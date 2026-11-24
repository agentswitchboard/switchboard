// @vitest-environment jsdom
import { createContext, Script } from 'node:vm';

import { expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';

import {
	minimalOwnerPage,
	ownerAuthorizationResume,
} from '#sign-in-core/better-auth/minimal-owner-pages';
import { signInConfigurationSchema } from '#sign-in-core/contracts/deployment-configuration';
import type { SignInCrypto } from '#sign-in-core/contracts/sign-in-platform';

/** Known random bytes 00…0f, so every page's nonce is the same fixed value. */
const fixedBytesCrypto: SignInCrypto = {
	getRandomValues: (bytes) => {
		bytes.set(Array.from({ length: bytes.byteLength }, (_, index) => index % 256));
		return bytes;
	},
	subtle: globalThis.crypto.subtle,
};

interface WidgetOptions {
	readonly sitekey: string;
	readonly action: string;
	readonly callback: (token: string) => void;
	readonly 'expired-callback': () => void;
	readonly 'error-callback': () => void;
}

interface MountedOwnerPage {
	readonly form: HTMLFormElement;
	readonly submitter: HTMLButtonElement;
	readonly status: HTMLElement;
	readonly render: Mock<(container: HTMLElement, options: WidgetOptions) => string>;
	readonly reset: Mock<(widgetId: string) => void>;
	readonly navigate: Mock<(url: string) => void>;
	readonly navigated: Promise<string>;
	readonly resetCompleted: Promise<void>;
	readonly issueToken: (token: string) => void;
}

const configuration = signInConfigurationSchema.parse({
	issuer: 'http://127.0.0.1:3000',
	mode: 'private',
	ownerEmail: 'owner@example.invalid',
	toolPortalOrigin: 'https://portal-test.invalid',
	managementAudience: 'https://portal-test.invalid/management',
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

async function mountOwnerPage(props: {
	readonly ready: boolean;
	readonly resume?: string;
	readonly fetch: (pathname: string, init: RequestInit) => Promise<Response>;
}): Promise<MountedOwnerPage> {
	const page = minimalOwnerPage({
		crypto: fixedBytesCrypto,
		ready: props.ready,
		configuration,
		resume: props.resume ?? null,
	});
	const parsed = new DOMParser().parseFromString(await page.text(), 'text/html');
	document.body.innerHTML = parsed.body.innerHTML;
	const script = parsed.querySelector('script:not([src])')?.textContent;
	if (script === null || script === undefined)
		throw new Error('Owner page has no controller script');
	const form = document.querySelector('form');
	const submitter = document.querySelector('button');
	const status = document.getElementById('status');
	if (
		!(form instanceof HTMLFormElement) ||
		!(submitter instanceof HTMLButtonElement) ||
		status === null
	)
		throw new Error('Owner page form is incomplete');
	let widgetOptions: WidgetOptions | undefined;
	const resetCompleted = Promise.withResolvers<void>();
	const render = vi.fn((_container: HTMLElement, options: WidgetOptions): string => {
		widgetOptions = options;
		return 'social-widget';
	});
	const reset = vi.fn((_widgetId: string): void => resetCompleted.resolve());
	const navigated = Promise.withResolvers<string>();
	const navigate = vi.fn((url: string): void => navigated.resolve(url));
	const pageEvents = new EventTarget();
	const context = createContext({
		document,
		window: {
			turnstile: { render, reset },
			addEventListener: pageEvents.addEventListener.bind(pageEvents),
			dispatchEvent: pageEvents.dispatchEvent.bind(pageEvents),
		},
		fetch: props.fetch,
		location: { assign: navigate },
		Error,
		Event,
	});
	new Script(script).runInContext(context);
	if (!props.ready) new Script('window.onSignInTurnstileReady()').runInContext(context);
	return {
		form,
		submitter,
		status,
		render,
		reset,
		navigate,
		navigated: navigated.promise,
		resetCompleted: resetCompleted.promise,
		issueToken(token: string): void {
			if (widgetOptions === undefined) throw new Error('Widget did not render');
			widgetOptions.callback(token);
		},
	};
}

test.each([
	{ token: '$&', suffix: '&state=$&x=1' },
	{ token: '$`', suffix: '&state=$`x=1' },
	// A special URL encodes an apostrophe in its query; its allowed fragment preserves it.
	{ token: "$'", suffix: "&state=literal#detail=$'x=1" },
	{ token: '$$', suffix: '&state=$$x=1' },
])(
	'owner bootstrap navigates to the exact validated continuation containing $token',
	async ({ token, suffix }) => {
		const authorization = new URL('/api/auth/oauth2/authorize', configuration.issuer);
		authorization.search = new URLSearchParams({
			client_id: configuration.ownerCliClientId,
			redirect_uri: configuration.ownerCliRedirectUri,
			response_type: 'code',
			scope: 'tool-portal:management',
			resource: configuration.managementAudience,
			code_challenge_method: 'S256',
			code_challenge: 'replacement-token-test',
		}).toString();
		const continuation = ownerAuthorizationResume(authorization.toString() + suffix, configuration);
		if (continuation.kind !== 'resume') throw new Error('Missing validated continuation');
		const resume = continuation.authorization;
		expect(resume).toContain(token);
		const page = await mountOwnerPage({
			ready: true,
			resume,
			fetch: async (): Promise<Response> => Response.json({ kind: 'complete' }),
		});
		page.form.requestSubmit(page.submitter);
		expect(await page.navigated).toBe(resume);
		expect(page.navigate).toHaveBeenCalledExactlyOnceWith(resume);
	},
);

test('owner page renders only the social widget before a passkey click', async () => {
	const fetch = vi.fn(async (): Promise<Response> => Response.json({}));
	const page = await mountOwnerPage({ ready: false, fetch });
	const container = document.getElementById('sign-in-captcha');
	expect(container?.getAttribute('data-sitekey')).toBe('1x00000000000000000000AA');
	expect(container?.getAttribute('data-action')).toBe('sign_in_social');
	expect(document.getElementById('sign-in-passkey-captcha')?.getAttribute('data-sitekey')).toBe(
		'1x00000000000000000000AA',
	);
	expect(page.render).toHaveBeenCalledTimes(1);
	expect(page.render).toHaveBeenCalledWith(
		container,
		expect.objectContaining({
			sitekey: '1x00000000000000000000AA',
			action: 'sign_in_social',
			size: 'flexible',
		}),
	);
	expect(document.getElementById('sign-in-turnstile-script')?.getAttribute('src')).toBe(
		'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onSignInTurnstileReady&render=explicit',
	);
	page.form.requestSubmit(page.submitter);
	expect(fetch).not.toHaveBeenCalled();
	expect(page.status.textContent).toBe('Complete sign-in verification first.');
});

test('owner social submission forwards the widget token once and resets only after completion', async () => {
	const entered = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<Response>();
	const fetch = vi.fn((_pathname: string, _init: RequestInit): Promise<Response> => {
		entered.resolve();
		return reply.promise;
	});
	const page = await mountOwnerPage({ ready: false, fetch });
	page.issueToken('first-widget-token');
	page.form.requestSubmit(page.submitter);
	await entered.promise;
	page.form.requestSubmit(page.submitter);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(page.reset).not.toHaveBeenCalled();
	const call = fetch.mock.calls[0];
	if (call === undefined) throw new Error('Social request was not sent');
	expect(call[0]).toBe('/api/auth/sign-in/social');
	expect(new Headers(call[1].headers).get('x-captcha-response')).toBe('first-widget-token');
	reply.resolve(Response.json({ url: 'https://provider.example.invalid/authorize' }));
	await page.resetCompleted;
	expect(page.navigate).toHaveBeenCalledWith('https://provider.example.invalid/authorize');
	expect(page.reset).toHaveBeenCalledExactlyOnceWith('social-widget');
	page.form.requestSubmit(page.submitter);
	expect(fetch).toHaveBeenCalledTimes(1);
});

test.each(['http-refusal', 'network-failure'])(
	'owner social submission resets after %s without navigating or reusing a token',
	async (failure: string): Promise<void> => {
		const entered = Promise.withResolvers<void>();
		const reply = Promise.withResolvers<Response>();
		const fetch = vi.fn((_pathname: string, _init: RequestInit): Promise<Response> => {
			entered.resolve();
			return reply.promise;
		});
		const page = await mountOwnerPage({ ready: false, fetch });
		page.issueToken('failed-widget-token');
		page.form.requestSubmit(page.submitter);
		await entered.promise;
		if (failure === 'http-refusal')
			reply.resolve(Response.json({ code: 'VERIFICATION_FAILED' }, { status: 403 }));
		else reply.reject(new Error('Controlled verification transport failed'));
		await page.resetCompleted;
		expect(page.reset).toHaveBeenCalledExactlyOnceWith('social-widget');
		expect(page.navigate).not.toHaveBeenCalled();
		expect(page.status.textContent?.length).toBeGreaterThan(0);
		page.form.requestSubmit(page.submitter);
		expect(fetch).toHaveBeenCalledTimes(1);
	},
);

test('owner-ready bootstrap loads no widget and sends no captcha header', async () => {
	const entered = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<Response>();
	const fetch = vi.fn((_pathname: string, _init: RequestInit): Promise<Response> => {
		entered.resolve();
		return reply.promise;
	});
	const page = await mountOwnerPage({ ready: true, fetch });
	const completed = Promise.withResolvers<void>();
	const observer = new MutationObserver((): void => completed.resolve());
	observer.observe(page.status, { childList: true });
	try {
		expect(document.getElementById('sign-in-captcha')).toBeNull();
		expect(document.querySelector('script[src]')).toBeNull();
		page.form.requestSubmit(page.submitter);
		await entered.promise;
		const call = fetch.mock.calls[0];
		if (call === undefined) throw new Error('Bootstrap request was not sent');
		expect(call[0]).toBe('/api/auth/owner/bootstrap');
		expect(new Headers(call[1].headers).has('x-captcha-response')).toBe(false);
		reply.resolve(Response.json({ kind: 'complete' }));
		await completed.promise;
		expect(page.status.textContent).toBe('Owner CLI initialized.');
		expect(page.render).not.toHaveBeenCalled();
		expect(page.reset).not.toHaveBeenCalled();
	} finally {
		observer.disconnect();
	}
});
