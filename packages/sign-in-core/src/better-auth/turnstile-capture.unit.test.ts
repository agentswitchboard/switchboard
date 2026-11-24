import { betterAuth, type BetterAuthOptions } from 'better-auth';
import type { captcha as nativeCaptchaFactory, CaptchaOptions } from 'better-auth/plugins/captcha';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { createTurnstileProviderOptions } from '#sign-in-core/better-auth/turnstile-captcha';
import { signInConfigurationSchema } from '#sign-in-core/contracts/deployment-configuration';
import type { SignInObservation } from '#sign-in-core/contracts/sign-in-observation';

interface ControlledHook {
	readonly reason: 'action_mismatch' | 'siteverify_rejected';
	readonly errorCodes: readonly string[];
	readonly result: { readonly response: Response };
	readonly entered: PromiseWithResolvers<void>;
}
type CaptchaContext = Parameters<ReturnType<typeof nativeCaptchaFactory>['onRequest']>[1];

const hookControls = vi.hoisted(() => new Map<string, ControlledHook>());
const frozenLogTimestamp = '2030-01-01T00:00:00.000Z';

// The adapter's external hook contract is controlled only at this pure unit
// layer. Host cases separately exercise the unmocked native plugin and handler.
vi.mock('better-auth/plugins/captcha', async (importOriginal) => {
	const original = await importOriginal<typeof import('better-auth/plugins/captcha')>();
	return {
		...original,
		captcha(options: CaptchaOptions): ReturnType<typeof original.captcha> {
			const native = original.captcha(options);
			return {
				...native,
				async onRequest(
					request: Parameters<typeof native.onRequest>[0],
					context: Parameters<typeof native.onRequest>[1],
				): ReturnType<typeof native.onRequest> {
					const control = hookControls.get(request.headers.get('x-captcha-response') ?? '');
					if (control === undefined) return undefined;
					context.logger.warn('Cloudflare Turnstile verification failed', {
						reason: control.reason,
						errorCodes: control.errorCodes,
					});
					control.entered.resolve();
					return control.result;
				},
			};
		},
	};
});

const configuration = signInConfigurationSchema.parse({
	issuer: 'https://sign-in.example.invalid',
	mode: 'private',
	ownerEmail: 'owner@example.invalid',
	toolPortalOrigin: 'https://portal-test.invalid',
	managementAudience: 'https://portal-test.invalid/management',
	centralIdentityAudience: 'https://central.example.invalid/identity',
	centralAdminAudience: 'https://central.example.invalid/admin',
	centralPublicOrigin: 'https://central.example.invalid',
	adminPageClientId: 'admin-page-local',
	ownerFleetCliClientId: 'owner-fleet-cli-local',
	organizationStatementLifetimeSeconds: 10_368_000,
	organizationIds: ['11111111-1111-7111-8111-111111111111'],
	ownerCliClientId: 'owner-cli-local',
	ownerCliRedirectUri: 'http://127.0.0.1/callback',
	turnstile: { kind: 'deployed', siteKey: '1x00000000000000000000AA' },
});

function controlledRefusal(
	reason: ControlledHook['reason'],
): ControlledHook & { readonly release: () => void } {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	const body = JSON.stringify({
		code: 'VERIFICATION_FAILED',
		message: 'Captcha verification failed',
	});
	const stream = new ReadableStream<Uint8Array>({
		start(next: ReadableStreamDefaultController<Uint8Array>): void {
			controller = next;
		},
	});
	return {
		reason,
		errorCodes: reason === 'siteverify_rejected' ? ['timeout-or-duplicate'] : [],
		result: {
			response: new Response(stream, {
				status: 403,
				headers: { 'content-type': 'application/json' },
			}),
		},
		entered: Promise.withResolvers<void>(),
		release(): void {
			if (controller === undefined) return;
			controller.enqueue(new TextEncoder().encode(body));
			controller.close();
			controller = undefined;
		},
	};
}

function observedSetup(
	events: SignInObservation[],
): ReturnType<typeof createTurnstileProviderOptions> {
	return createTurnstileProviderOptions({
		configuration,
		secret: { kind: 'configured', secretKey: '1x0000000000000000000000000000000AA' },
		log(observation: SignInObservation): void {
			events.push(observation);
		},
	});
}

async function createCaptureContext(
	setup: ReturnType<typeof createTurnstileProviderOptions>,
): Promise<CaptchaContext> {
	return betterAuth<BetterAuthOptions>({
		baseURL: configuration.issuer,
		secret: 'test-only-context-secret-'.repeat(3),
		logger: setup.logger,
	}).$context;
}

function createControlledRequest(token: string): Request {
	return new Request('https://sign-in.example.invalid/api/auth/sign-in/social', {
		headers: { 'x-captcha-response': token },
	});
}

beforeEach((): void => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(frozenLogTimestamp));
	hookControls.clear();
});

afterEach((): void => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

test.each(['wrong-action-first', 'duplicate-first'])(
	'captcha projection is request-owned even across delayed response bodies (%s)',
	async (arrival: string): Promise<void> => {
		const wrong = controlledRefusal('action_mismatch');
		const duplicate = controlledRefusal('siteverify_rejected');
		hookControls.set('wrong-token', wrong);
		hookControls.set('duplicate-token', duplicate);
		const wrongEvents: SignInObservation[] = [];
		const duplicateEvents: SignInObservation[] = [];
		const wrongSetup = observedSetup(wrongEvents);
		const duplicateSetup = observedSetup(duplicateEvents);
		const [wrongContext, duplicateContext] = await Promise.all([
			createCaptureContext(wrongSetup),
			createCaptureContext(duplicateSetup),
		]);
		const nativeTimestampFormatter = vi.spyOn(Date.prototype, 'toISOString');
		let wrongResult: ReturnType<(typeof wrongSetup.plugins)[0]['onRequest']> | undefined;
		let duplicateResult: ReturnType<(typeof duplicateSetup.plugins)[0]['onRequest']> | undefined;
		try {
			if (arrival === 'wrong-action-first') {
				wrongResult = wrongSetup.plugins[0].onRequest(
					createControlledRequest('wrong-token'),
					wrongContext,
				);
				await wrong.entered.promise;
				duplicateResult = duplicateSetup.plugins[0].onRequest(
					createControlledRequest('duplicate-token'),
					duplicateContext,
				);
				await duplicate.entered.promise;
				wrong.release();
				await wrongResult;
				duplicate.release();
				await duplicateResult;
			} else {
				duplicateResult = duplicateSetup.plugins[0].onRequest(
					createControlledRequest('duplicate-token'),
					duplicateContext,
				);
				await duplicate.entered.promise;
				wrongResult = wrongSetup.plugins[0].onRequest(
					createControlledRequest('wrong-token'),
					wrongContext,
				);
				await wrong.entered.promise;
				duplicate.release();
				await duplicateResult;
				wrong.release();
				await wrongResult;
			}
			expect(await wrongResult).toBe(wrong.result);
			expect(await duplicateResult).toBe(duplicate.result);
			expect(wrong.result.response.bodyUsed).toBe(false);
			expect(duplicate.result.response.bodyUsed).toBe(false);
			const nativeBody = '{"code":"VERIFICATION_FAILED","message":"Captcha verification failed"}';
			expect(await wrong.result.response.text()).toBe(nativeBody);
			expect(await duplicate.result.response.text()).toBe(nativeBody);
			expect(wrongEvents).toEqual([
				{ kind: 'captcha-refused', action: 'sign_in_social', reason: 'wrong-action' },
			]);
			expect(duplicateEvents).toEqual([
				{ kind: 'captcha-refused', action: 'sign_in_social', reason: 'duplicate' },
			]);
			expect(nativeTimestampFormatter).toHaveNthReturnedWith(1, frozenLogTimestamp);
			expect(nativeTimestampFormatter).toHaveNthReturnedWith(2, frozenLogTimestamp);
		} finally {
			wrong.release();
			duplicate.release();
			await Promise.allSettled([wrongResult, duplicateResult]);
		}
	},
);

test('captcha observation preserves an accepted native hook without adding a response or event', async () => {
	const events: SignInObservation[] = [];
	const setup = observedSetup(events);
	const context = await createCaptureContext(setup);
	const result = await setup.plugins[0].onRequest(
		createControlledRequest('accepted-token'),
		context,
	);
	expect(result).toBeUndefined();
	expect(events).toEqual([]);
});
