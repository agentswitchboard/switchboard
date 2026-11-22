import ts from 'typescript';

export function unwrapExpression(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (
		ts.isAsExpression(current) ||
		ts.isTypeAssertionExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isParenthesizedExpression(current)
	)
		current = current.expression;
	return current;
}

export function resolveDeclaration(
	expression: ts.Expression,
	checker: ts.TypeChecker,
): ts.Declaration | undefined {
	let symbol = checker.getSymbolAtLocation(expression);
	if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
		symbol = checker.getAliasedSymbol(symbol);
	return symbol?.valueDeclaration;
}

/** The `path` of every entry of a const route table (an array of object literals). */
export function pathsOfRouteTable(
	table: ts.Expression,
	checker: ts.TypeChecker,
): readonly string[] {
	const declaration = resolveDeclaration(table, checker);
	const initializer =
		declaration !== undefined && ts.isVariableDeclaration(declaration)
			? declaration.initializer
			: undefined;
	const array = initializer === undefined ? undefined : unwrapExpression(initializer);
	if (array === undefined || !ts.isArrayLiteralExpression(array))
		throw new Error('Non-literal pathname route table behind a route predicate');
	return array.elements.map((element) => {
		const entry = unwrapExpression(element);
		const pathProperty = ts.isObjectLiteralExpression(entry)
			? entry.properties.find(
					(property): property is ts.PropertyAssignment =>
						ts.isPropertyAssignment(property) &&
						ts.isIdentifier(property.name) &&
						property.name.text === 'path',
				)
			: undefined;
		const value =
			pathProperty === undefined ? undefined : unwrapExpression(pathProperty.initializer);
		if (
			value === undefined ||
			!(ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
		)
			throw new Error('Non-literal path in a route table behind a route predicate');
		return value.text;
	});
}

/** The string-literal keys of a const object literal (`as const` and `satisfies` allowed). */
export function keysOfRouteObject(
	table: ts.Expression,
	checker: ts.TypeChecker,
): readonly string[] {
	const declaration = resolveDeclaration(table, checker);
	const initializer =
		declaration !== undefined && ts.isVariableDeclaration(declaration)
			? declaration.initializer
			: undefined;
	const object = initializer === undefined ? undefined : unwrapExpression(initializer);
	if (object === undefined || !ts.isObjectLiteralExpression(object))
		throw new Error('Non-literal route object behind a route predicate');
	return object.properties.map((property) => {
		const name = ts.isPropertyAssignment(property) ? property.name : undefined;
		if (name === undefined || !(ts.isStringLiteral(name) || ts.isIdentifier(name)))
			throw new Error('Non-literal key in a route object behind a route predicate');
		return name.text;
	});
}

export function isPathname(expression: ts.Expression): boolean {
	return (
		(ts.isIdentifier(expression) && expression.text === 'pathname') ||
		(ts.isPropertyAccessExpression(expression) && expression.name.text === 'pathname')
	);
}

/** The one error every unsupported route form throws. */
export function unsupportedRouteForm(node: ts.Node, why: string): never {
	const at = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
	throw new Error(
		`Unsupported route predicate form: ${why} at ${node.getSourceFile().fileName}:${at.line + 1}`,
	);
}

/**
 * The routes a predicate function keeps in a table, when its body is `table.some((route) =>
 * route.path === pathname)` or `Object.hasOwn(table, pathname)`; undefined for any other body.
 */
export function tablePathsOfDeclaration(
	declaration: ts.FunctionDeclaration,
	checker: ts.TypeChecker,
): readonly string[] | undefined {
	if (declaration.body === undefined) return undefined;
	const found: string[] = [];
	let followed = false;
	function scan(node: ts.Node): void {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === 'some'
		) {
			const callback = node.arguments[0];
			const comparesPath =
				callback !== undefined &&
				(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
				JSON.stringify(callback.body.getText()).includes('.path');
			if (comparesPath) {
				followed = true;
				found.push(...pathsOfRouteTable(node.expression.expression, checker));
			}
		}
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === 'hasOwn' &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === 'Object' &&
			node.arguments[0] !== undefined
		) {
			followed = true;
			found.push(...keysOfRouteObject(node.arguments[0], checker));
		}
		ts.forEachChild(node, scan);
	}
	scan(declaration.body);
	return followed ? found : undefined;
}
