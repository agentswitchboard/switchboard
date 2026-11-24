import { fleetPermissionPolicy } from '@agent-collaboration/sign-in-core/better-auth';

import { authorizationFenceStoreCases } from '#sign-in-test-support/storage-cases/authorization-fence-store-cases';
import { authorizationRevisionDeliveryCases } from '#sign-in-test-support/storage-cases/authorization-revision-delivery-cases';
import { concurrentFirstClientLinks } from '#sign-in-test-support/storage-cases/concurrent-client-link-case';
import { organizationCentralEmptyCases } from '#sign-in-test-support/storage-cases/organization-central-empty-cases';
import { organizationCentralForgotCases } from '#sign-in-test-support/storage-cases/organization-central-forgot-cases';
import { organizationFleetCallCases } from '#sign-in-test-support/storage-cases/organization-fleet-call-cases';
import { heldOwnerRemoval } from '#sign-in-test-support/storage-cases/organization-held-removal';
import { organizationMembershipReadCases } from '#sign-in-test-support/storage-cases/organization-membership-read-cases';
import { organizationPermissionConfirmations } from '#sign-in-test-support/storage-cases/organization-permission-cases';
import { nativeOrganizationProvisioning } from '#sign-in-test-support/storage-cases/organization-provisioning-cases';
import { organizationRecordFaultCases } from '#sign-in-test-support/storage-cases/organization-record-fault-cases';
import { exerciseOrganizationConstraints } from '#sign-in-test-support/storage-cases/organization-schema-constraints';
import { organizationStampDeadlineCases } from '#sign-in-test-support/storage-cases/organization-stamp-deadline-cases';
import { organizationStampRenewalCases } from '#sign-in-test-support/storage-cases/organization-stamp-renewal-cases';
import { personCleanupCases } from '#sign-in-test-support/storage-cases/person-cleanup-cases';
import {
	providerIdentifiersUseUuid7,
	providerAssertionDigestRemainsSingleUse,
} from '#sign-in-test-support/storage-cases/provider-identifier-cases';
import {
	providerWritesJsonText,
	malformedWorkspaceRecordIsUnavailable,
	absentWorkspaceRecordIsAbsent,
	readsManagementResourceAsNonWorkspace,
} from '#sign-in-test-support/storage-cases/provider-json-storage-cases';
import { recordingCapabilitiesDriveStorage } from '#sign-in-test-support/storage-cases/recording-capability-case';
import { recoveryCodeCompareAndSwap } from '#sign-in-test-support/storage-cases/recovery-code-cas-case';
import { secondFactorRemovalCases } from '#sign-in-test-support/storage-cases/second-factor-removal-cases';
import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import { resetStorageCase } from '#sign-in-test-support/storage-cases/storage-case-utilities';
import { unavailableFactoryIsClosedResult } from '#sign-in-test-support/storage-cases/unavailable-store-case';

export interface StorageCaseDefinition {
	readonly name: string;
	readonly expected: unknown;
	readonly run: (context: StorageCaseContext) => Promise<unknown>;
}
export const storageCaseDefinitions: readonly StorageCaseDefinition[] = [
	...organizationMembershipReadCases,
	...secondFactorRemovalCases,
	{
		name: 'people: native recovery uses the adapter compare-and-swap boundary so exactly one held request spends a code',
		expected: {
			reachedBoth: true,
			arrivalCount: 2,
			successes: 1,
			nativeConflicts: 1,
			onlyWinnerStamped: true,
			distinctSessionsInitiallyUnconfirmed: true,
			usedCodeInitiallyPresentOnce: true,
			exactlyUsedCodeRemoved: true,
		},
		run: recoveryCodeCompareAndSwap,
	},
	...personCleanupCases,
	...authorizationFenceStoreCases,
	...authorizationRevisionDeliveryCases,
	...organizationStampRenewalCases,
	...organizationStampDeadlineCases,
	...organizationFleetCallCases,
	...organizationCentralEmptyCases,
	...organizationCentralForgotCases,
	{
		name: 'people: two native owner removals held at the production hook both refuse with both fixture owners unchanged',
		expected: {
			reachedBothHooks: true,
			nativeOwnerPayloads: true,
			statuses: [403, 403],
			bothOwnersUnchanged: true,
			ownerCount: 2,
			removalRecords: 0,
		},
		run: heldOwnerRemoval,
	},
	{
		name: 'people: live native permissions bind K5 to exactly one request organization and permission',
		expected: {
			// The case confirms every permission K5 declares; the owner role's own statements grant
			// them all, so the two sources must agree in number, as well as answer by answer.
			permissionCount: fleetPermissionPolicy.roles.owner.length,
			exactOwnerAnswers: true,
			allMemberAnswersInactive: true,
			wrongOrganization: { active: false },
			mismatchReadsNoSession: true,
			ownerAgain: true,
			removed: { active: false },
			revoked: { active: false },
		},
		run: organizationPermissionConfirmations,
	},
	{
		name: 'people: native organization insertion starts settingUp and only the provisioning stand-in confirms ready',
		expected: {
			observedBeforeReply: ['settingUp', 'settingUp', 'settingUp', 'settingUp'],
			states: ['settingUp', 'settingUp', 'settingUp', 'ready'],
			distinctRequests: 4,
		},
		run: nativeOrganizationProvisioning,
	},
	{
		name: 'an unavailable database factory returns explicit store failures rather than throwing or absence',
		expected: {
			resource: { kind: 'store-unavailable', reason: 'database-error' },
			owner: { kind: 'store-unavailable', reason: 'database-error' },
		},
		run: unavailableFactoryIsClosedResult,
	},
	{
		name: 'recording clock and known IDs drive stored values, fresh owner reads and expiry without real time',
		expected: {
			clockUsed: true,
			freshOwnerViews: true,
			liveBeforeExpiry: true,
			expiredAfterClockMove: true,
			requestFromKnownIds: true,
			intentTime: 2208988800100,
			outcomeTime: 2208988800200,
		},
		run: recordingCapabilitiesDriveStorage,
	},
	{
		name: 'provider model IDs use the injected v7 source and every text cell is scanned with a planted v4 control',
		expected: {
			generatorUsed: true,
			hasUuidCells: true,
			nonV7Locations: [],
			plantedLocations: [
				{ table: 'oauthClient', column: 'metadata', version: '4', reason: 'wrong-version' },
			],
			restoredClean: true,
		},
		run: providerIdentifiersUseUuid7,
	},
	{
		name: 'the real provider keeps the assertion jti digest key and refuses the same assertion replay',
		expected: {
			firstSpent: true,
			derivedDigestKept: true,
			replayRefused: true,
			sameKey: true,
			notUuid: true,
			noCredentials: true,
		},
		run: providerAssertionDigestRemainsSingleUse,
	},
	{
		name: 'native organization keys, foreign keys and required fields constrain real writes',
		expected: {
			duplicateSlug: true,
			invalidPerson: true,
			invalidOrganization: true,
			requiredEmail: true,
			nullableAuditIdentities: 2,
		},
		run: exerciseOrganizationConstraints,
	},
	{
		name: 'concurrent first client links converge through the real provider to one link',
		expected: { kinds: ['linked', 'linked'], overlappingReads: 2, links: [true], liveOwner: true },
		run: concurrentFirstClientLinks,
	},
	{
		name: 'malformed stored workspace JSON is unavailable rather than absent',
		expected: {
			read: { kind: 'store-unavailable', reason: 'row-unparseable' },
			exists: { kind: 'available', value: true },
		},
		run: malformedWorkspaceRecordIsUnavailable,
	},
	{
		name: 'a missing workspace row remains an ordinary absent result',
		expected: {
			read: { kind: 'available', value: null },
			exists: { kind: 'available', value: false },
		},
		run: absentWorkspaceRecordIsAbsent,
	},
	...organizationRecordFaultCases,
	{
		name: 'the real Better Auth Drizzle adapter writes one JSON text value and the typed store reads it',
		expected: {
			adapter: 'drizzle',
			cells: [{ grantTypes: 'array', redirects: 'array', metadata: 'object' }],
			registrationKind: 'available',
			grantTypes: ['client_credentials'],
			metadataMatches: true,
		},
		run: providerWritesJsonText,
	},
	{
		name: 'a legitimate Better Auth management resource is not a workspace resource',
		expected: { kind: 'available', value: null },
		run: readsManagementResourceAsNonWorkspace,
	},
];
export async function runStorageCase(context: StorageCaseContext, name: string): Promise<unknown> {
	const definition = storageCaseDefinitions.find((candidate) => candidate.name === name);
	if (definition === undefined) throw new Error('Unknown storage case');
	await resetStorageCase(context);
	return definition.run(context);
}
