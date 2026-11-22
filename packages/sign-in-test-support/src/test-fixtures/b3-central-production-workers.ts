import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Response as WorkerResponse, type WorkerOptions } from 'miniflare';

import { assertB3CentralWorkerProofArtifacts } from '#sign-in-test-support/test-fixtures/b3-central-proof-pin';
import {
	textBindings,
	type WorkerdCentralRuntime,
} from '#sign-in-test-support/test-fixtures/local-auth-harness';

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
	readonly jwksBody: string;
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
		jwksBody,
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
	return {
		centralBinding: { type: 'worker', workerName: privateName },
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
							? new WorkerResponse(jwksBody, { headers: { 'content-type': 'application/json' } })
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
