import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { z } from 'zod';

import {
	organizationProjectionSchema,
	organizationReceiptSchema,
	type OrganizationOperation,
	type OrganizationProjection,
	type OrganizationReceipt,
} from '#sign-in-test-support/fuzz/organization-model';
import { createOrganizationRuntime } from '#sign-in-test-support/fuzz/organization-runtime';
import type { StorageTestLeg } from '#sign-in-test-support/storage-cases/dual-storage-test-host';
import { openSqliteStorageTestHost } from '#sign-in-test-support/storage-cases/sqlite-storage-test-host';
import { initialSignInTestTime } from '#sign-in-test-support/test-fixtures/controlled-sign-in-time';
import {
	applyLocalSignInMigrations,
	localSignInDatabaseId,
} from '#sign-in-test-support/test-fixtures/local-d1-migrations';
import { turnstileTestSiteKey } from '#sign-in-test-support/test-fixtures/turnstile-test-keys';
import {
	clockedWorkerManifest,
	proofStartupModuleSource,
} from '#sign-in-test-support/test-fixtures/worker-module-manifest';

export interface OrganizationSequenceHost {
	readonly reset: () => Promise<OrganizationProjection>;
	readonly execute: (operation: OrganizationOperation) => Promise<OrganizationReceipt>;
	readonly close: () => Promise<void>;
}

/** Extends the established dual-storage fixture with an isolated new command entry,
 * because its existing closed StorageCommand union cannot carry generated operations. */
export async function createOrganizationSequenceHost(props: {
	readonly leg: StorageTestLeg;
	readonly setNativeTime: (milliseconds: number) => void;
}): Promise<OrganizationSequenceHost> {
	const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
	const root = await realpath(
		await mkdtemp(path.join(tmpdir(), '2026-11-organization-sequences-')),
	);
	if (props.leg === 'better-sqlite3') {
		const opened = await openSqliteStorageTestHost({
			databaseFile: path.join(root, 'sign-in.sqlite'),
			migrationsFolder: path.join(repositoryRoot, 'packages/sign-in-core/drizzle'),
			migrateBeforeServing: true,
		});
		const runtime = createOrganizationRuntime({
			context: opened.context,
			setNativeTime: props.setNativeTime,
		});
		return {
			...runtime,
			close: async (): Promise<void> => {
				opened.close();
			},
		};
	}
	const persistencePath = await applyLocalSignInMigrations({
		repositoryRoot,
		runtimeDirectory: root,
	});
	const bundled = await build({
		absWorkingDir: repositoryRoot,
		entryPoints: ['packages/sign-in-test-support/src/fuzz/organization-sequence-worker.ts'],
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'neutral',
		target: 'es2022',
		conditions: ['workerd', 'worker', 'browser'],
		mainFields: ['module', 'main'],
		external: ['cloudflare:workers', 'node:*'],
		logLevel: 'silent',
	});
	const application = bundled.outputFiles[0];
	if (application === undefined) throw new Error('Organization sequence Worker bundle is empty');
	const configuration = {
		issuer: 'https://storage-sign-in.invalid',
		mode: 'private',
		ownerEmail: 'storage-owner@example.invalid',
		toolPortalOrigin: 'https://storage-portal.invalid',
		managementAudience: 'https://storage-portal.invalid/management',
		centralIdentityAudience: 'https://central.example.invalid/identity',
		centralAdminAudience: 'https://central.example.invalid/admin',
		centralPublicOrigin: 'https://central.example.invalid',
		adminPageClientId: 'admin-page-local',
		ownerFleetCliClientId: 'owner-fleet-cli-local',
		organizationStatementLifetimeSeconds: 10_368_000,
		organizationIds: ['11111111-1111-7111-8111-111111111111'],
		ownerCliClientId: 'storage-owner-cli',
		ownerCliRedirectUri: 'http://127.0.0.1/callback',
		accessTokenSeconds: 300,
		managementHumanCheck: 'remembered-login',
		turnstile: { kind: 'deployed', siteKey: turnstileTestSiteKey },
	};
	const textBindings = {
		SIGN_IN_CONFIGURATION: JSON.stringify(configuration),
		AUTH_SECRET: 'test-only-sequence-secret-'.repeat(3),
		GOOGLE_CLIENT_ID: 'fixture-google',
		GOOGLE_CLIENT_SECRET: 'fixture-google-secret',
		GITHUB_CLIENT_ID: 'fixture-github',
		GITHUB_CLIENT_SECRET: 'fixture-github-secret',
	};
	const clock = `globalThis.organizationFuzzTime = ${initialSignInTestTime};
	globalThis.Date = new Proxy(Date, {
		apply(target) { return Reflect.construct(target, [globalThis.organizationFuzzTime]).toString(); },
		construct(target, args) { return Reflect.construct(target, args.length === 0 ? [globalThis.organizationFuzzTime] : args); },
		get(target, key, receiver) { return key === 'now' ? () => globalThis.organizationFuzzTime : Reflect.get(target, key, receiver); }
	});`;
	const miniflare = new Miniflare({
		resourcePersistencePath: persistencePath,
		telemetry: { enabled: false },
		logRequests: false,
		workers: [
			{
				config: {
					type: 'worker',
					name: 'organization-sequences',
					manifest: clockedWorkerManifest({
						kind: 'storage-proof',
						startup: proofStartupModuleSource,
						application: application.text,
						clock,
					}),
					compatibilityDate: '2026-08-15',
					compatibilityFlags: ['nodejs_compat'],
					env: {
						DB: { type: 'd1', id: localSignInDatabaseId },
						...Object.fromEntries(
							Object.entries(textBindings).map(([key, value]) => [key, { type: 'text', value }]),
						),
					},
				},
			},
		],
	});
	await miniflare.ready;
	const worker = await miniflare.getWorker('organization-sequences');
	async function send(
		command:
			| { readonly kind: 'reset' }
			| { readonly kind: 'execute'; readonly operation: OrganizationOperation },
	): Promise<unknown> {
		const response = await worker.fetch('https://organization-sequences.invalid/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(command),
		});
		const result = z
			.discriminatedUnion('kind', [
				z.object({ kind: z.literal('result'), value: z.unknown() }),
				z.object({ kind: z.literal('case-error'), message: z.string() }),
			])
			.parse(await response.json());
		if (result.kind === 'case-error') throw new Error(result.message);
		return result.value;
	}
	return {
		reset: async (): Promise<OrganizationProjection> =>
			organizationProjectionSchema.parse(await send({ kind: 'reset' })),
		execute: async (operation: OrganizationOperation): Promise<OrganizationReceipt> =>
			organizationReceiptSchema.parse(await send({ kind: 'execute', operation })),
		close: (): Promise<void> => miniflare.dispose(),
	};
}
