export type MePageRequestOutcome = 'finished' | 'failed';

/**
 * Follows the named requests that one Me document issues. A request counts only if it was issued
 * while Me was the requesting document, and its own terminal event is what ends it: a ready-page
 * request that finishes or fails after Me has committed belongs to the old document and never
 * settles anything here. A request that fails after its headers has arrived ends in `failed`.
 */
export function createMePageRequestTracker(props: {
	readonly origin: string;
	readonly paths: readonly string[];
}): {
	readonly observeIssued: (
		request: object,
		issued: { readonly method: string; readonly url: string; readonly documentPathname: string },
	) => void;
	readonly observeTerminal: (request: object, outcome: MePageRequestOutcome) => void;
	/** Resolves, never rejects, once every named path has one request that reached a terminal event. */
	readonly settled: Promise<ReadonlyMap<string, MePageRequestOutcome>>;
} {
	const pathOfRequest = new Map<object, string>();
	const claimedPaths = new Set<string>();
	const outcomes = new Map<string, MePageRequestOutcome>();
	const everyPathSettled = Promise.withResolvers<ReadonlyMap<string, MePageRequestOutcome>>();
	return {
		observeIssued(request, issued): void {
			const url = new URL(issued.url);
			if (
				issued.method !== 'GET' ||
				issued.documentPathname !== '/me' ||
				url.origin !== props.origin ||
				!props.paths.includes(url.pathname) ||
				claimedPaths.has(url.pathname)
			)
				return;
			claimedPaths.add(url.pathname);
			pathOfRequest.set(request, url.pathname);
		},
		observeTerminal(request, outcome): void {
			const path = pathOfRequest.get(request);
			if (path === undefined || outcomes.has(path)) return;
			outcomes.set(path, outcome);
			if (outcomes.size === props.paths.length) everyPathSettled.resolve(outcomes);
		},
		settled: everyPathSettled.promise,
	};
}
