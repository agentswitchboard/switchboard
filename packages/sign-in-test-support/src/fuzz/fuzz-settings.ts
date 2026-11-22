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

/** What an executed case did, kept so a stopped shrink can still print it. */
interface ExecutedCaseRecord {
	/** The first `maximumRecordedEntries` draws, each as its JSON value or an abbreviation marker. */
	readonly draws: unknown[];
	drawCount: number;
	abbreviatedDraws: number;
	readonly notes: string[];
	noteCount: number;
}

const maximumRecordedEntries = 200;
const maximumRecordedLength = 300;
const abbreviationMarker = '<abbreviated';

function printable(value: unknown): string {
	try {
		return JSON.stringify(value, (_key, item: unknown) =>
			typeof item === 'bigint' ? item.toString() : item,
		);
	} catch {
		return JSON.stringify(String(value));
	}
}

/** A draw as it is printed: its JSON value, or a marker saying it was cut at the character cap. */
function recordedDraw(value: unknown, record: ExecutedCaseRecord): unknown {
	const text = printable(value);
	if (text.length <= maximumRecordedLength) return JSON.parse(text);
	record.abbreviatedDraws += 1;
	return `${abbreviationMarker} to ${maximumRecordedLength} of ${text.length} characters: ${text.slice(0, maximumRecordedLength)}>`;
}

/** The record as the lines the budget error prints; every cap it hit is said, not implied. */
function describeRecord(record: ExecutedCaseRecord): readonly string[] {
	return [
		`draws: ${JSON.stringify(record.draws)}`,
		...(record.drawCount > record.draws.length
			? [
					`draws omitted: ${record.drawCount - record.draws.length} of ${record.drawCount} (only the first ${maximumRecordedEntries} are kept)`,
				]
			: []),
		...(record.abbreviatedDraws > 0
			? [
					`entries abbreviated to ${maximumRecordedLength} characters: ${record.abbreviatedDraws} draw(s)`,
				]
			: []),
		...(record.noteCount > record.notes.length
			? [
					`notes omitted: ${record.noteCount - record.notes.length} of ${record.noteCount} (only the first ${maximumRecordedEntries} are kept)`,
				]
			: []),
		...record.notes,
	];
}

export interface FailureEvidence {
	readonly draws: readonly unknown[];
	/** False when the print omitted or abbreviated anything: such evidence cannot be replayed. */
	readonly complete: boolean;
}

/** The JSON array at the start of `text`, whatever follows it on the line (Hegel appends the origin to a final line). */
function leadingJsonArray(text: string): string {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index += 1) {
		const character = text.charAt(index);
		if (inString) {
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === '"') inString = false;
		} else if (character === '"') inString = true;
		else if (character === '[') depth += 1;
		else if (character === ']') {
			depth -= 1;
			if (depth === 0) return text.slice(0, index + 1);
		}
	}
	throw new Error('The printed draws are not a complete JSON array');
}

/** Read the draws back out of a printed UNSHRUNK budget error. */
export function parseFailureEvidence(message: string): FailureEvidence {
	const line = message.split('\n').find((candidate) => candidate.startsWith('draws: '));
	const parsed: unknown =
		line === undefined ? [] : JSON.parse(leadingJsonArray(line.slice('draws: '.length)));
	const draws = Array.isArray(parsed) ? parsed : [];
	const complete =
		line !== undefined &&
		!/^draws omitted: /mu.test(message) &&
		!/^entries abbreviated to /mu.test(message) &&
		!draws.some((draw) => typeof draw === 'string' && draw.startsWith(abbreviationMarker));
	return { draws, complete };
}

/**
 * A test case that answers each draw from printed evidence, in order, so a recorded failure is
 * rerun with exactly the values it drew. It refuses evidence that was omitted or abbreviated, and
 * a replay that draws more than was printed.
 */
export function scriptedTestCase(evidence: FailureEvidence): Pick<hegel.TestCase, 'draw' | 'note'> {
	if (!evidence.complete)
		throw new Error(
			'The printed evidence is incomplete (omitted or abbreviated entries): it cannot be replayed',
		);
	let next = 0;
	return {
		draw: <Value>(): Value => {
			if (next >= evidence.draws.length)
				throw new Error('The replay drew more values than the printed evidence holds');
			const value = evidence.draws[next];
			next += 1;
			return value as Value;
		},
		note: (): void => undefined,
	};
}

/**
 * The test case the property sees: every draw and every note goes on to Hegel unchanged and is also
 * kept in the record, so a property that writes its trace to the test case directly (the sequence
 * campaign) and the values it drew are available when the budget stops the final replay.
 */
function recordingTestCase(testCase: hegel.TestCase, record: ExecutedCaseRecord): hegel.TestCase {
	return new Proxy(testCase, {
		get(target, property): unknown {
			const value: unknown = Reflect.get(target, property, target);
			if (typeof value !== 'function') return value;
			if (property === 'draw')
				return (generator: Parameters<hegel.TestCase['draw']>[0]): unknown => {
					const drawn: unknown = target.draw(generator);
					record.drawCount += 1;
					if (record.draws.length < maximumRecordedEntries)
						record.draws.push(recordedDraw(drawn, record));
					return drawn;
				};
			if (property === 'note')
				return (message: string): void => {
					record.noteCount += 1;
					if (record.notes.length < maximumRecordedEntries) record.notes.push(message);
					target.note(message);
				};
			return (value as (...args: unknown[]) => unknown).bind(target);
		},
	});
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
		const record: ExecutedCaseRecord = {
			draws: [],
			drawCount: 0,
			abbreviatedDraws: 0,
			notes: [],
			noteCount: 0,
		};
		const recorded = recordingTestCase(testCase, record);
		try {
			await property(recorded, (text): void => {
				recorded.note(text);
			});
		} catch (error) {
			if (!isHegelControlFlow(error))
				latestExecutedFailure = [
					error instanceof Error ? error.message : String(error),
					...describeRecord(record),
				].join('\n');
			throw error;
		}
	};
}
