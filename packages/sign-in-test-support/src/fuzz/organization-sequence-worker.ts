import { signInWorkerConfiguration } from '@agent-collaboration/sign-in-host-cloudflare/configuration';
import { z } from 'zod';

import { organizationOperationSchema } from '#sign-in-test-support/fuzz/organization-model';
import {
	createOrganizationRuntime,
	type OrganizationRuntime,
} from '#sign-in-test-support/fuzz/organization-runtime';
import { createStorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import { storageCaseErrorMessage } from '#sign-in-test-support/storage-cases/storage-case-errors';

declare global {
	// Installed by this test Worker's separate controlled-Date startup module.
	var organizationFuzzTime: number;
}

const commandSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('reset') }),
	z.object({ kind: z.literal('execute'), operation: organizationOperationSchema }),
]);
let runtime: OrganizationRuntime | undefined;

export default {
	async fetch(request: Request, bindings: AuthWorkerEnv): Promise<Response> {
		try {
			if (runtime === undefined) {
				const host = signInWorkerConfiguration(bindings);
				const context = createStorageCaseContext({
					openDatabase: host.openDatabase,
					runAtomically: host.platform.runAtomically,
				});
				runtime = createOrganizationRuntime({
					context,
					setNativeTime: (milliseconds): void => {
						globalThis.organizationFuzzTime = milliseconds;
					},
				});
			}
			const command = commandSchema.parse(await request.json());
			switch (command.kind) {
				case 'reset':
					return Response.json({ kind: 'result', value: await runtime.reset() });
				case 'execute':
					return Response.json({ kind: 'result', value: await runtime.execute(command.operation) });
				default:
					return command satisfies never;
			}
		} catch (error) {
			return Response.json(
				{ kind: 'case-error', message: storageCaseErrorMessage(error) },
				{ status: 500 },
			);
		}
	},
};
