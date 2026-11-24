import type { FactorPageState } from '#sign-in-core/better-auth/factor-enrollment-page';
import { organizationChoiceAllows } from '#sign-in-core/better-auth/organization-permission-check';
import type { SignInProvider } from '#sign-in-core/better-auth/provider-configuration';
import { requireStoredValue } from '#sign-in-core/better-auth/store-result-adapters';
import type { ListWorkspaces } from '#sign-in-core/central-link/list-workspaces';
import type { OrganizationChoice } from '#sign-in-core/contracts/organization-membership';
import { mintPageNonce } from '#sign-in-core/contracts/page-nonce';
import {
	machinesPath,
	organizationAdminPath,
	signedInDestinations,
	type SignedInDestinationPath,
	type SignedInNavigationPath,
	type SignedInNavigationState,
	type SignedInShellPage,
} from '#sign-in-core/contracts/sign-in-navigation';
import { uuid7Schema, type SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';
import {
	readPersonOrganizationContext,
	type OrganizationSessionView,
} from '#sign-in-core/organizations/person-organization-context';
import { renderSignedInNavigationPage } from '#sign-in-core/pages/signed-in-navigation-page';
import { renderWorkspacesPage } from '#sign-in-core/pages/workspaces-page';
import { decideRecentSecondFactor } from '#sign-in-core/second-factors/second-factor-step-up';
import { personIdSchema, type SignInStore } from '#sign-in-core/storage/models/sign-in-store';

interface SignedInNavigationAccount {
	readonly choices: readonly OrganizationChoice[];
	readonly activeOrganization: OrganizationChoice | null;
	readonly factorPage: FactorPageState;
	readonly email: string;
}

export async function readSignedInNavigationAccount(props: {
	readonly session: OrganizationSessionView;
	readonly store: Pick<SignInStore, 'organizations' | 'factors'>;
	readonly clock: SignInPlatform['clock'];
}): Promise<SignedInNavigationAccount | null> {
	const { session } = props;
	if (session.kind === 'unavailable') throw new Error('Session unavailable');
	if (session.kind === 'signed-out') return null;

	const [organization, factors] = await Promise.all([
		readPersonOrganizationContext({ session, store: props.store.organizations }),
		props.store.factors.readSession(
			personIdSchema.parse(session.value.user.id),
			session.value.session.id,
		),
	]);
	if (organization.kind !== 'available') throw new Error('Organization context unavailable');
	const storedFactors = requireStoredValue(factors);
	const factorPage =
		storedFactors === null
			? 'hidden'
			: storedFactors.enrollment.kind === 'never-enrolled'
				? 'enroll-app'
				: decideRecentSecondFactor({
							now: props.clock.now(),
							confirmation: storedFactors.confirmation,
					  }).kind === 'confirmed'
					? 'confirmed'
					: 'confirm';
	return {
		choices: organization.choices,
		activeOrganization:
			organization.choices.find(
				(choice) => choice.organizationId === organization.activeOrganizationId,
			) ?? null,
		factorPage,
		email: session.value.user.email,
	};
}

export function hasPendingSignInContinuation(url: URL): boolean {
	return url.searchParams.has('authorize') || url.searchParams.has('client_id');
}

/** The link on the setup page and direct shell requests use the same facts. */
export function signedInNavigationMembership(
	account: SignedInNavigationAccount | null,
	url: URL,
): OrganizationChoice | null {
	if (account?.factorPage !== 'confirmed' || hasPendingSignInContinuation(url)) return null;
	return account.activeOrganization;
}

function redirectToSignInStep(location: string): Response {
	return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

function refusedShellPage(): Response {
	return Response.json(
		{ kind: 'refused' },
		{ status: 403, headers: { 'cache-control': 'no-store' } },
	);
}

/** The sidebar's destinations for a role, from the same native statements every page checks. */
export function signedInDestinationsFor(
	role: OrganizationChoice['role'],
	machineLoginEnabled: boolean,
): readonly SignedInDestinationPath[] {
	return signedInDestinations
		.filter(
			(destination) =>
				(destination.path !== machinesPath || machineLoginEnabled) &&
				(destination.permission === 'person' ||
					organizationChoiceAllows(role, destination.permission)),
		)
		.map((destination) => destination.path);
}

/** Organization admin keeps today's menu rule: owners of the active organization. */
export function showsOrganizationAdmin(role: OrganizationChoice['role']): boolean {
	return role === 'owner';
}

export function signedInNavigationState(props: {
	readonly page: SignedInShellPage;
	readonly account: SignedInNavigationAccount;
	readonly activeOrganization: OrganizationChoice;
	readonly machineLoginEnabled: boolean;
}): SignedInNavigationState {
	return {
		page: props.page,
		activeOrganization: props.activeOrganization,
		choices: props.account.choices,
		destinations: signedInDestinationsFor(props.activeOrganization.role, props.machineLoginEnabled),
		showOrganizationAdmin: showsOrganizationAdmin(props.activeOrganization.role),
	};
}

export type SignedInShellEntry =
	| { readonly kind: 'answered'; readonly response: Response }
	| {
			readonly kind: 'entered';
			readonly state: SignedInNavigationState;
			readonly personId: string;
	  };

/**
 * One gate for every shell page: no authorization header, a live verified session, the
 * readiness predicate (N7), and the page permitted to the active role. Anything else is
 * answered here, so a hidden link is never the only guard.
 */
export async function enterSignedInShell(props: {
	readonly page: SignedInShellPage;
	readonly url: URL;
	readonly headers: Headers;
	readonly provider: SignInProvider;
	readonly store: Pick<SignInStore, 'organizations' | 'factors'>;
	readonly platform: Pick<SignInPlatform, 'clock'>;
	readonly machineLoginEnabled: boolean;
}): Promise<SignedInShellEntry> {
	if (props.headers.has('authorization')) return { kind: 'answered', response: refusedShellPage() };
	const session = await props.provider.api.readShellSession({ headers: props.headers });
	const account = await readSignedInNavigationAccount({
		session,
		store: props.store,
		clock: props.platform.clock,
	});
	if (account === null || session.kind !== 'session')
		return { kind: 'answered', response: redirectToSignInStep('/sign-in') };
	const activeOrganization = signedInNavigationMembership(account, props.url);
	if (activeOrganization === null)
		return {
			kind: 'answered',
			response: redirectToSignInStep(`/owner-ready${props.url.search}`),
		};
	const state = signedInNavigationState({
		page: props.page,
		account,
		activeOrganization,
		machineLoginEnabled: props.machineLoginEnabled,
	});
	const permitted =
		props.page === organizationAdminPath
			? state.showOrganizationAdmin
			: state.destinations.includes(props.page);
	if (!permitted) return { kind: 'answered', response: refusedShellPage() };
	return { kind: 'entered', state, personId: session.value.user.id };
}

export async function respondToSignedInNavigation(props: {
	readonly page: SignedInNavigationPath;
	readonly request: Request;
	readonly url: URL;
	readonly provider: SignInProvider;
	readonly store: SignInStore;
	readonly platform: SignInPlatform;
	readonly machineLoginEnabled: boolean;
	readonly listWorkspaces: ListWorkspaces | undefined;
}): Promise<Response> {
	const entry = await enterSignedInShell({ ...props, headers: props.request.headers });
	if (entry.kind === 'answered') return entry.response;
	const nonce = mintPageNonce(props.platform.crypto);
	if (props.page !== '/workspaces')
		return renderSignedInNavigationPage({ nonce, state: entry.state });
	const active = entry.state.activeOrganization;
	const listed = await props.listWorkspaces?.({
		request: props.request,
		organizationId: active.organizationId,
	});
	return renderWorkspacesPage({
		nonce,
		navigation: entry.state,
		workspaces: {
			directory:
				listed === undefined
					? { kind: 'unavailable' }
					: listed.result === 'workspaces'
						? {
								kind: 'listed',
								workspaces: listed.workspaces.map(({ workspaceId, name, state }) => ({
									workspaceId,
									name,
									state,
								})),
							}
						: { kind: listed.result },
			canCreate: organizationChoiceAllows(active.role, 'workspace:create'),
			operationId: uuid7Schema.parse(props.platform.ids.nextId()),
		},
	});
}

/** The account page is a landing only mid-flow; a ready person goes into the shell. */
export function accountPageLandsInShell(
	account: SignedInNavigationAccount | null,
	url: URL,
): boolean {
	return signedInNavigationMembership(account, url) !== null && !url.searchParams.has('device');
}
