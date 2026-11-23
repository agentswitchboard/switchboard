import { expect, it } from 'vitest';

import { approvalPersonReplySchemas } from '#sign-in-core/central-link/approval-person-replies';
import {
	approvalPersonAdminRefusalStatuses,
	approvalPersonPreflightStatuses,
	approvalPersonReplyStatuses,
} from '#sign-in-core/central-link/approval-person-results';
import { fleetAdminRefusalReasonSchema } from '#sign-in-core/central-link/fleet-admin-client';

it('names a status for exactly the reply kinds each schema accepts, all 200', (): void => {
	// Arrange
	const schemaKinds = Object.fromEntries(
		Object.entries(approvalPersonReplySchemas).map(([operation, schema]) => [
			operation,
			schema.options.map((option) => option.shape.kind.value).toSorted(),
		]),
	);
	// Act
	const tableKinds = Object.fromEntries(
		Object.entries(approvalPersonReplyStatuses).map(([operation, statuses]) => [
			operation,
			Object.keys(statuses).toSorted(),
		]),
	);
	// Assert
	expect(tableKinds).toEqual(schemaKinds);
	expect(
		Object.values(approvalPersonReplyStatuses).flatMap((statuses) => Object.values(statuses)),
	).toEqual(Array.from({ length: 9 }, () => 200));
});

it('records central matrix statuses for preflight refusals', (): void => {
	expect(approvalPersonPreflightStatuses).toEqual({
		methodNotPost: { status: 405, body: 'empty', allow: 'POST' },
		missingCredentials: { status: 401, body: 'empty' },
		badOrganizationAddress: { status: 400, body: 'empty' },
		verificationFailed: { status: 401, body: 'empty' },
		unavailable: { status: 503, body: 'empty' },
	});
});

it('admin refusals arrive at 200 in the envelope sign-in already reads, without a factor refusal', (): void => {
	const reasons = Object.keys(approvalPersonAdminRefusalStatuses);
	expect(reasons.map((reason) => fleetAdminRefusalReasonSchema.safeParse(reason).success)).toEqual(
		reasons.map(() => true),
	);
	expect(reasons).not.toContain('secondFactorRequired');
	expect(
		new Set(Object.values(approvalPersonAdminRefusalStatuses).map(({ status }) => status)),
	).toEqual(new Set([200]));
});
