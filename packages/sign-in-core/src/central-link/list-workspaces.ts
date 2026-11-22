import type { z } from 'zod';

import type { listWorkspacesReplySchema } from '#sign-in-core/central-link/fleet-admin-client';

export type ListWorkspacesResult =
	| z.infer<typeof listWorkspacesReplySchema>
	| { readonly result: 'unavailable' };

/** The request supplies the current browser's session for the organization-scoped person call. */
export type ListWorkspaces = (props: {
	readonly request: Request;
	readonly organizationId: string;
}) => Promise<ListWorkspacesResult>;
