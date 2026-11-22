import { expect, it } from 'vitest';

import {
	routeClassification,
	routeKey,
	supportedSocialProviders,
} from '#sign-in-test-support/fuzz/route-classification';

it('classifies each route once and supplies an answer and request parts for reachable routes', () => {
	const keys = routeClassification.map(routeKey);
	expect(new Set(keys).size).toBe(keys.length);
	for (const row of routeClassification) {
		expect(row.path).toMatch(/^\//u);
		expect(row.evidence.length).toBeGreaterThan(0);
		expect(row.disclosure.length).toBeGreaterThan(0);
		expect(row.documentedAnswers.length).toBeGreaterThan(0);
		expect(row.permittedRefusalEffects.length).toBeGreaterThan(0);
		if (!row.exposure.includes('blocked') && !row.exposure.includes('server-only'))
			expect(row.requestParts.length).toBeGreaterThan(0);
	}
});

it('keeps native server-only metadata separate from an admitted outer path', () => {
	const row = routeClassification.find(
		(route) => routeKey(route) === 'GET /api/auth/.well-known/oauth-authorization-server',
	);
	expect(row?.providerServerOnly).toBe(true);
	expect(row?.exposure).toContain('signed-out');
	expect(row?.documentedAnswers).toEqual([404, 429]);
});

it('marks the provider callback pattern separately from the concrete admitted callbacks', () => {
	for (const method of ['GET', 'POST']) {
		const pattern = routeClassification.find(
			(route) => routeKey(route) === `${method} /api/auth/callback/:id`,
		);
		expect(pattern?.exposure).toContain('blocked');
		for (const provider of ['google', 'github']) {
			const concrete = routeClassification.find(
				(route) => routeKey(route) === `${method} /api/auth/callback/${provider}`,
			);
			expect(concrete?.exposure).toContain('signed-out');
		}
	}
});

it('documents no 5xx answer for any route: F1 injects no storage or central fault', () => {
	for (const row of routeClassification) {
		expect(row.documentedAnswers.filter((status) => status >= 500)).toEqual([]);
		expect(
			Object.keys(row.documentedErrorBodies ?? {})
				.map(Number)
				.filter((s) => s >= 500),
		).toEqual([]);
	}
});

it('the supported social providers are exactly the concrete callback routes', () => {
	const callbacks = routeClassification
		.filter((row) => row.method === 'GET' && /^\/api\/auth\/callback\/[a-z]+$/u.test(row.path))
		.map((row) => String(row.path.split('/').at(-1)));
	const byName = (left: string, right: string): number => left.localeCompare(right);
	expect([...supportedSocialProviders].toSorted(byName)).toEqual(callbacks.toSorted(byName));
});
