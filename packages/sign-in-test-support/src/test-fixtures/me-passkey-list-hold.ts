import {
	authProofHoldTokenHeader,
	type createAuthProofHttpResponseHolds,
} from '#sign-in-test-support/test-fixtures/auth-proof-http-response-holds';
import { withNativeBrowserCleanup } from '#sign-in-test-support/test-fixtures/native-browser-cleanup';

const passkeyListPath = '/api/auth/passkey/list-user-passkeys';
const meHoldToken = 'me-passkey-list';

interface HoldableRoute {
	readonly request: () => {
		readonly frame: () => { readonly url: () => string };
		readonly headers: () => Record<string, string>;
	};
	readonly continue: (options: { readonly headers?: Record<string, string> }) => Promise<void>;
}
interface HoldableResponse {
	readonly request: () => {
		readonly method: () => string;
		readonly frame: () => { readonly url: () => string };
	};
	readonly url: () => string;
	readonly finished: () => Promise<unknown>;
}
interface HoldableNavigationRequest {
	readonly url: () => string;
	readonly isNavigationRequest: () => boolean;
	readonly frame: () => { readonly parentFrame: () => unknown };
}
/** The part of the browser page this fixture drives, so its exits can be exercised without a browser. */
export interface HoldablePage {
	readonly route: (
		matches: (url: URL) => boolean,
		handler: (route: HoldableRoute) => Promise<void>,
	) => Promise<unknown>;
	readonly unroute: (matches: (url: URL) => boolean) => Promise<void>;
	readonly on: (
		event: 'request',
		listener: (request: HoldableNavigationRequest) => void,
	) => unknown;
	readonly off: (
		event: 'request',
		listener: (request: HoldableNavigationRequest) => void,
	) => unknown;
	readonly waitForResponse: (
		matches: (response: HoldableResponse) => boolean,
		options: { readonly timeout: number },
	) => Promise<HoldableResponse>;
	readonly isClosed: () => boolean;
}
export interface MePasskeyListHoldBrowser {
	readonly signal: AbortSignal;
	readonly harness: {
		readonly httpResponseHolds: ReturnType<typeof createAuthProofHttpResponseHolds>;
	};
	readonly proof: { readonly page: HoldablePage };
}

export interface HeldMePasskeyList {
	/** Ordered by when each happened: `held`, `released`, then whatever the flow and test record. */
	readonly events: string[];
	/** Settles when the journey under test returns; rejects if it fails. */
	readonly flow: Promise<void>;
	/** The held Me page's session request is over, so only its list is still open. */
	readonly sessionSettled: Promise<void>;
	readonly release: () => void;
	/** Ends the held response as a network failure after its headers. */
	readonly fail: () => void;
}

/**
 * Runs a journey and holds, inside the proof server, the passkey-list response requested by the
 * Me page the journey reaches after its `afterReadyPageVisits`-th account-page arrival (0: the
 * first Me page). The ready page requests the same list and the pages set no-referrer, so the
 * browser marks only list requests issued from a Me document after that arrival with a hold
 * token, and the server holds only a marked response. Calls `exercise` once the hold is entered.
 * An already-aborted scenario signal rejects before anything is armed. Every other path out
 * aborts the hold first, which rejects a hold nothing reached and releases one that is holding,
 * and only then removes the browser route, so a route that cannot be removed cannot keep the hold.
 */
export async function holdMePasskeyListDuring(
	browser: MePasskeyListHoldBrowser,
	props: {
		readonly afterReadyPageVisits: number;
		readonly journey: (events: string[]) => Promise<void>;
		readonly exercise: (held: HeldMePasskeyList) => Promise<void>;
	},
): Promise<void> {
	browser.signal.throwIfAborted();
	const { harness, proof } = browser;
	const cleanup = new AbortController();
	const scenarioEnded = (): void => cleanup.abort(browser.signal.reason);
	const events: string[] = [];
	const hold = harness.httpResponseHolds.armNextGetResponse(
		passkeyListPath,
		cleanup.signal,
		meHoldToken,
	);
	let readyPageVisits = 0;
	const sessionSettled = Promise.withResolvers<void>();
	void sessionSettled.promise.catch(() => undefined);
	let sessionWaitArmed = false;
	function armSessionWait(): void {
		if (sessionWaitArmed) return;
		sessionWaitArmed = true;
		proof.page
			.waitForResponse(
				(candidate) =>
					candidate.request().method() === 'GET' &&
					new URL(candidate.url()).pathname === '/api/auth/get-session' &&
					new URL(candidate.request().frame().url()).pathname === '/me',
				{ timeout: 0 },
			)
			.then(async (response): Promise<void> => {
				await response.finished();
				// One macrotask lets every waiter on that same response run before the caller looks.
				await new Promise<void>((resolve) => setImmediate(resolve));
			})
			.then(sessionSettled.resolve, sessionSettled.reject);
	}
	// The account page answers a ready person with a redirect to Me, so an arrival is the main
	// frame's navigation request for it, not a committed document.
	function countReadyPageArrival(request: HoldableNavigationRequest): void {
		if (
			!request.isNavigationRequest() ||
			request.frame().parentFrame() !== null ||
			new URL(request.url()).pathname !== '/owner-ready'
		)
			return;
		readyPageVisits += 1;
		if (readyPageVisits === props.afterReadyPageVisits) armSessionWait();
	}
	const passkeyListRequests = (url: URL): boolean => url.pathname === passkeyListPath;
	await withNativeBrowserCleanup(
		async (): Promise<void> => {
			browser.signal.addEventListener('abort', scenarioEnded, { once: true });
			if (props.afterReadyPageVisits === 0) armSessionWait();
			proof.page.on('request', countReadyPageArrival);
			await proof.page.route(passkeyListRequests, async (route): Promise<void> => {
				const fromMe = new URL(route.request().frame().url()).pathname === '/me';
				const marked = fromMe && readyPageVisits >= props.afterReadyPageVisits;
				await route.continue(
					marked
						? { headers: { ...route.request().headers(), [authProofHoldTokenHeader]: meHoldToken } }
						: {},
				);
			});
			const flow = props.journey(events);
			void flow.catch(() => undefined);
			// A journey that fails settles the wait; one that returns early must not, so the caller sees
			// that in `events` and the hold is still awaited.
			const flowFailed = flow.then(() => new Promise<never>(() => {}));
			await Promise.race([hold.entered, flowFailed]);
			events.push('held');
			await props.exercise({
				events,
				flow,
				sessionSettled: sessionSettled.promise,
				release: hold.release,
				fail: hold.fail,
			});
		},
		async (): Promise<void> => {
			cleanup.abort(new Error('Me passkey-list witness ended'));
			browser.signal.removeEventListener('abort', scenarioEnded);
			proof.page.off('request', countReadyPageArrival);
			if (!proof.page.isClosed()) await proof.page.unroute(passkeyListRequests);
		},
	);
}
