import { workerLinkRoutePath } from '#sign-in-test-support/fuzz/machine-route-classification';

const negativeVariants = [
	'non-upgrade',
	'invalid-organization',
	'query',
	'missing-bearer',
] as const;
type NegativeVariant = (typeof negativeVariants)[number];

export const workerMachineLinkFamily = {
	route: { method: 'GET', path: workerLinkRoutePath },
	variants: negativeVariants,
	generate(
		organizationId: string,
		variant: NegativeVariant,
	): {
		readonly pathname: string;
		readonly init: { readonly method: 'GET'; readonly headers: Headers };
		readonly status: number;
	} {
		const pathname = workerLinkRoutePath.replace(
			'{organization_id}',
			variant === 'invalid-organization' ? 'invalid-organization' : organizationId,
		);
		const headers = new Headers();
		if (variant !== 'non-upgrade') headers.set('upgrade', 'websocket');
		if (variant !== 'missing-bearer')
			headers.set('authorization', 'Bearer fixture-only-machine-token');
		return {
			pathname: variant === 'query' ? `${pathname}?unexpected=fixture` : pathname,
			init: { method: 'GET', headers },
			status: variant === 'missing-bearer' ? 401 : 404,
		};
	},
} as const;
