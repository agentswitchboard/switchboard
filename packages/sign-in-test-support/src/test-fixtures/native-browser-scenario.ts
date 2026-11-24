import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { epochMillisecondsSchema } from '@agent-collaboration/sign-in-core';
import { z } from 'zod';

import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { initialSignInTestTime } from '#sign-in-test-support/test-fixtures/controlled-sign-in-time';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import {
	finishNativeBrowserScenario,
	type NativeBrowserFailure,
} from '#sign-in-test-support/test-fixtures/native-browser-cleanup';
import { prepareNodeProofArtifacts } from '#sign-in-test-support/test-fixtures/node-proof-artifacts';
import {
	launchProofBrowser,
	type PlaywrightBrowserPage,
} from '#sign-in-test-support/test-fixtures/playwright-browser';
import { nativeNetworkResponseSchema } from '#sign-in-test-support/test-fixtures/playwright-network';
import { prepareProofBundles } from '#sign-in-test-support/test-fixtures/proof-bundle-artifacts';

const initialMilliseconds = initialSignInTestTime;
const email = 'owner@example.invalid';
const execute = promisify(execFile);
const digest = (bytes: string | Uint8Array): string =>
	createHash('sha256').update(bytes).digest('hex');

export interface NativeBrowserStep {
	readonly name: string;
	readonly status: 'passed' | 'failed';
	readonly facts: Readonly<Record<string, unknown>>;
	readonly screenshot?: { readonly file: string; readonly bytes: number; readonly sha256: string };
}

/** The standard host lane owns the checkout and build; every run gets private evidence and state. */
export async function observeNativeFactorBrowser(
	host: 'node' | 'cloudflare',
	scenarioSignal: AbortSignal,
): Promise<void> {
	const root = fileURLToPath(new URL('../../../../', import.meta.url));
	const sourceRevision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
	// A label only, from the controlled clock (R33); mkdtemp's suffix keeps each run private.
	const datePrefix = new Date(controlledSignInClock.now()).toISOString().slice(0, 7);
	const evidence = await mkdtemp(
		path.join(tmpdir(), `${datePrefix}-sign-in-native-browser-${host}-`),
	);
	// Compare served bytes with the actual build inputs embedded by sign-in-core, not the HTTP response itself.
	const [stylesheet, island] = await Promise.all([
		readFile(path.join(root, 'packages/sign-in-core/__generated__/sign-in.css')),
		readFile(
			path.join(root, 'packages/sign-in-core/__generated__/islands/sign-in-pages-island.js'),
		),
	]);
	const stylesheetHash = digest(stylesheet);
	const islandHash = digest(island);
	const expectedAssets: Readonly<Record<string, string>> = {
		[`/assets/sign-in-${stylesheetHash.slice(0, 16)}.css`]: stylesheetHash,
		[`/assets/sign-in-pages-${islandHash.slice(0, 16)}.js`]: islandHash,
	};
	process.stdout.write(
		JSON.stringify({ event: 'native-browser-evidence', host, sourceRevision, evidence }) + '\n',
	);
	const steps: NativeBrowserStep[] = [];
	let activeStep = 'prepare';
	let harness: Awaited<ReturnType<typeof startLocalAuthHarness>> | undefined;
	let chrome: Awaited<ReturnType<typeof launchProofBrowser>> | undefined;
	let browserPage: PlaywrightBrowserPage | undefined;
	let cleanupFailure: string | null = null;
	let scenarioFailure: NativeBrowserFailure = { kind: 'none' };
	let appMilliseconds = initialMilliseconds;
	const statuses: { readonly pathname: string; readonly status: number }[] = [];
	const consoleCounts = { logErrors: 0, exceptions: 0 };
	const previousEnvironment = {
		host: process.env.SIGN_IN_TEST_HOST,
		manifest: process.env.AUTH_PROOF_MANIFEST_FILE,
		nodeManifest: process.env.AUTH_PROOF_NODE_MANIFEST_FILE,
	};
	async function passed(
		name: string,
		facts: Readonly<Record<string, unknown>>,
		capture = false,
	): Promise<void> {
		steps.push({
			name,
			status: 'passed',
			facts,
			...(capture && browserPage !== undefined
				? { screenshot: await browserPage.screenshot(name) }
				: {}),
		});
		await writeFile(path.join(evidence, 'steps.json'), JSON.stringify(steps, null, 2), {
			mode: 0o600,
		});
	}

	try {
		process.env.SIGN_IN_TEST_HOST = host;
		const manifest = await prepareProofBundles(root, evidence);
		const manifestFile = path.join(evidence, 'bundle-manifest.json');
		await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
		process.env.AUTH_PROOF_MANIFEST_FILE = manifestFile;
		if (host === 'node') {
			const file = path.join(evidence, 'node-manifest.json');
			await writeFile(file, JSON.stringify(await prepareNodeProofArtifacts(root, evidence)), {
				mode: 0o600,
				flag: 'wx',
			});
			process.env.AUTH_PROOF_NODE_MANIFEST_FILE = file;
		} else delete process.env.AUTH_PROOF_NODE_MANIFEST_FILE;
		harness = await startLocalAuthHarness({
			turnstileSecret: 'published-test',
			host,
			authenticatorClock: { now: () => epochMillisecondsSchema.parse(appMilliseconds) },
		});
		const activeHarness = harness;
		if (activeHarness.signInHost !== host)
			throw new Error(`Requested ${host} browser scenario resolved ${activeHarness.signInHost}`);
		chrome = await launchProofBrowser({
			evidence,
			origin: activeHarness.issuer,
			width: 390,
			scenarioSignal,
		});
		const page = chrome.protocol;
		const browserVersion = await page.send('Browser.getVersion');
		await writeFile(
			path.join(evidence, 'browser-version.json'),
			JSON.stringify(browserVersion, null, 2),
			{ mode: 0o600, flag: 'wx' },
		);
		browserPage = chrome;
		const activeBrowser = browserPage;
		await page.send('Log.enable');
		page.on('Network.responseReceived', (value): void => {
			const parsed = nativeNetworkResponseSchema.safeParse(value);
			if (parsed.success && new URL(parsed.data.response.url).origin === activeHarness.issuer)
				statuses.push({
					pathname: new URL(parsed.data.response.url).pathname,
					status: parsed.data.response.status,
				});
		});
		page.on('Log.entryAdded', (value): void => {
			if (
				z.object({ entry: z.object({ level: z.string() }) }).safeParse(value).data?.entry.level ===
				'error'
			)
				consoleCounts.logErrors += 1;
		});
		page.on('Runtime.exceptionThrown', (): void => {
			consoleCounts.exceptions += 1;
		});
		activeStep = 'sign-in-page';
		await activeBrowser.navigate(activeHarness.issuer + '/sign-in');
		await activeBrowser.readyWhen(
			`document.querySelector('#sign-in-captcha')?.dataset.sitekey==='1x00000000000000000000AA' && !!document.querySelector('script[src*="challenges.cloudflare.com"]')`,
		);
		await passed(activeStep, {
			turnstileContainerAndScript: true,
			publishedTestKey: true,
			externalChallengeAcceptance: 'not claimed',
		});
		activeStep = 'existing-native-session';
		const captcha = activeHarness.turnstile.issueToken({
			action: 'sign_in_social',
			hostname: new URL(activeHarness.issuer).hostname,
			verdict: 'accepted',
		});
		const initiated = await activeBrowser.evaluate(
			`fetch('/api/auth/sign-in/social',{method:'POST',credentials:'include',headers:{'content-type':'application/json','x-captcha-response':${JSON.stringify(captcha)}},body:JSON.stringify({provider:'google',callbackURL:location.origin+'/owner-ready'})}).then(async response=>({status:response.status,body:await response.json()}))`,
			z.object({ status: z.literal(200), body: z.object({ url: z.url() }) }),
		);
		const callback = activeHarness.providerCallback(
			'google',
			new URL(initiated.body.url),
			email,
			true,
		);
		await activeBrowser.navigate(callback.toString());
		await activeBrowser.readyWhen(
			`location.pathname==='/owner-ready' && !document.querySelector('[data-sign-in-island] [data-factor-form]') && [...document.querySelectorAll('[data-sign-in-island] button')].some(node=>node.textContent.includes('Set up authenticator app'))`,
		);
		await passed(activeStep, {
			existingSessionSetup:
				'native callback over controlled provider protocol; social verification is out of scope',
			witness: 'authenticated owner-ready enrollment view',
		});
		activeStep = 'native-served-assets';
		if (Object.keys(expectedAssets).length !== 2)
			throw new Error('Native target requires CSS and island identities');
		const assets = await activeBrowser.evaluate(
			`Promise.all(${JSON.stringify(Object.keys(expectedAssets))}.map(async pathname=>{const response=await fetch(pathname);return {pathname,status:response.status,body:await response.text()};}))`,
			z.array(z.object({ pathname: z.string(), status: z.literal(200), body: z.string() })),
		);
		for (const asset of assets)
			if (digest(asset.body) !== expectedAssets[asset.pathname])
				throw new Error('Native served asset differs from the same-checkout build');
		await passed(activeStep, {
			assets: assets.map((asset) => ({
				pathname: asset.pathname,
				bytes: Buffer.byteLength(asset.body),
				sha256: digest(asset.body),
			})),
		});
		activeStep = 'native-enrollment';
		const enable = await activeBrowser.responseTo(
			'/api/auth/two-factor/enable',
			async (): Promise<void> =>
				activeBrowser.click('[data-sign-in-island] button', 'Set up authenticator app'),
		);
		if (enable.response.status !== 200) throw new Error('Native app enrollment refused');
		const enrollment = z
			.object({
				method: z.literal('totp'),
				totpURI: z.string(),
				backupCodes: z.array(z.string()).min(1),
			})
			.parse(await activeBrowser.readBody(enable));
		activeHarness.totpAuthenticator.observeEnrollment(email, enrollment);
		const uri = new URL(enrollment.totpURI);
		if (uri.searchParams.get('issuer') !== 'Switchboard')
			throw new Error('Native authenticator issuer is not Switchboard');
		await activeBrowser.readyWhen(
			`document.querySelectorAll('[data-slot="input-otp-slot"]').length===6`,
		);
		const firstVerification = await activeBrowser.responseTo(
			'/api/auth/two-factor/verify-totp',
			async (): Promise<void> =>
				activeBrowser.enter(
					'input[autocomplete="one-time-code"]',
					await activeHarness.totpAuthenticator.currentCode(email),
				),
		);
		if (firstVerification.response.status !== 200)
			throw new Error('Native enrollment code refused');
		await activeBrowser.readyWhen(
			`[...document.querySelectorAll('[data-sign-in-island] button')].some(node=>node.textContent.includes("I've saved my recovery codes"))`,
		);
		await passed(activeStep, {
			status: 200,
			issuer: 'Switchboard',
			recoveryCodeCount: enrollment.backupCodes.length,
			code: 'generated by software authenticator from native enrollment response',
		});
		activeStep = 'enrollment-finish';
		await activeBrowser.afterNavigation('/owner-ready', async (): Promise<void> =>
			activeBrowser.click('[data-sign-in-island] button', "I've saved my recovery codes"),
		);
		await activeBrowser.readyWhen(
			`location.pathname==='/owner-ready' && !!document.querySelector('#create-organization')`,
		);
		await passed(
			activeStep,
			{
				nextPage: 'organization-create',
				nativeSessionRotated: 'native endpoint owns rotation; not inferred from a cookie count',
			},
			true,
		);
		activeStep = 'confirmation-required';
		appMilliseconds = initialMilliseconds + 16 * 60_000;
		const moved = await activeHarness.auth('/__auth-proof/set-clock', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ milliseconds: appMilliseconds }),
		});
		if (moved.status !== 200) throw new Error('Existing clock control refused');
		await activeBrowser.navigate(activeHarness.issuer + '/owner-ready');
		await activeBrowser.readyWhen(
			`document.querySelectorAll('[data-slot="input-otp-slot"]').length===6 && !document.querySelector('[data-sign-in-island] [data-factor-form]') && !document.querySelector('#create-organization')`,
		);
		await passed(activeStep, {
			controlledAdvanceMilliseconds: 16 * 60_000,
			organizationFormHidden: true,
		});
		activeStep = 'wrong-code-inline';
		const currentMilliseconds = appMilliseconds;
		const validWindow = new Set<string>();
		const periodMilliseconds = Number(uri.searchParams.get('period') ?? '30') * 1000;
		for (const offset of [-3, -2, -1, 0, 1, 2, 3]) {
			appMilliseconds = currentMilliseconds + offset * periodMilliseconds;
			// This software authenticator reads the one mutable clock; samples must be sequential.
			// oxlint-disable-next-line no-await-in-loop
			validWindow.add(await activeHarness.totpAuthenticator.currentCode(email));
		}
		appMilliseconds = currentMilliseconds;
		const wrongCode = Array.from({ length: 10 }, (_, digit) => String(digit).repeat(6)).find(
			(candidate) => !validWindow.has(candidate),
		);
		if (wrongCode === undefined) throw new Error('No deterministic wrong code available');
		await activeBrowser.evaluate(
			`(()=>{if(document.querySelector('[data-sonner-toast]'))throw new Error('Unexpected toast before wrong-code submission');window.nativeProofToastElements=new Set();new MutationObserver(()=>{document.querySelectorAll('[data-sonner-toast]').forEach(node=>window.nativeProofToastElements.add(node));}).observe(document.body,{childList:true,subtree:true});return true;})()`,
			z.literal(true),
		);
		const wrong = await activeBrowser.responseTo(
			'/api/auth/two-factor/verify-totp',
			async (): Promise<void> =>
				activeBrowser.enter('input[autocomplete="one-time-code"]', wrongCode),
		);
		if (![400, 401, 403].includes(wrong.response.status))
			throw new Error('Wrong native code did not receive a refusal');
		// Owner decision C2=B (WS10): Better Auth's words inline and in exactly one toast.
		await activeBrowser.readyWhen(
			`document.querySelector('[data-sign-in-island] form [data-slot="field-error"]')?.textContent==='Invalid code' && !!document.querySelector('[data-sonner-toast]') && !document.querySelector('[data-sign-in-island] [aria-busy="true"]')`,
		);
		const refusal = await activeBrowser.evaluate(
			`({inlineMessage:document.querySelector('[data-sign-in-island] form [data-slot="field-error"]')?.textContent,toastCount:window.nativeProofToastElements.size,toasts:[...document.querySelectorAll('[data-sonner-toast]')].map(node=>node.textContent)})`,
			z.strictObject({
				inlineMessage: z.literal('Invalid code'),
				toastCount: z.literal(1),
				toasts: z.array(z.string().refine((text) => text.includes('Invalid code'))).length(1),
			}),
		);
		await passed(
			activeStep,
			{
				nativeStatus: wrong.response.status,
				...refusal,
			},
			true,
		);
		activeStep = 'right-code-confirmation';
		const confirmed = await activeBrowser.responseTo(
			'/api/auth/two-factor/verify-totp',
			async (): Promise<void> =>
				activeBrowser.afterNavigation('/owner-ready', async (): Promise<void> =>
					activeBrowser.enter(
						'input[autocomplete="one-time-code"]',
						await activeHarness.totpAuthenticator.currentCode(email),
					),
				),
		);
		if (confirmed.response.status !== 200) throw new Error('Right native code refused');
		await activeBrowser.readyWhen(
			`location.pathname==='/owner-ready' && !!document.querySelector('#create-organization')`,
		);
		await passed(activeStep, { nativeStatus: 200, organizationFormVisible: true }, true);
		activeStep = 'organization-created';
		await activeBrowser.enter('input[name="organizationName"]', 'Native browser organization');
		const created = await activeBrowser.responseTo(
			'/api/auth/organization/create',
			async (): Promise<void> =>
				// Nothing is pending once the organization exists: the account page lands on Me.
				activeBrowser.afterNavigation('/me', async (): Promise<void> =>
					activeBrowser.click('#create-organization button[type="submit"]'),
				),
		);
		if (created.response.status !== 200) throw new Error('Native organization creation refused');
		await activeBrowser.readyWhen(
			`location.pathname==='/me' && !!document.querySelector('#security-heading') && document.querySelector('h1')?.textContent==='Me' && !document.querySelector('#create-organization')`,
		);
		await passed(activeStep, { nativeStatus: 200, accountSecurityVisible: true }, true);
		activeStep = 'replacement-codes';
		const replacement = await activeBrowser.responseTo(
			'/api/auth/two-factor/generate-backup-codes',
			async (): Promise<void> =>
				activeBrowser.click('form[data-factor-form] button', 'Replace recovery codes'),
		);
		if (replacement.response.status !== 200)
			throw new Error('Native recovery-code replacement refused');
		await activeBrowser.readyWhen(
			`document.querySelector('h1')?.textContent==='New recovery codes' && ['Copy to clipboard','Download .txt','Print',"I've saved my recovery codes"].every(label=>[...document.querySelectorAll('[data-sign-in-island] button')].some(node=>node.textContent.trim()===label))`,
		);
		const replacementCodes = await activeBrowser.evaluate(
			`JSON.parse(document.querySelector('[data-sign-in-island]').dataset.islandState).codes`,
			z.array(z.string()).min(1),
		);
		if (replacementCodes.some((code) => enrollment.backupCodes.includes(code)))
			throw new Error('Replacement reused an original recovery code');
		await passed(activeStep, {
			nativeStatus: 200,
			replacementCodeCount: replacementCodes.length,
			reusedOriginalCodes: false,
		});
		activeStep = 'replacement-finish';
		await activeBrowser.afterNavigation('/me', async (): Promise<void> =>
			activeBrowser.click('[data-sign-in-island] button', "I've saved my recovery codes"),
		);
		await activeBrowser.readyWhen(
			`location.pathname==='/me' && document.querySelector('h1')?.textContent==='Me'`,
		);
		await passed(activeStep, { nextPage: 'me' }, true);
		activeStep = 'session-read-no-token';
		const sessionRead = await activeBrowser.evaluate(
			`fetch('/api/auth/get-session',{credentials:'include'}).then(async response=>{const data=await response.json();const containsToken=value=>!!value&&typeof value==='object'&&Object.entries(value).some(([key,item])=>key==='token'||containsToken(item));return {status:response.status,hasSession:typeof data?.session?.id==='string',containsToken:containsToken(data)};})`,
			z.object({
				status: z.literal(200),
				hasSession: z.literal(true),
				containsToken: z.literal(false),
			}),
		);
		await passed(activeStep, sessionRead);
		if (
			(await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim() !== sourceRevision
		)
			throw new Error('Native browser checkout changed during the journey');
	} catch (error) {
		scenarioFailure = { kind: 'failed', error };
	} finally {
		const failureStep: NativeBrowserStep | undefined =
			scenarioFailure.kind === 'failed'
				? {
						name: activeStep,
						status: 'failed',
						facts: {
							message:
								scenarioFailure.error instanceof Error
									? scenarioFailure.error.message
									: 'Unknown native browser failure',
						},
					}
				: undefined;
		const failureBrowser = browserPage;
		await finishNativeBrowserScenario({
			failure: scenarioFailure,
			recordFailure: async (): Promise<void> => {
				if (failureStep === undefined) return;
				steps.push(failureStep);
				await writeFile(path.join(evidence, 'steps.json'), JSON.stringify(steps, null, 2), {
					mode: 0o600,
				});
			},
			...(failureBrowser === undefined
				? {}
				: { captureFailure: () => failureBrowser.captureFailureFrame() }),
			close: async (): Promise<void> => {
				const closeFailures: unknown[] = [];
				try {
					await chrome?.close();
				} catch (error) {
					cleanupFailure = error instanceof Error ? error.message : 'Chrome cleanup failed';
					closeFailures.push(error);
				}
				try {
					await harness?.close();
				} catch (error) {
					cleanupFailure = error instanceof Error ? error.message : 'Harness cleanup failed';
					closeFailures.push(error);
				}
				for (const [name, value] of Object.entries({
					SIGN_IN_TEST_HOST: previousEnvironment.host,
					AUTH_PROOF_MANIFEST_FILE: previousEnvironment.manifest,
					AUTH_PROOF_NODE_MANIFEST_FILE: previousEnvironment.nodeManifest,
				})) {
					if (value === undefined) delete process.env[name];
					else process.env[name] = value;
				}
				if (closeFailures.length === 1) throw closeFailures[0];
				if (closeFailures.length > 1)
					throw new AggregateError(closeFailures, 'Native browser cleanup failed', {
						cause: closeFailures[0],
					});
			},
			record: async (capture): Promise<void> => {
				let failureScreenshot: NativeBrowserStep['screenshot'];
				if (capture !== undefined && failureBrowser !== undefined) {
					try {
						failureScreenshot = await failureBrowser.recordScreenshot('failure-state', capture);
					} catch {
						// Optional frame storage cannot replace the already-persisted deciding error.
					}
				}
				const capturedFailure =
					failureStep !== undefined && failureScreenshot !== undefined
						? { ...failureStep, screenshot: failureScreenshot }
						: undefined;
				const completedSteps = steps.map((step) =>
					step === failureStep && capturedFailure !== undefined ? capturedFailure : step,
				);
				await writeFile(
					path.join(evidence, 'steps.json'),
					JSON.stringify(completedSteps, null, 2),
					{
						mode: 0o600,
					},
				);
				await writeFile(
					path.join(evidence, 'observation.json'),
					JSON.stringify(
						{
							target: {
								sourceRevision,
								root,
								expectedAssets,
								executionHost: hostname(),
								nodeVersion: process.version,
							},
							host,
							layer: 'local Chrome against native Better Auth and selected real storage',
							steps: completedSteps,
							statuses,
							consoleCounts,
							cleanupFailure,
							browserConnectedAfterClose: chrome?.isBrowserConnected() ?? null,
							actualHarnessHost: harness?.signInHost ?? null,
							harnessTeardown: harness?.teardownObservations.map((entry) => entry.kind) ?? [],
							standIns: [
								'controlled external provider and Turnstile siteverify for existing-session setup',
								'software authenticator',
								'injected clock',
								'central provisioning model',
							],
							notCovered: [
								'real Google/GitHub sign-in',
								'Cloudflare challenge acceptance',
								'physical authenticator',
								'hosted deployment',
								'global clipboard/download/print effects',
							],
							note: 'Harness bootstrap readiness receipt is not the browser witness; authenticated native owner UI and native endpoint results are this journey witness.',
						},
						null,
						2,
					),
					{ mode: 0o600 },
				);
			},
		});
	}
}
