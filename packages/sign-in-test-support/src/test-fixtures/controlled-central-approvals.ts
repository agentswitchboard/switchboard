import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
	approvalPersonReplySchemas,
	approvalPersonRequestBodySchemas,
	approvalPersonRoutePaths,
	type ApprovalPersonOperationName,
	type ApprovalPersonReplyFor,
} from '@agent-collaboration/sign-in-core';
import { z } from 'zod';

import {
	base64UrlSha256,
	sortedJson,
	verifyCentralPersonRequest,
	type AdminVerificationFailure,
	type CentralPersonVerifierSettings,
	type PersonTokenClaims,
} from '#sign-in-test-support/test-fixtures/controlled-central-admin';

/**
 * The named stand-in for central's C3 person approval routes (central main 1ede5c1b9). It
 * verifies each request with the same verifier steps as the admin stand-in, admits by
 * `approval:decide`, and answers in exactly the shapes of central's committed reply vectors,
 * seeded from them. It follows central's result matrix for list paging, notVisible, the decide
 * results and the operation log, but earns no credit for central's store, admission or deadline
 * settlement; only the sign-in side's sends and readings are proven here.
 */
export const approvalRouteByPath: Readonly<Record<string, ApprovalPersonOperationName>> = {
	[approvalPersonRoutePaths.ApprovalList]: 'ApprovalList',
	[approvalPersonRoutePaths.ApprovalRead]: 'ApprovalRead',
	[approvalPersonRoutePaths.ApprovalDecide]: 'ApprovalDecide',
};

const replyVectors = z
	.strictObject({
		ApprovalListReply: z.array(z.string()).min(1),
		ApprovalReadReply: z.array(z.string()).min(1),
		ApprovalDecideReply: z.array(z.string()).min(1),
	})
	.parse(
		JSON.parse(
			readFileSync(
				new URL(
					'../../../sign-in-core/contract-fixtures/central-person-approvals/approval-person-reply-vectors.json',
					import.meta.url,
				),
				'utf8',
			),
		),
	);
/** Central's own waiting unproven-call view: every seeded request is this view, re-addressed. */
const unprovenCallViewTemplate = z
	.object({ kind: z.literal('request'), view: z.looseObject({ kind: z.literal('unprovenCall') }) })
	.parse(JSON.parse(replyVectors.ApprovalReadReply[0] ?? 'null')).view;

type ReadView = Extract<
	ApprovalPersonReplyFor<'ApprovalRead'>,
	{ readonly kind: 'request' }
>['view'];
type ListedRequest = ApprovalPersonReplyFor<'ApprovalList'>['items'][number];
type ProviderApprovalOffer = Extract<ReadView, { readonly kind: 'providerApproval' }>['offer'];
type QuestionOffer = Extract<ReadView, { readonly kind: 'providerQuestion' }>['offer'];
type DecideAnswer = z.output<(typeof approvalPersonRequestBodySchemas)['ApprovalDecide']>['answer'];
type InvalidAnswer = Extract<
	Extract<DecideReply, { readonly kind: 'invalid' }>['reason'],
	{ readonly kind: 'invalidAnswer' }
>['reason'];
/** What a seeded request offers: an unproven call (central's vector), an approval, a question. */
type StoredOffer =
	| { readonly kind: 'unprovenCall' }
	| { readonly kind: 'providerApproval'; readonly offer: ProviderApprovalOffer }
	| { readonly kind: 'providerQuestion'; readonly offer: QuestionOffer };
type DecideReply = ApprovalPersonReplyFor<'ApprovalDecide'>;
type CentralReply = ApprovalPersonReplyFor<ApprovalPersonOperationName>;
type AdminRefusal = { readonly result: 'refused'; readonly reason: string };

export interface ApprovalArrival {
	readonly route: ApprovalPersonOperationName;
	readonly outcome:
		| { readonly kind: 'refused-unauthenticated'; readonly failure: AdminVerificationFailure }
		| { readonly kind: 'bad-request' }
		| { readonly kind: 'refused'; readonly reason: string }
		| { readonly kind: 'replied'; readonly reply: CentralReply; readonly delivered: boolean };
	readonly personId: string | null;
	readonly permissions: readonly string[] | null;
	readonly operationId: string | null;
	/** SHA-256 (hex) of the exact body bytes, taken before any parsing. */
	readonly bodySha256: string;
}

interface StoredRequest {
	readonly organizationId: string;
	readonly requestId: string;
	readonly raisedAtMillis: number;
	readonly offer: StoredOffer;
	ending:
		| null
		| {
				readonly kind: 'decided';
				readonly personId: string;
				readonly answer: DecideAnswer;
				readonly atMillis: number;
		  }
		| { readonly kind: 'timedOut'; readonly atMillis: number };
}

export interface ControlledCentralApprovals {
	readonly arrivals: readonly ApprovalArrival[];
	/** A waiting unproven call in `organizationId`, raised at `raisedAtMillis` (one-hour deadline). */
	readonly seedUnprovenCall: (props: {
		readonly organizationId: string;
		readonly requestId: string;
		readonly raisedAtMillis: number;
	}) => void;
	/** A waiting provider approval offering `offer`'s options. */
	readonly seedProviderApproval: (props: {
		readonly organizationId: string;
		readonly requestId: string;
		readonly raisedAtMillis: number;
		readonly offer: ProviderApprovalOffer;
	}) => void;
	/** A waiting provider question asking `offer`'s fields. */
	readonly seedQuestion: (props: {
		readonly organizationId: string;
		readonly requestId: string;
		readonly raisedAtMillis: number;
		readonly offer: QuestionOffer;
	}) => void;
	readonly setPageSize: (size: number) => void;
	/**
	 * The next admitted decide is applied and retained, but its reply is lost on the way back
	 * (central answers 503): the "reply lost" row, recovered by an exact retry.
	 */
	readonly loseNextDecideReply: () => void;
	readonly fetch: (request: Request, route: ApprovalPersonOperationName) => Promise<Response>;
}

/** The fields central's three C3 bodies carry, read once the route's own schema accepted them. */
const approvalBodyFieldsSchema = z.looseObject({
	organization: z.string(),
	filter: z.enum(['waiting', 'all']).optional(),
	cursor: z.string().nullish(),
	requestId: z.string().optional(),
	operationId: z.string().optional(),
	answer: z.unknown().optional(),
});
type ApprovalBodyFields = z.output<typeof approvalBodyFieldsSchema>;

const oneHourMillis = 3_600_000;
const approvalPermission = 'approval:decide';

/** RFC 3339 in UTC with `Z`: whole seconds, or exactly three fraction digits. */
function centralTime(milliseconds: number): string {
	const iso = new Date(milliseconds).toISOString();
	return iso.endsWith('.000Z') ? `${iso.slice(0, -5)}Z` : iso;
}

/** Central's `check_answer` (approval-request-protocol answer_validation.rs), restated. */
function checkAnswer(offer: StoredOffer, answer: DecideAnswer): InvalidAnswer | null {
	if (offer.kind === 'unprovenCall')
		return answer.kind === 'unprovenCall' ? null : { kind: 'wrongKind' };
	if (offer.kind === 'providerApproval') {
		if (answer.kind !== 'approval') return { kind: 'wrongKind' };
		return offer.offer.options.some((option) => option.id === answer.optionId)
			? null
			: { kind: 'unofferedOption', optionId: answer.optionId };
	}
	if (answer.kind !== 'question') return { kind: 'wrongKind' };
	if (answer.answer.kind === 'declined') return null;
	const answered = new Set<number>();
	for (const { fieldId, value } of answer.answer.fields) {
		if (answered.has(fieldId)) return { kind: 'repeatedField', fieldId };
		answered.add(fieldId);
		const field = offer.offer.fields.find((candidate) => candidate.fieldId === fieldId);
		if (field === undefined) return { kind: 'unofferedField', fieldId };
		const choices =
			field.kind === 'singleChoice'
				? { options: field.options, min: 1, max: 1 }
				: field.kind === 'multiChoice'
					? {
							options: field.selection.options,
							min: field.selection.min ?? 0,
							max: field.selection.max ?? field.selection.options.length,
						}
					: null;
		if (choices === null) {
			if (value.kind !== field.kind) return { kind: 'wrongValueType', fieldId };
			continue;
		}
		if (value.kind !== 'selectedOptions') return { kind: 'wrongValueType', fieldId };
		const selected = new Set<number>();
		for (const optionId of value.selectedOptionIds) {
			if (selected.has(optionId)) return { kind: 'repeatedSelection', fieldId, optionId };
			selected.add(optionId);
			if (!choices.options.some((option) => option.optionId === optionId))
				return { kind: 'unofferedOption', optionId };
		}
		if (selected.size < choices.min || selected.size > choices.max)
			return { kind: 'wrongSelectionCount', fieldId };
	}
	const missing = offer.offer.fields.find(
		(field) => field.required && !answered.has(field.fieldId),
	);
	return missing === undefined ? null : { kind: 'missingRequiredField', fieldId: missing.fieldId };
}

/** Central's `ApprovalPersonOperation::intent`, restated from its committed intent vectors. */
function independentApprovalIntent(
	route: ApprovalPersonOperationName,
	body: ApprovalBodyFields,
): string {
	const organization = body.organization;
	const intent =
		route === 'ApprovalList'
			? {
					v: 1,
					operation: route,
					organization,
					target: organization,
					operationId: null,
					params: { filter: body.filter, cursor: body.cursor ?? null },
				}
			: route === 'ApprovalRead'
				? {
						v: 1,
						operation: route,
						organization,
						target: body.requestId,
						operationId: null,
						params: {},
					}
				: {
						v: 1,
						operation: route,
						organization,
						target: body.requestId,
						operationId: body.operationId,
						params: { answer: body.answer },
					};
	return base64UrlSha256(sortedJson(intent));
}

export function createControlledCentralApprovals(
	props: CentralPersonVerifierSettings & {
		/** The provisioning peer's floors: central refuses a person whose floors it lacks. */
		readonly hasFloors: (organizationId: string, personId: string) => boolean;
	},
): ControlledCentralApprovals {
	const arrivals: ApprovalArrival[] = [];
	const requests: StoredRequest[] = [];
	const usedProofIds = new Set<string>();
	/** Central's operation log: the first result for each person's operation id and intent. */
	const operationLog = new Map<string, { readonly intent: string; readonly reply: DecideReply }>();
	let pageSize = 100;
	let loseNextDecide = false;

	function settleDeadline(stored: StoredRequest): void {
		const deadline = stored.raisedAtMillis + oneHourMillis;
		if (stored.ending === null && props.now() >= deadline)
			stored.ending = { kind: 'timedOut', atMillis: deadline };
	}

	function window(stored: StoredRequest): { readonly raisedAt: string; readonly deadline: string } {
		return {
			raisedAt: centralTime(stored.raisedAtMillis),
			deadline: centralTime(stored.raisedAtMillis + oneHourMillis),
		};
	}

	/** A parked call's state for an unproven call; a destination state for the provider kinds. */
	function state(stored: StoredRequest): object {
		const { ending } = stored;
		if (stored.offer.kind === 'unprovenCall') {
			if (ending === null) return { kind: 'waiting' };
			return {
				kind: 'ended',
				ending:
					ending.kind === 'timedOut'
						? { kind: 'timedOut' }
						: {
								kind: 'giver',
								decision:
									ending.answer.kind === 'unprovenCall' ? ending.answer.decision : 'decline',
								personId: ending.personId,
							},
				endedAt: centralTime(ending.atMillis),
				delivery: { kind: 'owed' },
			};
		}
		if (ending === null) return { kind: 'waiting', status: 'pending' };
		const accepted =
			ending.kind === 'timedOut'
				? null
				: ending.answer.kind === 'approval'
					? ending.answer.optionId
					: ending.answer.kind === 'question'
						? ending.answer.answer
						: null;
		return {
			kind: 'ended',
			ending:
				ending.kind === 'timedOut' || accepted === null
					? { kind: 'standing', ending: { kind: 'timedOut' } }
					: {
							kind: 'giver',
							decision: { by: { kind: 'person', personId: ending.personId }, answer: accepted },
						},
			endedAt: centralTime(ending.atMillis),
			delivery: { kind: 'owed' },
		};
	}

	function view(stored: StoredRequest): ReadView {
		const shape =
			stored.offer.kind === 'unprovenCall'
				? unprovenCallViewTemplate
				: { kind: stored.offer.kind, offer: stored.offer.offer };
		const read = approvalPersonReplySchemas.ApprovalRead.parse({
			kind: 'request',
			view: {
				...shape,
				requestId: stored.requestId,
				state: state(stored),
				window: window(stored),
			},
		});
		if (read.kind !== 'request') throw new Error('A seeded request always has a view');
		return read.view;
	}

	function summary(stored: StoredRequest): ListedRequest {
		return {
			requestId: stored.requestId,
			kind: stored.offer.kind,
			state:
				stored.ending === null
					? { kind: 'waiting' }
					: { kind: 'ended', ending: stored.ending.kind === 'timedOut' ? 'timedOut' : 'decided' },
			...window(stored),
		};
	}

	function admit(claims: PersonTokenClaims, proofId: string): AdminRefusal | null {
		if (props.now() >= claims.exp * 1000) return { result: 'refused', reason: 'expired' };
		if (!props.hasFloors(claims.organization_id, claims.sub))
			return { result: 'refused', reason: 'authorizationSyncRequired' };
		if (!claims.permissions.includes(approvalPermission))
			return { result: 'refused', reason: 'notPermitted' };
		if (usedProofIds.has(proofId)) return { result: 'refused', reason: 'requestReused' };
		usedProofIds.add(proofId);
		return null;
	}

	function find(organizationId: string, requestId: unknown): StoredRequest | undefined {
		return requests.find(
			(stored) => stored.organizationId === organizationId && stored.requestId === requestId,
		);
	}

	function apply(
		route: ApprovalPersonOperationName,
		body: ApprovalBodyFields,
		claims: PersonTokenClaims,
		intent: string,
	): CentralReply {
		const organizationId = claims.organization_id;
		for (const stored of requests) settleDeadline(stored);
		if (route === 'ApprovalList') {
			const cursor = body.cursor ?? null;
			const visible = requests
				.filter((stored) => stored.organizationId === organizationId)
				.filter((stored) => body.filter === 'all' || stored.ending === null)
				.filter((stored) => cursor === null || stored.requestId < cursor)
				.toSorted((left, right) => right.requestId.localeCompare(left.requestId));
			const page = visible.slice(0, pageSize);
			return {
				kind: 'page',
				items: page.map(summary),
				next: visible.length > pageSize ? (page.at(-1)?.requestId ?? null) : null,
			};
		}
		const stored = find(organizationId, body.requestId);
		if (route === 'ApprovalRead')
			return stored === undefined
				? { kind: 'notVisible' }
				: { kind: 'request', view: view(stored) };
		const logKey = `${claims.sub}/${body.operationId ?? ''}`;
		const prior = operationLog.get(logKey);
		if (prior !== undefined)
			return prior.intent === intent ? prior.reply : { kind: 'operationConflict' };
		const reply = decide(stored, body, claims);
		operationLog.set(logKey, { intent, reply });
		return reply;
	}

	function decide(
		stored: StoredRequest | undefined,
		body: ApprovalBodyFields,
		claims: PersonTokenClaims,
	): DecideReply {
		if (stored === undefined) return { kind: 'notVisible' };
		if (stored.ending?.kind === 'timedOut') return { kind: 'tooLate' };
		if (stored.ending?.kind === 'decided')
			return {
				kind: 'alreadyDecided',
				by: { kind: 'person', personId: stored.ending.personId },
				at: centralTime(stored.ending.atMillis),
			};
		const answer = approvalPersonRequestBodySchemas.ApprovalDecide.shape.answer.parse(body.answer);
		const invalid = checkAnswer(stored.offer, answer);
		if (invalid !== null)
			return { kind: 'invalid', reason: { kind: 'invalidAnswer', reason: invalid } };
		stored.ending = { kind: 'decided', personId: claims.sub, answer, atMillis: props.now() };
		return {
			kind: 'savedDecision',
			decision: { by: { kind: 'person', personId: claims.sub }, answer },
		};
	}

	return {
		arrivals,
		seedUnprovenCall(seed): void {
			requests.push({ ...seed, offer: { kind: 'unprovenCall' }, ending: null });
		},
		seedProviderApproval({ offer, ...seed }): void {
			requests.push({ ...seed, offer: { kind: 'providerApproval', offer }, ending: null });
		},
		seedQuestion({ offer, ...seed }): void {
			requests.push({ ...seed, offer: { kind: 'providerQuestion', offer }, ending: null });
		},
		setPageSize(size): void {
			pageSize = size;
		},
		loseNextDecideReply(): void {
			loseNextDecide = true;
		},
		async fetch(request, route): Promise<Response> {
			const bytes = new Uint8Array(await request.arrayBuffer());
			const bodySha256 = createHash('sha256').update(bytes).digest('hex');
			const absent = { personId: null, permissions: null, operationId: null, bodySha256 } as const;
			let decoded: unknown = null;
			try {
				decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
			} catch {
				decoded = null;
			}
			const parsed = approvalPersonRequestBodySchemas[route].safeParse(decoded);
			if (!parsed.success) {
				arrivals.push({ route, outcome: { kind: 'bad-request' }, ...absent });
				return new Response(null, { status: 400 });
			}
			const body = approvalBodyFieldsSchema.parse(parsed.data);
			const operationId = route === 'ApprovalDecide' ? (body.operationId ?? null) : null;
			const intent = independentApprovalIntent(route, body);
			const verified = await verifyCentralPersonRequest(props, request, {
				path: approvalPersonRoutePaths[route],
				organization: body.organization,
				intent,
			});
			if (verified.kind === 'refused') {
				arrivals.push({
					route,
					outcome: { kind: 'refused-unauthenticated', failure: verified.failure },
					...absent,
					operationId,
				});
				return new Response(null, { status: 401 });
			}
			const facts = {
				personId: verified.claims.sub,
				permissions: verified.claims.permissions,
				operationId,
				bodySha256,
			};
			const refused = admit(verified.claims, verified.requestId);
			if (refused !== null) {
				arrivals.push({ route, outcome: { kind: 'refused', reason: refused.reason }, ...facts });
				return Response.json(refused);
			}
			const reply = apply(route, body, verified.claims, intent);
			const delivered = !(route === 'ApprovalDecide' && loseNextDecide);
			if (route === 'ApprovalDecide') loseNextDecide = false;
			arrivals.push({ route, outcome: { kind: 'replied', reply, delivered }, ...facts });
			return delivered ? Response.json(reply) : new Response(null, { status: 503 });
		},
	};
}
