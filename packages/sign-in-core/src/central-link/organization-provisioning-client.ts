import { z } from 'zod';

import type { CentralTransport } from '#sign-in-core/central-link/central-transport';
import type {
	OrganizationStatementDigestReply,
	ProvisionOrganization,
	ProvisionOrganizationResult,
	ReadOrganizationStatementDigest,
} from '#sign-in-core/central-link/generated/central-sign-in.gen';
import type { AssertWireType, WireTypesEqual } from '#sign-in-core/central-link/wire-type-equality';
import { organizationStatementDigestSchema } from '#sign-in-core/contracts/organization-statement';
import type {
	CentralLinkUncertainty,
	OrganizationProvisioningClient,
	OrganizationStatementDigestAnswer,
	ProvisionOrganizationAnswer,
} from '#sign-in-core/organizations/organization-provisioning';
import { organizationIdSchema } from '#sign-in-core/storage/models/sign-in-store';

// Producer: codex-router identity_contract/organization_provisioning.rs and its closed JSON schemas.
const lowercaseOrganizationIdSchema = organizationIdSchema.refine(
	(value) => value === value.toLowerCase(),
);
/** Central bounds the compact JWS; it checks the signature and profile itself. */
const organizationStatementWireSchema = z
	.string()
	.min(5)
	.max(4096)
	.regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
export const centralProvisioningRequestSchema = z.strictObject({
	organizationId: lowercaseOrganizationIdSchema,
	organizationStatement: organizationStatementWireSchema,
});
export const centralProvisioningReplySchema = z.strictObject({ result: z.literal('provisioned') });
export const centralStatementDigestRequestSchema = z.strictObject({
	organizationId: lowercaseOrganizationIdSchema,
});
export const centralStatementDigestReplySchema = z.strictObject({
	digest: organizationStatementDigestSchema,
	expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	signingKeyId: z.string().min(1),
});
export type CentralProvisioningReplyTypes = [
	AssertWireType<
		WireTypesEqual<z.output<typeof centralProvisioningReplySchema>, ProvisionOrganizationResult>
	>,
	AssertWireType<
		WireTypesEqual<
			z.output<typeof centralStatementDigestReplySchema>,
			OrganizationStatementDigestReply
		>
	>,
];

const provisioningRoute = 'http://central.invalid/internal/organization-provisioning';
const statementDigestRoute = 'http://central.invalid/internal/organization-statement-digest';

type CentralLinkReply =
	| { readonly kind: 'answered'; readonly status: number; readonly body: unknown }
	| { readonly kind: 'unanswered'; readonly reason: CentralLinkUncertainty };

/** One explicit invocation sends once; an error body can never confirm setup. */
export function createOrganizationProvisioningClient(
	transport: CentralTransport,
): OrganizationProvisioningClient {
	return {
		async provisionOrganization(input): Promise<ProvisionOrganizationAnswer> {
			const reply = await postPrivately(
				transport,
				provisioningRoute,
				centralProvisioningRequestSchema.parse({
					organizationId: input.organizationId,
					organizationStatement: input.organizationStatement,
				}) satisfies ProvisionOrganization,
				input.signal,
			);
			if (reply.kind === 'unanswered') return { kind: 'unknown', reason: reply.reason };
			switch (reply.status) {
				case 200:
					return centralProvisioningReplySchema.safeParse(reply.body).success
						? { kind: 'provisioned' }
						: { kind: 'unknown', reason: 'malformed-reply' };
				case 403:
					return { kind: 'refused', reason: 'organization-mismatch' };
				case 409:
					return { kind: 'refused', reason: 'stale' };
				case 422:
					return { kind: 'refused', reason: 'invalid-statement' };
				default:
					return { kind: 'unknown', reason: 'unavailable' };
			}
		},
		async readStatementDigest(organizationId, options): Promise<OrganizationStatementDigestAnswer> {
			const reply = await postPrivately(
				transport,
				statementDigestRoute,
				centralStatementDigestRequestSchema.parse({
					organizationId,
				}) satisfies ReadOrganizationStatementDigest,
				options?.signal,
			);
			if (reply.kind === 'unanswered') return { kind: 'unavailable', reason: reply.reason };
			if (reply.status === 404) return { kind: 'none' };
			if (reply.status !== 200) return { kind: 'unavailable', reason: 'unavailable' };
			const parsed = centralStatementDigestReplySchema.safeParse(reply.body);
			return parsed.success
				? { kind: 'current', ...parsed.data }
				: { kind: 'unavailable', reason: 'malformed-reply' };
		},
	};
}

/** Only a 200 carries a contract body; every other status is read for its code alone. */
async function postPrivately(
	transport: CentralTransport,
	route: string,
	body: unknown,
	signal: AbortSignal | undefined,
): Promise<CentralLinkReply> {
	let response: Response;
	try {
		response = await transport.fetch(
			new Request(route, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				...(signal === undefined ? {} : { signal }),
			}),
		);
	} catch (error) {
		return {
			kind: 'unanswered',
			reason: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unavailable',
		};
	}
	if (response.status !== 200) return { kind: 'answered', status: response.status, body: null };
	try {
		const payload: unknown = await response.json();
		return { kind: 'answered', status: 200, body: payload };
	} catch {
		return { kind: 'unanswered', reason: 'malformed-reply' };
	}
}
