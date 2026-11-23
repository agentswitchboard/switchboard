import type { z } from 'zod';

import type { approvalPersonReplySchemas } from '#sign-in-core/central-link/approval-person-replies';
import type { AdminRefusal } from '#sign-in-core/central-link/generated/central-sign-in.gen';

// The HTTP status each C3 reply and refusal arrives with, from central's result matrix
// (`approval-person-results.md` at codex-router 24dfd348, vendored beside the C3 fixtures).
// No route reads this yet; the relayed routes will map from it.

/** How a refusal arrives: an empty body with a status, or the admin envelope at 200. */
export type ApprovalPersonRefusalArrival =
	| { readonly status: 405; readonly body: 'empty'; readonly allow: 'POST' }
	| { readonly status: 400 | 401 | 503; readonly body: 'empty' }
	| { readonly status: 200; readonly body: 'adminRefusal' };

/**
 * Every admitted C3 reply variant arrives with 200, keyed exhaustively by its `kind`. An exact
 * retained decide retry with a fresh proof, with or without the grant, also answers 200 with the
 * original result.
 */
export const approvalPersonReplyStatuses = {
	ApprovalList: { page: 200 },
	ApprovalRead: { request: 200, notVisible: 200 },
	ApprovalDecide: {
		savedDecision: 200,
		alreadyDecided: 200,
		tooLate: 200,
		invalid: 200,
		notVisible: 200,
		operationConflict: 200,
	},
} as const satisfies {
	readonly [Operation in keyof typeof approvalPersonReplySchemas]: Readonly<
		Record<z.output<(typeof approvalPersonReplySchemas)[Operation]>['kind'], 200>
	>;
};

/** Preflight refusals before the C3 union, in central's check order. Each body is empty. */
export const approvalPersonPreflightStatuses = {
	/** Any method other than POST; the reply carries `Allow: POST`. */
	methodNotPost: { status: 405, body: 'empty', allow: 'POST' },
	/** A missing or non-text `Authorization` or `DPoP` header. */
	missingCredentials: { status: 401, body: 'empty' },
	/** A missing or invalid organization address, or malformed JSON at addressing. */
	badOrganizationAddress: { status: 400, body: 'empty' },
	/** Token, proof, signed method or route, token organization or signed intent fails. */
	verificationFailed: { status: 401, body: 'empty' },
	/** Store, verifier, authority or reply unavailable; the outcome may be durable. */
	unavailable: { status: 503, body: 'empty' },
} as const satisfies Readonly<Record<string, ApprovalPersonRefusalArrival>>;

/**
 * Applying admission refusals, which arrive at 200 in the admin envelope
 * `{"result":"refused","reason":…}`. C3 has no `secondFactorRequired`.
 */
export const approvalPersonAdminRefusals = [
	'notPermitted',
	'refreshRequired',
	'authorizationSyncRequired',
	'expired',
	'requestTime',
	'requestReused',
] as const satisfies readonly AdminRefusal[];
export type ApprovalPersonAdminRefusal = (typeof approvalPersonAdminRefusals)[number];

export const approvalPersonAdminRefusalStatuses = {
	notPermitted: { status: 200, body: 'adminRefusal' },
	refreshRequired: { status: 200, body: 'adminRefusal' },
	authorizationSyncRequired: { status: 200, body: 'adminRefusal' },
	expired: { status: 200, body: 'adminRefusal' },
	requestTime: { status: 200, body: 'adminRefusal' },
	requestReused: { status: 200, body: 'adminRefusal' },
} as const satisfies Readonly<Record<ApprovalPersonAdminRefusal, ApprovalPersonRefusalArrival>>;
