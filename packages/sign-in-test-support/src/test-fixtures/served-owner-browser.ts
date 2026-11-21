import { createContext, Script } from 'node:vm';

import { navigateLocalBrowser } from '#sign-in-test-support/test-fixtures/browser-navigation';
import { readCurrentBrowserSession } from '#sign-in-test-support/test-fixtures/current-browser-session';
import { createIsolatedPageDom } from '#sign-in-test-support/test-fixtures/isolated-page-dom';
import type { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';

type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;
type PageEvent =
	| { readonly kind: 'navigate'; readonly url: string }
	| { readonly kind: 'document'; readonly html: string }
	| { readonly kind: 'refused' };
export type ServedOwnerObservation =
	| {
			readonly kind: 'app-confirmed';
			readonly beforeSessionId: string;
			readonly afterSessionId: string;
	  }
	| { readonly kind: 'foreign-organization-refused'; readonly status: number };

/** Only browser I/O, external provider and authenticator inputs are controlled.
 * After the CLI's initial URL, every destination comes from a served controller
 * or an actual HTTP redirect. No saved authorization URL repairs navigation. */
export function createServedOwnerBrowser(props: {
	readonly harness: Harness;
	readonly email: string;
	readonly organization?: { readonly name: string; readonly slug: string };
	readonly selection?: { readonly organizationId: string; readonly foreignOrganizationId: string };
	readonly observe: (observation: ServedOwnerObservation) => void;
}): (initialUrl: string) => Promise<readonly string[]> {
	const { harness } = props;
	let factorConfirmed = false;
	let foreignAttempted = false;
	let organizationSelected = false;
	const sensitiveValues: string[] = [];

	async function navigate(address: string, remaining: number): Promise<readonly string[]> {
		if (remaining <= 0) throw new Error('Served owner flow exceeded its navigation bound');
		const url = new URL(address, harness.issuer);
		if (url.origin !== new URL(harness.issuer).origin) {
			if (['127.0.0.1', 'localhost'].includes(url.hostname) && url.searchParams.has('code')) {
				const completed = await navigateLocalBrowser(url);
				if (!completed.ok) throw new Error('Original CLI loopback refused the page callback');
				sensitiveValues.push(url.searchParams.get('code') ?? '', harness.cookie());
				return sensitiveValues;
			}
			return navigate(
				harness.providerCallback('google', url, props.email, true).toString(),
				remaining - 1,
			);
		}
		const response = await harness.auth(url.toString(), {
			headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
		});
		const location = response.headers.get('location');
		if (location !== null && response.status >= 300 && response.status < 400)
			return navigate(new URL(location, url).toString(), remaining - 1);
		if (!response.ok || !response.headers.get('content-type')?.includes('text/html'))
			throw new Error('Served owner navigation did not return a page');
		return page(url.toString(), await response.text(), remaining - 1);
	}

	async function page(
		address: string,
		html: string,
		remaining: number,
	): Promise<readonly string[]> {
		if (remaining <= 0) throw new Error('Served owner flow exceeded its page bound');
		const currentUrl = new URL(address);
		if (currentUrl.pathname === '/owner-ready' && !currentUrl.searchParams.has('authorize'))
			throw new Error('Served factor flow lost the pending CLI authorization');
		const dom = createIsolatedPageDom(html, address);
		const document = dom.window.document;
		// Steps come in order: while the page's current step is the second
		// factor, the chooser is upcoming; any other page must offer the chooser
		// until an organization is selected.
		const currentStep = document.querySelector('[aria-current="step"] h2')?.textContent;
		const factorStepCurrent = currentStep === 'Your second factor';
		if (
			props.selection !== undefined &&
			!organizationSelected &&
			currentUrl.pathname === '/owner-ready' &&
			!factorStepCurrent &&
			document.getElementById('choose-organization') === null
		) {
			dom.window.close();
			throw new Error('Served organization chooser is missing');
		}
		let completion = Promise.withResolvers<PageEvent>();
		const requests: Promise<unknown>[] = [];
		const statuses: { readonly path: string; readonly status: number }[] = [];
		const observer = new dom.window.MutationObserver(() => {
			if (document.getElementById('status')?.textContent) completion.resolve({ kind: 'refused' });
		});
		const status = document.getElementById('status');
		if (status !== null)
			observer.observe(status, { childList: true, subtree: true, characterData: true });

		async function browserFetch(
			path: string,
			init?: RequestInit,
		): Promise<
			Pick<Response, 'ok' | 'status' | 'headers' | 'redirected' | 'url' | 'json' | 'text'>
		> {
			let url = new URL(path, address);
			const pathname = url.pathname;
			const before =
				pathname === '/api/auth/two-factor/verify-totp'
					? await readCurrentBrowserSession({
							cookie: harness.cookie(),
							database: harness.database,
						})
					: null;
			let response = await harness.auth(url.toString(), init);
			statuses.push({ path: pathname, status: response.status });
			if (pathname === '/api/auth/organization/set-active' && response.status === 200)
				organizationSelected = true;
			if (before !== null && response.status === 303) {
				const after = await readCurrentBrowserSession({
					cookie: harness.cookie(),
					database: harness.database,
				});
				factorConfirmed = true;
				props.observe({
					kind: 'app-confirmed',
					beforeSessionId: before.id,
					afterSessionId: after.id,
				});
			}
			let redirected = false;
			// Follow only redirects actually returned by fetch, consuming the native
			// rotated cookie before the next GET just as a browser cookie jar does.
			async function follow(hops: number): Promise<void> {
				const location = response.headers.get('location');
				if (location === null || response.status < 300 || response.status >= 400) return;
				if (hops <= 0) throw new Error('Browser fetch exceeded its redirect bound');
				redirected = true;
				url = new URL(location, url);
				response = await harness.auth(url.toString());
				return follow(hops - 1);
			}
			await follow(10);
			return {
				ok: response.ok,
				status: response.status,
				headers: response.headers,
				redirected,
				url: url.toString(),
				json: () => response.json(),
				text: () => response.text(),
			};
		}

		async function submit(form: HTMLFormElement, button: HTMLButtonElement): Promise<PageEvent> {
			completion = Promise.withResolvers<PageEvent>();
			form.requestSubmit(button);
			const event = await completion.promise;
			await Promise.all(requests);
			return event;
		}
		function formButton(form: HTMLFormElement): HTMLButtonElement {
			const button = form.querySelector('button');
			if (!(button instanceof dom.window.HTMLButtonElement))
				throw new Error('Served owner form has no submit button');
			return button;
		}
		function formById(id: string): HTMLFormElement {
			const form = document.getElementById(id);
			if (!(form instanceof dom.window.HTMLFormElement))
				throw new Error('Served owner form is missing');
			return form;
		}
		try {
			const context = createContext({
				document: {
					addEventListener: document.addEventListener.bind(document),
					querySelector: (selector: string): Element | null => document.querySelector(selector),
					querySelectorAll: (selector: string): NodeListOf<Element> =>
						document.querySelectorAll(selector),
					getElementById: (id: string): HTMLElement | null => document.getElementById(id),
					createElement: (tag: string): HTMLElement => document.createElement(tag),
					open: (): void => undefined,
					write: (content: string): void => completion.resolve({ kind: 'document', html: content }),
					close: (): void => undefined,
				},
				window: {
					addEventListener: dom.window.addEventListener.bind(dom.window),
					dispatchEvent: dom.window.dispatchEvent.bind(dom.window),
					turnstile: {
						render(
							_element: unknown,
							options: { readonly callback: (token: string) => void },
						): string {
							options.callback(
								harness.turnstile.issueToken({
									action: 'sign_in_social',
									hostname: new URL(harness.issuer).hostname,
									verdict: 'accepted',
								}),
							);
							return 'served-page-widget';
						},
						reset: (): void => undefined,
					},
				},
				fetch(path: string, init?: RequestInit): ReturnType<typeof browserFetch> {
					const pending = browserFetch(path, init);
					requests.push(pending);
					return pending;
				},
				FormData: dom.window.FormData,
				HTMLFormElement: dom.window.HTMLFormElement,
				Event: dom.window.Event,
				location: {
					assign: (url: string): void => completion.resolve({ kind: 'navigate', url }),
					reload: (): void => completion.resolve({ kind: 'navigate', url: address }),
				},
				Uint8Array,
				atob,
				btoa,
				Error,
			});
			// Classic inline controllers only: the island bootstrap is an inline module
			// this harness does not run, as it never ran the island bundle.
			for (const script of document.scripts)
				if (!script.src && script.type !== 'module')
					new Script(script.textContent).runInContext(context);
			if (document.getElementById('sign-in-captcha') !== null)
				new Script('window.onSignInTurnstileReady()').runInContext(context);
			const uri = document.getElementById('totp-uri')?.textContent;
			if (uri)
				harness.totpAuthenticator.observeEnrollment(props.email, {
					method: 'totp',
					totpURI: uri,
					backupCodes: [...document.querySelectorAll('li code')].map(
						(element) => element.textContent,
					),
				});
			let form: HTMLFormElement;
			let button: HTMLButtonElement;
			if (document.getElementById('sign-in-captcha') !== null) {
				const candidate = document.querySelector('form');
				if (!(candidate instanceof dom.window.HTMLFormElement))
					throw new Error('Served social form is missing');
				form = candidate;
				button = formButton(form);
			} else if (!factorConfirmed) {
				const forms = [...document.querySelectorAll('form[data-factor-form]')];
				// An enrolled page also offers replacement-app enrollment. Confirm
				// the current app first; enroll only when no confirmation is offered.
				const candidate =
					forms.find(
						(element) =>
							new URL(element.getAttribute('action') ?? '', address).pathname ===
							'/api/auth/two-factor/verify-totp',
					) ??
					forms.find(
						(element) =>
							new URL(element.getAttribute('action') ?? '', address).pathname ===
							'/api/auth/two-factor/enable',
					);
				if (!(candidate instanceof dom.window.HTMLFormElement))
					throw new Error('Served factor form is missing');
				form = candidate;
				button = formButton(form);
				const code = form.querySelector('input[name=code]');
				if (code instanceof dom.window.HTMLInputElement)
					code.value = await harness.totpAuthenticator.currentCode(props.email);
			} else if (document.getElementById('create-organization') !== null) {
				form = formById('create-organization');
				button = formButton(form);
				for (const [name, value] of [
					['organizationName', props.organization?.name],
					['organizationSlug', props.organization?.slug],
				]) {
					const input = form.querySelector(`[name=${name}]`);
					if (!(input instanceof dom.window.HTMLInputElement) || value === undefined)
						throw new Error('Served organization creation input is missing');
					input.value = value;
				}
			} else if (
				props.selection !== undefined &&
				document.getElementById('choose-organization') !== null
			) {
				form = formById('choose-organization');
				const selection = props.selection;
				if (selection === undefined) throw new Error('Served organization selection is missing');
				const membershipRow = [
					...form.querySelectorAll('button[type="submit"][name="organizationId"]'),
				].find(
					(row) =>
						row instanceof dom.window.HTMLButtonElement && row.value === selection.organizationId,
				);
				if (!(membershipRow instanceof dom.window.HTMLButtonElement))
					throw new Error('Served organization chooser membership row is missing');
				button = membershipRow;
				if (!foreignAttempted) {
					foreignAttempted = true;
					const foreignRow = membershipRow.cloneNode(true);
					if (!(foreignRow instanceof dom.window.HTMLButtonElement))
						throw new Error('Served organization chooser row could not be cloned');
					foreignRow.value = selection.foreignOrganizationId;
					form.appendChild(foreignRow);
					const refusal = await submit(form, foreignRow);
					foreignRow.remove();
					const response = statuses.findLast(
						(item) => item.path === '/api/auth/organization/set-active',
					);
					if (refusal.kind !== 'refused' || response?.status !== 403)
						throw new Error('Native membership boundary did not refuse the foreign organization');
					props.observe({ kind: 'foreign-organization-refused', status: response.status });
				}
			} else {
				const candidate = document.querySelector('#owner-sign-in');
				if (!(candidate instanceof dom.window.HTMLFormElement))
					throw new Error('Served Continue form is missing');
				form = candidate;
				button = formButton(form);
			}
			const event = await submit(form, button);
			if (event.kind === 'refused') throw new Error('Served owner form refused the flow');
			if (event.kind === 'document') return page(address, event.html, remaining - 1);
			return navigate(event.url, remaining - 1);
		} finally {
			observer.disconnect();
			dom.window.close();
		}
	}
	return (initialUrl): Promise<readonly string[]> => {
		harness.useBrowser(props.email);
		harness.clearBrowserSession();
		return navigate(initialUrl, 20);
	};
}
