// Auth module barrel. The router imports from here; handlers never
// reach into individual `auth/*.ts` files.
//
// Stage 8a is a file-move-only split of the old 623-line auth.ts.
// Stage 11 tightens the behavior (alg=none reject, hashed cache keys,
// JWKS versioning, https-only JWKS, error-verbosity, Bearer challenge).

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
