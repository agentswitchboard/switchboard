import { expect, it } from 'vitest';

import { personLinkTokenClaimsSchema } from '#sign-in-core/contracts/person-link-token';
import { epochMillisecondsSchema, uuid7Schema } from '#sign-in-core/contracts/sign-in-platform';
import type { FleetPermission } from '#sign-in-core/organizations/fleet-permission';
import type { PersonFleetAuthorizationSnapshot } from '#sign-in-core/organizations/person-fleet-issuance';
import { decidePersonLinkClaims } from '#sign-in-core/organizations/person-link-claims';
import { personIdSchema } from '#sign-in-core/storage/models/sign-in-store';

const snapshotAt = epochMillisecondsSchema.parse(2_208_988_800_000);
const issuedAtSeconds = 2_208_988_801;
const digest = 'd'.repeat(64);
const organizationId = '019a3dce-2000-7000-8000-000000000001';
const subjectId = '019a3dce-2000-7000-8000-000000000002';
const personId = personIdSchema.parse('019a3dce-2000-7000-8000-000000000003');
const tokenId = uuid7Schema.parse('019a3dce-2000-7000-8000-000000000004');
const issuer = 'https://sign-in.example.invalid';
const personLinkAudience = 'https://central.example.invalid/person-link';
const ownerPermissions: readonly FleetPermission[] = ['workspace:create', 'organization:view'];

function snapshot(
	overrides: Partial<PersonFleetAuthorizationSnapshot> = {},
): PersonFleetAuthorizationSnapshot {
	return {
		sessionExpiresAt: epochMillisecondsSchema.parse(snapshotAt + 3_600_000),
		organizationId,
		confirmation: {
			kind: 'confirmed',
			at: epochMillisecondsSchema.parse(snapshotAt - 600_000),
			method: 'passkey',
		},
		memberRole: 'owner',
		subject: { id: subjectId, revision: 3, state: 'active' },
		organizationFence: { revision: 2, state: 'active', permissionPolicyDigest: digest },
		...overrides,
	};
}

function decide(
	value: PersonFleetAuthorizationSnapshot | null,
): ReturnType<typeof decidePersonLinkClaims> {
	return decidePersonLinkClaims({
		issuance: {
			snapshot: value,
			snapshotAt,
			tokenLifetimeMilliseconds: 300_000,
			loadedPolicyDigest: digest,
			permissionsForRole: (role) =>
				role === 'owner' ? ownerPermissions : role === 'member' ? [] : null,
		},
		issuer,
		audience: personLinkAudience,
		subject: personId,
		issuedAtSeconds,
		tokenId,
	});
}

it('mints every person-link claim: the person-fleet facts under the person-link profile, audience and a 60 s lifetime', (): void => {
	// Expected values: C8 part B's claim list, written out, not derived from the builder.
	expect(decide(snapshot())).toEqual({
		kind: 'mint',
		claims: {
			iss: issuer,
			aud: personLinkAudience,
			sub: personId,
			iat: issuedAtSeconds,
			exp: issuedAtSeconds + 60,
			jti: tokenId,
			token_profile: 'person-link',
			organization_id: organizationId,
			authorization_subject_id: subjectId,
			person_revision: 3,
			organization_revision: 2,
			permission_policy_digest: digest,
			permissions: ['organization:view', 'workspace:create'],
			session_expires_at_ms: snapshotAt + 3_600_000,
			authorization_snapshot_at_ms: snapshotAt,
			authorization_snapshot_valid_until_ms: snapshotAt + 300_000,
			second_factor_at: Math.floor((snapshotAt - 600_000) / 1000),
			second_factor_method: 'passkey',
		},
	});
});

it('carries no cnf, no sid and no factor facts for an unconfirmed session', (): void => {
	const decided = decide(snapshot({ confirmation: { kind: 'unconfirmed' } }));
	if (decided.kind !== 'mint') throw new Error('Expected a token');
	const names = Object.keys(decided.claims);
	for (const absent of ['cnf', 'sid', 'second_factor_at', 'second_factor_method'])
		expect(names).not.toContain(absent);
	expect(decided.claims.exp - decided.claims.iat).toBeLessThanOrEqual(60);
});

it.each<{ readonly name: string; readonly value: PersonFleetAuthorizationSnapshot | null }>([
	{ name: 'no-session', value: null },
	{ name: 'no-membership', value: snapshot({ memberRole: null }) },
	{
		name: 'organization-inactive',
		value: snapshot({
			organizationFence: { revision: 2, state: 'stopped', permissionPolicyDigest: digest },
		}),
	},
	{ name: 'unknown-role', value: snapshot({ memberRole: 'auditor' }) },
])('refuses as the person-fleet issuance does: $name', ({ name, value }): void => {
	expect(decide(value)).toEqual({ kind: 'refused', reason: name });
});

it('the closed schema refuses cnf, sid, another profile, and a lifetime outside 1 to 60 s', (): void => {
	const decided = decide(snapshot());
	if (decided.kind !== 'mint') throw new Error('Expected a token');
	const minted = decided.claims;
	expect(personLinkTokenClaimsSchema.safeParse(minted).success).toBe(true);
	expect(
		personLinkTokenClaimsSchema.safeParse({ ...minted, cnf: { jkt: 'thumbprint' } }).success,
	).toBe(false);
	expect(personLinkTokenClaimsSchema.safeParse({ ...minted, sid: tokenId }).success).toBe(false);
	expect(
		personLinkTokenClaimsSchema.safeParse({ ...minted, token_profile: 'person-fleet' }).success,
	).toBe(false);
	expect(personLinkTokenClaimsSchema.safeParse({ ...minted, exp: minted.iat + 61 }).success).toBe(
		false,
	);
	expect(personLinkTokenClaimsSchema.safeParse({ ...minted, exp: minted.iat }).success).toBe(false);
});
