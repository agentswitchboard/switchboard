import * as hegel from '@hegeldev/hegel';
import { z } from 'zod';

/** Printed alongside the shrunk draw so a finding can be rerun without a Hegel database. */
export const fuzzSeed = z.coerce
	.number()
	.int()
	.safe()
	.parse(process.env.SIGN_IN_FUZZ_SEED ?? 20261117);

/** `SIGN_IN_FUZZ_CASES`, when set: a deep run (more cases) or a reduced diagnostic run (fewer). */
export const fuzzCasesOverride: number | undefined =
	process.env.SIGN_IN_FUZZ_CASES === undefined
		? undefined
		: z.coerce.number().int().positive().parse(process.env.SIGN_IN_FUZZ_CASES);

/** Exactly `cases` cases from the seed, offset so separate runs of one group draw differently. */
export function fuzzSettingsExact(cases: number, seedOffset = 0): Partial<hegel.Settings> {
	return {
		testCases: cases,
		seed: fuzzSeed + seedOffset,
		derandomize: true,
		database: hegel.Database.disabled,
		// Every case drives a real host (and, in the request campaign, several hosts at once), so
		// Hegel's generation-speed check measures the host, not the generators.
		suppressHealthCheck: [hegel.HealthCheck.TooSlow],
	};
}

/** `cases`, unless `SIGN_IN_FUZZ_CASES` replaces it. */
export function fuzzSettings(defaultCases: number): Partial<hegel.Settings> {
	return fuzzSettingsExact(fuzzCasesOverride ?? defaultCases);
}

/**
 * Hegel 0.4.10 has no shrink limit, and each execution here drives a real host (about 0.5 to 1.6 s),
 * so an unbounded shrink of a failing group can run for minutes. After `maximumShrinkReplays`
 * executions following the first failure, further candidates are not run: each throws a
 * budget-exhausted error that says so and carries the latest failure an executed case really
 * produced, with its notes. Nothing reports a candidate that did not run as having failed, and the
 * report says it is unshrunk. (Rejecting candidates with assume(false) instead makes Hegel lose
 * the reproduction blob, "Hegel failure has no reproduction blob".) The final replay is then
 * the budget error, not a claim about the replayed draws.
 */
export const maximumShrinkReplays = 15;

/** Hegel's own run-control errors (not exported by the package) must reach its runner unchanged. */
function isHegelControlFlow(error: unknown): boolean {
	return error instanceof Error && (error.name === 'StopTestError' || error.name === 'AssumeError');
}

export function boundShrinking(
	property: (testCase: hegel.TestCase, note: (text: string) => void) => Promise<void>,
	options: { readonly maximumReplays?: number } = {},
): (testCase: hegel.TestCase) => Promise<void> {
	const maximumReplays = options.maximumReplays ?? maximumShrinkReplays;
	let latestExecutedFailure: string | undefined;
	let executionsAfterFirstFailure = 0;
	return async (testCase): Promise<void> => {
		if (latestExecutedFailure !== undefined) {
			executionsAfterFirstFailure += 1;
			if (executionsAfterFirstFailure > maximumReplays)
				throw new Error(
					`S5 shrink budget exhausted after ${maximumReplays} replays: this candidate was NOT run. ` +
						`UNSHRUNK finding, the latest failure an executed case produced:\n${latestExecutedFailure}`,
				);
		}
		const notes: string[] = [];
		try {
			await property(testCase, (text): void => {
				notes.push(text);
				testCase.note(text);
			});
		} catch (error) {
			if (!isHegelControlFlow(error))
				latestExecutedFailure = `${error instanceof Error ? error.message : String(error)}\n${notes.join('\n')}`;
			throw error;
		}
	};
}
