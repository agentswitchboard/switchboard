import { expect, it } from 'vitest';

import { deviceRefusalCopy } from '#sign-in-core/pages/device-approval-copy';
import { deviceDecisionOutcome } from '#sign-in-core/pages/islands/device-decision-outcome';

it.each([
	['notPermitted', 'not-permitted'],
	['unknownWorkspace', 'unknown-workspace'],
	['machineInAnotherOrganization', 'other-organization'],
] as const)('maps the known Central refusal %s', (kind, refusal): void => {
	expect(
		deviceDecisionOutcome('approve', 403, { error: 'access_denied', reason: { kind } }),
	).toEqual({ kind: 'refused', refusal });
});

it('shows the conflict outcome from Central without classifying it as an approval', (): void => {
	const decision = deviceDecisionOutcome('approve', 409, {
		error: 'access_denied',
		reason: { kind: 'requestConflict' },
	});
	expect(decision).toEqual({ kind: 'refused', refusal: 'request-conflict' });
	expect(deviceRefusalCopy['request-conflict'].title).toBe(
		'This login was already approved with different details',
	);
});

it.each(['approve', 'deny'] as const)('asks for the factor when %s is held', (decision): void => {
	expect(
		deviceDecisionOutcome(decision, 403, {
			error: 'access_denied',
			reason: { kind: 'secondFactorRequired', withinSeconds: 900 },
		}),
	).toEqual({ kind: 'confirm-again', withinSeconds: 900 });
});

it('treats an unexpected response as a refusal on each decision path', (): void => {
	expect(deviceDecisionOutcome('approve', 200, { result: 'unknown' })).toEqual({
		kind: 'refused',
		refusal: 'unavailable',
	});
	expect(deviceDecisionOutcome('deny', 200, { result: 'unknown' })).toEqual({
		kind: 'refused',
		refusal: 'unavailable',
	});
});
