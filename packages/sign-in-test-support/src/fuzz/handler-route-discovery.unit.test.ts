import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
	discoverHandlerRoutes,
	discoverRoutesInSource,
	type OuterRouteIdentity,
	probedHttpMethods,
	reachableOuterRoutes,
	unclassifiedHandlerRoutes,
	unclassifiedOuterRoutes,
} from '#sign-in-test-support/fuzz/handler-route-discovery';
import {
	actualOuterRoutes,
	ambiguousMethodMismatches,
	discoverOuterHandlerRoutes,
	discoverOuterResponder,
	liveServedButNotStatic,
	servedOuterRoutes,
	staticServedOuterRoutes,
} from '#sign-in-test-support/fuzz/outer-handler-routes';
import { requestFamilies } from '#sign-in-test-support/fuzz/request-families/index';
import { routeClassification, routeKey } from '#sign-in-test-support/fuzz/route-classification';

function requestHandlerSourceName(program: ts.Program): string {
	const source = program.getSourceFile(
		'packages/sign-in-core/src/response-release/sign-in-request-handler.ts',
	);
	if (source === undefined) throw new Error('Request handler source not found');
	return source.fileName;
}

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
		suffixes: [],
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
		suffixes: [],
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
	const routes = discoverRoutesInSource(source, program.getTypeChecker(), {
		scannedFiles: [source.fileName, requestHandlerSourceName(program)],
	});
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
		const discovered = discoverRoutesInSource(source, program.getTypeChecker(), {
			scannedFiles: [
				'packages/sign-in-core/src/response-release/sign-in-request-handler.ts',
				'packages/sign-in-core/src/better-auth/sign-in-http-handler.ts',
				'packages/sign-in-core/src/response-release/machine-device-response.ts',
			].map((name) => program.getSourceFile(name)?.fileName ?? name),
		});
		expect(unclassifiedHandlerRoutes(discovered, classifiedPaths)).toEqual({
			paths: [],
			prefixes: [],
			suffixes: [],
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
	// Where the predicate names the method itself (a path admitted under only some methods), each
	// pair is exact and must be classified.
	const methodSpecific = reachable.filter(
		(route) =>
			reachable.filter((other) => other.path === route.path).length < probedHttpMethods.length,
	);
	expect(unclassifiedOuterRoutes(methodSpecific, routeClassification)).toEqual([]);
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

describe('B1 closure: effective method dispatch and unsupported predicate forms', (): void => {
	it('fails closed on a route predicate form it cannot read', (): void => {
		const files: Record<string, string> = {
			'/predicate.ts':
				'export function isKnown(pathname: string): boolean { return pathname.length > 3 && pathname !== computed(); }\nfunction computed(): string { return "/a"; }',
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
		expect(() =>
			discoverRoutesInSource(source, program.getTypeChecker(), { scannedFiles: ['/handler.ts'] }),
		).toThrow(/Unsupported route predicate form/);
	});

	it('discovers a method the unauthenticated plain probe cannot tell from a refusal (the relay POSTs)', async (): Promise<void> => {
		// The relay refuses a non-POST and a POST that lacks an origin with the same 403, and only a
		// well-formed POST reaches its DPoP check (401).
		const relayLike = async (
			route: OuterRouteIdentity,
			init: RequestInit | undefined,
		): Promise<string> => {
			const headers = new Headers(init?.headers);
			if (route.method !== 'POST' || !headers.has('origin') || !headers.has('content-type'))
				return '403 {"error":"not-allowed"}';
			return '401 {"error":"dpop-required"}';
		};
		const served = await servedOuterRoutes({
			classifiedPaths: ['/api/auth/organization-admin/v1/create-workspace'],
			answer: relayLike,
			issuerOrigin: 'https://issuer.example.invalid',
			isPublicRoute: (pathname) => pathname === '/api/auth/organization-admin/v1/create-workspace',
		});
		expect(served).toEqual([
			{ method: 'POST', path: '/api/auth/organization-admin/v1/create-workspace' },
		]);
	});
});

describe('B1 closure 2: the static scan fails closed', (): void => {
	/** A two-file program: a handler that calls `callExpression(pathname)` and a helper file. */
	function scan(
		helper: string,
		call: string,
		scanned: readonly string[] = ['/handler.ts'],
	): () => void {
		const files: Record<string, string> = {
			'/helper.ts': helper,
			'/handler.ts': `import { check, table } from './helper';\nexport function handle(pathname: string, method: string): boolean { return ${call}; }`,
		};
		const host = ts.createCompilerHost({ noLib: true });
		host.getSourceFile = (name: string): ts.SourceFile | undefined =>
			files[name] === undefined
				? undefined
				: ts.createSourceFile(name, files[name], ts.ScriptTarget.Latest, true);
		host.fileExists = (name: string): boolean => files[name] !== undefined;
		host.readFile = (name: string): string | undefined => files[name];
		const program = ts.createProgram(
			['/handler.ts', '/helper.ts'],
			{ noLib: true, module: ts.ModuleKind.ESNext },
			host,
		);
		const source = program.getSourceFile('/handler.ts');
		if (source === undefined) throw new Error('handler missing');
		return (): void => {
			discoverRoutesInSource(source, program.getTypeChecker(), { scannedFiles: scanned });
		};
	}

	it('throws for every silent return of the old scan', (): void => {
		const unsupported = /Unsupported route predicate form/;
		// An unresolved helper (not declared anywhere the program can see).
		expect(scan('export const check = 1;', 'missing(pathname)')).toThrow(unsupported);
		// A helper that is not a function declaration (an arrow function const).
		expect(
			scan('export const check = (path: string): boolean => path === "/a";', 'check(pathname)'),
		).toThrow(unsupported);
		// A call that is not an identifier call (a member call on an object).
		expect(
			scan(
				'export const table = { has: (path: string): boolean => path === "/a" };',
				'table.has(pathname)',
			),
		).toThrow(unsupported);
		// An unsupported dispatch shape inside a predicate that lives in a scanned file.
		expect(
			scan(
				'export function check(pathname: string): boolean { return new Set(["/a"]).has(pathname); }',
				'check(pathname)',
				['/handler.ts', '/helper.ts'],
			),
		).toThrow(unsupported);
	});

	it('still reads the supported forms', (): void => {
		expect(
			scan(
				'export function check(pathname: string): boolean { return pathname === "/a" || ["/b"].includes(pathname); }',
				'check(pathname)',
				['/handler.ts', '/helper.ts'],
			),
		).not.toThrow();
	});
});

describe('B1 closure 2: the static method and path inventory is the coverage authority', (): void => {
	const everyMethod = (path: string): OuterRouteIdentity[] =>
		probedHttpMethods.map((method) => ({ method, path }));

	function staticServed(source: string, path: string): readonly OuterRouteIdentity[] {
		const host = ts.createCompilerHost({});
		const original = host.getSourceFile.bind(host);
		host.getSourceFile = (name, languageVersion, ...rest) =>
			name === 'synthetic-handler.ts'
				? ts.createSourceFile(name, source, languageVersion, true)
				: original(name, languageVersion, ...rest);
		const program = ts.createProgram(['synthetic-handler.ts'], {}, host);
		const file = program.getSourceFile('synthetic-handler.ts');
		const responder = file?.statements.find(
			(statement): statement is ts.FunctionDeclaration =>
				ts.isFunctionDeclaration(statement) && statement.name?.text === 'respond',
		);
		if (responder === undefined) throw new Error('no responder');
		return staticServedOuterRoutes({
			responder,
			checker: program.getTypeChecker(),
			admitted: everyMethod(path),
			providerRoutes: [],
		});
	}

	const handler = (extra: string): string =>
		`export function respond(request: Request, url: URL): Response | null {\n` +
		`  if (url.pathname === '/api/a') {\n` +
		`    if (request.method === 'DELETE') { ${extra} }\n` +
		`    if (request.method !== 'POST') return new Response('no', { status: 405 });\n` +
		`    return new Response('ok');\n` +
		`  }\n  return null;\n}\n`;

	it('reads the methods a handler branch compares, whatever the signed-out answer', (): void => {
		expect(staticServed(handler("return new Response('no', { status: 405 });"), '/api/a')).toEqual(
			[
				{ method: 'POST', path: '/api/a' },
				{ method: 'DELETE', path: '/api/a' },
			].toSorted(
				(left, right) =>
					probedHttpMethods.indexOf(left.method as 'POST') -
					probedHttpMethods.indexOf(right.method as 'POST'),
			),
		);
	});

	it('fails a served method that is not classified even when its answer equals the reference method', (): void => {
		// DELETE answers 405 exactly like PUT: a live probe sees no difference, the static dispatch does.
		const served = staticServed(handler("return new Response('no', { status: 405 });"), '/api/a');
		expect(
			ambiguousMethodMismatches({
				served,
				admitted: everyMethod('/api/a'),
				classification: [{ method: 'POST', path: '/api/a', documentedAnswers: [200] }],
			}),
		).toEqual(['DELETE /api/a: served, not classified']);
	});

	it('passes once the method is classified', (): void => {
		const served = staticServed(handler("return new Response('no', { status: 405 });"), '/api/a');
		expect(
			ambiguousMethodMismatches({
				served,
				admitted: everyMethod('/api/a'),
				classification: [
					{ method: 'POST', path: '/api/a', documentedAnswers: [200] },
					{ method: 'DELETE', path: '/api/a', documentedAnswers: [405] },
				],
			}),
		).toEqual([]);
	});

	it('serves the handler-owned real paths exactly as the classification names them', (): void => {
		const { responder, checker } = discoverOuterResponder();
		const classifiedPaths = routeClassification.map((row) => row.path);
		const served = staticServedOuterRoutes({
			responder,
			checker,
			admitted: actualOuterRoutes(classifiedPaths),
			providerRoutes: routeClassification
				.filter(
					(row) =>
						row.providerServerOnly !== undefined &&
						!row.documentedAnswers.every((status) => status === 404 || status === 429),
				)
				.map((row) => ({ method: row.method, path: row.path })),
		});
		expect(
			ambiguousMethodMismatches({
				served,
				classification: routeClassification,
				admitted: actualOuterRoutes(classifiedPaths),
			}),
		).toEqual([]);
	});

	// The shape of the real responder: a GET branch first, then another method on the same path.
	const laterMethodHandler = (later: string): string =>
		`export function respond(request: Request, url: URL): Response | null {\n` +
		`  if (request.method === 'GET' && ['/api/a'].includes(url.pathname)) { return new Response('page'); }\n` +
		later +
		`  return null;\n}\n`;

	it('collects a later branch on the same path with a different method (not only the first guard)', (): void => {
		const served = staticServed(
			laterMethodHandler(
				`  if (request.method === 'DELETE' && url.pathname === '/api/a') { return new Response('no', { status: 405 }); }\n`,
			),
			'/api/a',
		);
		expect(served.map((route) => route.method)).toEqual(['GET', 'DELETE']);
	});

	it('reads a dispatch guard bound to an immutable local', (): void => {
		const served = staticServed(
			`export function respond(request: Request, url: URL): Response | null {
				const readyPage = request.method === 'GET' && ['/api/a'].includes(url.pathname);
				if (readyPage) return new Response('page');
				return null;
			}`,
			'/api/a',
		);
		expect(served).toEqual([{ method: 'GET', path: '/api/a' }]);
		expect(() =>
			staticServed(
				`export function respond(request: Request, url: URL): Response | null {
					const readyPage = request.method.toUpperCase() === 'GET' && ['/api/a'].includes(url.pathname);
					if (readyPage) return new Response('page');
					return null;
				}`,
				'/api/a',
			),
		).toThrow(/Unsupported route predicate form/u);
	});

	it('fails closed on an opaque method guard even when other branches gave evidence', (): void => {
		for (const guard of [
			`request.method.toUpperCase() === 'PUT'`,
			`isAllowedMethod(request.method)`,
			`['PUT', 'PATCH'].includes(request.method)`,
		])
			expect(
				() =>
					staticServed(
						laterMethodHandler(
							`  if (${guard} && url.pathname === '/api/a') { return new Response('x'); }\n`,
						),
						'/api/a',
					),
				guard,
			).toThrow(/Unsupported route predicate form/u);
	});

	it('treats the live probe as a one-way cross-check of the static inventory', (): void => {
		const staticPairs = [
			{ method: 'GET', path: '/api/a' },
			{ method: 'DELETE', path: '/api/a' },
		];
		// A method the live host serves that the static inventory lacks fails.
		expect(
			liveServedButNotStatic({
				live: [{ method: 'PATCH', path: '/api/a' }],
				staticPairs: staticPairs,
			}),
		).toEqual(['PATCH /api/a: served by the live host, absent from the static inventory']);
		// A static method the probe cannot tell from the reference answer is not a failure.
		expect(
			liveServedButNotStatic({ live: [{ method: 'GET', path: '/api/a' }], staticPairs }),
		).toEqual([]);
	});

	// Closure 4 (a): the else arm and an else-if chain of a branch that matched path and method.
	const elseHandler = (arm: string): string =>
		`export function respond(request: Request, url: URL): Response | null {\n` +
		`  if (request.method === 'GET' && url.pathname === '/api/a') { return new Response('page'); } ${arm}\n` +
		`  return null;\n}\n`;

	it('walks the else arm and the else-if chain of a branch that matched path and method', (): void => {
		for (const arm of [
			`else if (url.pathname === '/api/a') { if (request.method === 'DELETE') { return new Response('no', { status: 405 }); } }`,
			`else if (request.method === 'DELETE' && url.pathname === '/api/a') { return new Response('no', { status: 405 }); }`,
			`else { if (request.method === 'DELETE' && url.pathname === '/api/a') { return new Response('no', { status: 405 }); } }`,
		])
			expect(
				staticServed(elseHandler(arm), '/api/a').map((route) => route.method),
				arm,
			).toEqual(['GET', 'DELETE']);
	});

	// Closure 4 (b): a resolved helper that reads the method in a form the walker cannot take apart.
	const helperHandler = (helper: string, guard: string): string =>
		`${helper}\nexport function respond(request: Request, url: URL): Response | null {\n` +
		`  if (request.method === 'GET' && url.pathname === '/api/a') { return new Response('page'); }\n` +
		`  if (${guard}) { return new Response('x'); }\n  return null;\n}\n`;

	it('fails closed on a resolved helper that reads the method in an opaque form, after an earlier branch gave evidence', (): void => {
		for (const [helper = '', guard = ''] of [
			[
				`function allowed(method: string): boolean { return ['PUT', 'PATCH'].includes(method); }`,
				`allowed(request.method) && url.pathname === '/api/a'`,
			],
			[
				`function allowed(method: string): boolean { return method.toUpperCase() === 'PUT'; }`,
				`allowed(request.method) && url.pathname === '/api/a'`,
			],
			[
				`function allowed(method: string): boolean { return true; }`,
				`allowed(request.method) && url.pathname === '/api/a'`,
			],
			[
				`function allowed(method: string): boolean { return other(method); }\nfunction other(value: string): boolean { return value === 'PUT'; }`,
				`allowed(request.method) && url.pathname === '/api/a'`,
			],
		])
			expect(() => staticServed(helperHandler(helper, guard), '/api/a'), helper).toThrow(
				/Unsupported route predicate form/u,
			);
		// A helper that compares its parameter with a literal method is still read.
		expect(
			staticServed(
				helperHandler(
					`function allowed(method: string): boolean { return method === 'PUT'; }`,
					`allowed(request.method) && url.pathname === '/api/a'`,
				),
				'/api/a',
			).map((route) => route.method),
		).toEqual(['GET', 'PUT']);
	});

	it('exempts only the actual admission predicate, not any call that takes a pathname and a method', (): void => {
		// A look-alike: takes the pathname and the method, reads the method as array membership.
		expect(() =>
			staticServed(
				helperHandler(
					`function isAdmitted(pathname: string, method: string): boolean { return ['PUT', 'PATCH'].includes(method) && pathname === '/api/a'; }`,
					`isAdmitted(url.pathname, request.method)`,
				),
				'/api/a',
			),
		).toThrow(/Unsupported route predicate form/u);
	});

	// Closure 5: a helper that checks a route table and also reads the method.
	const tableHelper = (methodCheck: string, table: 'object' | 'array'): string =>
		table === 'object'
			? `const routes = { '/api/a': true } as const;\nfunction served(pathname: string, method: string): boolean { return Object.hasOwn(routes, pathname) && ${methodCheck}; }`
			: `const routes = [{ path: '/api/a' }] as const;\nfunction served(pathname: string, method: string): boolean { return routes.some((route) => route.path === pathname) && ${methodCheck}; }`;

	it('fails closed on a route-table helper that also reads the method in an opaque form, after an earlier branch gave evidence', (): void => {
		for (const table of ['object', 'array'] as const)
			for (const methodCheck of [
				`['PUT', 'PATCH'].includes(method)`,
				`method.toUpperCase() === 'PUT'`,
				`other(method)`,
			])
				expect(
					() =>
						staticServed(
							helperHandler(
								`${tableHelper(methodCheck, table)}\nfunction other(value: string): boolean { return value === 'PUT'; }`,
								'served(url.pathname, request.method)',
							),
							'/api/a',
						),
					`${table}: ${methodCheck}`,
				).toThrow(/Unsupported route predicate form/u);
	});

	it('still reads a route-table helper that compares the method with a literal', (): void => {
		for (const table of ['object', 'array'] as const)
			expect(
				staticServed(
					helperHandler(
						tableHelper(`method === 'PUT'`, table),
						'served(url.pathname, request.method)',
					),
					'/api/a',
				).map((route) => route.method),
				table,
			).toEqual(['GET', 'PUT']);
	});
});
