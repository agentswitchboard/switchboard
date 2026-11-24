import { z } from 'zod';

import { uuid7Schema } from '#sign-in-core/contracts/sign-in-platform';

/** Central's complete ListWorkspaces read for the active organization, as the server got it. */
export const workspaceDirectorySchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('listed'),
		workspaces: z
			.array(
				z.strictObject({
					workspaceId: z.string(),
					name: z.string(),
					state: z.enum(['active', 'archiving', 'archived']),
				}),
			)
			.readonly(),
	}),
	z.strictObject({ kind: z.literal('refused') }),
	z.strictObject({ kind: z.literal('unavailable') }),
]);
export type WorkspaceDirectory = z.infer<typeof workspaceDirectorySchema>;

export const workspacesPageStateSchema = z.strictObject({
	directory: workspaceDirectorySchema,
	/** workspace:create in the active organization. */
	canCreate: z.boolean(),
	/** Central's ledger key and the new workspace's ID, kept across retries of one create. */
	operationId: uuid7Schema,
});
export type WorkspacesPageState = z.infer<typeof workspacesPageStateSchema>;

export const organizationAdminPageStateSchema = z.strictObject({
	/** Fleet setup for the active organization; null before its provisioning was ever recorded. */
	fleetSetup: z.enum(['settingUp', 'ready']).nullable(),
});
export type OrganizationAdminPageState = z.infer<typeof organizationAdminPageStateSchema>;

export const organizationSetupPendingMessage =
	"Switchboard hasn't finished setting up your organization yet. If this doesn't change, try again.";
