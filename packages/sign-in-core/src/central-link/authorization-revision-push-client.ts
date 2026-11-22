import { z } from 'zod';

import type { CentralTransport } from '#sign-in-core/central-link/central-transport';
import type {
	AuthorizationRevision,
	AuthorizationRevisionAcknowledgement,
} from '#sign-in-core/central-link/generated/central-sign-in.gen';
import type { AssertWireType, WireTypesEqual } from '#sign-in-core/central-link/wire-type-equality';
import type { CentralLinkUncertainty } from '#sign-in-core/organizations/organization-provisioning';

// Producer fixtures: contract-fixtures/central-authorization-revisions/.
const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const lowercaseUuid7Schema = z.uuidv7().refine((value) => value === value.toLowerCase());
export const organizationRevisionPushSchema = z.strictObject({
	kind: z.literal('organization'),
	organizationId: lowercaseUuid7Schema,
	revision: revisionSchema,
	state: z.enum(['active', 'stopped', 'deleted']),
	permissionPolicyDigest: z.string().regex(/^[0-9a-f]{64}$/u),
});
export const personRevisionPushSchema = z.strictObject({
	kind: z.literal('person'),
	organizationId: lowercaseUuid7Schema,
	personId: lowercaseUuid7Schema,
	subjectId: lowercaseUuid7Schema,
	revision: revisionSchema,
	state: z.enum(['active', 'inactive']),
});
export const authorizationRevisionPushSchema = z.discriminatedUnion('kind', [
	organizationRevisionPushSchema,
	personRevisionPushSchema,
]);
export type AuthorizationRevisionPush = AuthorizationRevision;
export const authorizationRevisionAcknowledgementSchema = z.strictObject({
	acknowledgedRevision: revisionSchema,
});
export type AuthorizationRevisionWireTypes = [
	AssertWireType<
		WireTypesEqual<z.output<typeof authorizationRevisionPushSchema>, AuthorizationRevision>
	>,
	AssertWireType<
		WireTypesEqual<
			z.output<typeof authorizationRevisionAcknowledgementSchema>,
			AuthorizationRevisionAcknowledgement
		>
	>,
];

/** Central's answer: its retained floor after commit, a definite refusal, or nothing certain. */
export type AuthorizationRevisionPushAnswer =
	| ({ readonly kind: 'acknowledged' } & Readonly<AuthorizationRevisionAcknowledgement>)
	| {
			readonly kind: 'refused';
			readonly reason: 'conflict' | 'organization-floor-missing' | 'organization-mismatch';
	  }
	/**
	 * Central itself answered 503. Pinned central `e847a888` answers an unstamped store that way
	 * too, revealing nothing, so only a digest read can tell the two apart (WS7 R-push503).
	 */
	| { readonly kind: 'answered-unavailable' }
	| { readonly kind: 'unknown'; readonly reason: CentralLinkUncertainty };

export interface AuthorizationRevisionPushClient {
	/** `signal` aborts the in-flight link request at the guard run's deadline (D7). */
	readonly pushAuthorizationRevision: (
		push: AuthorizationRevisionPush,
		options?: { readonly signal?: AbortSignal },
	) => Promise<AuthorizationRevisionPushAnswer>;
}

const pushRoute = 'http://central.invalid/internal/organization-authorization-revisions';

/** Each push is idempotent at central, so a caller may resend the same version freely. */
export function createAuthorizationRevisionPushClient(
	transport: CentralTransport,
): AuthorizationRevisionPushClient {
	return {
		async pushAuthorizationRevision(push, options): Promise<AuthorizationRevisionPushAnswer> {
			let response: Response;
			try {
				response = await transport.fetch(
					new Request(pushRoute, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(
							authorizationRevisionPushSchema.parse(push) satisfies AuthorizationRevision,
						),
						...(options?.signal === undefined ? {} : { signal: options.signal }),
					}),
				);
			} catch (error) {
				return {
					kind: 'unknown',
					reason:
						error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unavailable',
				};
			}
			switch (response.status) {
				case 200: {
					let payload: unknown;
					try {
						payload = await response.json();
					} catch {
						return { kind: 'unknown', reason: 'malformed-reply' };
					}
					const parsed = authorizationRevisionAcknowledgementSchema.safeParse(payload);
					return parsed.success
						? { kind: 'acknowledged', acknowledgedRevision: parsed.data.acknowledgedRevision }
						: { kind: 'unknown', reason: 'malformed-reply' };
				}
				case 403:
					return { kind: 'refused', reason: 'organization-mismatch' };
				case 409:
					return { kind: 'refused', reason: 'conflict' };
				case 412:
					return { kind: 'refused', reason: 'organization-floor-missing' };
				case 503:
					return { kind: 'answered-unavailable' };
				default:
					return { kind: 'unknown', reason: 'unavailable' };
			}
		},
	};
}
