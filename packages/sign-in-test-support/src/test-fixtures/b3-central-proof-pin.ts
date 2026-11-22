import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

export const b3CentralProofPin = {
	commit: '19d097732af9db9b5d3019c37b308707d4a5a73c',
	tree: '93c5c52403ebc903edf0f967e7b8e6afda83606c',
	// Locked production CLI debug build, then signed for direct macOS execution.
	nativeSha256: '0daa4a04722e581557b6f0fe299154d39a968c2020564884b634318a4d98668d',
	workers: {
		'build/index.js': '78ba0e8570ad458e63cb51d6ae1740e27f5e38c7aaf34f9d19610295557efea6',
		'build/index_bg.wasm': 'd1d2f5e6d5e36716753268519389b2ee33cc8ed57d406a8a031aa7cdf070cf81',
		'build-link/index.js': '6b37e7d90a31920d7edb3b685f6a725332b78c82a6b89fd634a43f49e8710caf',
		'build-link/index_bg.wasm': 'ba13823d764ef8c17db11ed5501a0244553bd1b77e858a32588ba356f036b750',
	},
} as const;

async function assertDigest(file: string, expected: string): Promise<string> {
	const digest = createHash('sha256');
	for await (const chunk of createReadStream(file)) {
		if (!Buffer.isBuffer(chunk)) throw new Error('Central proof artifact did not supply bytes');
		digest.update(chunk);
	}
	const actual = digest.digest('hex');
	if (actual !== expected) throw new Error(`Central proof artifact SHA-256 mismatch (${actual})`);
	return actual;
}

export async function assertB3CentralNativeProofArtifact(executable: string): Promise<void> {
	const sha256 = await assertDigest(executable, b3CentralProofPin.nativeSha256);
	process.stdout.write(
		JSON.stringify({
			event: 'b3-central-native-proof-pin',
			commit: b3CentralProofPin.commit,
			sha256,
		}) + '\n',
	);
}

export async function assertB3CentralWorkerProofArtifacts(checkout: string): Promise<void> {
	const result = await runFile('git', ['-C', checkout, 'rev-parse', 'HEAD', 'HEAD^{tree}']);
	const [commit, tree] = result.stdout.trim().split('\n');
	if (commit !== b3CentralProofPin.commit || tree !== b3CentralProofPin.tree)
		throw new Error(`Central proof checkout is not the recorded source (${commit}, ${tree})`);
	const changes = await runFile('git', ['-C', checkout, 'status', '--porcelain']);
	if (changes.stdout !== '') throw new Error('Central proof checkout is dirty');
	const base = join(checkout, 'crates/collaboration-central-cloudflare');
	const hashes = await Promise.all(
		Object.entries(b3CentralProofPin.workers).map(
			async ([artifact, expected]) =>
				[artifact, await assertDigest(join(base, artifact), expected)] as const,
		),
	);
	process.stdout.write(
		JSON.stringify({
			event: 'b3-central-worker-proof-pin',
			commit,
			sha256: Object.fromEntries(hashes),
		}) + '\n',
	);
}
