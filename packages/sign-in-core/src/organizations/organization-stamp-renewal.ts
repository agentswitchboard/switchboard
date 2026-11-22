import { decodeJwt, decodeProtectedHeader } from 'jose';
import { z } from 'zod';

import type {
	OrganizationStampHeader,
	OrganizationStatement,
	OrganizationStatementDigestReply,
} from '#sign-in-core/central-link/generated/central-sign-in.gen';
import {
	organizationStatementClaimsSchema,
	organizationStatementRenewalWindowSeconds,
} from '#sign-in-core/contracts/organization-statement';
import type { SignInClock, SignInCrypto } from '#sign-in-core/contracts/sign-in-platform';
import {
	readCentralStamp,
	reprovisionFresh,
} from '#sign-in-core/organizations/organization-central-recovery';
import type {
	CentralLinkUncertainty,
	OrganizationFleetState,
	OrganizationProvisioningClient,
	OrganizationStatementRefusal,
	ProvisionOrganizationAnswer,
	SignOrganizationStatement,
} from '#sign-in-core/organizations/organization-provisioning';
import { withinDeadline } from '#sign-in-core/organizations/within-deadline';
import type { AuthorizationRevisionDeliveryRecords } from '#sign-in-core/storage/authorization-revision-delivery-store';
import type {
	SignInStoreFailure,
	SignInStoreResult,
} from '#sign-in-core/storage/models/sign-in-database';
import type { OrganizationId } from '#sign-in-core/storage/models/sign-in-store';

/** What central reports for a stored stamp, and what sign-in records once one is confirmed. */
export type OrganizationStampFacts = Readonly<OrganizationStatementDigestReply>;
export const organizationStampTryOutcomes = [
	'unanswered-unavailable',
	'unanswered-timeout',
	'unanswered-malformed-reply',
	// Lead edge rule (12 Nov): an empty record whose seed read central refused or lost.
	'unanswered-seed-unavailable',
	'refused-stale',
	'refused-organization-mismatch',
	'refused-invalid-statement',
] as const;
export type OrganizationStampTryOutcome = (typeof organizationStampTryOutcomes)[number];

/** B2 renew-on-use (owner, 9 Nov): the organization row's stamp record. */
export interface OrganizationStampRecord {
	readonly fleetState: OrganizationFleetState;
	readonly confirmed: OrganizationStampFacts | null;
	/** The signed statement whose answer is still unknown; at most one per organization. */
	readonly sent: OrganizationStatement | null;
	readonly renewedAt: number | null;
	readonly unansweredTries: number;
	readonly refusedTries: number;
	readonly lastTry: { readonly at: number; readonly outcome: OrganizationStampTryOutcome } | null;
}
/** What a definite answer does to the sent stamp, written in the same guarded update. */
export type OrganizationStampSettlement =
	| { readonly kind: 'keep-sent' }
	| { readonly kind: 'clear-sent' }
	/** WS7: central holds no stamp at all, so the record forgets its confirmed one too. */
	| { readonly kind: 'forget-central' }
	| { readonly kind: 'adopt-central'; readonly stamp: OrganizationStampFacts };

/** Every write is conditional: set the sent stamp only when empty, settle only while it
 * still holds the same statement (rule 2). A false result means another writer won. */
export interface OrganizationStampRecords {
	readonly readStampRecord: (
		organizationId: OrganizationId,
	) => Promise<SignInStoreResult<OrganizationStampRecord | null>>;
	readonly seedConfirmedStamp: (request: {
		readonly organizationId: OrganizationId;
		readonly stamp: OrganizationStampFacts;
	}) => Promise<SignInStoreResult<boolean>>;
	/**
	 * Counts one try while the record is still empty, so there are no sent bytes to settle: a seed
	 * read central refused or lost, or a WS7 recovery setup that did not land (Lead, 13 Nov).
	 */
	readonly recordUnsentTry: (request: {
		readonly organizationId: OrganizationId;
		readonly outcome: OrganizationStampTryOutcome;
		readonly now: number;
	}) => Promise<SignInStoreResult<boolean>>;
	/**
	 * WS7 R-notdue: central holds no stamp, so the record forgets its confirmed one, but only while
	 * it still names `digest` and has nothing in doubt.
	 */
	readonly forgetConfirmedStamp: (request: {
		readonly organizationId: OrganizationId;
		readonly digest: string;
	}) => Promise<SignInStoreResult<boolean>>;
	readonly claimSentStamp: (request: {
		readonly organizationId: OrganizationId;
		readonly statement: OrganizationStatement;
	}) => Promise<SignInStoreResult<boolean>>;
	readonly confirmSentStamp: (request: {
		readonly organizationId: OrganizationId;
		readonly statement: OrganizationStatement;
		readonly stamp: OrganizationStampFacts;
		readonly now: number;
	}) => Promise<SignInStoreResult<boolean>>;
	readonly recordStampTry: (request: {
		readonly organizationId: OrganizationId;
		readonly statement: OrganizationStatement;
		readonly outcome: OrganizationStampTryOutcome;
		readonly settlement: OrganizationStampSettlement;
		readonly now: number;
	}) => Promise<SignInStoreResult<boolean>>;
}

/** The one step the record calls for now. Pure: it reads, signs and sends nothing. */
export type OrganizationStampStep =
	| { readonly kind: 'not-ready' }
	| { readonly kind: 'seed' }
	| { readonly kind: 'current' }
	| { readonly kind: 'resend'; readonly statement: OrganizationStatement }
	| { readonly kind: 'sent-expired' }
	| { readonly kind: 'sign'; readonly replaces: string };

export function decideOrganizationStampStep(props: {
	readonly record: OrganizationStampRecord;
	readonly sentExpiresAt: number | null;
	readonly nowSeconds: number;
	readonly currentSigningKeyId: OrganizationStampHeader['kid'];
}): OrganizationStampStep {
	const { record } = props;
	if (record.fleetState !== 'ready') return { kind: 'not-ready' };
	if (record.confirmed === null) return { kind: 'seed' };
	// Rule 1: while a stamp is in doubt, only that same statement is ever sent again.
	if (record.sent !== null)
		return props.sentExpiresAt === null || props.sentExpiresAt <= props.nowSeconds
			? { kind: 'sent-expired' }
			: { kind: 'resend', statement: record.sent };
	const due =
		record.confirmed.signingKeyId !== props.currentSigningKeyId ||
		record.confirmed.expiresAt - props.nowSeconds <= organizationStatementRenewalWindowSeconds;
	return due ? { kind: 'sign', replaces: record.confirmed.digest } : { kind: 'current' };
}

/** Rule 4 alone: whether the stamp lets a call out; it never goes over an expired stamp. */
export type OrganizationStampReadiness =
	| { readonly kind: 'ready'; readonly renewal: OrganizationStampRenewal }
	| { readonly kind: 'unavailable'; readonly renewal: OrganizationStampRenewal };
export type OrganizationStampRenewal =
	| { readonly kind: 'not-ready' }
	| { readonly kind: 'unseeded' }
	/** WS7: central held no stamp; a fresh setup statement was provisioned and seeded. */
	| { readonly kind: 'reprovisioned' }
	/** WS7: central held no stamp and the fresh setup did not land; the call waits. */
	| { readonly kind: 'central-empty' }
	| { readonly kind: 'current' }
	| { readonly kind: 'renewed' }
	| { readonly kind: 'sent-expired' }
	| { readonly kind: 'signing-unavailable' }
	| { readonly kind: 'unanswered'; readonly reason: CentralLinkUncertainty }
	| { readonly kind: 'refused'; readonly reason: OrganizationStatementRefusal }
	| { readonly kind: 'contended' }
	| SignInStoreFailure;

export interface OrganizationStampRenewalProps {
	readonly organizationId: OrganizationId;
	readonly stamps: OrganizationStampRecords;
	readonly centralClient: Pick<
		OrganizationProvisioningClient,
		'provisionOrganization' | 'readStatementDigest'
	>;
	readonly sign: SignOrganizationStatement;
	readonly clock: SignInClock;
	readonly crypto: SignInCrypto;
	readonly currentSigningKeyId: OrganizationStampHeader['kid'];
	/** D7: one deadline for this whole guard run; every central call ends by it. */
	readonly deadline: AbortSignal;
	/** WS7 R-floors: a central found holding nothing has none of this source's ACKs either. */
	readonly revisions: Pick<AuthorizationRevisionDeliveryRecords, 'forgetCentralAcknowledgements'>;
}

/** A seed, a lost claim or a settled stamp in doubt can each need one more pass. */
const maximumStampSteps = 3;

/** B2 rules 1-5: the stamp step of each guard run (see `prepareOrganizationFleetCall`). */
export async function renewOrganizationStampForUse(
	props: OrganizationStampRenewalProps,
): Promise<OrganizationStampReadiness> {
	let renewal: OrganizationStampRenewal = { kind: 'contended' };
	for (let step = 0; step < maximumStampSteps; step += 1) {
		// oxlint-disable-next-line no-await-in-loop -- each step re-reads what the last one wrote.
		const record = await props.stamps.readStampRecord(props.organizationId);
		if (record.kind === 'store-unavailable') return { kind: 'unavailable', renewal: record };
		if (record.value === null) return { kind: 'ready', renewal: { kind: 'not-ready' } };
		const nowSeconds = Math.floor(props.clock.now() / 1000);
		const decision = decideOrganizationStampStep({
			record: record.value,
			sentExpiresAt: record.value.sent === null ? null : statementExpiry(record.value.sent),
			nowSeconds,
			currentSigningKeyId: props.currentSigningKeyId,
		});
		// oxlint-disable-next-line no-await-in-loop -- one step at a time, against the fresh record.
		const next = await takeStampStep(props, decision);
		if (next.kind === 'again') {
			renewal = next.renewal;
			continue;
		}
		renewal = next.renewal;
		break;
	}
	const settled = await props.stamps.readStampRecord(props.organizationId);
	if (settled.kind === 'store-unavailable') return { kind: 'unavailable', renewal: settled };
	const confirmed = settled.value?.confirmed ?? null;
	// D3: an unseeded or not-ready organization proceeds; central still refuses an expired stamp.
	// WS7: but an organization central has forgotten waits until its fresh setup lands.
	if (confirmed === null)
		return { kind: renewal.kind === 'central-empty' ? 'unavailable' : 'ready', renewal };
	return confirmed.expiresAt > Math.floor(props.clock.now() / 1000)
		? { kind: 'ready', renewal }
		: { kind: 'unavailable', renewal };
}

type StampStepResult =
	| { readonly kind: 'done'; readonly renewal: OrganizationStampRenewal }
	| { readonly kind: 'again'; readonly renewal: OrganizationStampRenewal };

async function takeStampStep(
	props: OrganizationStampRenewalProps,
	decision: OrganizationStampStep,
): Promise<StampStepResult> {
	switch (decision.kind) {
		case 'not-ready':
		case 'current':
		case 'sent-expired':
			return { kind: 'done', renewal: { kind: decision.kind } };
		case 'seed':
			return seedFromCentral(props);
		case 'resend':
			return sendAndSettle(props, decision.statement);
		case 'sign': {
			let statement: string;
			try {
				statement = await props.sign({
					organizationId: props.organizationId,
					replaces: decision.replaces,
				});
			} catch {
				return { kind: 'done', renewal: { kind: 'signing-unavailable' } };
			}
			const claimed = await props.stamps.claimSentStamp({
				organizationId: props.organizationId,
				statement,
			});
			if (claimed.kind === 'store-unavailable') return { kind: 'done', renewal: claimed };
			// Another writer holds a sent stamp: the next pass re-sends theirs, never ours.
			if (!claimed.value) return { kind: 'again', renewal: { kind: 'contended' } };
			return sendAndSettle(props, statement);
		}
		default:
			return unreachableStampStep(decision);
	}
}

async function seedFromCentral(props: OrganizationStampRenewalProps): Promise<StampStepResult> {
	const current = await readCentralStamp(props);
	// WS7: central answered that it holds no stamp (it started empty): set the organization up again.
	if (current.kind === 'none') return { kind: 'done', renewal: await reprovisionFresh(props) };
	if (current.kind !== 'current') {
		// No answer to seed from: nothing to sign against yet; the next guard run reads again.
		const recorded = await props.stamps.recordUnsentTry({
			organizationId: props.organizationId,
			outcome: current.kind === 'timeout' ? 'unanswered-timeout' : 'unanswered-seed-unavailable',
			now: props.clock.now(),
		});
		return {
			kind: 'done',
			renewal: recorded.kind === 'store-unavailable' ? recorded : { kind: 'unseeded' },
		};
	}
	const seeded = await props.stamps.seedConfirmedStamp({
		organizationId: props.organizationId,
		stamp: current.stamp,
	});
	if (seeded.kind === 'store-unavailable') return { kind: 'done', renewal: seeded };
	return { kind: 'again', renewal: { kind: 'current' } };
}

async function sendAndSettle(
	props: OrganizationStampRenewalProps,
	statement: string,
): Promise<StampStepResult> {
	let answer: ProvisionOrganizationAnswer;
	try {
		// D7: a reply still outstanding at the deadline is unanswered; the sent bytes stay in doubt.
		answer = await withinDeadline(
			props.deadline,
			async () =>
				props.centralClient.provisionOrganization({
					organizationId: props.organizationId,
					organizationStatement: statement,
					signal: props.deadline,
				}),
			{ kind: 'unknown', reason: 'timeout' },
		);
	} catch {
		answer = { kind: 'unknown', reason: 'unavailable' };
	}
	switch (answer.kind) {
		case 'provisioned':
			return confirm(
				props,
				statement,
				await readOrganizationStatementFacts(props.crypto, statement),
			);
		case 'unknown':
			return recordTry(
				props,
				statement,
				`unanswered-${answer.reason}`,
				{ kind: 'keep-sent' },
				{
					kind: 'unanswered',
					reason: answer.reason,
				},
			);
		case 'refused':
			if (answer.reason === 'stale') return reconcileStale(props, statement);
			// D2: central decided against these bytes, so they are no longer in doubt.
			return recordTry(
				props,
				statement,
				`refused-${answer.reason}`,
				{ kind: 'clear-sent' },
				{
					kind: 'refused',
					reason: answer.reason,
				},
			);
		default:
			return answer satisfies never;
	}
}

/**
 * Rule 3: a stale refusal is settled from central's current stamp. When its digest differs,
 * central's facts are adopted even if they have expired (owner R29, 14 Nov: a drifted and
 * expired organization recovers). An adopted expired stamp is due at once, so the next pass
 * signs a Replace of central's digest; calls still wait for a valid stamp (rule 4).
 */
async function reconcileStale(
	props: OrganizationStampRenewalProps,
	statement: string,
): Promise<StampStepResult> {
	const sent = await readOrganizationStatementFacts(props.crypto, statement);
	const read = await readCentralStamp(props);
	// D7: a deadline anywhere in the run is unanswered, never refused; the stamp stays in doubt.
	if (read.kind === 'timeout')
		return recordTry(
			props,
			statement,
			'unanswered-timeout',
			{ kind: 'keep-sent' },
			{
				kind: 'unanswered',
				reason: 'timeout',
			},
		);
	if (read.kind === 'none') {
		// WS7: the named digest is unknown because central holds nothing. Forget the record (only
		// while it still holds this statement), then set the organization up again.
		const forgotten = await props.stamps.recordStampTry({
			organizationId: props.organizationId,
			statement,
			outcome: 'refused-stale',
			settlement: { kind: 'forget-central' },
			now: props.clock.now(),
		});
		if (forgotten.kind === 'store-unavailable') return { kind: 'done', renewal: forgotten };
		if (!forgotten.value) return { kind: 'again', renewal: { kind: 'contended' } };
		return { kind: 'done', renewal: await reprovisionFresh(props) };
	}
	const current = read.kind === 'current' ? read.stamp : null;
	if (current !== null && current.digest === sent.digest) return confirm(props, statement, sent);
	const settlement: OrganizationStampSettlement =
		current !== null ? { kind: 'adopt-central', stamp: current } : { kind: 'keep-sent' };
	return recordTry(props, statement, 'refused-stale', settlement, {
		kind: 'refused',
		reason: 'stale',
	});
}

async function confirm(
	props: OrganizationStampRenewalProps,
	statement: string,
	stamp: OrganizationStampFacts,
): Promise<StampStepResult> {
	const confirmed = await props.stamps.confirmSentStamp({
		organizationId: props.organizationId,
		statement,
		stamp,
		now: props.clock.now(),
	});
	if (confirmed.kind === 'store-unavailable') return { kind: 'done', renewal: confirmed };
	return { kind: 'done', renewal: { kind: confirmed.value ? 'renewed' : 'contended' } };
}

async function recordTry(
	props: OrganizationStampRenewalProps,
	statement: string,
	outcome: OrganizationStampTryOutcome,
	settlement: OrganizationStampSettlement,
	renewal: OrganizationStampRenewal,
): Promise<StampStepResult> {
	const recorded = await props.stamps.recordStampTry({
		organizationId: props.organizationId,
		statement,
		outcome,
		settlement,
		now: props.clock.now(),
	});
	return { kind: 'done', renewal: recorded.kind === 'store-unavailable' ? recorded : renewal };
}

const statementHeaderSchema = z.looseObject({ kid: z.string().min(1) });

/** Facts of a statement sign-in signed itself; central computes the same digest. */
export async function readOrganizationStatementFacts(
	crypto: SignInCrypto,
	statement: string,
): Promise<OrganizationStampFacts> {
	const claims = organizationStatementClaimsSchema.parse(decodeJwt(statement));
	const header = statementHeaderSchema.parse(decodeProtectedHeader(statement)) satisfies Pick<
		OrganizationStampHeader,
		'kid'
	>;
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(statement));
	return {
		digest: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
			'',
		),
		expiresAt: claims.exp,
		signingKeyId: header.kid,
	};
}

/** An unreadable stored statement counts as expired: it can never be sent again. */
function statementExpiry(statement: string): number | null {
	try {
		const claims = organizationStatementClaimsSchema.safeParse(decodeJwt(statement));
		return claims.success ? claims.data.exp : null;
	} catch {
		return null;
	}
}

function unreachableStampStep(_value: never): never {
	throw new Error('Unknown organization stamp step');
}
