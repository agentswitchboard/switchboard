import { createContext, Script } from 'node:vm';

import { createIsolatedPageDom } from '#sign-in-test-support/test-fixtures/isolated-page-dom';
import type { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';

type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;

/** One forwarding request the page's own script sent, with its parsed body. */
export interface AdminPageRequest {
	readonly path: string;
	readonly body: unknown;
}

export interface OrganizationAdminPageDriver {
	/** Fills the create form and submits it; resolves once the page settled, with its status. */
	readonly submitCreate: (fields: {
		readonly name: string;
		readonly description?: string;
	}) => Promise<string>;
	/** Every forwarding request the page sent, in order, including its first load. */
	readonly requests: readonly AdminPageRequest[];
	readonly changeRecordLines: () => readonly string[];
	/** How many times the page asked to reload (it does after a reported creation). */
	readonly reloads: () => number;
}

/**
 * The served `/organization-admin` page, run as a browser runs it: its inline script in an
 * isolated DOM, its `fetch` going to the real sign-in routes with the person's cookie. Only
 * browser I/O is supplied; every answer comes from sign-in and, through it, central.
 */
export async function openOrganizationAdminPage(props: {
	readonly harness: Harness;
	readonly cookie: string;
}): Promise<OrganizationAdminPageDriver> {
	const { harness } = props;
	const address = new URL('/organization-admin', harness.issuer).toString();
	const page = await harness.auth(address, { headers: { cookie: props.cookie } });
	if (page.status !== 200) throw new Error(`Admin page answered ${String(page.status)}`);
	const dom = createIsolatedPageDom(await page.text(), address);
	const { document } = dom.window;
	const requests: AdminPageRequest[] = [];
	/** Each request the page has open, settled once sign-in answered it. */
	const open = new Set<Promise<unknown>>();
	let reloads = 0;
	function track<TValue>(work: Promise<TValue>): Promise<TValue> {
		const tracked = work.finally(() => open.delete(tracked));
		open.add(tracked);
		return work;
	}
	/**
	 * Each request stays open until sign-in's whole answer is read, and the page's own read of
	 * it is tracked too: the page issues its next request only after that read, so by the time
	 * the read settles, any request it chains on is already open.
	 */
	async function pageFetch(path: string, init?: RequestInit): Promise<Response> {
		const body = typeof init?.body === 'string' ? init.body : '';
		requests.push({ path, body: body === '' ? null : JSON.parse(body) });
		const response = await track(
			(async (): Promise<Response> => {
				const answered = await harness.auth(new URL(path, address).toString(), {
					method: init?.method ?? 'GET',
					headers: {
						...Object.fromEntries(new Headers(init?.headers)),
						cookie: props.cookie,
						origin: new URL(harness.issuer).origin,
					},
					...(body === '' ? {} : { body }),
				});
				return new Response(await answered.text(), {
					status: answered.status,
					headers: answered.headers,
				});
			})(),
		);
		const readJson = response.json.bind(response);
		response.json = (): Promise<unknown> => track(readJson());
		return response;
	}
	/** Waits until no page request is open, including any the last answer started. */
	async function drained(): Promise<void> {
		for (;;) {
			// oxlint-disable-next-line no-await-in-loop -- each round waits on the requests now open.
			await Promise.allSettled(open);
			// One event-loop turn lets the page's continuation issue its next request, if any.
			// oxlint-disable-next-line no-await-in-loop -- the same round, then a fresh look.
			await new Promise((resolveTurn) => setImmediate(resolveTurn));
			if (open.size === 0) return;
		}
	}
	const context = createContext({
		document,
		fetch: pageFetch,
		FormData: dom.window.FormData,
		location: {
			reload: (): void => {
				reloads += 1;
			},
		},
		crypto: {
			getRandomValues: (array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> =>
				crypto.getRandomValues(array),
		},
	});
	for (const script of document.scripts)
		if (!script.src && script.type !== 'module')
			new Script(script.textContent).runInContext(context);
	const form = document.getElementById('create-workspace');
	if (!(form instanceof dom.window.HTMLFormElement))
		throw new Error('Admin page has no create form');
	const foundButton = form.querySelector('button');
	if (!(foundButton instanceof dom.window.HTMLButtonElement))
		throw new Error('Admin page create form has no button');
	const button: HTMLButtonElement = foundButton;
	const status = (): string => document.getElementById('status')?.textContent ?? '';
	/** The page's own end of a submit: its handler re-enables the button in `finally`. */
	function buttonReenabled(): Promise<void> {
		return new Promise((resolveEnabled) => {
			const observer = new dom.window.MutationObserver(() => {
				if (button.disabled) return;
				observer.disconnect();
				resolveEnabled();
			});
			observer.observe(button, { attributes: true, attributeFilter: ['disabled'] });
		});
	}
	await drained();
	return {
		requests,
		changeRecordLines: () =>
			Array.from(
				document.querySelectorAll('#change-records li'),
				(record) => record.textContent ?? '',
			),
		reloads: () => reloads,
		async submitCreate(fields): Promise<string> {
			const nameInput = form.querySelector('input[name="name"]');
			const descriptionInput = form.querySelector('textarea[name="description"]');
			if (!(nameInput instanceof dom.window.HTMLInputElement))
				throw new Error('Admin page create form has no name field');
			nameInput.value = fields.name;
			if (descriptionInput !== null) descriptionInput.textContent = fields.description ?? '';
			const finished = buttonReenabled();
			form.requestSubmit();
			await finished;
			await drained();
			return status();
		},
	};
}
