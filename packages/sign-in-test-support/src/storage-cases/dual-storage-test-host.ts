import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Miniflare, type WorkerOptions } from 'miniflare';
import { z } from 'zod';

import { openSqliteStorageTestHost } from '#sign-in-test-support/storage-cases/sqlite-storage-test-host';
import { captureStorageCase } from '#sign-in-test-support/storage-cases/storage-case-errors';
import {
	executeStorageCommand,
	type StorageCommand,
} from '#sign-in-test-support/storage-cases/storage-commands';
import { buildStorageProofApplication } from '#sign-in-test-support/storage-cases/storage-proof-application';
import { prepareBaselineMigrations } from '#sign-in-test-support/test-fixtures/baseline-migrations';
import { controlledWorkerDateScript } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import {
	applyLocalSignInMigrations,
	localSignInDatabaseId,
} from '#sign-in-test-support/test-fixtures/local-d1-migrations';
import { proofModuleHashes } from '#sign-in-test-support/test-fixtures/proof-bundle-artifacts';
import { loadProofRateLimitBindings } from '#sign-in-test-support/test-fixtures/proof-rate-limit-bindings';
import {
	turnstileTestSecret,
	turnstileTestSiteKey,
} from '#sign-in-test-support/test-fixtures/turnstile-test-keys';
import {
	clockedWorkerManifest,
	proofStartupModuleSource,
} from '#sign-in-test-support/test-fixtures/worker-module-manifest';

export type StorageTestLeg = 'd1-workerd' | 'better-sqlite3';
export interface StorageTestHost {
	readonly runCase: (name: string) => Promise<unknown>;
	readonly runCommand: (command: StorageCommand) => Promise<unknown>;
	readonly restart: () => Promise<void>;
	readonly upgrade: () => Promise<void>;
	readonly close: () => Promise<void>;
}
export async function createStorageTestHost(
	leg: StorageTestLeg,
	mode: 'migrated' | 'unmigrated' | 'baseline' | 'before-machine-login' = 'migrated',
): Promise<StorageTestHost> {
	const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
	const proofRateLimitBindings = await loadProofRateLimitBindings(repositoryRoot);
	const runtimeDirectory = await mkdtemp(path.join(tmpdir(), '2026-10-sign-in-storage-'));
	const currentFolder = path.join(repositoryRoot, 'packages/sign-in-core/drizzle');
	const migrationsFolder =
		mode === 'baseline' || mode === 'before-machine-login'
			? await prepareBaselineMigrations({
					currentFolder,
					runtimeDirectory,
					...(mode === 'before-machine-login' ? { through: '0004_organization_stamp_record' } : {}),
				})
			: currentFolder;
	if (leg === 'better-sqlite3') {
		const options = {
			databaseFile: path.join(runtimeDirectory, 'sign-in.sqlite'),
			migrationsFolder,
			migrateBeforeServing: mode !== 'unmigrated',
		};
		let host = await openSqliteStorageTestHost(options);
		async function runNodeCommand(command: StorageCommand): Promise<unknown> {
			const result = await captureStorageCase(() => executeStorageCommand(host.context, command));
			if (result.kind === 'case-error') throw new Error(result.message);
			return result.value;
		}
		return {
			runCommand: runNodeCommand,
			runCase: (name) => runNodeCommand({ kind: 'case', name }),
			restart: async () => {
				host.close();
				host = await openSqliteStorageTestHost(options);
			},
			async upgrade(): Promise<void> {
				host.close();
				options.migrationsFolder = currentFolder;
				options.migrateBeforeServing = true;
				host = await openSqliteStorageTestHost(options);
			},
			close: async () => host.close(),
		};
	}
	const resourcePersistencePath =
		mode !== 'unmigrated'
			? await applyLocalSignInMigrations({ repositoryRoot, runtimeDirectory, migrationsFolder })
			: path.join(runtimeDirectory, 'state', 'v3');
	const application = await buildStorageProofApplication(repositoryRoot);
	const configuration = {
		issuer: 'https://storage-sign-in.invalid',
		mode: 'private',
		ownerEmail: 'storage-owner@example.invalid',
		toolPortalOrigin: 'https://storage-portal.invalid',
		managementAudience: 'https://storage-portal.invalid/management',
		centralIdentityAudience: 'https://central.example.invalid/identity',
		centralAdminAudience: 'https://central.example.invalid/admin',
		centralPersonLinkAudience: 'https://central.example.invalid/person-link',
		centralPublicOrigin: 'https://central.example.invalid',
		adminPageClientId: 'admin-page-local',
		ownerFleetCliClientId: 'owner-fleet-cli-local',
		organizationStatementLifetimeSeconds: 10_368_000,
		organizationIds: ['11111111-1111-7111-8111-111111111111'],
		ownerCliClientId: 'storage-owner-cli',
		ownerCliRedirectUri: 'http://127.0.0.1/callback',
		accessTokenSeconds: 300,
		managementHumanCheck: 'remembered-login',
		turnstile: { kind: 'deployed', siteKey: turnstileTestSiteKey },
	};
	const textBindings = {
		SIGN_IN_CONFIGURATION: JSON.stringify(configuration),
		AUTH_SECRET: 'test-only-storage-secret-'.repeat(3),
		TURNSTILE_SECRET_KEY: turnstileTestSecret,
		GOOGLE_CLIENT_ID: 'fixture-google',
		GOOGLE_CLIENT_SECRET: 'fixture-google-secret',
		GITHUB_CLIENT_ID: 'fixture-github',
		GITHUB_CLIENT_SECRET: 'fixture-github-secret',
	};
	const workerOptions: WorkerOptions = {
		config: {
			type: 'worker',
			name: 'storage-proof',
			manifest: clockedWorkerManifest({
				kind: 'storage-proof',
				startup: proofStartupModuleSource,
				application,
				clock: controlledWorkerDateScript(),
			}),
			compatibilityDate: '2026-08-15',
			compatibilityFlags: ['nodejs_compat'],
			env: {
				DB: { type: 'd1', id: localSignInDatabaseId },
				...proofRateLimitBindings,
				...Object.fromEntries(
					Object.entries(textBindings).map(([key, value]) => [key, { type: 'text', value }]),
				),
			},
		},
	};
	// Bind storage-mutant observations to the actual source-bundled Worker bytes.
	// This is separate from the production HTTP harness's seven-artifact manifest.
	process.stdout.write(
		JSON.stringify({
			event: 'storage-worker-modules',
			moduleHashes: proofModuleHashes(workerOptions.config?.manifest),
		}) + '\n',
	);
	function openRuntime(): Miniflare {
		return new Miniflare({
			resourcePersistencePath,
			telemetry: { enabled: false },
			logRequests: false,
			workers: [workerOptions],
		});
	}
	let runtime = openRuntime();
	await runtime.ready;
	let worker = await runtime.getWorker('storage-proof');
	async function runCommand(command: StorageCommand): Promise<unknown> {
		const response = await worker.fetch('https://storage-proof.invalid/case', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(command),
		});
		const result = z
			.discriminatedUnion('kind', [
				z.object({ kind: z.literal('result'), value: z.unknown() }),
				z.object({ kind: z.literal('case-error'), message: z.string() }),
			])
			.parse(await response.json());
		if (result.kind === 'case-error') throw new Error(result.message);
		return result.value;
	}
	return {
		runCommand,
		runCase: (name) => runCommand({ kind: 'case', name }),
		async restart(): Promise<void> {
			await runtime.dispose();
			runtime = openRuntime();
			await runtime.ready;
			worker = await runtime.getWorker('storage-proof');
		},
		async upgrade(): Promise<void> {
			await runtime.dispose();
			await applyLocalSignInMigrations({
				repositoryRoot,
				runtimeDirectory,
				migrationsFolder: currentFolder,
			});
			runtime = openRuntime();
			await runtime.ready;
			worker = await runtime.getWorker('storage-proof');
		},
		close: () => runtime.dispose(),
	};
}
