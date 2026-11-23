import {
	signInConfigurationSchema,
	createSignInStore,
	createCentralLinkClient,
	createMachineLoginDecisionsClient,
	type SignInObservation,
} from '@agent-collaboration/sign-in-core';
import type { SignInHttpConfiguration } from '@agent-collaboration/sign-in-core/better-auth';
import { createWebSignInCapabilities } from '@agent-collaboration/sign-in-platform-web';
import { z } from 'zod';

import { createBindingRequestLimiter } from '#sign-in-host-cloudflare/binding-request-limiter';
import {
	openSignInDatabase,
	createD1AtomicRunner,
} from '#sign-in-host-cloudflare/sign-in-database';

/** Deployment facts come only from the generated Env's protected bindings. */
export function signInWorkerConfiguration(bindings: AuthWorkerEnv): SignInHttpConfiguration {
	const configuration = signInConfigurationSchema.parse(JSON.parse(bindings.SIGN_IN_CONFIGURATION));
	const turnstileSecret = z
		.object({ TURNSTILE_SECRET_KEY: z.string().optional() })
		.parse(bindings).TURNSTILE_SECRET_KEY;
	const openDatabase: SignInHttpConfiguration['openDatabase'] = () =>
		openSignInDatabase(bindings.DB);
	const central = {
		fetch: (request: Request): Promise<Response> => bindings.CENTRAL.fetch(request),
	};
	const platform = {
		...createWebSignInCapabilities(),
		centralClient: createCentralLinkClient(central),
		requestLimiter: createBindingRequestLimiter({
			signInAttempts: bindings.SIGN_IN_ATTEMPTS,
			authRequests: bindings.AUTH_REQUESTS,
		}),
		runAtomically: createD1AtomicRunner(bindings.DB),
		log(observation: SignInObservation): void {
			try {
				console.log(JSON.stringify(observation));
			} catch {
				// A failed host log sink cannot change the authentication decision.
			}
		},
	};
	return {
		openDatabase,
		machineLoginDecisions: createMachineLoginDecisionsClient(central),
		platform,
		store: createSignInStore({ openDatabase, platform, ownerEmail: configuration.ownerEmail }),
		configuration,
		secret: z.string().min(32).parse(bindings.AUTH_SECRET),
		turnstileSecret:
			turnstileSecret === undefined || turnstileSecret.length === 0
				? { kind: 'missing' }
				: { kind: 'configured', secretKey: turnstileSecret },
		google: {
			clientId: z.string().min(1).parse(bindings.GOOGLE_CLIENT_ID),
			clientSecret: z.string().min(1).parse(bindings.GOOGLE_CLIENT_SECRET),
		},
		github: {
			clientId: z.string().min(1).parse(bindings.GITHUB_CLIENT_ID),
			clientSecret: z.string().min(1).parse(bindings.GITHUB_CLIENT_SECRET),
		},
	};
}

/** The fetch handler's own request preparation, for proof bundles that compose the same path. */
export { workerClientAddressHeaders } from '#sign-in-host-cloudflare/worker-client-address';
