import { and, eq, gt, isNull, type SQL } from 'drizzle-orm';

import type { Uuid7 } from '#sign-in-core/contracts/sign-in-platform';
import {
	deviceApprovalClaimSchema,
	settleDeviceApprovalClaim,
	type DeviceApprovalCompletion,
} from '#sign-in-core/machine-login/device-approval-claim';
import type { SignInDatabaseFactory } from '#sign-in-core/storage/models/sign-in-database';
import { deviceCode } from '#sign-in-core/storage/sign-in-schema';

interface ScopedDeviceDecision {
	readonly openDatabase: SignInDatabaseFactory;
	readonly id: string;
	readonly approver: string;
	readonly now: () => number;
}

function liveCode(props: ScopedDeviceDecision): SQL | undefined {
	return and(
		eq(deviceCode.id, props.id),
		eq(deviceCode.userId, props.approver),
		gt(deviceCode.expiresAt, new Date(props.now())),
	);
}

function sameClaim(raw: string | null): SQL {
	return raw === null ? isNull(deviceCode.decisionClaim) : eq(deviceCode.decisionClaim, raw);
}

export type DeviceApprovalAttempt =
	| { readonly kind: 'claimed'; readonly attempt: Uuid7 }
	| { readonly kind: 'approved'; readonly enrollmentId: string | null }
	| { readonly kind: 'already-decided' };

export async function claimDeviceApprovalAttempt(
	props: ScopedDeviceDecision & { readonly attempt: Uuid7 },
): Promise<DeviceApprovalAttempt> {
	const database = props.openDatabase();
	for (;;) {
		const [row] = await database
			.select({
				status: deviceCode.status,
				claim: deviceCode.decisionClaim,
				enrollmentId: deviceCode.enrollmentId,
			})
			.from(deviceCode)
			.where(liveCode(props))
			.limit(1);
		if (row?.status === 'approved') return { kind: 'approved', enrollmentId: row.enrollmentId };
		if (row?.status !== 'pending') return { kind: 'already-decided' };
		const previous =
			row.claim === null
				? { attempts: [], mayHaveCommitted: false }
				: deviceApprovalClaimSchema.parse(JSON.parse(row.claim));
		const claim = JSON.stringify({ ...previous, attempts: [...previous.attempts, props.attempt] });
		const [changed] = await database
			.update(deviceCode)
			.set({ decisionClaim: claim })
			.where(and(liveCode(props), eq(deviceCode.status, 'pending'), sameClaim(row.claim)))
			.returning({ id: deviceCode.id });
		if (changed !== undefined) return { kind: 'claimed', attempt: props.attempt };
	}
}

export async function completeDeviceApprovalAttempt(
	props: ScopedDeviceDecision & {
		readonly attempt: Uuid7;
		readonly completion: DeviceApprovalCompletion;
	},
): Promise<boolean> {
	const database = props.openDatabase();
	for (;;) {
		const [row] = await database
			.select({
				status: deviceCode.status,
				claim: deviceCode.decisionClaim,
				enrollmentId: deviceCode.enrollmentId,
			})
			.from(deviceCode)
			.where(liveCode(props))
			.limit(1);
		if (row?.status === 'approved')
			return (
				props.completion.kind === 'answered' &&
				props.completion.decision.result === 'approved' &&
				props.completion.decision.enrollmentId === row.enrollmentId
			);
		if (row?.status !== 'pending' || row.claim === null) return false;
		const transition = settleDeviceApprovalClaim({
			claim: deviceApprovalClaimSchema.parse(JSON.parse(row.claim)),
			attempt: props.attempt,
			completion: props.completion,
		});
		if (transition.kind === 'unchanged') return false;
		const change =
			transition.kind === 'approve'
				? { status: 'approved', enrollmentId: transition.enrollmentId, decisionClaim: null }
				: { decisionClaim: transition.kind === 'retain' ? JSON.stringify(transition.claim) : null };
		const [changed] = await database
			.update(deviceCode)
			.set(change)
			.where(and(liveCode(props), eq(deviceCode.status, 'pending'), sameClaim(row.claim)))
			.returning({ id: deviceCode.id });
		if (changed !== undefined) return true;
	}
}

export async function recordDeviceDenial(
	props: ScopedDeviceDecision,
): Promise<'denied' | 'already-deciding' | 'already-decided'> {
	const database = props.openDatabase();
	const [changed] = await database
		.update(deviceCode)
		.set({ status: 'denied' })
		.where(and(liveCode(props), eq(deviceCode.status, 'pending'), isNull(deviceCode.decisionClaim)))
		.returning({ id: deviceCode.id });
	if (changed !== undefined) return 'denied';
	const [current] = await database
		.select({ status: deviceCode.status, claim: deviceCode.decisionClaim })
		.from(deviceCode)
		.where(liveCode(props))
		.limit(1);
	return current?.status === 'pending' && current.claim !== null
		? 'already-deciding'
		: 'already-decided';
}
