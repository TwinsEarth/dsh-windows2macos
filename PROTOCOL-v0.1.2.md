# W2M 线协议 v0.1.2 增量（跨区域 / 跨网络）

> 基线：`PROTOCOL.md`（v1 冻结）。**本文件只写增量**，未提及的部分一律不变。
> 主题：让中继可以被放在**公网 VPS、Tailscale 内网、或隧道后面**，且三种部署都正确工作。

---

## 0. 为什么需要这版（现状的三个真实缺陷）

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | 客户端用 `new URL('/v1/stream', rabbitUrl)` 拼 URL | **一旦中继挂在子路径后面就全部 404**。`new URL('/a', 'https://h/w2m')` → `https://h/a`，前缀被吃掉。只有挂在根路径才行 |
| 2 | 中继是纯 `http`，无代理头处理，无 CORS | 反代/隧道后面拿不到真实 scheme，SSE 可能被中间层缓冲；浏览器预检直接失败 |
| 3 | 中继纯内存、无持久化 | 重启即丢设备表与任务账本，所有机器要重新配对；跨区域后中继多半在 VPS 上会被重启/迁移 |
| 4 | 任何已配对设备都能下发指令 | 公网暴露后，一台被攻破的机器可以反过来指挥组内其他机器 |

---

## 1. 部署形态（三种都要支持）

| 形态 | TLS 由谁做 | 中继监听 | 客户端 `rabbitUrl` 长什么样 |
|---|---|---|---|
| **A. Tailscale / WireGuard** | 网络层（WireGuard 自带端到端加密） | `100.x.y.z:8787` | `http://100.x.y.z:8787`（明文 HTTP 走加密隧道，**正确且推荐**） |
| **B. 公网 VPS + 域名 + TLS** | 中继自己（`--tls-cert`/`--tls-key`）或前置反代 | `127.0.0.1:8787` 或 `0.0.0.0:8443` | `https://w2m.example.com` |
| **C. 隧道（Cloudflare Tunnel / ngrok）** | 隧道服务 | `127.0.0.1:8787` | `https://<随机子域>.example.com` **或带子路径** |

**子路径是硬要求**：形态 C 与部分反代会把服务挂在 `https://host/w2m/` 下。因此协议新增「部署基路径」概念。

---

## 2. 客户端：`rabbitUrl` 语义（**修正 #1**）

`rabbitUrl` 一律解释为「**基地址**」，允许带子路径，**不允许带查询串或片段**。

```
合法：http://127.0.0.1:8787
      http://100.64.0.5:8787
      https://w2m.example.com
      https://w2m.example.com/team-a/w2m        ← 子路径
      https://w2m.example.com/w2m/             ← 末尾斜杠可有可无
非法：https://w2m.example.com?x=1
      https://w2m.example.com#frag
```

**拼接规则（唯一正确实现）**：
```
base  = 去掉末尾所有 '/' 的 rabbitUrl
url(p) = base + (p.startsWith('/') ? p : '/' + p)
```
**禁止**用 `new URL(path, base)`（会吃掉子路径），**禁止**用 `path.posix.join`（会把 `https://` 的双斜杠压成一个）。

`rabbitUrl` 若非法（带 query/fragment、不是 http/https、解析失败）→ **启动即报错**，错误信息点名 `rabbitUrl` 与非法原因，不要静默降级。

---

## 3. 中继：部署参数（新增）

| CLI | 环境变量 | 默认 | 语义 |
|---|---|---|---|
| `--base-path <p>` | `W2M_BASE_PATH` | `/` | 中继期望自己被挂载的前缀。反代把 `/w2m/v1/task` 转成 `/v1/task` 时**不用设**；反代**原样透传** `/w2m/v1/task` 时**必须设** `--base-path /w2m` |
| `--trust-proxy` | `W2M_TRUST_PROXY=1` | 关 | 信任 `X-Forwarded-Proto` / `X-Forwarded-For`。**仅在确实位于可信反代之后时开启**，否则客户端可伪造 IP 绕过限流 |
| `--tls-cert <f>` / `--tls-key <f>` | — | — | 由中继自己终结 TLS（形态 B） |
| `--operator-token <t>` | `W2M_OPERATOR_TOKEN` | 首次启动自动生成 | 见 §5 |
| `--pair-rate-limit <n>` | — | `5` | 每 IP 每分钟 `/v1/pair` 尝试上限，`0` = 关闭 |

**`--base-path` 行为**：请求路径先剥掉前缀再路由；不在前缀下的请求返回 `404 NOT_FOUND`（不要返回网关式的 502，那是误导）。
`--base-path /w2m` 时 `/w2m/healthz` 与 `/healthz` **都**应答（健康检查常被反代直接打到根），但 `/v1/*` 只在前缀下应答。

**代理头**：仅在 `--trust-proxy` 开启时读取。`X-Forwarded-Proto` 用于 `/healthz` 的 `effective_scheme` 与启动日志里的公开 URL 提示；`X-Forwarded-For` 用于限流取真实客户端 IP。

---

## 4. `GET /healthz`（扩展，用于跨区域运维）

v1 已返回 `{ok, protocol_version, rabbit_time, uptime_ms, ...stats}`。v0.1.2 追加：

| 字段 | 语义 |
|---|---|
| `relay_id` | 每次进程启动生成的随机 id。**客户端据此发现"中继重启过"** |
| `started_at` | 进程启动时刻（RFC3339） |
| `effective_scheme` | `http` 或 `https`（`--trust-proxy` 时取 `X-Forwarded-Proto`，否则取实际监听） |
| `base_path` | 生效的部署前缀 |
| `operator_token_required` | bool。跨区域部署时必须为 `true`（见 §5） |
| `pair_rate_limit` | 每 IP 每分钟上限 |
| `persistence` | `{ enabled, dir, revived_devices, revived_tasks }` |

> 用途：跨区域时你最需要回答的问题是「中继还在吗、重启过吗、我的机器还连着吗」。这三个字段让它一眼可答。

---

## 5. Operator token（**修正 #4**）

区分两种凭据，**不可混用**：

| 凭据 | 持有者 | 能做什么 |
|---|---|---|
| `device_token` | 每台机器 | 自己领任务、回结果、读设备表/任务状态 |
| `operator_token` | **只有你** | **下发任务**（`POST /v1/task`） |

**规则**：
1. 中继**总是**生成或接受一个 operator token，并写入 `<state>/operator-token.txt`（权限 0600），启动时打印一次。
2. `POST /v1/task` 需要 `Authorization: Bearer <operator_token>`：
   - 带头且等于 operator token → 放行；
   - 带的是 device_token（而不是 operator token）→ **401 `OPERATOR_REQUIRED`**，message 要说清"这是设备令牌，下发任务需要操作者令牌"；
   - 不带 → 401 `OPERATOR_REQUIRED`。
3. 其他端点仍用 device_token（不变）。
4. `--operator-token ''`（空串）显式关闭该要求，并在启动时打印**醒目警告**、`/healthz` 的 `operator_token_required` 为 `false`。这是给纯局域网/调试用的逃生舱，不是默认。

**插件侧**：`w2m_run` 必须携带 operator token；配置项新增 `operatorToken`（或读 `W2M_OPERATOR_TOKEN`）。缺失时报错要点名该配置项，**不要**退回用 device token 静默尝试。

---

## 6. `/v1/pair` 限流（**配合 #4**）

- 默认每 IP 每 60s 最多 **5** 次尝试（含失败）。
- 超限 → `429` + 错误码 **`RATE_LIMITED`**，并带 `retry_after_seconds`。
- 成功的配对**也计数**（否则可以用成功请求刷掉失败预算）。
- IP 取 `X-Forwarded-For` 首项**仅当** `--trust-proxy`；否则取 socket 地址。
- 内存实现即可（滑动窗口），无需持久化。

---

## 7. 持久化（**修正 #3**）

`<state>/` 下：

| 文件 | 形式 | 内容 |
|---|---|---|
| `devices.json` | 原子快照（写临时文件 + rename） | `{machine_id → {machine_name, platform, caps, user_id, device_token, paired_at, re_paired}}` |
| `ledger.jsonl` | append-only，每行一个 JSON | 任务创建、结果入库、租约状态变更 |
| `operator-token.txt` | 单行文本，0600 | operator token |

**启动恢复**：读 `devices.json` 重建设备表与 token 索引；重放 `ledger.jsonl` 重建任务、租约、去重键。
**写入时机**：设备变化立即快照；账本事件同步 append（`fs.appendFileSync` 足够，量小）。
**损坏处理**：某行 JSON 解析失败 → **跳过该行并计入 `warnings`**，不要让中继启动失败；`devices.json` 损坏 → 从空表启动并在启动日志与 `/healthz` 里**明确报告**，不要静默清空。
**禁用**：`--state ''` 或 `--no-persist` → 纯内存（v1 行为），`/healthz` 的 `persistence.enabled = false`。

---

## 8. 跨区域可靠性（小改动，大收益）

1. **重连抖动**：现有退避是 `[500,1000,2000,4000,8000,10000]` + 抖动。跨区域后**多台机器同时断线会同时重连**，需要抖动区间足够宽；保持现状即可，但**必须在 `notice` 里暴露"我正在重连，第 N 次"**，否则远程排障只能靠猜。
2. **RTT 可见**：agent 每次心跳记录到中继的往返时间，滚动保存最近 5 次到 `state.rttMs`，并在信封的 `platform` 旁**不新增字段**，而是通过 `w2m_status` 工具暴露。跨区域时"延迟多少"是第一个要问的问题。
3. **中继重启检测**：SSE 首帧的 `ready` 带上 `relay_id`；agent 发现 `relay_id` 变化 → 记 `warn` 日志并清空本地 seq 游标（旧 seq 在新进程里无意义）。
4. **重放窗口**：`notice/REPLAY_TRUNCATED` 已存在；v0.1.2 起该事件必须带 `oldest_available_seq`，让客户端知道该从哪重新对齐，而不是只知道"补不上了"。
5. **SSE 抗缓冲**：响应头显式带 `X-Accel-Buffering: no` 与 `Cache-Control: no-cache, no-transform`，防止 nginx 类反代把事件流缓冲住（这是隧道部署最常见的"能连上但收不到事件"）。

---

## 9. 版本

- 包版本 → **0.1.2**（`package.json`）。
- `PROTOCOL_VERSION` **保持 1**：以上全部是**向后兼容的追加**（新端点字段、新错误码、新配置项）。
  - 唯一的行为变更：`POST /v1/task` 在**配置了 operator token 时**需要它 —— 这是安全修复，会在 CHANGELOG 的 Breaking 区注明，并给出关闭方法。
- v1 客户端（0.0.1）连 v0.1.2 中继：能配对、能领任务、能回结果，但**无法下发任务**（缺 operator token）。这是有意的。

---

## 10. 本版不做（明确边界）

- ❌ 不做 WebSocket 传输（SSE 在三种部署形态下都够用，换传输是大改动）
- ❌ 不做端到端加密（形态 A 由 WireGuard 负责；形态 B/C 由 TLS 负责）
- ❌ 不做多中继联邦 / 跨中继转发（多区域只支持「各自的机器连同一个中继」）
- ❌ 不做中继高可用（单点；账本可重建，设备表可快照）
- ❌ 不做 mTLS 客户端证书（配对码 + 双 token 已覆盖威胁模型）
