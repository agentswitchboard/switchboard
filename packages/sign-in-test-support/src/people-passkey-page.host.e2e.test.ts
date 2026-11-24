import { createContext, Script } from 'node:vm';

import { passkey } from '@agent-collaboration/sign-in-core';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { readCurrentBrowserSession } from '#sign-in-test-support/test-fixtures/current-browser-session';
import { createIsolatedPageDom } from '#sign-in-test-support/test-fixtures/isolated-page-dom';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import {
	peoplePost,
	signInConfirmedPeopleBrowser,
	signInPeopleBrowser,
} from '#sign-in-test-support/test-fixtures/people-browser-login';
import {
	createSoftwarePasskeyAuthenticator,
	type SoftwarePasskeyAuthenticator,
} from '#sign-in-test-support/test-fixtures/software-passkey-authenticator';

useControlledSignInClock();
type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;
type BrowserCredential = Pick<
	PublicKeyCredential,
	'id' | 'rawId' | 'type' | 'authenticatorAttachment' | 'getClientExtensionResults'
>;
type RegistrationCredential = BrowserCredential & {
	readonly response: Pick<
		AuthenticatorAttestationResponse,
		'clientDataJSON' | 'attestationObject' | 'getTransports'
	>;
};
type AssertionCredential = BrowserCredential & {
	readonly response: Pick<
		AuthenticatorAssertionResponse,
		'clientDataJSON' | 'authenticatorData' | 'signature' | 'userHandle'
	>;
};

function decodedBytes(value: string): ArrayBuffer {
	return Uint8Array.from(Buffer.from(value, 'base64url')).buffer;
}

/** Only navigator.credentials is controlled. The delivered DOM/controller,
 * binary serialization, HTTP handlers, native verifier and database stay real. */
async function runPageCeremony(props: {
	readonly harness: Harness;
	readonly authenticator: SoftwarePasskeyAuthenticator;
	readonly action: 'add-passkey' | 'confirm-passkey';
}): Promise<void> {
	// The classic page controller is served on the account page, which a ready person reaches only
	// while a CLI sign-in waits to resume.
	const authorize = new URL('/api/auth/oauth2/authorize', props.harness.target.issuer);
	authorize.search = new URLSearchParams({
		client_id: props.harness.target.ownerCliClientId,
		redirect_uri: props.harness.target.ownerCliRedirectUri,
		response_type: 'code',
		scope: 'tool-portal:management',
		resource: props.harness.target.managementAudience,
		code_challenge_method: 'S256',
		code_challenge: 'waiting-cli-sign-in',
	}).toString();
	const accountPage = `/owner-ready?authorize=${encodeURIComponent(authorize.toString())}`;
	const page = await props.harness.auth(accountPage);
	expect(page.status).toBe(200);
	const dom = createIsolatedPageDom(await page.text(), props.harness.issuer + accountPage);
	const document = dom.window.document;
	const controller = [...document.scripts].find((script) =>
		script.textContent.includes('navigator.credentials.create'),
	);
	const button = document.getElementById(props.action);
	const status = document.getElementById('status');
	if (controller === undefined || button === null || status === null)
		throw new Error('Delivered owner page has no passkey ceremony controls');
	const completion = Promise.withResolvers<void>();
	const observer = new dom.window.MutationObserver(() => {
		if (status.textContent !== '')
			completion.reject(new Error('Passkey controller refused ceremony'));
	});
	observer.observe(status, { childList: true, subtree: true, characterData: true });
	const requests: Promise<Response>[] = [];
	const responses: { readonly path: string; readonly status: number }[] = [];
	const credentials = {
		async create(input: unknown): Promise<RegistrationCredential> {
			const options = z
				.object({
					publicKey: z.object({
						challenge: z.instanceof(Uint8Array),
						user: z.object({ id: z.instanceof(Uint8Array) }),
						// The browser's passkey prompt names Switchboard (A10).
						rp: z.object({ id: z.string().min(1), name: z.literal('Switchboard') }),
						authenticatorSelection: z.object({ userVerification: z.literal('required') }),
					}),
				})
				.parse(input).publicKey;
			expect(options.user.id.byteLength).toBeGreaterThan(0);
			// The relying-party ID is unchanged by naming the app.
			expect(options.rp.id).toBe(new URL(props.harness.issuer).hostname);
			const wire = props.authenticator.registrationResponse({
				challenge: Buffer.from(options.challenge).toString('base64url'),
				rpId: options.rp.id,
				origin: props.harness.issuer,
			});
			return {
				id: wire.id,
				rawId: decodedBytes(wire.rawId),
				type: wire.type,
				authenticatorAttachment: 'cross-platform',
				getClientExtensionResults: () => ({}),
				response: {
					clientDataJSON: decodedBytes(wire.response.clientDataJSON),
					attestationObject: decodedBytes(wire.response.attestationObject),
					getTransports: () => ['usb'],
				},
			};
		},
		async get(input: unknown): Promise<AssertionCredential> {
			const options = z
				.object({
					publicKey: z.object({
						challenge: z.instanceof(Uint8Array),
						rpId: z.string().min(1),
						userVerification: z.literal('required'),
						allowCredentials: z.array(z.object({ id: z.instanceof(Uint8Array) })).length(1),
					}),
				})
				.parse(input).publicKey;
			expect(
				options.allowCredentials.map(({ id }) => Buffer.from(id).toString('base64url')),
			).toEqual([props.authenticator.credentialId]);
			const wire = props.authenticator.authenticationResponse({
				challenge: Buffer.from(options.challenge).toString('base64url'),
				rpId: options.rpId,
				origin: props.harness.issuer,
			});
			return {
				id: wire.id,
				rawId: decodedBytes(wire.rawId),
				type: wire.type,
				authenticatorAttachment: 'cross-platform',
				getClientExtensionResults: () => ({}),
				response: {
					clientDataJSON: decodedBytes(wire.response.clientDataJSON),
					authenticatorData: decodedBytes(wire.response.authenticatorData),
					signature: decodedBytes(wire.response.signature),
					userHandle: null,
				},
			};
		},
	};
	try {
		new Script(controller.textContent).runInContext(
			createContext({
				document,
				navigator: { credentials },
				fetch(path: string, init?: RequestInit): Promise<Response> {
					const request = props.harness.auth(path, init).then((response) => {
						responses.push({ path, status: response.status });
						return response;
					});
					requests.push(request);
					return request;
				},
				location: { reload: () => completion.resolve() },
				atob,
				btoa,
				Uint8Array,
				Error,
			}),
		);
		button.click();
		await completion.promise;
		await Promise.all(requests);
		expect(responses).toContainEqual({
			path:
				'/api/auth/passkey/' + (props.action === 'add-passkey' ? 'verify-registration' : 'confirm'),
			status: 200,
		});
	} finally {
		observer.disconnect();
		dom.window.close();
	}
}

it('people: the delivered passkey page registers and confirms through its real binary transport and selected host', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const email = 'owner@example.invalid';
		const personId = await signInConfirmedPeopleBrowser({ harness, email });
		// Passkeys are managed on the account page, after the owner's first setup
		// creates the organization (Lead R-ui Q2: the create step is one task).
		const created = await peoplePost(harness, 'create', {
			name: 'Passkey organization',
			slug: 'passkey-organization',
		});
		expect(created.status).toBe(200);
		const authenticator = await createSoftwarePasskeyAuthenticator();
		await runPageCeremony({ harness, authenticator, action: 'add-passkey' });
		expect(
			await harness.database
				.select({ credentialId: passkey.credentialID })
				.from(passkey)
				.where(eq(passkey.userId, personId)),
		).toEqual([{ credentialId: authenticator.credentialId }]);
		await signInPeopleBrowser({ harness, email });
		const before = await readCurrentBrowserSession({
			cookie: harness.cookie(),
			database: harness.database,
		});
		expect(before.secondFactorAt).toBeNull();
		await runPageCeremony({ harness, authenticator, action: 'confirm-passkey' });
		const after = await readCurrentBrowserSession({
			cookie: harness.cookie(),
			database: harness.database,
		});
		expect(after).toMatchObject({ id: before.id, personId, secondFactorMethod: 'passkey' });
		expect(after.secondFactorAt).not.toBeNull();
	} finally {
		await harness.close();
	}
});
