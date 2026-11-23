import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import {
	assertB3CentralNativeProofArtifact,
	type CentralNativeProofPin,
} from '#sign-in-test-support/test-fixtures/b3-central-proof-pin';

export const b3CentralPublicOrigin = 'https://central.example.invalid';
export const b3CentralServiceId = '019f0000-0000-7000-8000-00000000d209';

export function b3CentralTrust(issuer: string): {
	readonly issuer: string;
	readonly audience: string;
	readonly adminAudience: string;
	readonly machineAudience: string;
	readonly publicOrigin: string;
	readonly serviceId: string;
} {
	return {
		issuer,
		audience: `${b3CentralPublicOrigin}/identity`,
		adminAudience: `${b3CentralPublicOrigin}/admin`,
		machineAudience: `${b3CentralPublicOrigin}/machine`,
		publicOrigin: b3CentralPublicOrigin,
		serviceId: b3CentralServiceId,
	};
}

export async function startB3CentralTokio(props: {
	readonly executable: string;
	readonly issuer: string;
	readonly jwksUrl: string;
	/** The build this run must be; the B3 pin unless a proof names another. */
	readonly pin?: CentralNativeProofPin;
}): Promise<{
	readonly tcp: URL;
	readonly socketPath: string;
	readonly close: () => Promise<void>;
}> {
	await assertB3CentralNativeProofArtifact(props.executable, props.pin);
	const root = await mkdtemp('/tmp/b3-central-join-');
	const centralRoot = join(root, 'central');
	const centralConfig = join(root, 'central.json');
	let stop: (() => Promise<void>) | undefined;
	async function close(): Promise<void> {
		try {
			await stop?.();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
	try {
		await writeFile(
			centralConfig,
			JSON.stringify({
				listen: '127.0.0.1:0',
				root: centralRoot,
				signIn: { ...b3CentralTrust(props.issuer), jwksUrl: props.jwksUrl },
			}),
			{ mode: 0o600 },
		);
		const central = spawn(props.executable, ['central', 'serve', '--config', centralConfig], {
			stdio: ['ignore', 'pipe', 'inherit'],
		});
		const exited = once(central, 'close');
		stop = async (): Promise<void> => {
			central.kill('SIGTERM');
			const [status]: readonly unknown[] = await exited;
			if (status !== 0) throw new Error(`Central shut down with status ${String(status)}`);
		};
		const readiness = createInterface({ input: central.stdout });
		const opened = await Promise.race([
			once(readiness, 'line').then(([line]: readonly unknown[]) => {
				if (typeof line !== 'string') throw new Error('Missing Central readiness line');
				return /^central listening: (http:\/\/127\.0\.0\.1:\d+) \(private sign-in socket (.+)\)$/.exec(
					line,
				);
			}),
			exited.then(() => {
				throw new Error('Central exited before readiness');
			}),
		]);
		const [, tcp, socketPath] = opened ?? [];
		if (tcp === undefined || socketPath !== join(centralRoot, 'signin.sock'))
			throw new Error('Central did not announce the expected private listeners');
		return { tcp: new URL(tcp), socketPath, close };
	} catch (error) {
		await close();
		throw error;
	}
}
