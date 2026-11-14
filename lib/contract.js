/**
 * Package-facing entry for W2M's interop contract layer: `@twinsearth/w2m-dsh-plugin/contract`.
 *
 * The documented subpath a profile row names to expose `w2m.*` methods (local service + HTTP routes)
 * and to reach peers through the published contract SDK's local → http → file → legacy fallback.
 * The vendored SDK copy and its provenance live in `src/interop/contract/`.
 */
export {
  CONTRACT_LOCAL_SERVICE,
  CONTRACT_ROUTE_PREFIX,
  W2M_CONTRACT_CAPABILITIES,
  W2M_CONTRACT_SERVICE,
  W2M_CONTRACT_VERSION,
  W2M_METHODS,
  W2M_METHOD_VERSION,
  apply,
  createW2mContractClient,
  createW2mContractServer,
  inject,
  name,
  registerContractRoutes,
} from '../src/interop/index.mjs';
