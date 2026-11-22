import { z } from 'zod';

const authorityPattern =
	/^(\[::1\]|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::([1-9][0-9]{0,4}))?$/u;
const resourcePattern =
	/^(https?):\/\/([^/?#]+)(\/(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/]|%[0-9A-Fa-f]{2})*)?$/u;

/** Provisional mirror of fleet-identity-protocol; replaced by the generated
 * schema in B3 central. D08 compares the original bytes, never URL normalization. */
export const machineResourceUriSchema = z
	.string()
	.max(2048)
	.refine((value: string): boolean => {
		if (!/^[\x21-\x7E]+$/u.test(value)) return false;
		const resource = resourcePattern.exec(value);
		const authority = authorityPattern.exec(resource?.[2] ?? '');
		if (resource === null || authority === null) return false;
		const port = authority[2];
		if (port !== undefined && Number(port) > 65535) return false;
		return (
			resource[1] === 'https' || ['localhost', '127.0.0.1', '[::1]'].includes(authority[1] ?? '')
		);
	}, 'Machine resource must match the byte-exact D08 URL profile');
