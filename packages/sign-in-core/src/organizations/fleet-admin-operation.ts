import { z } from 'zod';

import { canonicalJson, type CanonicalJsonValue } from '#sign-in-core/contracts/canonical-json';
import type { SignInCrypto } from '#sign-in-core/contracts/sign-in-platform';

// Central's published admin wire (codex-router 7fb2de88a, `contracts/*Request.schema.json`,
// vendored in `contract-fixtures/central-organization-admin/`): closed bodies, routes and the
// T06 signed intent. Central refuses, never trims, a body outside these rules.
const centralUuid7Schema = z
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
	.refine((name) => utf8ByteLength(name) <= 256, 'A workspace name is at most 256 bytes');
export const fleetAdminRequestSchema = z.discriminatedUnion('operation', [
	z.strictObject({
		operation: z.literal('CreateWorkspace'),
		organizationId: centralUuid7Schema,
		/** Chosen once by the page and kept on every retry; central's ledger key. */
		operationId: centralUuid7Schema,
		name: fleetAdminWorkspaceNameSchema,
		description: z
			.string()
			.refine((text) => utf8ByteLength(text) <= 2048, 'A description is at most 2048 bytes'),
	}),
	z.strictObject({
		operation: z.literal('WorkspaceLookup'),
		organizationId: centralUuid7Schema,
		workspaceId: centralUuid7Schema,
	}),
	z.strictObject({
		operation: z.literal('ListWorkspaces'),
		organizationId: centralUuid7Schema,
	}),
	z.strictObject({
		operation: z.literal('ReadChangeRecords'),
		organizationId: centralUuid7Schema,
		/** The last record ID of the previous page; null for the first. */
		after: z.uuid().nullable(),
		limit: z.number().int().min(1).max(100),
	}),
]);
export type FleetAdminRequest = z.infer<typeof fleetAdminRequestSchema>;

function utf8ByteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

export const fleetAdminRoutePaths = {
	CreateWorkspace: '/organization-admin/v1/create-workspace',
	WorkspaceLookup: '/organization-admin/v1/workspace-lookup',
	ListWorkspaces: '/organization-admin/v1/list-workspaces',
	ReadChangeRecords: '/organization-admin/v1/change-records',
} as const satisfies Record<FleetAdminRequest['operation'], string>;

/** The closed JSON body central parses for the route; the body never names its operation. */
export function fleetAdminRequestBody(operation: FleetAdminRequest): CanonicalJsonValue {
	switch (operation.operation) {
		case 'CreateWorkspace':
			return {
				organizationId: operation.organizationId,
				operationId: operation.operationId,
				name: operation.name,
				description: operation.description,
			};
		case 'WorkspaceLookup':
			return { organizationId: operation.organizationId, workspaceId: operation.workspaceId };
		case 'ListWorkspaces':
			return { organizationId: operation.organizationId };
		case 'ReadChangeRecords':
			return {
				organizationId: operation.organizationId,
				after: operation.after,
				limit: operation.limit,
			};
		default:
			return unreachableOperation(operation);
	}
}

/** T06: `{v:1, operation, organization, target, operationId, params}`, params holding every effect field. */
export function fleetAdminIntent(operation: FleetAdminRequest): CanonicalJsonValue {
	const organization = operation.organizationId;
	switch (operation.operation) {
		case 'CreateWorkspace':
			return {
				v: 1,
				operation: operation.operation,
				organization,
				target: organization,
				operationId: operation.operationId,
				params: { name: operation.name, description: operation.description },
			};
		case 'WorkspaceLookup':
		case 'ListWorkspaces':
			return {
				v: 1,
				operation: operation.operation,
				organization,
				target: operation.operation === 'WorkspaceLookup' ? operation.workspaceId : organization,
				operationId: null,
				params: {},
			};
		case 'ReadChangeRecords':
			return {
				v: 1,
				operation: operation.operation,
				organization,
				target: organization,
				operationId: null,
				params: { after: operation.after, limit: operation.limit },
			};
		default:
			return unreachableOperation(operation);
	}
}

/** The proof's `intent` claim: base64url(SHA-256(RFC 8785 JCS(intent))). */
export async function fleetAdminIntentDigest(
	crypto: SignInCrypto,
	operation: FleetAdminRequest,
): Promise<string> {
	return base64UrlSha256(crypto, canonicalJson(fleetAdminIntent(operation)));
}

/** base64url without padding, as central's `sha256_url`. */
export async function base64UrlSha256(crypto: SignInCrypto, text: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
	);
	let binary = '';
	for (const byte of digest) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function unreachableOperation(_operation: never): never {
	throw new Error('Unknown Fleet admin operation');
}
