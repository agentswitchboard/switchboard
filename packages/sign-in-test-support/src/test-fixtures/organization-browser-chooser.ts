import { member, session } from '@agent-collaboration/sign-in-core';
import { organizationPersonTokenClaimsSchema } from '@agent-collaboration/sign-in-core/person-identity';
import { and, eq } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { expect, vi } from 'vitest';
import { z } from 'zod';

import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { readCurrentBrowserSession } from '#sign-in-test-support/test-fixtures/current-browser-session';
import { loginThroughNativeOwnerCli } from '#sign-in-test-support/test-fixtures/native-cli-proof';
import type { OrganizationBrowserScenario } from '#sign-in-test-support/test-fixtures/organization-browser-scenario';
import {
	installOrganizationBrowserCookie,
	organizationBrowserCookie,
	organizationDomReady,
	observeOrganizationEnterGesture,
	tabToOrganizationControl,
} from '#sign-in-test-support/test-fixtures/organization-browser-transport';

const switchPath = '/api/auth/organization/set-active';
const continueButton = '#owner-sign-in button';

function recordChooserPhase(
	phase:
		| 'first-gesture'
		| 'first-release'
		| 'first-dom-ready'
		| 'second-choice-click'
		| 'second-response'
		| 'continue',
	state: 'started' | 'completed' | 'waiting-for-response' | 'received',
): void {
	process.stdout.write(
		`${JSON.stringify({ event: 'organization-chooser-phase', phase, state })}\n`,
	);
}

async function currentSession(context: OrganizationBrowserScenario): Promise<{
	readonly id: string;
	readonly activeOrganizationId: string | null;
	readonly secondFactorAt: number | null;
	readonly secondFactorMethod: string | null;
}> {
	const browser = await readCurrentBrowserSession({
		cookie: await organizationBrowserCookie(context.page, context.harness.issuer),
		database: context.harness.database,
	});
	const rows = await context.harness.database
		.select({
			id: session.id,
			activeOrganizationId: session.activeOrganizationId,
			secondFactorAt: session.secondFactorAt,
			secondFactorMethod: session.secondFactorMethod,
		})
		.from(session)
		.where(eq(session.id, browser.id));
	const row = rows[0];
	if (row === undefined) throw new Error('Native Chrome session disappeared');
	return row;
}

async function chooseOrganization(
	context: OrganizationBrowserScenario,
	organizationId: string,
	tracePhase?: 'second-choice',
): Promise<void> {
	await organizationDomReady(
		context.page,
		`!!document.querySelector('[data-sign-in-island-mounted] #choose-organization')`,
	);
	const response = await context.page.responseTo(switchPath, async (): Promise<void> =>
		context.page.afterNavigation('/owner-ready', async (): Promise<void> => {
			if (tracePhase === 'second-choice') recordChooserPhase('second-choice-click', 'started');
			await context.page.click(`#choose-organization button[value="${organizationId}"]`);
			if (tracePhase === 'second-choice') {
				recordChooserPhase('second-choice-click', 'completed');
				recordChooserPhase('second-response', 'waiting-for-response');
			}
		}),
	);
	if (tracePhase === 'second-choice') recordChooserPhase('second-response', 'received');
	expect(response.response.status).toBe(200);
	await organizationDomReady(
		context.page,
		`!!document.querySelector('[data-sign-in-island-mounted] #choose-organization') && document.querySelector('h1')?.textContent!=='Choose your organization'`,
	);
	expect((await currentSession(context)).activeOrganizationId).toBe(organizationId);
}

/**
 * The account page while a CLI sign-in waits: the only state in which a ready person is shown it,
 * so the chooser's own reloads (it replaces the current URL) keep the page.
 */
function waitingCliAccountPage(harness: OrganizationBrowserScenario['harness']): string {
	const authorize = new URL('/api/auth/oauth2/authorize', harness.target.issuer);
	authorize.search = new URLSearchParams({
		client_id: harness.target.ownerCliClientId,
		redirect_uri: harness.target.ownerCliRedirectUri,
		response_type: 'code',
		scope: 'tool-portal:management',
		resource: harness.target.managementAudience,
		code_challenge_method: 'S256',
		code_challenge: 'waiting-cli-sign-in',
	}).toString();
	return `/owner-ready?authorize=${encodeURIComponent(authorize.toString())}`;
}

/** V2 preserves the delivered CLI's PKCE, original state, signature and private-cache assertions. */
export async function exerciseOrganizationChooser(
	context: OrganizationBrowserScenario,
): Promise<void> {
	const { harness, page, responses } = context;
	// Fresh native social login is setup, with the controlled provider and real Better Auth session.
	harness.clearBrowserSession();
	const initiated = await harness.auth('/api/auth/sign-in/social', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-captcha-response': harness.turnstile.issueToken({
				action: 'sign_in_social',
				hostname: new URL(harness.issuer).hostname,
				verdict: 'accepted',
			}),
		},
		body: JSON.stringify({ provider: 'google', callbackURL: `${harness.issuer}/owner-ready` }),
	});
	expect(initiated.status).toBe(200);
	const provider = z.object({ url: z.url() }).parse(await initiated.json());
	const admitted = await harness.auth(
		harness
			.providerCallback('google', new URL(provider.url), 'owner@example.invalid', true)
			.toString(),
	);
	expect(admitted.status).toBe(302);
	await harness.totpAuthenticator.ensureConfirmed('owner@example.invalid', harness.auth);
	await installOrganizationBrowserCookie({
		page,
		issuer: harness.issuer,
		cookie: harness.cookie(),
	});
	const fresh = await currentSession(context);
	expect(fresh.id).not.toBe(context.initialSessionId);
	expect(fresh.activeOrganizationId).toBeNull();
	const membershipsBefore = await harness.database.select().from(member);
	const token = await loginThroughNativeOwnerCli({
		target: harness.target,
		repositoryRoot: context.root,
		cancelBrowser: () => page.cancel('Delivered CLI ended before chooser completion'),
		signal: context.scenarioSignal,
		browser: async (initialUrl: string): Promise<readonly string[]> => {
			// Enter with the native session arranged above. Sign-in-page navigation is outside V2.
			const ownerReady = new URL(initialUrl);
			expect(ownerReady.origin).toBe(new URL(harness.issuer).origin);
			expect(ownerReady.pathname).toBe('/sign-in');
			expect(ownerReady.searchParams.get('authorize')).toBeTruthy();
			ownerReady.pathname = '/owner-ready';
			await page.navigate(ownerReady.toString());
			await organizationDomReady(
				page,
				`document.querySelector('h1')?.textContent==='Choose your organization' && !!document.querySelector('[data-sign-in-island-mounted] #choose-organization button')`,
			);
			expect(
				await page.evaluate(
					`!!document.querySelector(${JSON.stringify(continueButton)})?.disabled`,
					z.boolean(),
				),
			).toBe(true);
			const choices = await page.evaluate(
				`document.querySelector('#choose-organization')?.textContent`,
				z.string(),
			);
			expect(choices).toContain(context.firstOrganizationName);
			expect(choices).toContain(context.secondOrganizationName);
			expect(choices.toLowerCase()).toContain('owner');
			await tabToOrganizationControl({
				page,
				selector: `#choose-organization button[aria-label="Choose ${context.firstOrganizationName}"]`,
			});
			const firstReply = await page.responseTo(switchPath, async (): Promise<void> =>
				page.afterNavigation('/owner-ready', async (): Promise<void> => {
					const heldResponse = responses.arm((url): boolean => url.pathname === switchPath);
					void heldResponse.catch(() => undefined);
					recordChooserPhase('first-gesture', 'started');
					const observation = await observeOrganizationEnterGesture({
						page,
						buttonSelector: `#choose-organization button[value="${context.firstOrganizationId}"]`,
						formSelector: '#choose-organization',
						pressEnter: (): Promise<void> => page.page.keyboard.press('Enter'),
					});
					recordChooserPhase('first-gesture', 'completed');
					process.stdout.write(
						`${JSON.stringify({ event: 'organization-chooser-enter-gesture', observation })}\n`,
					);
					// Check the completed gesture before awaiting a request that might not exist.
					expect(
						observation.events.some(
							(event) => event.kind === 'submit' && event.expectedButton && event.expectedForm,
						),
					).toBe(true);
					expect(observation.events.map((event) => event.kind)).toEqual([
						'keydown',
						'keypress',
						'click',
						'submit',
						'keyup',
					]);
					expect(
						observation.events
							.filter((event) => event.kind !== 'keyup')
							.every((event) => event.expectedButton && event.expectedForm),
					).toBe(true);
					// A valid submit disables the chooser; keyup and focus may then move to body.
					recordChooserPhase('first-release', 'waiting-for-response');
					const firstHeldResponse = await heldResponse;
					recordChooserPhase('first-release', 'started');
					await responses.releaseForNavigation(firstHeldResponse);
					recordChooserPhase('first-release', 'completed');
				}),
			);
			expect(firstReply.response.status).toBe(200);
			recordChooserPhase('first-dom-ready', 'started');
			await organizationDomReady(
				page,
				`!!document.querySelector('#choose-organization button[value="${context.secondOrganizationId}"]') && document.querySelector('h1')?.textContent!=='Choose your organization'`,
			);
			recordChooserPhase('first-dom-ready', 'completed');
			expect((await currentSession(context)).activeOrganizationId).toBe(
				context.firstOrganizationId,
			);
			expect(
				await page.evaluate(
					`document.querySelector(${JSON.stringify(continueButton)})?.disabled`,
					z.boolean(),
				),
			).toBe(false);
			expect(
				await page.evaluate(
					`document.querySelector('#choose-organization')?.textContent.includes('Current')`,
					z.boolean(),
				),
			).toBe(true);
			await chooseOrganization(context, context.secondOrganizationId, 'second-choice');
			expect((await currentSession(context)).id).toBe(fresh.id);
			expect(
				await page.evaluate(
					`!!document.querySelector('[data-organization-id="${context.secondOrganizationId}"]')`,
					z.boolean(),
				),
			).toBe(true);
			await context.capture('chooser-second-choice');
			recordChooserPhase('continue', 'started');
			await page.afterNavigation(undefined, async (): Promise<void> => page.click(continueButton));
			recordChooserPhase('continue', 'completed');
			// Chrome follows the actual served Continue destination; no saved authorization URL is replayed.
			const callback = await page.evaluate('location.href', z.url());
			expect(new URL(callback).hostname).toBe('127.0.0.1');
			return [
				new URL(callback).searchParams.get('code') ?? '',
				await organizationBrowserCookie(page, harness.issuer),
			];
		},
	});
	const claims = organizationPersonTokenClaimsSchema.parse(decodeJwt(token));
	expect(claims.organization_id).toBe(context.secondOrganizationId);
	expect(claims.sid).toBe(fresh.id);
	expect(claims.second_factor_method).toBe('app');
	await page.navigate(`${harness.issuer}${waitingCliAccountPage(harness)}`);
	await chooseOrganization(context, context.firstOrganizationId);
	// Drop the response only after the real native set-active has committed.
	const switchesBeforeLost = context.requestedPaths.filter(
		(pathname) => pathname === switchPath,
	).length;
	const lost = responses.arm((url): boolean => url.pathname === switchPath);
	await page.click(`#choose-organization button[value="${context.secondOrganizationId}"]`);
	const committed = await lost;
	expect(committed.responseStatusCode).toBe(200);
	expect((await currentSession(context)).activeOrganizationId).toBe(context.secondOrganizationId);
	await page.afterNavigation('/owner-ready', async (): Promise<void> => responses.lose(committed));
	await organizationDomReady(
		page,
		`!!document.querySelector('[data-sign-in-island-mounted] #choose-organization button[value="${context.firstOrganizationId}"]')`,
	);
	expect(context.requestedPaths.filter((pathname) => pathname === switchPath)).toHaveLength(
		switchesBeforeLost + 1,
	);
	expect(
		await page.evaluate(
			`document.querySelector('h1')?.textContent==='Choose your organization'`,
			z.boolean(),
		),
	).toBe(false);
	expect(
		await page.evaluate(
			`!!document.querySelector('[data-organization-id="${context.secondOrganizationId}"]')`,
			z.boolean(),
		),
	).toBe(true);
	expect(
		await page.evaluate(
			`document.querySelector('#choose-organization button[value="${context.secondOrganizationId}"]')?.textContent.includes('Current')`,
			z.boolean(),
		),
	).toBe(true);
	await chooseOrganization(context, context.firstOrganizationId);
	// Adversarial DOM input reaches the same native membership check as a real card submission.
	await page.evaluate(
		`(()=>{const button=document.querySelector('#choose-organization button[value="${context.secondOrganizationId}"]');button.value=${JSON.stringify(context.foreignOrganizationId)};return true;})()`,
		z.literal(true),
	);
	await page.evaluate(
		`(()=>{sessionStorage.removeItem('organization-refusal-observed');new MutationObserver(()=>{if(document.body.textContent.includes("That organization isn't available"))sessionStorage.setItem('organization-refusal-observed','yes');}).observe(document.body,{subtree:true,childList:true,characterData:true});return true;})()`,
		z.literal(true),
	);
	const foreign = await page.responseTo(switchPath, async (): Promise<void> =>
		page.afterNavigation('/owner-ready', async (): Promise<void> =>
			page.click(`#choose-organization button[value="${context.foreignOrganizationId}"]`),
		),
	);
	expect(foreign.response.status).toBe(403);
	await organizationDomReady(
		page,
		`document.querySelector('h1')?.textContent==='Choose your organization'`,
	);
	expect(
		await page.evaluate(`sessionStorage.getItem('organization-refusal-observed')`, z.string()),
	).toBe('yes');
	expect((await currentSession(context)).activeOrganizationId).toBeNull();
	const selfContext = await page.evaluate(
		`fetch('/api/auth/organization/self-context').then(response=>response.json())`,
		z.object({
			kind: z.literal('available'),
			activeOrganizationId: z.null(),
			choices: z.array(z.object({ organizationId: z.string(), role: z.string() })),
		}),
	);
	expect(selfContext.choices.map((choice) => choice.organizationId).toSorted()).toEqual(
		[context.firstOrganizationId, context.secondOrganizationId].toSorted(),
	);
	await page.navigate(`${harness.issuer}${waitingCliAccountPage(harness)}`);
	await organizationDomReady(
		page,
		`!!document.querySelector('[data-sign-in-island-mounted] #choose-organization')`,
	);
	expect((await currentSession(context)).activeOrganizationId).toBeNull();
	expect(
		await page.evaluate(
			`document.querySelector('#choose-organization')?.textContent.includes('Current')`,
			z.boolean(),
		),
	).toBe(false);
	expect(await harness.database.select().from(member)).toEqual(membershipsBefore);
	await chooseOrganization(context, context.firstOrganizationId);
	const before = await currentSession(context);
	const advanced = controlledSignInClock.now() + 16 * 60_000;
	vi.setSystemTime(advanced);
	try {
		expect(
			(
				await harness.auth('/__auth-proof/set-clock', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ milliseconds: advanced }),
				})
			).status,
		).toBe(200);
		await chooseOrganization(context, context.secondOrganizationId);
		const after = await currentSession(context);
		expect({ at: after.secondFactorAt, method: after.secondFactorMethod }).toEqual({
			at: before.secondFactorAt,
			method: before.secondFactorMethod,
		});
		const invite = await page.evaluate(
			`fetch('/api/auth/organization/invite-member',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({organizationId:${JSON.stringify(context.secondOrganizationId)},email:'stale-step-up@example.invalid',role:'member'})}).then(response=>response.status)`,
			z.number(),
		);
		expect(invite).toBe(403);
		expect(
			await harness.database
				.select()
				.from(member)
				.where(
					and(
						eq(member.organizationId, context.foreignOrganizationId),
						eq(member.userId, context.ownerPersonId),
					),
				),
		).toEqual([]);
	} finally {
		vi.setSystemTime(controlledSignInClock.now());
	}
}
