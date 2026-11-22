import { readFile } from 'node:fs/promises';

import { expect, it } from 'vitest';
import { z } from 'zod';

import { machineResourceUriSchema } from '#sign-in-core/machine-login/machine-resource-uri';

it('accepts and preserves exactly the D08 fixture bytes, rejecting every refused vector', async () => {
	const vectors = z
		.object({ accept: z.array(z.string()), refuse: z.array(z.string()) })
		.parse(
			JSON.parse(
				await readFile(
					new URL(
						'../../contract-fixtures/machine-login/resource-uri-vectors.json',
						import.meta.url,
					),
					'utf8',
				),
			),
		);
	for (const value of vectors.accept) expect(machineResourceUriSchema.parse(value)).toBe(value);
	for (const value of vectors.refuse)
		expect(machineResourceUriSchema.safeParse(value).success, value).toBe(false);
});
