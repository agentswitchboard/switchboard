import {
	authorizationRevisionAcknowledgementSchema,
	authorizationRevisionPushSchema,
} from '@agent-collaboration/sign-in-core';

import type { CentralPeerExchange } from '#sign-in-test-support/test-fixtures/controlled-central-provisioning';

/** A person-revision push for which Central actually replied 200 with its retained floor. */
export interface CentralAcknowledgement {
	readonly kind: 'person';
	readonly organizationId: string;
	readonly personId: string;
	/** The revision the push carried. */
	readonly revision: number;
	/** The floor Central's reply returned for it. */
	readonly acknowledgedRevision: number;
}

const pushRoute = '/internal/organization-authorization-revisions';

/**
 * Central's actual acknowledgements, read from the exchanges the stand-in recorded: the push body
 * as received paired with a 200 reply that parses as an acknowledgement. A received push alone, a
 * 412, 409 or 503 reply, a lost reply, and the stand-in's reply mode never count.
 */
export function readCentralAcknowledgements(
	exchanges: readonly CentralPeerExchange[],
): readonly CentralAcknowledgement[] {
	return exchanges.flatMap((exchange): readonly CentralAcknowledgement[] => {
		if (exchange.path !== pushRoute || exchange.response.kind !== 'answered') return [];
		if (exchange.response.status !== 200) return [];
		let requestBody: unknown;
		let replyBody: unknown;
		try {
			requestBody = JSON.parse(exchange.requestBody);
			replyBody = JSON.parse(exchange.response.body);
		} catch {
			return [];
		}
		const push = authorizationRevisionPushSchema.safeParse(requestBody);
		const reply = authorizationRevisionAcknowledgementSchema.safeParse(replyBody);
		if (!push.success || !reply.success || push.data.kind !== 'person') return [];
		return [
			{
				kind: 'person',
				organizationId: push.data.organizationId,
				personId: push.data.personId,
				revision: push.data.revision,
				acknowledgedRevision: reply.data.acknowledgedRevision,
			},
		];
	});
}
