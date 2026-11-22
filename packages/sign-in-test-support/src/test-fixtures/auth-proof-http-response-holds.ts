interface ProofHttpResponse {
	readonly destroyed: boolean;
	readonly once: (event: 'close', listener: () => void) => unknown;
	readonly off: (event: 'close', listener: () => void) => unknown;
	readonly flushHeaders: () => void;
	readonly write: (chunk: Uint8Array) => unknown;
	readonly end: (chunk: Uint8Array) => unknown;
}

export interface AuthProofHttpResponseHold {
	readonly entered: Promise<void>;
	readonly settled: Promise<'closed' | 'released'>;
	readonly release: () => void;
}

/** Holds real response bytes on the existing HTTP listener, after receipt recording. */
export function createAuthProofHttpResponseHolds(): {
	readonly armNextJwksResponse: () => AuthProofHttpResponseHold;
	readonly armNextGetResponse: (pathname: string) => AuthProofHttpResponseHold;
	readonly send: (props: {
		readonly pathname: string;
		readonly method: string;
		readonly response: ProofHttpResponse;
		readonly body: Buffer;
	}) => Promise<void>;
} {
	let armed:
		| {
				readonly pathname: string;
				readonly entered: PromiseWithResolvers<void>;
				readonly finished: PromiseWithResolvers<'closed' | 'released'>;
				readonly outcome: PromiseWithResolvers<'closed' | 'released'>;
		  }
		| undefined;
	return {
		armNextJwksResponse(): AuthProofHttpResponseHold {
			return this.armNextGetResponse('/api/auth/jwks');
		},
		armNextGetResponse(pathname): AuthProofHttpResponseHold {
			if (armed !== undefined) throw new Error('HTTP response hold already armed');
			const hold = {
				pathname,
				entered: Promise.withResolvers<void>(),
				finished: Promise.withResolvers<'closed' | 'released'>(),
				outcome: Promise.withResolvers<'closed' | 'released'>(),
			};
			armed = hold;
			return {
				entered: hold.entered.promise,
				settled: hold.finished.promise,
				release: () => hold.outcome.resolve('released'),
			};
		},
		async send({ pathname, method, response, body }): Promise<void> {
			if (armed === undefined || pathname !== armed.pathname || method !== 'GET') {
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
				hold.finished.resolve(outcome);
			} finally {
				response.off('close', closed);
			}
		},
	};
}
