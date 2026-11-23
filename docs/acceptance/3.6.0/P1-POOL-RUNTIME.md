# P1 验收记录 — WebRTC pool runtime / registry ownership

日期：2026-11-23  
工作树：`E:\DB\W2M`  
分支：`work/v3.6.0-desktop-v2`  
基线提交：`2a09619496f1c9e9b8ef65deb9714ad863e19bdc`（P0-BASELINE）  
package 版本：`3.6.0`

## 目标

把「一个进程一个 WebRTC pool」从口头约定变成可执行的运行时合同：

- pool 有唯一 owner；
- 第二个插件行只能 `acquire` 借用，不能创建第二个 pool；
- 消费者可以在 pool 晚到时通过 `getSharedWebRtcPool()` 或订阅拿到它；
- 借用的行不能停掉 owner 的 pool。

P1 只落地 pool 运行时和 registry，不改变 `dsh-p2p-webrtc` 的默认启用状态，也不改桌面 `/stop` 语义。

## 交付

| 文件                                     | 作用                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/plugin/webrtc-pool-registry.mjs`    | owner / acquire / release / subscribe / 兼容旧 `set/get`                                                                                    |
| `src/plugin/p2p-webrtc/pool-runtime.mjs` | 配置归一化、身份/设备密钥解析、单次构建、状态、owner-only stop、进程单例                                                                    |
| `src/plugin/tools/shared.mjs`            | root `w2m` 改为 `createWebRtcPoolRuntime(... owner: 'w2m-root')` + `ensure()`，不再直接 `createWebRtcTransportPool` / `setSharedWebRtcPool` |
| `test/p2p-webrtc-pool-registry.test.mjs` | owner 冲突、并发 acquire、晚绑定订阅、异常订阅者隔离                                                                                        |
| `test/p2p-webrtc-pool-runtime.test.mjs`  | 构建/借用、配置兼容、失败码、密钥缺失、单例、owner-only stop、root 接线守卫                                                                 |

## 运行时合同

### Registry

- `set(pool, { owner })`：首个发布者成为 owner；同一 pool 重复发布幂等；不同 pool 返回 `WEBRTC_POOL_OWNER_CONFLICT`，绝不静默替换。
- `set(null)`：省略 owner 时按旧调用的 `legacy` owner 处理；未显式携带匹配 owner 的非 owner 清除会被拒绝。
- `acquire({ owner, create })`：已有 pool 直接返回 `reused: true`，不调用 `create`；无 pool 时只允许一个构建，并发调用共享同一 promise；工厂抛错/拒绝返回命名失败。
- `release(owner, pool)`：仅 owner 可释放；registry 不调用 `pool.stop()`。
- `subscribe(listener)`：立即收到当前快照，之后在发布/清除时收到更新；返回取消订阅函数；单个订阅者抛错不影响其他订阅者。
- `getSharedWebRtcPoolState()`：`{ pool, owner, ready, epoch }`。

### Runtime

- `normalizePoolRuntimeConfig()` 同时接受 root 的 snake_case 和 Cordis 的 camelCase，并支持嵌套 `webrtc`。
- `createWebRtcPoolRuntime(config, deps)` 返回独立 runtime；`ensureWebRtcPoolRuntime()` 是进程单例入口。
- `ensure()` 幂等、并发安全；已有 pool 时只借用，且不会加载本地设备密钥。
- 构建失败返回 `WEBRTC_POOL_BAD_CONFIG` / `WEBRTC_POOL_IDENTITY_UNAVAILABLE` / `WEBRTC_POOL_DEVICE_KEY_UNAVAILABLE` / `WEBRTC_POOL_PEER_KEY_RESOLVER_REQUIRED` 等命名码。
- `status()` 返回脱敏后的 signal URL、owner、machine id、device key 是否存在、pool diagnostics。
- `stop()` 只停止当前 owner 的 pool；借用方返回 `WEBRTC_POOL_NOT_OWNER`，不触碰 pool。

## 验证

| 套件                                                                                      | 结果                                                      |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `npm run test:p2p-webrtc-pool-runtime`                                                    | 19/19                                                     |
| `npm run test:p2p-webrtc`                                                                 | 71/71                                                     |
| `test/remote-view-route.test.mjs` + `test/p2p-v2.test.mjs` + `test/teams-plugin.test.mjs` | 35/35                                                     |
| `node scripts/layer-check.mjs`                                                            | clean（318 files / 13 layers）                            |
| ESLint（P1 涉及文件）                                                                     | 0 error；仅保留该文件既有的 `require-atomic-updates` 警告 |

## 已知边界

- P1 的 root owner 仍是 `w2m-root`。P2 把 `dsh-p2p-webrtc` 改成 pool provider 后，owner 应切到子插件；root 只保留 `acquire`。
- `dsh-p2p-webrtc` / `dsh-desktop` 仍默认 `disabled: true`；生产 profile 尚未切到 `transport:webrtc` + `allowLegacyP2P:false`。
- `heartbeat.mjs` / `deliver.mjs` 仍固定捕获 `deps.webrtcPool`，P3 改为每次 `getSharedWebRtcPool()`。
- `test/teams-plugin.test.mjs` 的「25 tools」断言是 V2 遗留过期值，已同步为当前 package 的「31 tools」；不属于 P1 功能改动。
- 本机 Windows 的 `npm test` 仍受 8191 字符命令上限影响；本条是本地编排限制，不是套件失败。
- 未执行 `git push`、`git tag`、npm publish、GitHub Release 或市场索引。

## P1 结论

pool 所有权、并发 acquire、晚绑定订阅和 owner-only teardown 已可执行并有测试覆盖；P2 可以在不改 registry 语义的前提下把 `dsh-p2p-webrtc` 接成唯一 owner。
