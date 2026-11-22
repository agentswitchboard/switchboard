import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

export const b3CentralProofPin = {
	commit: 'b0e33b15e6d7b9cc448f3fa822b3a3ca2159eb10',
	tree: '57808cb62351b00db87ab8c073171ec2a1b2cbc8',
	// Locked production CLI debug build, then signed for direct macOS execution.
	nativeSha256: 'ef8af00ff781cc864a0607819a13e7a483e370c640b3370d9d92db2e3a81d3b1',
	workers: {
		'build/index.js': '78ba0e8570ad458e63cb51d6ae1740e27f5e38c7aaf34f9d19610295557efea6',
		'build/index_bg.wasm': 'd53f81cff8a61846c8b6c542fbd1a4bec52581e702d4a1905d0911ac9da33a70',
		'build-link/index.js': '6b37e7d90a31920d7edb3b685f6a725332b78c82a6b89fd634a43f49e8710caf',
		'build-link/index_bg.wasm': '9a9021c391c7addbf020efe829d630314bcd6d4bbdc37283d6e7d5cdbb896f77',
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
