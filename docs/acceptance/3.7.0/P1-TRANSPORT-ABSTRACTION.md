# P1 验收：传输接口抽象

日期：2026-11-24  
分支：`work/v3.7.0-v2-baseline`  
代码基线：`3fb1ed0`（P0 冻结）

## 目标

把 P2P V2 的 peer 字节面从“直接持有 `WebRtcTransportPool`”改为“从注册表取命名传输绑定”，为后续 relay/其它传输留出可替换接口，同时保持 BitTorrent 帧格式与共享 pair 生命周期不变。

## 实现

- 新增 `src/agent/webtorrent/transports/registry.mjs`
  - `registerTorrentTransport(name, transport)`：注册 `{name, create({pool})}` 定义。
  - `getTorrentTransport(name)`：按名字取定义；未知名字抛 `P2P_V2_TRANSPORT_UNKNOWN`。
  - 默认注册 `webrtc-v1`；支持 `createTorrentTransportRegistry()` 供测试隔离。
- 新增 `src/agent/webtorrent/transports/webrtc-v1.mjs`
  - `createWebRtcV1Transport({pool})` 只转发 `pool.ensure/send/onMessage`。
  - `destroy()` 只退订自己的 handler；不调用 `pool.closePeer()` / `pool.stop()`。
- `peer-adapter.mjs` 改为接收 `transport`，不再收 `pool`；adapter 仍只 `send` 和 `feed`，不拥有 transport。
- `service.mjs`
  - 传输绑定按名字缓存在当前 pool 上；pool 变化只重建/退订绑定，不关闭 pair。
  - `share` / `add` / `attach` 接受 `transport`，默认 `webrtc-v1`；share/add 记录传输名，后续 attach 缺省沿用。
  - 未知传输在 share 哈希、add 建目录、attach 开 pair 之前按名字拒绝。
  - 帧按 `(peer, info hash)` 路由，并校验 adapter 的 transport 名；帧格式不变。
- `p2p_v2_share` / `p2p_v2_add` / `p2p_v2_attach` 工具面增加可选 `transport` 参数；`p2p_v2_status` 增加 `transports` 视图。
- `multiplex.mjs` 未修改。

## 测试

| 证据 | 结果 |
|---|---|
| `node --test --test-force-exit test/p2p-v2.test.mjs` | **16/16，0 fail，0 skip** |
| `test/p2p-v2-live.mjs`（真实 WebTorrent 3.0.21 + fake WebRTC engine） | **1/1，0 fail，0 skip** |
| `npm run test:p2p-webrtc` | 87/87，0 fail |
| `npm run test:teams` | 39/39，0 fail |
| remote-view 三套件 | 35/35，0 fail |
| `test/claims.test.mjs` | 47 pass / 0 fail / 1 skip |
| `npm run test:tools-surface` | 3/3，0 fail |
| `npm run layer-check` | clean，所有跨层边已声明 |
| 改动文件 ESLint | 0 error / 0 warning |

日志：`.matrix/baseline-370/p1-*.log`。

## 已知边界

- `p2p-v2-live` 的 WebRTC engine 仍是确定性 fake；真实跨机 ICE 矩阵不在本阶段。
- 传输名仍由调用方显式给出，不做远端自动协商或 fleet roster 发现。
- `webrtc-v1` 之外的传输只有注册表接口和 fake 测试，没有生产实现。

## 结论

P1 完成：传输选择已成为注册表查找 + 绑定，`webrtc-v1` 仍是默认；已有的共享 pool 生命周期、Noise 通道和帧格式没有被改写。
