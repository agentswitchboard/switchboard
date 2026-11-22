import { jsonFamily } from './request-family';

// The endpoint ignores any body (the signed cookie is its only input), so body variants only
// vary what the handler must not read.
export const requestFamily = jsonFamily('/api/auth/switchboard/sign-out', () => ({}));
