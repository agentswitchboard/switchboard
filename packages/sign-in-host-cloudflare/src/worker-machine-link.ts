import {
	centralLinkUpgradeRequest,
	uuid7Schema,
	type CentralTransport,
} from '@agent-collaboration/sign-in-core';

const publicLinkPrefix = '/api/fleet/link/';

/** Returns the binding's original response so workerd can carry its WebSocket to the client. */
export function forwardWorkerMachineLink(
	request: Request,
	bindings: { readonly CENTRAL_LINK: CentralTransport },
): Promise<Response> | undefined {
	if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
		return undefined;
	const address = new URL(request.url);
	if (address.search !== '' || !address.pathname.startsWith(publicLinkPrefix)) return undefined;
	const organization = uuid7Schema.safeParse(address.pathname.slice(publicLinkPrefix.length));
	if (!organization.success) return undefined;
	const authorization = request.headers.get('authorization') ?? '';
	if (!/^Bearer [^\s]+$/iu.test(authorization))
		return Promise.resolve(new Response(null, { status: 401 }));
	return bindings.CENTRAL_LINK.fetch(
		centralLinkUpgradeRequest({
			principal: 'machine',
			organizationId: organization.data,
			authorization,
			handshake: request.headers,
		}),
	);
}
