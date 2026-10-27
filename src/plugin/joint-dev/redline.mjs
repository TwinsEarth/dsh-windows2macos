/**
 * 兼容入口：红线判据的唯一实现在 src/util/redline-core.mjs（relay 与插件共用）。
 * 保留此文件是为了既有引用（joint-dev/*、测试）不发生破坏性改动。
 */
export {
  MAX_CONTROL_BYTES,
  CONTROL_VERSION,
  CONTROL_TYPES,
  DATA_PLANES,
  CONTROL_ALLOWED_KEYS,
  BODY_ALLOWED_KEYS,
  FORBIDDEN_DATA_KEYS,
  inspectControlMessage,
  assertPlane,
  createAudit,
} from '../../util/redline-core.mjs';
