import { queryFamily } from './request-family';

export const requestFamily = queryFamily('/.well-known/openid-configuration', () => ({}));
