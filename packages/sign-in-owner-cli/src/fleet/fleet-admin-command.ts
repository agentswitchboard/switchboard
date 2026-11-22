import {
	fleetAdminIntentDigest,
	fleetAdminRequestBody,
	fleetAdminResultSchemas,
	fleetAdminRoutePaths,
	signFleetAdminProof,
	type FleetAdminRequest,
	type FleetAdminResult,
} from '@agent-collaboration/sign-in-core';

import type { FleetTarget } from '#sign-in-owner-cli/auth-target';
import {
	refreshFleetCli,
	type FleetCliIo,
	type FleetCliSession,
} from '#sign-in-owner-cli/fleet/fleet-credential';
import type { ProofKeyStore } from '#sign-in-owner-cli/fleet/proof-key-store';

/** The sign-in relay for each of central's link-only admin routes. */
const relayPaths = {
	CreateWorkspace: '/api/auth/organization-admin/v1/create-workspace',
	WorkspaceLookup: '/api/auth/organization-admin/v1/workspace-lookup',
	ReadChangeRecords: '/api/auth/organization-admin/v1/change-records',
} as const satisfies Partial<Record<FleetAdminRequest['operation'], string>>;

/** A workspace as central's admin answers name it. */
type FleetAdminWorkspace = Extract<FleetAdminResult, { readonly result: 'applied' }>['workspace'];

export type FleetAdminOutcome =
	| { readonly kind: 'answered'; readonly result: FleetAdminResult }
	/**
	 * Central answered a create `nameInUse`, and one lookup at `workspaceId = operationId` found
	 * this very operation's workspace under the same name: an earlier send of it created the
	 * workspace, past central's replay window (R31). Never inferred from the refusal alone.
	 */
	| { readonly kind: 'created-earlier'; readonly workspace: FleetAdminWorkspace }
	/** Central refused after the confirmation the person declined or could not give. */
	| { readonly kind: 'not-confirmed' }
	| { readonly kind: 'unauthenticated' }
	/** No answer: the same command, with the same operation ID, is safe to repeat. */
	| { readonly kind: 'unknown' };

async function send(props: {
	readonly target: FleetTarget;
	readonly session: FleetCliSession;
	readonly operation: FleetAdminRequest;
	readonly io: FleetCliIo;
}): Promise<FleetAdminOutcome> {
	if (props.operation.operation === 'ListWorkspaces') return { kind: 'unknown' };
	// htu names central's admin endpoint, not this hop.
	const proof = await signFleetAdminProof(props.io.crypto, {
		key: props.session.key,
		htu: `${props.target.centralPublicOrigin}${fleetAdminRoutePaths[props.operation.operation]}`,
		requestId: props.io.nextId(),
		issuedAtSeconds: Math.floor(props.io.now() / 1000),
		bound: {
			accessToken: props.session.accessToken,
			intent: await fleetAdminIntentDigest(props.io.crypto, props.operation),
		},
	});
	let response: Response;
	try {
		response = await props.io.fetch(
			new URL(relayPaths[props.operation.operation], props.target.issuer),
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `DPoP ${props.session.accessToken}`,
					dpop: proof,
				},
				body: JSON.stringify(fleetAdminRequestBody(props.operation)),
			},
		);
	} catch {
		return { kind: 'unknown' };
	}
	if (response.status === 401) return { kind: 'unauthenticated' };
	if (!response.ok) return { kind: 'unknown' };
	const parsed = fleetAdminResultSchemas[props.operation.operation].safeParse(
		await response.json().catch(() => null),
	);
	return parsed.success ? { kind: 'answered', result: parsed.data } : { kind: 'unknown' };
}

interface FleetAdminCommandProps {
	readonly target: FleetTarget;
	readonly store: ProofKeyStore;
	readonly session: FleetCliSession;
	readonly operation: FleetAdminRequest;
	readonly io: FleetCliIo;
	readonly confirmSecondFactor: () => Promise<boolean>;
}

/**
 * One admin command. On `secondFactorRequired` the person confirms in the browser; only after
 * a confirmed step-up does the CLI refresh with the same key (the new token carries the renewed
 * factor) and retry once, with a fresh proof and the same operation and intent. A create
 * answered `nameInUse` runs exactly one lookup at `workspaceId = operationId`; nothing else
 * is retried.
 */
export async function runFleetAdminCommand(
	props: FleetAdminCommandProps,
): Promise<FleetAdminOutcome> {
	const outcome = await sendConfirmingOnce(props);
	const { operation } = props;
	if (
		operation.operation !== 'CreateWorkspace' ||
		outcome.kind !== 'answered' ||
		outcome.result.result !== 'refused' ||
		outcome.result.reason !== 'nameInUse'
	)
		return outcome;
	const lookup = await sendConfirmingOnce({
		...props,
		operation: {
			operation: 'WorkspaceLookup',
			organizationId: operation.organizationId,
			workspaceId: operation.operationId,
		},
	});
	return lookup.kind === 'answered' &&
		lookup.result.result === 'found' &&
		lookup.result.workspace !== null &&
		lookup.result.workspace.name === operation.name
		? { kind: 'created-earlier', workspace: lookup.result.workspace }
		: outcome;
}

async function sendConfirmingOnce(props: FleetAdminCommandProps): Promise<FleetAdminOutcome> {
	const first = await send(props);
	if (
		first.kind !== 'answered' ||
		first.result.result !== 'refused' ||
		first.result.reason !== 'secondFactorRequired'
	)
		return first;
	if (!(await props.confirmSecondFactor())) return { kind: 'not-confirmed' };
	const renewed = await refreshFleetCli(props);
	if (renewed === null) return { kind: 'unauthenticated' };
	return send({ ...props, session: renewed });
}
