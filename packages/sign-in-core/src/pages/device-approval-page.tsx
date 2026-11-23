/** @jsxImportSource react */
import { Button, Card, CardContent } from '@agent-collaboration/tool-access-ui/server';

import type { DeviceApprovalPageState } from '#sign-in-core/contracts/device-approval-state';
import type { PageNonce } from '#sign-in-core/contracts/page-nonce';
import type { SignedInNavigationState } from '#sign-in-core/contracts/sign-in-navigation';
import { DeviceApproval } from '#sign-in-core/pages/islands/device-approval';
import {
	IslandRoot,
	pageDocument,
	signInPagesIslandScript,
} from '#sign-in-core/pages/page-document';
import { organizationSwitcherButton, SignedInShell } from '#sign-in-core/pages/signed-in-shell';

export function renderDeviceApprovalPage(props: {
	readonly nonce: PageNonce;
	readonly navigation: SignedInNavigationState;
	readonly device: DeviceApprovalPageState;
}): Response {
	const { nonce, navigation, device } = props;
	const document = pageDocument({
		title: 'Approve a machine login',
		nonce,
		layout: 'shell',
		challenge: 'none',
		scripts: signInPagesIslandScript,
		children: (
			<IslandRoot
				state={{ kind: 'device-approval', navigation, device }}
				fallback={
					<SignedInShell
						state={navigation}
						switcher={organizationSwitcherButton(
							navigation.activeOrganization.organizationName,
							true,
						)}
					>
						<DeviceApproval state={device} interactive={false} />
					</SignedInShell>
				}
			/>
		),
	});
	return new Response(document.html, { headers: document.headers });
}

export function renderDeviceApprovalSignIn(props: {
	readonly nonce: PageNonce;
	readonly userCode: string | null;
}): Response {
	const signInLocation =
		props.userCode === null ? '/sign-in' : `/sign-in?device=${encodeURIComponent(props.userCode)}`;
	const document = pageDocument({
		title: 'Approve a machine login',
		nonce: props.nonce,
		challenge: 'none',
		scripts: '',
		children: (
			<Card>
				<CardContent>
					<Button nativeButton={false} render={<a href={signInLocation} />}>
						Sign in to approve this machine
					</Button>
				</CardContent>
			</Card>
		),
	});
	return new Response(document.html, { headers: document.headers });
}
