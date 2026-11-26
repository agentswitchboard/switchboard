/** @jsxImportSource react */
import * as React from 'react';

import { factorFormScript } from '#sign-in-core/better-auth/factor-form-script';
import { ownerPageScript } from '#sign-in-core/better-auth/owner-page-script';
import { passkeyPageScript } from '#sign-in-core/better-auth/passkey-page-script';
import type { PageNonce } from '#sign-in-core/contracts/page-nonce';
import { FleetCliContinuationNotice } from '#sign-in-core/pages/fleet-cli-continuation';
import {
	OwnerPage,
	OwnerPageFooter,
	ownerPageTitle,
	type OwnerPageProps,
} from '#sign-in-core/pages/owner-page';
import { pageDocument, signInPagesIslandScript } from '#sign-in-core/pages/page-document';

export function renderOwnerPage(props: OwnerPageProps & { readonly nonce: PageNonce }): Response {
	const { nonce, ...pageProps } = props;
	const callback = new URL('/owner-ready', props.configuration.issuer);
	if (props.resume !== null) callback.searchParams.set('authorize', props.resume);
	if (props.deviceUserCode !== undefined) callback.searchParams.set('device', props.deviceUserCode);
	const document = pageDocument({
		title: ownerPageTitle(pageProps),
		children: (
			<React.Fragment>
				{props.resumeProfile === 'fleet' && <FleetCliContinuationNotice />}
				<OwnerPage {...pageProps} continueLocation={callback.pathname + callback.search} />
			</React.Fragment>
		),
		footer: OwnerPageFooter(pageProps),
		nonce,
		// Turnstile gates only the sign-in page; signed-in pages load no third party.
		challenge: props.ready ? 'none' : 'turnstile',
		scripts:
			ownerPageScript({
				ready: props.ready,
				callback: callback.toString(),
				resume: props.resume,
				profile: props.resumeProfile,
			}) +
			(props.factorPage !== undefined && props.factorPage !== 'hidden'
				? passkeyPageScript() + factorFormScript()
				: '') +
			// Passkey sign-in, factor controls and membership choices share the island entry.
			(!props.ready ||
			(props.factorPage !== undefined && props.factorPage !== 'hidden') ||
			(props.memberships?.length ?? 0) > 0
				? signInPagesIslandScript
				: '') +
			(props.ready
				? ''
				: '<script id="sign-in-turnstile-script" src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onSignInTurnstileReady&amp;render=explicit" async defer></script>'),
	});
	return new Response(document.html, { headers: document.headers });
}
