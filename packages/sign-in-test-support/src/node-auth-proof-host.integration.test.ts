import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { createAuthProofBarrierServer } from '#sign-in-test-support/test-fixtures/auth-proof-barrier-server';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { organizationOne } from '#sign-in-test-support/test-fixtures/local-auth-configuration';
import { startNodeAuthProofHost } from '#sign-in-test-support/test-fixtures/node-auth-proof-host';

useControlledSignInClock();

async function openFixtureHost(): Promise<{
	readonly host: Awaited<ReturnType<typeof startNodeAuthProofHost>>;
	readonly barriers: ReturnType<typeof createAuthProofBarrierServer>;
}> {
	const barriers = createAuthProofBarrierServer();
	const runtimeDirectory = await mkdtemp(path.join(tmpdir(), '2026-10-node-proof-transport-'));
	const host = await startNodeAuthProofHost({
		runtimeDirectory,
		// These transport-only cases never call central. A path is still required explicitly.
		centralSocketPath: path.join(runtimeDirectory, 'unused-central.sock'),
		issuer: 'http://127.0.0.1:9000',
		barriers,
		provider: async () => Response.json({ error: 'unexpected-provider-request' }, { status: 503 }),
		configuration: {
			issuer: 'http://127.0.0.1:9000',
			turnstile: { kind: 'local', siteKey: 'fixture-site-key' },
			mode: 'private',
			ownerEmail: 'owner@example.invalid',
			toolPortalOrigin: 'https://portal.invalid',
			managementAudience: 'https://portal.invalid/management',
			centralIdentityAudience: 'https://central.example.invalid/identity',
			centralAdminAudience: 'https://central.example.invalid/admin',
			centralPublicOrigin: 'https://central.example.invalid',
			adminPageClientId: 'admin-page-local',
			ownerFleetCliClientId: 'owner-fleet-cli-local',
			organizationStatementLifetimeSeconds: 10_368_000,
			organizationIds: [organizationOne],
			ownerCliClientId: 'owner-cli-test',
			ownerCliRedirectUri: 'http://127.0.0.1/callback',
		},
	});
	return { host, barriers };
}

it('records the empty HEAD response body actually emitted by the Node transport', async () => {
	const { host, barriers } = await openFixtureHost();
	try {
		const response = await fetch(new URL('/not-a-public-route', host.address), {
			method: 'HEAD',
			headers: { 'x-auth-proof-invocation': '22222222-2222-7222-8222-222222222222' },
		});
		expect(response.status).toBe(404);
		expect(await response.text()).toBe('');
		expect(host.receipts[0]).toMatchObject({ httpMethod: 'HEAD', path: '/not-a-public-route' });
		expect(host.receipts[0]?.responseHash).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		);
	} finally {
		await host.close();
		barriers.close();
	}
});

it('retains the Node invocation receipt when a management request fails before producing a response', async () => {
	const barriers = createAuthProofBarrierServer();
	const runtimeDirectory = await mkdtemp(path.join(tmpdir(), '2026-10-node-proof-failure-'));
	const host = await startNodeAuthProofHost({
		runtimeDirectory,
		centralSocketPath: path.join(runtimeDirectory, 'unused-central.sock'),
		issuer: 'http://127.0.0.1:9000',
		barriers,
		provider: async () => Response.json({ error: 'unexpected-provider-request' }, { status: 503 }),
		configuration: {
			issuer: 'http://127.0.0.1:9000',
			turnstile: { kind: 'local', siteKey: 'fixture-site-key' },
			mode: 'private',
			ownerEmail: 'owner@example.invalid',
			toolPortalOrigin: 'https://portal.invalid',
			managementAudience: 'https://portal.invalid/management',
			centralIdentityAudience: 'https://central.example.invalid/identity',
			centralAdminAudience: 'https://central.example.invalid/admin',
			centralPublicOrigin: 'https://central.example.invalid',
			adminPageClientId: 'admin-page-local',
			ownerFleetCliClientId: 'owner-fleet-cli-local',
			organizationStatementLifetimeSeconds: 10_368_000,
			organizationIds: [organizationOne],
			ownerCliClientId: 'owner-cli-test',
			ownerCliRedirectUri: 'http://127.0.0.1/callback',
		},
	});
	try {
		const response = await fetch(new URL('/__auth-proof/node-management', host.address), {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-auth-proof-invocation': '11111111-1111-7111-8111-111111111111',
			},
			body: JSON.stringify({ method: 'unknown' }),
		});
		expect(response.status).toBe(503);
		expect(host.receipts).toHaveLength(1);
		expect(host.receipts[0]).toMatchObject({
			invocationId: '11111111-1111-7111-8111-111111111111',
			status: 503,
		});
	} finally {
		await host.close();
		barriers.close();
	}
});
