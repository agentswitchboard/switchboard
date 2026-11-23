import { readFile, readdir } from 'node:fs/promises';

import { expect, it } from 'vitest';
import { z } from 'zod';

import {
	machineDeviceFixtureDirectory,
	machineDeviceFixtureSchemas,
} from '#sign-in-core/machine-login/machine-device-fixture-schemas';
import { machineDeviceRequestIsValid } from '#sign-in-core/machine-login/machine-device-requests';
import { projectMachineDeviceResponse } from '#sign-in-core/response-release/machine-device-response';

const headersSchema = z.record(z.string(), z.string());
const responseFixtureSchema = z.strictObject({
	status: z.number().int(),
	headers: headersSchema,
	body: z.record(z.string(), z.unknown()),
});
const requestFixtureSchema = z.strictObject({
	method: z.literal('POST'),
	path: z.string(),
	headers: z.strictObject({ 'content-type': z.literal('application/x-www-form-urlencoded') }),
	body: z.record(z.string(), z.string()),
});

async function fixtureJson(relativePath: string): Promise<unknown> {
	return JSON.parse(await readFile(new URL(relativePath, machineDeviceFixtureDirectory), 'utf8'));
}

it('keeps exactly one device replay response and schema for each documented answer', async (): Promise<void> => {
	const names = machineDeviceFixtureSchemas.map(({ name }) => name);
	for (const [directory, extension] of [
		['responses/', '.json'],
		['schemas/', '.schema.json'],
	] as const) {
		const files = await readdir(new URL(directory, machineDeviceFixtureDirectory));
		expect(files.toSorted()).toEqual(names.map((name) => `${name}${extension}`).toSorted());
	}
});

it.each(machineDeviceFixtureSchemas)(
	'keeps the $name replay body and JSON Schema consistent with production',
	async ({ name, status, schema, projectAt }): Promise<void> => {
		const fixture = responseFixtureSchema.parse(await fixtureJson(`responses/${name}.json`));
		expect(fixture.status).toBe(status);
		expect(await fixtureJson(`schemas/${name}.schema.json`)).toEqual(
			z.toJSONSchema(schema, { target: 'draft-2020-12' }),
		);
		expect(schema.parse(fixture.body)).toEqual(fixture.body);
		if (projectAt === undefined) return;
		const projected = await projectMachineDeviceResponse(
			projectAt,
			Response.json(fixture.body, { status: fixture.status, headers: fixture.headers }),
		);
		expect(projected.status).toBe(fixture.status);
		expect(await projected.json()).toEqual(fixture.body);
		for (const [name, value] of Object.entries(fixture.headers))
			expect(projected.headers.get(name)).toBe(value);
	},
);

it.each([
	['device-code-start', '/api/auth/device/code', false],
	['poll', '/api/auth/oauth2/token', true],
	['refresh', '/api/auth/oauth2/token', true],
] as const)(
	'accepts the %s sample through the production request guard',
	async (name, path, machineToken) => {
		const fixture = requestFixtureSchema.parse(await fixtureJson(`requests/${name}.json`));
		expect(fixture.path).toBe(path);
		const request = new Request(new URL(fixture.path, 'https://sign-in.example.invalid'), {
			method: fixture.method,
			headers: fixture.headers,
			body: new URLSearchParams(fixture.body),
		});
		expect(await machineDeviceRequestIsValid(request, machineToken)).toBe(true);
	},
);
