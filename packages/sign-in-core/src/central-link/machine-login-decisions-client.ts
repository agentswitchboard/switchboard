import type { z } from 'zod';

import type { CentralTransport } from '#sign-in-core/central-link/central-transport';
import type {
	DecideDeviceLogin_Deserialize,
	DecideMachineToken,
} from '#sign-in-core/central-link/generated/central-sign-in.gen';
import {
	decideDeviceLoginSchema,
	decideMachineTokenSchema,
	deviceLoginDecisionSchema,
	machineTokenDecisionSchema,
	type MachineDecisionOptions,
	type MachineDecisionReply,
	type MachineLoginDecisions,
} from '#sign-in-core/machine-login/machine-login-contracts';

// Central: codex-router `organization_signin_http.rs`. Each route answers 200 with the decision,
// 503 when its port fails, and 400 for a body it cannot read.
const deviceLoginRoute = 'http://central.invalid/internal/device-login-decisions';
const machineTokenRoute = 'http://central.invalid/internal/machine-token-decisions';

/** Sends each machine decision once over the private link; only a parsed 200 is an answer. */
export function createMachineLoginDecisionsClient(
	transport: CentralTransport,
): MachineLoginDecisions {
	return {
		decideDeviceLogin: async (request, options) =>
			decide(
				transport,
				deviceLoginRoute,
				decideDeviceLoginSchema.parse(request) satisfies DecideDeviceLogin_Deserialize,
				deviceLoginDecisionSchema,
				options,
			),
		decideMachineToken: async (request, options) =>
			decide(
				transport,
				machineTokenRoute,
				decideMachineTokenSchema.parse(request) satisfies DecideMachineToken,
				machineTokenDecisionSchema,
				options,
			),
	};
}

async function decide<TDecision>(
	transport: CentralTransport,
	route: string,
	body: unknown,
	decisionSchema: z.ZodType<TDecision>,
	options: MachineDecisionOptions | undefined,
): Promise<MachineDecisionReply<TDecision>> {
	let response: Response;
	try {
		response = await transport.fetch(
			new Request(route, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				...(options?.signal === undefined ? {} : { signal: options.signal }),
			}),
		);
	} catch (error) {
		return {
			kind: 'unavailable',
			reason: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unavailable',
		};
	}
	if (response.status === 503) return { kind: 'answered-unavailable' };
	if (response.status !== 200) return { kind: 'unavailable', reason: 'unavailable' };
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return { kind: 'unavailable', reason: 'malformed-reply' };
	}
	const decision = decisionSchema.safeParse(payload);
	return decision.success
		? { kind: 'answered', decision: decision.data }
		: { kind: 'unavailable', reason: 'malformed-reply' };
}
