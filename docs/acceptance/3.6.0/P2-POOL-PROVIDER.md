# P2 验收：P2P 子插件成为共享 WebRTC pool 提供者

- 版本：`3.6.0`
- 分支：`work/v3.6.0-desktop-v2`
- 前置：P1 `32b5a15 feat(webrtc): add owner-aware process pool runtime`
- 范围：`dsh-p2p-webrtc` 的 `mode: 'pool'`、root `w2m` 的 consumer 化、工具面 pool 状态与 stop 语义。

## 结论

P2 达标。`dsh-p2p-webrtc` 在 `autoStart: true` / `mode: 'pool'` 时通过
`createWebRtcPoolRuntime({ owner: 'dsh-p2p-webrtc' })` 构建或借用进程级 pool；root `w2m`
不再构建 pool，也不在 teardown 停 pool；`p2p_webrtc_stop` 默认只关闭一个 peer，只有
`confirm: "pool-stop"` 才整池停止。桌面 viewer、Teams 数据面、P2P V2 仍可从 registry
晚绑定同一 pool，不会被一次 peer 停止拆掉。

## 行为合同

### `dsh-p2p-webrtc`

- `normalizePluginConfig()`：
  - `mode` 接受 `pool` / `single`；
  - 未显式配置时，`autoStart: true` 推导为 `pool`，否则 `single`；
  - `rabbitUrl` 可显式配置；空值时按 `device.json` 的 `rabbit_url`、再按
    `W2M_RABBIT_URL` 解析 peer static key；
  - `pool` / `single` 都保留原有单 transport 兼容字段。
- `autoStart: true`：`apply()` **await** `service.start()`；失败只记录命名原因
  （如 `WEBRTC_POOL_OWNER_CONFLICT`）并继续 mount，不抛异常。
- `mode: 'pool'`：
  - `status()` 固定返回 `mode`、`pool: {ready, owner, machine_id, signal_url,
    device_key_present, peers, peer_count, diagnostics, last_ensure}`、`last_ensure`；
  - `p2p_webrtc_start` 先 ensure pool，再按 `peerMachineId` 调 `pool.ensure(peer)`；
    未给 peer 时只发布 pool，返回 `state: "pool-ready"`；
  - `p2p_webrtc_stop` 有 peer 时只 `pool.closePeer(peer)`；无 peer 时返回
    `WEBRTC_POOL_STOP_REFUSED`；`confirm: "pool-stop"` 才 `runtime.stop()`；
  - `p2p_webrtc_probe` 通过 `pool.peerStatus(peer)` 确认 pair，再取该 pair 的 live
    transport probe；不存在时返回 `WEBRTC_POOL_PEER_NOT_LIVE`，不会为了 probe 新建 pair；
  - `apply()` 的 effect disposer 调 `service.dispose()`：只关闭配置的 peer，绝不拆池。
- `mode: 'single'`：`start` / `stop` / `probe` 仍是原来的单 transport 生命周期，
  以保持旧调用方与单 pair 诊断可用。

### root `w2m`

- `cfg.webrtc.buildable === true` 时只 `getSharedWebRtcPool()`：
  - 已有 pool：借用并写 `inProcessWebRtcPool`；
  - 尚无 pool：写 `cfg.webrtc.reason = "WEBRTC_POOL_UNAVAILABLE: ..."`，不构建第二个 pool；
- root teardown 不再调用 `webrtcRuntime.stop()`；pool 生命周期属于 provider。

### `cordis.patch.yml`

- 包默认仍是 `dsh-p2p-webrtc: disabled: true`、`autoStart: false`；
- 行内新增 `mode: 'pool'`、`rabbitUrl: ''`；
- 行后新增生产 profile 示例：provider `enabled`、`autoStart: true`、`signalUrl`、
  `providerCommand`，以及 `dsh-desktop` 的 `transport: 'webrtc'` /
  `allowLegacyP2P: false`。

## 测试证据

| 套件 | 结果 |
| --- | --- |
| `node --test test/p2p-webrtc-plugin.test.mjs` | 16/16 |
| `npm run test:p2p-webrtc-pool-runtime` | 19/19 |
| `npm run test:p2p-webrtc` | 80/80 |
| `node --test test/remote-view-route.test.mjs test/p2p-v2.test.mjs test/teams-plugin.test.mjs` | 35/35 |
| `node scripts/layer-check.mjs` | clean（318 files / 13 layers） |
| ESLint（P2 改动文件） | 0 error，13 个既有 warning |

新增覆盖：

- `autoStart` 只 ensure 一次 pool，status 报告 owner / machine id / peers；
- 真实 `createWebRtcPoolRuntime` + 隔离 registry：provider 成为 owner，`poolFactory`
  只构建一次，`confirm: "pool-stop"` 后才 release；
- `stop` 有 peer：只 `closePeer`，`pool.stop` 调用次数为 0；
- `stop` 无 peer：`WEBRTC_POOL_STOP_REFUSED`；
- `dispose` 只关闭配置 peer；
- probe 走 live transport，未知 peer 返回命名拒绝；
- owner 冲突只 warn，不阻塞 mount；
- 无 `providerCommand` 时 autoStart 返回 `WEBRTC_PROVIDER_UNAVAILABLE` 并继续 mount；
- `p2p_webrtc_stop` 工具默认拒绝整池停止。

## 未完成 / 下一阶段

- P3：`heartbeat.mjs` / `deliver.mjs` 仍固定捕获 `deps.webrtcPool`；root 在 p2p 行之前
  mount 时 `webrtcPool` 为 null，任务面需要晚绑定 registry 后才会真正走 WebRTC。
- P4：桌面 `transport: 'auto'` 仍可能尝试旧 UDP；生产 profile 需要收紧为
  `transport: 'webrtc'`、`allowLegacyP2P: false`，并补齐 `/start` 的 pool 诊断字段。
- 未执行 `git push`、`git tag`、npm publish、GitHub Release 或市场索引。
