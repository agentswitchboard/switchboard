import { expect, it } from 'vitest';

import {
	collectWorkspacePages,
	type ListWorkspacesPageResult,
} from '#sign-in-core/central-link/list-workspaces';

const firstWorkspace = {
	workspaceId: '019a3dce-2000-7000-8000-000000000001',
	name: 'First workspace',
	description: '',
	state: 'active',
} as const;
const secondWorkspace = {
	...firstWorkspace,
	workspaceId: '019a3dce-2000-7000-8000-000000000002',
	name: 'Second workspace',
} as const;

it('follows the cursor and returns the entire checked workspace list', async (): Promise<void> => {
	const calls: (string | undefined)[] = [];
	const result = await collectWorkspacePages(async (after): Promise<ListWorkspacesPageResult> => {
		calls.push(after);
		return after === undefined
			? {
					result: 'workspaces',
					workspaces: [firstWorkspace],
					next: firstWorkspace.workspaceId,
				}
			: { result: 'workspaces', workspaces: [secondWorkspace], next: null };
	});
	expect(calls).toEqual([undefined, firstWorkspace.workspaceId]);
	expect(result).toEqual({ result: 'workspaces', workspaces: [firstWorkspace, secondWorkspace] });
});

it('discards a partial list when a later page repeats the cursor or refuses', async (): Promise<void> => {
	const firstPage = {
		result: 'workspaces',
		workspaces: [firstWorkspace],
		next: firstWorkspace.workspaceId,
	} as const;
	const repeated = await collectWorkspacePages(async () => ({
		...firstPage,
		workspaces: [...firstPage.workspaces],
	}));
	expect(repeated).toEqual({ result: 'unavailable' });
	const laterRefused = await collectWorkspacePages(async (after) =>
		after === undefined
			? { ...firstPage, workspaces: [...firstPage.workspaces] }
			: { result: 'refused', reason: 'authorizationSyncRequired' },
	);
	expect(laterRefused).toEqual({ result: 'refused', reason: 'authorizationSyncRequired' });
});
