# P6 验收：生产部署与 readiness

- 日期：2026-11-24
- 分支：`work/v3.6.0-desktop-v2`
- 代码基线：P5 `7cc5079` + 文档 `d22f1e0`
- 版本：`@twinsearth/w2m-dsh-plugin@3.6.0`

## 目标

把 P4/P5 的代码路径变成可部署的生产路径：signal 侧怎么起、每台机器怎么装外部 WebRTC
engine、DSH 行怎么配、远端 static key 怎么核对、relay ack 怎么确认、pool 未发布时怎么在
点击“连接”之前发现。

## 交付物

| 文件 | 作用 |
| --- | --- |
| `docs/DESKTOP-PRODUCTION.md` | signal 部署/TLS、provider 安装、DSH 行配置、readiness、回滚、故障表 |
| `scripts/desktop-webrtc-readiness.mjs` | 只读 readiness，输出每项 `ok/code/detail` |
| `test/desktop-webrtc-readiness.test.mjs` | 7 个测试：格式、配置、provider、pool、ack、CLI 脱敏 |
| `package.json` | `desktop:readiness` / `test:desktop-readiness` 脚本；`files` 只额外打包 readiness 脚本，不打包整个 `scripts/` |

## readiness 合同

### 检查项

| id | 通过条件 | 关键约束 |
| --- | --- | --- |
| `node_version` | `>= 20.19` | signal WebSocket 探针建议 Node 22 全局 WebSocket |
| `identity` | `device.json` 有 `machine_id` 与 `device_token` | 不输出 token，只输出 machine id / redacted relay |
| `device_key` | `device.key` 存在且 `DeviceKey.load` 成功 | 只输出 32-byte 公钥指纹；不创建新 key |
| `remote_config` | 文件不存在为 warn；存在时 `transport === --expect-transport`；`enabled=false` 为 warn | 文件优先于行配置；不写文件 |
| provider | `providerCwd`/脚本/package/`node-datachannel` 可解析，`PeerConnection` 是函数 | 只 `require` 加载，不 spawn |
| `signal_health` | `/health` 返回 200 且 `ok:true` | 不打印 token / 完整 URL |
| `signal_websocket` | 短命 join 收到 `joined` 后立即 close | 不发送应用数据；不把 token 写入输出 |
| `pool` | 快照 `ok:true`、`pool_available:true`、`pool_owner:'dsh-p2p-webrtc'`、`pool.ready !== false` | 独立进程不能读 in-process registry；必须有 `--diagnostics-json` 或 `--diagnostics-url` |
| `peer_static_key` | `--peer-key` 或 `GET /v1/peer/<peer>` 的 `peer.static_key` 是 32-byte base64 | 只输出指纹；不输出原值 |
| `relay_ack` | `GET /v1/remote/ack` 返回 404 + `REMOTE_ACK_NOT_FOUND` | 证明路由存在；随机 session 证明没有伪造 ack |

### 命名阻断而不是猜测通过

- 没有 `--diagnostics-json` / `--diagnostics-url`：`pool` 报 `POOL_OBSERVER_MISSING`，退出 2。
  独立脚本不会为了“变绿”去建第二个 pool 或 spawn provider。
- `--skip-pool` / `--skip-network` / `--skip-peer` / `--skip-ack` 只用于离线预检或单机排障；
  带 skip 的报告不能当生产验收。
- 旧 relay 的 404 通用 `NOT_FOUND` 报 `REMOTE_ACK_ROUTE_MISSING`，不把“404”误判成“没有 live ack”。

### 输出脱敏

- `device_token`、`signalToken`、`peer.static_key`、`device.key` 原值不出现；
- `signal` 用 `redactSignalingUrl`，token query 变成 `<redacted>`；
- device public key / peer static key 只输出 16 hex 指纹；
- 输出 JSON 顶层无 token 字段；错误详情也不拼接 Bearer。

## 部署文档范围

`docs/DESKTOP-PRODUCTION.md` 覆盖：

- relay 侧 `w2m-webrtc-signal`：token 文件、`--host/--port/--path`、systemd、nginx/Caddy TLS、
  `/health`、access log 关闭；
- 每台机器 provider：macOS/Linux 与 Windows 命令、`node-datachannel@0.33.6` pin、绝对
  `providerArgs` / `providerCwd`、从 providerCwd 解析 addon；
- DSH 行：`dsh-p2p-webrtc` 生产 `mode:pool` + `autoStart:true` + signal/provider/TURN，
  `dsh-desktop` 严格 `transport:'webrtc'` + `allowLegacyP2P:false`；
- `remote-view.json` 优先级与权限；
- readiness 命令、`--diagnostics-json` 获取方式、`/v1/peer/<machine_id>`、`/v1/remote/ack` 手工核对；
- 单机 `relay` 回滚、整队回滚、禁止用 `pool-stop` 做单机回滚；
- 故障码表与安全清单。

安装/升级脚本不执行 `npm install`，不自动安装 `node-datachannel`；package 仍为零 runtime
dependency。

## 测试

`npm run test:desktop-readiness`：7/7。

| test | 证明 |
| --- | --- |
| `signalHealthUrl` | wss/ws 都映射到 `/health` 并丢掉 token query；非 ws 返回 null |
| `remote-view config` | missing=warn、webrtc=ok、relay=mismatch fail、坏 JSON=invalid fail |
| `static key` | 32-byte base64 通过，16-byte/空值按命名错误拒绝 |
| `pool snapshot` | owner 必须是 `dsh-p2p-webrtc`，`pool_available:false` 阻断，快照里的无关 secret 不进入结果 |
| `ack response` | `REMOTE_ACK_NOT_FOUND`=ok，通用 404=route missing，401=forbidden，200=warn |
| `provider` | 从 `providerCwd` 的 fake `node-datachannel` 真加载出 `PeerConnection`；缺失目录按 `PROVIDER_CWD_MISSING` |
| `CLI` | 临时 state/device key/provider 下真实 spawn，`ok:true`，输出不含 device token 与 signal token |

本轮没有在真实 fleet 安装 `node-datachannel` 或起真实 signal（本机没有生产 token/证书）；
因此 readiness 的真实 `/health`、WebSocket join、`/v1/peer`、`/v1/remote/ack` 网络路径未被
本机执行。它们属于 P7 的真实多机验收，P6 不伪造结果。

## 回归

| 套件 | 结果 |
| --- | --- |
| `npm run test:desktop-readiness` | 7/7 |
| `npm run test:p2p-webrtc` | 87/87 |
| `npm run layer-check` | clean，318 files / 20 declared edges all present |
| `npm pack --dry-run --json` | `scripts/desktop-webrtc-readiness.mjs` 出现在包文件列表 |
| `test/acceptance-doc.test.mjs` | 6/6 |
| readiness JS ESLint | 0 error |

`node --check` 通过 `scripts/desktop-webrtc-readiness.mjs` 与
`test/desktop-webrtc-readiness.test.mjs`。

未执行：`git push`、`git tag`、`npm publish`、GitHub Release、市场索引。未安装/启动真实
signal、`node-datachannel` 或生产 TURN。

## 不在 P6 范围

- P7 的真实 `node-datachannel` 双端 ICE/DTLS、4 节点有向矩阵、30 分钟 soak；
- `docs/acceptance/3.7.0/DESKTOP-WEBRTC-DEFAULT.json` 最终 JSON；
- P2P V2 的 WebTorrent 文件面安装；
- 自动安装脚本或自动 `npm install`。
