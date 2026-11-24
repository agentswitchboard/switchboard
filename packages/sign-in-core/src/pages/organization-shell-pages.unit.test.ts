// @vitest-environment jsdom
import { expect, it } from 'vitest';

import { mintPageNonce } from '#sign-in-core/contracts/page-nonce';
import type { SignedInNavigationState } from '#sign-in-core/contracts/sign-in-navigation';
import { uuid7Schema, type SignInCrypto } from '#sign-in-core/contracts/sign-in-platform';
import { renderOrganizationAdminPage } from '#sign-in-core/pages/organization-admin-page';
import { renderWorkspacesPage } from '#sign-in-core/pages/workspaces-page';
import { organizationIdSchema } from '#sign-in-core/storage/models/sign-in-store';

const fixedBytesCrypto: SignInCrypto = {
	getRandomValues: (bytes) => {
		bytes.set(Array.from({ length: bytes.byteLength }, (_, index) => index % 256));
		return bytes;
	},
	subtle: globalThis.crypto.subtle,
};
const organizationId = organizationIdSchema.parse('019a3dce-2000-7000-8000-0000000000a1');

function navigation(page: SignedInNavigationState['page']): SignedInNavigationState {
	const activeOrganization = {
		organizationId,
		organizationName: '<b>Example</b> organization',
		role: 'owner',
	} as const;
	return {
		page,
		activeOrganization,
		choices: [activeOrganization],
		destinations: ['/me', '/people', '/device', '/workspaces'],
		showOrganizationAdmin: true,
	};
}

async function served(response: Response): Promise<Document> {
	return new DOMParser().parseFromString(await response.text(), 'text/html');
}

function sidebarLinks(page: Document): readonly (readonly [string, string | null])[] {
	return [...page.querySelectorAll('nav[aria-label="Signed-in navigation"] a')].map((link) => [
		link.textContent ?? '',
		link.getAttribute('aria-current'),
	]);
}

it('renders Organization admin inside the shell with the organization ID and its copy control', async () => {
	// Act
	const page = await served(
		renderOrganizationAdminPage({
			crypto: fixedBytesCrypto,
			navigation: navigation('/organization-admin'),
			admin: { fleetSetup: 'settingUp' },
		}),
	);

	// Assert
	expect(page.querySelector('[data-slot="sidebar-wrapper"]')).not.toBeNull();
	expect(sidebarLinks(page)).toEqual([
		['Me', null],
		['People', null],
		['Machines', null],
		['Workspaces', null],
	]);
	expect(page.querySelector('h1')?.textContent).toBe('Organization admin');
	expect(page.querySelector<HTMLInputElement>('input[readonly]')?.getAttribute('value')).toBe(
		organizationId,
	);
	expect(
		page.querySelector('button[aria-label="Copy organization ID"]')?.getAttribute('data-copy-value'),
	).toBe(organizationId);
	expect(page.body.textContent).toContain('<b>Example</b> organization');
	expect(page.querySelector('b')).toBeNull();
});

it('renders Workspaces as the current destination with central\'s directory as a table', async () => {
	// Act
	const page = await served(
		renderWorkspacesPage({
			nonce: mintPageNonce(fixedBytesCrypto),
			navigation: navigation('/workspaces'),
			workspaces: {
				directory: {
					kind: 'listed',
					workspaces: [
						{ workspaceId: 'a', name: 'Release tooling', state: 'active' },
						{ workspaceId: 'b', name: 'Design systems', state: 'archived' },
					],
				},
				canCreate: true,
				operationId: uuid7Schema.parse('019a3dce-2000-7000-8000-0000000000a2'),
			},
		}),
	);

	// Assert
	expect(sidebarLinks(page).find(([label]) => label === 'Workspaces')?.[1]).toBe('page');
	expect(
		[...page.querySelectorAll('table[aria-label="Workspaces"] tbody tr')].map((row) =>
			[...row.querySelectorAll('td')].map((cell) => cell.textContent),
		),
	).toEqual([
		['Release tooling', 'Active'],
		['Design systems', 'Archived'],
	]);
	expect(
		[...page.querySelectorAll('button')].some((button) => button.textContent === 'Create workspace'),
	).toBe(true);
});
