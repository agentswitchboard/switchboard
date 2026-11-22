import { getSessionCookie } from 'better-auth/cookies';
import { importJWK } from 'jose';
import { z } from 'zod';

import { navigateLocalBrowser } from '#sign-in-test-support/test-fixtures/browser-navigation';
import { recordLocalAuthTransportFailure } from '#sign-in-test-support/test-fixtures/local-auth-transport-failure';

/** Browser I/O owns its cookie jar; authentication remains on the selected host. */
export function createLocalAuthBrowser(props: {
	readonly issuer: string;
	readonly onJwksReady: () => Promise<void>;
	readonly onSignInSession?: (cookie: string) => Promise<void>;
}): {
	readonly auth: (pathname: string, init?: RequestInit) => Promise<Response>;
	readonly cookie: () => string;
	readonly cookies: () => readonly string[];
	readonly clear: () => void;
} {
	const jar = new Map<string, string>();
	return {
		cookie: () => [...jar.values()].join('; '),
		cookies: () => [...jar.values()],
		clear: () => jar.clear(),
		async auth(pathname: string, init: RequestInit = {}): Promise<Response> {
			// An empty jar sends no Cookie header at all (an empty one is still a cookie to the relay).
			const headers = {
				...(jar.size === 0 ? {} : { cookie: [...jar.values()].join('; ') }),
				origin: props.issuer,
				'sec-fetch-site': 'same-origin',
				...Object.fromEntries(new Headers(init.headers)),
			};
			const response = await (
				new Headers(init.headers).get('sec-fetch-mode') === 'navigate'
					? navigateLocalBrowser(new URL(pathname, props.issuer), headers)
					: fetch(new URL(pathname, props.issuer), { ...init, headers, redirect: 'manual' })
			).catch((error: unknown): never => {
				recordLocalAuthTransportFailure('browser', error);
				throw error;
			});
			if (new URL(pathname, props.issuer).pathname === '/api/auth/jwks' && response.ok) {
				const published = z
					.object({
						keys: z
							.array(
								z.looseObject({
									kid: z.string().min(1),
									kty: z.literal('OKP'),
									crv: z.literal('Ed25519'),
								}),
							)
							.min(1),
					})
					.parse(await response.clone().json());
				const firstKey = published.keys[0];
				if (firstKey === undefined) throw new Error('Actual sign-in JWKS has no usable key');
				await importJWK(firstKey, 'EdDSA');
				await props.onJwksReady();
			}
			for (const header of response.headers.getSetCookie()) {
				const pair = header.split(';')[0];
				if (pair !== undefined) jar.set(pair.split('=')[0] ?? '', pair);
			}
			const callbackPath = new URL(pathname, props.issuer).pathname;
			const callbackCookie = response.headers
				.getSetCookie()
				.map((header) => header.split(';')[0])
				.join('; ');
			if (
				['/api/auth/callback/google', '/api/auth/callback/github'].includes(callbackPath) &&
				response.status === 302 &&
				!new URL(response.headers.get('location') ?? 'invalid:', props.issuer).searchParams.has(
					'error',
				) &&
				getSessionCookie(new Headers({ cookie: callbackCookie })) !== null
			) {
				await props.onSignInSession?.([...jar.values()].join('; '));
			}
			return response;
		},
	};
}
