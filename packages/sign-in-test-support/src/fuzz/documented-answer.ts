import { expect } from 'vitest';

import type { GeneratedRequest } from '#sign-in-test-support/fuzz/request-families/index';
import {
	documentedAnswersFor,
	type RouteCaller,
	type RouteClassification,
} from '#sign-in-test-support/fuzz/route-classification';

/**
 * S2 documented answer: the status must be one the route documents for this caller and this
 * generated request. The request is required, not optional, so a caller of this check cannot leave
 * out the part of the oracle that refuses a success for a body the route cannot read.
 */
export function assertDocumentedAnswer(props: {
	readonly classification: Parameters<typeof documentedAnswersFor>[0] &
		Pick<RouteClassification, 'path'>;
	readonly caller: RouteCaller;
	readonly request: GeneratedRequest;
	readonly status: number;
}): void {
	expect(
		documentedAnswersFor(props.classification, props.caller, props.request),
		`S2 documented-answer: ${props.classification.path} for ${props.caller}, ${props.request.label}`,
	).toContain(props.status);
}
