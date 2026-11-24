import {
	account,
	invitation,
	member,
	passkey,
	session,
	signInAudit,
	twoFactor,
	user,
} from '@agent-collaboration/sign-in-core';
import { and, asc, eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { z } from 'zod';

import {
	controlledSignInClock,
	controlledSignInIds,
} from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { withNativeBrowserCleanup } from '#sign-in-test-support/test-fixtures/native-browser-cleanup';
import type { OrganizationBrowserScenario } from '#sign-in-test-support/test-fixtures/organization-browser-scenario';
import {
	installOrganizationBrowserCookie,
	organizationDomReady,
	tabToOrganizationControl,
} from '#sign-in-test-support/test-fixtures/organization-browser-transport';
import {
	peoplePost,
	signInConfirmedPeopleBrowser,
	signInPeopleBrowser,
} from '#sign-in-test-support/test-fixtures/people-browser-login';
import type { PlaywrightBrowserPage } from '#sign-in-test-support/test-fixtures/playwright-browser';
import { nativeNetworkResponseSchema } from '#sign-in-test-support/test-fixtures/playwright-network';

async function observePeoplePublications(
	page: PlaywrightBrowserPage,
	regionSelector: string,
	operation: 'lookup' | 'list',
	staleText: string,
): Promise<void> {
	await page.evaluate(
		`(()=>{
const region=document.querySelector(${JSON.stringify(regionSelector)});
if(!region)throw new Error('People publication region missing');
const publications=[];
let resolveStale;
const stale=new Promise(resolve=>{resolveStale=resolve;});
const capture=()=>{
 const publication=region.textContent??'';
 publications.push(publication);
 if(publication.includes(${JSON.stringify(staleText)}))resolveStale(true);
};
const dom=new MutationObserver(capture);
dom.observe(region,{childList:true,subtree:true,characterData:true});
capture();
let resolveHandled;
const handled=new Promise(resolve=>{resolveHandled=resolve;});
const outcome=new PerformanceObserver((entries)=>{
const decision=entries.getEntriesByName(${JSON.stringify('organization-people:' + operation + '-handled')})[0];
if(!decision)return;
outcome.disconnect();resolveHandled(decision.detail);
});
outcome.observe({entryTypes:['mark']});
window.peoplePublicationProbe={publications,handled,stale,close:()=>{dom.disconnect();outcome.disconnect();resolveStale(false);}};
return true;
})()`,
		z.literal(true),
	);
}

const committedPeopleReply = z.object({
	generation: z.number().int().nonnegative(),
	outcome: z.enum(['applied', 'discarded-as-stale']),
});

async function requireDiscardedOlderReply(page: PlaywrightBrowserPage): Promise<void> {
	const decision = await page.evaluate(
		'window.peoplePublicationProbe.handled',
		committedPeopleReply,
	);
	expect(decision.outcome).toBe('discarded-as-stale');
}

async function requireFreshPeoplePublication(
	page: PlaywrightBrowserPage,
	publishNewer: () => Promise<void>,
): Promise<void> {
	const stalePublication = page
		.evaluate('window.peoplePublicationProbe.stale', z.boolean())
		.then((published): void => {
			if (published) throw new Error('Stale People reply was published');
		});
	await Promise.race([publishNewer(), stalePublication]);
}

async function closePeoplePublications(page: PlaywrightBrowserPage): Promise<void> {
	if (page.page.isClosed()) return;
	await page.evaluate('window.peoplePublicationProbe.close(); true', z.literal(true));
}

const lookupPath = '/api/auth/organization/person-membership';
const listPath = '/api/auth/organization/people-list';
const lookupField = 'input[type="email"]';
const resultRegion = '[aria-label="Membership result"]';
const nativeReads = ['list', 'get-full-organization', 'list-members', 'list-invitations'];

async function readPeopleTables(context: OrganizationBrowserScenario): Promise<readonly unknown[]> {
	return Promise.all([
		context.harness.database.select().from(user),
		context.harness.database.select().from(member),
		context.harness.database.select().from(invitation),
		context.harness.database.select().from(session),
		context.harness.database.select().from(twoFactor),
		context.harness.database.select().from(passkey),
		context.harness.database.select().from(signInAudit),
	]);
}

async function expectLookup(context: OrganizationBrowserScenario, text: string): Promise<void> {
	await organizationDomReady(
		context.page,
		`document.querySelector(${JSON.stringify(resultRegion)})?.textContent===${JSON.stringify(text)}`,
	);
	expect(
		await context.page.evaluate(
			`document.querySelector(${JSON.stringify(resultRegion)})?.textContent`,
			z.string(),
		),
	).toBe(text);
}

async function lookUp(context: OrganizationBrowserScenario, email: string): Promise<void> {
	await context.page.enter(lookupField, email);
	await context.page.click('button', 'Look up');
}

async function memberEmails(context: OrganizationBrowserScenario): Promise<readonly string[]> {
	return context.page.evaluate(
		`Array.from(document.querySelectorAll('table[aria-label="Members"] tbody tr')).map(row=>row.cells[1].textContent.trim())`,
		z.array(z.string()),
	);
}

/** V6 uses 101 members, independently of V5's 51-member API pagination fixture. */
export async function exerciseOrganizationPeople(
	context: OrganizationBrowserScenario,
): Promise<void> {
	const { harness, page, responses } = context;
	const ownerCookie = harness.cookie();
	expect(
		(
			await peoplePost(
				harness,
				'set-active',
				{ organizationId: context.firstOrganizationId },
				ownerCookie,
			)
		).status,
	).toBe(200);
	// Native setup for the member who later signs in: an email-only seeded user cannot
	// implicitly acquire a provider account under the production linking policy.
	const nativeMemberEmail = 'browser-member-001@example.invalid';
	const invited = await peoplePost(
		harness,
		'invite-member',
		{
			organizationId: context.firstOrganizationId,
			email: nativeMemberEmail,
			role: 'member',
		},
		ownerCookie,
	);
	expect(invited.status).toBe(200);
	const invitationId = z.object({ id: z.uuidv7() }).parse(await invited.json()).id;
	const nativeMemberId = await signInConfirmedPeopleBrowser({ harness, email: nativeMemberEmail });
	expect((await peoplePost(harness, 'accept-invitation', { invitationId })).status).toBe(200);
	expect(
		await harness.database
			.select({ organizationId: member.organizationId, role: member.role })
			.from(member)
			.where(eq(member.userId, nativeMemberId)),
	).toEqual([{ organizationId: context.firstOrganizationId, role: 'member' }]);
	expect(
		await harness.database
			.select({ providerId: account.providerId })
			.from(account)
			.where(eq(account.userId, nativeMemberId)),
	).toEqual([{ providerId: 'google' }]);
	expect(
		await harness.database
			.select({ status: invitation.status })
			.from(invitation)
			.where(eq(invitation.id, invitationId)),
	).toEqual([{ status: 'accepted' }]);
	harness.useBrowser('owner@example.invalid');
	const members = Array.from({ length: 99 }, (_, index) => ({
		id: controlledSignInIds.nextId(),
		name: `Browser member ${String(index + 2).padStart(3, '0')}`,
		email: `browser-member-${String(index + 2).padStart(3, '0')}@example.invalid`,
		createdAt: new Date(controlledSignInClock.now() + index + 1),
	}));
	// The other 99 members supply list volume only; they never sign in.
	await members.reduce(
		async (previous: Promise<void>, person: (typeof members)[number]): Promise<void> => {
			await previous;
			// Inserts stay below D1's parameter limit and preserve the intended join order.
			await harness.database
				.insert(user)
				.values({ ...person, emailVerified: true, updatedAt: person.createdAt });
			await harness.database.insert(member).values({
				id: controlledSignInIds.nextId(),
				userId: person.id,
				organizationId: context.firstOrganizationId,
				role: 'member',
				createdAt: person.createdAt,
			});
		},
		Promise.resolve(),
	);
	await harness.database.insert(invitation).values({
		id: controlledSignInIds.nextId(),
		organizationId: context.firstOrganizationId,
		email: 'browser-invited@example.invalid',
		role: 'member',
		status: 'pending',
		expiresAt: new Date(controlledSignInClock.now() + 86_400_000),
		createdAt: new Date(controlledSignInClock.now()),
		inviterId: context.ownerPersonId,
	});
	const expected = await harness.database
		.select({ name: user.name, email: user.email, role: member.role })
		.from(member)
		.innerJoin(user, eq(member.userId, user.id))
		.where(eq(member.organizationId, context.firstOrganizationId))
		.orderBy(asc(member.createdAt), asc(member.id));
	expect(expected).toHaveLength(101);
	const beforeReads = await readPeopleTables(context);
	// The pre-shell People page; the shell's /people is proven by the navigation journeys.
	const peoplePath = `/api/auth/organization/people?organizationId=${context.firstOrganizationId}`;
	await page.afterNavigation('/api/auth/organization/people', async (): Promise<void> =>
		page.navigate(`${harness.issuer}${peoplePath}`),
	);
	await organizationDomReady(
		page,
		`document.querySelectorAll('table[aria-label="Members"] tbody tr').length===50`,
	);
	const visible = await page.evaluate(
		`Array.from(document.querySelectorAll('table[aria-label="Members"] tbody tr')).map(row=>Array.from(row.cells).map(cell=>cell.textContent.trim()))`,
		z.array(z.array(z.string())),
	);
	expect(visible).toEqual(
		expected
			.slice(0, 50)
			.map((person) => [person.name, person.email, person.role === 'owner' ? 'Owner' : 'Member']),
	);
	expect(
		await page.evaluate(
			`Array.from(document.querySelectorAll('table[aria-label="Invitations"] tbody tr')).map(row=>Array.from(row.cells).map(cell=>cell.textContent.trim()))`,
			z.array(z.array(z.string())),
		),
	).toEqual([['browser-invited@example.invalid', 'Member', 'Invited']]);
	await tabToOrganizationControl({ page, selector: 'button', label: 'Next' });
	await page.click('button', 'Next');
	await organizationDomReady(
		page,
		`document.querySelector('table[aria-label="Members"]')?.textContent.includes(${JSON.stringify(expected[50]?.email)})`,
	);
	expect(await memberEmails(context)).toEqual(
		expected.slice(50, 100).map((person) => person.email),
	);
	await page.click('button', 'Previous');
	await organizationDomReady(
		page,
		`document.querySelector('table[aria-label="Members"]')?.textContent.includes(${JSON.stringify(expected[0]?.email)})`,
	);
	const ownerEmail = expected.find((person) => person.role === 'owner')?.email;
	if (ownerEmail === undefined) throw new Error('Owner missing from first page');
	await page.click(
		`table[aria-label="Members"] tbody tr:has(button[aria-label="Look up ${ownerEmail}"]) td:first-child`,
	);
	await expectLookup(context, 'Member · Owner');
	await lookUp(context, 'browser-invited@example.invalid');
	await expectLookup(context, 'Invited');
	await lookUp(context, 'browser-absent@example.invalid');
	await expectLookup(context, 'Not a member');
	await page.enter(lookupField, 'invalid-email');
	expect(
		await page.evaluate(
			`document.querySelector(${JSON.stringify(resultRegion)})?.textContent??''`,
			z.string(),
		),
	).toBe('');
	const beforeInvalid = context.requestedPaths.filter((pathname) => pathname === lookupPath).length;
	await page.click('button', 'Look up');
	expect(context.requestedPaths.filter((pathname) => pathname === lookupPath)).toHaveLength(
		beforeInvalid,
	);
	// Both races hold the real computed reply at Chrome's response boundary.
	const firstReply = responses.arm((url): boolean => url.pathname === lookupPath);
	await lookUp(context, 'browser-invited@example.invalid');
	const firstHeld = await firstReply;
	expect(firstHeld.responseStatusCode).toBe(200);
	const beforeDuplicate = context.requestedPaths.filter(
		(pathname) => pathname === lookupPath,
	).length;
	await page.evaluate(
		`(()=>{const button=Array.from(document.querySelectorAll('button')).find(node=>node.textContent.trim()==='Look up');button.click();return true;})()`,
		z.literal(true),
	);
	const newerLookupReply = responses.arm((url): boolean => url.pathname === lookupPath);
	await lookUp(context, 'browser-absent@example.invalid');
	const newerLookupHeld = await newerLookupReply;
	expect(newerLookupHeld.responseStatusCode).toBe(200);
	expect(newerLookupHeld.networkId).not.toBe(firstHeld.networkId);
	expect(context.requestedPaths.filter((pathname) => pathname === lookupPath)).toHaveLength(
		beforeDuplicate + 1,
	);
	await observePeoplePublications(page, resultRegion, 'lookup', 'Invited');
	await withNativeBrowserCleanup(
		async (): Promise<void> => {
			// The newer reply stays held until the component has processed the older reply.
			await responses.release(firstHeld);
			await requireDiscardedOlderReply(page);
			const whileNewerLookupPending = await page.evaluate(
				`({current:document.querySelector(${JSON.stringify(resultRegion)})?.textContent,publications:window.peoplePublicationProbe.publications})`,
				z.object({ current: z.string(), publications: z.array(z.string()) }),
			);
			expect(whileNewerLookupPending.current).toBe('Looking up…');
			expect(whileNewerLookupPending.publications).not.toContain('Invited');
			await responses.release(newerLookupHeld);
			await requireFreshPeoplePublication(page, () => expectLookup(context, 'Not a member'));
			expect(
				await page.evaluate(
					`document.querySelector(${JSON.stringify(resultRegion)})?.textContent`,
					z.string(),
				),
			).toBe('Not a member');
			expect(
				await page.evaluate('window.peoplePublicationProbe.publications', z.array(z.string())),
			).not.toContain('Invited');
		},
		() => closePeoplePublications(page),
	);
	const editReply = responses.arm((url): boolean => url.pathname === lookupPath);
	await lookUp(context, 'browser-invited@example.invalid');
	const editHeld = await editReply;
	await page.enter(lookupField, 'edited@example.invalid');
	await responses.release(editHeld);
	await page.readyWhen(`document.querySelector(${JSON.stringify(resultRegion)})?.textContent===''`);
	expect(
		await page.evaluate(
			`document.querySelector(${JSON.stringify(resultRegion)})?.textContent`,
			z.string(),
		),
	).toBe('');
	await lookUp(context, 'browser-invited@example.invalid');
	await expectLookup(context, 'Invited');
	const armed = await harness.auth('/__auth-proof/database-control', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			kind: 'fault',
			fault: {
				operation: 'select',
				table: 'member',
				key: context.firstOrganizationId,
				additionalKeys: [],
				projection: 'membership-facts',
				once: true,
			},
		}),
	});
	expect(armed.status).toBe(200);
	try {
		const failed = await page.responseTo(lookupPath, async (): Promise<void> =>
			lookUp(context, ownerEmail),
		);
		expect(failed.response.status).toBe(503);
		await expectLookup(context, 'Lookup unavailable. Try again.');
	} finally {
		expect(
			(
				await harness.auth('/__auth-proof/database-control', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ kind: 'fault', fault: null }),
				})
			).status,
		).toBe(200);
	}
	const page50Reply = responses.arm(
		(url): boolean => url.pathname === listPath && url.searchParams.get('offset') === '50',
	);
	await page.click('button', 'Next');
	const page50Held = await page50Reply;
	expect(page50Held.responseStatusCode).toBe(200);
	const page100Reply = responses.arm(
		(url): boolean => url.pathname === listPath && url.searchParams.get('offset') === '100',
	);
	await page.click('button', 'Next');
	const page100Held = await page100Reply;
	expect(page100Held.responseStatusCode).toBe(200);
	expect(page100Held.networkId).not.toBe(page50Held.networkId);
	// Arm for this exact held request before either response is released.
	const page100Response = page.network.armResponse((value): boolean => {
		const parsed = nativeNetworkResponseSchema.safeParse(value);
		if (!parsed.success || parsed.data.requestId !== page100Held.networkId) return false;
		const responseUrl = new URL(parsed.data.response.url);
		return responseUrl.pathname === listPath && responseUrl.searchParams.get('offset') === '100';
	});
	const olderPageEmail = expected[50]?.email;
	if (olderPageEmail === undefined) throw new Error('Page-50 fixture absent');
	await observePeoplePublications(page, 'table[aria-label="Members"]', 'list', olderPageEmail);
	await withNativeBrowserCleanup(
		async (): Promise<void> => {
			await responses.release(page50Held);
			await requireDiscardedOlderReply(page);
			const whilePage100Pending = await page.evaluate(
				`({loading:!!document.querySelector('table[aria-label="Members"] [aria-label="Loading people"]'),emails:Array.from(document.querySelectorAll('table[aria-label="Members"] tbody button')).map(button=>button.textContent.trim()),publications:window.peoplePublicationProbe.publications})`,
				z.object({
					loading: z.boolean(),
					emails: z.array(z.string()),
					publications: z.array(z.string()),
				}),
			);
			expect(whilePage100Pending.loading).toBe(true);
			expect(whilePage100Pending.emails).toEqual([]);
			expect(whilePage100Pending.publications.join('\n')).not.toContain(olderPageEmail);
			await responses.release(page100Held);
			const page100 = nativeNetworkResponseSchema.parse(await page100Response.completed);
			expect(page100.requestId).toBe(page100Held.networkId);
			expect(new URL(page100.response.url).searchParams.get('offset')).toBe('100');
			await requireFreshPeoplePublication(page, () =>
				organizationDomReady(
					page,
					`document.querySelectorAll('table[aria-label="Members"] tbody tr').length===1`,
				),
			);
			expect(await memberEmails(context)).toEqual(
				expected.slice(100).map((person) => person.email),
			);
			const publications = await page.evaluate(
				'window.peoplePublicationProbe.publications',
				z.array(z.string()),
			);
			expect(publications.join('\n')).not.toContain(olderPageEmail);
		},
		() => closePeoplePublications(page),
	);
	const layout = await page.evaluate(
		`({headingCount:document.querySelectorAll('h1').length,overflow:document.documentElement.scrollWidth>innerWidth,dark:document.documentElement.classList.contains('dark')&&matchMedia('(prefers-color-scheme: dark)').matches,roleControls:document.querySelectorAll('select,[role="combobox"]').length,mutations:Array.from(document.querySelectorAll('button,input,select,a')).map(node=>({label:node.getAttribute('aria-label')||node.textContent||'',tag:node.tagName})).filter(item=>/^(Invite|Remove|Change role|Edit role)/i.test(item.label.trim()))})`,
		z.object({
			headingCount: z.literal(1),
			overflow: z.literal(false),
			dark: z.literal(true),
			roleControls: z.literal(0),
			mutations: z.array(z.unknown()).length(0),
		}),
	);
	expect(layout.headingCount).toBe(1);
	await tabToOrganizationControl({ page, selector: lookupField });
	await tabToOrganizationControl({ page, selector: 'button[type="submit"]' });
	await tabToOrganizationControl({
		page,
		selector: 'button',
		label: 'Previous',
	});
	await context.capture('people-dark-400');
	expect(
		await Promise.all(
			nativeReads.map(
				async (route: string): Promise<number> =>
					(
						await harness.auth(`/api/auth/organization/${route}`, {
							headers: { cookie: ownerCookie },
						})
					).status,
			),
		),
	).toEqual([404, 404, 404, 404]);
	expect(await readPeopleTables(context)).toEqual(beforeReads);
	// A genuine member session: the pre-shell People page keeps its own permission gate.
	expect(await signInPeopleBrowser({ harness, email: nativeMemberEmail })).toBe(nativeMemberId);
	expect(
		await harness.database
			.select({ role: member.role })
			.from(member)
			.where(
				and(
					eq(member.organizationId, context.firstOrganizationId),
					eq(member.userId, nativeMemberId),
				),
			),
	).toEqual([{ role: 'member' }]);
	expect(
		(
			await harness.auth('/api/auth/organization/set-active', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ organizationId: context.firstOrganizationId }),
			})
		).status,
	).toBe(200);
	await installOrganizationBrowserCookie({
		page,
		issuer: harness.issuer,
		cookie: harness.cookie(),
	});
	// Organization admin is a shell page: a member whose second factor is unconfirmed in this
	// session is sent to finish signing in, and is never offered People there.
	const memberAdmin = await harness.auth('/organization-admin', {
		headers: { cookie: harness.cookie() },
		redirect: 'manual',
	});
	expect(memberAdmin.status).toBe(303);
	expect(new URL(memberAdmin.headers.get('location') ?? 'invalid:', harness.issuer).pathname).toBe(
		'/owner-ready',
	);
	const denied = await page.responseTo('/api/auth/organization/people', () =>
		page.navigate(`${harness.issuer}${peoplePath}`),
	);
	expect(denied.response.status).toBe(403);
	expect(
		await Promise.all(
			nativeReads.map(
				async (route: string): Promise<number> =>
					(await harness.auth(`/api/auth/organization/${route}`)).status,
			),
		),
	).toEqual([404, 404, 404, 404]);
}
