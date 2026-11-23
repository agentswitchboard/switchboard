import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

/** Copy the real migration prefix, without executing authored fixture DDL. */
export async function prepareBaselineMigrations(props: {
	readonly currentFolder: string;
	readonly runtimeDirectory: string;
	readonly through?: '0004_organization_stamp_record';
}): Promise<string> {
	const baselineFolder = path.join(props.runtimeDirectory, 'baseline-migrations');
	await mkdir(path.join(baselineFolder, 'meta'), { recursive: true });
	const journal = z
		.object({
			version: z.string(),
			dialect: z.string(),
			entries: z.array(
				z.object({
					idx: z.number(),
					version: z.string(),
					when: z.number(),
					tag: z.string(),
					breakpoints: z.boolean(),
				}),
			),
		})
		.parse(
			JSON.parse(await readFile(path.join(props.currentFolder, 'meta/_journal.json'), 'utf8')),
		);
	const baseline = journal.entries[0];
	if (baseline?.tag !== '0000_outstanding_nextwave')
		throw new Error('Main migration identity changed');
	const last =
		props.through === undefined ? 0 : journal.entries.findIndex(({ tag }) => tag === props.through);
	if (last < 0) throw new Error('Requested migration baseline is absent');
	const entries = journal.entries.slice(0, last + 1);
	await Promise.all(
		entries.map(({ tag }) =>
			copyFile(
				path.join(props.currentFolder, tag + '.sql'),
				path.join(baselineFolder, tag + '.sql'),
			),
		),
	);
	await writeFile(
		path.join(baselineFolder, 'meta/_journal.json'),
		JSON.stringify({ ...journal, entries }),
	);
	return baselineFolder;
}
