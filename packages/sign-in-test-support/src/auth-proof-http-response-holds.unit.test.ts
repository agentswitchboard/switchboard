import { EventEmitter } from 'node:events';

import { expect, it } from 'vitest';

import { createAuthProofHttpResponseHolds } from '#sign-in-test-support/test-fixtures/auth-proof-http-response-holds';

function observedResponse(): {
	readonly events: EventEmitter;
	readonly chunks: Uint8Array[];
	readonly response: Parameters<
		ReturnType<typeof createAuthProofHttpResponseHolds>['send']
	>[0]['response'];
} {
	const events = new EventEmitter();
	const chunks: Uint8Array[] = [];
	return {
		events,
		chunks,
		response: {
			destroyed: false,
			once: (event, listener) => events.once(event, listener),
			off: (event, listener) => events.off(event, listener),
			flushHeaders: () => {},
			write: (chunk) => chunks.push(chunk),
			end: (chunk) => chunks.push(chunk),
		},
	};
}

it('holds actual response bytes until the HTTP close event without a manual release', async () => {
	const controls = createAuthProofHttpResponseHolds();
	const hold = controls.armNextJwksResponse();
	const observed = observedResponse();
	const body = Buffer.from('{"keys":[]}');
	const sent = controls.send({
		pathname: '/api/auth/jwks',
		method: 'GET',
		holdToken: null,
		response: observed.response,
		body,
	});
	await hold.entered;
	expect(Buffer.concat(observed.chunks).toString()).toBe('{');
	observed.events.emit('close');
	expect(await hold.settled).toBe('closed');
	await sent;
	expect(Buffer.concat(observed.chunks).toString()).toBe('{');
});

it('releases the exact remaining body bytes when the explicit control is used', async () => {
	const controls = createAuthProofHttpResponseHolds();
	const hold = controls.armNextJwksResponse();
	const observed = observedResponse();
	const body = Buffer.from('{"keys":[]}');
	const sent = controls.send({
		pathname: '/api/auth/jwks',
		method: 'GET',
		holdToken: null,
		response: observed.response,
		body,
	});
	await hold.entered;
	hold.release();
	await sent;
	expect(await hold.settled).toBe('released');
	expect(Buffer.concat(observed.chunks)).toEqual(body);
});

it('keeps an armed JWKS hold out of unrelated HTTP responses', async () => {
	const controls = createAuthProofHttpResponseHolds();
	controls.armNextJwksResponse();
	const observed = observedResponse();
	const body = Buffer.from('unchanged');
	await controls.send({
		pathname: '/api/auth/other',
		method: 'GET',
		holdToken: null,
		response: observed.response,
		body,
	});
	expect(Buffer.concat(observed.chunks)).toEqual(body);
	expect(() => controls.armNextJwksResponse()).toThrow('already armed');
});

it('rejects hold entry and disarms the hold when its signal aborts before any response arrives', async () => {
	const controls = createAuthProofHttpResponseHolds();
	const cancellation = new AbortController();
	const hold = controls.armNextGetResponse('/api/auth/other', cancellation.signal);
	const reason = new Error('scenario ended');
	cancellation.abort(reason);
	await expect(hold.entered).rejects.toBe(reason);
	const observed = observedResponse();
	const body = Buffer.from('unheld');
	await controls.send({
		pathname: '/api/auth/other',
		method: 'GET',
		holdToken: null,
		response: observed.response,
		body,
	});
	expect(Buffer.concat(observed.chunks)).toEqual(body);
	expect(() => controls.armNextGetResponse('/api/auth/other')).not.toThrow();
});

it('lets an entered hold finish as closed when its signal aborts', async () => {
	const controls = createAuthProofHttpResponseHolds();
	const cancellation = new AbortController();
	const hold = controls.armNextGetResponse('/api/auth/other', cancellation.signal);
	const observed = observedResponse();
	const sent = controls.send({
		pathname: '/api/auth/other',
		method: 'GET',
		holdToken: null,
		response: observed.response,
		body: Buffer.from('held'),
	});
	await hold.entered;
	cancellation.abort(new Error('scenario ended'));
	await sent;
	expect(await hold.settled).toBe('closed');
});

it('holds only the response whose request carries the armed token', async () => {
	const controls = createAuthProofHttpResponseHolds();
	controls.armNextGetResponse('/api/auth/other', undefined, 'token-one');
	const unmarked = observedResponse();
	const body = Buffer.from('unmarked');
	await controls.send({
		pathname: '/api/auth/other',
		method: 'GET',
		holdToken: null,
		response: unmarked.response,
		body,
	});
	expect(Buffer.concat(unmarked.chunks)).toEqual(body);
	expect(() => controls.armNextGetResponse('/api/auth/other')).toThrow('already armed');
});
