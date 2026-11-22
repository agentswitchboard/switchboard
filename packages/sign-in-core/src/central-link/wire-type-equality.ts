export type WireTypesEqual<Actual, Expected> = 0 extends 1 & Actual
	? false
	: 0 extends 1 & Expected
		? false
		: [Actual] extends [Expected]
			? [Expected] extends [Actual]
				? true
				: false
			: false;

export type AssertWireType<Matches extends true> = Matches;
