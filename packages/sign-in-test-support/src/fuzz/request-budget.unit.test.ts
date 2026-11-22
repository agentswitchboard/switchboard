import * as hegel from '@hegeldev/hegel';
import { expect, it } from 'vitest';

import { fuzzSettingsExact } from '#sign-in-test-support/fuzz/fuzz-settings';
import {
	requestFamilies,
	type GeneratedRequest,
	type RequestFamily,
	type VariantStep,
} from '#sign-in-test-support/fuzz/request-families/index';
import { variantKey } from '#sign-in-test-support/fuzz/request-families/request-family';
import { syntheticRequestFamilyContext } from '#sign-in-test-support/fuzz/request-families/synthetic-context';

const context = syntheticRequestFamilyContext;

/** Generate one request per call, in a Hegel run closed over `step` (the way the live driver does). */
function generateOnce(family: RequestFamily, step: VariantStep | undefined): GeneratedRequest {
	let generated: GeneratedRequest | undefined;
	hegel.test((testCase): void => {
		generated = family.generate(testCase, context, step);
	}, fuzzSettingsExact(1));
	if (generated === undefined) throw new Error('No request generated');
	return generated;
}

function randomVariantKeys(family: RequestFamily, draws: number): ReadonlySet<string> {
	const seen = new Set<string>();
	hegel.test((testCase): void => {
		seen.add(variantKey(family.generate(testCase, context).variant));
	}, fuzzSettingsExact(draws));
	return seen;
}

/** The named fields a request carries, by how it is encoded; null for a field set to null. */
function fieldsOf(request: GeneratedRequest): Readonly<Record<string, string | null>> | undefined {
	const body = typeof request.init.body === 'string' ? request.init.body : '';
	const contentType = new Headers(request.init.headers).get('content-type') ?? '';
	if (request.init.method === 'GET')
		return Object.fromEntries(new URL(request.pathname, 'http://host.invalid').searchParams);
	if (contentType.startsWith('application/json')) {
		try {
			const parsed: unknown = JSON.parse(body);
			if (typeof parsed !== 'object' || parsed === null) return undefined;
			return Object.fromEntries(
				Object.entries(parsed).map(([key, value]) => [
					key,
					value === null ? null : typeof value === 'string' ? value : JSON.stringify(value),
				]),
			);
		} catch {
			return undefined;
		}
	}
	if (contentType.startsWith('application/x-www-form-urlencoded'))
		return Object.fromEntries(new URLSearchParams(body));
	return undefined;
}

const encodingOf = (step: VariantStep): string => step.encoding;

for (const family of requestFamilies) {
	it(`${family.route.method} ${family.route.path}: the coverage pass is exactly its variant families, each built as it says`, (): void => {
		const steps = family.variantSteps(context);
		const keys = steps.map(variantKey);
		// Every variant family is distinct (encoding, field and mutation all count): no collapsing.
		expect(new Set(keys).size).toBe(keys.length);
		// The pass built one request per variant family, and each says it is that one (equality, both ways).
		const built = steps.map((step) => generateOnce(family, step));
		expect(built.map((request) => variantKey(request.variant)).toSorted()).toEqual(keys.toSorted());
		built.forEach((request, index) => {
			expect(request.variant).toEqual(steps[index]);
		});
		// And each request really is its variant family, read from the request itself, not its label.
		const valid = built.find(
			(request) => request.variant.mutation === 'valid' && fieldsOf(request) !== undefined,
		);
		const validFields = valid === undefined ? undefined : fieldsOf(valid);
		for (const request of built) {
			const step = request.variant;
			const fields = fieldsOf(request);
			const contentType = new Headers(request.init.headers).get('content-type') ?? '';
			if (step.encoding === 'wrong-content-type') expect(contentType).toBe('text/plain');
			else if (step.encoding === 'malformed') expect(fields).toBeUndefined();
			else if (step.encoding === 'json' && family.route.method === 'POST')
				expect(contentType).toContain('application/json');
			else if (validFields !== undefined && fields !== undefined) {
				const changed = Object.keys({ ...validFields, ...fields }).filter(
					(name) => validFields[name] !== fields[name],
				);
				if (step.mutation === 'valid') expect(changed).toEqual([]);
				else if (step.field !== null) expect(changed).toEqual([step.field]);
				else expect(changed).toEqual(['unexpected']);
			}
		}
		// Nothing random draws can produce is missing from the pass: every variant family reached in
		// 3000 random draws is in the pass.
		const reachable = randomVariantKeys(family, 3000);
		expect([...reachable].filter((key) => !keys.includes(key))).toEqual([]);
		expect(steps.map(encodingOf).every((encoding) => encoding.length > 0)).toBe(true);
	});
}

it('a wrong build that drops or repeats a variant family would fail: field identity is part of the key', (): void => {
	const dropped = (family: RequestFamily): readonly string[] =>
		family.variantSteps(context).map(variantKey).slice(1);
	const family = requestFamilies.find(
		(candidate) => candidate.route.path === '/api/auth/oauth2/token',
	);
	if (family === undefined) throw new Error('token family missing');
	const keys = family.variantSteps(context).map(variantKey);
	expect(dropped(family)).not.toEqual(keys.toSorted());
	// The five near-valid mutations of the token request are five variant families, not one.
	expect(keys.filter((key) => key.endsWith('|near-valid'))).toHaveLength(5);
	expect(new Set(keys.filter((key) => key.endsWith('|near-valid'))).size).toBe(5);
});
