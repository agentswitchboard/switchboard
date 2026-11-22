import {
	organizationPeopleChangeSchema,
	type OrganizationPeopleChange,
} from '@agent-collaboration/sign-in-core';
import { z } from 'zod';

import {
	seedBaselineUpgrade,
	readBaselineUpgrade,
	readUpgradeAdditions,
} from '#sign-in-test-support/storage-cases/baseline-upgrade-case';
import { raceNativeDeviceRedemption } from '#sign-in-test-support/storage-cases/device-redemption-race';
import {
	factorReplacementStateSchema,
	replacementChallengeSchema,
	replacementCredentialSchema,
	prepareFactorReplacement,
	challengeAfterFactorRestart,
	confirmAfterFactorRestart,
} from '#sign-in-test-support/storage-cases/factor-replacement-restart';
import {
	storedSecretOnlyUpdate,
	appendedAttributableRefusal,
} from '#sign-in-test-support/storage-cases/management-readback-cases';
import {
	executeRecordHistory,
	recordHistoryStepSchema,
} from '#sign-in-test-support/storage-cases/organization-record-history';
import {
	prepareStampRestart,
	readStampAfterRestart,
	stampRestartStateSchema,
} from '#sign-in-test-support/storage-cases/organization-stamp-restart';
import { readStorageSchema } from '#sign-in-test-support/storage-cases/schema-readback';
import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import { runStorageCase } from '#sign-in-test-support/storage-cases/storage-case-registry';
import {
	createStoragePerson,
	createStorageMembership,
	personAccountCounts,
	resetStorageCase,
} from '#sign-in-test-support/storage-cases/storage-case-utilities';

export const restartStateSchema = z.strictObject({
	change: organizationPeopleChangeSchema,
	rows: z.array(z.unknown()),
});
export type RestartState = z.infer<typeof restartStateSchema>;
export const storageCommandSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('case'), name: z.string() }),
	z.strictObject({ kind: z.literal('seed-baseline') }),
	z.strictObject({ kind: z.literal('read-upgrade') }),
	z.strictObject({ kind: z.literal('device-redemption-race') }),
	z.strictObject({ kind: z.literal('upgrade-additions') }),
	z.strictObject({
		kind: z.literal('record-history'),
		steps: z.array(recordHistoryStepSchema).min(1).max(60),
	}),
	z.strictObject({ kind: z.literal('prepare-restart'), phase: z.enum(['intent', 'outcome']) }),
	z.strictObject({ kind: z.literal('read-restart'), state: restartStateSchema }),
	z.strictObject({ kind: z.literal('prepare-stamp-restart') }),
	z.strictObject({ kind: z.literal('read-stamp-restart'), state: stampRestartStateSchema }),
	z.strictObject({
		kind: z.literal('prepare-factor-replacement'),
		credential: replacementCredentialSchema,
	}),
	z.strictObject({
		kind: z.literal('factor-replacement-challenge'),
		state: factorReplacementStateSchema,
	}),
	z.strictObject({
		kind: z.literal('confirm-factor-replacement'),
		challenge: replacementChallengeSchema,
		assertion: z.unknown(),
	}),
	z.strictObject({ kind: z.literal('unmigrated-read') }),
	z.strictObject({ kind: z.literal('schema-readback'), details: z.enum(['catalog', 'metadata']) }),
	z.strictObject({
		kind: z.literal('management-readback'),
		scenario: z.enum(['stored-secret-only', 'appended-refusal']),
	}),
]);
export type StorageCommand = z.infer<typeof storageCommandSchema>;
export async function executeStorageCommand(
	context: StorageCaseContext,
	command: StorageCommand,
): Promise<unknown> {
	switch (command.kind) {
		case 'prepare-factor-replacement':
			return prepareFactorReplacement({ context, credential: command.credential });
		case 'factor-replacement-challenge':
			return challengeAfterFactorRestart({ context, state: command.state });
		case 'confirm-factor-replacement':
			return confirmAfterFactorRestart({
				context,
				challenge: command.challenge,
				assertion: command.assertion,
			});
		case 'seed-baseline':
			return seedBaselineUpgrade(context);
		case 'read-upgrade':
			return readBaselineUpgrade(context);
		case 'device-redemption-race':
			return raceNativeDeviceRedemption(context);
		case 'upgrade-additions':
			return readUpgradeAdditions(context);
		case 'case':
			return runStorageCase(context, command.name);
		case 'record-history':
			return executeRecordHistory(context, command.steps);
		case 'unmigrated-read':
			return context.store.resources.read('https://storage-portal.invalid/missing');
		case 'schema-readback':
			return readStorageSchema(context, command.details);
		case 'management-readback':
			await resetStorageCase(context);
			return command.scenario === 'stored-secret-only'
				? storedSecretOnlyUpdate(context)
				: appendedAttributableRefusal(context);
		case 'prepare-restart': {
			await resetStorageCase(context);
			const actorUserId = await createStoragePerson(context);
			const organizationId = await createStorageMembership(context, actorUserId);
			const change: OrganizationPeopleChange = {
				requestId: context.platform.ids.nextId(),
				actorUserId,
				organizationId,
				change: 'invited',
				targetId: 'pending@example.invalid',
			};
			const intent = await context.store.peopleChanges.record(change, 'intent');
			if (intent.kind !== 'available') throw new Error('Restart intent unavailable');
			if (command.phase === 'outcome') {
				const outcome = await context.store.peopleChanges.record(change, 'outcome');
				if (outcome.kind !== 'available') throw new Error('Restart outcome unavailable');
			}
			const rows = await context.store.peopleChanges.read(change);
			if (rows.kind !== 'available') throw new Error('Restart record read unavailable');
			return { change, rows: rows.value };
		}
		case 'prepare-stamp-restart':
			return prepareStampRestart(context);
		case 'read-stamp-restart':
			return readStampAfterRestart(context, command.state);
		case 'read-restart': {
			const rows = await context.store.peopleChanges.read(command.state.change);
			if (rows.kind !== 'available') return rows;
			return {
				rows: rows.value,
				personRows: await personAccountCounts(context, command.state.change.actorUserId),
			};
		}
	}
}
