import * as hegel from '@hegeldev/hegel';
import { expect, it } from 'vitest';

import { fuzzSettings } from '#sign-in-test-support/fuzz/fuzz-settings';
import { requestFamilies } from '#sign-in-test-support/fuzz/request-families/index';
import type { RequestFamily } from '#sign-in-test-support/fuzz/request-families/index';
import { syntheticRequestFamilyContext } from '#sign-in-test-support/fuzz/request-families/synthetic-context';

/** A variant family is what a case tests, not how it is encoded: the valid body, one mutation of
 * one named field (near-valid, boundary or wrong-type), or a transport fault. */
function variantFamily(label: string): string {
	if (label.startsWith('malformed:')) return 'malformed';
	if (label.startsWith('wrong-content-type:')) return 'wrong-content-type';
	return label.replace(/^(?:json|form):/u, '');
}

function reachableByRandomDraws(family: RequestFamily): ReadonlySet<string> {
	const drawn = new Set<string>();
	hegel.test(
		(testCase): void => {
			drawn.add(variantFamily(family.generate(testCase, syntheticRequestFamilyContext).label));
		},
		{ ...fuzzSettings(2000), testCases: 2000 },
	);
	return drawn;
}

function visitedByCoveragePass(family: RequestFamily): ReadonlySet<string> {
	const visited = new Set<string>();
	let caseIndex = 0;
	const cases = family.coverageCases(syntheticRequestFamilyContext);
	hegel.test(
		(testCase): void => {
			visited.add(
				variantFamily(family.generate(testCase, syntheticRequestFamilyContext, caseIndex++).label),
			);
		},
		{ ...fuzzSettings(cases), testCases: cases },
	);
	return visited;
}

/** Random draws reach a rare variant family only after hundreds of cases per route (measured:
 * the unknown-provider mutation of sign-in/social needs about 75, one family over 580), which is
 * the cost of the whole campaign several times over on a real host. The coverage pass visits each
 * variant family once, so the default budget is one case per family and misses none. */
it('the coverage pass visits every variant family that random draws can produce', (): void => {
	const missed: string[] = [];
	for (const family of requestFamilies) {
		const visited = visitedByCoveragePass(family);
		const possible = reachableByRandomDraws(family);
		const absent = [...possible].filter((name) => !visited.has(name));
		if (absent.length > 0)
			missed.push(`${family.route.method} ${family.route.path}: ${absent.toSorted().join(', ')}`);
		expect(visited.size).toBeLessThanOrEqual(family.coverageCases(syntheticRequestFamilyContext));
	}
	expect(missed).toEqual([]);
});
