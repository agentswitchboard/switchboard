import { expect, it } from 'vitest';

import { createStorageTestHost } from '#sign-in-test-support/storage-cases/dual-storage-test-host';
import {
	schemaReadbackSchema,
	type SchemaReadback,
} from '#sign-in-test-support/storage-cases/schema-readback';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	expectedServiceTables,
	organizationColumnExpectations,
	retiredAdmissionTables,
} from '#sign-in-test-support/test-fixtures/organization-schema-expectations';

useControlledSignInClock();
const serviceNames = new Set<string>(expectedServiceTables);
function requireTable(snapshot: SchemaReadback, name: string): SchemaReadback['tables'][number] {
	const table = snapshot.tables.find((candidate) => candidate.name === name);
	if (table === undefined) throw new Error('Migrated table is absent: ' + name);
	return table;
}
function assertApprovedOrganizationSchema(snapshot: SchemaReadback): void {
	expect(
		snapshot.tables.filter((table) => serviceNames.has(table.name)).map((table) => table.name),
	).toEqual([...expectedServiceTables]);
	for (const [name, columns] of Object.entries(organizationColumnExpectations)) {
		const table = requireTable(snapshot, name);
		expect(
			table.columns.map((column) => [
				column.name,
				column.type.toUpperCase(),
				column.notNull,
				column.primaryKey,
			]),
		).toEqual(columns);
		for (const column of table.columns) {
			const expectedDefault =
				name === 'twoFactor' && column.name === 'verified'
					? 'true'
					: name === 'twoFactor' && column.name === 'failedVerificationCount'
						? '0'
						: name === 'organization' && column.name === 'fleetState'
							? "'settingUp'"
							: name === 'member' && column.name === 'role'
								? "'member'"
								: name === 'invitation' && column.name === 'status'
									? "'pending'"
									: column.name === 'acknowledged_revision' ||
										  column.name === 'fleetStampUnansweredTries' ||
										  column.name === 'fleetStampRefusedTries'
										? '0'
										: null;
			expect(column.defaultValue).toBe(expectedDefault);
		}
	}
	for (const retired of retiredAdmissionTables)
		expect(snapshot.tables.some((table) => table.name === retired)).toBe(false);
	for (const [name, columns] of [
		['member', ['organizationId', 'userId']],
		['twoFactor', ['userId']],
		['invitation', ['organizationId', 'inviterId']],
	] as const) {
		expect(
			requireTable(snapshot, name)
				.foreignKeys.map(({ table, from, to, onDelete, onUpdate }) => ({
					table,
					from,
					to,
					onDelete,
					onUpdate,
				}))
				.toSorted((left, right) => left.from.localeCompare(right.from)),
		).toEqual(
			columns
				.map((from) => ({
					table: from === 'organizationId' ? 'organization' : 'user',
					from,
					to: 'id',
					onDelete: 'CASCADE',
					onUpdate: 'NO ACTION',
				}))
				.toSorted((left, right) => left.from.localeCompare(right.from)),
		);
	}
	expect(requireTable(snapshot, 'sign_in_audit').foreignKeys).toEqual([]);
	for (const [table, name, column] of [
		['member', 'member_userId_idx', 'userId'],
		['twoFactor', 'twoFactor_userId_idx', 'userId'],
		['twoFactor', 'twoFactor_secret_idx', 'secret'],
		['member', 'member_organizationId_idx', 'organizationId'],
		['invitation', 'invitation_email_idx', 'email'],
		['invitation', 'invitation_organizationId_idx', 'organizationId'],
		['sign_in_audit', 'sign_in_audit_organization_id', 'organization_id'],
		['sign_in_audit', 'sign_in_audit_request_id', 'request_id'],
	]) {
		if (table === undefined || name === undefined || column === undefined)
			throw new Error('Invalid index fixture');
		expect(requireTable(snapshot, table).indexes.find((index) => index.name === name)).toEqual({
			name,
			unique: 0,
			origin: 'c',
			partial: 0,
			columns: [column],
		});
	}
	const device = requireTable(snapshot, 'deviceCode');
	expect(device.columns.map((column) => column.name)).toEqual([
		'id',
		'deviceCode',
		'userCode',
		'userId',
		'expiresAt',
		'status',
		'lastPolledAt',
		'pollingInterval',
		'clientId',
		'scope',
		'resources',
		'oauthClientId',
		'machineId',
		'machineLabel',
		'organizationId',
		'enrollmentId',
		'decisionClaim',
	]);
	expect(device.foreignKeys).toEqual([]);
	for (const name of ['machineId', 'machineLabel', 'organizationId'])
		expect(device.columns.find((column) => column.name === name)?.notNull).toBe(1);
	for (const name of ['enrollmentId', 'userId', 'decisionClaim'])
		expect(device.columns.find((column) => column.name === name)?.notNull).toBe(0);
	expect(requireTable(snapshot, 'session').columns.map((column) => column.name)).toEqual([
		'id',
		'expiresAt',
		'token',
		'createdAt',
		'updatedAt',
		'ipAddress',
		'userAgent',
		'userId',
		'activeOrganizationId',
		'secondFactorAt',
		'secondFactorMethod',
	]);
	expect(requireTable(snapshot, 'user').columns.map((column) => column.name)).toEqual([
		'id',
		'name',
		'email',
		'emailVerified',
		'image',
		'createdAt',
		'updatedAt',
		'twoFactorEnabled',
		'secondFactorSetAt',
	]);
	expect(
		requireTable(snapshot, 'user').columns.find((column) => column.name === 'twoFactorEnabled')
			?.defaultValue,
	).toBe('false');
	expect(requireTable(snapshot, 'twoFactor')).toBeDefined();
}

it('Wrangler D1 migrations and the Drizzle SQLite migrator install the same approved service schema', async () => {
	const snapshots = await Promise.all(
		(['d1-workerd', 'better-sqlite3'] as const).map(async (leg) => {
			const host = await createStorageTestHost(leg);
			try {
				const snapshot = schemaReadbackSchema.parse(
					await host.runCommand({
						kind: 'schema-readback',
						details: leg === 'd1-workerd' ? 'catalog' : 'metadata',
					}),
				);
				const metadataNames = snapshot.tables
					.filter((table) => !serviceNames.has(table.name))
					.map((table) => table.name);
				expect(metadataNames).toEqual(
					leg === 'd1-workerd'
						? ['_cf_METADATA', 'd1_migrations', 'sqlite_sequence']
						: ['__drizzle_migrations'],
				);
				expect(
					snapshot.tables
						.filter((table) => serviceNames.has(table.name))
						.map((table) => table.name),
				).toEqual([...expectedServiceTables]);
				if (leg === 'better-sqlite3') assertApprovedOrganizationSchema(snapshot);
				return snapshot.entries.filter((entry) => serviceNames.has(entry.table));
			} finally {
				await host.close();
			}
		}),
	);
	expect(snapshots[0]).toEqual(snapshots[1]);
});
