/** C8 part B: a person's link upgrade, refused or forwarded by sign-in's shared handler. */
export const personLinkRoutePath = '/api/fleet/person-link/{organization_id}';

/**
 * Every variant is refused before a token is minted, so none reaches central's link: F1's fault-free
 * lane has no central link, and a forwarded upgrade is proven by the host test's stand-in instead.
 */
const negativeVariants = [
	'non-get',
	'non-upgrade',
	'no-credential',
	'both-credentials',
	'cookie-without-origin',
	'cookie-from-other-origin',
	'bearer-scheme',
	'dpop-without-proof',
] as const;
type NegativeVariant = (typeof negativeVariants)[number];

/** The issuer's hostname on another port: an origin that is not the issuer's exact origin. */
export function otherOrigin(issuer: string): string {
	const address = new URL(issuer);
	return `${address.protocol}//${address.hostname}:${address.port === '1' ? '2' : '1'}`;
}

export const personLinkFamily = {
	route: { method: 'GET', path: personLinkRoutePath },
	variants: negativeVariants,
	generate(
		organizationId: string,
		issuer: string,
		variant: NegativeVariant,
	): {
		readonly pathname: string;
		readonly init: { readonly method: 'GET' | 'POST'; readonly headers: Headers };
		readonly status: 401 | 403 | 405;
		readonly error: string;
	} {
		const headers = new Headers({
			connection: 'Upgrade',
			upgrade: 'websocket',
			'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
			'sec-websocket-version': '13',
		});
		// A non-GET carries no upgrade: no HTTP client sends one on a body-carrying method.
		if (variant === 'non-upgrade' || variant === 'non-get') {
			headers.delete('upgrade');
			headers.delete('connection');
		}
		const cookie = 'better-auth.session_token=fixture-only-session';
		const dpop = `DPoP fixture-only-person-fleet-token`;
		const pathname = personLinkRoutePath.replace('{organization_id}', organizationId);
		const refusal = (
			status: 401 | 403 | 405,
			error: string,
		): ReturnType<(typeof personLinkFamily)['generate']> => ({
			pathname,
			init: { method: variant === 'non-get' ? 'POST' : 'GET', headers },
			status,
			error,
		});
		switch (variant) {
			case 'non-get':
				headers.set('cookie', cookie);
				headers.set('origin', new URL(issuer).origin);
				return refusal(405, 'method-not-allowed');
			case 'non-upgrade':
				headers.set('cookie', cookie);
				headers.set('origin', new URL(issuer).origin);
				return refusal(405, 'websocket-upgrade-required');
			case 'no-credential':
				return refusal(401, 'credential-missing');
			case 'both-credentials':
				headers.set('cookie', cookie);
				headers.set('authorization', dpop);
				headers.set('dpop', 'fixture-only-proof');
				return refusal(401, 'credential-ambiguous');
			case 'cookie-without-origin':
				headers.set('cookie', cookie);
				return refusal(403, 'origin-refused');
			case 'cookie-from-other-origin':
				headers.set('cookie', cookie);
				// Same host, another port: not the issuer's exact origin (a local dev edge refuses foreign hosts).
				headers.set('origin', otherOrigin(issuer));
				return refusal(403, 'origin-refused');
			case 'bearer-scheme':
				headers.set('authorization', 'Bearer fixture-only-person-fleet-token');
				headers.set('dpop', 'fixture-only-proof');
				return refusal(401, 'proof-refused');
			case 'dpop-without-proof':
				headers.set('authorization', dpop);
				return refusal(401, 'proof-refused');
			default:
				return variant satisfies never;
		}
	},
} as const;
