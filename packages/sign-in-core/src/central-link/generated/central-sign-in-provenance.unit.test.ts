import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { centralSignInWireProvenance } from '#sign-in-core/central-link/generated/provenance';

it('pins the generated Central wire file byte-for-byte to its producer', async (): Promise<void> => {
	const vendored = await readFile(new URL('./central-sign-in.gen.ts', import.meta.url));
	expect(createHash('sha256').update(vendored).digest('hex')).toBe(
		centralSignInWireProvenance.sha256,
	);
});
