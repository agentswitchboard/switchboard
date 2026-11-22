import { expect, it } from 'vitest';

import { createMePageRequestTracker } from '#sign-in-test-support/test-fixtures/me-page-request-tracker';

const origin = 'http://localhost:1';
const listUrl = `${origin}/api/auth/passkey/list-user-passkeys`;
const sessionUrl = `${origin}/api/auth/get-session`;

function tracker(): ReturnType<typeof createMePageRequestTracker> {
	return createMePageRequestTracker({
		origin,
		paths: ['/api/auth/passkey/list-user-passkeys', '/api/auth/get-session'],
	});
}

it('does not let a ready-page request that finishes after Me committed settle the Me wait', async () => {
	const waiting = tracker();
	const readyPageList = {};
	const meSession = {};
	const meList = {};
	waiting.observeIssued(readyPageList, {
		method: 'GET',
		url: listUrl,
		documentPathname: '/owner-ready',
	});
	// Me commits; its session request goes out and ends, and only then the old page's list arrives.
	waiting.observeIssued(meSession, { method: 'GET', url: sessionUrl, documentPathname: '/me' });
	waiting.observeIssued(meList, { method: 'GET', url: listUrl, documentPathname: '/me' });
	waiting.observeTerminal(meSession, 'finished');
	waiting.observeTerminal(readyPageList, 'finished');
	let settled = false;
	void waiting.settled.then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
	waiting.observeTerminal(meList, 'finished');
	expect([...(await waiting.settled)]).toEqual([
		['/api/auth/get-session', 'finished'],
		['/api/auth/passkey/list-user-passkeys', 'finished'],
	]);
});

it('ignores requests of another method, origin or path', async () => {
	const waiting = tracker();
	const others = [
		{ method: 'POST', url: listUrl },
		{ method: 'GET', url: 'http://elsewhere.invalid/api/auth/passkey/list-user-passkeys' },
		{ method: 'GET', url: `${origin}/api/auth/other` },
	].map((issued) => {
		const request = {};
		waiting.observeIssued(request, { ...issued, documentPathname: '/me' });
		return request;
	});
	for (const request of others) waiting.observeTerminal(request, 'finished');
	let settled = false;
	void waiting.settled.then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
});
