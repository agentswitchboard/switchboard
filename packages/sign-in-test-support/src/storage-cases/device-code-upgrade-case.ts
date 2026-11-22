import { deviceCode } from '@agent-collaboration/sign-in-core';
import { eq } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';

const oldDeviceCode = sqliteTable('deviceCode', {
	id: text('id').primaryKey(),
	deviceCode: text('deviceCode').notNull(),
	userCode: text('userCode').notNull(),
	userId: text('userId'),
	expiresAt: integer('expiresAt', { mode: 'timestamp_ms' }).notNull(),
	status: text('status').notNull(),
	lastPolledAt: integer('lastPolledAt', { mode: 'timestamp_ms' }),
	pollingInterval: integer('pollingInterval'),
	clientId: text('clientId'),
	scope: text('scope'),
	resources: text('resources'),
	oauthClientId: text('oauthClientId'),
	machineInstallationId: text('machineInstallationId').notNull(),
	machinePeerId: text('machinePeerId').notNull(),
	machineLabel: text('machineLabel').notNull(),
	organizationId: text('organizationId').notNull(),
	enrollmentId: text('enrollmentId'),
});

export const expectedDeviceCodeAfterUpgrade = {
	id: '019a3dce-2000-7000-8000-000000000081',
	deviceCode: 'fixture-polling-code',
	userCode: 'FIXTURECODE',
	userId: '019a3dce-2000-7000-8000-000000000082',
	expiresAt: 1_800_000_600_000,
	status: 'approved',
	lastPolledAt: 1_800_000_000_000,
	pollingInterval: 5_000,
	clientId: '019a3dce-2000-7000-8000-000000000083',
	scope: 'offline_access',
	resources: '["https://central.example.invalid/machine"]',
	oauthClientId: '019a3dce-2000-7000-8000-000000000084',
	machineId: '019a3dce-2000-7000-8000-000000000085',
	machineLabel: 'Proof Mac',
	organizationId: '019a3dce-2000-7000-8000-000000000086',
	enrollmentId: '019a3dce-2000-7000-8000-000000000087',
	decisionClaim: null,
};

export async function seedDeviceCode0004(
	context: StorageCaseContext,
): Promise<{ readonly seeded: true }> {
	const {
		machineId,
		decisionClaim: _newColumn,
		expiresAt,
		lastPolledAt,
		...retained
	} = expectedDeviceCodeAfterUpgrade;
	await context
		.openDatabase()
		.insert(oldDeviceCode)
		.values({
			...retained,
			expiresAt: new Date(expiresAt),
			lastPolledAt: new Date(lastPolledAt),
			machineInstallationId: machineId,
			machinePeerId: '019a3dce-2000-7000-8000-000000000088',
		});
	return { seeded: true };
}

export async function readDeviceCode0005(context: StorageCaseContext): Promise<
	Omit<typeof deviceCode.$inferSelect, 'expiresAt' | 'lastPolledAt'> & {
		readonly expiresAt: number;
		readonly lastPolledAt: number | null;
	}
> {
	const [row] = await context
		.openDatabase()
		.select()
		.from(deviceCode)
		.where(eq(deviceCode.id, expectedDeviceCodeAfterUpgrade.id));
	if (row === undefined) throw new Error('The migration dropped the populated device code');
	return {
		...row,
		expiresAt: row.expiresAt.getTime(),
		lastPolledAt: row.lastPolledAt?.getTime() ?? null,
	};
}
