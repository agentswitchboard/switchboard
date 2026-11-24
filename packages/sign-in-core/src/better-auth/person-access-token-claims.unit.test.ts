import { expect, it } from 'vitest';

import { personAccessTokenClaims } from '#sign-in-core/better-auth/person-access-token-claims';
import { epochMillisecondsSchema } from '#sign-in-core/contracts/sign-in-platform';
import type { SignInStore } from '#sign-in-core/storage/models/sign-in-store';

const configuration = {
	managementAudience: 'https://portal.example.invalid/management',
	centralAdminAudience: 'https://central.example.invalid/admin',
	accessTokenSeconds: 300,
};
const user = { id: '019a3dce-2000-7000-8000-000000000003' };

/** Any store read means the guard was passed; the refusal must come before every read. */
function recordingStore(reads: string[]): SignInStore {
	const area = (name: string): unknown =>
		new Proxy(
			{},
			{
				get: (_target, method) => (): never => {
					reads.push(`${name}.${String(method)}`);
					throw new Error('store read');
				},
			},
		);
	return new Proxy({}, { get: (_target, name) => area(String(name)) }) as SignInStore;
}

it.each([configuration.centralAdminAudience, configuration.managementAudience])(
	'a person issuance with no session is invalid_grant before any read, for %s (the deferred device grant)',
	async (audience): Promise<void> => {
		// Arrange
		const reads: string[] = [];
		// Act
		const issued = personAccessTokenClaims(
			{ user, resources: [audience] },
			{
				configuration,
				store: recordingStore(reads),
				clock: { now: () => epochMillisecondsSchema.parse(2_208_988_800_000) },
			},
		);
		// Assert
		await expect(issued).rejects.toMatchObject({ body: { error: 'invalid_grant' } });
		expect(reads).toEqual([]);
	},
);
