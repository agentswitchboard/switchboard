import { z } from 'zod';

import type {
	ListWorkspacesRequest_Deserialize,
	OrganizationAdminIntent_Serialize,
} from '#sign-in-core/central-link/generated/central-sign-in.gen';

export const centralUuid7Schema = z
	.string()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
/** The code points Rust's `char::is_whitespace` (Unicode White_Space) accepts. */
function isUnicodeWhitespace(codePoint: number): boolean {
	return (
		(codePoint >= 0x09 && codePoint <= 0x0d) ||
		(codePoint >= 0x2000 && codePoint <= 0x200a) ||
		[0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000].includes(codePoint)
	);
}
/** Central's ResourceName: 1..=256 UTF-8 bytes, no leading or trailing Unicode whitespace. */
export const fleetAdminWorkspaceNameSchema = z
	.string()
	// Every White_Space code point is in the BMP, so the end units decide; a surrogate never is.
	.refine((name) => {
		if (name.length === 0) return false;
		return (
			!isUnicodeWhitespace(name.charCodeAt(0)) &&
			!isUnicodeWhitespace(name.charCodeAt(name.length - 1))
		);
	}, 'A workspace name has no leading or trailing whitespace')
	.refine(
		(name) => new TextEncoder().encode(name).length <= 256,
		'A workspace name is at most 256 bytes',
	);

export const listWorkspacesPath = '/organization-admin/v1/list-workspaces';
export const listWorkspacesPageLimit = 100;

export const listWorkspacesRequestSchema = z.strictObject({
	operation: z.literal('ListWorkspaces'),
	organizationId: centralUuid7Schema,
	after: centralUuid7Schema.nullish(),
	limit: z.number().int().min(1).max(listWorkspacesPageLimit).optional(),
});
type ListWorkspacesInput = z.output<typeof listWorkspacesRequestSchema>;
export type ListWorkspacesIntent = Extract<
	OrganizationAdminIntent_Serialize,
	{ operation: 'ListWorkspaces' }
>;

export function listWorkspacesRequestBody(
	request: ListWorkspacesInput,
): ListWorkspacesRequest_Deserialize {
	return {
		organizationId: request.organizationId,
		...(request.after === undefined ? {} : { after: request.after }),
		...(request.limit === undefined ? {} : { limit: request.limit }),
	} satisfies ListWorkspacesRequest_Deserialize;
}

export function listWorkspacesIntent(request: ListWorkspacesInput): ListWorkspacesIntent {
	return {
		v: 1,
		operation: request.operation,
		organization: request.organizationId,
		target: request.organizationId,
		operationId: null,
		params: { after: request.after ?? null, limit: request.limit ?? listWorkspacesPageLimit },
	} satisfies ListWorkspacesIntent;
}
