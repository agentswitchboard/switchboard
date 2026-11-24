import type { z } from 'zod';

import {
	fleetAdminResultSchemas,
	type FleetAdminRefusalReason,
} from '#sign-in-core/central-link/fleet-admin-client';
import { fleetAdminForwardingPaths } from '#sign-in-core/contracts/fleet-admin-wire';
import { fleetAdminCreateWords } from '#sign-in-core/organizations/fleet-admin-create-words';

type RefusedReply = { readonly result: 'refused'; readonly reason: FleetAdminRefusalReason };

/** One forwarded admin request as a page can act on it. */
export type ForwardedAdminOutcome<TAnswer> =
	| { readonly kind: 'answered'; readonly result: TAnswer }
	| { readonly kind: 'refused'; readonly reason: FleetAdminRefusalReason }
	/** Central needs a recent second-factor confirmation before it acts. */
	| { readonly kind: 'confirm-again' }
	| { readonly kind: 'unavailable' };

export type CreateWorkspaceReply = Exclude<
	z.output<typeof fleetAdminResultSchemas.CreateWorkspace>,
	RefusedReply
>;
export type WorkspaceLookupReply = Exclude<
	z.output<typeof fleetAdminResultSchemas.WorkspaceLookup>,
	RefusedReply
>;
export type ChangeRecordsReply = Exclude<
	z.output<typeof fleetAdminResultSchemas.ReadChangeRecords>,
	RefusedReply
>;
export type ChangeRecord = ChangeRecordsReply['records'][number];

export type SendForwardedRequest = (path: string, body: object) => Promise<Response>;

/** The page's own same-origin POST; the server signs central's request. */
export const sendForwardedRequest: SendForwardedRequest = (path, body) =>
	fetch(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});

function refusedOutcome(reason: FleetAdminRefusalReason): ForwardedAdminOutcome<never> {
	return reason === 'secondFactorRequired'
		? { kind: 'confirm-again' }
		: { kind: 'refused', reason };
}

async function replyBody(response: Response): Promise<unknown> {
	return response.ok ? response.json().catch(() => null) : null;
}

export async function createWorkspace(
	request: {
		readonly organizationId: string;
		readonly operationId: string;
		readonly name: string;
		readonly description: string;
	},
	send: SendForwardedRequest = sendForwardedRequest,
): Promise<ForwardedAdminOutcome<CreateWorkspaceReply>> {
	try {
		const body = await replyBody(await send(fleetAdminForwardingPaths.CreateWorkspace, request));
		const parsed = fleetAdminResultSchemas.CreateWorkspace.safeParse(body);
		if (!parsed.success) return { kind: 'unavailable' };
		return parsed.data.result === 'refused'
			? refusedOutcome(parsed.data.reason)
			: { kind: 'answered', result: parsed.data };
	} catch {
		return { kind: 'unavailable' };
	}
}

export async function lookUpWorkspace(
	request: { readonly organizationId: string; readonly workspaceId: string },
	send: SendForwardedRequest = sendForwardedRequest,
): Promise<ForwardedAdminOutcome<WorkspaceLookupReply>> {
	try {
		const body = await replyBody(await send(fleetAdminForwardingPaths.WorkspaceLookup, request));
		const parsed = fleetAdminResultSchemas.WorkspaceLookup.safeParse(body);
		if (!parsed.success) return { kind: 'unavailable' };
		return parsed.data.result === 'refused'
			? refusedOutcome(parsed.data.reason)
			: { kind: 'answered', result: parsed.data };
	} catch {
		return { kind: 'unavailable' };
	}
}

export async function readChangeRecords(
	request: { readonly organizationId: string },
	send: SendForwardedRequest = sendForwardedRequest,
): Promise<ForwardedAdminOutcome<ChangeRecordsReply>> {
	try {
		const body = await replyBody(
			await send(fleetAdminForwardingPaths.ReadChangeRecords, {
				organizationId: request.organizationId,
				after: null,
				limit: 100,
			}),
		);
		const parsed = fleetAdminResultSchemas.ReadChangeRecords.safeParse(body);
		if (!parsed.success) return { kind: 'unavailable' };
		return parsed.data.result === 'refused'
			? refusedOutcome(parsed.data.reason)
			: { kind: 'answered', result: parsed.data };
	} catch {
		return { kind: 'unavailable' };
	}
}

/** A fresh UUIDv7: central's ledger key for a corrected create after it answered the old one. */
export function freshOperationId(
	random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (bytes) =>
		crypto.getRandomValues(bytes),
	now: () => number = Date.now,
): string {
	const bytes = random(new Uint8Array(16));
	let time = now();
	for (let index = 5; index >= 0; index -= 1) {
		bytes[index] = time % 256;
		time = Math.floor(time / 256);
	}
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface ChangeRecordRow {
	readonly id: string;
	readonly when: string;
	readonly change: string;
	readonly subject: string;
	readonly origin: string;
}

/** What each column of the change-records table says about one record. */
export function describeChangeRecord(record: ChangeRecord): ChangeRecordRow {
	const origin =
		record.origin.kind === 'person'
			? `${record.origin.personId} (${record.origin.permissionChecked})`
			: record.origin.kind === 'automatic'
				? 'Central, automatically'
				: 'Sign-in';
	return {
		id: record.id,
		when: new Date(record.createdAtMillis).toISOString(),
		change: record.kind,
		subject:
			record.kind === 'machineAllowanceChanged'
				? `${record.machineId} in ${record.workspaceId} (${record.state})`
				: record.targetId,
		origin,
	};
}

/** What one press of Create led to, after any lookup it needed. */
export type WorkspaceCreateResult =
	| { readonly kind: 'created' }
	| { readonly kind: 'confirm-again' }
	| { readonly kind: 'not-created'; readonly message: string };

/**
 * One create, with the owner CLI's outcomes. An answered create is created. A name in use is
 * first checked against this operation's own workspace: an earlier send may have created it.
 * After central answered a name in use or a conflict, the next try gets a fresh operation ID,
 * since a corrected request under the same ID is a conflict by design. A second-factor request
 * asks for confirmation once; after a confirmation it is reported instead.
 */
export async function submitWorkspaceCreate(props: {
	readonly organizationId: string;
	/** This page's operation ID, replaced here when central has answered the old one. */
	readonly operationId: { current: string };
	readonly request: { readonly name: string; readonly description: string };
	readonly confirmedAlready: boolean;
	readonly send?: SendForwardedRequest;
	readonly mintOperationId?: () => string;
}): Promise<WorkspaceCreateResult> {
	const send = props.send ?? sendForwardedRequest;
	const mint = props.mintOperationId ?? ((): string => freshOperationId());
	const created = await createWorkspace(
		{
			organizationId: props.organizationId,
			operationId: props.operationId.current,
			...props.request,
		},
		send,
	);
	switch (created.kind) {
		case 'answered':
			return { kind: 'created' };
		case 'confirm-again':
			return props.confirmedAlready
				? { kind: 'not-created', message: 'Not confirmed; nothing was sent.' }
				: { kind: 'confirm-again' };
		case 'unavailable':
			return { kind: 'not-created', message: 'Central is unavailable. Try again.' };
		case 'refused': {
			if (created.reason === 'nameInUse') {
				const own = await lookUpWorkspace(
					{ organizationId: props.organizationId, workspaceId: props.operationId.current },
					send,
				);
				if (own.kind === 'answered' && own.result.workspace?.name === props.request.name)
					return { kind: 'created' };
				props.operationId.current = mint();
				return { kind: 'not-created', message: fleetAdminCreateWords.nameInUse };
			}
			if (created.reason === 'conflict') {
				props.operationId.current = mint();
				return { kind: 'not-created', message: fleetAdminCreateWords.conflict };
			}
			return { kind: 'not-created', message: `Central refused: ${created.reason}` };
		}
		default:
			return created satisfies never;
	}
}

/** What one Try again on Fleet setup led to, as the page says it. */
export type OrganizationSetupRetry =
	| { readonly kind: 'ready' }
	| { readonly kind: 'still-setting-up'; readonly message: string }
	| { readonly kind: 'unreachable'; readonly message: string };

export const organizationSetupRetryMessages = {
	stillSettingUp:
		"Switchboard still hasn't finished setting up your organization. Try again shortly.",
	unreachable: "Switchboard couldn't be reached. Try again shortly.",
} as const;

/** Asks sign-in to retry the organization's Fleet setup; only a confirmed answer is ready. */
export async function retryOrganizationSetup(
	organizationId: string,
	send: SendForwardedRequest = sendForwardedRequest,
): Promise<OrganizationSetupRetry> {
	try {
		const response = await send('/api/auth/organization/retry-provisioning', { organizationId });
		const result: unknown = await response.json().catch(() => null);
		return response.ok &&
			typeof result === 'object' &&
			result !== null &&
			'kind' in result &&
			result.kind === 'ready'
			? { kind: 'ready' }
			: { kind: 'still-setting-up', message: organizationSetupRetryMessages.stillSettingUp };
	} catch {
		return { kind: 'unreachable', message: organizationSetupRetryMessages.unreachable };
	}
}
