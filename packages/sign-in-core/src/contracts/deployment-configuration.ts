import { normalizeToolPortalOrigin } from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

import { organizationStatementLifetimeSeconds } from '#sign-in-core/contracts/organization-statement';
import { machineLoginConfigurationSchema } from '#sign-in-core/machine-login/machine-login-contracts';

const loopbackHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);
function isLoopbackHostname(hostname: string): boolean {
	const normalizedHostname = hostname.replace(/\.$/u, '');
	return (
		loopbackHostnames.has(normalizedHostname) ||
		normalizedHostname.endsWith('.localhost') ||
		/^127(?:\.\d+){3}$/u.test(normalizedHostname)
	);
}
const turnstileSiteSchema = z.strictObject({ siteKey: z.string().min(1) });
const localSiteVerifyUrlSchema = z.url().refine((value: string): boolean => {
	const endpoint = new URL(value);
	return (
		isLoopbackHostname(endpoint.hostname) &&
		['http:', 'https:'].includes(endpoint.protocol) &&
		endpoint.username === '' &&
		endpoint.password === '' &&
		endpoint.hash === ''
	);
}, 'Local siteverify must use a loopback HTTP endpoint');

const turnstileConfigurationSchema = z.discriminatedUnion('kind', [
	turnstileSiteSchema.extend({
		kind: z.literal('local'),
		siteVerifyURLOverride: localSiteVerifyUrlSchema.optional(),
	}),
	turnstileSiteSchema.extend({ kind: z.literal('deployed') }),
]);

export const signInConfigurationSchema = z
	.strictObject({
		issuer: z.url(),
		mode: z.literal('private'),
		ownerEmail: z.email().transform((email) => email.toLowerCase()),
		toolPortalOrigin: z.string().transform(normalizeToolPortalOrigin),
		managementAudience: z.url(),
		centralIdentityAudience: z.url(),
		/** Central's admin audience for person-fleet tokens (Lead, 8 Nov): never the stamp audience. */
		centralAdminAudience: z.url(),
		/**
		 * C8 part B: central's audience for the person-link token minted at a person's link upgrade.
		 * Absent, the person-link route is off: it answers 503 `person-link-not-configured` and mints
		 * nothing, as central treats an absent audience. The off state is temporary. When delivery 5 is
		 * deployed and watched, both sign-in and central make the audience required and the off state
		 * is deleted.
		 */
		centralPersonLinkAudience: z.url().optional(),
		/** Central's own CENTRAL_PUBLIC_ORIGIN: every admin proof's `htu` is this plus the route. */
		centralPublicOrigin: z
			.url()
			.refine(
				(value) => new URL(value).origin === value,
				'An origin only: no path, query or slash',
			),
		/** The system client the owner page mints per-request person-fleet tokens with. */
		adminPageClientId: z.string().min(1),
		/** The owner fleet CLI's system client: loopback PKCE, key-bound refresh (t15e). */
		ownerFleetCliClientId: z.string().min(1),
		organizationStatementLifetimeSeconds: z.literal(organizationStatementLifetimeSeconds),
		/** D7 (Lead, 12 Nov): one deadline bounds each renewal attempt inside a request. */
		organizationStampRenewalDeadlineMilliseconds: z
			.number()
			.int()
			.positive()
			.max(60_000)
			.default(5_000),
		organizationIds: z.array(z.uuidv7()).min(1),
		ownerCliClientId: z.string().min(1),
		ownerCliRedirectUri: z.url().refine((value) => {
			const redirect = new URL(value);
			return (
				redirect.protocol === 'http:' &&
				['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname) &&
				redirect.username === '' &&
				redirect.password === '' &&
				redirect.hash === ''
			);
		}, 'Owner CLI redirects must use an HTTP loopback address'),
		accessTokenSeconds: z.number().int().positive().max(300).default(300),
		machineLogin: machineLoginConfigurationSchema.optional(),
		turnstile: turnstileConfigurationSchema,
		managementHumanCheck: z
			.enum(['remembered-login', 'fresh-verified-uv', 'exact-operation-binding'])
			.default('remembered-login'),
	})
	.superRefine((configuration, context): void => {
		const machineLogin = configuration.machineLogin;
		const localIssuer = isLoopbackHostname(new URL(configuration.issuer).hostname);
		if ((configuration.turnstile.kind === 'local') !== localIssuer)
			context.addIssue({
				code: 'custom',
				path: ['turnstile', 'kind'],
				message: 'Local Turnstile requires a loopback issuer; deployed Turnstile forbids it',
			});
		// A token for one audience must never be accepted by another: every configured audience differs.
		const audiences = [
			configuration.managementAudience,
			configuration.centralIdentityAudience,
			configuration.centralAdminAudience,
			...(configuration.centralPersonLinkAudience === undefined
				? []
				: [configuration.centralPersonLinkAudience]),
			...(machineLogin === undefined ? [] : [machineLogin.machineAudience]),
		];
		if (new Set(audiences).size !== audiences.length)
			context.addIssue({
				code: 'custom',
				path: ['centralAdminAudience'],
				message:
					'The management, stamp, admin, person-link and configured machine audiences must be distinct',
			});
		// Each system client has its own profile; one ID cannot hold two.
		if (
			new Set([
				configuration.ownerCliClientId,
				configuration.adminPageClientId,
				configuration.ownerFleetCliClientId,
				...(machineLogin === undefined ? [] : [machineLogin.routerClientId]),
			]).size !== (machineLogin === undefined ? 3 : 4)
		)
			context.addIssue({
				code: 'custom',
				path: ['adminPageClientId'],
				message:
					'The management CLI, admin page, fleet CLI and configured device client need distinct IDs',
			});
	});
export type SignInConfiguration = z.infer<typeof signInConfigurationSchema>;
