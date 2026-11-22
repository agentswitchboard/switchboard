import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const generatedDirectories = new Set(['dist', 'node_modules', '__generated__', 'tmp']);

function findProviderZodImporters(directory = ''): string[] {
	return readdirSync(join(repositoryRoot, directory), { withFileTypes: true }).flatMap(
		(entry): string[] => {
			if (entry.name.startsWith('.')) return [];
			const path = join(directory, entry.name);
			if (entry.isDirectory())
				return generatedDirectories.has(entry.name) ? [] : findProviderZodImporters(path);
			if (!entry.isFile() || !/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(entry.name)) return [];
			const sourceText = readFileSync(join(repositoryRoot, path), 'utf8');
			const imports = ts.preProcessFile(sourceText, true, true).importedFiles;
			return imports.some(({ fileName }) => fileName.split('/')[0] === 'provider-zod')
				? [path]
				: [];
		},
	);
}

it('only the Better Auth device field declarations import provider-zod', (): void => {
	expect(findProviderZodImporters()).toEqual([
		join('packages', 'sign-in-core', 'src', 'better-auth', 'provider-machine-extension-fields.ts'),
	]);
});
