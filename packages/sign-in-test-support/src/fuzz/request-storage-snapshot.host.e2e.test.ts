import { signInSchema, type SignInDatabase } from '@agent-collaboration/sign-in-core';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { expect, it } from 'vitest';

import {
	readRequestStorageRowCounts,
	readRequestStorageSnapshot,
	readRequestStorageSnapshotPerTable,
	rowBytes,
	wipeRequestStorage,
} from '#sign-in-test-support/fuzz/request-storage-snapshot';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';

type SeedRow = Record<string, unknown>;

/** A value of the column's own type; an enum column takes its first member. */
function valueFor(column: SQLiteColumn): unknown {
	const seeds: Readonly<Record<string, () => unknown>> = {
		string: () => column.enumValues?.[0] ?? `${column.name}-seed`,
		number: () => 1,
		boolean: () => true,
		date: () => new Date(1_000),
		json: () => ({ seed: true }),
	};
	const seed = seeds[column.dataType];
	if (seed === undefined)
		throw new Error(`Seed has no value for ${column.name} (${column.dataType})`);
	return seed();
}

/** Tables ordered so every foreign key points at a table already seeded. */
function dependencyOrder(): readonly SQLiteTable[] {
	const remaining = new Set<SQLiteTable>(Object.values(signInSchema));
	const ordered: SQLiteTable[] = [];
	while (remaining.size > 0) {
		const ready = [...remaining].find((table) =>
			getTableConfig(table).foreignKeys.every((key) => {
				const target = key.reference().foreignTable;
				return target === table || !remaining.has(target);
			}),
		);
		if (ready === undefined) throw new Error('Schema foreign keys are cyclic');
		remaining.delete(ready);
		ordered.push(ready);
	}
	return ordered;
}

/** One row in every table, foreign keys pointing at the rows seeded before. */
async function seedEveryTable(database: SignInDatabase): Promise<void> {
	const seeded = new Map<SQLiteTable, SeedRow>();
	for (const table of dependencyOrder()) {
		const row: SeedRow = {};
		for (const [key, column] of Object.entries(getTableColumns(table))) row[key] = valueFor(column);
		for (const foreignKey of getTableConfig(table).foreignKeys) {
			const { columns, foreignColumns, foreignTable } = foreignKey.reference();
			const target = seeded.get(foreignTable);
			if (target === undefined) continue;
			columns.forEach((column, index) => {
				const foreignName = foreignColumns[index]?.name;
				const targetEntry = Object.entries(getTableColumns(foreignTable)).find(
					([, candidate]) => candidate.name === foreignName,
				);
				const ownEntry = Object.entries(getTableColumns(table)).find(
					([, candidate]) => candidate.name === column.name,
				);
				if (targetEntry !== undefined && ownEntry !== undefined)
					row[ownEntry[0]] = target[targetEntry[0]];
			});
		}
		await database.insert(table).values(row);
		seeded.set(table, row);
	}
}

for (const host of ['node', 'cloudflare'] as const) {
	it(`S2 storage snapshot on ${host}: the one-statement reads equal the per-table reads, and the wipe empties every table`, async (): Promise<void> => {
		const harness = await startLocalAuthHarness({ host, turnstileSecret: 'published-test' });
		try {
			const database = harness.database;
			const tableNames = Object.keys(signInSchema);
			expect(tableNames).toHaveLength(21);
			// The one-statement form carries no blob column; a future one needs an explicit hex().
			expect(
				Object.values(signInSchema).flatMap((table) =>
					Object.values(getTableColumns(table))
						.filter((column) => column.columnType.includes('Blob'))
						.map((column) => `${getTableConfig(table).name}.${column.name}`),
				),
			).toEqual([]);

			await seedEveryTable(database);

			const perTable = await readRequestStorageSnapshotPerTable(database);
			const oneStatement = await readRequestStorageSnapshot(database);
			// Same tables, rows, projection, sort order and bytes.
			expect(Object.keys(oneStatement)).toEqual(Object.keys(perTable));
			for (const name of tableNames) {
				expect(perTable[name]?.length, `${name} has a seeded row`).toBeGreaterThan(0);
				expect(oneStatement[name]?.map(rowBytes), name).toEqual(perTable[name]?.map(rowBytes));
			}
			expect(oneStatement).toStrictEqual(perTable);

			// The count names every table.
			const counts = await readRequestStorageRowCounts(database);
			expect(Object.keys(counts)).toEqual(tableNames);
			for (const name of tableNames)
				expect(counts[name], `${name} count`).toBe(perTable[name]?.length);

			// The wipe leaves nothing, by both readers.
			await wipeRequestStorage(database);
			expect(Object.values(await readRequestStorageRowCounts(database))).toEqual(
				tableNames.map(() => 0),
			);
			expect(Object.values(await readRequestStorageSnapshot(database)).flat()).toEqual([]);
			expect(Object.values(await readRequestStorageSnapshotPerTable(database)).flat()).toEqual([]);
		} finally {
			await harness.close();
		}
	});
}
