import ts from 'typescript';

import {
	methodPathPairsOfDeclaration,
	resolveDeclaration,
	tablePathsOfDeclaration,
	unsupportedRouteForm,
	unwrapExpression,
} from '#sign-in-test-support/fuzz/route-ast';

type Value = string | boolean;

interface Environment {
	readonly pathname: string;
	readonly method: string;
	readonly machineLoginEnabled?: boolean;
}

/** Walk every node of a predicate body and refuse any form the evaluator below cannot run. */
export function assertPredicateIsEvaluable(
	declaration: ts.FunctionDeclaration,
	checker: ts.TypeChecker,
): void {
	if (declaration.body === undefined)
		return unsupportedRouteForm(declaration, 'a predicate without a body');
	const parameters = declaration.parameters.map((parameter) => parameter.name.getText());
	function expression(node: ts.Expression): void {
		const current = unwrapExpression(node);
		if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) return;
		if (current.kind === ts.SyntaxKind.TrueKeyword || current.kind === ts.SyntaxKind.FalseKeyword)
			return;
		if (ts.isIdentifier(current)) {
			if (parameters.includes(current.text)) return;
			const declared = resolveDeclaration(current, checker);
			if (
				declared !== undefined &&
				ts.isVariableDeclaration(declared) &&
				declared.initializer !== undefined &&
				ts.isStringLiteral(unwrapExpression(declared.initializer))
			)
				return;
			return unsupportedRouteForm(
				current,
				`an identifier the evaluator cannot read (${current.text})`,
			);
		}
		if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.ExclamationToken)
			return expression(current.operand);
		if (ts.isBinaryExpression(current)) {
			const kind = current.operatorToken.kind;
			if (
				[
					ts.SyntaxKind.AmpersandAmpersandToken,
					ts.SyntaxKind.BarBarToken,
					ts.SyntaxKind.EqualsEqualsEqualsToken,
					ts.SyntaxKind.ExclamationEqualsEqualsToken,
				].includes(kind)
			) {
				expression(current.left);
				return expression(current.right);
			}
			return unsupportedRouteForm(
				current,
				`an operator the evaluator cannot run (${current.operatorToken.getText()})`,
			);
		}
		if (ts.isCallExpression(current)) {
			const callee = current.expression;
			if (
				ts.isPropertyAccessExpression(callee) &&
				callee.name.text === 'startsWith' &&
				current.arguments.length === 1
			) {
				expression(callee.expression);
				return current.arguments.forEach((argument) => expression(argument));
			}
			if (
				ts.isPropertyAccessExpression(callee) &&
				callee.name.text === 'includes' &&
				ts.isArrayLiteralExpression(unwrapExpression(callee.expression)) &&
				current.arguments.length === 1
			) {
				const list = unwrapExpression(callee.expression);
				if (ts.isArrayLiteralExpression(list))
					list.elements.forEach((element) => expression(element));
				return current.arguments.forEach((argument) => expression(argument));
			}
			if (ts.isIdentifier(callee)) {
				const target = resolveDeclaration(callee, checker);
				if (target !== undefined && ts.isFunctionDeclaration(target)) {
					if (
						current.arguments.length === 1 &&
						tablePathsOfDeclaration(target, checker) !== undefined
					)
						return;
					if (
						current.arguments.length === 2 &&
						methodPathPairsOfDeclaration(target, checker) !== undefined
					)
						return current.arguments.forEach(expression);
				}
			}
			return unsupportedRouteForm(
				current,
				`a call the evaluator cannot run (${current.getText()})`,
			);
		}
		return unsupportedRouteForm(
			current,
			`an expression the evaluator cannot run (${current.getText()})`,
		);
	}
	function statement(node: ts.Statement): void {
		if (ts.isBlock(node)) return node.statements.forEach(statement);
		if (ts.isReturnStatement(node)) {
			if (node.expression === undefined)
				return unsupportedRouteForm(node, 'a bare return in a predicate');
			return expression(node.expression);
		}
		if (ts.isIfStatement(node)) {
			expression(node.expression);
			statement(node.thenStatement);
			if (node.elseStatement !== undefined) statement(node.elseStatement);
			return;
		}
		return unsupportedRouteForm(
			node,
			`a statement the evaluator cannot run (${node.getText().slice(0, 40)})`,
		);
	}
	declaration.body.statements.forEach(statement);
}

/**
 * Run a predicate declaration (`(pathname, method) => boolean`) over the syntax tree: the static
 * route admission. It reads the same source the host runs; a unit test pins it equal to the runtime
 * predicate for every method and path, so the method comparisons are discovered statically too.
 */
export function evaluatePredicateStatically(
	declaration: ts.FunctionDeclaration,
	checker: ts.TypeChecker,
	environment: Environment,
): boolean {
	assertPredicateIsEvaluable(declaration, checker);
	const names = declaration.parameters.map((parameter) => parameter.name.getText());
	const bindings = new Map<string, Value>([
		[names[0] ?? 'pathname', environment.pathname],
		[names[1] ?? 'method', environment.method],
	]);
	const configurationFlag = names[2];
	if (configurationFlag === 'machineLoginEnabled')
		bindings.set(configurationFlag, environment.machineLoginEnabled ?? false);
	function evaluate(node: ts.Expression): Value {
		const current = unwrapExpression(node);
		if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current))
			return current.text;
		if (current.kind === ts.SyntaxKind.TrueKeyword) return true;
		if (current.kind === ts.SyntaxKind.FalseKeyword) return false;
		if (ts.isIdentifier(current)) {
			const bound = bindings.get(current.text);
			if (bound !== undefined) return bound;
			const declared = resolveDeclaration(current, checker);
			if (
				declared !== undefined &&
				ts.isVariableDeclaration(declared) &&
				declared.initializer !== undefined
			) {
				const initializer = unwrapExpression(declared.initializer);
				if (ts.isStringLiteral(initializer)) return initializer.text;
			}
		}
		if (ts.isPrefixUnaryExpression(current)) return !evaluate(current.operand);
		if (ts.isBinaryExpression(current)) {
			const kind = current.operatorToken.kind;
			if (kind === ts.SyntaxKind.AmpersandAmpersandToken)
				return Boolean(evaluate(current.left)) && Boolean(evaluate(current.right));
			if (kind === ts.SyntaxKind.BarBarToken)
				return Boolean(evaluate(current.left)) || Boolean(evaluate(current.right));
			const equal = evaluate(current.left) === evaluate(current.right);
			return kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? equal : !equal;
		}
		if (ts.isCallExpression(current)) {
			const callee = current.expression;
			if (ts.isPropertyAccessExpression(callee)) {
				const argument = current.arguments[0];
				if (argument === undefined)
					return unsupportedRouteForm(current, 'a call without an argument');
				if (callee.name.text === 'startsWith')
					return String(evaluate(callee.expression)).startsWith(String(evaluate(argument)));
				const list = unwrapExpression(callee.expression);
				if (ts.isArrayLiteralExpression(list))
					return list.elements.map((element) => evaluate(element)).includes(evaluate(argument));
			}
			if (ts.isIdentifier(callee)) {
				const target = resolveDeclaration(callee, checker);
				const argument = current.arguments[0];
				if (target !== undefined && ts.isFunctionDeclaration(target) && argument !== undefined) {
					const methodArgument = current.arguments[1];
					if (methodArgument !== undefined) {
						const pairs = methodPathPairsOfDeclaration(target, checker);
						const path = evaluate(argument);
						const method = evaluate(methodArgument);
						if (pairs !== undefined)
							return pairs.some((pair) => pair.path === path && pair.method === method);
					} else {
						const table = tablePathsOfDeclaration(target, checker);
						if (table !== undefined) return table.includes(String(evaluate(argument)));
					}
				}
			}
		}
		return unsupportedRouteForm(
			current,
			`an expression the evaluator cannot run (${current.getText()})`,
		);
	}
	function run(statements: readonly ts.Statement[]): boolean | undefined {
		for (const node of statements) {
			if (ts.isReturnStatement(node) && node.expression !== undefined)
				return Boolean(evaluate(node.expression));
			if (ts.isIfStatement(node)) {
				const branch = evaluate(node.expression) ? node.thenStatement : node.elseStatement;
				if (branch !== undefined) {
					const result = run(ts.isBlock(branch) ? branch.statements : [branch]);
					if (result !== undefined) return result;
				}
				continue;
			}
			if (ts.isBlock(node)) {
				const result = run(node.statements);
				if (result !== undefined) return result;
			}
		}
		return undefined;
	}
	return run(declaration.body?.statements ?? []) ?? false;
}
