import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily('/api/auth/organization/create', () => ({
	name: 'Example organization',
	slug: 'example-organization',
}));
