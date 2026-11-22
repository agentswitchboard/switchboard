import ts from 'typescript';

export interface DiscoveredHandlerRoutes {
	readonly paths: readonly string[];
	readonly prefixes: readonly string[];
}

export function unclassifiedHandlerRoutes(
	discovered: DiscoveredHandlerRoutes,
	classifiedPaths: readonly string[],
): DiscoveredHandlerRoutes {
	const paths = new Set(classifiedPaths);
	return {
		paths: discovered.paths.filter((path) => !paths.has(path)),
		prefixes: discovered.prefixes.filter(
			(prefix) => !classifiedPaths.some((path) => path.startsWith(prefix)),
		),
	};
}

function isPathname(expression: ts.Expression): boolean {
	return (
		(ts.isIdentifier(expression) && expression.text === 'pathname') ||
		(ts.isPropertyAccessExpression(expression) && expression.name.text === 'pathname')
	);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
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

function resolveDeclaration(
	expression: ts.Expression,
	checker: ts.TypeChecker,
): ts.Declaration | undefined {
	let symbol = checker.getSymbolAtLocation(expression);
	if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
		symbol = checker.getAliasedSymbol(symbol);
	return symbol?.valueDeclaration;
}

/** The `path` of every entry of a const route table (an array of object literals). */
function pathsOfRouteTable(table: ts.Expression, checker: ts.TypeChecker): readonly string[] {
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
function keysOfRouteObject(table: ts.Expression, checker: ts.TypeChecker): readonly string[] {
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

export interface DiscoveryOptions {
	/**
	 * The files being scanned (as the program names them). A predicate declared in one of them is
	 * understood because its own comparisons are scanned; one declared elsewhere must have a form this
	 * scanner can follow (a route table's `.some`, or `Object.hasOwn(table, pathname)`) or the scan fails.
	 */
	readonly scannedFiles?: readonly string[];
}

/**
 * A call such as `isSignedInNavigationPath(pathname)` hides its routes in a table: its body is
 * `table.some((route) => route.path === pathname)`, and `isFleetAdminRelayRoute(pathname)` is
 * `Object.hasOwn(table, pathname)`. Follow either to the table. A predicate declared in a scanned
 * file is read where it is declared. Any other predicate form is unsupported and fails the scan,
 * never silently ignored.
 */
function pathsBehindPredicate(
	call: ts.CallExpression,
	checker: ts.TypeChecker,
	options: DiscoveryOptions,
): readonly string[] {
	if (!ts.isIdentifier(call.expression) || !call.arguments.some(isPathname)) return [];
	const declaration = resolveDeclaration(call.expression, checker);
	if (
		declaration === undefined ||
		!ts.isFunctionDeclaration(declaration) ||
		declaration.body === undefined
	)
		return [];
	if (options.scannedFiles?.includes(declaration.getSourceFile().fileName) === true) return [];
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
	if (!followed) {
		const at = call.getSourceFile().getLineAndCharacterOfPosition(call.getStart());
		throw new Error(
			`Unsupported route predicate form: ${call.expression.text}(...) at ${call.getSourceFile().fileName}:${at.line + 1}`,
		);
	}
	return found;
}

function requireLiteral(
	expression: ts.Expression,
	source: ts.SourceFile,
	checker?: ts.TypeChecker,
): string {
	if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
		return expression.text;
	if (ts.isIdentifier(expression) && checker !== undefined) {
		let symbol = checker.getSymbolAtLocation(expression);
		if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
			symbol = checker.getAliasedSymbol(symbol);
		const declaration = symbol?.valueDeclaration;
		if (
			declaration !== undefined &&
			ts.isVariableDeclaration(declaration) &&
			ts.isVariableDeclarationList(declaration.parent) &&
			(declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
			declaration.initializer !== undefined &&
			(ts.isStringLiteral(declaration.initializer) ||
				ts.isNoSubstitutionTemplateLiteral(declaration.initializer))
		)
			return declaration.initializer.text;
	}
	const position = source.getLineAndCharacterOfPosition(expression.getStart(source));
	throw new Error(`Non-literal pathname route at ${source.fileName}:${position.line + 1}`);
}

/** Discover route decisions, failing closed when their route cannot be read as a literal. */
export function discoverHandlerRoutes(
	sourceText: string,
	fileName: string,
): DiscoveredHandlerRoutes {
	const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
	return discoverRoutesInSource(source);
}

export function discoverRoutesInSource(
	source: ts.SourceFile,
	checker?: ts.TypeChecker,
	options: DiscoveryOptions = {},
): DiscoveredHandlerRoutes {
	const fileName = source.fileName;
	const paths = new Set<string>();
	const prefixes = new Set<string>();
	function visit(node: ts.Node): void {
		if (ts.isSwitchStatement(node) && isPathname(node.expression)) {
			for (const clause of node.caseBlock.clauses)
				if (ts.isCaseClause(clause)) paths.add(requireLiteral(clause.expression, source, checker));
		}
		if (
			ts.isBinaryExpression(node) &&
			[node.operatorToken.kind].some((kind) =>
				[
					ts.SyntaxKind.EqualsEqualsEqualsToken,
					ts.SyntaxKind.ExclamationEqualsEqualsToken,
					ts.SyntaxKind.EqualsEqualsToken,
					ts.SyntaxKind.ExclamationEqualsToken,
				].includes(kind),
			)
		) {
			if (isPathname(node.left)) paths.add(requireLiteral(node.right, source, checker));
			if (isPathname(node.right)) paths.add(requireLiteral(node.left, source, checker));
		}
		if (ts.isCallExpression(node) && checker !== undefined)
			for (const path of pathsBehindPredicate(node, checker, options)) paths.add(path);
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const { expression, name } = node.expression;
			if (name.text === 'startsWith' && isPathname(expression)) {
				const argument = node.arguments[0];
				if (argument === undefined) throw new Error(`Missing pathname prefix in ${fileName}`);
				prefixes.add(requireLiteral(argument, source, checker));
			}
			if (name.text === 'includes' && node.arguments.some(isPathname)) {
				if (!ts.isArrayLiteralExpression(expression))
					throw new Error(`Non-literal pathname route table in ${fileName}`);
				for (const element of expression.elements) {
					if (!ts.isExpression(element)) throw new Error(`Invalid pathname route in ${fileName}`);
					paths.add(requireLiteral(element, source, checker));
				}
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	return { paths: [...paths].toSorted(), prefixes: [...prefixes].toSorted() };
}

/** The HTTP methods a handler could name (HEAD and OPTIONS are protocol aliases); a new method on a known path is probed too. */
export const probedHttpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export interface OuterRouteIdentity {
	readonly method: string;
	readonly path: string;
}

/**
 * The method and path pairs the outer handler actually admits: the real route predicate asked of
 * every discovered path under every method, so a new method on an existing path appears too.
 */
export function reachableOuterRoutes(
	paths: readonly string[],
	isPublicRoute: (pathname: string, method: string) => boolean,
): readonly OuterRouteIdentity[] {
	return [...new Set(paths)]
		.toSorted()
		.flatMap((path) =>
			probedHttpMethods
				.filter((method) => isPublicRoute(path, method))
				.map((method) => ({ method, path })),
		);
}

export function unclassifiedOuterRoutes(
	reachable: readonly OuterRouteIdentity[],
	classified: readonly OuterRouteIdentity[],
): readonly OuterRouteIdentity[] {
	const known = new Set(classified.map((row) => `${row.method} ${row.path}`));
	return reachable.filter((row) => !known.has(`${row.method} ${row.path}`));
}
