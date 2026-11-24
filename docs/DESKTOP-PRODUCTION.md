# 桌面 WebRTC 生产部署

本文只覆盖 3.6.0 的 **远程桌面生产默认路径**：`dsh-p2p-webrtc` 以 `pool` 模式发布唯一的
WebRTC pool，`dsh-desktop` 用这个 pool 承载远程桌面帧。任务分发仍走同一 pool；P2P V2 的
WebTorrent 文件面不在本文安装范围内。

目标是让“默认 WebRTC”可部署、可验证、可回滚，而不是把 relay 藏起来。任何一步缺失都必须
得到命名错误，不能靠“看起来能连”通过。

## 0. 拓扑

```text
                    TLS / reverse proxy
 relay (w2m-rabbit)  ────────┐
   /v1/remote/ack           │
   /v1/peer/<machine_id>    │
                            │
 signal (w2m-webrtc-signal) ┘
   wss://signal.example.com/w2m/webrtc
          │  SDP / ICE only
          │
  machine A ───────────── WebRTC DataChannel ───────────── machine B
   dsh-p2p-webrtc (pool owner)                    dsh-p2p-webrtc (pool owner)
   node-datachannel provider                      node-datachannel provider
```

- relay 仍然负责配对、任务、SSE 和 `/v1/remote/ack` 控制面；远程桌面帧不经过 relay。
- signal 只转发 SDP/ICE，不解析 SDP、不持有应用会话；DataChannel 建立后可以断开。
- 每台机器各有一个外部 WebRTC engine（`node-datachannel`），不是包内依赖。
- 所有 WebRTC 应用帧仍经过既有 Noise IK + ChaCha20-Poly1305；SDP/ICE 永远不是信任材料。

## 1. 前置条件

| 项      | 要求                                                                                   |
| ------- | -------------------------------------------------------------------------------------- |
| Node.js | `>= 20.19.0`；生产建议 22 LTS，signal 的 WebSocket 探针要求 Node 22 的全局 `WebSocket` |
| DSH     | `>= 0.2.0 < 0.3.0`                                                                     |
| 插件    | `@twinsearth/w2m-dsh-plugin@3.6.0` 或包含 P4/P5 的同版本构建                           |
| relay   | 已部署，且包含 `/v1/remote/ack` 与 `/v1/peer/<machine_id>`                             |
| TLS     | signal 对外必须是 `wss://`；relay 按现有部署要求                                       |
| 包依赖  | **不新增 runtime dependency**；`node-datachannel` 只装在每台机器的 provider 目录       |

先确认 Node 与包入口：

```bash
node --version
node "$W2M_PLUGIN_DIR/bin/w2m-webrtc-signal.mjs" --help
```

signal CLI 目前没有 `--help`；不要在 shell 里用 `--help` 试运行它。检查语法用：

```bash
node --check "$W2M_PLUGIN_DIR/bin/w2m-webrtc-signal.mjs"
```

## 2. relay 侧：部署 `w2m-webrtc-signal`

### 2.1 生成 token

signal token 是共享 secret，不是设备 token。不要写进 URL、git、shell history 或进程参数。

```bash
sudo install -d -m 700 /etc/w2m
sudo sh -c 'umask 077; head -c 32 /dev/urandom | base64 > /etc/w2m/signal-token'
sudo chown w2m:w2m /etc/w2m/signal-token
sudo chmod 600 /etc/w2m/signal-token
```

每台机器通过环境变量读取同一个 token；signal 服务器用 `--token-file` 读取。

### 2.2 启动 signal

signal 与 relay 分开部署；relay 重启不应断开已建立的 DataChannel。

```bash
node /opt/w2m/node_modules/@twinsearth/w2m-dsh-plugin/bin/w2m-webrtc-signal.mjs \
  --host 127.0.0.1 \
  --port 8788 \
  --path /w2m/webrtc \
  --token-file /etc/w2m/signal-token
```

- 默认绑定 `127.0.0.1`；只有前面有 TLS/私有网络时才用 `0.0.0.0`。
- signal 自身说 cleartext WebSocket；TLS 由 nginx/Caddy 终止。
- `--path` 必须与 `signalUrl` 的路径一致（默认 `/w2m/webrtc`）。
- 服务器打印的 URL 不含 token；health 在 `/health`，不需要 token。

### 2.3 systemd 单元

```ini
[Unit]
Description=W2M WebRTC signaling
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=w2m
Group=w2m
WorkingDirectory=/opt/w2m
ExecStart=/usr/bin/node /opt/w2m/node_modules/@twinsearth/w2m-dsh-plugin/bin/w2m-webrtc-signal.mjs --host 127.0.0.1 --port 8788 --path /w2m/webrtc --token-file /etc/w2m/signal-token
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/opt/w2m /etc/w2m/signal-token

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now w2m-webrtc-signal
sudo systemctl status w2m-webrtc-signal
curl -fsS http://127.0.0.1:8788/health
```

健康响应示例：

```json
{ "ok": true, "protocol": "w2m-webrtc/1", "uptime_ms": 12345, "rooms": 0 }
```

字段以实际服务器实现为准；关键是 `ok:true`。

### 2.4 nginx / TLS 终止

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 443 ssl http2;
  server_name signal.example.com;

  ssl_certificate     /etc/letsencrypt/live/signal.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/signal.example.com/privkey.pem;

  # WebSocket 的 token 在 query string；不要把它写进 access log。
  location /w2m/webrtc {
    access_log off;
    proxy_pass http://127.0.0.1:8788;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }

  location = /w2m/signal-health {
    access_log off;
    proxy_pass http://127.0.0.1:8788/health;
  }
}
```

生产 `signalUrl`：

```text
wss://signal.example.com/w2m/webrtc
```

不要把 `?token=...` 写进 `signalUrl`；token 用 `signalToken` 单独传给客户端。若确实把 token
放在 URL 里，至少确认 nginx access log 已关闭，并知道它可能被代理日志记录。

Windows 上可用 NSSM 或计划任务运行同一个 `node ... --token-file ...`；不要让 token 出现在
任务参数里，改用受 ACL 保护的文件。

## 3. 每台机器：安装 `node-datachannel` provider

包本身零 runtime dependency；provider 目录和 `node-datachannel` 都由运维安装。安装/升级脚本
**不会**自动执行 `npm install`，也不再提供隐藏安装开关。

### 3.1 macOS / Linux

```bash
export W2M_PROVIDER_DIR="$HOME/.w2m/webrtc-provider"
mkdir -p "$W2M_PROVIDER_DIR"
cd "$W2M_PROVIDER_DIR"
npm init -y
npm install --save-exact node-datachannel@0.33.6
cp "$W2M_PLUGIN_DIR/src/agent/webrtc/providers/node-datachannel-provider.mjs" .
node -e 'const m=require("node-datachannel"); if (typeof m.PeerConnection !== "function") process.exit(1); console.log("node-datachannel", m.version ?? "loaded")'
```

### 3.2 Windows PowerShell

```powershell
$W2M_PROVIDER_DIR = "$HOME\.w2m\webrtc-provider"
New-Item -ItemType Directory -Force $W2M_PROVIDER_DIR | Out-Null
Set-Location $W2M_PROVIDER_DIR
npm init -y
npm install --save-exact node-datachannel@0.33.6
Copy-Item "$W2M_PLUGIN_DIR\src\agent\webrtc\providers\node-datachannel-provider.mjs" .
node -e 'const m=require("node-datachannel"); if (typeof m.PeerConnection !== "function") process.exit(1); console.log("node-datachannel", m.version ?? "loaded")'
```

### 3.3 版本与路径

- 先 pin 一个已验证的 `node-datachannel` 版本；上面的 `0.33.6` 是当前参考版本，换版本必须重跑
  真实 ICE/DTLS 双端测试。
- `providerCwd` 必须是**绝对路径**；Node 的 `child_process.cwd` 与 provider 不展开 `~` 或
  shell 变量。
- `providerArgs` 指向 provider 脚本的绝对路径。可以把打包内的脚本直接指过去，也可以复制到
  provider 目录；两种方式都从 `providerCwd` 解析 `node-datachannel`。
- 不要 `npm install` 到 W2M 包目录；那会把包变成有 runtime dependency，违背包的合同。
- 升级 provider 时只替换 provider 目录里的 addon/脚本，不改 `signalToken` 或设备密钥。

## 4. DSH 行配置

### 4.1 `dsh-p2p-webrtc`：生产 pool provider

```yaml
- id: dsh-p2p-webrtc
  name: '@twinsearth/w2m-dsh-plugin/dsh-p2p-webrtc'
  disabled: false
  config:
    mode: 'pool'
    autoStart: true
    signalUrl: 'wss://signal.example.com/w2m/webrtc'
    signalToken: !!js process.env.W2M_WEBRTC_SIGNAL_TOKEN
    rabbitUrl: ''
    deviceKeyDir: ''
    allowCreateDeviceKey: false
    providerCommand: 'node'
    providerArgs: ['/Users/me/.w2m/webrtc-provider/node-datachannel-provider.mjs']
    providerCwd: '/Users/me/.w2m/webrtc-provider'
    iceServers:
      - urls: ['stun:stun.example.com:3478']
    turnServers:
      - urls: ['turn:w2m:<secret>@turn-a.example:3479']
      - urls: ['turn:w2m:<secret>@turn-b.example:3479']
    turnPolicy: balanced
    preferP2p: true
    allowRelay: true
    maxRttMs: 350
    connectTimeoutMs: 30000
    handshakeTimeoutMs: 15000
    peerTimeoutMs: 20000
```

Windows 的 `providerCwd` / `providerArgs` 使用正斜杠或双反斜杠：

```yaml
providerArgs: ['C:/Users/me/.w2m/webrtc-provider/node-datachannel-provider.mjs']
providerCwd: 'C:/Users/me/.w2m/webrtc-provider'
```

`deviceKeyDir: ''` 表示 `<DSH_HOME>/xclient`，与 `device.json` 同目录。生产不要打开
`allowCreateDeviceKey: true`，除非明确接受“新 key 会改变机器身份、旧 peer 会拒绝”的后果。
`signalToken` 的 `!!js` 读取发生在 DSH 进程启动时；启动 DSH 的环境必须有
`W2M_WEBRTC_SIGNAL_TOKEN`，否则 pool 会以 `signalUrl`/token 缺失拒绝，而不是猜一个默认值。

`turn:` 与 `turns:` 都可用；`turns:` 是 TLS 选项，`turn:` 是常规 UDP 部署。生产优先 `turns:`，并保留 `turnServers` 双节点与 `turnPolicy: balanced`。

### 4.2 `dsh-desktop`：默认 WebRTC

```yaml
- id: dsh-desktop
  name: '@twinsearth/w2m-dsh-plugin/desktop'
  disabled: false
  config:
    transport: 'webrtc'
    allowLegacyP2P: false
    prepareTimeoutMs: 8000
    handshakeTimeoutMs: 10000
```

`transport: 'webrtc'` 是严格模式：失败返回命名 502，不静默回落到 relay。生产先按这个模式验收；
需要临时救火时改单机 `remote-view.json` 为 `relay`，不要改全队 profile。

`remote-view.json` 的优先级高于行配置：

```json
{ "enabled": true, "transport": "webrtc", "updatedAt": "2026-11-24T00:00:00.000Z" }
```

- 路径：`<DSH_HOME>/xclient/remote-view.json`，默认 `~/.dsh/xclient/remote-view.json`；
- 权限：`600`，目录 `700`；
- 文件存在时 `transport` 取文件值，`transport_source:"json"`；
- 文件不存在时取行默认，`transport_source:"row"` 或 `"default"`。

如果不希望 UI 改配置，预置这个文件并做权限保护；否则远程桌面面板的“开启”会写它。

### 4.3 P2P V2

`dsh-p2p-v2` 的多对多文件面可以复用本 pool，但它还需要单独安装 WebTorrent 的入口模块，
不在 P6 的桌面验收范围。不要为了开远程桌面去装 WebTorrent；也不要让 V2 建立第二个
WebRTC pool。

## 5. 启动与验收

### 5.1 启动顺序

1. relay（含 `/v1/remote/ack`）已在线；
2. signal 在线，`/health` 为 `ok:true`；
3. 每台机器的 provider 目录可加载 `node-datachannel`；
4. DSH 启动，`dsh-p2p-webrtc` 的 `autoStart:true` 发布 pool；
5. `dsh-desktop` 挂载并读取 `remote-view.json` / 行配置；
6. 打开远程桌面面板，确认底部显示 `WebRTC`，不是 `P2P`，且“WebRTC：就绪”。

### 5.2 只读 readiness

脚本：`bin/w2m-desktop-readiness.mjs`。

```bash
node "$W2M_PLUGIN_DIR/bin/w2m-desktop-readiness.mjs" \
  --state "${DSH_HOME:-$HOME/.dsh}/xclient" \
  --signal "wss://signal.example.com/w2m/webrtc" \
  --health-url "https://signal.example.com/w2m/signal-health" \
  --provider-cwd "$HOME/.w2m/webrtc-provider" \
  --peer "machine-b" \
  --diagnostics-json /tmp/remote-diagnostics.json
```

`--health-url` 与上面的 nginx `/w2m/signal-health` 对应；如果 signal 直接暴露 `/health`，可以
省略它，脚本默认把 `wss://host/...` 映射为 `https://host/health`。

它检查：

| 检查                                                                        | 语义                                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `node_version`                                                              | `>= 20.19`；WebSocket 探针建议 22                                              |
| `identity`                                                                  | `device.json` 有 `machine_id` / `device_token`；不打印 token                   |
| `device_key`                                                                | `device.key` 可加载；只输出公钥指纹                                            |
| `remote_config`                                                             | `remote-view.json` 的 `transport` / `enabled`；文件不存在为 warn               |
| `provider_cwd` / `provider_script` / `provider_package` / `provider_module` | provider 目录、脚本、`node-datachannel` 可解析；不 spawn                       |
| `signal_health` / `signal_websocket`                                        | TLS `/health` 与一次短命 join；不发送应用数据                                  |
| `pool`                                                                      | 从 diagnostics 快照检查 `pool_available`、`pool_owner=dsh-p2p-webrtc`、`ready` |
| `peer_static_key`                                                           | `GET /v1/peer/<peer>` 的 `peer.static_key` 是 32-byte base64；只输出指纹       |
| `relay_ack`                                                                 | `GET /v1/remote/ack` 返回 `REMOTE_ACK_NOT_FOUND`，证明路由存在；不伪造 ack     |

**pool 为什么必须从快照读**：pool 是 DSH 进程内状态，独立脚本无法 import 到同一个 registry。
脚本不会自己建 pool，也不会 spawn provider 来“凑一个 ready”。因此生产验收要么给
`--diagnostics-json`（从已鉴权的桌面 host 保存的响应），要么给 `--diagnostics-url` 和
`W2M_DIAGNOSTICS_COOKIE`。两者都不给时 `pool` 是命名失败，不是猜测通过。

获取快照（把 `<desktop-port>` 换成 DSH 桌面 host 的实际端口；该路由不在 relay 上）：

```bash
curl -fsS \
  -H "Cookie: $W2M_DESKTOP_COOKIE" \
  "http://127.0.0.1:<desktop-port>/api/w2m/remote/diagnostics" \
  > /tmp/remote-diagnostics.json
```

或者：

```bash
W2M_DIAGNOSTICS_COOKIE="$W2M_DESKTOP_COOKIE" \
node "$W2M_PLUGIN_DIR/bin/w2m-desktop-readiness.mjs" \
  --state "$HOME/.dsh/xclient" \
  --signal "wss://signal.example.com/w2m/webrtc" \
  --provider-cwd "$HOME/.w2m/webrtc-provider" \
  --peer "machine-b" \
  --diagnostics-url "http://127.0.0.1:<desktop-port>/api/w2m/remote/diagnostics"
```

`--skip-network`、`--skip-pool`、`--skip-peer`、`--skip-ack` 只用于离线预检或单机排障；生产
验收不应带这些 flag。脚本不打印 `device_token`、`signalToken`、私钥、`peer.static_key` 原值
或完整 signaling URL。

### 5.3 手工核对

`remote-view.json` / `/config`：

```bash
# 在已鉴权的桌面 host 上
GET /api/w2m/remote/config
```

期望：

```json
{
  "ok": true,
  "enabled": true,
  "transport": "webrtc",
  "transport_source": "json",
  "pool_available": true,
  "pool_owner": "dsh-p2p-webrtc",
  "legacy_p2p": false
}
```

`/v1/peer/<machine_id>`：

```bash
TOKEN=$(jq -r .device_token "$HOME/.dsh/xclient/device.json")
RELAY=$(jq -r .rabbit_url "$HOME/.dsh/xclient/device.json")
curl -fsS -H "Authorization: Bearer $TOKEN" "$RELAY/v1/peer/machine-b" \
  | jq -r '.peer.static_key // empty' \
  | awk '{ if (length($0) > 0) print "static_key present" }'
unset TOKEN
```

不要在终端 `echo` token 或 static key；readiness 脚本只输出指纹。

`/v1/remote/ack`：

```bash
curl -sS -o /tmp/ack.json -w '%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  "$RELAY/v1/remote/ack?session_id=readiness-$(date +%s)&target=$MACHINE_ID"
cat /tmp/ack.json
```

期望 `404`，body 的 `error.code` 为 `REMOTE_ACK_NOT_FOUND`。如果返回通用 `NOT_FOUND` 或
HTML，说明 relay 版本没有这个路由，`auto`/`webrtc` 都无法按预期工作。

### 5.4 一次真实查看

1. 目标机也开启远程桌面开关；
2. viewer 选择目标，点“连接”；
3. 顶部显示 `远程会话：<id> · WebRTC · 直连：是/否`；
4. 底部 `通道：WebRTC`、`直连：是/否`、`WebRTC：就绪`；
5. 打开 `/api/w2m/remote/diagnostics`：`session.channel:"webrtc"`、
   `session.direct` 为 `true/false`、`counters.relay_frames` 不增长；
6. 关闭窗口后再看 Teams/任务数据面，确认 pool 未被拆掉。

## 6. 发布与回滚

发布顺序按设计文档：relay ack 路由 → 插件 → 生产 profile → 观察 24 小时。

单机回滚：

```json
{ "enabled": true, "transport": "relay" }
```

写入 `~/.dsh/xclient/remote-view.json` 即可，无需重启；`/config` 会显示
`transport_source:"json"`。

整队回滚：

- `dsh-desktop` 行改回 `transport: 'auto'` 或 `'relay'`；
- `dsh-p2p-webrtc.autoStart` 可保留；`dsh-p2p-v2`、Teams、任务分发不依赖桌面视图；
- 代码回退到 P4 前的 desktop 实现时，共享 pool runtime 可以保留，只需 `autoStart:false`。

不要用 `p2p_webrtc_stop` 的 `pool-stop` 做单机回滚：那会拆掉 Teams / 任务分发共用的 pool。

## 7. 故障定位

| 现象                 | 命名错误                                                            | 处理                                                                          |
| -------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| pool 没发布          | `pool_available:false` / `WEBRTC_POOL_BAD_CONFIG`                   | 确认 `dsh-p2p-webrtc` 已启用、`mode:pool`、`autoStart:true`、`signalUrl` 非空 |
| 机器没有设备密钥     | `WEBRTC_POOL_DEVICE_KEY_UNAVAILABLE`                                | 恢复 `device.key`，不要随意开启 `allowCreateDeviceKey`                        |
| provider 目录没装    | `WEBRTC_PROVIDER_UNAVAILABLE` / readiness `PROVIDER_MODULE_MISSING` | 在 `providerCwd` 执行 `npm install --save-exact node-datachannel@...`         |
| provider 子进程失败  | `WEBRTC_PROVIDER_SPAWN_FAILED`                                      | 用绝对路径跑 provider；确认 `node` 在 DSH 的 PATH 中                          |
| signal 不可达        | `SIGNAL_HEALTH_FAILED` / `WEBRTC_SIGNAL_*`                          | 检查 `wss://`、nginx Upgrade、token、`--path`                                 |
| ack 路由缺失         | `REMOTE_ACK_ROUTE_MISSING` / `WEBRTC_ACK_UNAVAILABLE`               | 升级 relay 到含 `/v1/remote/ack` 的版本                                       |
| peer 没有 static key | `PEER_STATIC_KEY_UNAVAILABLE`                                       | 对方先 announce/上线；或显式提供 peer key 做离线核对                          |
| 严格 WebRTC 失败     | `webrtc.attempted:true, ok:false`                                   | 查 `fallback_reason`、provider、ICE/TURN；不要悄悄改 relay                    |
| 旧客户端仍想 P2P     | `allowLegacyP2P`                                                    | 生产保持 false；旧路径只用于兼容，不是默认                                    |

## 8. 安全检查清单

- signal token 只在 `/etc/w2m/signal-token` 或环境变量；不进 URL、git、日志、命令行。
- nginx 的 WebSocket location `access_log off`，避免 query token 写入访问日志。
- `remote-view.json`、`device.key`、`device.json` 权限分别为 `600`；状态目录 `700`。
- 不输出 `peer.static_key` 原值；只输出指纹或“present”。
- TURN 优先 `turns:`；`turn:` 也可用于内网/边缘部署，凭证只在配置与环境变量中。
- `allowCreateDeviceKey:false`；换 key 等于换机器身份。
- `transport:'webrtc'` 严格模式上线，`auto` 仅用于迁移/回滚窗口。
- readiness 的 `pool` 必须来自真实 diagnostics 快照；`--skip-pool` 的结果不能当生产验收。

## 9. P6 验收边界与 P7 结果

本文和 `bin/w2m-desktop-readiness.mjs` 只做部署与只读 readiness。真实多机 ICE/DTLS
矩阵、30 分钟 1 Hz soak 与最终验收 JSON 属于 P7；P7 的实测结果与现网 NAT 限制见
`docs/acceptance/3.7.0/DESKTOP-WEBRTC-DEFAULT.md` 和 `.json`。本文件不伪造这些结果。

相关文档：

- `docs/P2P-WEBRTC.md`：协议、provider JSON-line、pool 语义；
- `docs/design/DESKTOP-DEFAULT-WEBRTC-PLAN.md`：P0–P7 计划；
- `docs/acceptance/3.6.0/P4-DESKTOP-ROW-CONFIG.md`：行配置与回落；
- `docs/acceptance/3.6.0/P5-DIAGNOSTICS.md`：诊断字段与客户端标签；
- `docs/acceptance/3.7.0/DESKTOP-WEBRTC-DEFAULT.md`：P7 真实引擎矩阵、故障与 soak 结果。
