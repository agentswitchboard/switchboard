import { isPublicSignInRoute } from '@agent-collaboration/sign-in-core';
import ts from 'typescript';

import {
	discoverRoutesInSource,
	probedHttpMethods,
	reachableOuterRoutes,
	type DiscoveredHandlerRoutes,
	type OuterRouteIdentity,
} from '#sign-in-test-support/fuzz/handler-route-discovery';

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
	return outerHandlerFiles.map((file) => {
		const source = program.getSourceFile(file);
		if (source === undefined) throw new Error(`Handler source not found: ${file}`);
		return discoverRoutesInSource(source, program.getTypeChecker());
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
 * The pairs the outer handler serves. Where the real predicate admits a path under only some
 * methods, those pairs are exact. Where it admits a path under every method (the handler decides
 * downstream), each method is asked of the live host and compared with the answer to a method that
 * is not served on that path: a pair that answers differently is served (a page, a redirect, an
 * auth or input refusal), a pair that answers alike is not a route. PUT is the reference, DELETE
 * the reference for PUT itself; if both were served alike the pair would be missed, so the unit
 * proof pins what a served method looks like.
 */
export async function servedOuterRoutes(props: {
	readonly classifiedPaths: readonly string[];
	/** The answer (status and body) of the live host to a method and path. */
	readonly answer: (route: OuterRouteIdentity) => Promise<string>;
}): Promise<readonly OuterRouteIdentity[]> {
	const admitted = actualOuterRoutes(props.classifiedPaths);
	const served: OuterRouteIdentity[] = [];
	for (const path of new Set(admitted.map((route) => route.path))) {
		const pairs = admitted.filter((route) => route.path === path);
		if (pairs.length < probedHttpMethods.length) {
			served.push(...pairs);
			continue;
		}
		const reference = await props.answer({ method: 'PUT', path });
		const secondReference = await props.answer({ method: 'DELETE', path });
		for (const route of pairs) {
			const against = route.method === 'PUT' ? secondReference : reference;
			if ((await props.answer(route)) !== against) served.push(route);
		}
	}
	return served;
}
