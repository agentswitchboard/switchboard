import type { SignInConfiguration } from '#sign-in-core/contracts/deployment-configuration';
import { mintPageNonce } from '#sign-in-core/contracts/page-nonce';
import type { SignInCrypto } from '#sign-in-core/contracts/sign-in-platform';
import type { OwnerPageProps } from '#sign-in-core/pages/owner-page';
import { renderOwnerPage } from '#sign-in-core/pages/owner-page-document';

export type OwnerAuthorizationProfile = 'management' | 'fleet';

const fleetAuthorizationFields = [
	'client_id',
	'response_type',
	'redirect_uri',
	'scope',
	'resource',
	'code_challenge',
	'code_challenge_method',
	'state',
] as const;
const fleetAuthorizationScope = 'fleet:admin offline_access';

/** A requested owner CLI continuation is absent, one of the fixed profiles, or refused. */
export type OwnerAuthorizationResume =
	| { readonly kind: 'absent' }
	| {
			readonly kind: 'resume';
			readonly profile: OwnerAuthorizationProfile;
			readonly authorization: string;
	  }
	| { readonly kind: 'refused' };

function hasFleetAuthorizationFields(
	params: URLSearchParams,
	configuration: SignInConfiguration,
): boolean {
	return (
		params.getAll('client_id').includes(configuration.ownerFleetCliClientId) ||
		params.getAll('scope').includes(fleetAuthorizationScope) ||
		params.getAll('resource').includes(configuration.centralAdminAudience)
	);
}

/** Read the page or factor carrier before reading a browser session or running a native action. */
export function ownerAuthorizationContinuation(
	requestUrl: URL,
	configuration: SignInConfiguration,
	carrier: 'page' | 'factor',
): OwnerAuthorizationResume {
	const params = requestUrl.searchParams;
	const nested = params.getAll('authorize');
	const hasFlat = params.has('client_id');
	const hasFleet =
		(hasFlat && hasFleetAuthorizationFields(params, configuration)) ||
		nested.some((value) => {
			const candidate = URL.parse(value);
			return (
				candidate !== null && hasFleetAuthorizationFields(candidate.searchParams, configuration)
			);
		});
	if (
		hasFleet &&
		(params.has('device') ||
			nested.length > 1 ||
			(hasFlat && (nested.length > 0 || carrier === 'factor')))
	)
		return { kind: 'refused' };
	if (nested[0] !== undefined) return ownerAuthorizationResume(nested[0], configuration);
	if (!hasFlat || carrier === 'factor') return { kind: 'absent' };
	const authorization = new URL('/api/auth/oauth2/authorize', configuration.issuer);
	authorization.search = requestUrl.search;
	return ownerAuthorizationResume(authorization.toString(), configuration);
}

/** The native provider compares the registered redirect as written with only the port removed. */
function loopbackRedirectWithoutPort(value: string): string | null {
	const match = /^(http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]))(?::[0-9]+)?([/?][^#]*)?$/iu.exec(
		value,
	);
	const host = match?.[1];
	return host === undefined ? null : `${host}${match?.[2] ?? ''}`;
}

/** Admit the fixed management or Fleet request after the owner's provider sign-in. */
export function ownerAuthorizationResume(
	value: string | null,
	configuration: SignInConfiguration,
): OwnerAuthorizationResume {
	if (value === null) return { kind: 'absent' };
	const authorization = URL.parse(value);
	if (authorization === null) return { kind: 'refused' };
	const params = authorization.searchParams;
	const redirect = params.get('redirect_uri') ?? '';
	const callback = URL.parse(redirect);
	const configuredCallback = new URL(configuration.ownerCliRedirectUri);
	if (
		callback === null ||
		authorization.origin !== new URL(configuration.issuer).origin ||
		authorization.pathname !== '/api/auth/oauth2/authorize' ||
		authorization.username !== '' ||
		authorization.password !== '' ||
		params.get('response_type') !== 'code' ||
		params.getAll('resource').length !== 1 ||
		params.get('code_challenge_method') !== 'S256' ||
		!params.has('code_challenge') ||
		callback.protocol !== 'http:' ||
		!['127.0.0.1', 'localhost', '[::1]'].includes(callback.hostname) ||
		callback.hostname !== configuredCallback.hostname ||
		callback.pathname !== configuredCallback.pathname ||
		callback.search !== configuredCallback.search ||
		callback.username !== '' ||
		callback.password !== '' ||
		callback.hash !== ''
	)
		return { kind: 'refused' };
	// Fleet markers select its stricter profile even if management fields are also present.
	if (hasFleetAuthorizationFields(params, configuration)) {
		const callbackWithoutPort = loopbackRedirectWithoutPort(redirect);
		if (
			params.get('client_id') !== configuration.ownerFleetCliClientId ||
			params.get('scope') !== fleetAuthorizationScope ||
			params.get('resource') !== configuration.centralAdminAudience ||
			params.size !== fleetAuthorizationFields.length ||
			fleetAuthorizationFields.some((field) => !params.get(field)?.trim()) ||
			!value.startsWith(`${authorization.origin}/`) ||
			value.includes('#') ||
			callbackWithoutPort === null ||
			callbackWithoutPort !== loopbackRedirectWithoutPort(configuration.ownerCliRedirectUri)
		)
			return { kind: 'refused' };
		return { kind: 'resume', profile: 'fleet', authorization: authorization.toString() };
	}
	if (
		params.get('client_id') !== configuration.ownerCliClientId ||
		params.get('scope') !== 'tool-portal:management' ||
		params.get('resource') !== configuration.managementAudience
	)
		return { kind: 'refused' };
	return { kind: 'resume', profile: 'management', authorization: authorization.toString() };
}

/** Provider and session actions retain their native authorization boundary. Always renders, so
 * it always mints the page's nonce. */
export function minimalOwnerPage(
	props: OwnerPageProps & { readonly crypto: SignInCrypto },
): Response {
	const { crypto, ...pageProps } = props;
	return renderOwnerPage({ ...pageProps, nonce: mintPageNonce(crypto) });
}
