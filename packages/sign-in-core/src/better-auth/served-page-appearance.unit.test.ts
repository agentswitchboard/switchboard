// @vitest-environment jsdom
import { expect, it } from 'vitest';

import { renderFactorFormResponse } from '#sign-in-core/better-auth/factor-enrollment-page';
import { minimalOwnerPage } from '#sign-in-core/better-auth/minimal-owner-pages';
import { signInConfigurationSchema } from '#sign-in-core/contracts/deployment-configuration';
import type { SignInCrypto } from '#sign-in-core/contracts/sign-in-platform';
import { organizationIdSchema } from '#sign-in-core/storage/models/sign-in-store';
const firstOrganizationId = organizationIdSchema.parse('019a3dce-2000-7000-8000-0000000000a1');
const secondOrganizationId = organizationIdSchema.parse('019a3dce-2000-7000-8000-0000000000a2');

/** Known random bytes 00…0f, so every page's nonce is the same fixed value. */
const fixedBytesCrypto: SignInCrypto = {
	getRandomValues: (bytes) => {
		bytes.set(Array.from({ length: bytes.byteLength }, (_, index) => index % 256));
		return bytes;
	},
	subtle: globalThis.crypto.subtle,
};

const configuration = signInConfigurationSchema.parse({
	issuer: 'http://127.0.0.1:3000',
	mode: 'private',
	ownerEmail: 'owner@example.invalid',
	toolPortalOrigin: 'https://portal.invalid',
	managementAudience: 'https://portal.invalid/management',
	centralIdentityAudience: 'https://central.example.invalid/identity',
	centralAdminAudience: 'https://central.example.invalid/admin',
	centralPublicOrigin: 'https://central.example.invalid',
	adminPageClientId: 'admin-page-local',
	ownerFleetCliClientId: 'owner-fleet-cli-local',
	organizationStatementLifetimeSeconds: 10_368_000,
	organizationIds: ['11111111-1111-7111-8111-111111111111'],
	ownerCliClientId: 'owner-cli-local',
	ownerCliRedirectUri: 'http://127.0.0.1/callback',
	turnstile: { kind: 'local', siteKey: '1x00000000000000000000AA' },
});

it.each([
	{ ready: false, factorPage: 'hidden', chooseOrganization: false, expected: 'Sign-in' },
	{ ready: true, factorPage: 'hidden', chooseOrganization: false, expected: 'Your account' },
	{
		ready: true,
		factorPage: 'enroll-app',
		chooseOrganization: false,
		expected: 'Set up your second factor',
	},
	{
		ready: true,
		factorPage: 'confirm',
		chooseOrganization: false,
		expected: 'Confirm your changes',
	},
	{ ready: true, factorPage: 'confirmed', chooseOrganization: false, expected: 'Your account' },
	{
		ready: true,
		factorPage: 'confirmed',
		chooseOrganization: true,
		expected: 'Choose your organization',
	},
] as const)(
	'names the $factorPage page as $expected',
	async ({ ready, factorPage, chooseOrganization, expected }) => {
		const response = minimalOwnerPage({
			crypto: fixedBytesCrypto,
			ready,
			factorPage,
			configuration,
			resume: null,
			selectionRequired: chooseOrganization,
			memberships: chooseOrganization
				? [
						{
							organizationId: firstOrganizationId,
							organizationName: 'My organization',
							role: 'owner',
						},
					]
				: [],
		});
		const page = new DOMParser().parseFromString(await response.text(), 'text/html');
		expect(page.querySelector('h1')?.textContent).toBe(expected);
		expect(page.title).toBe(expected);
	},
);

async function expectPanelDocument(response: Response): Promise<Document> {
	const page = new DOMParser().parseFromString(await response.text(), 'text/html');
	expect(page.querySelector('link[rel="stylesheet"]')?.getAttribute('href')).toMatch(
		/^\/assets\/sign-in-[a-f0-9]+\.css$/u,
	);
	expect(page.querySelector('[data-slot="card"]')).not.toBeNull();
	expect(page.querySelector('[data-slot="button"]')).not.toBeNull();
	expect(page.querySelector('meta[name="viewport"]')?.getAttribute('content')).toContain(
		'initial-scale=1',
	);
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(response.headers.get('referrer-policy')).toBe('no-referrer');
	expect(response.headers.get('x-content-type-options')).toBe('nosniff');
	const policy = response.headers.get('content-security-policy') ?? '';
	expect(policy).toContain("style-src 'self'");
	expect(policy).not.toContain('unsafe-inline');
	for (const script of page.querySelectorAll('script')) {
		expect(script.nonce.length).toBeGreaterThan(20);
		expect(policy).toContain(`'nonce-${script.nonce}'`);
	}
	return page;
}

it.each(['hidden', 'enroll-app', 'confirm', 'confirmed'] as const)(
	'uses the shared panel components for the %s owner setup state and offers organization creation only once confirmed',
	async (factorPage) => {
		const response = minimalOwnerPage({
			crypto: fixedBytesCrypto,
			ready: factorPage !== 'hidden',
			configuration,
			resume: null,
			factorPage,
			createOrganization: true,
		});
		const page = await expectPanelDocument(response);
		if (factorPage === 'confirmed')
			expect(page.querySelector('input[name="organizationName"]')?.getAttribute('data-slot')).toBe(
				'input',
			);
		else expect(page.querySelector('#create-organization')).toBeNull();
	},
);

/** One flow keeps its steps: the factor step has one title in every state. */
it.each([
	{ factorPage: 'enroll-app', factorStatus: 'current' },
	{ factorPage: 'confirm', factorStatus: 'current' },
	{ factorPage: 'confirmed', factorStatus: 'done' },
] as const)(
	'titles the factor step the same while it is $factorStatus ($factorPage)',
	async ({ factorPage, factorStatus }) => {
		const page = new DOMParser().parseFromString(
			await minimalOwnerPage({
				crypto: fixedBytesCrypto,
				ready: true,
				configuration,
				resume: null,
				factorPage,
				createOrganization: true,
			}).text(),
			'text/html',
		);
		const steps = [...page.querySelectorAll('ol li')];
		expect(steps.map((step) => step.querySelector('h2')?.textContent)).toEqual([
			'Your second factor',
			'Create your organization',
		]);
		expect(steps[0]?.getAttribute('aria-current') === 'step').toBe(factorStatus === 'current');
		// The expired-confirmation action exists only beside the create form, hidden until refused.
		const confirmAgain = page.getElementById('confirm-second-factor-again');
		if (factorPage === 'confirmed') expect(confirmAgain?.hasAttribute('hidden')).toBe(true);
		else expect(confirmAgain).toBeNull();
	},
);

it('renders untrusted organization labels in the chooser as text', async () => {
	const response = minimalOwnerPage({
		crypto: fixedBytesCrypto,
		ready: true,
		configuration,
		resume: null,
		factorPage: 'confirmed',
		selectionRequired: true,
		memberships: [
			{
				organizationId: firstOrganizationId,
				organizationName: '<script>untrusted()</script>',
				role: 'member',
			},
			{
				organizationId: secondOrganizationId,
				organizationName: 'Second organization',
				role: 'owner',
			},
		],
	});
	const page = await expectPanelDocument(response);
	const row = page.querySelector(
		'#choose-organization button[name="organizationId"][value="019a3dce-2000-7000-8000-0000000000a1"]',
	);
	expect(row?.textContent).toContain('<script>untrusted()</script>');
	expect(row?.textContent).toContain('Member');
	expect(row?.querySelector('script')).toBeNull();
	for (const script of page.querySelectorAll('script'))
		expect(script.textContent).not.toContain('untrusted()');
});

it.each([
	{
		path: 'enable',
		status: 200,
		body: {
			method: 'totp',
			totpURI: 'otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP',
			backupCodes: ['one', 'two'],
		},
	},
	{ path: 'generate-backup-codes', status: 200, body: { backupCodes: ['one', 'two'] } },
	{ path: 'enable', status: 403, body: { message: 'private upstream detail' } },
	{ path: 'enable', status: 429, body: { message: 'private upstream detail' } },
])(
	'styles factor response $path / $status without disclosing provider errors',
	async ({ path, status, body }) => {
		const response = await renderFactorFormResponse({
			crypto: fixedBytesCrypto,
			request: new Request(`https://sign-in.invalid/api/auth/two-factor/${path}`, {
				method: 'POST',
				headers: { accept: 'text/html' },
			}),
			response: Response.json(body, { status }),
		});
		const page = await expectPanelDocument(response);
		expect(response.status).toBe(status);
		expect(page.body.textContent).not.toContain('private upstream detail');
		if (status >= 400) expect(page.querySelector('[data-slot="alert"]')).not.toBeNull();
	},
);

it('names the Turnstile origin only in the sign-in page policy, and frames only blob: on signed-in pages', async () => {
	const signIn = minimalOwnerPage({
		crypto: fixedBytesCrypto,
		ready: false,
		configuration,
		resume: null,
	});
	const signInPolicy = signIn.headers.get('content-security-policy') ?? '';
	expect(signInPolicy).toMatch(
		/script-src 'nonce-[a-f0-9]+' https:\/\/challenges\.cloudflare\.com;/u,
	);
	expect(signInPolicy).toContain("connect-src 'self' https://challenges.cloudflare.com;");
	expect(signInPolicy).toContain('frame-src https://challenges.cloudflare.com;');
	expect(signInPolicy).not.toContain('blob:');

	const signedInPages = [
		...(['hidden', 'enroll-app', 'confirm', 'confirmed'] as const).map((factorPage) =>
			minimalOwnerPage({
				crypto: fixedBytesCrypto,
				ready: true,
				configuration,
				resume: null,
				factorPage,
				createOrganization: true,
			}),
		),
		minimalOwnerPage({
			crypto: fixedBytesCrypto,
			ready: true,
			configuration,
			resume: null,
			factorPage: 'confirmed',
			selectionRequired: true,
			memberships: [
				{ organizationId: firstOrganizationId, organizationName: 'One', role: 'owner' },
				{ organizationId: secondOrganizationId, organizationName: 'Two', role: 'member' },
			],
		}),
		...(await Promise.all(
			[
				{ path: 'enable', status: 403 },
				{ path: 'enable', status: 429 },
				{ path: 'generate-backup-codes', status: 200 },
			].map(({ path, status }) =>
				renderFactorFormResponse({
					crypto: fixedBytesCrypto,
					request: new Request(`https://sign-in.invalid/api/auth/two-factor/${path}`, {
						method: 'POST',
						headers: { accept: 'text/html' },
					}),
					response: Response.json(status === 200 ? { backupCodes: ['one'] } : {}, { status }),
				}),
			),
		)),
	];
	for (const page of signedInPages) {
		const policy = page.headers.get('content-security-policy') ?? '';
		// The whole policy: only frame-src blob: differs from the former signed-in policy.
		expect(policy.replace(/'nonce-[a-f0-9]+'/u, "'nonce'")).toBe(
			"default-src 'none'; script-src 'nonce'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
		);
	}
});

const fixedNonce = '000102030405060708090a0b0c0d0e0f';

it('the owner page nonce is the host bytes, on the policy header and on every script', async () => {
	// Arrange / Act
	const pages = [
		minimalOwnerPage({ crypto: fixedBytesCrypto, ready: false, configuration, resume: null }),
		minimalOwnerPage({
			crypto: fixedBytesCrypto,
			ready: true,
			configuration,
			resume: null,
			factorPage: 'enroll-app',
			createOrganization: true,
		}),
	];
	// Assert
	for (const response of pages) {
		expect(response.headers.get('content-security-policy')).toContain(`'nonce-${fixedNonce}'`);
		const page = new DOMParser().parseFromString(await response.text(), 'text/html');
		const scripts = [...page.querySelectorAll('script')];
		expect(scripts.length).toBeGreaterThan(0);
		for (const script of scripts) expect(script.getAttribute('nonce')).toBe(fixedNonce);
	}
});

it('each rendered owner page asks the host for random bytes exactly once', async () => {
	// Arrange: every draw returns different bytes, so a page shows which draw it used.
	const draws: Uint8Array<ArrayBuffer>[] = [];
	const countingCrypto: SignInCrypto = {
		getRandomValues: (bytes) => {
			bytes.fill(draws.length + 1);
			draws.push(Uint8Array.from(bytes));
			return bytes;
		},
		subtle: globalThis.crypto.subtle,
	};
	// Act
	const first = minimalOwnerPage({
		crypto: countingCrypto,
		ready: false,
		configuration,
		resume: null,
	});
	const afterFirst = draws.length;
	const second = minimalOwnerPage({
		crypto: countingCrypto,
		ready: true,
		configuration,
		resume: null,
		factorPage: 'confirmed',
	});
	// Assert
	expect(afterFirst).toBe(1);
	expect(draws.map((draw) => draw.byteLength)).toEqual([16, 16]);
	expect(first.headers.get('content-security-policy')).toContain(`'nonce-${'01'.repeat(16)}'`);
	expect(second.headers.get('content-security-policy')).toContain(`'nonce-${'02'.repeat(16)}'`);
});

it('the page policy text is exactly main f3b2b88b, with only the nonce value substituted', () => {
	// The reference is pageContentSecurityPolicy at f3b2b88b, written out with the fixed nonce.
	const signIn = minimalOwnerPage({
		crypto: fixedBytesCrypto,
		ready: false,
		configuration,
		resume: null,
	});
	const signedIn = minimalOwnerPage({
		crypto: fixedBytesCrypto,
		ready: true,
		configuration,
		resume: null,
		factorPage: 'hidden',
	});
	expect(signIn.headers.get('content-security-policy')).toBe(
		`default-src 'none'; script-src 'nonce-${fixedNonce}' https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
	);
	expect(signedIn.headers.get('content-security-policy')).toBe(
		`default-src 'none'; script-src 'nonce-${fixedNonce}'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
	);
});

it('keeps membership choices disabled before mount while enabling the selected CLI continuation', async () => {
	const memberships = [
		{
			organizationId: firstOrganizationId,
			organizationName: 'First organization',
			role: 'owner' as const,
		},
		{
			organizationId: secondOrganizationId,
			organizationName: 'Second organization',
			role: 'member' as const,
		},
	];
	await Promise.all(
		[firstOrganizationId, secondOrganizationId].map(async (activeOrganizationId): Promise<void> => {
			const response = minimalOwnerPage({
				crypto: fixedBytesCrypto,
				ready: true,
				configuration,
				resume: null,
				factorPage: 'hidden',
				memberships,
				activeOrganizationId,
				selectionRequired: false,
			});
			const page = await expectPanelDocument(response);
			expect(page.querySelector('h1')?.textContent).toBe('Your account');
			expect(page.querySelector('#owner-sign-in button')?.hasAttribute('disabled')).toBe(false);
			expect(page.querySelector('#choose-organization')?.textContent).toContain(
				'First organization',
			);
			expect(page.querySelector('#choose-organization')?.textContent).toContain(
				'Second organization',
			);
			expect(
				page.querySelector(`#choose-organization button[value="${activeOrganizationId}"]`)
					?.textContent,
			).toContain('Current');
			const otherId =
				activeOrganizationId === firstOrganizationId ? secondOrganizationId : firstOrganizationId;
			expect(
				page
					.querySelector(`#choose-organization button[value="${otherId}"]`)
					?.hasAttribute('disabled'),
			).toBe(true);
			expect(
				[...page.querySelectorAll('script')].some((script) =>
					script.textContent?.includes('mountSignInIslands'),
				),
			).toBe(true);
		}),
	);
});

it('disables the CLI only while a choice is required and keeps a sole membership informational', async () => {
	const membership = {
		organizationId: firstOrganizationId,
		organizationName: 'Only organization',
		role: 'member' as const,
	};
	await Promise.all(
		[true, false].map(async (selectionRequired): Promise<void> => {
			const response = minimalOwnerPage({
				crypto: fixedBytesCrypto,
				ready: true,
				configuration,
				resume: null,
				factorPage: 'hidden',
				memberships: selectionRequired
					? [membership, { ...membership, organizationId: secondOrganizationId }]
					: [membership],
				activeOrganizationId: null,
				selectionRequired,
			});
			const page = await expectPanelDocument(response);
			expect(page.querySelector('h1')?.textContent).toBe(
				selectionRequired ? 'Choose your organization' : 'Your account',
			);
			expect(page.querySelector('#owner-sign-in button')?.hasAttribute('disabled')).toBe(
				selectionRequired,
			);
			if (!selectionRequired)
				expect(page.querySelector('#choose-organization button')?.hasAttribute('disabled')).toBe(
					true,
				);
		}),
	);
});

it.each(['enroll-app', 'confirm'] as const)(
	'keeps pre-mount choices disabled while %s is pending',
	async (factorPage) => {
		const response = minimalOwnerPage({
			crypto: fixedBytesCrypto,
			ready: true,
			configuration,
			resume: null,
			factorPage,
			selectionRequired: true,
			activeOrganizationId: null,
			memberships: [
				{
					organizationId: firstOrganizationId,
					organizationName: 'First organization',
					role: 'owner',
				},
				{
					organizationId: secondOrganizationId,
					organizationName: 'Second organization',
					role: 'member',
				},
			],
		});
		const page = await expectPanelDocument(response);
		expect(page.querySelectorAll('#choose-organization button:not([disabled])')).toHaveLength(0);
		expect(page.querySelector('#owner-sign-in button')?.hasAttribute('disabled')).toBe(true);
		expect(page.body.textContent).not.toContain('then choose your organization');
	},
);
