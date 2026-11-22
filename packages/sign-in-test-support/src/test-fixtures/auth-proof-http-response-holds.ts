interface ProofHttpResponse {
	readonly destroyed: boolean;
	readonly once: (event: 'close', listener: () => void) => unknown;
	readonly off: (event: 'close', listener: () => void) => unknown;
	readonly flushHeaders: () => void;
	readonly write: (chunk: Uint8Array) => unknown;
	readonly end: (chunk: Uint8Array) => unknown;
	readonly destroy: () => unknown;
}

/** A browser scenario marks the one request it wants held with this header; the relay strips it. */
export const authProofHoldTokenHeader = 'x-auth-proof-hold';

type HoldOutcome = 'closed' | 'released' | 'failed';

export interface AuthProofHttpResponseHold {
	readonly entered: Promise<void>;
	readonly settled: Promise<HoldOutcome>;
	readonly release: () => void;
	/** Drops the connection after the headers and first byte, as a network failure mid-response. */
	readonly fail: () => void;
}

/** Holds real response bytes on the existing HTTP listener, after receipt recording. */
export function createAuthProofHttpResponseHolds(): {
	readonly armNextJwksResponse: () => AuthProofHttpResponseHold;
	/**
	 * Holds the next GET of `pathname`, only one carrying `holdToken` in its hold-token header
	 * when a token is given. An aborted signal rejects `entered`, disarms an unentered hold and
	 * releases an entered one.
	 */
	readonly armNextGetResponse: (
		pathname: string,
		signal?: AbortSignal,
		holdToken?: string,
	) => AuthProofHttpResponseHold;
	readonly send: (props: {
		readonly pathname: string;
		readonly method: string;
		readonly holdToken: string | null;
		readonly response: ProofHttpResponse;
		readonly body: Buffer;
	}) => Promise<void>;
} {
	let armed:
		| {
				readonly pathname: string;
				readonly holdToken: string | undefined;
				readonly entered: PromiseWithResolvers<void>;
				readonly finished: PromiseWithResolvers<HoldOutcome>;
				readonly outcome: PromiseWithResolvers<HoldOutcome>;
		  }
		| undefined;
	return {
		armNextJwksResponse(): AuthProofHttpResponseHold {
			return this.armNextGetResponse('/api/auth/jwks');
		},
		armNextGetResponse(pathname, signal, holdToken): AuthProofHttpResponseHold {
			if (armed !== undefined) throw new Error('HTTP response hold already armed');
			const hold = {
				pathname,
				holdToken,
				entered: Promise.withResolvers<void>(),
				finished: Promise.withResolvers<HoldOutcome>(),
				outcome: Promise.withResolvers<HoldOutcome>(),
			};
			armed = hold;
			void hold.entered.promise.catch(() => undefined);
			function abort(): void {
				if (armed === hold) armed = undefined;
				hold.entered.reject(signal?.reason);
				hold.outcome.resolve('closed');
			}
			if (signal?.aborted === true) abort();
			else signal?.addEventListener('abort', abort, { once: true });
			return {
				entered: hold.entered.promise,
				settled: hold.finished.promise,
				release: () => hold.outcome.resolve('released'),
				fail: () => hold.outcome.resolve('failed'),
			};
		},
		async send({ pathname, method, holdToken, response, body }): Promise<void> {
			if (
				armed === undefined ||
				pathname !== armed.pathname ||
				method !== 'GET' ||
				(armed.holdToken !== undefined && holdToken !== armed.holdToken)
			) {
				response.end(body);
				return;
			}
			const hold = armed;
			armed = undefined;
			const closed = (): void => hold.outcome.resolve('closed');
			response.once('close', closed);
			response.flushHeaders();
			response.write(body.subarray(0, 1));
			hold.entered.resolve();
			try {
				const outcome = await hold.outcome.promise;
				if (outcome === 'released' && !response.destroyed) response.end(body.subarray(1));
				if (outcome === 'failed') response.destroy();
				hold.finished.resolve(outcome);
			} finally {
				response.off('close', closed);
			}
		},
	};
}
