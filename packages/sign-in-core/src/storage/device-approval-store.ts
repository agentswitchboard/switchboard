import { and, eq, gt, isNull, type SQL } from 'drizzle-orm';

import {
	deviceApprovalClaimSchema,
	transitionDeviceApproval,
	type DeviceApprovalAction,
	type DeviceApprovalOutcome,
	type DeviceApprovalState,
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

function readDecisionState(
	row:
		| {
				readonly status: string;
				readonly claim: string | null;
				readonly enrollmentId: string | null;
		  }
		| undefined,
): DeviceApprovalState {
	if (row === undefined) return { kind: 'closed' };
	switch (row.status) {
		case 'pending':
			return row.claim === null
				? { kind: 'unclaimed' }
				: deviceApprovalClaimSchema.parse(JSON.parse(row.claim));
		case 'approved':
			return { kind: 'approved', enrollmentId: row.enrollmentId };
		case 'denied':
			return { kind: 'denied' };
		default:
			return { kind: 'closed' };
	}
}

function decisionWrite(state: DeviceApprovalState): Partial<typeof deviceCode.$inferInsert> {
	switch (state.kind) {
		case 'unclaimed':
			return { decisionClaim: null };
		case 'claimed':
			return { decisionClaim: JSON.stringify(state) };
		case 'approved':
			return { status: 'approved', enrollmentId: state.enrollmentId, decisionClaim: null };
		case 'denied':
			return { status: 'denied' };
		case 'closed':
			throw new Error('A closed device code cannot be written');
		default:
			return state satisfies never;
	}
}

export async function applyDeviceApprovalAction(
	props: ScopedDeviceDecision,
	action: DeviceApprovalAction,
): Promise<DeviceApprovalOutcome> {
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
		const state = readDecisionState(row);
		const transition = transitionDeviceApproval(state, action);
		if (row === undefined || transition.next === state) return transition.outcome;
		const [changed] = await database
			.update(deviceCode)
			.set(decisionWrite(transition.next))
			.where(and(liveCode(props), eq(deviceCode.status, row.status), sameClaim(row.claim)))
			.returning({ id: deviceCode.id });
		if (changed !== undefined) return transition.outcome;
	}
}
