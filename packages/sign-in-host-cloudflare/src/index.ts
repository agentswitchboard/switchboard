/// <reference types="../worker-configuration.gen.d.ts" preserve="true" />

import { runAuthorizationRevisionBackfill } from '@agent-collaboration/sign-in-core';
import {
	createSignInHttpHandler,
	createSignInManagementBinding,
	readSignInJwksResponse,
} from '@agent-collaboration/sign-in-core/better-auth';
import { WorkerEntrypoint } from 'cloudflare:workers';

import { workerClientAddressHeaders } from '#sign-in-host-cloudflare/worker-client-address';
import { signInWorkerConfiguration } from '#sign-in-host-cloudflare/worker-configuration';
import { forwardWorkerMachineLink } from '#sign-in-host-cloudflare/worker-machine-link';

/** Only the named service binding can reach agent management; the public fetch handler exposes no RPC route. */
export class AgentClientManagement extends WorkerEntrypoint<AuthWorkerEnv> {
	/** Option D's deploy step: run once right after each deploy. There is no cron (owner, 12 Nov);
	 * a fenced write that meets a missing fence backfills its own organizations and retries once. */
	async backfillAuthorizationRevisions(): ReturnType<typeof runAuthorizationRevisionBackfill> {
		const configuration = signInWorkerConfiguration(this.env);
		return runAuthorizationRevisionBackfill({
			openDatabase: configuration.openDatabase,
			platform: configuration.platform,
		});
	}
	async humanCheckStatus(): ReturnType<
		ReturnType<typeof createSignInManagementBinding>['humanCheckStatus']
	> {
		return createSignInManagementBinding(signInWorkerConfiguration(this.env)).humanCheckStatus();
	}
	async isLiveOwner(props: {
		readonly token: string;
		readonly organizationId: string;
	}): Promise<boolean> {
		return createSignInManagementBinding(signInWorkerConfiguration(this.env)).isLiveOwner(props);
	}

	async ownsAgentClient(props: {
		readonly token: string;
		readonly organizationId: string;
		readonly clientId: string;
	}): Promise<boolean> {
		return createSignInManagementBinding(signInWorkerConfiguration(this.env)).ownsAgentClient(
			props,
		);
	}

	async registerAndLink(
		props: Parameters<ReturnType<typeof createSignInManagementBinding>['registerAndLink']>[0],
	): ReturnType<ReturnType<typeof createSignInManagementBinding>['registerAndLink']> {
		return createSignInManagementBinding(signInWorkerConfiguration(this.env)).registerAndLink(
			props,
		);
	}
	async link(
		props: Parameters<ReturnType<typeof createSignInManagementBinding>['link']>[0],
	): ReturnType<ReturnType<typeof createSignInManagementBinding>['link']> {
		return createSignInManagementBinding(signInWorkerConfiguration(this.env)).link(props);
	}
	async unlink(
		props: Parameters<ReturnType<typeof createSignInManagementBinding>['unlink']>[0],
	): ReturnType<ReturnType<typeof createSignInManagementBinding>['unlink']> {
		return createSignInManagementBinding(signInWorkerConfiguration(this.env)).unlink(props);
	}
	async disable(
		props: Parameters<ReturnType<typeof createSignInManagementBinding>['disable']>[0],
	): ReturnType<ReturnType<typeof createSignInManagementBinding>['disable']> {
		return createSignInManagementBinding(signInWorkerConfiguration(this.env)).disable(props);
	}
}

export class SignInJwks extends WorkerEntrypoint<AuthWorkerEnv> {
	override async fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname !== '/api/auth/jwks')
			return new Response(null, { status: 404 });
		if (request.method !== 'GET')
			return new Response(null, { status: 405, headers: { allow: 'GET' } });
		return readSignInJwksResponse(signInWorkerConfiguration(this.env));
	}
}

export default {
	async fetch(
		request: Request,
		bindings: AuthWorkerEnv,
		context: Pick<ExecutionContext, 'waitUntil'>,
	): Promise<Response> {
		try {
			const machineLink = forwardWorkerMachineLink(request, bindings);
			if (machineLink !== undefined) return await machineLink;
			return await createSignInHttpHandler(signInWorkerConfiguration(bindings), {
				// A committed fence change drains after the response; a lost hint drains on the next Fleet call.
				deferAfterResponse: (work: Promise<unknown>): void => context.waitUntil(work),
			})(new Request(request, { headers: workerClientAddressHeaders(request.headers) }), {
				// C8: a person's link goes over the same binding as a Mac's; sign-in never reads a frame.
				forwardPersonLink: (upstream: Request): Promise<Response> =>
					bindings.CENTRAL_LINK.fetch(upstream),
			});
		} catch {
			return Response.json({ error: 'sign-in-unavailable' }, { status: 503 });
		}
	},
};
