import ts from 'typescript';

import {
	isPathname,
	resolveDeclaration,
	tablePathsOfDeclaration,
	unsupportedRouteForm,
	unwrapExpression,
} from '#sign-in-test-support/fuzz/route-ast';

/** The methods a handler's own code serves for a path, with the source line of each comparison. */
export interface StaticMethodEvidence {
	readonly methods: ReadonlySet<string>;
	readonly anchors: readonly string[];
}

interface Guard {
	/** Whether the guard holds for the path: undefined when it does not look at the path. */
	readonly path: boolean | undefined;
	/** The methods the guard compares the request with. */
	readonly methods: readonly string[];
}

interface Frame {
	readonly path: string;
	readonly depth: number;
	readonly visited: Set<ts.Node>;
	readonly methods: Set<string>;
	readonly anchors: string[];
	/** Inside a branch whose path guard holds for this path: only there are calls followed. */
	readonly inBranch: boolean;
	/** Set once any branch whose path guard holds for this path was entered. */
	readonly branch: { found: boolean };
}

const httpMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const maximumDepth = 5;

function anchor(node: ts.Node): string {
	const at = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
	return `${node.getSourceFile().fileName.replace(/^.*\/packages\//u, 'packages/')}:${at.line + 1}`;
}

/** `request.method`, `props.request.method`, a bare `method`: the request's method. */
function isMethodReference(expression: ts.Expression): boolean {
	const current = unwrapExpression(expression);
	return (
		(ts.isIdentifier(current) && current.text === 'method') ||
		(ts.isPropertyAccessExpression(current) && current.name.text === 'method')
	);
}

function literalText(expression: ts.Expression, checker: ts.TypeChecker): string | undefined {
	const current = unwrapExpression(expression);
	if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current))
		return current.text;
	if (ts.isIdentifier(current)) {
		const declared = resolveDeclaration(current, checker);
		if (
			declared !== undefined &&
			ts.isVariableDeclaration(declared) &&
			declared.initializer !== undefined
		) {
			const initializer = unwrapExpression(declared.initializer);
			if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer))
				return initializer.text;
		}
	}
	return undefined;
}

/** Read a guard as what it says about the path and the method; anything else is opaque. */
function analyze(expression: ts.Expression, path: string, checker: ts.TypeChecker): Guard {
	const current = unwrapExpression(expression);
	const opaque: Guard = { path: undefined, methods: [] };
	if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.ExclamationToken) {
		const inner = analyze(current.operand, path, checker);
		return { path: inner.path === undefined ? undefined : !inner.path, methods: inner.methods };
	}
	if (ts.isBinaryExpression(current)) {
		const kind = current.operatorToken.kind;
		if (kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken) {
			const left = analyze(current.left, path, checker);
			const right = analyze(current.right, path, checker);
			const combine = (a: boolean | undefined, b: boolean | undefined): boolean | undefined =>
				a === undefined
					? b
					: b === undefined
						? a
						: kind === ts.SyntaxKind.AmpersandAmpersandToken
							? a && b
							: a || b;
			return { path: combine(left.path, right.path), methods: [...left.methods, ...right.methods] };
		}
		const equality = kind === ts.SyntaxKind.EqualsEqualsEqualsToken;
		if (equality || kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
			const sides: [ts.Expression, ts.Expression][] = [
				[current.left, current.right],
				[current.right, current.left],
			];
			for (const [subject, other] of sides) {
				if (isPathname(subject)) {
					const literal = literalText(other, checker);
					if (literal !== undefined) return { path: (literal === path) === equality, methods: [] };
				}
				if (isMethodReference(subject)) {
					const literal = literalText(other, checker);
					if (literal !== undefined && httpMethods.has(literal))
						return { path: undefined, methods: [literal] };
				}
			}
		}
		return opaque;
	}
	if (ts.isCallExpression(current)) {
		const callee = current.expression;
		if (ts.isPropertyAccessExpression(callee)) {
			if (callee.name.text === 'startsWith' && isPathname(callee.expression)) {
				const prefix =
					current.arguments[0] === undefined
						? undefined
						: literalText(current.arguments[0], checker);
				if (prefix !== undefined) return { path: path.startsWith(prefix), methods: [] };
			}
			const list = unwrapExpression(callee.expression);
			if (
				callee.name.text === 'includes' &&
				ts.isArrayLiteralExpression(list) &&
				current.arguments.some(isPathname)
			) {
				const texts = list.elements.map((element) => literalText(element, checker));
				if (texts.every((text) => text !== undefined))
					return { path: texts.includes(path), methods: [] };
			}
		}
		if (ts.isIdentifier(callee)) {
			const target = resolveDeclaration(callee, checker);
			if (target !== undefined && ts.isFunctionDeclaration(target)) {
				const table = tablePathsOfDeclaration(target, checker);
				if (table !== undefined && current.arguments.some(isPathname))
					return { path: table.includes(path), methods: [] };
				// A predicate that takes the pathname and the method is the route admission itself (isPublicSignInRoute):
				// the static admission evaluates it, so it is no dispatch evidence here.
				if (current.arguments.some(isPathname) && current.arguments.some(isMethodReference))
					return opaque;
				// A helper that compares its method parameter (isSameOriginSignInPost(method, ...)).
				const argumentIndex = current.arguments.findIndex(isMethodReference);
				const parameter = argumentIndex < 0 ? undefined : target.parameters[argumentIndex];
				if (parameter !== undefined && target.body !== undefined)
					return {
						path: undefined,
						methods: methodsComparedTo(parameter.name.getText(), target.body, checker),
					};
			}
		}
	}
	return opaque;
}

/** The literal methods a function body compares one of its names with. */
function methodsComparedTo(
	name: string,
	body: ts.Node,
	checker: ts.TypeChecker,
): readonly string[] {
	const found: string[] = [];
	function visit(node: ts.Node): void {
		if (
			ts.isBinaryExpression(node) &&
			[ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
				node.operatorToken.kind,
			)
		) {
			for (const [subject, other] of [
				[node.left, node.right],
				[node.right, node.left],
			] as const) {
				const literal =
					ts.isIdentifier(unwrapExpression(subject)) && unwrapExpression(subject).getText() === name
						? literalText(other, checker)
						: undefined;
				if (literal !== undefined && httpMethods.has(literal)) found.push(literal);
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(body);
	return found;
}

function alwaysEnds(statement: ts.Statement): boolean {
	if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
	if (ts.isBlock(statement)) return statement.statements.some(alwaysEnds);
	if (ts.isIfStatement(statement))
		return (
			statement.elseStatement !== undefined &&
			alwaysEnds(statement.thenStatement) &&
			alwaysEnds(statement.elseStatement)
		);
	return false;
}

/** Follow a call to a function declared in the project: its statements are walked for this path. */
function followCalls(node: ts.Node, frame: Frame, checker: ts.TypeChecker): void {
	if (!frame.inBranch) return;
	function visit(inner: ts.Node): void {
		if (
			ts.isCallExpression(inner) &&
			ts.isIdentifier(inner.expression) &&
			inner.expression.text === 'createAuthEndpoint'
		) {
			// An endpoint declares its own method: `createAuthEndpoint('/owner/bootstrap', { method: 'POST' })`,
			// counted only for this path (the provider's other endpoints are not this dispatch).
			const [endpointPath, options] = inner.arguments;
			const declared = endpointPath === undefined ? undefined : literalText(endpointPath, checker);
			if (
				declared !== undefined &&
				frame.path.endsWith(declared) &&
				options !== undefined &&
				ts.isObjectLiteralExpression(options)
			)
				for (const property of options.properties)
					if (ts.isPropertyAssignment(property) && property.name.getText() === 'method') {
						const method = literalText(property.initializer, checker);
						if (method !== undefined && httpMethods.has(method)) {
							frame.methods.add(method);
							frame.anchors.push(`${method} ${anchor(property)}`);
						}
					}
		}
		if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression)) {
			const target = resolveDeclaration(inner.expression, checker);
			if (
				target !== undefined &&
				ts.isFunctionDeclaration(target) &&
				target.body !== undefined &&
				!target.getSourceFile().fileName.includes('node_modules') &&
				!target.getSourceFile().isDeclarationFile
			)
				walkFunction(target, inner, frame, checker);
		}
		if (ts.isFunctionLike(inner) && inner !== node) {
			// A callback (`run(async () => { ... })`) of the responder itself is walked as the statements it
			// is; a closure inside a followed function (a plugin endpoint it builds) is not dispatch.
			if (frame.depth > 0) return;
			const body = (inner as ts.FunctionLikeDeclaration).body;
			if (body !== undefined && ts.isBlock(body)) walkStatements(body.statements, frame, checker);
			else if (body !== undefined) followCalls(body, frame, checker);
			return;
		}
		if (ts.isStatement(inner) && inner !== node) {
			// A nested statement is walked with its guards, never followed unconditionally.
			walkStatements([inner], frame, checker);
			return;
		}
		ts.forEachChild(inner, visit);
	}
	visit(node);
}

function walkFunction(
	declaration: ts.FunctionDeclaration,
	call: ts.CallExpression | undefined,
	frame: Frame,
	checker: ts.TypeChecker,
): void {
	if (
		declaration.body === undefined ||
		frame.visited.has(declaration) ||
		frame.depth >= maximumDepth
	)
		return;
	frame.visited.add(declaration);
	walkStatements(declaration.body.statements, { ...frame, depth: frame.depth + 1 }, checker);
	void call;
}

/** Walk statements for one path; true when they always end the request. */
function walkStatements(
	statements: readonly ts.Statement[],
	frame: Frame,
	checker: ts.TypeChecker,
): boolean {
	for (const statement of statements) {
		if (ts.isIfStatement(statement)) {
			const guard = analyze(statement.expression, frame.path, checker);
			if (guard.path === false) {
				if (
					statement.elseStatement !== undefined &&
					walkStatements([statement.elseStatement], frame, checker)
				)
					return true;
				continue;
			}
			if (guard.path === true) {
				for (const method of guard.methods) {
					frame.methods.add(method);
					frame.anchors.push(`${method} ${anchor(statement.expression)}`);
				}
				frame.branch.found = true;
				return (
					walkStatements([statement.thenStatement], { ...frame, inBranch: true }, checker) ||
					alwaysEnds(statement.thenStatement)
				);
			}
			// The guard does not look at the path: a method gate, or something opaque.
			for (const method of guard.methods) {
				frame.methods.add(method);
				frame.anchors.push(`${method} ${anchor(statement.expression)}`);
			}
			followCalls(statement.expression, frame, checker);
			const ended = walkStatements([statement.thenStatement], frame, checker);
			if (statement.elseStatement !== undefined)
				walkStatements([statement.elseStatement], frame, checker);
			if (guard.methods.length > 0 && ended) continue;
			continue;
		}
		if (ts.isBlock(statement)) {
			if (walkStatements(statement.statements, frame, checker)) return true;
			continue;
		}
		if (ts.isTryStatement(statement)) {
			const ended = walkStatements(statement.tryBlock.statements, frame, checker);
			if (statement.catchClause !== undefined)
				walkStatements(statement.catchClause.block.statements, frame, checker);
			if (statement.finallyBlock !== undefined)
				walkStatements(statement.finallyBlock.statements, frame, checker);
			if (ended) return true;
			continue;
		}
		if (ts.isSwitchStatement(statement)) {
			followCalls(statement.expression, frame, checker);
			for (const clause of statement.caseBlock.clauses)
				walkStatements(clause.statements, frame, checker);
			continue;
		}
		if (
			ts.isForStatement(statement) ||
			ts.isForOfStatement(statement) ||
			ts.isForInStatement(statement) ||
			ts.isWhileStatement(statement) ||
			ts.isDoStatement(statement)
		) {
			walkStatements([statement.statement], frame, checker);
			continue;
		}
		followCalls(statement, frame, checker);
		if (alwaysEnds(statement)) return true;
	}
	return false;
}

/**
 * The methods the handlers' own dispatch serves for a path, found by walking the request responder
 * and the project functions it calls, deciding path guards for this path and reading method
 * comparisons (a guard's, or a helper's on its method parameter). Empty means the handler sets no
 * method for the path: the provider router decides.
 */
export function staticMethodsForPath(props: {
	readonly responder: ts.FunctionDeclaration | ts.FunctionLikeDeclaration;
	readonly checker: ts.TypeChecker;
	readonly path: string;
}): StaticMethodEvidence {
	const frame: Frame = {
		path: props.path,
		depth: 0,
		visited: new Set(),
		methods: new Set(),
		anchors: [],
		inBranch: false,
		branch: { found: false },
	};
	const body = props.responder.body;
	if (body === undefined || !ts.isBlock(body))
		return unsupportedRouteForm(props.responder, 'a responder without a block body');
	walkStatements(body.statements, frame, props.checker);
	if (frame.branch.found && frame.methods.size === 0)
		return unsupportedRouteForm(
			props.responder,
			`a handler branch for ${props.path} with no method dispatch found`,
		);
	return { methods: frame.methods, anchors: frame.anchors };
}
