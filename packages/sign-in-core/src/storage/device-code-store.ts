import { and, asc, eq, gt } from 'drizzle-orm';

import type { SignInDatabaseFactory } from '#sign-in-core/storage/models/sign-in-database';
import { deviceCode } from '#sign-in-core/storage/sign-in-schema';

/** What the `/device` page may read about a code it shows. A read only: every
 * decision still goes through the native verify and the guarded endpoints. */
export type DeviceCodeForPage = Pick<
	typeof deviceCode.$inferSelect,
	'status' | 'userId' | 'expiresAt' | 'clientId' | 'machineLabel' | 'organizationId'
>;

export async function listPendingDeviceCodesForApprover(props: {
	readonly openDatabase: SignInDatabaseFactory;
	readonly organizationId: string;
	readonly approver: string;
	readonly routerClientId: string;
	readonly now: number;
}): Promise<readonly Pick<typeof deviceCode.$inferSelect, 'userCode' | 'machineLabel'>[]> {
	// The user's verification code has already been confirmed by the same person.
	// No unclaimed requests or polling credentials are included in this read.
	return props
		.openDatabase()
		.select({ userCode: deviceCode.userCode, machineLabel: deviceCode.machineLabel })
		.from(deviceCode)
		.where(
			and(
				eq(deviceCode.organizationId, props.organizationId),
				eq(deviceCode.userId, props.approver),
				eq(deviceCode.clientId, props.routerClientId),
				eq(deviceCode.status, 'pending'),
				gt(deviceCode.expiresAt, new Date(props.now)),
			),
		)
		.orderBy(asc(deviceCode.expiresAt), asc(deviceCode.id));
}

export async function readDeviceCodeForDecision(props: {
	readonly openDatabase: SignInDatabaseFactory;
	readonly userCode: string;
}): Promise<typeof deviceCode.$inferSelect | null> {
	const [stored] = await props
		.openDatabase()
		.select()
		.from(deviceCode)
		.where(eq(deviceCode.userCode, props.userCode))
		.limit(1);
	return stored ?? null;
}

export async function recordDeviceCodeDecision(props: {
	readonly openDatabase: SignInDatabaseFactory;
	readonly id: string;
	readonly approver: string;
	readonly now: number;
	readonly decision:
		| { readonly kind: 'approve'; readonly enrollmentId: string }
		| { readonly kind: 'deny' };
}): Promise<boolean> {
	const database = props.openDatabase();
	const unexpiredApproverCode = and(
		eq(deviceCode.id, props.id),
		eq(deviceCode.userId, props.approver),
		gt(deviceCode.expiresAt, new Date(props.now)),
	);
	const update =
		props.decision.kind === 'approve'
			? { status: 'approved', enrollmentId: props.decision.enrollmentId }
			: { status: 'denied' };
	const [changed] = await database
		.update(deviceCode)
		.set(update)
		.where(and(unexpiredApproverCode, eq(deviceCode.status, 'pending')))
		.returning({ id: deviceCode.id });
	if (changed !== undefined) return true;
	if (props.decision.kind === 'deny') return false;
	const [confirmed] = await database
		.select({ id: deviceCode.id })
		.from(deviceCode)
		.where(
			and(
				unexpiredApproverCode,
				eq(deviceCode.status, 'approved'),
				eq(deviceCode.enrollmentId, props.decision.enrollmentId),
			),
		)
		.limit(1);
	return confirmed !== undefined;
}

export async function readDeviceCodeForPage(props: {
	readonly openDatabase: SignInDatabaseFactory;
	/** The stored form: uppercase, no hyphen or spaces. */
	readonly userCode: string;
}): Promise<DeviceCodeForPage | null> {
	const row = (
		await props
			.openDatabase()
			.select({
				status: deviceCode.status,
				userId: deviceCode.userId,
				expiresAt: deviceCode.expiresAt,
				clientId: deviceCode.clientId,
				machineLabel: deviceCode.machineLabel,
				organizationId: deviceCode.organizationId,
			})
			.from(deviceCode)
			.where(eq(deviceCode.userCode, props.userCode))
			.limit(1)
	)[0];
	return row ?? null;
}
