import { z } from 'zod';

import type { OrganizationStampClaims_Deserialize } from '#sign-in-core/central-link/generated/central-sign-in.gen';
import { organizationIdSchema } from '#sign-in-core/storage/models/sign-in-store';

export const organizationStatementType = 'fleet-organization-stamp+jwt';
/** Owner choice 3f: 120-day statements, renewed once 60 days or fewer remain. */
export const organizationStatementLifetimeSeconds = 120 * 24 * 60 * 60;
export const organizationStatementRenewalWindowSeconds = 60 * 24 * 60 * 60;
export const organizationStatementDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const organizationStatementSigningRequestSchema = z.strictObject({
	organizationId: organizationIdSchema,
	replaces: organizationStatementDigestSchema.optional(),
});
export type OrganizationStatementSigningRequest = z.infer<
	typeof organizationStatementSigningRequestSchema
>;

export const organizationStatementClaimsSchema = z
	.strictObject({
		purpose: z.literal('fleet-organization-stamp'),
		version: z.literal(1),
		iss: z.url(),
		aud: z.url(),
		sub: organizationIdSchema,
		organization_id: organizationIdSchema,
		iat: z.number().int().nonnegative(),
		exp: z.number().int().nonnegative(),
		replaces: organizationStatementDigestSchema.optional(),
	})
	.refine((claims) => claims.sub === claims.organization_id && claims.exp > claims.iat);
export type OrganizationStatementClaims = OrganizationStampClaims_Deserialize;
