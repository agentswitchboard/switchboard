import ts from 'typescript';
import { expect, it } from 'vitest';

import {
	discoverHandlerRoutes,
	discoverRoutesInSource,
	reachableOuterRoutes,
	unclassifiedHandlerRoutes,
	unclassifiedOuterRoutes,
} from '#sign-in-test-support/fuzz/handler-route-discovery';
import {
	actualOuterRoutes,
	discoverOuterHandlerRoutes,
} from '#sign-in-test-support/fuzz/outer-handler-routes';
import { requestFamilies } from '#sign-in-test-support/fuzz/request-families/index';
import { routeClassification, routeKey } from '#sign-in-test-support/fuzz/route-classification';

it('discovers pathname comparisons, route tables and prefixes', () => {
	const routes = discoverHandlerRoutes(
		`if (pathname === '/one' || '/two' === url.pathname) {}\n` +
			`if (pathname.startsWith('/group/')) {}\n` +
			`if (['/three', '/four'].includes(url.pathname)) {}\n` +
			`switch (url.pathname) { case '/five': break; default: break; }`,
		'handler.ts',
	);
	expect(routes).toEqual({
		paths: ['/five', '/four', '/one', '/three', '/two'],
		prefixes: ['/group/'],
	});
});

it('reports a newly discovered route and prefix missing from the classification', () => {
	const discovered = discoverHandlerRoutes(
		"if (pathname === '/known' || pathname === '/new') {} if (pathname.startsWith('/new-group/')) {}",
		'handler.ts',
	);
	expect(unclassifiedHandlerRoutes(discovered, ['/known'])).toEqual({
		paths: ['/new'],
		prefixes: ['/new-group/'],
	});
});

it('resolves the actual handler imported literal route through the compiler', () => {
	const configPath = 'packages/sign-in-core/tsconfig.json';
	const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
	expect(config.error).toBeUndefined();
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, 'packages/sign-in-core');
	const program = ts.createProgram(parsed.fileNames, parsed.options);
	const source = program.getSourceFile(
		'packages/sign-in-core/src/better-auth/sign-in-http-handler.ts',
	);
	if (source === undefined) throw new Error('Sign-in HTTP handler source not found');
	const routes = discoverRoutesInSource(source, program.getTypeChecker());
	expect(routes.paths).toContain('/organization-admin');
});

it('covers every pathname branch and prefix in the actual outer handlers', () => {
	const config = ts.readConfigFile('packages/sign-in-core/tsconfig.json', (path) =>
		ts.sys.readFile(path),
	);
	if (config.error !== undefined)
		throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, 'packages/sign-in-core');
	const program = ts.createProgram(parsed.fileNames, parsed.options);
	const classifiedPaths = routeClassification.map((row) => row.path);
	for (const file of [
		'packages/sign-in-core/src/response-release/sign-in-request-handler.ts',
		'packages/sign-in-core/src/better-auth/sign-in-http-handler.ts',
	]) {
		const source = program.getSourceFile(file);
		if (source === undefined) throw new Error(`Handler source not found: ${file}`);
		const discovered = discoverRoutesInSource(source, program.getTypeChecker());
		expect(unclassifiedHandlerRoutes(discovered, classifiedPaths)).toEqual({
			paths: [],
			prefixes: [],
		});
	}
});

it.each([
	'pathname === route',
	'url.pathname.startsWith(prefix)',
	'routes.includes(pathname)',
	"['/one', other].includes(pathname)",
])('refuses an unresolved pathname route: %s', (expression) => {
	expect(() => discoverHandlerRoutes(`if (${expression}) {}`, 'handler.ts')).toThrow(
		/Non-literal pathname/,
	);
});

it('accepts immutable literal constants and rejects computed or mutable constants', () => {
	const fileName = '/handler.ts';
	for (const [declaration, accepted] of [
		["const route = '/fixed'", true],
		["let route = '/mutable'", false],
		["const route = '/a' + '/b'", false],
	] satisfies readonly (readonly [string, boolean])[]) {
		const source = ts.createSourceFile(
			fileName,
			`${declaration}; if (pathname === route) {}`,
			ts.ScriptTarget.Latest,
			true,
		);
		const host = ts.createCompilerHost({ noLib: true });
		host.getSourceFile = (name: string): ts.SourceFile | undefined =>
			name === fileName ? source : undefined;
		const checker = ts.createProgram([fileName], { noLib: true }, host).getTypeChecker();
		if (accepted) expect(discoverRoutesInSource(source, checker).paths).toEqual(['/fixed']);
		else expect(() => discoverRoutesInSource(source, checker)).toThrow(/Non-literal pathname/);
	}
});

it('follows a route predicate to its table: the signed-in shell pages are discovered', () => {
	const discovered = discoverOuterHandlerRoutes().flatMap((routes) => routes.paths);
	expect(discovered).toContain('/me');
	expect(discovered).toContain('/people');
});

it('refuses a route predicate whose table cannot be read as literals', () => {
	const files: Record<string, string> = {
		'/predicate.ts':
			"export const table = [{ path: '/a' }, { path: String('/b') }];\nexport function isKnown(pathname: string): boolean { return table.some((route) => route.path === pathname); }",
		'/handler.ts':
			"import { isKnown } from './predicate';\nexport function handle(pathname: string): boolean { return isKnown(pathname); }",
	};
	const host = ts.createCompilerHost({ noLib: true });
	host.getSourceFile = (name: string): ts.SourceFile | undefined =>
		files[name] === undefined
			? undefined
			: ts.createSourceFile(name, files[name], ts.ScriptTarget.Latest, true);
	host.fileExists = (name: string): boolean => files[name] !== undefined;
	host.readFile = (name: string): string | undefined => files[name];
	const program = ts.createProgram(
		['/handler.ts', '/predicate.ts'],
		{ noLib: true, module: ts.ModuleKind.ESNext },
		host,
	);
	const source = program.getSourceFile('/handler.ts');
	if (source === undefined) throw new Error('handler missing');
	expect(() => discoverRoutesInSource(source, program.getTypeChecker())).toThrow(
		/Non-literal path/,
	);
});

it('the signed-in shell pages are classified and have a request family, and the discovered paths are all classified', () => {
	const classifiedKeys = new Set(routeClassification.map(routeKey));
	for (const page of ['/me', '/people']) expect(classifiedKeys).toContain(`GET ${page}`);
	const familyKeys = new Set(requestFamilies.map((family) => routeKey(family.route)));
	for (const page of ['/me', '/people']) expect(familyKeys).toContain(`GET ${page}`);
	// Every pair whose method the outer predicate itself names is classified; a pair it admits
	// under any method is probed against the live handler (route-coverage.host.e2e.test.ts).
	const reachable = actualOuterRoutes(routeClassification.map((row) => row.path));
	expect(reachable).toContainEqual({ method: 'GET', path: '/me' });
	expect(reachable).toContainEqual({ method: 'GET', path: '/people' });
	expect(
		unclassifiedOuterRoutes(reachable, routeClassification).filter(
			(route) => route.method === 'PUT' && route.path.startsWith('/api/auth/'),
		),
	).toEqual([]);
});

it('a new HTTP method on a known path, or a new shell page, is unclassified until classified', () => {
	const classified = [{ method: 'GET', path: '/me' }];
	const today = (pathname: string, method: string): boolean =>
		pathname === '/me' && method === 'GET';
	expect(unclassifiedOuterRoutes(reachableOuterRoutes(['/me'], today), classified)).toEqual([]);
	// A wrong build: the handler starts admitting PUT /me, or a new page /billing.
	const withPut = (pathname: string, method: string): boolean =>
		pathname === '/me' && (method === 'GET' || method === 'PUT');
	expect(unclassifiedOuterRoutes(reachableOuterRoutes(['/me'], withPut), classified)).toEqual([
		{ method: 'PUT', path: '/me' },
	]);
	const withPage = (pathname: string, method: string): boolean =>
		method === 'GET' && (pathname === '/me' || pathname === '/billing');
	expect(
		unclassifiedOuterRoutes(reachableOuterRoutes(['/me', '/billing'], withPage), classified),
	).toEqual([{ method: 'GET', path: '/billing' }]);
});
