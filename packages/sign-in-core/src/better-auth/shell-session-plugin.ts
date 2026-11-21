import { createAuthEndpoint } from 'better-auth/api';

import type { OrganizationSessionView } from '#sign-in-core/organizations/person-organization-context';
import type { PersonSessionRecords } from '#sign-in-core/storage/models/person-session-records';

type ReadShellSessionEndpoint = ReturnType<
	typeof createAuthEndpoint.serverOnly<
		string,
		{ method: 'GET'; requireHeaders: true },
		OrganizationSessionView
	>
>;

/** Shell entry verifies the native cookie without invoking session refresh or expiry cleanup. */
export function createShellSessionPlugin(
	sessions: Pick<PersonSessionRecords, 'readLiveSessionByToken'>,
): {
	readonly id: 'switchboard-shell-session';
	readonly endpoints: { readonly readShellSession: ReadShellSessionEndpoint };
} {
	return {
		id: 'switchboard-shell-session',
		endpoints: {
			readShellSession: createAuthEndpoint.serverOnly(
				{ method: 'GET', requireHeaders: true },
				async (context): Promise<OrganizationSessionView> => {
					const token = await context.getSignedCookie(
						context.context.authCookies.sessionToken.name,
						context.context.secret,
					);
					if (typeof token !== 'string' || token.length === 0) return { kind: 'signed-out' };
					const stored = await sessions.readLiveSessionByToken(token);
					if (stored.kind === 'store-unavailable') return { kind: 'unavailable' };
					return stored.value === null
						? { kind: 'signed-out' }
						: { kind: 'session', value: stored.value };
				},
			),
		},
	};
}
