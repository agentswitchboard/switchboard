import { readFile } from 'node:fs/promises';

import { expect } from 'vitest';
import { z } from 'zod';

const fixtureDirectory = new URL(
	'../../../sign-in-core/contract-fixtures/machine-device-login/responses/',
	import.meta.url,
);
const replayBody = z.record(z.string(), z.union([z.string(), z.number()]));
const fixtureSchema = z.strictObject({
	status: z.number().int(),
	headers: z.record(z.string(), z.string()),
	body: replayBody,
});

function fieldTypes(body: z.infer<typeof replayBody>): Readonly<Record<string, string>> {
	return Object.fromEntries(Object.entries(body).map(([name, value]) => [name, typeof value]));
}

export async function assertMachineDeviceReplayResponse(
	name: string,
	response: Response,
): Promise<unknown> {
	const fixture = fixtureSchema.parse(
		JSON.parse(await readFile(new URL(`${name}.json`, fixtureDirectory), 'utf8')),
	);
	expect(response.status, name).toBe(fixture.status);
	for (const [header, value] of Object.entries(fixture.headers))
		expect(response.headers.get(header), `${name} ${header}`).toBe(value);
	const actual = replayBody.safeParse(await response.json());
	if (!actual.success) throw new Error(`Expected a flat machine device response for ${name}`);
	expect(fieldTypes(actual.data), name).toEqual(fieldTypes(fixture.body));
	if (Object.hasOwn(fixture.body, 'error'))
		expect(actual.data['error'], name).toBe(fixture.body['error']);
	return actual.data;
}
