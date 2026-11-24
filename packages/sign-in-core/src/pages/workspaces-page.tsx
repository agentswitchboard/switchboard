/** @jsxImportSource react */
import type { WorkspacesPageState } from '#sign-in-core/contracts/organization-shell-pages';
import type { PageNonce } from '#sign-in-core/contracts/page-nonce';
import type { SignedInNavigationState } from '#sign-in-core/contracts/sign-in-navigation';
import {
	IslandRoot,
	pageDocument,
	signInPagesIslandScript,
} from '#sign-in-core/pages/page-document';
import { organizationSwitcherButton, SignedInShell } from '#sign-in-core/pages/signed-in-shell';
import { WorkspacesView } from '#sign-in-core/pages/workspace-directory';

/** The organization's workspaces, as central listed them for this request, and Create. */
export function renderWorkspacesPage(props: {
	readonly nonce: PageNonce;
	readonly navigation: SignedInNavigationState;
	readonly workspaces: WorkspacesPageState;
}): Response {
	const { nonce, navigation, workspaces } = props;
	const document = pageDocument({
		title: 'Workspaces',
		nonce,
		layout: 'shell',
		challenge: 'none',
		scripts: signInPagesIslandScript,
		children: (
			<IslandRoot
				state={{ kind: 'workspaces', navigation, workspaces }}
				fallback={
					<SignedInShell
						state={navigation}
						switcher={organizationSwitcherButton(
							navigation.activeOrganization.organizationName,
							true,
						)}
					>
						<WorkspacesView state={workspaces} />
					</SignedInShell>
				}
			/>
		),
	});
	return new Response(document.html, { headers: document.headers });
}
