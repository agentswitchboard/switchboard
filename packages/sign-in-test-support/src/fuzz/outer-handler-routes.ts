import { isPublicSignInRoute } from '@agent-collaboration/sign-in-core';
import ts from 'typescript';

import {
	discoverRoutesInSource,
	probedHttpMethods,
	reachableOuterRoutes,
	type DiscoveredHandlerRoutes,
	type OuterRouteIdentity,
} from '#sign-in-test-support/fuzz/handler-route-discovery';
import { staticMethodsForPath } from '#sign-in-test-support/fuzz/static-route-dispatch';

const outerHandlerFiles = [
	'packages/sign-in-core/src/response-release/sign-in-request-handler.ts',
	'packages/sign-in-core/src/better-auth/sign-in-http-handler.ts',
] as const;

/** Discover the literal paths and prefixes of both outer handlers, through the compiler (run from the workspace root). */
export function discoverOuterHandlerRoutes(): readonly DiscoveredHandlerRoutes[] {
	const config = ts.readConfigFile('packages/sign-in-core/tsconfig.json', (path) =>
		ts.sys.readFile(path),
	);
	if (config.error !== undefined)
		throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, 'packages/sign-in-core');
	const program = ts.createProgram(parsed.fileNames, parsed.options);
	const scannedFileNames = outerHandlerFiles.map((file) => {
		const source = program.getSourceFile(file);
		if (source === undefined) throw new Error(`Handler source not found: ${file}`);
		return source.fileName;
	});
	return outerHandlerFiles.map((file) => {
		const source = program.getSourceFile(file);
		if (source === undefined) throw new Error(`Handler source not found: ${file}`);
		return discoverRoutesInSource(source, program.getTypeChecker(), {
			scannedFiles: scannedFileNames,
		});
	});
}

/** The method and path pairs the real outer route predicate admits among the discovered paths and the classified ones. */
export function actualOuterRoutes(
	classifiedPaths: readonly string[],
): readonly OuterRouteIdentity[] {
	return reachableOuterRoutes(
		[...discoverOuterHandlerRoutes().flatMap((routes) => routes.paths), ...classifiedPaths],
		isPublicSignInRoute,
	);
}

/**
 * The request a method is probed with: a well-formed one of its kind (a body-carrying method gets a
 * JSON body, a content type and the issuer's origin), so a route that refuses a plain request the
 * same way for every method (the relay answers 403 to a non-POST and to a POST without an origin)
 * still answers differently once a real POST of that kind arrives.
 */
export function outerProbeInit(method: string, issuerOrigin: string): RequestInit {
	return ['POST', 'PUT', 'PATCH'].includes(method)
		? {
				method,
				headers: { 'content-type': 'application/json', origin: issuerOrigin },
				body: '{}',
			}
		: { method };
}

/**
 * The pairs the outer handler serves. Where the real predicate admits a path under only some
 * methods, those pairs are exact. Where it admits a path under every method (the handler decides
 * downstream), each method is asked of the live host with a well-formed request of its kind and
 * compared with the answer to a method that is not served on that path: a pair that answers
 * differently is served, a pair that answers alike is not a route. PUT is the reference, PATCH the
 * reference for PUT itself.
 */
export async function servedOuterRoutes(props: {
	readonly classifiedPaths: readonly string[];
	/** The answer (status and body) of the live host to a method and path, asked with this request. */
	readonly answer: (route: OuterRouteIdentity, init: RequestInit) => Promise<string>;
	readonly issuerOrigin: string;
	/** The route predicate asked; the real one unless a unit test injects another. */
	readonly isPublicRoute?: (pathname: string, method: string) => boolean;
}): Promise<readonly OuterRouteIdentity[]> {
	const admitted = reachableOuterRoutes(
		[...discoverOuterHandlerRoutes().flatMap((routes) => routes.paths), ...props.classifiedPaths],
		props.isPublicRoute ?? isPublicSignInRoute,
	);
	const ask = (route: OuterRouteIdentity): Promise<string> =>
		props.answer(route, outerProbeInit(route.method, props.issuerOrigin));
	const served: OuterRouteIdentity[] = [];
	for (const path of new Set(admitted.map((route) => route.path))) {
		const pairs = admitted.filter((route) => route.path === path);
		if (pairs.length < probedHttpMethods.length) {
			served.push(...pairs);
			continue;
		}
		const reference = await ask({ method: 'PUT', path });
		const secondReference = await ask({ method: 'PATCH', path });
		for (const route of pairs) {
			const against = route.method === 'PUT' ? secondReference : reference;
			if ((await ask(route)) !== against) served.push(route);
		}
	}
	return served;
}

/**
 * For every path the predicate admits under every method, the methods the live host serves must be
 * exactly the methods the classification names (a classified method that is not served is stale, a
 * served method that is not classified is missing), except a documented admitted-but-unserved row.
 */
export function ambiguousMethodMismatches(props: {
	readonly served: readonly OuterRouteIdentity[];
	readonly classification: readonly {
		readonly method: string;
		readonly path: string;
		readonly documentedAnswers: readonly number[];
	}[];
	readonly admitted: readonly OuterRouteIdentity[];
}): readonly string[] {
	const ambiguousPaths = new Set(
		[...new Set(props.admitted.map((route) => route.path))].filter(
			(path) =>
				props.admitted.filter((route) => route.path === path).length === probedHttpMethods.length,
		),
	);
	const mismatches: string[] = [];
	for (const path of ambiguousPaths) {
		const servedMethods = new Set(
			props.served.filter((route) => route.path === path).map((route) => route.method),
		);
		const classifiedMethods = new Set(
			props.classification
				.filter(
					(row) =>
						row.path === path &&
						!row.documentedAnswers.every((status) => status === 404 || status === 429),
				)
				.map((row) => row.method),
		);
		for (const method of servedMethods)
			if (!classifiedMethods.has(method))
				mismatches.push(`${method} ${path}: served, not classified`);
		for (const method of classifiedMethods)
			if (!servedMethods.has(method)) mismatches.push(`${method} ${path}: classified, not served`);
	}
	return mismatches;
}

/** The request responder of the outer handler: the function that asks the public route predicate. */
export function discoverOuterResponder(): {
	readonly responder: ts.FunctionLikeDeclaration;
	readonly checker: ts.TypeChecker;
} {
	const config = ts.readConfigFile('packages/sign-in-core/tsconfig.json', (path) =>
		ts.sys.readFile(path),
	);
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, 'packages/sign-in-core');
	const program = ts.createProgram(parsed.fileNames, parsed.options);
	// The checker binds the files, which sets the parent links the climb below needs.
	const checker = program.getTypeChecker();
	const source = program.getSourceFile(outerHandlerFiles[1]);
	if (source === undefined) throw new Error(`Handler source not found: ${outerHandlerFiles[1]}`);
	let responder: ts.FunctionLikeDeclaration | undefined;
	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'isPublicSignInRoute'
		) {
			let owner: ts.Node | undefined = node.parent;
			while (owner !== undefined && !ts.isFunctionLike(owner)) owner = owner.parent;
			if (owner !== undefined && ts.isFunctionLike(owner))
				responder = owner as ts.FunctionLikeDeclaration;
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	if (responder === undefined) throw new Error('Unsupported route predicate form: no responder');
	return { responder, checker };
}

/** A provider path template (`/a/:id`) against a concrete path, segment by segment. */
function providerPathMatches(template: string, path: string): boolean {
	const templateSegments = template.split('/');
	const pathSegments = path.split('/');
	return (
		templateSegments.length === pathSegments.length &&
		templateSegments.every(
			(segment, index) => segment.startsWith(':') || segment === pathSegments[index],
		)
	);
}

/**
 * The method and path pairs the handlers' own code serves, the coverage authority. A path the
 * predicate admits under some methods is exact. A path admitted under every method is served under
 * the methods the handler dispatch names (comparisons and tables, read from the source); where the
 * handler names none, the provider router decides and its installed endpoint methods apply.
 */
export function staticServedOuterRoutes(props: {
	readonly responder: ts.FunctionLikeDeclaration;
	readonly checker: ts.TypeChecker;
	readonly admitted: readonly OuterRouteIdentity[];
	readonly providerRoutes: readonly OuterRouteIdentity[];
}): readonly OuterRouteIdentity[] {
	const served: OuterRouteIdentity[] = [];
	for (const path of new Set(props.admitted.map((route) => route.path))) {
		const pairs = props.admitted.filter((route) => route.path === path);
		if (pairs.length < probedHttpMethods.length) {
			served.push(...pairs);
			continue;
		}
		const handlerMethods = staticMethodsForPath({
			responder: props.responder,
			checker: props.checker,
			path,
		}).methods;
		const methods =
			handlerMethods.size > 0
				? handlerMethods
				: new Set(
						props.providerRoutes
							.filter(
								(route) =>
									providerPathMatches(route.path, path) ||
									providerPathMatches(route.path.replace(/^\/api\/auth/u, ''), path),
							)
							.map((route) => route.method),
					);
		for (const method of probedHttpMethods) if (methods.has(method)) served.push({ method, path });
	}
	return served;
}

/**
 * Routes the provider serves from its request hook, not from an endpoint, so the installed endpoint
 * inventory cannot list them. The OAuth provider plugin answers the authorization-server metadata
 * at the issuer root for GET and HEAD and refuses every other method with 405 (`@better-auth/oauth-provider`
 * 1.7.11, `dist/authorize-CtCi8mAs.mjs` `handleIssuerMetadataRequest`, `authServerMetadataPaths`). HEAD is
 * a protocol alias of GET and is not a classified method; the discovered pair is GET.
 */
export const providerRequestHookRoutes: readonly OuterRouteIdentity[] = [
	{ method: 'GET', path: '/.well-known/oauth-authorization-server' },
];
