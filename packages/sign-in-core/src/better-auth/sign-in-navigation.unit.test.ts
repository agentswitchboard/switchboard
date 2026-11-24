import { expect, it } from 'vitest';

import {
	accountPageLandsInShell,
	signedInDestinationsFor,
} from '#sign-in-core/better-auth/sign-in-navigation';
import type { OrganizationChoice } from '#sign-in-core/contracts/organization-membership';
import { organizationIdSchema } from '#sign-in-core/storage/models/sign-in-store';

const organization: OrganizationChoice = {
	organizationId: organizationIdSchema.parse('019a3dce-2000-7000-8000-0000000000a1'),
	organizationName: 'Example organization',
	role: 'owner',
};

it.each([
	['owner', true, ['/me', '/people', '/device', '/workspaces']],
	['owner', false, ['/me', '/people', '/workspaces']],
	['member', true, ['/me']],
	['member', false, ['/me']],
] as const)(
	'gives a %s with machine login %s exactly the destinations their role permits',
	(role, machineLoginEnabled, expected) => {
		// Act
		const destinations = signedInDestinationsFor(role, machineLoginEnabled);

		// Assert
		expect(destinations).toEqual(expected);
	},
);

const readyAccount = {
	choices: [organization],
	activeOrganization: organization,
	factorPage: 'confirmed',
	email: 'owner@example.invalid',
} as const;

it.each([
	['a ready person', readyAccount, '/owner-ready', true],
	['a waiting CLI sign-in', readyAccount, '/owner-ready?authorize=x', false],
	['a CLI client continuation', readyAccount, '/owner-ready?client_id=x', false],
	['a machine login code', readyAccount, '/owner-ready?device=ABCD-EFGH', false],
	['second-factor setup', { ...readyAccount, factorPage: 'enroll-app' }, '/owner-ready', false],
	['second-factor confirmation', { ...readyAccount, factorPage: 'confirm' }, '/owner-ready', false],
	[
		'an organization to choose',
		{ ...readyAccount, activeOrganization: null },
		'/owner-ready',
		false,
	],
	['no session', null, '/owner-ready', false],
] as const)('sends %s into the shell: %s', (_case, account, path, lands) => {
	// Arrange
	const url = new URL(path, 'http://127.0.0.1:3000');

	// Act
	const landsInShell = accountPageLandsInShell(account, url);

	// Assert
	expect(landsInShell).toBe(lands);
});
