import type { BetterAuthPlugin } from '@better-auth/core';
import { APIError, createAuthEndpoint, createAuthMiddleware, isAPIError } from 'better-auth/api';
import { z } from 'zod';

import {
	requireFactorActor,
	requireFactorChange,
	type FactorActor,
} from '#sign-in-core/better-auth/second-factor-authorization';
import { requireStoredValue } from '#sign-in-core/better-auth/store-result-adapters';
import { uuid7Schema, type SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';
import type { FactorChangeRecord } from '#sign-in-core/second-factors/factor-change-record';
import type { FactorChange } from '#sign-in-core/second-factors/second-factor-step-up';
import type { SignInStore } from '#sign-in-core/storage/models/sign-in-store';

const mutationPathSchema = z.enum([
	'/two-factor/enable',
	'/two-factor/generate-backup-codes',
	'/passkey/verify-registration',
	'/passkey/update-passkey',
	'/passkey/remove',
	'/two-factor/remove-app',
]);
const mutations = {
	'/two-factor/enable': { action: 'app-enrollment-started', change: 'begin-app-enrollment' },
	'/two-factor/generate-backup-codes': {
		action: 'recovery-codes-rotated',
		change: 'rotate-recovery-codes',
	},
	'/passkey/verify-registration': { action: 'passkey-added', change: 'add-passkey' },
	'/passkey/update-passkey': { action: 'passkey-renamed', change: 'rename-passkey' },
	'/passkey/remove': { action: 'passkey-removed', change: 'remove-passkey' },
	'/two-factor/remove-app': { action: 'app-removed', change: 'remove-app' },
} as const satisfies Readonly<
	Record<
		z.infer<typeof mutationPathSchema>,
		{ readonly action: FactorChangeRecord['action']; readonly change: FactorChange }
	>
>;
const nativeRemovals = new Set([
	'/two-factor/disable',
	'/passkey/delete-passkey',
	'/two-factor/get-totp-uri',
]);
const confirmationPaths = new Set(['/two-factor/verify-totp', '/two-factor/verify-backup-code']);

const registrationRequestSchema = z.object({
	response: z.object({
		id: z.base64url().min(1),
		rawId: z.base64url().min(1),
		type: z.literal('public-key'),
		response: z.object({
			clientDataJSON: z.base64url().min(1),
			attestationObject: z.base64url().min(1),
			transports: z.array(z.string()).optional(),
		}),
		clientExtensionResults: z.record(z.string(), z.unknown()),
		authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
	}),
});

export function createSecondFactorProviderPlugin(props: {
	readonly store: Pick<SignInStore, 'factors' | 'factorChanges'>;
	readonly platform: Pick<SignInPlatform, 'clock' | 'ids'>;
}): BetterAuthPlugin {
	let pending:
		| { readonly kind: 'none' }
		| {
				readonly kind: 'recorded';
				readonly change: FactorChangeRecord;
				readonly actor: FactorActor;
		  } = { kind: 'none' };
	function requireMutationPermission(actor: FactorActor, change: FactorChange): void {
		requireFactorChange({ clock: props.platform.clock, factors: actor.factors, change });
	}
	return {
		id: 'sign-in-second-factors',
		hooks: {
			before: [
				{
					matcher: (context) =>
						nativeRemovals.has(context.path ?? '') ||
						confirmationPaths.has(context.path ?? '') ||
						mutationPathSchema.safeParse(context.path).success ||
						context.path === '/passkey/generate-register-options',
					handler: createAuthMiddleware(async (context): Promise<void> => {
						const pathname = context.path ?? '';
						if (nativeRemovals.has(pathname))
							throw new APIError('NOT_FOUND', { code: 'NOT_OFFERED', message: 'not-found' });
						const body = z.record(z.string(), z.unknown()).safeParse(context.body);
						if (
							body.success &&
							(body.data.trustDevice === true || body.data.createSession === true)
						)
							throw new APIError('BAD_REQUEST', {
								code: 'NOT_OFFERED',
								message: 'option-not-offered',
							});
						const actor = await requireFactorActor({ context, store: props.store.factors });
						if (pathname === '/passkey/generate-register-options') {
							requireMutationPermission(actor, 'add-passkey');
							return;
						}
						let action: FactorChangeRecord['action'];
						let targetId = uuid7Schema.parse(actor.personId);
						if (confirmationPaths.has(pathname)) {
							if (
								pathname === '/two-factor/verify-backup-code' &&
								actor.factors.enrollment.kind === 'never-enrolled'
							)
								throw new APIError('FORBIDDEN', { code: 'APP_REQUIRED', message: 'appRequired' });
							action =
								pathname === '/two-factor/verify-totp' ? 'app-confirmed' : 'recovery-code-used';
						} else {
							const path = mutationPathSchema.parse(pathname);
							const mutation = mutations[path];
							requireMutationPermission(actor, mutation.change);
							if (
								path === '/passkey/verify-registration' &&
								!registrationRequestSchema.safeParse(context.body).success
							)
								throw new APIError('BAD_REQUEST', {
									code: 'INVALID_REQUEST',
									message: 'invalid-passkey-registration',
								});
							if (
								path === '/two-factor/enable' &&
								body.success &&
								body.data.method !== undefined &&
								body.data.method !== 'totp'
							)
								throw new APIError('BAD_REQUEST', { code: 'NOT_OFFERED', message: 'app-required' });
							if (path === '/passkey/remove' || path === '/passkey/update-passkey') {
								const parsed = z.object({ id: uuid7Schema }).safeParse(context.body);
								if (!parsed.success)
									throw new APIError('BAD_REQUEST', {
										code: 'INVALID_REQUEST',
										message: 'invalid-passkey-id',
									});
								targetId = parsed.data.id;
							}
							action = mutation.action;
						}
						const change: FactorChangeRecord = {
							requestId: props.platform.ids.nextId(),
							actorPersonId: actor.personId,
							action,
							targetId,
						};
						requireStoredValue(await props.store.factorChanges.record(change, 'intent'));
						pending = { kind: 'recorded', change, actor };
					}),
				},
			],
			after: [
				{
					matcher: (context) =>
						confirmationPaths.has(context.path ?? '') ||
						mutationPathSchema.safeParse(context.path).success,
					handler: createAuthMiddleware(async (context): Promise<unknown> => {
						if (
							pending.kind !== 'recorded' ||
							context.context.returned === undefined ||
							isAPIError(context.context.returned)
						)
							return;
						if (context.context.returned instanceof Response && !context.context.returned.ok)
							return;
						const pathname = context.path ?? '';
						if (confirmationPaths.has(pathname)) {
							const result = z
								.looseObject({ token: z.string().min(1), user: z.looseObject({ id: uuid7Schema }) })
								.safeParse(context.context.returned);
							if (!result.success || result.data.user.id !== pending.actor.personId)
								throw new APIError('SERVICE_UNAVAILABLE', {
									message: 'second-factor-result-unconfirmed',
								});
							// Native first app enrollment (and re-enrollment) rotates the session.
							// Its JSON token can still name the deleted old one; the browser's new
							// cookie follows newSession, so that actual session must receive the stamp.
							const current = context.context.newSession ?? context.context.session;
							if (
								current === null ||
								current === undefined ||
								current.user.id !== pending.actor.personId
							)
								throw new APIError('UNAUTHORIZED', { message: 'session-not-live' });
							const stamped = requireStoredValue(
								await props.store.factors.stampSession({
									personId: pending.actor.personId,
									sessionId: uuid7Schema.parse(current.session.id),
									method: pathname === '/two-factor/verify-totp' ? 'app' : 'recoveryCode',
								}),
							);
							if (stamped.kind !== 'stamped')
								throw new APIError('UNAUTHORIZED', { message: 'session-not-live' });
							requireStoredValue(await props.store.factorChanges.record(pending.change, 'outcome'));
							const { token: _sessionToken, ...publicBody } = result.data;
							return context.json(publicBody);
						}
						requireStoredValue(await props.store.factorChanges.record(pending.change, 'outcome'));
					}),
				},
			],
		},
		endpoints: {
			removePasskeySafely: createAuthEndpoint(
				'/passkey/remove',
				{ method: 'POST', body: z.strictObject({ id: uuid7Schema }) },
				async (context) => {
					const actor = await requireFactorActor({ context, store: props.store.factors });
					requireMutationPermission(actor, 'remove-passkey');
					const result = requireStoredValue(
						await props.store.factors.removePasskey({
							personId: actor.personId,
							passkeyId: context.body.id,
						}),
					);
					if (result.kind !== 'removed')
						throw new APIError('FORBIDDEN', {
							code: 'ANOTHER_FACTOR_REQUIRED',
							message: 'anotherFactorRequired',
						});
					return context.json({ status: true });
				},
			),
			removeAuthenticatorApp: createAuthEndpoint(
				'/two-factor/remove-app',
				{ method: 'POST', body: z.strictObject({}) },
				async (context) => {
					const actor = await requireFactorActor({ context, store: props.store.factors });
					requireMutationPermission(actor, 'remove-app');
					const result = requireStoredValue(
						await props.store.factors.removeAuthenticatorApp(actor.personId),
					);
					if (result.kind !== 'removed')
						throw new APIError('FORBIDDEN', {
							code: 'ANOTHER_FACTOR_REQUIRED',
							message: 'anotherFactorRequired',
						});
					return context.json({ status: true });
				},
			),
		},
	};
}
