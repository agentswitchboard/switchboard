import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Response as WorkerResponse, type WorkerOptions } from 'miniflare';
import { z } from 'zod';

import { assertB3CentralWorkerProofArtifacts } from '#sign-in-test-support/test-fixtures/b3-central-proof-pin';
import {
	textBindings,
	type WorkerdCentralRuntime,
} from '#sign-in-test-support/test-fixtures/local-auth-harness';

export const workspaceListPath = '/organization-admin/v1/list-workspaces';
export const deviceDecisionPath = '/internal/device-login-decisions';
const observedCentralReplySchema = z.strictObject({
	path: z.enum([workspaceListPath, deviceDecisionPath]),
	status: z.number().int(),
	body: z.unknown(),
});
export type ObservedCentralReply = z.infer<typeof observedCentralReplySchema>;

async function centralBundle(
	checkout: string,
	build: 'build' | 'build-link',
): Promise<NonNullable<WorkerOptions['config']['manifest']>> {
	const directory = join(checkout, 'crates/collaboration-central-cloudflare', build);
	const [script, wasm] = await Promise.all([
		readFile(join(directory, 'index.js'), 'utf8'),
		readFile(join(directory, 'index_bg.wasm')),
	]);
	return {
		mainModule: 'index.js',
		modules: {
			'index.js': { type: 'esm', contents: script },
			'index_bg.wasm': { type: 'wasm', contents: new Uint8Array(wasm) },
		},
	};
}

export async function centralProductionWorkers(props: {
	readonly checkout: string;
	readonly readJwks: () => Promise<string>;
	readonly observe?: (reply: ObservedCentralReply) => void;
	readonly trust: {
		readonly issuer: string;
		readonly audience: string;
		readonly adminAudience: string;
		readonly machineAudience: string;
		readonly publicOrigin: string;
		readonly serviceId: string;
	};
}): Promise<WorkerdCentralRuntime> {
	const {
		checkout,
		readJwks,
		trust: { issuer, audience, adminAudience, machineAudience, publicOrigin, serviceId },
	} = props;
	await assertB3CentralWorkerProofArtifacts(checkout);
	const storageName = 'central-production-storage';
	const privateName = 'central-production-link';
	const jwksUrl = `${issuer}/api/auth/jwks`;
	const binding = {
		type: 'durable-object',
		workerName: storageName,
		exportName: 'CentralObject',
	} as const;
	const bindings = textBindings({
		CENTRAL_SIGN_IN_ISSUER: issuer,
		CENTRAL_SIGN_IN_AUDIENCE: audience,
		CENTRAL_SIGN_IN_JWKS_URL: jwksUrl,
		CENTRAL_ADMIN_AUDIENCE: adminAudience,
		CENTRAL_MACHINE_AUDIENCE: machineAudience,
		CENTRAL_PUBLIC_ORIGIN: publicOrigin,
		CENTRAL_SIGN_IN_SERVICE_ID: serviceId,
	});
	const [storage, link] = await Promise.all([
		centralBundle(checkout, 'build'),
		centralBundle(checkout, 'build-link'),
	]);
	const observationName = 'central-production-observer';
	const observe = props.observe;
	const observationWorker: WorkerOptions | undefined =
		observe === undefined
			? undefined
			: {
					config: {
						type: 'worker',
						name: observationName,
						compatibilityDate: '2026-08-21',
						manifest: {
							mainModule: 'observer.mjs',
							modules: {
								'observer.mjs': {
									type: 'esm',
									contents: `
				export default { async fetch(request, env) {
					const response = await env.UPSTREAM.fetch(request);
					const path = new URL(request.url).pathname;
					if (path === '${workspaceListPath}' || path === '${deviceDecisionPath}') {
						const body = await response.clone().json().catch(() => null);
						await env.OBSERVE.fetch('http://observe.invalid', {
							method: 'POST', body: JSON.stringify({ path, status: response.status, body }),
						});
					}
					return response;
				} };
			`,
								},
							},
						},
						env: {
							UPSTREAM: { type: 'worker', workerName: privateName },
							OBSERVE: {
								type: 'fetcher',
								async handler(request): Promise<WorkerResponse> {
									observe(observedCentralReplySchema.parse(await request.json()));
									return new WorkerResponse(null, { status: 204 });
								},
							},
						},
					},
				};
	return {
		centralBinding: {
			type: 'worker',
			workerName: observationWorker === undefined ? privateName : observationName,
		},
		...(observationWorker === undefined ? {} : { observationWorker }),
		storageWorker: {
			config: {
				type: 'worker',
				name: storageName,
				compatibilityDate: '2026-08-21',
				manifest: storage,
				env: {
					...bindings,
					CENTRAL: binding,
					WORKSPACE_STORE: { ...binding, exportName: 'WorkspaceStoreObject' },
				},
				exports: {
					CentralObject: { type: 'durable-object', storage: 'sqlite' },
					WorkspaceStoreObject: { type: 'durable-object', storage: 'sqlite' },
				},
			},
			dev: {
				outboundService: {
					type: 'fetcher',
					handler: async (request): Promise<WorkerResponse> =>
						request.method === 'GET' && request.url === jwksUrl
							? new WorkerResponse(await readJwks(), {
									headers: { 'content-type': 'application/json' },
								})
							: new WorkerResponse(null, { status: 502 }),
				},
			},
		},
		privateWorker: {
			config: {
				type: 'worker',
				name: privateName,
				compatibilityDate: '2026-08-21',
				manifest: link,
				env: { ...bindings, CENTRAL: binding },
			},
		},
	};
}
