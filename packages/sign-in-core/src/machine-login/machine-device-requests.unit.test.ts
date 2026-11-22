import { expect, it } from 'vitest';

import {
	machineDeviceRequestIsValid,
	revokeMachineEnrollmentPublicPath,
} from '#sign-in-core/machine-login/machine-device-requests';

it('admits a JSON enrollment revocation and refuses the same fields in a form', async (): Promise<void> => {
	const fields = {
		organizationId: '019a3dce-2000-7000-8000-000000000071',
		enrollmentId: '019a3dce-2000-7000-8000-000000000073',
	};
	const url = `https://sign-in.example.invalid${revokeMachineEnrollmentPublicPath}`;
	const json = new Request(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(fields),
	});
	const form = new Request(url, { method: 'POST', body: new URLSearchParams(fields) });
	expect(await machineDeviceRequestIsValid(json, false)).toBe(true);
	expect(await machineDeviceRequestIsValid(form, false)).toBe(false);
});
