// Auth module barrel. The router imports from here; handlers never
// reach into individual `auth/*.ts` files.

export { authenticate } from './authenticate';
export type { AuthClaims } from './authenticate';
export {
  __resetJwtCacheForTest,
} from './jwt';
export {
  __resetJwksCacheForTest,
} from './jwks';
export {
  __resetPemCacheForTest,
} from './pem';
