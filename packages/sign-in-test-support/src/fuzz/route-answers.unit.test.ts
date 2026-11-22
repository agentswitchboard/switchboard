import { describe, expect, it } from 'vitest';

import type { GeneratedRequest } from '#sign-in-test-support/fuzz/request-families/index';
import {
	documentedAnswersFor,
	routeClassification,
	type RouteClassification,
} from '#sign-in-test-support/fuzz/route-classification';

const row = (method: string, path: string): RouteClassification => {
	const found = routeClassification.find(
		(candidate) => candidate.method === method && candidate.path === path,
	);
	if (found === undefined) throw new Error(`${method} ${path} not classified`);
	return found;
};

const request = (
	encoding: string,
	mutation: 'valid' | 'near-valid' = 'valid',
): GeneratedRequest => ({
	pathname: '/x',
	init: { method: 'POST' },
	label: 'request',
	variant: { encoding, field: null, mutation },
	expectation: 'success-or-refusal',
});

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

describe('S2 closure: a success is documented only for a caller the route is exposed to', (): void => {
	it('refuses a signed-out caller and a member a success from the owner bootstrap (a signed-out 200 {} fails)', (): void => {
		const bootstrap = row('POST', '/api/auth/owner/bootstrap');
		expect(documentedAnswersFor(bootstrap, 'signed-out').some(isSuccess)).toBe(false);
		expect(documentedAnswersFor(bootstrap, 'member').some(isSuccess)).toBe(false);
		expect(documentedAnswersFor(bootstrap, 'owner')).toContain(200);
		// Its refusals stay documented for them.
		expect(documentedAnswersFor(bootstrap, 'signed-out')).toContain(401);
	});

	it('does the same for another caller-specific family (organization create, owner admin forwarding)', (): void => {
		for (const path of [
			'/api/auth/organization/create',
			'/api/auth/organization/set-active',
			'/api/auth/passkey/remove',
		])
			expect(documentedAnswersFor(row('POST', path), 'signed-out').some(isSuccess), path).toBe(
				false,
			);
		for (const path of [
			'/api/auth/organization-admin/create-workspace',
			'/api/auth/organization-admin/workspace-lookup',
		])
			expect(documentedAnswersFor(row('POST', path), 'member').some(isSuccess), path).toBe(false);
		// A route exposed to every caller keeps its success for each of them.
		for (const caller of ['signed-out', 'member', 'owner'] as const)
			expect(documentedAnswersFor(row('GET', '/api/auth/get-session'), caller)).toContain(200);
		// The CLI routes are exercised through the owner fixture: that caller keeps the success.
		expect(documentedAnswersFor(row('POST', '/api/auth/oauth2/token'), 'owner')).toContain(200);
		expect(
			documentedAnswersFor(row('POST', '/api/auth/oauth2/token'), 'signed-out').some(isSuccess),
		).toBe(false);
	});

	it('does not document a success for a request whose body cannot be read, on a route that reads its body', (): void => {
		const bootstrap = row('POST', '/api/auth/owner/bootstrap');
		for (const encoding of ['malformed', 'wrong-content-type'])
			expect(
				documentedAnswersFor(bootstrap, 'owner', request(encoding)).some(isSuccess),
				encoding,
			).toBe(false);
		// The same caller with a readable body keeps its success.
		expect(documentedAnswersFor(bootstrap, 'owner', request('json'))).toContain(200);
	});
});
