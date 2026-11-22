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
			// Typed: each value is its JSON text, so the string "false" differs from the boolean false.
			return Object.fromEntries(
				Object.entries(parsed).map(([key, value]) => [key, JSON.stringify(value)]),
			);
		} catch {
			return undefined;
		}
	}
	if (contentType.startsWith('application/x-www-form-urlencoded'))
		return Object.fromEntries(new URLSearchParams(body));
	return undefined;
}

/** Every variant family is distinct, and what the pass builds for each step says it is that step. */
function assertPassMatchesWhatIsBuilt(family: RequestFamily): readonly GeneratedRequest[] {
	const steps = family.variantSteps(context);
	const keys = steps.map(variantKey);
	// Distinct (encoding, field and mutation all count): no collapsing.
	expect(new Set(keys).size).toBe(keys.length);
	const built = steps.map((step) => generateOnce(family, step));
	expect(built.map((request) => variantKey(request.variant)).toSorted()).toEqual(keys.toSorted());
	built.forEach((request, index) => {
		expect(request.variant).toEqual(steps[index]);
	});
	return built;
}

function assertChangedFields(
	validFields: Readonly<Record<string, string | null>>,
	fields: Readonly<Record<string, string | null>>,
	step: VariantStep,
): void {
	const changed = Object.keys({ ...validFields, ...fields }).filter(
		(name) => validFields[name] !== fields[name],
	);
	if (step.mutation === 'valid') expect(changed).toEqual([]);
	else if (step.field !== null) expect(changed).toEqual([step.field]);
	else expect(changed).toEqual(['unexpected']);
}

/**
 * Each request really is its variant family, read from the request itself, not its label: the wire
 * body of every field-carrying encoding (JSON, form, query) is parsed and exactly the named field
 * (or, for the valid request, none) differs from the valid fields; transports are what they say.
 */
function assertRequestsAreTheirVariants(built: readonly GeneratedRequest[]): void {
	// The valid fields of each encoding (a JSON body is compared with the valid JSON body).
	const validFieldsOf = (encoding: string): ReturnType<typeof fieldsOf> => {
		const valid = built.find(
			(request) => request.variant.encoding === encoding && request.variant.mutation === 'valid',
		);
		return valid === undefined ? undefined : fieldsOf(valid);
	};
	for (const request of built) {
		const step = request.variant;
		const fields = fieldsOf(request);
		const contentType = new Headers(request.init.headers).get('content-type') ?? '';
		if (step.encoding === 'wrong-content-type') {
			expect(contentType).toBe('text/plain');
			continue;
		}
		if (step.encoding === 'malformed') {
			expect(fields).toBeUndefined();
			continue;
		}
		// An encoding is what the wire says it is.
		if (step.encoding === 'json') expect(contentType).toContain('application/json');
		if (step.encoding === 'form')
			expect(contentType).toContain('application/x-www-form-urlencoded');
		if (step.encoding === 'query') expect(request.init.method).toBe('GET');
		expect(fields, `${variantKey(step)} has a body to read`).toBeDefined();
		const validFields = validFieldsOf(step.encoding);
		expect(validFields, `${step.encoding} has a valid request to compare with`).toBeDefined();
		if (validFields !== undefined && fields !== undefined)
			assertChangedFields(validFields, fields, step);
	}
}

/** Nothing random draws can produce is missing from the pass. */
function assertRandomDrawsStayInsidePass(family: RequestFamily): void {
	const keys = family.variantSteps(context).map(variantKey);
	const reachable = randomVariantKeys(family, 3000);
	expect([...reachable].filter((key) => !keys.includes(key))).toEqual([]);
}

function assertFamilyIsProved(family: RequestFamily): void {
	assertRequestsAreTheirVariants(assertPassMatchesWhatIsBuilt(family));
	assertRandomDrawsStayInsidePass(family);
}

for (const family of requestFamilies) {
	it(`${family.route.method} ${family.route.path}: the coverage pass is exactly its variant families, each built as it says`, (): void => {
		assertFamilyIsProved(family);
	});
}

const callbackFamily = ((): RequestFamily => {
	const found = requestFamilies.find(
		(candidate) =>
			candidate.route.path === '/api/auth/callback/google' && candidate.route.method === 'POST',
	);
	if (found === undefined) throw new Error('callback family missing');
	return found;
})();

it('a dual-encoding form family plans field mutations under JSON as well as under the form (the reach random generation had)', (): void => {
	const keys = callbackFamily.variantSteps(context).map(variantKey);
	for (const encoding of ['form', 'json'])
		for (const mutation of ['near-valid', 'boundary', 'wrong-type'])
			expect(
				keys.some((key) => key.startsWith(`${encoding}|`) && key.endsWith(`|${mutation}`)),
			).toBe(true);
});

it('wrong builds are caught: unchanged valid JSON labelled as a field mutation, and a pass that drops a variant family', (): void => {
	const mutationStep = callbackFamily
		.variantSteps(context)
		.find((step) => step.encoding === 'json' && step.mutation === 'near-valid');
	if (mutationStep === undefined) throw new Error('no JSON mutation step in the callback plan');
	const validStep = callbackFamily
		.variantSteps(context)
		.find((step) => step.encoding === 'json' && step.mutation === 'valid');
	if (validStep === undefined) throw new Error('no JSON valid step in the callback plan');
	// Wrong build 1: the JSON field mutation returns the valid JSON body unchanged, still labelled.
	const labelsValidAsMutation: RequestFamily = {
		...callbackFamily,
		generate: (testCase, ctx, step): GeneratedRequest => {
			const request = callbackFamily.generate(
				testCase,
				ctx,
				step !== undefined && variantKey(step) === variantKey(mutationStep) ? validStep : step,
			);
			return step === undefined ? request : { ...request, variant: step };
		},
	};
	expect(() =>
		assertRequestsAreTheirVariants(assertPassMatchesWhatIsBuilt(labelsValidAsMutation)),
	).toThrow();
	// Wrong build 2: the pass drops one variant family that random draws still reach.
	const dropsOne: RequestFamily = {
		...callbackFamily,
		variantSteps: (ctx) => callbackFamily.variantSteps(ctx).slice(1),
	};
	expect(() => assertRandomDrawsStayInsidePass(dropsOne)).toThrow();
	// The real family passes the same checks.
	expect(() => assertFamilyIsProved(callbackFamily)).not.toThrow();
});
