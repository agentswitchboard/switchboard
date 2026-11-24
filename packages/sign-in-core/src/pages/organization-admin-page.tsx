/** @jsxImportSource react */
import type { OrganizationAdminPageState } from '#sign-in-core/contracts/organization-shell-pages';
import { mintPageNonce } from '#sign-in-core/contracts/page-nonce';
import type { SignedInNavigationState } from '#sign-in-core/contracts/sign-in-navigation';
import type { SignInCrypto } from '#sign-in-core/contracts/sign-in-platform';
import { OrganizationAdminFallback } from '#sign-in-core/pages/organization-admin-view';
import {
	IslandRoot,
	pageDocument,
	signInPagesIslandScript,
} from '#sign-in-core/pages/page-document';
import { organizationSwitcherButton, SignedInShell } from '#sign-in-core/pages/signed-in-shell';

/**
 * The owner's organization page in the shell: the organization's identity and Fleet setup, and
 * its change records. It holds no token or key; each read posts to a cookie-only forwarding
 * route, and the server signs central's request.
 */
export function renderOrganizationAdminPage(props: {
	readonly crypto: SignInCrypto;
	readonly navigation: SignedInNavigationState;
	readonly admin: OrganizationAdminPageState;
}): Response {
	const { navigation, admin } = props;
	const document = pageDocument({
		title: 'Organization admin',
		nonce: mintPageNonce(props.crypto),
		layout: 'shell',
		challenge: 'none',
		scripts: signInPagesIslandScript,
		children: (
			<IslandRoot
				state={{ kind: 'organization-admin', navigation, admin }}
				fallback={
					<SignedInShell
						state={navigation}
						switcher={organizationSwitcherButton(
							navigation.activeOrganization.organizationName,
							true,
						)}
					>
						<OrganizationAdminFallback organization={navigation.activeOrganization} state={admin} />
					</SignedInShell>
				}
			/>
		),
	});
	return new Response(document.html, { headers: document.headers });
}
