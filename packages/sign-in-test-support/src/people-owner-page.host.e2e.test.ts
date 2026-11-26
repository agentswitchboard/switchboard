import { fileURLToPath } from 'node:url';

import { member, organization } from '@agent-collaboration/sign-in-core';
import { organizationPersonTokenClaimsSchema } from '@agent-collaboration/sign-in-core/person-identity';
import { decodeJwt } from 'jose';
import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { ownerEmail, setupFleetCli } from '#sign-in-test-support/test-fixtures/fleet-cli-fixture';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { loginThroughNativeOwnerCli } from '#sign-in-test-support/test-fixtures/native-cli-proof';
import {
	createServedOwnerBrowser,
	type ServedOwnerObservation,
} from '#sign-in-test-support/test-fixtures/served-owner-browser';

useControlledSignInClock();
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const navigationHeaders = { 'sec-fetch-mode': 'navigate', accept: 'text/html' };

it('people: the management link shows provider sign-in with a live cookie and owner-ready continues the same session', async () => {
	const { harness, target } = await setupFleetCli();
	const requests: string[] = [];
	try {
		const claims = organizationPersonTokenClaimsSchema.parse(
			decodeJwt(
				await loginThroughNativeOwnerCli({
					target: harness.target,
					repositoryRoot,
					async browser(printedUrl): Promise<readonly string[]> {
						const signIn = await harness.auth(printedUrl, { headers: navigationHeaders });
						expect(signIn.status).toBe(200);
						expect(await signIn.text()).toContain('Continue with Google');
						const ready = new URL(printedUrl);
						ready.pathname = '/owner-ready';
						return createServedOwnerBrowser({
							harness,
							email: ownerEmail,
							initialSession: 'confirmed',
							observe: () => undefined,
							observePage(_url, document): void {
								expect(document.querySelector('#owner-sign-in button')?.textContent).toBe(
									'Continue to management CLI',
								);
							},
							observeRequest: (pathname): void => {
								requests.push(pathname);
							},
						})(ready.toString());
					},
				}),
			),
		);
		expect(requests).toEqual(['/api/auth/passkey/list-user-passkeys', '/api/auth/owner/bootstrap']);
		expect(claims.organization_id).toBe(target.organizationId);
	} finally {
		await harness.close();
	}
});

it('people: served first-login pages keep the original CLI authorization through app setup, rotated cookie and organization creation', async () => {
	const harness = await startLocalAuthHarness();
	const observations: ServedOwnerObservation[] = [];
	try {
		const token = await loginThroughNativeOwnerCli({
			target: harness.target,
			repositoryRoot,
			browser: createServedOwnerBrowser({
				harness,
				email: 'owner@example.invalid',
				organization: { name: 'Created through the page', slug: 'page-first-owner' },
				observe: (event): void => {
					observations.push(event);
				},
			}),
		});
		// The delivered CLI verified the signature, original state/PKCE loopback
		// and live session before returning this private-cache credential.
		const claims = organizationPersonTokenClaimsSchema.parse(decodeJwt(token));
		const confirmation = observations.find((event) => event.kind === 'app-confirmed');
		if (confirmation?.kind !== 'app-confirmed')
			throw new Error('The served app confirmation was not observed');
		expect(confirmation.afterSessionId).not.toBe(confirmation.beforeSessionId);
		expect(claims.sid).toBe(confirmation.afterSessionId);
		expect(claims.second_factor_method).toBe('app');
		expect(
			await harness.database
				.select({ id: organization.id, name: organization.name })
				.from(organization),
		).toEqual([{ id: claims.organization_id, name: 'Created through the page' }]);
		expect(
			await harness.database
				.select({ organizationId: member.organizationId, role: member.role })
				.from(member),
		).toEqual([{ organizationId: claims.organization_id, role: 'owner' }]);
	} finally {
		await harness.close();
	}
});
