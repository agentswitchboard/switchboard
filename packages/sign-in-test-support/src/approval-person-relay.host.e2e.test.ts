import {
	createMemoryProofKeyStore,
	runApprovalsCommand,
	type ApprovalsCommandOptions,
	type FleetCliIo,
} from '@agent-collaboration/sign-in-owner-cli';
import { createWebSignInCapabilities } from '@agent-collaboration/sign-in-platform-web';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	fleetCliIoFor,
	initialTime,
	setupFleetCli,
	type FleetFixture,
} from '#sign-in-test-support/test-fixtures/fleet-cli-fixture';
import {
	peoplePost,
	signInConfirmedPeopleBrowser,
} from '#sign-in-test-support/test-fixtures/people-browser-login';
import { webSignInCrypto } from '#sign-in-test-support/test-fixtures/recording-sign-in-capabilities';

useControlledSignInClock();

const ids = createWebSignInCapabilities().ids;
const minute = 60_000;

/**
 * One `approvals` command through the owner CLI's real entry, with this person's fleet
 * credential, against the running sign-in host and its central stand-in.
 */
function approvalsCli(props: {
	readonly fixture: FleetFixture;
	readonly io: FleetCliIo;
	readonly organizationId: string;
}): (
	args: readonly string[],
	options?: ApprovalsCommandOptions,
) => Promise<{ readonly exitCode: number; readonly lines: readonly string[] }> {
	const store = createMemoryProofKeyStore(webSignInCrypto);
	return async (args, options = {}) => {
		const lines: string[] = [];
		const exitCode = await runApprovalsCommand({
			arguments: args,
			target: { ...props.fixture.harness.target, organizationId: props.organizationId },
			options,
			environment: {
				io: props.io,
				store: () => store,
				confirmSecondFactor: async () => {
					throw new Error('approvals never ask for a second factor');
				},
				write: (line) => lines.push(line),
			},
		});
		return { exitCode, lines };
	};
}

it('approvals: the owner lists, reads and decides through the relay; central replies in its committed shapes', async () => {
	// Arrange: four unproven calls in the owner's organization, one raised past its deadline.
	const fixture = await setupFleetCli();
	const { harness, target } = fixture;
	try {
		const organizationId = target.organizationId;
		// Central orders by request id; ids minted in one millisecond differ only in random bits,
		// so they are named in id order: timedOut < first < second < third.
		const [timedOut = '', first = '', second = '', third = ''] = [
			ids.nextId(),
			ids.nextId(),
			ids.nextId(),
			ids.nextId(),
		].toSorted();
		harness.centralApprovals.seedUnprovenCall({
			organizationId,
			requestId: timedOut,
			raisedAtMillis: initialTime - 120 * minute,
		});
		for (const [index, requestId] of [first, second, third].entries())
			harness.centralApprovals.seedUnprovenCall({
				organizationId,
				requestId,
				raisedAtMillis: initialTime - (10 - index) * minute,
			});
		harness.centralApprovals.setPageSize(2);
		const approvals = approvalsCli({ fixture, io: fixture.io, organizationId });

		// Act / Assert: list pages newest first; the timed-out call is waiting no longer.
		const firstPage = await approvals(['list']);
		expect(firstPage.exitCode).toBe(0);
		expect(firstPage.lines.map((line) => line.split('  ')[0])).toEqual([
			third,
			second,
			`More: approvals list --cursor ${second}`,
		]);
		const secondPage = await approvals(['list'], { cursor: second });
		expect(secondPage.lines.map((line) => line.split('  ')[0])).toEqual([first]);
		const everything = await approvals(['list'], { all: true, cursor: first });
		expect(everything.lines).toEqual([
			expect.stringMatching(new RegExp(`^${timedOut}  unproven call  timedOut  `, 'u')),
		]);

		// read: a request this organization does not hold is notVisible.
		expect(await approvals(['show', ids.nextId()])).toEqual({ exitCode: 2, lines: ['Not found.'] });
		const shown = await approvals(['show', first]);
		expect(shown.exitCode).toBe(0);
		expect(shown.lines[0]).toBe(`${first}  unproven call  waiting`);

		// decide: saved, then a second answer is alreadyDecided, naming who and when.
		expect(await approvals(['approve', first])).toEqual({
			exitCode: 0,
			lines: ['Decision saved: allow.'],
		});
		const again = await approvals(['deny', first]);
		expect(again.exitCode).toBe(2);
		const ownerId = harness.centralApprovals.arrivals.at(-1)?.personId;
		expect(again.lines).toEqual([
			`Already decided by person ${ownerId} at ${new Date(initialTime).toISOString().replace('.000Z', 'Z')}; this answer was not saved.`,
		]);
		// tooLate: the deadline passed before an answer.
		expect(await approvals(['approve', timedOut])).toEqual({
			exitCode: 2,
			lines: ['Too late: the request timed out or was closed before an answer.'],
		});
		// operationConflict: the same operation id with a different answer.
		const operationId = ids.nextId();
		expect((await approvals(['approve', second], { 'operation-id': operationId })).exitCode).toBe(
			0,
		);
		expect(await approvals(['deny', second], { 'operation-id': operationId })).toEqual({
			exitCode: 2,
			lines: ['This operation id was already used with a different answer.'],
		});

		// Every C3 request reached central with the owner's own credential and approval:decide.
		const arrivals = harness.centralApprovals.arrivals;
		expect(arrivals.every((arrival) => arrival.outcome.kind === 'replied')).toBe(true);
		expect(new Set(arrivals.map((arrival) => arrival.personId))).toEqual(new Set([ownerId]));
		expect(arrivals.every((arrival) => arrival.permissions?.includes('approval:decide'))).toBe(
			true,
		);
	} finally {
		await harness.close();
	}
});

it('approvals: a lost decide reply is recovered by the retry with the same operation id, not decided twice', async () => {
	// Arrange
	const fixture = await setupFleetCli();
	const { harness, target } = fixture;
	try {
		const organizationId = target.organizationId;
		const requestId = ids.nextId();
		harness.centralApprovals.seedUnprovenCall({
			organizationId,
			requestId,
			raisedAtMillis: initialTime - minute,
		});
		harness.centralApprovals.loseNextDecideReply();
		const approvals = approvalsCli({ fixture, io: fixture.io, organizationId });
		// Act
		const result = await approvals(['approve', requestId]);
		// Assert: the first decide was applied and its reply lost; the retry got the same result.
		expect(result).toEqual({ exitCode: 0, lines: ['Decision saved: allow.'] });
		const decides = harness.centralApprovals.arrivals.filter(
			(arrival) => arrival.route === 'ApprovalDecide',
		);
		expect(decides.map((arrival) => arrival.outcome)).toEqual([
			{
				kind: 'replied',
				reply: expect.objectContaining({ kind: 'savedDecision' }),
				delivered: false,
			},
			{
				kind: 'replied',
				reply: expect.objectContaining({ kind: 'savedDecision' }),
				delivered: true,
			},
		]);
		expect(decides[0]?.operationId).toEqual(z.uuidv7().parse(decides[1]?.operationId));
		expect(decides[0]?.bodySha256).toBe(decides[1]?.bodySha256);
	} finally {
		await harness.close();
	}
});

it('approvals: a member, who holds no approval:decide, is refused by central on every route', async () => {
	// Arrange: the owner invites a member, who signs in, accepts, and signs in to the fleet CLI.
	const fixture = await setupFleetCli();
	const { harness, target } = fixture;
	try {
		const organizationId = target.organizationId;
		const requestId = ids.nextId();
		harness.centralApprovals.seedUnprovenCall({
			organizationId,
			requestId,
			raisedAtMillis: initialTime - minute,
		});
		const invited = await peoplePost(
			harness,
			'invite-member',
			{ organizationId, email: 'member@example.invalid', role: 'member' },
			fixture.cookie,
		);
		const invitationId = z.object({ id: z.uuidv7() }).parse(await invited.json()).id;
		const memberId = await signInConfirmedPeopleBrowser({
			harness,
			email: 'member@example.invalid',
		});
		expect((await peoplePost(harness, 'accept-invitation', { invitationId })).status).toBe(200);
		await harness.settleDeferredWork();
		const memberIo = fleetCliIoFor({
			harness,
			cookie: harness.cookie(),
			now: () => initialTime,
			sent: [],
		});
		const approvals = approvalsCli({ fixture, io: memberIo, organizationId });
		const notPermitted =
			"Not permitted: answering approvals needs the organization owner's approval:decide.";
		// Act / Assert
		expect(await approvals(['list'])).toEqual({ exitCode: 2, lines: [notPermitted] });
		expect(await approvals(['approve', requestId])).toEqual({ exitCode: 2, lines: [notPermitted] });
		const arrivals = harness.centralApprovals.arrivals;
		expect(arrivals.map((arrival) => [arrival.route, arrival.outcome])).toEqual([
			['ApprovalList', { kind: 'refused', reason: 'notPermitted' }],
			['ApprovalRead', { kind: 'refused', reason: 'notPermitted' }],
		]);
		expect(arrivals.every((arrival) => arrival.personId === memberId)).toBe(true);
		expect(arrivals.some((arrival) => arrival.permissions?.includes('approval:decide'))).toBe(
			false,
		);
	} finally {
		await harness.close();
	}
});
