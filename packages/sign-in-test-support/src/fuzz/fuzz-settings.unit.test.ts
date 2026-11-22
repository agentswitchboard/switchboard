import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import { boundShrinking, fuzzSettingsExact } from '#sign-in-test-support/fuzz/fuzz-settings';

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
	expect(message).toContain(`draws: [${latest.a}, ${latest.b}]`);
	expect(message).toContain('operation-trace a-is-large=true');
});
