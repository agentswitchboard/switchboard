import { createHash } from 'node:crypto';

import { epochMillisecondsSchema, type FleetAdminRequest } from '@agent-collaboration/sign-in-core';
import {
	requireFleetTarget,
	type FleetCliIo,
	type FleetTarget,
	type SecurityCommandRunner,
} from '@agent-collaboration/sign-in-owner-cli';
import { createWebSignInCapabilities } from '@agent-collaboration/sign-in-platform-web';
import { createLocalJWKSet } from 'jose';
import type { WorkerOptions } from 'miniflare';
import { expect } from 'vitest';
import { z } from 'zod';

import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { ensureLocalOwnerOrganization } from '#sign-in-test-support/test-fixtures/local-owner-organization';
import { signInConfirmedPeopleBrowser } from '#sign-in-test-support/test-fixtures/people-browser-login';

export type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;
export const ownerEmail = 'owner@example.invalid';
export const initialTime = controlledSignInClock.now();

export interface FleetFixture {
	readonly harness: Harness;
	readonly target: FleetTarget;
	readonly cookie: string;
	readonly io: FleetCliIo;
	/** Every request the CLI made, with its exact body bytes. */
	readonly sent: { readonly url: URL; readonly headers: Headers; readonly body: string }[];
	readonly browserVisits: () => number;
	readonly setTime: (milliseconds: number) => Promise<void>;
}

/**
 * The owner signs in through the real provider callback and runs the bootstrap; the CLI's
 * "browser" then follows the printed authorization with the owner's cookie and delivers the
 * code to the CLI's real loopback listener. Only the human at the browser is stood in for.
 */
/**
 * The fleet CLI's injected I/O against a running harness: real fetch to the issuer, every
 * request recorded with its exact body, and a "browser" that follows the printed
 * authorization with the person's own cookie and delivers the code to the CLI's loopback.
 */
export function fleetCliIoFor(props: {
	readonly harness: Harness;
	readonly cookie: string;
	readonly now: () => number;
	readonly sent: FleetFixture['sent'][number][];
	readonly onBrowserVisit?: () => void;
}): FleetCliIo {
	const capabilities = createWebSignInCapabilities({
		now: () => epochMillisecondsSchema.parse(props.now()),
	});
	return {
		now: props.now,
		nextId: () => capabilities.ids.nextId(),
		crypto: capabilities.crypto,
		async fetch(input, init) {
			props.sent.push({
				url: new URL(String(input)),
				headers: new Headers(init?.headers),
				body: typeof init?.body === 'string' ? init.body : '',
			});
			return fetch(input, init);
		},
		async browser(url) {
			props.onBrowserVisit?.();
			const authorization = new URL(new URL(url).searchParams.get('authorize') ?? 'invalid:');
			const authorized = await props.harness.auth(
				`${authorization.pathname}${authorization.search}`,
				{ headers: { cookie: props.cookie, 'sec-fetch-mode': 'navigate', accept: 'text/html' } },
			);
			const location = authorized.headers.get('location');
			if (location === null)
				throw new Error(`Authorization gave no redirect (${authorized.status})`);
			await fetch(location);
		},
	};
}

export async function setupFleetCli(
	options: {
		/** workerd only: the Worker sign-in's CENTRAL_LINK binding reaches (C8's stand-in central link). */
		readonly machineLinkStorageWorker?: WorkerOptions;
	} = {},
): Promise<FleetFixture> {
	let now = initialTime;
	const harness = await startLocalAuthHarness({
		turnstileSecret: 'published-test',
		authenticatorClock: { now: () => epochMillisecondsSchema.parse(now) },
		...options,
	});
	try {
		await signInConfirmedPeopleBrowser({ harness, email: ownerEmail });
		const organizationId = await ensureLocalOwnerOrganization({
			auth: harness.auth,
			database: harness.database,
		});
		expect(
			(
				await harness.auth('/api/auth/owner/bootstrap', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: '{}',
				})
			).status,
		).toBe(200);
		await harness.settleDeferredWork();
		const cookie = harness.cookie();
		const sent: FleetFixture['sent'] = [];
		let visits = 0;
		const io = fleetCliIoFor({
			harness,
			cookie,
			now: () => now,
			sent,
			onBrowserVisit: () => {
				visits += 1;
			},
		});
		return {
			harness,
			target: requireFleetTarget({ ...harness.target, organizationId }),
			cookie,
			io,
			sent,
			browserVisits: () => visits,
			async setTime(milliseconds): Promise<void> {
				const response = await harness.auth('/__auth-proof/set-clock', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ milliseconds }),
				});
				expect(response.status).toBe(200);
				now = epochMillisecondsSchema.parse(milliseconds);
				harness.setCentralAdminTime(milliseconds);
			},
		};
	} catch (error) {
		await harness.close();
		throw error;
	}
}

export function createRequest(fixture: FleetFixture, name = 'research'): FleetAdminRequest {
	return {
		operation: 'CreateWorkspace',
		organizationId: fixture.target.organizationId,
		operationId: createWebSignInCapabilities().ids.nextId(),
		name,
		description: '',
	};
}
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
export async function publicKeys(harness: Harness): Promise<ReturnType<typeof createLocalJWKSet>> {
	return createLocalJWKSet(
		z
			.object({ keys: z.array(z.looseObject({ kty: z.string() })) })
			.parse(await (await harness.auth('/api/auth/jwks')).json()),
	);
}

/**
 * A stand-in for `/usr/bin/security` over one in-memory keychain shared by several CLI
 * processes. It reads `-i` commands with the real tool's double-quote words; the real tool is
 * proven by the darwin host-lane Keychain test.
 */
export function fakeSecurityRunner(): SecurityCommandRunner {
	const items = new Map<string, string>();
	const option = (list: readonly string[], flag: string): string =>
		list[list.indexOf(flag) + 1] ?? '';
	return async ({ args, stdin }) => {
		if (args[0] === '-i') {
			const words = [...(stdin ?? '').matchAll(/"([^"]*)"|(\S+)/gu)].map(
				(match) => match[1] ?? match[2] ?? '',
			);
			if (words[0] !== 'add-generic-password') return { exitCode: 1, stdout: '' };
			items.set(`${option(words, '-s')}\n${option(words, '-a')}`, option(words, '-w'));
			return { exitCode: 0, stdout: '' };
		}
		const key = `${option(args, '-s')}\n${option(args, '-a')}`;
		if (args[0] === 'find-generic-password') {
			const value = items.get(key);
			return value === undefined
				? { exitCode: 44, stdout: '' }
				: { exitCode: 0, stdout: `${value}\n` };
		}
		if (args[0] === 'delete-generic-password')
			return { exitCode: items.delete(key) ? 0 : 44, stdout: '' };
		return { exitCode: 1, stdout: '' };
	};
}
