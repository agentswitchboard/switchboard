/** @jsxImportSource react */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server.browser';

import type { FactorPageState } from '#sign-in-core/better-auth/factor-enrollment-page';
import { factorFormScript } from '#sign-in-core/better-auth/factor-form-script';
import type { PageNonce } from '#sign-in-core/contracts/page-nonce';
import {
	FactorControls,
	FactorResponseContent,
	factorResponseTitle,
	ownerReadyLocation,
	type FactorPageContent,
} from '#sign-in-core/pages/factor-page';
import {
	pageDocument,
	PageBackLink,
	PageStatus,
	signInPagesIslandScript,
} from '#sign-in-core/pages/page-document';

export function renderFactorControls(state: FactorPageState, resume: string | null): string {
	return renderToStaticMarkup(<FactorControls state={state} resume={resume} />);
}

export function renderFactorPage(props: {
	readonly content: FactorPageContent;
	readonly resume: string | null;
	readonly deviceUserCode?: string | undefined;
	readonly headers: Headers;
	readonly status: number;
	readonly nonce: PageNonce;
}): Response {
	const refusal = props.content.kind === 'refused' || props.content.kind === 'limited';
	const document = pageDocument({
		title: factorResponseTitle(props.content),
		children: (
			<React.Fragment>
				<FactorResponseContent
					content={props.content}
					resume={props.resume}
					deviceUserCode={props.deviceUserCode}
				/>
				<PageStatus />
			</React.Fragment>
		),
		// Error pages carry their one action in the card; others keep a quiet way back.
		footer: refusal ? undefined : (
			<PageBackLink href={ownerReadyLocation(props.resume, props.deviceUserCode)} />
		),
		// The replacement codes page mounts Better Auth UI's codes block (copy,
		// download, print) with the explicit finish.
		scripts:
			factorFormScript() + (props.content.kind === 'recovery-codes' ? signInPagesIslandScript : ''),
		challenge: 'none',
		headers: props.headers,
		nonce: props.nonce,
	});
	return new Response(document.html, { status: props.status, headers: document.headers });
}
