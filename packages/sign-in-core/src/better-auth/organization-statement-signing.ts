import type { GenericEndpointContext } from '@better-auth/core';
import { signJWT } from 'better-auth/plugins/jwt';

import { signInJwtOptions } from '#sign-in-core/better-auth/native-jwt-options';
import type {
	OrganizationStampClaims_Deserialize,
	OrganizationStampHeader,
} from '#sign-in-core/central-link/generated/central-sign-in.gen';
import type { SignInConfiguration } from '#sign-in-core/contracts/deployment-configuration';
import {
	organizationStatementClaimsSchema,
	organizationStatementType,
	type OrganizationStatementSigningRequest,
} from '#sign-in-core/contracts/organization-statement';
import type { SignInClock } from '#sign-in-core/contracts/sign-in-platform';

/** Called only from a native endpoint; the provider owns key selection and storage. */
export async function signOrganizationStatement(props: {
	readonly context: GenericEndpointContext;
	readonly request: OrganizationStatementSigningRequest;
	readonly configuration: Pick<
		SignInConfiguration,
		'issuer' | 'centralIdentityAudience' | 'organizationStatementLifetimeSeconds'
	>;
	readonly clock: SignInClock;
}): Promise<string> {
	const issuedAt = Math.floor(props.clock.now() / 1000);
	const claims = organizationStatementClaimsSchema.parse({
		purpose: 'fleet-organization-stamp',
		version: 1,
		iss: props.configuration.issuer,
		aud: props.configuration.centralIdentityAudience,
		sub: props.request.organizationId,
		organization_id: props.request.organizationId,
		iat: issuedAt,
		exp: issuedAt + props.configuration.organizationStatementLifetimeSeconds,
		...(props.request.replaces === undefined ? {} : { replaces: props.request.replaces }),
	} satisfies OrganizationStampClaims_Deserialize);
	return signJWT(props.context, {
		options: signInJwtOptions(props.configuration),
		header: { typ: organizationStatementType } satisfies Pick<OrganizationStampHeader, 'typ'>,
		payload: claims,
	});
}
