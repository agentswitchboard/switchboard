import * as hegel from '@hegeldev/hegel';
import { expect } from 'vitest';

import { readCentralAcknowledgements } from '#sign-in-test-support/fuzz/central-acknowledgements';
import { assertDocumentedAnswer } from '#sign-in-test-support/fuzz/documented-answer';
import {
	boundShrinking,
	caseIdentityNote,
	fuzzCasesOverride,
	fuzzSettingsExact,
	scriptedTestCase,
	type FailureReplay,
} from '#sign-in-test-support/fuzz/fuzz-settings';
import {
	createRequestCaseFixture,
	type RequestCaller,
	type RequestHarness,
} from '#sign-in-test-support/fuzz/request-case-fixture';
import {
	assertDocumentedErrorBody,
	assertGenericRefusalBody,
	assertRequestDisclosure,
	observeRequestAnswer,
	type ObservedRequestAnswer,
} from '#sign-in-test-support/fuzz/request-disclosure';
import type {
	GeneratedRequest,
	RequestFamily,
} from '#sign-in-test-support/fuzz/request-families/index';
import {
	variantKey,
	type VariantStep,
} from '#sign-in-test-support/fuzz/request-families/request-family';
import { syntheticRequestFamilyContext } from '#sign-in-test-support/fuzz/request-families/synthetic-context';
import { assertRequestRefusalEffects } from '#sign-in-test-support/fuzz/request-refusal-effects';
import { readRequestStorageSnapshot } from '#sign-in-test-support/fuzz/request-storage-snapshot';
import {
	routeKey,
	type RouteClassification,
} from '#sign-in-test-support/fuzz/route-classification';

/**
 * One group (a route as a caller) of the request campaign: the coverage pass visits every variant
 * family of the route once, each as its own Hegel run whose variant is fixed by the step it is
 * closed over (so a replay or a shrink candidate is always the same variant family, a function of
 * the draw alone), then any extra cases (a deep `SIGN_IN_FUZZ_CASES`) draw their variant family from
 * the same list. The plan comes from the real fixture context of the group's first case, and every
 * later case must see the same field inventory.
 *
 * With `replay` (printed evidence of one failed case), the group runs only that case, answering its
 * draws from the print, against the same property.
 */
export async function runRequestGroup(props: {
	readonly harness: RequestHarness;
	readonly family: RequestFamily;
	readonly caller: RequestCaller;
	readonly classification: RouteClassification;
	readonly replay?: FailureReplay | undefined;
	/**
	 * A test-support stub between the host's answer and the oracles: a test plants a deterministic
	 * failure here (never in product code) to prove a printed failure replays.
	 */
	readonly observeAnswer?:
		| ((answer: ObservedRequestAnswer, request: GeneratedRequest) => ObservedRequestAnswer)
		| undefined;
	/**
	 * Run only the random tail, this many cases (the coverage pass is skipped), so a test can reach
	 * a randomly selected variant without a deep run.
	 */
	readonly randomCasesOnly?: number | undefined;
}): Promise<{ readonly executedCases: number }> {
	const { harness, family, caller, classification } = props;
	let caseNumber = 0;
	let planKeys: readonly string[] | undefined;
	const runCase = async (
		testCase: Pick<hegel.TestCase, 'draw'>,
		note: (text: string) => void,
		identity: { readonly stepIndex: number | undefined; readonly offset: number },
	): Promise<void> => {
		caseNumber += 1;
		process.stdout.write(
			JSON.stringify({
				event: 'F1-case-start',
				route: routeKey(family.route),
				caller,
				caseNumber,
			}) + '\n',
		);
		const fixture = await createRequestCaseFixture({
			caller,
			path: family.route.path,
			existingHarness: harness,
		});
		const steps = family.variantSteps(fixture.context);
		const keys = steps.map(variantKey);
		planKeys ??= keys;
		expect(keys, 'S2 live field inventory changed between cases').toEqual(planKeys);
		// The unit proofs (request-budget.unit.test.ts) use the synthetic context: it must carry the live field inventory.
		expect(keys, 'S2 live field inventory differs from the proved one').toEqual(
			family.variantSteps(syntheticRequestFamilyContext).map(variantKey),
		);
		const generated = family.generate(
			testCase,
			fixture.context,
			identity.stepIndex === undefined ? undefined : steps[identity.stepIndex],
		);
		note(
			caseIdentityNote({
				offset: identity.offset,
				route: routeKey(family.route),
				caller,
				variant: variantKey(generated.variant),
				mode: identity.stepIndex === undefined ? 'random' : 'scheduled',
			}),
		);
		const before = await readRequestStorageSnapshot(fixture.harness.database);
		const exchangesBefore = fixture.harness.centralProvisioning.exchanges.length;
		const response = await fixture.harness.auth(generated.pathname, {
			...generated.init,
			headers: {
				...Object.fromEntries(new Headers(generated.init.headers)),
				cookie: fixture.cookie,
			},
		});
		const observed = await observeRequestAnswer(response);
		const answer = props.observeAnswer?.(observed, generated) ?? observed;
		await fixture.harness.settleDeferredWork();
		const after = await readRequestStorageSnapshot(fixture.harness.database);
		expect(
			answer.status,
			'S2 no-server-error: generated input without injected storage faults',
		).toBeLessThan(500);
		assertDocumentedAnswer({
			classification,
			caller,
			request: generated,
			status: answer.status,
		});
		assertDocumentedErrorBody({
			documentedErrorBodies: classification.documentedErrorBodies,
			answer,
			caller,
			request: generated,
		});
		assertGenericRefusalBody(answer, {
			htmlRefusalDocumented: classification.htmlRefusals?.includes(answer.status) === true,
		});
		assertRequestDisclosure({
			fixture,
			path: family.route.path,
			request: generated,
			answer,
			before,
			after,
		});
		if (answer.status >= 400 || answer.headers.get('location')?.includes('error='))
			assertRequestRefusalEffects({
				classification,
				fixture,
				before,
				after,
				request: generated,
				// Central's actual replies during this request: the only acknowledgement evidence.
				central: {
					acknowledgements: readCentralAcknowledgements(
						fixture.harness.centralProvisioning.exchanges.slice(exchangesBefore),
					),
				},
			});
		process.stdout.write(
			JSON.stringify({
				event: 'F1-case-end',
				route: routeKey(family.route),
				caller,
				caseNumber,
			}) + '\n',
		);
	};
	const runCases = async (cases: {
		readonly stepIndex: number | undefined;
		readonly cases: number;
		readonly seedOffset: number;
	}): Promise<void> => {
		await hegel.testAsync(
			boundShrinking(async (testCase, note): Promise<void> => {
				await runCase(testCase, note, { stepIndex: cases.stepIndex, offset: cases.seedOffset });
			}),
			fuzzSettingsExact(cases.cases, cases.seedOffset),
		);
	};
	if (props.replay !== undefined) {
		const replay = props.replay;
		if (replay.route !== routeKey(family.route) || replay.caller !== caller)
			throw new Error(
				`The printed case is for ${replay.route} as ${replay.caller}, not ${routeKey(family.route)} as ${caller}`,
			);
		const stepIndex = planKeysOf(family).indexOf(replay.variant);
		if (stepIndex < 0) throw new Error(`The printed variant ${replay.variant} is not planned`);
		const scripted = scriptedTestCase(replay.evidence);
		let variantDraw = replay.mode === 'random';
		// A random case drew its variant before its fields: that draw is replayed as the generator makes
		// it (so the field draws stay aligned) and must be the printed variant.
		const drawer: Pick<hegel.TestCase, 'draw'> = {
			draw: <Value>(generator: Parameters<hegel.TestCase['draw']>[0]): Value => {
				const value = scripted.draw(generator) as Value;
				if (variantDraw) {
					variantDraw = false;
					const drawn = variantKey(value as VariantStep);
					if (drawn !== replay.variant)
						throw new Error(
							`The first recorded draw is variant ${drawn}, not the printed ${replay.variant}: the draws would be misaligned`,
						);
				}
				return value;
			},
		};
		try {
			await runCase(drawer, () => undefined, {
				stepIndex: replay.mode === 'random' ? undefined : stepIndex,
				offset: replay.offset,
			});
		} finally {
			// A replay that executed nothing, or more than the one printed case, proves nothing.
			if (caseNumber !== 1)
				throw new Error(`The replay executed ${caseNumber} cases, not exactly one`);
		}
		return { executedCases: caseNumber };
	}
	if (props.randomCasesOnly !== undefined) {
		await runCases({
			stepIndex: undefined,
			cases: props.randomCasesOnly,
			seedOffset: planKeysOf(family).length,
		});
		return { executedCases: caseNumber };
	}
	// The first case also reads the plan from the real context; it is the first variant family.
	await runCases({ stepIndex: 0, cases: 1, seedOffset: 0 });
	const planLength = planKeys?.length ?? 1;
	const budget = fuzzCasesOverride ?? planLength;
	if (budget < planLength)
		process.stdout.write(
			JSON.stringify({
				event: 'F1-reduced-run',
				route: routeKey(family.route),
				caller,
				budget,
				variantFamilies: planLength,
			}) + '\n',
		);
	for (let stepIndex = 1; stepIndex < Math.min(budget, planLength); stepIndex += 1)
		await runCases({ stepIndex, cases: 1, seedOffset: stepIndex });
	if (budget > planLength)
		await runCases({ stepIndex: undefined, cases: budget - planLength, seedOffset: planLength });
	return { executedCases: caseNumber };
}

/**
 * A printed case names a route and a caller the campaign must actually run. Checked before any
 * group registers: a print from an older route inventory fails loudly instead of skipping every
 * group and reporting green with nothing replayed.
 */
export function assertReplayIsRegistered(
	replay: Pick<FailureReplay, 'route' | 'caller'>,
	families: readonly RequestFamily[],
): void {
	const registered = families.some(
		(family) =>
			routeKey(family.route) === replay.route &&
			(family.callers as readonly string[]).includes(replay.caller),
	);
	if (!registered)
		throw new Error(
			`SIGN_IN_FUZZ_REPLAY names ${replay.route} as ${replay.caller}, which the campaign inventory does not run: nothing would be replayed`,
		);
}

/** The variant keys the family plans for the synthetic context (the proved inventory every live case must equal). */
function planKeysOf(family: RequestFamily): readonly string[] {
	return family.variantSteps(syntheticRequestFamilyContext).map(variantKey);
}
