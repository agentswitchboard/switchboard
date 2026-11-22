import { expect, it } from 'vitest';

import {
	decideDeviceLoginSchema,
	deviceLoginDecisionSchema,
	fleetLoginDiscoveryResponseSchema,
	machineLoginConfigurationSchema,
	machinePrincipalSchema,
	machineTokenDecisionSchema,
	presentedMachineSchema,
	revokeMachineEnrollmentRequestSchema,
	revokeMachineEnrollmentResultSchema,
} from '#sign-in-core/machine-login/machine-login-contracts';

const machineId = '019a61bb-0000-7000-8000-000000000001';
const organizationId = '019a61bb-0000-7000-8000-000000000002';
const approver = '019a61bb-0000-7000-8000-000000000003';
const requestId = '019a61bb-0000-7000-8000-000000000004';
const enrollmentId = '019a61bb-0000-7000-8000-000000000005';

it('uses the same strict HTTPS link template contract at startup and on discovery', (): void => {
	const configurations = (linkUrlTemplate: string): unknown => ({
		routerClientId: machineId,
		machineAudience: 'https://central.example.invalid/machine',
		linkUrlTemplate,
	});
	for (const link_url of [
		'https://sign-in.example.invalid/api/fleet/link/{organization_id}',
		'https://central.example.invalid/v1/organizations/{organization_id}/link',
	]) {
		const response = { client_id: machineId, link_url };
		expect(fleetLoginDiscoveryResponseSchema.parse(response)).toEqual(response);
		expect(machineLoginConfigurationSchema.safeParse(configurations(link_url)).success).toBe(true);
		expect(fleetLoginDiscoveryResponseSchema.safeParse({ ...response, extra: true }).success).toBe(
			false,
		);
	}
	for (const link_url of [
		'/v1/organizations/{organization_id}/link',
		'http://central.example.invalid/v1/organizations/{organization_id}/link',
		'https:///central.example.invalid/v1/organizations/{organization_id}/link',
		'https://central.example.invalid/v1/organizations/no-placeholder/link',
		'https://central.example.invalid/v1/{organization_id}/{organization_id}/link',
		'https://central.example.invalid/v1/organizations?org={organization_id}',
		'https://user@central.example.invalid/v1/organizations/{organization_id}/link',
	]) {
		expect(
			fleetLoginDiscoveryResponseSchema.safeParse({ client_id: machineId, link_url }).success,
		).toBe(false);
		expect(machineLoginConfigurationSchema.safeParse(configurations(link_url)).success).toBe(false);
	}
});

it('refuses obsolete fleet addresses in machine configuration', (): void => {
	const configuration = {
		routerClientId: machineId,
		machineAudience: 'https://central.example.invalid/machine',
		linkUrlTemplate: 'https://central.example.invalid/v1/organizations/{organization_id}/link',
	};
	expect(machineLoginConfigurationSchema.safeParse(configuration).success).toBe(true);
	expect(
		machineLoginConfigurationSchema.safeParse({
			...configuration,
			fleetCentral: { receiver: organizationId, relay: enrollmentId },
		}).success,
	).toBe(false);
});

it.each([
	{
		name: 'DecideDeviceLogin',
		schema: decideDeviceLoginSchema,
		value: {
			machineId,
			organizationId,
			approver,
			permissionChecked: 'machine:enroll',
			requestId,
			label: 'Proof Mac',
			allowedWorkspaces: [],
			approverSecondFactorAt: null,
			codeExpiresAt: 2_208_989_100,
		},
		obsolete: 'installation',
		idField: 'machineId',
	},
	{
		name: 'PresentedMachine',
		schema: presentedMachineSchema,
		value: { machineId },
		obsolete: 'peer',
		idField: 'machineId',
	},
	{
		name: 'MachineTokenDecision Grant',
		schema: machineTokenDecisionSchema,
		value: {
			result: 'grant',
			machineId,
			enrollmentId,
			decidedAt: 2_208_988_800,
			grantExpiresAt: 2_208_989_400,
		},
		obsolete: 'installation',
		idField: 'machineId',
	},
	{
		name: 'MachinePrincipal',
		schema: machinePrincipalSchema,
		value: { kind: 'machine', machine_id: machineId, enrollment_id: enrollmentId },
		obsolete: 'installation_id',
		idField: 'machine_id',
	},
])('accepts one UUIDv7 and refuses legacy identity keys for $name', (fixture): void => {
	expect(fixture.schema.parse(fixture.value)).toEqual(fixture.value);

	const legacy = fixture.schema.safeParse({ ...fixture.value, [fixture.obsolete]: machineId });
	if (legacy.success) throw new Error('Accepted an obsolete machine identity key');
	expect(legacy.error.issues).toContainEqual(
		expect.objectContaining({ code: 'unrecognized_keys', keys: [fixture.obsolete] }),
	);
	expect(
		fixture.schema.safeParse({
			...fixture.value,
			[fixture.idField]: '019a61bb-0000-4000-8000-000000000001',
		}).success,
	).toBe(false);
});

it('keeps revocation actor and second-factor time out of the request body', (): void => {
	const body = { organizationId, enrollmentId };
	expect(revokeMachineEnrollmentRequestSchema.parse(body)).toEqual(body);
	for (const extra of [{ actor: approver }, { secondFactorAt: 2_208_988_790 }]) {
		const result = revokeMachineEnrollmentRequestSchema.safeParse({ ...body, ...extra });
		if (result.success) throw new Error('Accepted request-supplied person authorization');
		expect(result.error.issues).toContainEqual(
			expect.objectContaining({ code: 'unrecognized_keys', keys: Object.keys(extra) }),
		);
	}
});

it('admits the exact device approval and its provisional conflict reply', (): void => {
	const approved = { result: 'approved', enrollmentId, label: 'Proof Mac', allowedWorkspaces: [] };
	const conflict = { result: 'refused', reason: { kind: 'requestConflict' } };
	expect(deviceLoginDecisionSchema.parse(approved)).toEqual(approved);
	expect(deviceLoginDecisionSchema.parse(conflict)).toEqual(conflict);
	expect(deviceLoginDecisionSchema.safeParse({ ...approved, note: 'extra' }).success).toBe(false);
});

it('admits the serialized machine grant with an omitted or populated superseded client', (): void => {
	const grant = {
		result: 'grant',
		machineId,
		enrollmentId,
		decidedAt: 2_208_988_800,
		grantExpiresAt: 2_208_989_400,
	};
	const superseded = { enrollmentId: requestId, clientId: requestId };
	expect(machineTokenDecisionSchema.parse(grant)).toEqual(grant);
	expect(machineTokenDecisionSchema.parse({ ...grant, superseded })).toEqual({
		...grant,
		superseded,
	});
	expect(machineTokenDecisionSchema.safeParse({ ...grant, superseded: null }).success).toBe(false);
	expect(machineTokenDecisionSchema.safeParse({ ...grant, note: 'extra' }).success).toBe(false);
});

it('admits the closed revocation outcome vocabulary', (): void => {
	for (const outcome of [
		{ result: 'revoked' },
		{ result: 'notFound' },
		{ result: 'alreadyEnded' },
		{ result: 'refused', reason: 'notPermitted' },
		{ result: 'refused', reason: 'factorNotRecent' },
	]) {
		expect(revokeMachineEnrollmentResultSchema.parse(outcome)).toEqual(outcome);
	}
	expect(
		revokeMachineEnrollmentResultSchema.safeParse({
			result: 'refused',
			reason: 'secondFactorRequired',
		}).success,
	).toBe(false);
});
