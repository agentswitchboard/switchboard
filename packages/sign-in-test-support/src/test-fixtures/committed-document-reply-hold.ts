import type { CDPSession } from 'playwright';

import type { PlaywrightBrowserPage } from '#sign-in-test-support/test-fixtures/playwright-browser';
import type { HeldBrowserReply } from '#sign-in-test-support/test-fixtures/sign-in-navigation-layout';

/**
 * How many holds on a page need the browser cache off. A cached response is never requested, so
 * it could not be held; Playwright turns the cache off the same way while it intercepts.
 */
const holdsNeedingNoCache = new WeakMap<object, number>();

async function adjustCacheUse(session: CDPSession, page: object, change: 1 | -1): Promise<void> {
	const count = (holdsNeedingNoCache.get(page) ?? 0) + change;
	holdsNeedingNoCache.set(page, count);
	if (count === 1 && change === 1)
		await session.send('Network.setCacheDisabled', { cacheDisabled: true });
	if (count === 0) await session.send('Network.setCacheDisabled', { cacheDisabled: false });
}

/**
 * Holds, once its headers have arrived, the first response to a request that the *committed*
 * main-frame document issued, and passes every other matching response through.
 *
 * The document is the first main-frame commit after the hold is created, told apart by the loader
 * id Chromium gives each committed document. A request of the document left behind, or one issued
 * before the commit, is not held whatever its URL. It pauses responses on a protocol session of its
 * own rather than a Playwright route, because a route cannot say which document issued a request.
 * `close()` stops the interception once the page has settled.
 */
export async function holdCommittedDocumentReply(
	proof: PlaywrightBrowserPage,
	props: {
		/** CDP wildcard that narrows what the browser pauses. */
		readonly urlPattern: string;
		readonly matches: RegExp;
		readonly signal: AbortSignal;
	},
): Promise<HeldBrowserReply> {
	const { signal } = props;
	const session = await proof.context.newCDPSession(proof.page);
	const requested = Promise.withResolvers<number>();
	const release = Promise.withResolvers<void>();
	const ended = Promise.withResolvers<void>();
	void requested.promise.catch(() => undefined);
	void ended.promise.catch(() => undefined);
	const loaderOfRequest = new Map<string, string>();
	let committedLoaderId: string | null = null;
	let entered = false;
	let matchedRequests = 0;
	function abort(): void {
		requested.reject(signal.reason);
		release.resolve();
	}
	if (signal.aborted) abort();
	else signal.addEventListener('abort', abort, { once: true });
	session.on('Network.requestWillBeSent', (event): void => {
		loaderOfRequest.set(event.requestId, event.loaderId);
	});
	session.on('Page.frameNavigated', (event): void => {
		if (event.frame.parentId === undefined && committedLoaderId === null)
			committedLoaderId = event.frame.loaderId;
	});
	async function resume(requestId: string): Promise<void> {
		try {
			await session.send('Fetch.continueResponse', { requestId });
		} catch (error) {
			if (!proof.page.isClosed()) throw error;
		}
	}
	session.on('Fetch.requestPaused', (event): void => {
		void (async (): Promise<void> => {
			if (!props.matches.test(event.request.url)) {
				await resume(event.requestId);
				return;
			}
			matchedRequests += 1;
			const issuedByCommittedDocument =
				committedLoaderId !== null &&
				event.networkId !== undefined &&
				loaderOfRequest.get(event.networkId) === committedLoaderId;
			if (entered || !issuedByCommittedDocument) {
				await resume(event.requestId);
				return;
			}
			entered = true;
			requested.resolve(event.responseStatusCode ?? 0);
			await release.promise;
			await resume(event.requestId);
			ended.resolve();
		})().catch((error: unknown): void => {
			requested.reject(error);
			ended.reject(error);
		});
	});
	await session.send('Network.enable');
	await adjustCacheUse(session, proof.page, 1);
	await session.send('Page.enable');
	await session.send('Fetch.enable', {
		patterns: [{ urlPattern: props.urlPattern, requestStage: 'Response' }],
	});
	return {
		status: requested.promise,
		matchedRequests: () => matchedRequests,
		release: () => release.resolve(),
		async close(): Promise<void> {
			signal.removeEventListener('abort', abort);
			release.resolve();
			if (proof.page.isClosed()) return;
			if (entered) await ended.promise;
			await session.send('Fetch.disable');
			await adjustCacheUse(session, proof.page, -1);
			// The session is not detached: detaching it breaks the page's later WebAuthn registration.
			// Its Network events stop here, and it is gone with the page.
			await session.send('Network.disable');
		},
	};
}
