import type {
	MachineDecisionOptions,
	MachineDecisionReply,
	MachineLoginDecisions,
} from '#sign-in-core/machine-login/machine-login-contracts';
import type { RunOrganizationFleetCall } from '#sign-in-core/organizations/organization-fleet-call';

/**
 * WS4 (Lead, 13 Nov): each machine decision is a sign-in to Fleet call, so it runs through the
 * organization's guard run like every other one: the stamp step and pending revisions first
 * (D7 budget, Q1 = A), and after central's own 503 the probe, recovery and one retry
 * (R-notdue, R-push503). A call the guard keeps back answers unavailable, as before.
 */
export function guardMachineLoginDecisions(props: {
	readonly decisions: MachineLoginDecisions;
	readonly runFleetCall: RunOrganizationFleetCall;
}): MachineLoginDecisions {
	async function guarded<TDecision>(
		organizationId: string,
		send: (options: MachineDecisionOptions) => Promise<MachineDecisionReply<TDecision>>,
	): Promise<MachineDecisionReply<TDecision>> {
		const run = await props.runFleetCall<MachineDecisionReply<TDecision>>({
			organizationId,
			// R-retrysignal: only the retry carries the run's deadline to the link.
			send: async (retry) => send(retry === null ? {} : { signal: retry.signal }),
			answeredUnavailable: (reply) => reply.kind === 'answered-unavailable',
			atDeadline: { kind: 'unavailable', reason: 'timeout' },
		});
		return run.kind === 'held' ? { kind: 'unavailable', reason: 'unavailable' } : run.answer;
	}
	return {
		decideDeviceLogin: async (request) =>
			guarded(request.organizationId, async (options) =>
				props.decisions.decideDeviceLogin(request, options),
			),
		decideMachineToken: async (request) =>
			guarded(request.organizationId, async (options) =>
				props.decisions.decideMachineToken(request, options),
			),
	};
}
