import type { TestCase } from '@hegeldev/hegel';

/** What a family needs of a test case: to draw. A replay can supply just that. */
export type Drawer = Pick<TestCase, 'draw'>;
import * as generators from '@hegeldev/hegel/generators';

export interface RequestFamilyContext {
	readonly issuer: string;
	readonly personId: string;
	readonly organizationId: string;
	readonly memberId: string;
	readonly invitationId: string;
	readonly passkeyId: string;
	readonly challengeId: string;
	readonly passkeyRegistrationResponse: Readonly<Record<string, unknown>>;
	readonly passkeyAuthenticationResponse: Readonly<Record<string, unknown>>;
	readonly totpCode: string;
	readonly backupCode: string;
	readonly captchaToken: string;
	readonly callbackQuery: Readonly<Record<string, string>>;
	readonly oauthClientId: string;
	readonly oauthClientSecret: string;
	readonly oauthCode: string;
	readonly oauthToken: string;
	readonly oauthCodeVerifier: string;
	readonly oauthCodeChallenge: string;
	readonly oauthRedirectUri: string;
	readonly oauthResource: string;
	readonly machineRouterClientId: string;
	readonly machineId: string;
	readonly machineEnrollmentId: string;
	readonly machineUserCode: string;
	readonly machineDeviceCode: string;
}

/** One variant family, kept structural: how the request is encoded, which field is changed, and how. */
export type FieldMutation =
	| 'valid'
	| 'near-valid'
	| 'boundary'
	| 'wrong-type'
	| 'unsupported-grant';
export interface VariantStep {
	readonly encoding: string;
	readonly field: string | null;
	readonly mutation: FieldMutation;
	readonly flow?: 'machine-device' | 'machine-refresh';
}
export function variantKey(step: VariantStep): string {
	const variant = `${step.encoding}|${step.field ?? '-'}|${step.mutation}`;
	return step.flow === undefined ? variant : `${variant}|${step.flow}`;
}

export interface GeneratedRequest {
	readonly pathname: string;
	readonly init: RequestInit;
	readonly label: string;
	/** The variant family this request is, as data: the coverage proof reads this, not the label. */
	readonly variant: VariantStep;
	readonly expectation: 'success-or-refusal';
}

export interface RequestFamily {
	readonly route: { readonly method: 'GET' | 'POST'; readonly path: string };
	readonly callers: readonly ('signed-out' | 'member' | 'owner')[];
	/**
	 * Every variant family of this route for this context: the valid request, each mutation of each
	 * named field under its encoding, and each transport fault. The context supplies the field inventory.
	 */
	readonly variantSteps: (context: RequestFamilyContext) => readonly VariantStep[];
	/**
	 * Build one request. A given `step` is that variant family exactly (the coverage pass); without
	 * one, the step is drawn from `variantSteps`, so the variant is a function of the draw alone.
	 */
	readonly generate: (
		testCase: Drawer,
		context: RequestFamilyContext,
		step?: VariantStep,
	) => GeneratedRequest;
}

type Fields = Readonly<Record<string, unknown>>;
type FieldsForContext = (context: RequestFamilyContext) => Fields;

const callers = ['signed-out', 'member', 'owner'] as const;

const mutations = ['near-valid', 'boundary', 'wrong-type'] as const;

/** The valid body, then each mutation of each named field (of the body itself when it has none). */
function fieldSteps(valid: Fields, encoding: string): readonly VariantStep[] {
	const keys = Object.keys(valid);
	return [
		{ encoding, field: null, mutation: 'valid' },
		...(keys.length === 0
			? mutations.map((mutation) => ({ encoding, field: null, mutation }))
			: keys.flatMap((field) => mutations.map((mutation) => ({ encoding, field, mutation })))),
	];
}

function stepLabel(step: VariantStep): string {
	if (step.encoding === 'wrong-content-type') return step.encoding;
	return step.field === null ? step.mutation : `${step.mutation}:${step.field}`;
}

function transportStep(encoding: string): VariantStep {
	return { encoding, field: null, mutation: 'valid' };
}

export function chooseStep(
	testCase: Drawer,
	steps: readonly VariantStep[],
	given: VariantStep | undefined,
): VariantStep {
	if (given === undefined) return testCase.draw(generators.sampledFrom([...steps]));
	if (!steps.some((step) => variantKey(step) === variantKey(given)))
		throw new Error(`Variant ${variantKey(given)} is not a variant family of this route`);
	return given;
}

function mutateFields(
	testCase: Drawer,
	valid: Fields,
	step: VariantStep,
): { fields: Fields; label: string } {
	if (step.mutation === 'valid') return { fields: valid, label: 'valid' };
	if (step.field === null)
		return {
			fields: { unexpected: step.mutation === 'wrong-type' ? [] : '' },
			label: step.mutation,
		};
	const originalValue = valid[step.field];
	const value =
		step.mutation === 'wrong-type'
			? // null is the wrong type of any value but null, whose wrong type is an array.
				originalValue === null || originalValue === undefined
				? ['wrong-type']
				: null
			: typeof originalValue === 'number'
				? step.mutation === 'near-valid'
					? -1
					: testCase.draw(generators.sampledFrom([0, 1, 100, 101, 2_147_483_647]))
				: typeof originalValue === 'boolean'
					? step.mutation === 'near-valid'
						? 'false'
						: !originalValue
					: step.mutation === 'near-valid'
						? 'invalid'
						: 'x'.repeat(testCase.draw(generators.integers({ minValue: 0, maxValue: 4096 })));
	return { fields: { ...valid, [step.field]: value }, label: `${step.mutation}:${step.field}` };
}

function jsonSteps(valid: Fields): readonly VariantStep[] {
	return [
		...fieldSteps(valid, 'json'),
		transportStep('malformed'),
		transportStep('wrong-content-type'),
	];
}

export function jsonFamily(
	path: string,
	validFields: FieldsForContext,
	headersForContext: (
		context: RequestFamilyContext,
	) => Readonly<Record<string, string>> = () => ({}),
): RequestFamily {
	return {
		route: { method: 'POST', path },
		callers,
		variantSteps: (context): readonly VariantStep[] => jsonSteps(validFields(context)),
		generate(testCase, context, given): GeneratedRequest {
			const valid = validFields(context);
			const step = chooseStep(testCase, jsonSteps(valid), given);
			const { fields, label } = mutateFields(testCase, valid, step);
			return {
				pathname: path,
				init: {
					method: 'POST',
					headers: {
						'content-type':
							step.encoding === 'wrong-content-type' ? 'text/plain' : 'application/json',
						origin: new URL(context.issuer).origin,
						...headersForContext(context),
					},
					body: step.encoding === 'malformed' ? '{' : JSON.stringify(fields),
				},
				label: `${step.encoding}:${label}`,
				variant: step,
				expectation: 'success-or-refusal',
			};
		},
	};
}

export function queryFamily(path: string, validFields: FieldsForContext): RequestFamily {
	return {
		route: { method: 'GET', path },
		callers,
		variantSteps: (context): readonly VariantStep[] => fieldSteps(validFields(context), 'query'),
		generate(testCase, context, given): GeneratedRequest {
			const valid = validFields(context);
			const step = chooseStep(testCase, fieldSteps(valid, 'query'), given);
			const { fields, label } = mutateFields(testCase, valid, step);
			const query = new URLSearchParams();
			for (const [key, value] of Object.entries(fields)) {
				if (value === null || value === undefined) continue;
				if (typeof value === 'string') query.set(key, value);
				else if (typeof value === 'number' || typeof value === 'boolean')
					query.set(key, String(value));
				else query.set(key, JSON.stringify(value) ?? '');
			}
			const suffix = query.toString();
			return {
				pathname: suffix ? `${path}?${suffix}` : path,
				init: { method: 'GET' },
				label,
				variant: step,
				expectation: 'success-or-refusal',
			};
		},
	};
}

/**
 * A form route that also accepts JSON plans field mutations under both encodings (the reach
 * random generation had before the coverage pass), and a malformed JSON body as a transport fault.
 */
function formSteps(valid: Fields, allowJson: boolean): readonly VariantStep[] {
	return [
		...fieldSteps(valid, 'form'),
		...(allowJson ? [...fieldSteps(valid, 'json'), transportStep('malformed')] : []),
		transportStep('wrong-content-type'),
	];
}

export function formFamily(
	path: string,
	validFields: (context: RequestFamilyContext) => Readonly<Record<string, string>>,
	allowJson: boolean,
	headersForContext: (
		context: RequestFamilyContext,
	) => Readonly<Record<string, string>> = () => ({}),
): RequestFamily {
	return {
		route: { method: 'POST', path },
		callers,
		variantSteps: (context): readonly VariantStep[] => formSteps(validFields(context), allowJson),
		generate(testCase, context, given): GeneratedRequest {
			const valid = validFields(context);
			const step = chooseStep(testCase, formSteps(valid, allowJson), given);
			const { fields, label } = mutateFields(testCase, valid, step);
			const form = new URLSearchParams();
			for (const [key, value] of Object.entries(fields)) {
				if (typeof value === 'string') form.set(key, value);
				else if (value !== null && value !== undefined) form.set(key, JSON.stringify(value) ?? '');
			}
			const isJson = step.encoding === 'json' || step.encoding === 'malformed';
			return {
				pathname: path,
				init: {
					method: 'POST',
					headers: {
						'content-type':
							step.encoding === 'wrong-content-type'
								? 'text/plain'
								: isJson
									? 'application/json'
									: 'application/x-www-form-urlencoded',
						...headersForContext(context),
					},
					body:
						step.encoding === 'malformed' ? '{' : isJson ? JSON.stringify(fields) : form.toString(),
				},
				label: `${step.encoding}:${label}`,
				variant: step,
				expectation: 'success-or-refusal',
			};
		},
	};
}

const tokenFieldKeys = ['client_id', 'code', 'code_verifier', 'redirect_uri', 'resource'] as const;
const tokenSteps: readonly VariantStep[] = [
	{ encoding: 'form', field: null, mutation: 'valid' },
	{ encoding: 'form', field: 'grant_type', mutation: 'unsupported-grant' },
	transportStep('wrong-content-type'),
	...tokenFieldKeys.flatMap((field) => [
		{ encoding: 'form', field, mutation: 'near-valid' as const },
		{ encoding: 'form', field, mutation: 'boundary' as const },
	]),
];

export function tokenFamily(path: string): RequestFamily {
	return {
		route: { method: 'POST', path },
		callers,
		variantSteps: (): readonly VariantStep[] => tokenSteps,
		generate(testCase, context, given): GeneratedRequest {
			const step = chooseStep(testCase, tokenSteps, given);
			const fields: Record<string, string> = {
				grant_type: 'authorization_code',
				client_id: context.oauthClientId,
				code: context.oauthCode,
				code_verifier: context.oauthCodeVerifier,
				redirect_uri: context.oauthRedirectUri,
				resource: context.oauthResource,
			};
			if (step.mutation === 'unsupported-grant') fields.grant_type = 'client_credentials';
			if ((step.mutation === 'near-valid' || step.mutation === 'boundary') && step.field !== null)
				fields[step.field] = step.mutation === 'boundary' ? '' : 'invalid';
			return {
				pathname: path,
				init: {
					method: 'POST',
					headers: {
						'content-type':
							step.encoding === 'wrong-content-type'
								? 'text/plain'
								: 'application/x-www-form-urlencoded',
					},
					body: new URLSearchParams(fields).toString(),
				},
				label: stepLabel(step),
				variant: step,
				expectation: 'success-or-refusal',
			};
		},
	};
}

const introspectionSteps: readonly VariantStep[] = [
	{ encoding: 'form', field: null, mutation: 'valid' },
	{ encoding: 'form', field: 'token', mutation: 'near-valid' },
	{ encoding: 'form', field: 'token', mutation: 'boundary' },
	transportStep('wrong-content-type'),
];

export function introspectionFamily(path: string): RequestFamily {
	return {
		route: { method: 'POST', path },
		callers,
		variantSteps: (): readonly VariantStep[] => introspectionSteps,
		generate(testCase, context, given): GeneratedRequest {
			const step = chooseStep(testCase, introspectionSteps, given);
			const fields = new URLSearchParams({
				token:
					step.mutation === 'boundary'
						? ''
						: step.mutation === 'near-valid'
							? 'invalid'
							: context.oauthToken,
				client_id: context.oauthClientId,
			});
			return {
				pathname: path,
				init: {
					method: 'POST',
					headers: {
						'content-type':
							step.encoding === 'wrong-content-type'
								? 'text/plain'
								: 'application/x-www-form-urlencoded',
						authorization: `Basic ${btoa(`${context.oauthClientId}:${context.oauthClientSecret}`)}`,
					},
					body: fields.toString(),
				},
				label: stepLabel(step),
				variant: step,
				expectation: 'success-or-refusal',
			};
		},
	};
}
