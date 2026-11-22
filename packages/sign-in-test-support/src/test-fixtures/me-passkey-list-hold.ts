import { authProofHoldTokenHeader } from '#sign-in-test-support/test-fixtures/auth-proof-http-response-holds';
import type { NavigationBrowser } from '#sign-in-test-support/test-fixtures/sign-in-navigation-browser';

const passkeyListPath = '/api/auth/passkey/list-user-passkeys';
const meHoldToken = 'me-passkey-list';

export interface HeldMePasskeyList {
	/** Ordered by when each happened: `held`, `released`, then whatever the flow and test record. */
	readonly events: string[];
	/** Settles when the journey under test returns; rejects if it fails. */
	readonly flow: Promise<void>;
	/** The held Me page's session request is over, so only its list is still open. */
	readonly sessionSettled: Promise<void>;
	readonly release: () => void;
}

/**
 * Runs a journey and holds, inside the proof server, the passkey-list response requested by the
 * Me page the journey reaches after its `afterReadyPageVisits`-th ready-page arrival (0: the
 * first Me page). The ready page requests the same list and the pages set no-referrer, so the
 * browser marks only list requests issued from a Me document after that arrival with a hold
 * token, and the server holds only a marked response. Calls `exercise` once the hold is entered.
 * Every path out aborts the hold signal, which rejects a hold nothing reached and releases one
 * that is holding.
 */
export async function holdMePasskeyListDuring(
	browser: NavigationBrowser,
	props: {
		readonly afterReadyPageVisits: number;
		readonly journey: (events: string[]) => Promise<void>;
		readonly exercise: (held: HeldMePasskeyList) => Promise<void>;
	},
): Promise<void> {
	const { harness, proof } = browser;
	const cleanup = new AbortController();
	const scenarioEnded = (): void => cleanup.abort(browser.signal.reason);
	browser.signal.addEventListener('abort', scenarioEnded, { once: true });
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
	function countReadyPageArrival(frame: { url: () => string; parentFrame: () => unknown }): void {
		if (frame.parentFrame() !== null || new URL(frame.url()).pathname !== '/owner-ready') return;
		readyPageVisits += 1;
		if (readyPageVisits === props.afterReadyPageVisits) armSessionWait();
	}
	if (props.afterReadyPageVisits === 0) armSessionWait();
	proof.page.on('framenavigated', countReadyPageArrival);
	const passkeyListRequests = (url: URL): boolean => url.pathname === passkeyListPath;
	await proof.page.route(passkeyListRequests, async (route): Promise<void> => {
		const fromMe = new URL(route.request().frame().url()).pathname === '/me';
		const marked = fromMe && readyPageVisits >= props.afterReadyPageVisits;
		await route.continue(
			marked
				? { headers: { ...route.request().headers(), [authProofHoldTokenHeader]: meHoldToken } }
				: {},
		);
	});
	try {
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
		});
	} finally {
		proof.page.off('framenavigated', countReadyPageArrival);
		if (!proof.page.isClosed()) await proof.page.unroute(passkeyListRequests);
		browser.signal.removeEventListener('abort', scenarioEnded);
		cleanup.abort(new Error('Me passkey-list witness ended'));
	}
}
