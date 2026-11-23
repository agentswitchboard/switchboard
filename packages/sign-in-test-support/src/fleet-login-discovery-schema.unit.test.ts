import { readFile } from 'node:fs/promises';

import addFormats from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { expect, it } from 'vitest';
import { z } from 'zod';

const fixtures = new URL(
	'../../sign-in-core/contract-fixtures/machine-device-login/',
	import.meta.url,
);

it('rejects invalid link templates through the published discovery JSON Schema', async (): Promise<void> => {
	const schema = z
		.record(z.string(), z.unknown())
		.parse(JSON.parse(await readFile(new URL('schemas/discovery.schema.json', fixtures), 'utf8')));
	const validator = new Ajv2020();
	addFormats(validator);
	const validate = validator.compile(schema);
	const client_id = '019a3dce-2000-7000-8000-0000000000a1';
	const link_url = 'https://sign-in.example.invalid/api/fleet/link/{organization_id}';
	expect(validate({ client_id, link_url })).toBe(true);
	for (const invalid of [
		link_url.replace('https:', 'http:'),
		link_url.replace('/{organization_id}', '/missing'),
		`${link_url}/{organization_id}`,
		link_url.replace('/{organization_id}', '?org={organization_id}'),
	])
		expect(validate({ client_id, link_url: invalid }), invalid).toBe(false);
});
