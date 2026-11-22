import { uuid7Schema, type CentralTransport } from '@agent-collaboration/sign-in-core';

const publicLinkPrefix = '/api/fleet/link/';
const machineLinkHandshakeHeaders = [
	'authorization',
	'sec-websocket-key',
	'sec-websocket-version',
	'sec-websocket-protocol',
	'sec-websocket-extensions',
] as const;

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
	const headers = new Headers({ connection: 'Upgrade', upgrade: 'websocket' });
	for (const name of machineLinkHandshakeHeaders) {
		const value = request.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	return bindings.CENTRAL_LINK.fetch(
		new Request(`http://central.invalid/v1/organizations/${organization.data}/link`, {
			headers,
			redirect: 'manual',
		}),
	);
}
