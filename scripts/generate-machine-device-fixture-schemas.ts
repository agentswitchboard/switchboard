import { mkdir, writeFile } from 'node:fs/promises';

import { z } from 'zod';

import {
	machineDeviceFixtureDirectory,
	machineDeviceFixtureSchemas,
} from '../packages/sign-in-core/src/machine-login/machine-device-fixture-schemas.js';

const schemaDirectory = new URL('schemas/', machineDeviceFixtureDirectory);
await mkdir(schemaDirectory, { recursive: true });
await Promise.all(
	machineDeviceFixtureSchemas.map(({ name, schema }) =>
		writeFile(
			new URL(`${name}.schema.json`, schemaDirectory),
			`${JSON.stringify(z.toJSONSchema(schema, { target: 'draft-2020-12' }), null, '\t')}\n`,
		),
	),
);
