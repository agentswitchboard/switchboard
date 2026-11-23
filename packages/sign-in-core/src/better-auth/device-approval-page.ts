import { organizationChoiceAllows } from '#sign-in-core/better-auth/organization-permission-check';
import type { SignInProvider } from '#sign-in-core/better-auth/provider-configuration';
import type { SignInHttpConfiguration } from '#sign-in-core/better-auth/sign-in-http-handler';
import { readSignedInNavigationAccount } from '#sign-in-core/better-auth/sign-in-navigation';
import type { DeviceApprovalPageState } from '#sign-in-core/contracts/device-approval-state';
import { mintPageNonce } from '#sign-in-core/contracts/page-nonce';
import { signedInNavigationRoutes } from '#sign-in-core/contracts/sign-in-navigation';
import { uuid7Schema } from '#sign-in-core/contracts/sign-in-platform';
import { deviceApprovalClaimSchema } from '#sign-in-core/machine-login/device-approval-claim';
import { parseDeviceUserCode } from '#sign-in-core/machine-login/device-user-code';
import {
	renderDeviceApprovalPage,
	renderDeviceApprovalSignIn,
} from '#sign-in-core/pages/device-approval-page';
import {
	listPendingDeviceCodesForApprover,
	readDeviceCodeForPage,
} from '#sign-in-core/storage/device-code-store';

export async function respondToDeviceApprovalPage(props: {
	readonly request: Request;
	readonly provider: SignInProvider;
	readonly configuration: SignInHttpConfiguration;
	readonly signIn: (request: Request) => Promise<Response>;
}): Promise<Response> {
	const { request, configuration } = props;
	const machineLogin = configuration.configuration.machineLogin;
	if (machineLogin === undefined) return new Response(null, { status: 404 });
	const userCode = parseDeviceUserCode(new URL(request.url).searchParams.get('user_code'));
	const nonce = mintPageNonce(configuration.platform.crypto);
	if (request.headers.has('authorization'))
		return Response.json({ error: 'access_denied' }, { status: 403 });
	const session = await props.provider.api.readShellSession({ headers: request.headers });
	const account = await readSignedInNavigationAccount({
		session,
		store: configuration.store,
		clock: configuration.platform.clock,
	});
	if (account === null || session.kind !== 'session')
		return renderDeviceApprovalSignIn({ nonce, userCode });
	const active = account.activeOrganization;
	if (active === null)
		return new Response(null, {
			status: 303,
			headers: {
				location:
					userCode === null
						? '/owner-ready'
						: `/owner-ready?device=${encodeURIComponent(userCode)}`,
				'cache-control': 'no-store',
			},
		});
	const permitted = organizationChoiceAllows(active.role, 'machine:enroll');
	function render(device: DeviceApprovalPageState): Response {
		if (account === null || active === null) throw new Error('Missing approval navigation');
		return renderDeviceApprovalPage({
			nonce,
			navigation: {
				page: '/device',
				activeOrganization: active,
				choices: account.choices,
				destinations: signedInNavigationRoutes
					.filter(
						(route) =>
							route.permission === 'person' ||
							organizationChoiceAllows(active.role, route.permission),
					)
					.map((route) => route.path),
				showOrganizationAdmin: active.role === 'owner',
				showMachines: permitted,
			},
			device,
		});
	}
	if (!permitted)
		return render({ kind: 'refused', refusal: 'not-permitted', userCode: userCode ?? '' });
	if (userCode === null)
		return render({
			kind: 'enter',
			pending: await listPendingDeviceCodesForApprover({
				openDatabase: configuration.openDatabase,
				organizationId: active.organizationId,
				approver: session.value.user.id,
				routerClientId: machineLogin.routerClientId,
				now: configuration.platform.clock.now(),
			}),
		});

	const verify = new URL('/api/auth/device', configuration.configuration.issuer);
	verify.searchParams.set('user_code', userCode);
	const verified = await props.signIn(new Request(verify, { headers: request.headers }));
	await verified.body?.cancel();
	if (verified.status === 401) return renderDeviceApprovalSignIn({ nonce, userCode });
	if (verified.status === 403)
		return render({ kind: 'refused', refusal: 'not-permitted', userCode });
	if (verified.status >= 500 || verified.status === 429)
		return render({ kind: 'refused', refusal: 'unavailable', userCode });

	// Read only the safe display fields after the native verify claimed the code for this person.
	const stored = await readDeviceCodeForPage({
		openDatabase: configuration.openDatabase,
		userCode,
	});
	if (
		stored === null ||
		stored.clientId !== machineLogin.routerClientId ||
		stored.userId !== session.value.user.id ||
		stored.expiresAt.getTime() <= configuration.platform.clock.now()
	)
		return render({ kind: 'refused', refusal: 'expired', userCode });
	if (stored.organizationId !== active.organizationId)
		return render({ kind: 'refused', refusal: 'not-permitted', userCode });

	const facts = {
		userCode,
		machineLabel: stored.machineLabel,
		organizationName: active.organizationName,
	};
	if (stored.status === 'approved') return render({ kind: 'approved', ...facts });
	if (stored.status !== 'pending' || !verified.ok)
		return render({ kind: 'refused', refusal: 'expired', userCode });
	if (stored.decisionClaim !== null) {
		const { selection } = deviceApprovalClaimSchema.parse(JSON.parse(stored.decisionClaim));
		return render({
			kind: 'recovering',
			...facts,
			machineLabel: selection.label,
			allowedWorkspaces: selection.allowedWorkspaces,
		});
	}
	const listed = await configuration.listWorkspaces?.({
		request,
		organizationId: stored.organizationId,
	});
	return render({
		kind: 'review',
		...facts,
		workspaces:
			listed?.result === 'workspaces'
				? listed.workspaces
						.filter((workspace) => workspace.state === 'active')
						.map(({ name, workspaceId }) => ({
							name,
							workspaceId: uuid7Schema.parse(workspaceId),
						}))
				: null,
	});
}
