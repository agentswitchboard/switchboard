import { isAbsolute } from 'node:path';
import type { Writable } from 'node:stream';

import {
	createSignInStore,
	createCentralLinkClient,
	createMachineLoginDecisionsClient,
	runAuthorizationRevisionBackfill,
	signInConfigurationSchema,
	type SignInClock,
	type SignInDeadlines,
	type SignInObservation,
} from '@agent-collaboration/sign-in-core';
import {
	createSignInHttpHandler,
	createSignInManagementBinding,
	type SignInHttpConfiguration,
} from '@agent-collaboration/sign-in-core/better-auth';
import { createWebSignInCapabilities } from '@agent-collaboration/sign-in-platform-web';
import { z } from 'zod';

import { createCentralUnixTransport } from '#sign-in-host-node/central-unix-transport';
import { createFixedWindowRequestLimiter } from '#sign-in-host-node/fixed-window-request-limiter';
import {
	openNodeSignInDatabase,
	type NodeSignInDatabase,
} from '#sign-in-host-node/sign-in-database';
import {
	startNodeSignInListener,
	type NodeSignInListener,
} from '#sign-in-host-node/sign-in-http-listener';
import { createNodeSignInLogging } from '#sign-in-host-node/sign-in-logging';
import { trustedClientAddressSchema } from '#sign-in-host-node/trusted-client-address';

const providerCredentialsSchema = z.strictObject({
	clientId: z.string().min(1),
	clientSecret: z.string().min(1),
});
export const nodeSignInSettingsSchema = z.strictObject({
	stateDirectory: z.string().min(1),
	centralSocketPath: z
		.string()
		.min(1)
		.refine(isAbsolute, 'Central requires an absolute Unix socket path'),
	hostname: z.string().min(1).default('127.0.0.1'),
	port: z.number().int().min(0).max(65535),
	configuration: signInConfigurationSchema,
	secret: z.string().min(32),
	turnstileSecretKey: z.string().min(1).optional(),
	google: providerCredentialsSchema,
	github: providerCredentialsSchema,
	clientAddress: trustedClientAddressSchema.default({ kind: 'socket-peer' }),
	otlpEndpoint: z.url().optional(),
});
export type NodeSignInSettings = z.infer<typeof nodeSignInSettingsSchema>;

export interface NodeSignInHost extends NodeSignInListener {
	readonly management: ReturnType<typeof createSignInManagementBinding>;
	readonly configuration: SignInHttpConfiguration;
}
export type StartNodeSignInHostResult =
	| { readonly kind: 'started'; readonly host: NodeSignInHost }
	| {
			readonly kind: 'unavailable';
			readonly reason: 'invalid-configuration' | 'database-error' | 'listener-error';
	  };

export function createNodeSignInConfiguration(props: {
	readonly settings: NodeSignInSettings;
	readonly database: NodeSignInDatabase;
	readonly clock?: SignInClock;
	/** Controlled tests fire deadlines themselves; production uses the runtime timer. */
	readonly deadlines?: SignInDeadlines;
	readonly log: (observation: SignInObservation) => void;
}): SignInHttpConfiguration {
	const capabilities = createWebSignInCapabilities(props.clock, props.deadlines);
	const central = createCentralUnixTransport(props.settings.centralSocketPath);
	const platform = {
		...capabilities,
		centralClient: createCentralLinkClient(central),
		requestLimiter: createFixedWindowRequestLimiter(capabilities.clock),
		runAtomically: props.database.runAtomically,
		log: props.log,
	};
	return {
		openDatabase: props.database.openDatabase,
		machineLoginDecisions: createMachineLoginDecisionsClient(central),
		platform,
		store: createSignInStore({
			openDatabase: props.database.openDatabase,
			platform,
			ownerEmail: props.settings.configuration.ownerEmail,
		}),
		configuration: props.settings.configuration,
		secret: props.settings.secret,
		turnstileSecret:
			props.settings.turnstileSecretKey === undefined
				? { kind: 'missing' }
				: { kind: 'configured', secretKey: props.settings.turnstileSecretKey },
		google: props.settings.google,
		github: props.settings.github,
	};
}

export async function startNodeSignInHost(props: {
	readonly settings: unknown;
	readonly clock?: SignInClock;
	readonly deadlines?: SignInDeadlines;
	readonly output?: Writable;
}): Promise<StartNodeSignInHostResult> {
	const parsed = nodeSignInSettingsSchema.safeParse(props.settings);
	if (!parsed.success) return { kind: 'unavailable', reason: 'invalid-configuration' };
	const settings = parsed.data;
	const endpoint = z
		.url()
		.optional()
		.safeParse(settings.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
	if (!endpoint.success) return { kind: 'unavailable', reason: 'invalid-configuration' };
	const opened = await openNodeSignInDatabase({ stateDirectory: settings.stateDirectory });
	if (opened.kind === 'unavailable') return opened;
	const clock = props.clock ?? createWebSignInCapabilities().clock;
	const logging = createNodeSignInLogging({
		clock,
		output: props.output ?? process.stderr,
		endpoint: endpoint.data,
	});
	const configuration = createNodeSignInConfiguration({
		settings,
		database: opened.database,
		clock,
		...(props.deadlines === undefined ? {} : { deadlines: props.deadlines }),
		log: logging.log,
	});
	// Rows that predate the fence tables get their fences before the first request; if this
	// fails, fenced writes for those rows keep failing closed and the next start retries.
	await runAuthorizationRevisionBackfill({
		openDatabase: configuration.openDatabase,
		platform: configuration.platform,
	});
	// After-response drain hints are owned here, so close() waits for them before the database.
	const deferredWork = new Set<Promise<unknown>>();
	function deferAfterResponse(work: Promise<unknown>): void {
		const owned = work
			.catch((): void => undefined)
			.finally((): void => {
				deferredWork.delete(owned);
			});
		deferredWork.add(owned);
	}
	const started = await startNodeSignInListener({
		hostname: settings.hostname,
		port: settings.port,
		issuer: settings.configuration.issuer,
		clientAddress: settings.clientAddress,
		handle: createSignInHttpHandler(configuration, { deferAfterResponse }),
		logging,
	});
	if (started.kind === 'unavailable') {
		opened.database.close();
		await logging.close();
		return started;
	}
	// No timers (owner, 9 and 12 Nov): each Fleet call's guard renews the stamp and drains a
	// revision hint lost to a crash or a lost ACK before the call goes out.
	let closing: Promise<void> | undefined;
	return {
		kind: 'started',
		host: {
			address: started.listener.address,
			configuration,
			management: createSignInManagementBinding(configuration),
			close(): Promise<void> {
				closing ??= (async (): Promise<void> => {
					await started.listener.close();
					await Promise.all(deferredWork);
					opened.database.close();
					await logging.close();
				})();
				return closing;
			},
		},
	};
}
