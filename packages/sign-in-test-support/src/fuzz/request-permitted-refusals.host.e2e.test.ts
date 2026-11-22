import { expect, it } from 'vitest';

import { createRequestCaseFixture } from '#sign-in-test-support/fuzz/request-case-fixture';
import {
	assertRequestDisclosure,
	observeRequestAnswer,
} from '#sign-in-test-support/fuzz/request-disclosure';
import type { GeneratedRequest } from '#sign-in-test-support/fuzz/request-families/index';
import { assertRequestRefusalEffects } from '#sign-in-test-support/fuzz/request-refusal-effects';
import { readRequestStorageSnapshot } from '#sign-in-test-support/fuzz/request-storage-snapshot';
import { routeClassification } from '#sign-in-test-support/fuzz/route-classification';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';

useControlledSignInClock();

it('S2 permitted refusal consumes the matching passkey challenge before rejecting a bad assertion and its replay', async () => {
	const path = '/api/auth/passkey/confirm';
	const fixture = await createRequestCaseFixture({ caller: 'owner', path });
	try {
		const classification = routeClassification.find((row) => row.path === path);
		if (classification === undefined) throw new Error('Passkey classification missing');
		const request: GeneratedRequest = {
			pathname: path,
			label: 'valid-challenge-invalid-assertion',
			variant: { encoding: 'json', field: null, mutation: 'valid' },
			expectation: 'success-or-refusal',
			init: {
				method: 'POST',
				headers: { 'content-type': 'application/json', cookie: fixture.cookie },
				body: JSON.stringify({
					challengeId: fixture.context.challengeId,
					response: { ...fixture.context.passkeyAuthenticationResponse, id: 'unknown-credential' },
				}),
			},
		};
		const before = await readRequestStorageSnapshot(fixture.harness.database);
		const answer = await observeRequestAnswer(await fixture.harness.auth(path, request.init));
		const after = await readRequestStorageSnapshot(fixture.harness.database);
		expect(answer.status).toBe(401);
		assertRequestDisclosure({ fixture, path, request, answer, before, after });
		assertRequestRefusalEffects({ fixture, classification, before, after, request });
		expect(
			(before.verification ?? []).some(
				(row) =>
					row.identifier === `passkey-confirm:${fixture.sessionId}:${fixture.context.challengeId}`,
			),
		).toBe(true);
		expect(
			(after.verification ?? []).some(
				(row) =>
					row.identifier === `passkey-confirm:${fixture.sessionId}:${fixture.context.challengeId}`,
			),
		).toBe(false);
		const replay = await fixture.harness.auth(path, request.init);
		expect(replay.status).toBe(401);
		assertRequestRefusalEffects({
			fixture,
			classification,
			before: after,
			after: await readRequestStorageSnapshot(fixture.harness.database),
			request,
		});
	} finally {
		await fixture.harness.close();
	}
});

it('S2 permitted refused read deletes its expired session and advances every retained fence', async () => {
	const path = '/api/auth/owner/bootstrap';
	const fixture = await createRequestCaseFixture({ caller: 'owner', path });
	try {
		const classification = routeClassification.find((row) => row.path === path);
		if (classification === undefined) throw new Error('Bootstrap classification missing');
		const before = await readRequestStorageSnapshot(fixture.harness.database);
		const current = (before.session ?? []).find((row) => row.id === fixture.sessionId);
		if (current === undefined || typeof current.expiresAt !== 'number')
			throw new Error('Expected native session expiry');
		const now = current.expiresAt + 1;
		const clock = await fixture.harness.auth('/__auth-proof/set-clock', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ milliseconds: now }),
		});
		expect(clock.status).toBe(200);
		const request: GeneratedRequest = {
			pathname: path,
			label: 'expired-session-read',
			variant: { encoding: 'json', field: null, mutation: 'valid' },
			expectation: 'success-or-refusal',
			init: {
				method: 'POST',
				headers: { 'content-type': 'application/json', cookie: fixture.cookie },
				body: '{}',
			},
		};
		const answer = await observeRequestAnswer(await fixture.harness.auth(path, request.init));
		const after = await readRequestStorageSnapshot(fixture.harness.database);
		expect(answer.status).toBe(401);
		assertRequestDisclosure({ fixture, path, request, answer, before, after });
		assertRequestRefusalEffects({
			fixture,
			classification,
			before,
			after,
			request,
			now,
			central: {
				pushes: fixture.harness.centralProvisioning.pushes,
				pushReply: fixture.harness.centralProvisioning.pushReplyMode(),
			},
		});
		expect((after.session ?? []).some((row) => row.id === fixture.sessionId)).toBe(false);
		for (const pair of before.personOrganizationAuthorizationRevisions ?? []) {
			if (pair.person_id !== fixture.context.personId) continue;
			const next = (after.personOrganizationAuthorizationRevisions ?? []).find(
				(row) => row.id === pair.id,
			);
			if (typeof pair.revision !== 'number') throw new Error('Expected integer revision');
			expect(next?.revision).toBe(pair.revision + 1);
		}
	} finally {
		await fixture.harness.close();
	}
});
