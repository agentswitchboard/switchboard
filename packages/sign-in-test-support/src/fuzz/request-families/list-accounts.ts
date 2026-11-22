import { queryFamily } from './request-family';

export const requestFamily = queryFamily('/api/auth/list-accounts', () => ({}));
