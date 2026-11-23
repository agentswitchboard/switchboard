import ts from 'typescript';

import {
	isPathname,
	methodPathPairsOfDeclaration,
	resolveDeclaration,
	tablePathsOfDeclaration,
	unsupportedRouteForm,
} from '#sign-in-test-support/fuzz/route-ast';
import { assertPredicateIsEvaluable } from '#sign-in-test-support/fuzz/static-route-admission';

export interface DiscoveredHandlerRoutes {
	/** Route suffixes a literal regular expression names (`/\/callback\/(google|github)$/`). */
	readonly suffixes?: readonly string[];
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
		suffixes: (discovered.suffixes ?? []).filter(
			(suffix) => !classifiedPaths.some((path) => path.endsWith(suffix)),
		),
		prefixes: discovered.prefixes.filter(
			(prefix) => !classifiedPaths.some((path) => path.startsWith(prefix)),
		),
	};
}

export interface DiscoveryOptions {
	/**
	 * The files being scanned (as the program names them). A predicate declared in one of them is
	 * understood because its own comparisons are scanned; one declared elsewhere must have a form this
	 * scanner can follow (a route table's `.some`, or `Object.hasOwn(table, pathname)`) or the scan fails.
	 */
	readonly scannedFiles?: readonly string[];
}

/** A predicate declared in a scanned file is read where it is declared, but only if it is a form this scanner can evaluate. */
function returnsBoolean(declaration: ts.FunctionDeclaration, checker: ts.TypeChecker): boolean {
	const signature = checker.getSignatureFromDeclaration(declaration);
	if (signature === undefined) return false;
	if (checker.getTypePredicateOfSignature(signature) !== undefined) return true;
	return (checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.BooleanLike) !== 0;
}

const pathnameMethodNames = new Set(['startsWith', 'includes']);

/**
 * The suffixes a literal regular expression such as `/\/callback\/(google|github)$/u` names, when it is
 * escaped-slash segments, one group of literal alternatives and an end anchor; any other pattern is
 * an unsupported route form.
 */
function suffixesOfRegularExpression(pattern: ts.RegularExpressionLiteral): readonly string[] {
	const source = pattern.text.slice(1, pattern.text.lastIndexOf('/'));
	const match = /^((?:\\\/[A-Za-z0-9_-]+)+)\\\/\(([A-Za-z0-9_|-]+)\)\$/u.exec(source);
	if (match === null)
		return unsupportedRouteForm(pattern, `a regular expression route pattern (${pattern.text})`);
	const prefix = (match[1] ?? '').replaceAll('\\/', '/');
	return (match[2] ?? '').split('|').map((alternative) => `${prefix}/${alternative}`);
}

function regularExpressionReceiver(
	call: ts.CallExpression,
): ts.RegularExpressionLiteral | undefined {
	return ts.isPropertyAccessExpression(call.expression) &&
		['exec', 'test'].includes(call.expression.name.text) &&
		ts.isRegularExpressionLiteral(call.expression.expression)
		? call.expression.expression
		: undefined;
}

/**
 * A call that passes the pathname on. `pathname.startsWith(x)` and `[..].includes(pathname)` are read
 * by the scanner itself. A call to an identifier follows its declaration: a table predicate
 * (`table.some(...)`, `Object.hasOwn(table, pathname)`) yields its routes; a boolean predicate in a
 * scanned file must be one the static evaluator can run; a handler in a scanned file is scanned
 * where it is declared. Every other call shape (unresolved, not a function declaration, a member
 * call, an unreadable predicate) fails the scan: nothing is silently skipped.
 */
function pathsBehindPredicate(
	call: ts.CallExpression,
	checker: ts.TypeChecker,
	options: DiscoveryOptions,
): readonly string[] {
	if (!call.arguments.some(isPathname) && !isPathnameReceiverCall(call)) return [];
	if (ts.isPropertyAccessExpression(call.expression)) {
		if (pathnameMethodNames.has(call.expression.name.text)) return [];
		if (regularExpressionReceiver(call) !== undefined) return [];
		return unsupportedRouteForm(
			call,
			`a member call that receives the pathname (${call.expression.getText()})`,
		);
	}
	if (!ts.isIdentifier(call.expression))
		return unsupportedRouteForm(
			call,
			'a call that is not an identifier call receives the pathname',
		);
	const declaration = resolveDeclaration(call.expression, checker);
	if (declaration === undefined)
		return unsupportedRouteForm(call, `an unresolved helper (${call.expression.text})`);
	if (!ts.isFunctionDeclaration(declaration) || declaration.body === undefined)
		return unsupportedRouteForm(
			call,
			`a helper that is not a function declaration (${call.expression.text})`,
		);
	if (options.scannedFiles?.includes(declaration.getSourceFile().fileName) === true) {
		if (returnsBoolean(declaration, checker)) assertPredicateIsEvaluable(declaration, checker);
		return [];
	}
	const table =
		tablePathsOfDeclaration(declaration, checker) ??
		methodPathPairsOfDeclaration(declaration, checker)?.map((pair) => pair.path);
	return (
		table ??
		unsupportedRouteForm(call, `a predicate with an unreadable body (${call.expression.text})`)
	);
}

function isPathnameReceiverCall(call: ts.CallExpression): boolean {
	return ts.isPropertyAccessExpression(call.expression) && isPathname(call.expression.expression);
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
	const suffixes = new Set<string>();
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
		if (ts.isCallExpression(node)) {
			const pattern = regularExpressionReceiver(node);
			if (pattern !== undefined && node.arguments.some(isPathname))
				for (const suffix of suffixesOfRegularExpression(pattern)) suffixes.add(suffix);
		}
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
	return {
		paths: [...paths].toSorted(),
		prefixes: [...prefixes].toSorted(),
		suffixes: [...suffixes].toSorted(),
	};
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
