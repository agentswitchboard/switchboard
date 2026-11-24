/** The WebSocket handshake headers a link upgrade carries to central; nothing else crosses. */
const centralLinkHandshakeHeaders = [
	'sec-websocket-key',
	'sec-websocket-version',
	'sec-websocket-protocol',
	'sec-websocket-extensions',
] as const;

/**
 * Central's two organization link routes: a Mac's, and a person's (C8, agreed with central). Central
 * refuses a token whose audience or profile does not match the route it arrived on.
 */
const centralLinkRoutePaths = { machine: 'link', person: 'person-link' } as const;

/**
 * Central's organization link upgrade, built from an allowlist: the handshake headers and the one
 * credential sign-in chooses. A Mac's link carries its own bearer; a person's carries the
 * person-link token sign-in minted. Cookies, the incoming Authorization and DPoP never cross.
 */
export function centralLinkUpgradeRequest(props: {
	readonly principal: keyof typeof centralLinkRoutePaths;
	readonly organizationId: string;
	readonly authorization: string;
	readonly handshake: Headers;
}): Request {
	const headers = new Headers({
		connection: 'Upgrade',
		upgrade: 'websocket',
		authorization: props.authorization,
	});
	for (const name of centralLinkHandshakeHeaders) {
		const value = props.handshake.get(name);
		if (value !== null) headers.set(name, value);
	}
	return new Request(
		`http://central.invalid/v1/organizations/${props.organizationId}/${centralLinkRoutePaths[props.principal]}`,
		{
			headers,
			redirect: 'manual',
		},
	);
}
