import { z } from 'zod';

import { mintPageNonce } from '#sign-in-core/contracts/page-nonce';
import type { SignInCrypto } from '#sign-in-core/contracts/sign-in-platform';
import { ownerReadyLocation, type FactorPageContent } from '#sign-in-core/pages/factor-page';
import { renderFactorControls, renderFactorPage } from '#sign-in-core/pages/factor-page-document';

const enrollmentSchema = z.object({
	method: z.literal('totp'),
	totpURI: z.string().startsWith('otpauth://totp/'),
	backupCodes: z.array(z.string().min(1)).min(1),
});

/** HTML is negotiated only for the native form POST response. The native
 * handler still owns enrollment, verification and audit. No secret is retained. */
export async function renderFactorFormResponse(props: {
	readonly request: Request;
	readonly response: Response;
	/** Asked for random bytes only on the branch that renders a page. */
	readonly crypto: SignInCrypto;
	/** The handler validates this before native effects. */
	readonly resume?: string | null;
	readonly deviceUserCode?: string | undefined;
}): Promise<Response> {
	if (props.request.method !== 'POST') return props.response;
	const path = new URL(props.request.url).pathname;
	const resume = props.resume ?? null;
	const offered = new Set([
		'/api/auth/two-factor/enable',
		'/api/auth/two-factor/generate-backup-codes',
		'/api/auth/two-factor/verify-totp',
		'/api/auth/two-factor/verify-backup-code',
		'/api/auth/two-factor/remove-app',
	]);
	if (!offered.has(path)) return props.response;
	const headers = new Headers(props.response.headers);
	headers.delete('content-length');
	headers.set('cache-control', 'no-store');
	headers.set('referrer-policy', 'no-referrer');
	if (!props.request.headers.get('accept')?.includes('text/html'))
		return new Response(props.response.body, {
			status: props.response.status,
			statusText: props.response.statusText,
			headers,
		});
	let content: FactorPageContent;
	if (props.response.status === 429) {
		content = { kind: 'limited' };
	} else if (!props.response.ok) {
		content = { kind: 'refused' };
	} else if (path === '/api/auth/two-factor/enable') {
		const enrollment = enrollmentSchema.parse(await props.response.json());
		const secret = z
			.string()
			.regex(/^[A-Z2-7]+=*$/u)
			.parse(new URL(enrollment.totpURI).searchParams.get('secret'));
		content = { kind: 'enrollment', ...enrollment, secret };
	} else if (path === '/api/auth/two-factor/generate-backup-codes') {
		const result = enrollmentSchema.pick({ backupCodes: true }).parse(await props.response.json());
		content = { kind: 'recovery-codes', ...result };
	} else {
		headers.set('location', ownerReadyLocation(resume, props.deviceUserCode));
		return new Response(null, { status: 303, headers });
	}
	return renderFactorPage({
		content,
		resume,
		deviceUserCode: props.deviceUserCode,
		headers,
		status: props.response.status,
		nonce: mintPageNonce(props.crypto),
	});
}

export type FactorPageState = 'hidden' | 'enroll-app' | 'confirm' | 'confirmed';
export function factorPageControls(state: FactorPageState, resume: string | null = null): string {
	return renderFactorControls(state, resume);
}
