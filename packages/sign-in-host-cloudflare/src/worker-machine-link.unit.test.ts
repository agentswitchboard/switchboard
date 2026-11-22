import { expect, it, vi } from 'vitest';

import { forwardWorkerMachineLink } from '#sign-in-host-cloudflare/worker-machine-link';

const organizationId = '019a3dce-2000-7000-8000-0000000000d1';
const publicLink = `https://sign-in.invalid/api/fleet/link/${organizationId}`;

it('returns the binding response as-is and sends only the machine-link handshake', async (): Promise<void> => {
	const refusal = new Response('enrollment refused', { status: 401 });
	const fetch = vi.fn(async (outbound: Request): Promise<Response> => {
		expect(outbound.url).toBe(`http://central.invalid/v1/organizations/${organizationId}/link`);
		expect(outbound.redirect).toBe('manual');
		expect(outbound.headers.get('authorization')).toBe('Bearer synthetic-proof');
		expect(outbound.headers.get('sec-websocket-protocol')).toBe('central-link');
		expect(outbound.headers.has('cookie')).toBe(false);
		return refusal;
	});

	const answer = await forwardWorkerMachineLink(
		new Request(publicLink, {
			headers: {
				upgrade: 'websocket',
				authorization: 'Bearer synthetic-proof',
				'sec-websocket-protocol': 'central-link',
				cookie: 'local-fixture=unused',
			},
		}),
		{ fetch },
	);

	expect(answer).toBe(refusal);
	expect(fetch).toHaveBeenCalledOnce();
});

it.each([
	new Request(publicLink),
	new Request(`${publicLink}/nested`, { headers: { upgrade: 'websocket' } }),
	new Request(`${publicLink}?extra=true`, { headers: { upgrade: 'websocket' } }),
	new Request(publicLink, { method: 'POST', headers: { upgrade: 'websocket' } }),
])('leaves unrelated requests on the ordinary Sign-in path', (request): void => {
	const fetch = vi.fn();

	expect(forwardWorkerMachineLink(request, { fetch })).toBeUndefined();
	expect(fetch).not.toHaveBeenCalled();
});
