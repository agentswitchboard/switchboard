import { uuid7Schema } from '@agent-collaboration/sign-in-core';
import {
	decideDeviceLoginSchema,
	decideMachineTokenSchema,
	machineTokenResponseSchema,
	type MachineLoginConfiguration,
} from '@agent-collaboration/sign-in-core/better-auth';
import { z } from 'zod';

import type { RequestFamilyContext } from '#sign-in-test-support/fuzz/request-families/index';
import {
	controlledSignInClock,
	controlledSignInIds,
} from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import type { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { peoplePost } from '#sign-in-test-support/test-fixtures/people-browser-login';

export const fuzzMachineLogin: Omit<MachineLoginConfiguration, 'linkUrlTemplate'> = {
	routerClientId: uuid7Schema.parse('019a3dce-2000-7000-8000-0000000000f1'),
	machineAudience: 'https://central.example.invalid/machine',
};

export function createFuzzMachineOptions(): {
	readonly machineLogin: typeof fuzzMachineLogin;
	readonly machineDecisions: (request: Request) => Promise<Response>;
	readonly turnstileSecret: 'published-test';
} {
	// Each harness owns its synthetic decisions. Every case uses a newly issued enrollment ID.
	const approvals = new Map<
		string,
		{ readonly machineId: string; readonly organizationId: string }
	>();
	async function machineDecisions(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;
		const input: unknown = await request.json();
		if (path === '/internal/device-login-decisions') {
			const decision = decideDeviceLoginSchema.parse(input);
			const enrollmentId = controlledSignInIds.nextId();
			approvals.set(enrollmentId, {
				machineId: decision.machineId,
				organizationId: decision.organizationId,
			});
			return Response.json({
				result: 'approved',
				enrollmentId,
				label: decision.label,
				allowedWorkspaces: decision.allowedWorkspaces,
			});
		}
		if (path === '/organization-admin/v1/revoke-machine-enrollment') {
			if (
				!request.headers.get('authorization')?.startsWith('DPoP ') ||
				!request.headers.has('dpop')
			)
				return new Response(null, { status: 401 });
			z.strictObject({ organizationId: z.uuidv7(), enrollmentId: z.uuidv7() }).parse(input);
			return Response.json({ result: 'notFound' });
		}
		const token = decideMachineTokenSchema.parse(input);
		const approved = approvals.get(token.enrollmentId);
		if (approved?.organizationId !== token.organizationId || token.clientId !== token.enrollmentId)
			return Response.json({ result: 'refuse', reason: { kind: 'enrollmentNotActive' } });
		const now = Math.floor(controlledSignInClock.now() / 1000);
		return Response.json({
			result: 'grant',
			machineId: approved.machineId,
			enrollmentId: token.enrollmentId,
			decidedAt: now,
			grantExpiresAt: now + 3600,
		});
	}
	return { machineLogin: fuzzMachineLogin, machineDecisions, turnstileSecret: 'published-test' };
}

const verifiedCodeRoutes = new Set([
	'/device',
	'/api/auth/machine-login/approve',
	'/api/auth/machine-login/deny',
]);
const tokenPath = '/api/auth/oauth2/token';
const revokePath = '/api/auth/oauth2/revoke';

export async function prepareMachineCode(props: {
	readonly path: string;
	readonly harness: Awaited<ReturnType<typeof startLocalAuthHarness>>;
	readonly ownerCookie: string;
	readonly context: RequestFamilyContext;
	readonly machineRefreshVariant: boolean;
}): Promise<RequestFamilyContext> {
	const { path, harness, ownerCookie, context } = props;
	const needsRefresh = props.machineRefreshVariant || path === revokePath;
	if (
		!verifiedCodeRoutes.has(path) &&
		path !== '/api/auth/device' &&
		path !== tokenPath &&
		!needsRefresh
	)
		return context;
	async function issueCode(): Promise<{
		readonly device_code: string;
		readonly user_code: string;
	}> {
		const issued = await harness.auth('/api/auth/device/code', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: '' },
			body: JSON.stringify({
				client_id: context.machineRouterClientId,
				machine_id: context.machineId,
				machine_label: 'Fuzz fixture machine',
				organization_id: context.organizationId,
			}),
		});
		if (!issued.ok)
			throw new Error(`F1 machine fixture could not issue a device code (${issued.status})`);
		return z
			.object({ device_code: z.string().min(1), user_code: z.string().min(1) })
			.parse(await issued.json());
	}
	async function verifyCode(userCode: string): Promise<void> {
		const active = await peoplePost(
			harness,
			'set-active',
			{ organizationId: context.organizationId },
			ownerCookie,
		);
		if (!active.ok)
			throw new Error(
				`F1 machine fixture could not activate the owner organization (${active.status})`,
			);
		const verified = await harness.auth(
			`/api/auth/device?${new URLSearchParams({ user_code: userCode })}`,
			{
				headers: { cookie: ownerCookie },
			},
		);
		if (!verified.ok)
			throw new Error(`F1 machine fixture could not verify the device code (${verified.status})`);
	}
	if (!needsRefresh) {
		const pending = await issueCode();
		if (verifiedCodeRoutes.has(path)) await verifyCode(pending.user_code);
		return {
			...context,
			machineDeviceCode: pending.device_code,
			machineUserCode: pending.user_code,
		};
	}

	// A deep random run may draw a pending poll even when it preloads refresh credentials.
	const pending = path === tokenPath ? await issueCode() : undefined;
	const refreshCode = await issueCode();
	await verifyCode(refreshCode.user_code);
	const bootstrap = await harness.auth('/api/auth/owner/bootstrap', {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: ownerCookie },
		body: '{}',
	});
	if (!bootstrap.ok) throw new Error(`F1 machine fixture bootstrap failed (${bootstrap.status})`);
	const approved = await harness.auth('/api/auth/machine-login/approve', {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: harness.issuer, cookie: ownerCookie },
		body: JSON.stringify({ userCode: refreshCode.user_code, allowedWorkspaces: [] }),
	});
	if (!approved.ok) {
		const refusal = z
			.object({ error: z.string(), reason: z.object({ kind: z.string() }).optional() })
			.safeParse(await approved.json().catch(() => null));
		throw new Error(
			`F1 machine fixture approval failed (${approved.status}, ${refusal.success ? (refusal.data.reason?.kind ?? refusal.data.error) : 'unknown refusal'})`,
		);
	}
	const { enrollmentId } = z.object({ enrollmentId: z.uuidv7() }).parse(await approved.json());
	async function requestToken(
		fields: Record<string, string>,
	): Promise<z.infer<typeof machineTokenResponseSchema>> {
		const reply = await harness.auth(tokenPath, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: '' },
			body: new URLSearchParams(fields),
		});
		if (!reply.ok) throw new Error(`F1 machine fixture token request failed (${reply.status})`);
		return machineTokenResponseSchema.strict().parse(await reply.json());
	}
	const first = await requestToken({
		grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
		client_id: context.machineRouterClientId,
		device_code: refreshCode.device_code,
	});
	const rotated = await requestToken({
		grant_type: 'refresh_token',
		client_id: enrollmentId,
		refresh_token: first.refresh_token,
	});
	if (rotated.refresh_token === first.refresh_token || rotated.machine_client_id !== enrollmentId)
		throw new Error('F1 machine fixture credential did not rotate for its enrollment');
	return {
		...context,
		...(pending === undefined
			? {}
			: { machineDeviceCode: pending.device_code, machineUserCode: pending.user_code }),
		machineEnrollmentId: enrollmentId,
		machineRefreshToken: rotated.refresh_token,
	};
}
