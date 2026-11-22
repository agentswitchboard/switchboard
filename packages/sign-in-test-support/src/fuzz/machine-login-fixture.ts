import { uuid7Schema } from '@agent-collaboration/sign-in-core';
import {
	decideDeviceLoginSchema,
	decideMachineTokenSchema,
	type MachineLoginConfiguration,
} from '@agent-collaboration/sign-in-core/better-auth';
import { z } from 'zod';

import type { RequestFamilyContext } from '#sign-in-test-support/fuzz/request-families/index';
import { controlledSignInIds } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import type { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { peoplePost } from '#sign-in-test-support/test-fixtures/people-browser-login';

export const fuzzMachineLogin: Omit<MachineLoginConfiguration, 'linkUrlTemplate'> = {
	routerClientId: uuid7Schema.parse('019a3dce-2000-7000-8000-0000000000f1'),
	machineAudience: 'https://machine.example.invalid',
	fleetCentral: {
		receiver: uuid7Schema.parse('019a3dce-2000-7000-8000-0000000000f2'),
		relay: uuid7Schema.parse('019a3dce-2000-7000-8000-0000000000f3'),
	},
};

async function machineDecisions(request: Request): Promise<Response> {
	const path = new URL(request.url).pathname;
	const input: unknown = await request.json();
	if (path === '/internal/device-login-decisions') {
		const decision = decideDeviceLoginSchema.parse(input);
		return Response.json({
			result: 'approved',
			enrollmentId: controlledSignInIds.nextId(),
			label: decision.label,
			allowedWorkspaces: decision.allowedWorkspaces,
		});
	}
	if (path === '/organization-admin/v1/revoke-machine-enrollment') {
		if (!request.headers.get('authorization')?.startsWith('DPoP ') || !request.headers.has('dpop'))
			return new Response(null, { status: 401 });
		z.strictObject({ organizationId: z.uuidv7(), enrollmentId: z.uuidv7() }).parse(input);
		return Response.json({ result: 'notFound' });
	}
	decideMachineTokenSchema.parse(input);
	return Response.json({ result: 'refuse', reason: { kind: 'enrollmentNotActive' } });
}

export const fuzzMachineOptions = {
	machineLogin: fuzzMachineLogin,
	machineDecisions,
	turnstileSecret: 'published-test',
} as const;

const verifiedCodeRoutes = new Set([
	'/device',
	'/api/auth/machine-login/approve',
	'/api/auth/machine-login/deny',
]);

export async function prepareMachineCode(props: {
	readonly path: string;
	readonly harness: Awaited<ReturnType<typeof startLocalAuthHarness>>;
	readonly ownerCookie: string;
	readonly context: RequestFamilyContext;
}): Promise<RequestFamilyContext> {
	const { path, harness, ownerCookie, context } = props;
	if (
		!verifiedCodeRoutes.has(path) &&
		path !== '/api/auth/device' &&
		path !== '/api/auth/oauth2/token'
	)
		return context;
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
	const { device_code, user_code } = z
		.object({ device_code: z.string().min(1), user_code: z.string().min(1) })
		.parse(await issued.json());
	if (verifiedCodeRoutes.has(path)) {
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
		const verified = await harness.auth(`/api/auth/device?${new URLSearchParams({ user_code })}`, {
			headers: { cookie: ownerCookie },
		});
		if (!verified.ok)
			throw new Error(`F1 machine fixture could not verify the device code (${verified.status})`);
	}
	return { ...context, machineDeviceCode: device_code, machineUserCode: user_code };
}
