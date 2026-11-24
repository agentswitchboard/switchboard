import { z } from 'zod';

import { organizationChoiceSchema } from '#sign-in-core/contracts/organization-membership';

export const organizationPeoplePermission = 'organization:view';

/** Pages the shell handler serves itself. Machines (`/device`) and Organization admin are shell
 * pages with their own handlers. */
export const signedInNavigationRoutes = [
	{ path: '/me', label: 'Me', permission: 'person' },
	{ path: '/people', label: 'People', permission: organizationPeoplePermission },
	// Central's ListWorkspaces checks organization:view; creating checks workspace:create.
	{ path: '/workspaces', label: 'Workspaces', permission: organizationPeoplePermission },
] as const;
export const signedInNavigationPathSchema = z.enum(
	signedInNavigationRoutes.map((route) => route.path),
);
export type SignedInNavigationPath = z.infer<typeof signedInNavigationPathSchema>;
export function isSignedInNavigationPath(pathname: string): pathname is SignedInNavigationPath {
	return signedInNavigationRoutes.some((route) => route.path === pathname);
}

export const machinesPath = '/device';
export const organizationAdminPath = '/organization-admin';

/** The sidebar's destinations, in the approved mockups' order. Machines needs machine login. */
export const signedInDestinations = [
	{ path: '/me', label: 'Me', permission: 'person' },
	{ path: '/people', label: 'People', permission: organizationPeoplePermission },
	{ path: machinesPath, label: 'Machines', permission: 'machine:enroll' },
	{ path: '/workspaces', label: 'Workspaces', permission: organizationPeoplePermission },
] as const;
export const signedInDestinationPathSchema = z.enum(
	signedInDestinations.map((destination) => destination.path),
);
export type SignedInDestinationPath = z.infer<typeof signedInDestinationPathSchema>;
export const signedInShellPageSchema = z.union([
	signedInDestinationPathSchema,
	z.literal(organizationAdminPath),
]);
export type SignedInShellPage = z.infer<typeof signedInShellPageSchema>;

export const switchboardSignOutPath = '/api/auth/switchboard/sign-out';
export const signOutFailureMessage = "Couldn't sign you out; try again";

export const signedInNavigationStateSchema = z.strictObject({
	page: signedInShellPageSchema,
	destinations: z.array(signedInDestinationPathSchema).readonly(),
	activeOrganization: organizationChoiceSchema,
	choices: z.array(organizationChoiceSchema).readonly(),
	showOrganizationAdmin: z.boolean(),
});
export type SignedInNavigationState = z.infer<typeof signedInNavigationStateSchema>;
