import {
	organizationPersonTokenClaimsSchema,
	personSessionConfirmationSchema,
} from '@agent-collaboration/sign-in-core/person-identity';
import { z } from 'zod';

const personClaims = {
	iss: 'https://sign-in.example.invalid',
	sub: '11111111-1111-7111-8111-111111111111',
	aud: 'https://central.example.invalid/admin',
	iat: 2_208_988_800,
	exp: 2_208_989_400,
	scope: 'organization:admin',
	client_id: 'person-admin-client',
	azp: 'person-admin-client',
	sid: '22222222-2222-7222-8222-222222222222',
	jti: 'opaque-provider-token-identifier',
	organization_id: '33333333-3333-7333-8333-333333333333',
};

/** Structural values, not minted tokens or observed introspection output. */
export function personIdentityFixtureArtifacts(): Readonly<Record<string, unknown>> {
	const activeConfirmation = {
		active: true,
		sub: personClaims.sub,
		sid: personClaims.sid,
		aud: personClaims.aud,
		exp: personClaims.exp,
		organization_id: personClaims.organization_id,
		checkedAt: 2_208_988_800_000,
	};
	return {
		'K5.schema.json': z.toJSONSchema(personSessionConfirmationSchema, { target: 'draft-2020-12' }),
		'K6.schema.json': z.toJSONSchema(organizationPersonTokenClaimsSchema, {
			target: 'draft-2020-12',
		}),
		'K5.fixtures.json': {
			contract: 'K5SessionConfirmation',
			examples: {
				inactive: personSessionConfirmationSchema.parse({ active: false }),
				active: personSessionConfirmationSchema.parse({
					...activeConfirmation,
					permission: 'organization:view',
				}),
				approvalDecision: personSessionConfirmationSchema.parse({
					...activeConfirmation,
					permission: 'approval:decide',
				}),
			},
		},
		'K6.fixtures.json': {
			contract: 'K6OrganizationPersonTokenClaims',
			examples: {
				providerSession: organizationPersonTokenClaimsSchema.parse(personClaims),
				app: organizationPersonTokenClaimsSchema.parse({
					...personClaims,
					second_factor_at: 2_208_988_790,
					second_factor_method: 'app',
				}),
				recoveryCode: organizationPersonTokenClaimsSchema.parse({
					...personClaims,
					second_factor_at: 2_208_988_790,
					second_factor_method: 'recoveryCode',
				}),
				passkey: organizationPersonTokenClaimsSchema.parse({
					...personClaims,
					second_factor_at: 2_208_988_790,
					second_factor_method: 'passkey',
				}),
			},
		},
	};
}

export function encodePersonIdentityFixture(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}
