/** Normalize intersections into object shapes without merging distinct union arms. */
type WireShape<Value> = Value extends object
	? { [Key in keyof Value]: WireShape<Value[Key]> }
	: Value;

/** Exact comparison keeps optional and nested keys visible to the type checker. */
export type WireTypesEqual<Actual, Expected> =
	(<Probe>() => Probe extends WireShape<Actual> ? true : false) extends <
		Probe,
	>() => Probe extends WireShape<Expected> ? true : false
		? (<Probe>() => Probe extends WireShape<Expected> ? true : false) extends <
				Probe,
			>() => Probe extends WireShape<Actual> ? true : false
			? true
			: false
		: false;

export type AssertWireType<Matches extends true> = Matches;
