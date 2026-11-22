import { queryFamily } from './request-family';

export const requestFamily = queryFamily('/people', () => ({}));
