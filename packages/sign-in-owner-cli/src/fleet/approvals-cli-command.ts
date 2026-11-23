import {
	approvalOperationIdSchema,
	approvalRequestIdSchema,
	type ApprovalPersonAdminRefusal,
	type ApprovalPersonReplyFor,
} from '@agent-collaboration/sign-in-core';
import { z } from 'zod';

import { requireFleetTarget, type AuthTarget } from '#sign-in-owner-cli/auth-target';
import { decideApproval, sendApprovalOperation } from '#sign-in-owner-cli/fleet/approval-command';
import type { FleetCliEnvironment } from '#sign-in-owner-cli/fleet/fleet-cli-commands';
import { fleetCliSession } from '#sign-in-owner-cli/fleet/fleet-credential';

export const approvalsCommandName = 'approvals';

/** `approvals list [--all] [--cursor ID]`, `show ID`, and `approve|deny ID [--operation-id ID]`. */
const approvalsArgumentsSchema = z.union([
	z.tuple([z.literal('list')]),
	z.tuple([z.enum(['show', 'approve', 'deny']), approvalRequestIdSchema]),
]);

export interface ApprovalsCommandOptions {
	readonly all?: boolean | undefined;
	readonly cursor?: string | undefined;
	readonly 'operation-id'?: string | undefined;
}

type ReadView = Extract<
	ApprovalPersonReplyFor<'ApprovalRead'>,
	{ readonly kind: 'request' }
>['view'];
type DecideReply = ApprovalPersonReplyFor<'ApprovalDecide'>;
type ListedRequest = ApprovalPersonReplyFor<'ApprovalList'>['items'][number];
type DecidedBy = Extract<DecideReply, { readonly kind: 'alreadyDecided' }>['by'];

const requestKindWords = {
	providerApproval: 'provider approval',
	providerQuestion: 'question',
	unprovenCall: 'unproven call',
} as const satisfies Record<ListedRequest['kind'], string>;

function decidedByWords(by: DecidedBy): string {
	return by.kind === 'person' ? `person ${by.personId}` : `session ${by.session}`;
}

function listedRequestLine(item: ListedRequest): string {
	const state = item.state.kind === 'waiting' ? 'waiting' : item.state.ending;
	return `${item.requestId}  ${requestKindWords[item.kind]}  ${state}  raised ${item.raisedAt}  deadline ${item.deadline}`;
}

function decisionWords(
	answer: Extract<DecideReply, { kind: 'savedDecision' }>['decision']['answer'],
): string {
	switch (answer.kind) {
		case 'unprovenCall':
			return answer.decision;
		case 'approval':
			return `option ${answer.optionId}`;
		case 'question':
			return answer.answer.kind;
		default:
			return answer satisfies never;
	}
}

/** The words for each decide reply (R5). */
export function decideReplyWords(reply: DecideReply): string {
	switch (reply.kind) {
		case 'savedDecision':
			return `Decision saved: ${decisionWords(reply.decision.answer)}.`;
		case 'alreadyDecided':
			return `Already decided by ${decidedByWords(reply.by)} at ${reply.at}; this answer was not saved.`;
		case 'tooLate':
			return 'Too late: the request timed out or was closed before an answer.';
		case 'invalid':
			return reply.reason.kind === 'invalidAnswer'
				? `Not accepted: the answer does not fit the request (${reply.reason.reason.kind}).`
				: `Not accepted: central could not end the request (${reply.reason.reason.kind}).`;
		case 'notVisible':
			return 'Not found.';
		case 'operationConflict':
			return 'This operation id was already used with a different answer.';
		default:
			return reply satisfies never;
	}
}

export function adminRefusalWords(reason: ApprovalPersonAdminRefusal): string {
	return reason === 'notPermitted'
		? "Not permitted: answering approvals needs the organization owner's approval:decide."
		: `Central refused (${reason}).`;
}

const credentialRefused = 'Central refused the fleet credential; run fleet-login again.';

/** Runs one approvals command; returns the process exit code. No token or key is printed. */
export async function runApprovalsCommand(props: {
	readonly arguments: readonly string[];
	readonly target: AuthTarget;
	readonly options: ApprovalsCommandOptions;
	readonly environment: FleetCliEnvironment;
}): Promise<number> {
	const parsed = approvalsArgumentsSchema.parse(props.arguments);
	const target = requireFleetTarget(props.target);
	const { environment } = props;
	const { io } = environment;
	const store = environment.store({
		issuer: target.issuer,
		clientId: target.ownerFleetCliClientId,
	});
	const session = await fleetCliSession({ target, store, io });
	const organization = target.organizationId;
	const send = { target, session, io } as const;

	if (parsed[0] === 'list') {
		const outcome = await sendApprovalOperation({
			...send,
			operation: {
				operation: 'ApprovalList',
				organization,
				filter: props.options.all === true ? 'all' : 'waiting',
				cursor:
					props.options.cursor === undefined
						? null
						: approvalRequestIdSchema.parse(props.options.cursor),
			},
		});
		if (outcome.kind !== 'replied') return writeUnanswered(environment, outcome);
		if (outcome.reply.items.length === 0) environment.write('No approval requests.');
		for (const item of outcome.reply.items) environment.write(listedRequestLine(item));
		if (outcome.reply.next !== null)
			environment.write(
				`More: approvals list${props.options.all === true ? ' --all' : ''} --cursor ${outcome.reply.next}`,
			);
		return 0;
	}

	const [command, requestId] = parsed;
	const read = await sendApprovalOperation({
		...send,
		operation: { operation: 'ApprovalRead', organization, requestId },
	});
	if (read.kind !== 'replied') return writeUnanswered(environment, read);
	if (read.reply.kind === 'notVisible') {
		environment.write('Not found.');
		return 2;
	}
	const { view } = read.reply;
	if (command === 'show') {
		environment.write(`${view.requestId}  ${requestKindWords[view.kind]}  ${view.state.kind}`);
		environment.write(JSON.stringify(view));
		return 0;
	}
	if (view.kind !== 'unprovenCall') {
		environment.write(unanswerableWords(view));
		return 2;
	}
	// Minted once for this invocation and reused by its retry; a repeat names it explicitly.
	const operationId =
		props.options['operation-id'] === undefined
			? io.nextId()
			: approvalOperationIdSchema.parse(props.options['operation-id']);
	const decided = await decideApproval({
		...send,
		operation: {
			operation: 'ApprovalDecide',
			organization,
			requestId,
			operationId,
			answer: { kind: 'unprovenCall', decision: command === 'approve' ? 'allow' : 'decline' },
		},
	});
	if (decided.kind === 'unknown') {
		environment.write(
			`Central did not answer. Repeat with --operation-id ${operationId}; it will not be decided twice.`,
		);
		return 1;
	}
	if (decided.kind !== 'replied') return writeUnanswered(environment, decided);
	environment.write(decideReplyWords(decided.reply));
	return decided.reply.kind === 'savedDecision' ? 0 : 2;
}

/**
 * Provider approvals and questions need answers the CLI cannot express yet (which offered
 * option, which field values); nothing is decided for them.
 */
function unanswerableWords(view: ReadView): string {
	return `This request is a ${requestKindWords[view.kind]}; the CLI cannot answer it yet. Nothing was decided.`;
}

function writeUnanswered(
	environment: FleetCliEnvironment,
	outcome:
		| { readonly kind: 'refused'; readonly reason: ApprovalPersonAdminRefusal }
		| { readonly kind: 'unauthenticated' }
		| { readonly kind: 'unknown' },
): number {
	switch (outcome.kind) {
		case 'refused':
			environment.write(adminRefusalWords(outcome.reason));
			return 2;
		case 'unauthenticated':
			environment.write(credentialRefused);
			return 1;
		case 'unknown':
			environment.write('Central did not answer. Repeat the command.');
			return 1;
		default:
			return outcome satisfies never;
	}
}
