import type { Uuid7 } from '#sign-in-core/contracts/sign-in-platform';
import type { SocialLoginProvider } from '#sign-in-core/contracts/social-login-provider';
import type { OrganizationPeopleChange } from '#sign-in-core/organizations/organization-change-record';
import type { IssuedPersonSession } from '#sign-in-core/response-release/sign-in-response-release';
import type { LoginLinkAuditChange } from '#sign-in-core/storage/linked-login-audit';
import type { PersonId } from '#sign-in-core/storage/models/sign-in-store';

export type ProviderLoginLinkState =
	| { readonly kind: 'none' }
	| { readonly kind: 'attempted'; readonly provider: SocialLoginProvider }
	| { readonly kind: 'intent-recorded'; readonly change: LoginLinkAuditChange }
	| { readonly kind: 'changed'; readonly change: LoginLinkAuditChange; readonly accountId: Uuid7 };

export interface ProviderRequestState {
	/** Set once a fenced batch committed in this request: the response then hints a drain. */
	authorizationFenceCommitted: boolean;
	readonly createdUserIds: string[];
	readonly issuedSessions: IssuedPersonSession[];
	machineToken:
		| { readonly kind: 'none' }
		| {
				readonly kind: 'granted';
				readonly machineId: Uuid7;
				readonly organizationId: Uuid7;
				readonly enrollmentId: Uuid7;
				readonly clientId: Uuid7;
				readonly decidedAt: number;
				readonly grantExpiresAt: number;
		  };
	loginLink: ProviderLoginLinkState;
	organizationActor:
		| { readonly kind: 'none' }
		| { readonly kind: 'authenticated'; readonly personId: PersonId; readonly sessionId: Uuid7 };
	peopleChange:
		| { readonly kind: 'none' }
		| { readonly kind: 'intent-recorded'; readonly change: OrganizationPeopleChange };
}

export function createProviderRequestState(): ProviderRequestState {
	return {
		authorizationFenceCommitted: false,
		createdUserIds: [],
		issuedSessions: [],
		machineToken: { kind: 'none' },
		loginLink: { kind: 'none' },
		organizationActor: { kind: 'none' },
		peopleChange: { kind: 'none' },
	};
}
