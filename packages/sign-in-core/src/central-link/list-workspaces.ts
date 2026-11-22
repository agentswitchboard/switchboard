import type { z } from 'zod';

import type { listWorkspacesReplySchema } from '#sign-in-core/contracts/fleet-admin-wire';

type ListWorkspacesReply = z.infer<typeof listWorkspacesReplySchema>;
type WorkspacePage = Extract<ListWorkspacesReply, { readonly result: 'workspaces' }>;
export type ListWorkspacesPageResult = ListWorkspacesReply | { readonly result: 'unavailable' };

export type ListWorkspacesResult =
	| {
			readonly result: 'workspaces';
			readonly workspaces: readonly WorkspacePage['workspaces'][number][];
	  }
	| Extract<ListWorkspacesPageResult, { readonly result: 'refused' | 'unavailable' }>;

/** The request supplies the current browser's session for the organization-scoped person call. */
export type ListWorkspaces = (props: {
	readonly request: Request;
	readonly organizationId: string;
}) => Promise<ListWorkspacesResult>;

/** Expose only a complete directory read. A repeated cursor, out-of-order row,
 * or refusal on a later page must never look like a complete partial list.
 */
export async function collectWorkspacePages(
	readPage: (after: string | undefined) => Promise<ListWorkspacesPageResult>,
): Promise<ListWorkspacesResult> {
	const workspaces: WorkspacePage['workspaces'] = [];
	let after: string | undefined;
	for (;;) {
		const page = await readPage(after);
		if (page.result !== 'workspaces') return page;
		let previous = after;
		for (const workspace of page.workspaces) {
			if (previous !== undefined && workspace.workspaceId <= previous)
				return { result: 'unavailable' };
			previous = workspace.workspaceId;
			workspaces.push(workspace);
		}
		if (page.nextAfter === null) return { result: 'workspaces', workspaces };
		if (page.nextAfter !== previous || page.nextAfter === after) return { result: 'unavailable' };
		after = page.nextAfter;
	}
}
