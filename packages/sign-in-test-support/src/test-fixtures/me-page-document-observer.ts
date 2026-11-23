import {
	createMePageDocumentTracker,
	type MePageWaitBlock,
} from '#sign-in-test-support/test-fixtures/me-page-request-tracker';
import type { PlaywrightBrowserPage } from '#sign-in-test-support/test-fixtures/playwright-browser';

let observerCount = 0;

/**
 * In every document created while the observer is installed, reports once the island has mounted
 * and shows no loading skeleton, which is the page's final content. The report carries nothing but
 * itself: the CDP execution-context id of the call says which document made it.
 *
 * This is an observed ordering, not a proof that startup has issued every fetch it will issue: the
 * page publishes no such event, and adding one is a product change. See the tracker.
 */
function startupSignalScript(bindingName: string): string {
	return `(()=>{
	let last=false;
	new MutationObserver(()=>{
		const mounted=document.querySelector('[data-sign-in-island-mounted]')!==null;
		const loading=document.querySelector('[data-slot="skeleton"]')!==null;
		const state=mounted&&!loading;
		if(state===last||!state)return;
		last=state;
		window[${JSON.stringify(bindingName)}]('rendered');
	}).observe(document,{subtree:true,attributes:true,childList:true});
})()`;
}

export interface MePageDocumentObservation {
	readonly tracker: ReturnType<typeof createMePageDocumentTracker>;
	/** Removes every listener, binding and document script this observation installed. */
	readonly stop: () => Promise<void>;
}

/**
 * Feeds a Me document tracker from the proof page's own Chromium protocol events: the main-frame
 * commit and its loader id, each request with the loader id of the document that issued it, and
 * the request's terminal event. Nothing here waits for time.
 */
export async function observeMePageDocument(props: {
	readonly proof: PlaywrightBrowserPage;
	readonly origin: string;
	readonly paths: readonly string[];
	readonly onBlocked?: (block: MePageWaitBlock) => void;
}): Promise<MePageDocumentObservation> {
	const { proof } = props;
	const { protocol, page } = proof;
	const tracker = createMePageDocumentTracker({
		origin: props.origin,
		paths: props.paths,
		...(props.onBlocked === undefined ? {} : { onBlocked: props.onBlocked }),
	});
	observerCount += 1;
	const bindingName = `meDocumentSignal${observerCount}`;
	const committed = (event: {
		frame: { id: string; parentId?: string; loaderId: string; url: string };
	}): void => {
		if (event.frame.parentId !== undefined) return;
		mainFrameId = event.frame.id;
		committedLoaderId = event.frame.loaderId;
		pairDocumentContext();
		tracker.observeMainFrameCommitted({
			loaderId: event.frame.loaderId,
			pathname: new URL(event.frame.url).pathname,
		});
	};
	const issued = (event: {
		requestId: string;
		loaderId: string;
		type?: string;
		request: { method: string; url: string };
	}): void =>
		tracker.observeRequestIssued({
			requestId: event.requestId,
			loaderId: event.loaderId,
			method: event.request.method,
			url: event.request.url,
			resourceType: event.type ?? 'Other',
		});
	const finished = (event: { requestId: string }): void =>
		tracker.observeRequestTerminal({
			requestId: event.requestId,
			outcome: 'finished',
			cancelled: false,
		});
	const failed = (event: { requestId: string; canceled?: boolean }): void =>
		tracker.observeRequestTerminal({
			requestId: event.requestId,
			outcome: 'failed',
			cancelled: event.canceled === true,
		});
	// Chromium clears the contexts, commits the document, then creates its default context, so the
	// next default context of the main frame after a commit belongs to that commit's document.
	let committedLoaderId: string | null = null;
	let mainFrameId: string | null = null;
	let defaultContext: { readonly id: number; readonly frameId: string } | null = null;
	function pairDocumentContext(): void {
		if (
			committedLoaderId === null ||
			defaultContext === null ||
			defaultContext.frameId !== mainFrameId
		)
			return;
		tracker.observeDocumentContext({ loaderId: committedLoaderId, contextId: defaultContext.id });
		committedLoaderId = null;
		defaultContext = null;
	}
	const contextsCleared = (): void => {
		committedLoaderId = null;
		defaultContext = null;
	};
	const contextCreated = (event: {
		context: { id: number; auxData?: { frameId?: string; isDefault?: boolean } };
	}): void => {
		const { frameId, isDefault } = event.context.auxData ?? {};
		if (isDefault !== true || frameId === undefined) return;
		defaultContext = { id: event.context.id, frameId };
		pairDocumentContext();
	};
	const signalled = (event: { name: string; executionContextId: number }): void => {
		if (event.name === bindingName)
			tracker.observeStartupRendered({ contextId: event.executionContextId });
	};
	const pageError = (error: Error): void => tracker.observeScriptError(error.message);
	const closed = (): void => tracker.observePageLost('page closed');
	const crashed = (): void => tracker.observePageLost('page crashed');
	protocol.on('Page.frameNavigated', committed);
	protocol.on('Network.requestWillBeSent', issued);
	protocol.on('Network.loadingFinished', finished);
	protocol.on('Network.loadingFailed', failed);
	protocol.on('Runtime.executionContextsCleared', contextsCleared);
	protocol.on('Runtime.executionContextCreated', contextCreated);
	protocol.on('Runtime.bindingCalled', signalled);
	page.on('pageerror', pageError);
	page.on('close', closed);
	page.on('crash', crashed);
	await protocol.send('Page.enable');
	await protocol.send('Runtime.enable');
	await protocol.send('Runtime.addBinding', { name: bindingName });
	const { identifier } = await protocol.send('Page.addScriptToEvaluateOnNewDocument', {
		source: startupSignalScript(bindingName),
	});
	return {
		tracker,
		async stop(): Promise<void> {
			protocol.off('Page.frameNavigated', committed);
			protocol.off('Network.requestWillBeSent', issued);
			protocol.off('Network.loadingFinished', finished);
			protocol.off('Network.loadingFailed', failed);
			protocol.off('Runtime.executionContextsCleared', contextsCleared);
			protocol.off('Runtime.executionContextCreated', contextCreated);
			protocol.off('Runtime.bindingCalled', signalled);
			page.off('pageerror', pageError);
			page.off('close', closed);
			page.off('crash', crashed);
			if (page.isClosed()) return;
			await protocol.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
			await protocol.send('Runtime.removeBinding', { name: bindingName });
		},
	};
}
