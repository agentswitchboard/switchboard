export type AuthProofCloseState =
	| { readonly kind: 'ready' }
	| { readonly kind: 'pendingAtClose'; readonly pendingRequests: number }
	| { readonly kind: 'failedForwarder'; readonly failedRequests: number };

export class AuthProofCloseError extends Error {
	constructor(readonly state: Exclude<AuthProofCloseState, { readonly kind: 'ready' }>) {
		super(`Local auth proof close failed: ${state.kind}`);
		this.name = 'AuthProofCloseError';
	}
}

/** Gate cases must finish their requests before disposal; late receipts never gain a grace period. */
export function createAuthProofForwarderLifecycle(): {
	readonly trackRequest: (operation: () => Promise<void>) => Promise<void>;
	readonly settleAfterHttpCleanup: () => Promise<void>;
	readonly closeWithReceiptSnapshot: (props: {
		readonly report: (state: AuthProofCloseState) => Promise<void>;
		readonly capture: () => Promise<() => void | Promise<void>>;
		readonly dispose: () => Promise<void>;
	}) => Promise<void>;
} {
	let pendingRequests = 0;
	let failedRequests = 0;
	let requestsFinished = Promise.withResolvers<void>();
	requestsFinished.resolve();
	function finishRequest(): void {
		pendingRequests -= 1;
		if (pendingRequests === 0) requestsFinished.resolve();
	}
	return {
		trackRequest(operation): Promise<void> {
			if (pendingRequests === 0) requestsFinished = Promise.withResolvers<void>();
			pendingRequests += 1;
			return Promise.resolve()
				.then(operation)
				.then(
					() => {
						finishRequest();
					},
					() => {
						failedRequests += 1;
						finishRequest();
					},
				);
		},
		async settleAfterHttpCleanup(): Promise<void> {
			await requestsFinished.promise;
			if (failedRequests > 0)
				throw new AuthProofCloseError({ kind: 'failedForwarder', failedRequests });
		},
		async closeWithReceiptSnapshot(props): Promise<void> {
			const state: AuthProofCloseState =
				pendingRequests > 0
					? { kind: 'pendingAtClose', pendingRequests }
					: failedRequests > 0
						? { kind: 'failedForwarder', failedRequests }
						: { kind: 'ready' };
			let snapshot:
				| { readonly kind: 'captured'; readonly assertUnchanged: () => void | Promise<void> }
				| { readonly kind: 'failed'; readonly error: unknown };
			try {
				await props.report(state);
				try {
					snapshot = { kind: 'captured', assertUnchanged: await props.capture() };
				} catch (error) {
					snapshot = { kind: 'failed', error };
				}
			} finally {
				await props.dispose();
			}
			if (snapshot.kind === 'captured') await snapshot.assertUnchanged();
			if (state.kind !== 'ready') throw new AuthProofCloseError(state);
			if (snapshot.kind === 'failed') throw snapshot.error;
		},
	};
}
