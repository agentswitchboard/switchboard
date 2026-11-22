import * as hegel from '@hegeldev/hegel';
import { z } from 'zod';

/** Printed alongside the shrunk draw so a finding can be rerun without a Hegel database. */
export const fuzzSeed = z.coerce
	.number()
	.int()
	.safe()
	.parse(process.env.SIGN_IN_FUZZ_SEED ?? 20261117);

export function fuzzSettings(defaultCases: number): Partial<hegel.Settings> {
	return {
		testCases: z.coerce
			.number()
			.int()
			.positive()
			.parse(process.env.SIGN_IN_FUZZ_CASES ?? defaultCases),
		seed: fuzzSeed,
		derandomize: true,
		database: hegel.Database.disabled,
		// Every case drives a real host (and, in the request campaign, several hosts at once), so
		// Hegel's generation-speed check measures the host, not the generators.
		suppressHealthCheck: [hegel.HealthCheck.TooSlow],
	};
}

/** Real host cases take about 1.5 s, so a shrink replay budget keeps a failure from running for minutes. */
const maximumShrinkReplays = 15;

/** Hegel's own run-control errors (not exported by the package) must reach its runner unchanged. */
function isHegelControlFlow(error: unknown): boolean {
	return error instanceof Error && (error.name === 'StopTestError' || error.name === 'AssumeError');
}

/**
 * Bound shrinking for a property whose every execution is expensive. The first failure is
 * remembered; after `maximumShrinkReplays` further executions each execution re-throws the latest
 * real failure without doing the work, so the shrinker finishes immediately and the final replay
 * reports that failure together with the notes recorded when it really happened.
 */
export function boundShrinking(
	property: (testCase: hegel.TestCase, note: (text: string) => void) => Promise<void>,
): (testCase: hegel.TestCase) => Promise<void> {
	let latestFailure: Error | undefined;
	let executionsAfterFirstFailure = 0;
	return async (testCase): Promise<void> => {
		if (latestFailure !== undefined) {
			executionsAfterFirstFailure += 1;
			if (executionsAfterFirstFailure > maximumShrinkReplays) throw latestFailure;
		}
		const notes: string[] = [];
		try {
			await property(testCase, (text): void => {
				notes.push(text);
				testCase.note(text);
			});
		} catch (error) {
			if (isHegelControlFlow(error)) throw error;
			const reason = error instanceof Error ? error.message : String(error);
			latestFailure = new Error(`${reason}\n${notes.join('\n')}`, { cause: error });
			throw latestFailure;
		}
	};
}
