import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { describe, expect, it } from 'vitest';

import {
	boundShrinking,
	fuzzSettingsExact,
	parseFailureEvidence,
	scriptedTestCase,
} from '#sign-in-test-support/fuzz/fuzz-settings';
import { assertRequestDisclosure } from '#sign-in-test-support/fuzz/request-disclosure';
import { requestFamilies } from '#sign-in-test-support/fuzz/request-families/index';
import { syntheticRequestFamilyContext } from '#sign-in-test-support/fuzz/request-families/synthetic-context';
import type { RequestStorageSnapshot } from '#sign-in-test-support/fuzz/request-storage-snapshot';

interface Execution {
	readonly value: number;
	readonly lastRun: boolean;
	readonly failed: boolean;
}

/** A property that fails for every value from 1000 up and so shrinks over many candidates. */
async function runFailingProperty(maximumReplays: number | undefined): Promise<{
	readonly message: string;
	readonly reportedValue: number;
	readonly executions: readonly Execution[];
}> {
	const executions: Execution[] = [];
	const property = boundShrinking(
		async (testCase): Promise<void> => {
			const value = testCase.draw(generators.integers({ minValue: 0, maxValue: 1_000_000 }));
			const failed = value >= 1000;
			executions.push({ value, lastRun: testCase.isLastRun, failed });
			if (failed) throw new Error(`failed for ${value}`);
		},
		maximumReplays === undefined ? {} : { maximumReplays },
	);
	let message = '';
	try {
		await hegel.testAsync(property, fuzzSettingsExact(50));
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	const reported = /failed for (\d+)/u.exec(message)?.[1];
	if (reported === undefined) throw new Error(`No failure reported: ${message}`);
	return { message, reportedValue: Number(reported), executions };
}

it('bounded shrinking never reports a candidate that did not run, and labels an unshrunk finding', async (): Promise<void> => {
	const cap = 3;
	const { message, executions } = await runFailingProperty(cap);
	const failures = executions.filter((execution) => execution.failed);
	expect(failures.length).toBeGreaterThan(0);
	// Only `cap` shrink candidates ran after the first failure; the rest were not run.
	const firstFailure = executions.findIndex((execution) => execution.failed);
	expect(executions.slice(firstFailure + 1).length).toBeLessThanOrEqual(cap);
	// The report names the budget, says the candidate was not run, and gives the latest failure an
	// executed case produced: its value is one the property really executed and failed on.
	expect(message).toContain('shrink budget exhausted');
	expect(message).toContain('NOT run');
	expect(message).toContain('UNSHRUNK');
	const reported = Number(/failed for (\d+)/u.exec(message)?.[1]);
	expect(failures.map((execution) => execution.value)).toContain(reported);
	// No post-budget candidate is ever claimed as a failure: the last executed failure is the latest reported.
	expect(reported).toBe(failures.at(-1)?.value);
});

it('an unbounded shrink reaches the minimal failing value, so the bound is the only thing that stops it', async (): Promise<void> => {
	const { reportedValue, executions } = await runFailingProperty(10_000);
	expect(reportedValue).toBe(1000);
	const bounded = await runFailingProperty(3);
	expect(bounded.executions.length).toBeLessThan(executions.length);
});

it('a capped replay prints the actual draws and the direct testCase.note trace of the latest executed failure', async (): Promise<void> => {
	const executed: { readonly a: number; readonly b: number; readonly failed: boolean }[] = [];
	const property = boundShrinking(
		async (testCase): Promise<void> => {
			const a = testCase.draw(generators.integers({ minValue: 0, maxValue: 1_000_000 }));
			const b = testCase.draw(generators.integers({ minValue: 0, maxValue: 9 }));
			// The trace is written to the test case directly (as the sequence campaign does), and the
			// failure message names neither draw.
			testCase.note(`operation-trace a-is-large=${a >= 1000}`);
			const failed = a >= 1000;
			executed.push({ a, b, failed });
			if (failed) throw new Error('property failed');
		},
		{ maximumReplays: 2 },
	);
	let message = '';
	try {
		await hegel.testAsync(property, fuzzSettingsExact(50));
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	const latest = executed.filter((execution) => execution.failed).at(-1);
	if (latest === undefined) throw new Error('No executed failure');
	expect(message).toContain('shrink budget exhausted');
	// The actual draws of that executed failure, in order, and its trace.
	expect(message).toContain(`draws: [${latest.a},${latest.b}]`);
	expect(message).toContain('operation-trace a-is-large=true');
});

describe('B5 closure: printed evidence replays the failure and says what it omitted', (): void => {
	it('says explicitly when entries were omitted or abbreviated', async (): Promise<void> => {
		const property = boundShrinking(
			async (testCase): Promise<void> => {
				const long = testCase.draw(generators.text({ minSize: 400, maxSize: 400 }));
				for (let index = 0; index < 205; index += 1)
					testCase.draw(generators.integers({ minValue: 0, maxValue: 9 }));
				testCase.note('a short note');
				throw new Error(`failed with ${long.length}`);
			},
			{ maximumReplays: 1 },
		);
		let message = '';
		try {
			await hegel.testAsync(property, fuzzSettingsExact(20));
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain('shrink budget exhausted');
		// The record keeps 200 entries: the other 6 draws (205 integers and the text make 206) are said to be omitted.
		expect(message).toMatch(/draws omitted: 6 of 206/u);
		expect(message).toMatch(/entries abbreviated to 300 characters/u);
	});

	it('replays a recorded failure from its printed draws and fails with the same named property', async (): Promise<void> => {
		// A wrong build: the host echoes the stored session token when a boundary field is long.
		const family = requestFamilies.find(
			(candidate) => candidate.route.path === '/api/auth/sign-in/social',
		);
		if (family === undefined) throw new Error('social family missing');
		const step = { encoding: 'json', field: 'callbackURL', mutation: 'boundary' } as const;
		const before: RequestStorageSnapshot = {
			session: [{ id: 'session-row', userId: 'person', token: 'session-secret' }],
		};
		const property = async (testCase: Pick<hegel.TestCase, 'draw'>): Promise<void> => {
			const generated = family.generate(testCase, syntheticRequestFamilyContext, step);
			const wire = generated.init.body;
			if (typeof wire !== 'string') throw new Error('the boundary step plans a text body');
			const body: unknown = JSON.parse(wire);
			const length = String(
				typeof body === 'object' && body !== null && 'callbackURL' in body ? body.callbackURL : '',
			).length;
			const text = length > 2000 ? '{"echo":"session-secret"}' : '{}';
			assertRequestDisclosure({
				fixture: {
					caller: 'owner',
					sessionId: 'session-row',
					cookie: '',
					forbiddenIdentities: [],
					foreignIdentities: [],
					invitedOrganizationId: 'org',
					invitedPersonId: 'person',
					issuedCredentials: [],
					context: { ...syntheticRequestFamilyContext, personId: 'person' },
				},
				path: '/api/auth/sign-in/social',
				request: generated,
				answer: {
					status: 200,
					headers: new Headers(),
					text,
					body: JSON.parse(text) as unknown,
					bodyKind: 'json',
				},
				before,
				after: before,
			});
		};
		let message = '';
		try {
			await hegel.testAsync(
				boundShrinking(async (testCase): Promise<void> => property(testCase), {
					maximumReplays: 1,
				}),
				fuzzSettingsExact(200),
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain('S2 credential-disclosure: body contains a stored credential');
		expect(message).toContain('UNSHRUNK');
		// Replay from the printed evidence alone: its draws, nothing else.
		const evidence = parseFailureEvidence(message);
		expect(evidence.complete).toBe(true);
		expect(evidence.draws.length).toBeGreaterThan(0);
		await expect(property(scriptedTestCase(evidence))).rejects.toThrow(
			'S2 credential-disclosure: body contains a stored credential',
		);
		// A control: the same replay with a short field does not fail, so the draws are what matters.
		await expect(
			property(scriptedTestCase({ draws: [10], complete: true })),
		).resolves.toBeUndefined();
		// And evidence that was abbreviated cannot be replayed: it refuses rather than guessing.
		expect(() =>
			scriptedTestCase(
				parseFailureEvidence(
					'draws: ["<abbreviated to 300 of 900 characters: x>"]\nentries abbreviated to 300 characters: 1 draw(s)',
				),
			),
		).toThrow('abbreviated');
	});
});
describe('B5 closure 3: notes omitted, and draws JSON cannot print', (): void => {
	async function printedFailure(
		draw: (testCase: hegel.TestCase) => unknown,
		notes = 0,
	): Promise<string> {
		const property = boundShrinking(
			async (testCase): Promise<void> => {
				draw(testCase);
				for (let index = 0; index < notes; index += 1) testCase.note(`note ${index}`);
				throw new Error('named property failed');
			},
			{ maximumReplays: 1 },
		);
		try {
			await hegel.testAsync(property, fuzzSettingsExact(5));
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		throw new Error('the property did not fail');
	}

	it('is not complete when the print says notes were omitted', async (): Promise<void> => {
		const message = await printedFailure(
			(testCase) => testCase.draw(generators.integers({ minValue: 0, maxValue: 9 })),
			205,
		);
		expect(message).toMatch(/notes omitted: 5 of 205/u);
		const evidence = parseFailureEvidence(message);
		expect(evidence.draws).toHaveLength(1);
		expect(evidence.complete).toBe(false);
		expect(() => scriptedTestCase(evidence)).toThrow(/incomplete/u);
	});

	it('prints a top-level undefined draw explicitly without throwing, and replays it as undefined', async (): Promise<void> => {
		const message = await printedFailure((testCase) => testCase.draw(generators.just(undefined)));
		expect(message).toContain('named property failed');
		expect(message).toContain('draws: [{"$undefined":true}]');
		const evidence = parseFailureEvidence(message);
		expect(evidence.complete).toBe(true);
		expect(scriptedTestCase(evidence).draw(generators.just(1))).toBeUndefined();
	});

	it('prints a draw JSON cannot print by name and refuses to replay it', async (): Promise<void> => {
		const message = await printedFailure((testCase) =>
			testCase.draw(generators.just(() => 'a function')),
		);
		expect(message).toContain('named property failed');
		expect(message).toContain('$unprintable');
		expect(parseFailureEvidence(message).complete).toBe(false);
	});
});
