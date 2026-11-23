import { expect, it } from 'vitest';

import {
	formatDeviceUserCode,
	parseDeviceUserCode,
} from '#sign-in-core/machine-login/device-user-code';

it.each([
	['ABCDEFGH', 'ABCDEFGH'],
	['abcd-efgh', 'ABCDEFGH'],
	[' ABCD EFGH ', 'ABCDEFGH'],
	['WXYZ-2345', 'WXYZ2345'],
	// Alphabet and length are Better Auth's to decide, not ours.
	['ABC', 'ABC'],
	['ABCDEFG0', 'ABCDEFG0'],
	['abcdefghjk', 'ABCDEFGHJK'],
	[` ${'A'.repeat(64)} `, 'A'.repeat(64)],
])('reads the typed code %j as %s', (typed, stored) => {
	expect(parseDeviceUserCode(typed)).toBe(stored);
});

it.each([
	null,
	'',
	'   ',
	'-',
	'https://evil.example/device?user_code=ABCDEFGH',
	'/device?user_code=ABCDEFGH',
	'//evil.example',
	'ABCD\\EFGH',
	'ABCD%2FEFGH',
	'ABCD#EFGH',
	'ABCD&next=x',
	'owner@evil.example',
	'ABCD\u0000EFGH',
	'A'.repeat(65),
])('refuses %j', (typed) => {
	expect(parseDeviceUserCode(typed)).toBeNull();
});

it.each([
	['ABCDEFGH', 'ABCD-EFGH'],
	['ABC', 'ABC'],
	['ABCDEFGHJK', 'ABCD-EFGH-JK'],
])('shows the stored code %s as %s', (code, shown) => {
	expect(formatDeviceUserCode(code)).toBe(shown);
});
