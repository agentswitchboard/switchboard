import {
	chooseStep,
	formFamily,
	tokenFamily,
	type RequestFamily,
	type RequestFamilyContext,
	type VariantStep,
} from './request-family';

const tokenPath = '/api/auth/oauth2/token';
const personToken = tokenFamily(tokenPath);
const machineToken = {
	'machine-device': formFamily(
		tokenPath,
		(context) => ({
			grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
			client_id: context.machineRouterClientId,
			device_code: context.machineDeviceCode,
		}),
		true,
	),
	'machine-refresh': formFamily(
		tokenPath,
		(context) => ({
			grant_type: 'refresh_token',
			client_id: context.machineEnrollmentId,
			refresh_token: context.machineRefreshToken,
		}),
		true,
	),
} satisfies Record<NonNullable<VariantStep['flow']>, RequestFamily>;

function tokenVariants(context: RequestFamilyContext): readonly VariantStep[] {
	return [
		...personToken.variantSteps(context),
		...machineToken['machine-device'].variantSteps(context).map((step): VariantStep => ({
			...step,
			flow: 'machine-device',
		})),
		...machineToken['machine-refresh'].variantSteps(context).map((step): VariantStep => ({
			...step,
			flow: 'machine-refresh',
		})),
	];
}

export const requestFamily: RequestFamily = {
	route: personToken.route,
	callers: personToken.callers,
	variantSteps: tokenVariants,
	generate(testCase, context, given) {
		const { flow, ...step } = chooseStep(testCase, tokenVariants(context), given);
		if (flow === undefined) return personToken.generate(testCase, context, step);
		const generated = machineToken[flow].generate(testCase, context, step);
		return { ...generated, variant: { ...generated.variant, flow } };
	},
};
