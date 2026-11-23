// The flags each `approvals` subcommand takes (PR #24 review S3). A flag a subcommand does not
// use is refused before any credential or request, so it can never be silently ignored.

export type ApprovalsSubcommand = 'list' | 'show' | 'approve' | 'deny' | 'answer';

/** Flags every approvals subcommand takes: the target file and how to sign in and keep keys. */
const sharedFlags = ['target', 'no-browser', 'memory-only'] as const;

const subcommandFlags = {
	list: ['all', 'cursor'],
	show: [],
	approve: ['option', 'operation-id'],
	deny: ['option', 'operation-id'],
	answer: ['field', 'operation-id'],
} as const satisfies Record<ApprovalsSubcommand, readonly string[]>;

/** The first supplied flag this subcommand does not take, or null when every flag is its own. */
export function unsupportedApprovalsFlag(
	subcommand: ApprovalsSubcommand,
	suppliedFlags: readonly string[],
): string | null {
	const allowed: readonly string[] = [...sharedFlags, ...subcommandFlags[subcommand]];
	return suppliedFlags.find((flag) => !allowed.includes(flag)) ?? null;
}

export function unsupportedFlagWords(subcommand: ApprovalsSubcommand, flag: string): string {
	const own = subcommandFlags[subcommand];
	const takes =
		own.length === 0 ? 'takes no options' : `takes ${own.map((name) => `--${name}`).join(', ')}`;
	return `approvals ${subcommand} does not take --${flag} (it ${takes}). Nothing was sent.`;
}
