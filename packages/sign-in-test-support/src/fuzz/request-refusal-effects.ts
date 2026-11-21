import { z } from 'zod';

import type { RequestCaseFixture } from '#sign-in-test-support/fuzz/request-case-fixture';
import type { GeneratedRequest } from '#sign-in-test-support/fuzz/request-families/index';
import type { RequestFamilyContext } from '#sign-in-test-support/fuzz/request-families/index';
import {
	rowBytes,
	rowsAdded,
	type RequestStorageSnapshot,
	type StoredRow,
} from '#sign-in-test-support/fuzz/request-storage-snapshot';
import type { RouteClassification } from '#sign-in-test-support/fuzz/route-classification';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';

const factorActions: Readonly<Record<string, string>> = {
	'/api/auth/two-factor/enable': 'app-enrollment-started',
	'/api/auth/two-factor/verify-totp': 'app-confirmed',
	'/api/auth/two-factor/verify-backup-code': 'recovery-code-used',
	'/api/auth/two-factor/generate-backup-codes': 'recovery-codes-rotated',
	'/api/auth/two-factor/remove-app': 'app-removed',
	'/api/auth/passkey/verify-registration': 'passkey-added',
	'/api/auth/passkey/update-passkey': 'passkey-renamed',
	'/api/auth/passkey/remove': 'passkey-removed',
	'/api/auth/passkey/confirm': 'passkey-confirmed',
};

function withoutFields(row: StoredRow, fields: readonly string[]): string {
	return rowBytes(Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key))));
}

/** A permission describes one row transition, never a whole table that may change freely. */
export function assertRequestRefusalEffects(props: {
	readonly classification: RouteClassification;
	readonly fixture: Pick<RequestCaseFixture, 'sessionId'> & {
		readonly context: Pick<RequestFamilyContext, 'personId' | 'passkeyId' | 'challengeId'>;
		readonly permittedVerificationIds?: readonly string[];
	};
	readonly before: RequestStorageSnapshot;
	readonly after: RequestStorageSnapshot;
	readonly request?: GeneratedRequest;
	readonly now?: number;
}): void {
	const { classification, fixture, before, after } = props;
	const now = props.now ?? controlledSignInClock.now();
	const expired = (before.session ?? []).find(
		(row) =>
			row.id === fixture.sessionId && typeof row.expiresAt === 'number' && row.expiresAt <= now,
	);
	for (const table of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const original = before[table] ?? [];
		const current = after[table] ?? [];
		const additions = rowsAdded({ before: original, after: current });
		const removals = rowsAdded({ before: current, after: original });
		if (additions.length === 0 && removals.length === 0) continue;
		const permissions = classification.permittedRefusalEffects;
		if (
			table === 'session' &&
			permissions.includes('clear-current-choice') &&
			additions.length === 1 &&
			removals.length === 1
		) {
			const old = removals[0];
			const next = additions[0];
			if (
				old !== undefined &&
				next !== undefined &&
				old.id === fixture.sessionId &&
				next.activeOrganizationId === null &&
				withoutFields(old, ['activeOrganizationId', 'updatedAt']) ===
					withoutFields(next, ['activeOrganizationId', 'updatedAt']) &&
				next.updatedAt === now
			)
				continue;
		}
		if (permissions.includes('expired-session-cleanup') && expired !== undefined) {
			if (
				table === 'session' &&
				additions.length === 0 &&
				removals.length === 1 &&
				removals[0]?.id === expired.id
			)
				continue;
			if (table === 'personOrganizationAuthorizationRevisions') {
				// The refused guard run advances each of the person's pairs once. Drain-on-use
				// (authorization-revision-drainer.ts:78) may then deliver and acknowledge the new
				// revision of a pair whose organization's central confirms it, in the same run.
				const advanced = (row: Record<string, unknown>): Record<string, unknown> =>
					Object.assign({}, row, {
						revision: Number(row.revision) + 1,
						next_attempt_at: now,
						updated_at: now,
					});
				const drained = (row: Record<string, unknown>): Record<string, unknown> =>
					Object.assign(advanced(row), {
						acknowledged_revision: Number(row.revision) + 1,
						acknowledged_at: now,
					});
				const matches =
					current.length === original.length &&
					original.every((row) => {
						const observed = current.find((candidate) => candidate.id === row.id);
						if (observed === undefined) return false;
						if (row.person_id !== expired.userId || typeof row.revision !== 'number')
							return rowBytes(observed) === rowBytes(row);
						return [advanced(row), drained(row)].some(
							(allowed) => rowBytes(allowed) === rowBytes(observed),
						);
					});
				if (matches) continue;
			}
		}
		if (table === 'verification' && additions.length === 0) {
			const allowed = removals.every(
				(row) =>
					(permissions.includes('consume-passkey-challenge') &&
						row.identifier ===
							`passkey-confirm:${fixture.sessionId}:${fixture.context.challengeId}`) ||
					((permissions.includes('oauth-code-consumption') ||
						permissions.includes('provider-verification-consumption')) &&
						fixture.permittedVerificationIds?.includes(String(row.id)) === true),
			);
			if (allowed) continue;
		}
		if (table === 'signInAudit' && removals.length === 0 && additions.length === 1) {
			const row = additions[0];
			if (
				permissions.includes('callback-outcome') &&
				row !== undefined &&
				row.kind === 'sign-in' &&
				row.actor_user_id === 'anonymous' &&
				row.phase === 'outcome' &&
				row.change_kind === 'failed' &&
				row.target_id === classification.path.split('/').at(-1) &&
				row.at === now
			)
				continue;
			if (
				permissions.includes('people-change-intent') &&
				row !== undefined &&
				props.request !== undefined
			) {
				let body: Readonly<Record<string, unknown>> = {};
				try {
					body = z
						.record(z.string(), z.unknown())
						.parse(
							JSON.parse(
								typeof props.request.init.body === 'string' ? props.request.init.body : '{}',
							),
						);
				} catch {
					/* malformed input has no permitted native intent */
				}
				const path = classification.path;
				const invitation = (before.invitation ?? []).find(
					(candidate) => candidate.id === body.invitationId,
				);
				const person = (before.user ?? []).find(
					(candidate) => candidate.email === body.memberIdOrEmail,
				);
				const change = path.endsWith('/invite-member')
					? 'invited'
					: path.endsWith('/cancel-invitation')
						? 'invitation-cancelled'
						: path.endsWith('/accept-invitation')
							? 'invitation-accepted'
							: 'member-removed';
				const target =
					change === 'invited'
						? body.email
						: change === 'member-removed'
							? person?.id
							: invitation?.id;
				const organization =
					change === 'invitation-cancelled' || change === 'invitation-accepted'
						? invitation?.organizationId
						: body.organizationId;
				if (
					target !== undefined &&
					organization !== undefined &&
					row.kind === 'organization-people-changed' &&
					row.actor_user_id === fixture.context.personId &&
					row.phase === 'intent' &&
					row.change_kind === change &&
					row.target_id === target &&
					row.organization_id === organization
				)
					continue;
			}
			const action = factorActions[classification.path];
			const target = [
				'/api/auth/passkey/confirm',
				'/api/auth/passkey/update-passkey',
				'/api/auth/passkey/remove',
			].includes(classification.path)
				? fixture.context.passkeyId
				: fixture.context.personId;
			if (
				permissions.includes('factor-intent') &&
				row !== undefined &&
				row.kind === 'second-factor-changed' &&
				row.actor_user_id === fixture.context.personId &&
				row.phase === 'intent' &&
				row.change_kind === action &&
				row.target_id === target
			)
				continue;
		}
		if (
			table === 'twoFactor' &&
			additions.length === 1 &&
			removals.length === 1 &&
			classification.path === '/api/auth/two-factor/verify-totp' &&
			permissions.includes('factor-intent')
		) {
			const old = removals[0];
			const next = additions[0];
			if (
				old !== undefined &&
				next !== undefined &&
				old.userId === fixture.context.personId &&
				typeof old.failedVerificationCount === 'number' &&
				next.failedVerificationCount === old.failedVerificationCount + 1 &&
				withoutFields(old, ['failedVerificationCount', 'lockedUntil']) ===
					withoutFields(next, ['failedVerificationCount', 'lockedUntil'])
			)
				continue;
		}
		throw new Error(`S2 refusal-effects: unauthorized transition in ${table}`);
	}
}
