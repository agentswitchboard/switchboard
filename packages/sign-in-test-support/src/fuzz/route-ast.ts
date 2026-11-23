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

function literalRouteCase(expression: ts.Expression, checker: ts.TypeChecker): string | undefined {
	if (ts.isStringLiteral(expression)) return expression.text;
	if (!ts.isIdentifier(expression)) return undefined;
	const declaration = resolveDeclaration(expression, checker);
	if (
		declaration === undefined ||
		!ts.isVariableDeclaration(declaration) ||
		!ts.isVariableDeclarationList(declaration.parent) ||
		(declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
		declaration.initializer === undefined
	)
		return undefined;
	const initializer = unwrapExpression(declaration.initializer);
	return ts.isStringLiteral(initializer) ? initializer.text : undefined;
}

/** A switch on the first argument with literal path cases that return one equality on the second. */
export function methodPathPairsOfDeclaration(
	declaration: ts.FunctionDeclaration,
	checker: ts.TypeChecker,
): readonly { readonly path: string; readonly method: string }[] | undefined {
	const [pathname, method] = declaration.parameters.map((parameter) => parameter.name.getText());
	const [dispatch] = declaration.body?.statements ?? [];
	if (
		declaration.parameters.length !== 2 ||
		declaration.body?.statements.length !== 1 ||
		dispatch === undefined ||
		!ts.isSwitchStatement(dispatch) ||
		!ts.isIdentifier(dispatch.expression) ||
		dispatch.expression.text !== pathname
	)
		return undefined;
	const clauses = dispatch.caseBlock.clauses;
	const fallback = clauses.at(-1);
	const fallbackReturn = fallback?.statements[0];
	if (
		fallback === undefined ||
		!ts.isDefaultClause(fallback) ||
		fallback.statements.length !== 1 ||
		fallbackReturn === undefined ||
		!ts.isReturnStatement(fallbackReturn) ||
		fallbackReturn.expression?.kind !== ts.SyntaxKind.FalseKeyword
	)
		return undefined;
	const pairs: { path: string; method: string }[] = [];
	let groupedPaths: string[] = [];
	for (const clause of clauses.slice(0, -1)) {
		if (!ts.isCaseClause(clause)) return undefined;
		const path = literalRouteCase(clause.expression, checker);
		if (path === undefined) return undefined;
		groupedPaths.push(path);
		if (clause.statements.length === 0) continue;
		const returned = clause.statements[0];
		const comparison =
			returned !== undefined && ts.isReturnStatement(returned) ? returned.expression : undefined;
		if (
			clause.statements.length !== 1 ||
			comparison === undefined ||
			!ts.isBinaryExpression(comparison) ||
			comparison.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
			!ts.isIdentifier(comparison.left) ||
			comparison.left.text !== method ||
			!ts.isStringLiteral(comparison.right)
		)
			return undefined;
		const methodLiteral = comparison.right.text;
		pairs.push(
			...groupedPaths.map((groupedPath) => ({ path: groupedPath, method: methodLiteral })),
		);
		groupedPaths = [];
	}
	return groupedPaths.length === 0 && new Set(pairs.map((pair) => pair.path)).size === pairs.length
		? pairs
		: undefined;
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
