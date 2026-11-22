import { queryFamily } from './request-family';

export const requestFamily = queryFamily('/.well-known/oauth-authorization-server', () => ({}));
