import { createHash } from 'node:crypto';

import { signInSchema, type SignInDatabase } from '@agent-collaboration/sign-in-core';
import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

import { storedRowProjection } from '#sign-in-test-support/test-fixtures/stored-row-projection';

export type StoredRow = Readonly<Record<string, unknown>>;
export type RequestStorageSnapshot = Readonly<Record<string, readonly StoredRow[]>>;

const signInTables = Object.entries(signInSchema);

/** One sorted row list per table: the snapshot shape every assertion compares. */
function sortedRows(rows: readonly StoredRow[]): readonly StoredRow[] {
	return rows.toSorted((left, right) => rowBytes(left).localeCompare(rowBytes(right)));
}

/**
 * The reference reader: one `SELECT` per table. Each costs a round trip (about 10 ms on D1, which
 * runs statements one at a time), so cases use `readRequestStorageSnapshot`; this stays as the
 * definition its one-statement form must equal (request-storage-snapshot.host.e2e.test.ts).
 */
export async function readRequestStorageSnapshotPerTable(
	database: SignInDatabase,
): Promise<RequestStorageSnapshot> {
	const entries = await Promise.all(
		signInTables.map(async ([name, table]) => {
			const rows = z
				.array(z.record(z.string(), z.unknown()))
				.parse(await database.select(storedRowProjection(table)).from(table));
			return [name, sortedRows(rows)] as const;
		}),
	);
	return Object.fromEntries(entries);
}

/** A blob would need an explicit hex() projection; the schema has none, and this refuses one. */
function nonBlobColumns(table: SQLiteTable): SQLiteColumn[] {
	return Object.values(getTableColumns(table)).map((column) => {
		if (column.columnType.includes('Blob'))
			throw new Error(
				`Storage snapshot: blob column ${column.name} needs an explicit hex() projection`,
			);
		return column;
	});
}

/** The one result row of a statement whose columns are named by table: object or positional. */
async function readTableKeyedRow(
	database: SignInDatabase,
	statement: SQL,
): Promise<Readonly<Record<string, unknown>>> {
	const rows: unknown = await database.all(statement);
	const first = z.array(z.unknown()).parse(rows)[0];
	if (Array.isArray(first))
		return Object.fromEntries(signInTables.map(([name], index) => [name, first[index]]));
	return z.record(z.string(), z.unknown()).parse(first);
}

/**
 * Read every table, including credential and fence rows, in ONE statement: each table is a scalar
 * sub-select of `json_group_array(json_array(...columns))`, so a case pays one round trip instead of
 * 21 (about 11 ms instead of about 190 ms on D1). A single `UNION ALL` over the tables is refused by
 * D1 (too many compound terms), which is why the tables are columns of one row.
 */
export async function readRequestStorageSnapshot(
	database: SignInDatabase,
): Promise<RequestStorageSnapshot> {
	const statement = sql`select ${sql.join(
		signInTables.map(
			([name, table]) =>
				sql`(select json_group_array(json_array(${sql.join(nonBlobColumns(table), sql`, `)})) from ${table}) as ${sql.identifier(name)}`,
		),
		sql`, `,
	)}`;
	const row = await readTableKeyedRow(database, statement);
	return Object.fromEntries(
		signInTables.map(([name, table]) => {
			const columns = nonBlobColumns(table);
			const values = z.array(z.array(z.unknown())).parse(JSON.parse(z.string().parse(row[name])));
			return [
				name,
				sortedRows(
					values.map((value) =>
						Object.fromEntries(columns.map((column, index) => [column.name, value[index]])),
					),
				),
			] as const;
		}),
	);
}

/** Row count of every table in one statement; the empty-baseline assertion reads this. */
export async function readRequestStorageRowCounts(
	database: SignInDatabase,
): Promise<Readonly<Record<string, number>>> {
	const statement = sql`select ${sql.join(
		signInTables.map(
			([name, table]) => sql`(select count(*) from ${table}) as ${sql.identifier(name)}`,
		),
		sql`, `,
	)}`;
	const row = await readTableKeyedRow(database, statement);
	return Object.fromEntries(
		signInTables.map(([name]) => [name, z.number().int().nonnegative().parse(row[name])] as const),
	);
}

function hasExec(client: unknown): client is { exec: (statements: string) => unknown } {
	return sqlClientSchema.safeParse(client).success;
}

const sqlClientSchema = z.object({
	exec: z.custom<(statements: string) => unknown>((value) => typeof value === 'function'),
});

/**
 * Delete every row of every table, in the reverse of the schema's order. Where the driver exposes
 * `exec` (D1, better-sqlite3), one call runs all Drizzle-rendered `DELETE`s: about 5 ms instead of about 225 ms for
 * 21 statements; better-sqlite3 has it too. A driver without `exec` deletes table by table. Test
 * harness only: host code never runs `exec`
 * (openSignInDatabase forbids it), which is why this lives in test support.
 */
export async function wipeRequestStorage(database: SignInDatabase): Promise<void> {
	const tables = signInTables.toReversed().map(([, table]) => table);
	const client: unknown = Reflect.get(database, '$client');
	if (hasExec(client)) {
		// Called on the driver itself: a parsed copy would lose its `this`.
		// D1's exec is asynchronous (better-sqlite3's is not): wait, or the next read races it.
		await client.exec(tables.map((table) => database.delete(table).toSQL().sql).join('; '));
		return;
	}
	for (const table of tables) await database.delete(table);
}

export function rowBytes(row: StoredRow): string {
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(row).toSorted(([left], [right]) => left.localeCompare(right)),
		),
	);
}

/** Failures name only the changed table; assertions must never print stored credentials. */
export function snapshotDigest(snapshot: unknown): string {
	return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export function rowsAdded(props: {
	readonly before: readonly StoredRow[];
	readonly after: readonly StoredRow[];
}): readonly StoredRow[] {
	const before = new Set(props.before.map(rowBytes));
	return props.after.filter((row) => !before.has(rowBytes(row)));
}

export function storedCredentials(snapshot: RequestStorageSnapshot): readonly string[] {
	const columns = new Set([
		'token',
		'accessToken',
		'deviceCode',
		'refreshToken',
		'idToken',
		'clientSecret',
		'password',
		'privateKey',
		'secret',
		'backupCodes',
	]);
	return Object.values(snapshot).flatMap((rows) =>
		rows.flatMap((row) =>
			Object.entries(row).flatMap(([column, value]) =>
				columns.has(column) && typeof value === 'string' && value.length > 0 ? [value] : [],
			),
		),
	);
}
