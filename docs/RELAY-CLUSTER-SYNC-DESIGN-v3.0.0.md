# Relay v3.0.0 — 三节点数据同步设计

- 状态：**实现与本地验证完成；线上部署待用户确认（未部署）**
- 目标版本：Relay **3.0.0**（基于插件 v3.3.15 的 relay 代码）
- 适用线上：主 43.142.74.71、Tencent 106.53.197.47、Vultr 202.182.123.154（当前均 2.1.5，无跨节点同步）
- 关联文档：`docs/MULTI-RELAY.md`（active-passive 链路与 relay 看门狗）、`docs/DEPLOY.md`、`docs/adr/0001-collaboration-crdt.md`

---

## 1. 问题与目标

### 1.1 现状

三台 relay 各自独立：设备注册、任务账本、项目房间互不相通。客户端通过主/备链路连接不同 relay，
但一台 relay 重启后，它上面的设备/任务/房间状态**只能从本机 `--state` 目录恢复**，其他两台无法补齐；
把客户端切到 standby relay 时，standby 看不到主 relay 上的任务与设备。

### 1.2 目标（本版本）

1. **数据同步**：三台 relay 每 **1 小时**互相同步一次（可配置）；
2. **重启后随机延迟同步**：进程重启后 **60–600 秒随机**触发第一次同步，避免三台同时同步；
3. **在线保证**：滚动重启流程保证任意时刻至少 2 台（实际要求 ≥1 台）在线，客户端可继续工作；
4. 对插件 **v3.3.15** 完全兼容：不改变既有协议/路由语义，只新增能力与 `healthz` 字段；
5. 安全：同步通道加密 + 认证，**不在任何日志里记录同步内容**；不触碰数据面红线（blobs 不同步）。

### 1.3 非目标（本版本不做）

- 不做实时强一致（不引入 Raft/Paxos/CRDT；沿用 ADR-0001 的结论）；
- 不做 blobs（数据面）同步 —— 红线：数据面不经 relay；
- 不做 operator token / relay signing secret 的同步（每台 relay 的权威凭据保持独立）；
- 不做 fleet chat / fleet memory / admission / remote-frame 等**当前仅内存态**数据的持久化与同步
  （它们本身不在 `--state` 中，重启即丢；若要做，另立 Phase 2/3）；
  - **更新（2026-11-17）**：fleet chat 的持久化与跨 relay 复制已在 Relay Phase 2 落地，见独立 ADR
    `docs/RELAY-CLUSTER-SYNC-PHASE2-DESIGN.md`；fleet memory / admission / remote-frame 仍未做。
- 不保证“同步后立即一致”：最长延迟 = 同步周期（默认 1h）+ 传输/重试时间。

---

## 2. 同步范围（v1）

### 2.1 纳入同步（durable state）

| 域 | 现状存储 | 同步单位 | 合并规则 |
|---|---|---|---|
| 设备注册表 | `<state>/devices.json` | 每设备一条 | 按 `machine_id` 合并；以 `re_paired`、`paired_at_ms` 较新者为准；补全缺失的 `device_token`/`fleet_id`/`caps` |
| 任务账本 | `<state>/ledger.jsonl` | 每条 ledger entry | 按 `(origin_node_id, offset)` 去重；按 `ts` 排序回放；同一 `task_id` 的 `task.created` 冲突时保留最早一条并记 conflict |
| 操作员公钥 | ledger 中的 `operator.key.registered` | —— | **排除**（每台 relay 的权威不同，不跨节点复制） |

说明：`devices.json` 含 `device_token`（明文）——这是 standby relay 能认证同一设备所必需；
因此同步通道必须加密（见 §4），且同步落盘文件 0600。

### 2.2 明确排除

- `blobs/`、`index.json`、`latest.json`：数据面红线，且体积不可控；
- fleet messages / fleet memory / admission / pairing codes / roles / readMarks / remote frames：仅内存态；
- 心跳、SSE 连接、lease `online` 标志、RTT：易变状态，不同步（由各 relay 自己观测）；
- operator token、`--signing-secret`、cluster secret：凭据不同步。

> 这样做的代价：重启后任务最多可能丢最近 1 小时（同步周期）内的增量——在同步周期内 relay 进程仍在线，
> 数据在本机 ledger 中；只有在**未同步前就宕机**时才会丢。这与“每小时一次”的设计目标一致。

### 2.3 Phase 2（后续可选项，不在本次实现）

- 项目房间（projects snapshot）：需要把 project events 增加 `origin_node_id` 并做事件级合并；
- 若希望 chat/memory 跨 relay 可见：先给它们加持久化，再纳入同步（单独 ADR）。

> **Phase 2 后续状态（2026-11-17）**：上述两项已在 Relay Phase 2 落地，独立 ADR 见
> `docs/RELAY-CLUSTER-SYNC-PHASE2-DESIGN.md`，滚动升级手册见 `docs/RUNBOOK-RELAY-ROLLING-UPGRADE.md`。
> 实现与原设想的差异以 ADR 为准：项目域同步的是**整项目快照**（事件仍以内容 hash 去重合并），没有给
> project events 增加 `origin_node_id` 字段；chat 与 fleet memory 的边界也不同——chat 已做，memory 仍未做。

---

## 3. 协议设计

### 3.1 拓扑与调度

```
            ┌────────────── 每小时/随机首同步 ──────────────┐
            ▼                                              ▼
   relay A (node-a) ──── pull snapshot ───► relay B (node-b) ───► relay C (node-c)
      ▲  每个节点都按同样的规则 pull 其他节点（三向全mesh，非主从）
      └────────────────────────────────────────────────────────┘
```

- **稳定节点 ID**：`--node-id` / `W2M_RELAY_NODE_ID`；缺省用 `<state>` 目录内
  `cluster-node.json` 的持久值（首次启动生成 `node-<8hex>`），**不能使用 relay_id**（relay_id 每次进程重启变化）。
- **拉模型（pull-only）**：每个节点按自己的调度拉取所有 peer 的增量；无需 receiver 的“push”。
  三台互为 peer，任意两台之间都直接拉，因此数据不会经过第三台中转。
- **单飞**：任一时刻每节点只允许一个同步任务在跑；上一轮未结束则跳过本轮并记录 skipped 计数。

### 3.2 调度规则

```
启动后：                 delay = uniform(60s, 600s)  → 第一次同步（要求 3）
之后每轮：               every 3600s ± jitter(0..300s)  → 下一次同步（要求 2）
失败重试：               同一 peer 失败 → 30s / 2m / 10m 退避，最多 3 次，下轮再试
关闭条件：               cluster 未配置 或 secret 无效 → 不启动（healthz 显示 disabled）
```

- 首次随机延迟也适用于进程被 watchdog 自动重启的场景；
- 环境变量（测试/运维可覆盖）：
  `W2M_RELAY_SYNC_INTERVAL_MS`（默认 3600000）、
  `W2M_RELAY_SYNC_BOOT_MIN_MS`（默认 60000）、`W2M_RELAY_SYNC_BOOT_MAX_MS`（默认 600000）、
  `W2M_RELAY_SYNC_JITTER_MS`（默认 300000）。

### 3.3 同步接口（仅 cluster 认证可访问）

```
GET  /v1/cluster/ping
     → 200 {ok:true,node_id,relay_version,features}          （健康探测，不返回数据）

GET  /v1/cluster/snapshot?since=<cursor>
     请求头：
       x-w2m-cluster-peer:   <本节点 node-id>                （明文，用于选择 key）
       x-w2m-cluster-ts:     <unix ms>
       x-w2m-cluster-nonce:  <16B base64url>
       x-w2m-cluster-auth:   base64(HMAC-SHA256(secret, "GET\n/v1/cluster/snapshot\n<ts>\n<nonce>\n<since>"))
     响应体：加密信封（base64）：
       { v:1, node_id, relay_version, cursor:{...}, chunk:{index,total}, last:bool,
         docs:{ devices:[...], ledger:[{origin,offset,ts,entry}], next_since:<cursor> } }
```

- **游标**：每 peer 独立持久化到 `<state>/cluster/cursors.json`：
  `{ "<peer-node-id>": { ledger_offset:<bytes>, devices_version:<n>, last_ok_at_ms, last_error } }`；
  首次同步 from 0（全量增量），之后从游标继续。
- **分块**：单次响应 ≤ 2 MiB（可配），超出则 `chunk.index/total` 分块；客户端循环拉取直到 `last:true`。
- **幂等**：同一 `(origin,offset)` 重复拉取不会重复应用；`devices` 合并是幂等的 LWW。
- **不可用 peer**：返回/超时只影响该 peer 游标，其它 peer 继续；不阻塞其他同步。

### 3.4 加密与认证

- 前置共享密钥 `W2M_RELAY_CLUSTER_SECRET`（32 字节 base64，三台一致；不进仓库）。
- 请求认证：
  `auth = HMAC-SHA256(secret, "GET\n/path\n<ts>\n<nonce>\n<since>")`；
  服务端要求 `|now-ts| ≤ 120s`，nonce 10 分钟内不重复，`timingSafeEqual` 比较。
- 响应加密：AES-256-GCM，key = HKDF-SHA256(secret, salt="w2m-cluster-sync", info=node ids)；
  AAD = `"w2m-cluster-v1|<node_id>|<ts>|<nonce>"`；密文 base64 放入 `enc` 字段。
  → 即使 relay 之间走公网 HTTP，同步内容（含 device_token）对链路上不可见。
- 可选 `W2M_RELAY_CLUSTER_ALLOW_IPS`（CIDR 列表）：在认证之外再加来源限制。
- 限流：cluster 路由单独限速（例如 30 次/分钟/node），不占用普通客户端配额。
- 审计：**不记录内容**；只在 healthz 记录 `peer/last_ok/last_error/cursors/imported counts`。

### 3.5 合并实现（服务端）

```js
// 新增 src/relay/cluster-sync.mjs（仅此模块做同步的 IO 与调度）
createClusterSync({ state, persistence, config, now, logger })
  .status()                 // 给 /healthz
  .start() / .stop()        // 定时器（首次随机 60–600s）
  .tick()                   // 单次：拉取所有 peer → 合并（测试可直接调用）
  .handleHttp(req,res)      // GET /v1/cluster/{ping,snapshot}
```

- 每轮流程：`for peer: GET snapshot(since=cursor) → decrypt → verify → mergeDocuments(docs) → 推进 cursor`。
- `mergeDocuments`：
  - `devices` → `state.mergeClusterDevices(list)`：LWW 更新内存 devices/tokens，成功后
    `persistence.saveDevices(state.devices)` 落盘；
  - `ledger` → `state.applyClusterLedger(list)`：对既有 task/result 只补缺、不覆盖；
    成功后追加到 `<state>/cluster-ledger.jsonl`（0600）以便重启后重放。
- **启动恢复**：`state.restore()` 之后，把 `cluster-ledger.jsonl` 与本地 `ledger.jsonl` 合并去重后一起回放
  （在 `restore` 的 `ledger` 参数层面实现；不改变现有调用方签名）。
- **冲突**：同 `task_id` 的 `task.created` 有差异时保留 `created_at_ms` 最早者，
  计数器 `cluster.conflicts++`，healthz 暴露（不打印任务内容）。
- **存储新增文件**（全部 0600，目录 0700）：
  `cluster-node.json`（node id）、`cluster/cursors.json`、`cluster-ledger.jsonl`、`cluster/last-sync.json`。

---

## 4. 安全边界

1. 只同步 §2.1 列出的 durable 数据；**blobs 与聊天/内存数据永不同步**；
2. 同步通道 AEAD + HMAC 认证 + 时间窗 + nonce 防重放；任一校验失败 → 401/403 且**不应用任何数据**；
3. cluster secret 只存在于各 relay 的 systemd drop-in（0600），不写入仓库、不打印、不进日志；
4. `devices.json`/`cluster-ledger.jsonl` 含 device token，落盘 0600 + 目录 0700；日志只记计数；
5. cluster 路由与普通客户端路由隔离：只接受 cluster 认证头，不接受 device/operator token；
6. 不做跨 fleet：同步内容按整台 relay 复制，relay 的 `--fleet` 绑定由各 relay 自己决定；若两 relay 的
   fleet 配置不同，合并时保留各自 fleet 记录（跨 fleet 可见性由现有 fleet 隔离规则约束，不因同步放宽）。

---

## 5. 滚动重启与“始终在线”

### 5.1 目标

任意时刻至少 **1 台 relay 可服务**（设计上要求 2/3 保持健康再动第 3 台），且客户端能按
`docs/MULTI-RELAY.md` 的 active-passive 规则自动切换。

### 5.2 滚动重启脚本（新增 `deploy/relay/rolling-restart.sh`）

```
for node in B, C, A:                         # 先备后主，最后主
  1. 确认另外两台 healthz.ok=true（否则 abort）
  2. systemctl stop w2m-rabbit; 备份 state 目录（可选）
  3. 部署新代码（tar 覆盖 bin/ src/ package.json），启动
  4. 等待 healthz.ok=true 且 relay_version=3.0.0
  5. 等待 cluster 首同步（最多 W2M_RELAY_SYNC_BOOT_MAX_MS + 5min）成功或超时记录
  6. 确认至少 2 台健康后，再处理下一台
```

- 重启后的随机 60–600s 首同步保证三台不会同一秒拉取；
- watchdog（`deploy/relay/w2m-watchdog.timer`）在部署期间不要停用，用于兜底；
- 客户端侧不需要改配置：active-passive 链路会路由到健康 relay。

### 5.3 运维验收

```
curl /healthz | jq '{relay_version, features, cluster}'
features 必须含 relay-cluster-sync-v1
cluster: {enabled:true, node_id, peers:[{id,last_ok_at,last_error}], last_sync_at, next_sync_at}
```

---

## 6. 版本与兼容性

- relay 版本：部署时设置 `W2M_RELAY_VERSION=3.0.0`（`server.mjs` 已支持该环境变量），
  因此 `/healthz.relay_version = "3.0.0"`；包版本仍随插件发布（3.3.15）不冲突。
- `RELAY_FEATURES` 新增 `relay-cluster-sync-v1`（仅当 cluster 配置启用时暴露）。
- 插件 v3.3.15 完全兼容：现有路由/字段只增不改；`relay-capabilities` 读到新 feature 会忽略未知项。
- 未配置 cluster 的 relay 行为与 2.1.5 完全一致（feature 不出现）。
- 回滚：停新进程 → 恢复旧 tar + 旧 systemd env → 启动；`cluster-*` 文件可保留（旧代码不读）。

---

## 7. 测试与验证计划

### 7.1 单元测试（`test/cluster-sync.test.mjs` 等）

1. 信封加解密、HMAC 认证、时间窗、nonce 重放、篡改拒绝；
2. devices 合并 LWW（新 paired、re_paired、fleet 绑定、token 补全）；
3. ledger 去重（同 origin/offset 两次）、task/result 补缺不覆盖、conflict 计数；
4. 调度器：首同步落在 [60s,600s]、周期 3600s、jitter 范围、单飞、skip 计数；
5. cursor 持久化/恢复、坏 cursor 自愈；
6. 分块（>2MiB）与跨 chunk 幂等。

### 7.2 三进程集成测试（本地）

启动 3 个 `w2m-rabbit` 进程（不同端口/state、同一 cluster secret、互为 peer，
`W2M_RELAY_SYNC_INTERVAL_MS=1000` 便于测试）：

1. A 配对设备 → 等同步 → B/C `/v1/devices` 能看到该设备；
2. A 创建任务并完成 → B/C `/v1/tasks` 能看到；
3. 重启 A → 首同步延迟窗口内不丢 B/C 数据，A 恢复后补齐；
4. 一台 peer 宕机 → 同步不阻塞、恢复后自动追平；
5. 错误 secret / 非 cluster token → 401，无数据写入；
6. 三台同时启动 → 首同步时间分散（随机性断言，允许固定 seed 的测试钩子）。

### 7.3 上线前验证（用户确认后）

1. 本地 3 进程 e2e 全绿；
2. 线上先在**一台**（Vultr，流量最小）部署 3.0.0、开启 cluster（peer 指向另外两台 2.1.5 会失败——
   需先把三台都升级；因此线上验证按滚动顺序：先升级但暂不启用 cluster，最后统一启用）；
3. `healthz.relay_version=3.0.0`、`features` 含新 feature；
4. 三台各配一台测试设备的跨 relay 可见性验证；
5. 观察 24h：同步成功、无 5xx、状态目录大小增长可控，再宣布完成。

---

## 8. 部署方案（确认后执行）

```bash
# 0. 本地生成 cluster secret（只生成一次，三台同一值，0600 保存）
openssl rand -base64 32 > cluster-secret.txt

# 1. 每台 relay：备份
systemctl stop w2m-rabbit
cp -a /opt/w2m/app /opt/w2m/app.bak-v3.0.0-$(date +%Y%m%d%H%M%S)

# 2. 覆盖 bin/ src/ package.json（3.3.15 relay 代码）
# 3. systemd drop-in：/etc/systemd/system/w2m-rabbit.service.d/cluster.conf
[Service]
Environment=W2M_RELAY_VERSION=3.0.0
Environment=W2M_RELAY_NODE_ID=node-cn-primary     # 三台不同
Environment=W2M_RELAY_PEERS=[{"id":"node-tencent","url":"http://106.53.197.47:8787"},...]
Environment=W2M_RELAY_CLUSTER_SECRET=<base64>
# 4. rolling-restart：B → C → A（见 §5.2）
# 5. 验收：healthz + 三台设备/任务可见性 + 24h 观察
```

回滚：`systemctl stop` → 恢复 `/opt/w2m/app.bak-v3.0.0-*` → 移除 cluster drop-in → 启动 → 验证
`relay_version` 回到 2.1.5、`features` 无新项。

---

## 9. 待确认决策（请用户确认后再进入开发）

| # | 决策 | 推荐 | 影响 |
|---|---|---|---|
| 1 | v1 同步范围 | **devices + task ledger**（project rooms 留 Phase 2；messages/memory 不同步） | 决定工作量与风险；范围越大越慢 |
| 2 | device_token 是否随同步复制（加密传输） | **是**（否则 standby 无法认证同一设备） | 安全评审点 |
| 3 | cluster 传输与密钥 | **HMAC + AES-GCM，前置共享 secret（systemd env）** | 也可改为只允许 WireGuard/tailnet |
| 4 | 重启首同步随机窗口 | **60–600s**（符合需求 3） | 可调 |

确认后执行顺序：**开发 → 单元测试 → 三进程集成测试 → 本地验证报告 → 用户确认 → 线上部署**。

---

## 10. 实现状态（2026-11-15，本地开发完成，未部署）

### 10.1 决策确认

用户已确认按 §9 的推荐默认值执行（v1 范围 = devices + task ledger；device_token 加密同步；
HMAC + AES-256-GCM 共享 secret；重启首同步 60–600s 随机）。

### 10.2 代码落点

| 文件 | 变更 |
|---|---|
| `src/relay/cluster-sync.mjs` | **新增**：配置校验、HMAC 请求认证、AES-256-GCM 信封、拉取调度（首同步 60–600s，之后 1h±5min）、游标、设备/账本合并、`/v1/cluster/ping` 与 `/v1/cluster/snapshot` 处理 |
| `src/relay/persistence.mjs` | 新增 cluster 状态文件（`cluster-node.json`、`cluster/cursors.json`、`cluster/ledger.jsonl`、`cluster/last-sync.json`）与 `readLedgerSlice()`（按字节偏移、不消费半行） |
| `src/relay/state.mjs` | 新增 `mergeClusterDevices()`（LWW，保留本机 presence）与 `applyClusterLedger()`（`origin@offset` 幂等回放；拒绝 operator key） |
| `src/relay/server.mjs` | 构造时启动 cluster、恢复时重放导入账本、`/v1/cluster/*` 路由（先于 device/operator 认证）、`healthz.features` 条件追加 `relay-cluster-sync-v1`、`healthz.cluster` 诊断、`listen` 启动调度、`close` 停止、`attachCluster()`（测试用延迟绑定） |
| `bin/w2m-rabbit.mjs` | `--cluster-peers/--cluster-secret/--cluster-node-id/--cluster-sync-ms` 与 `W2M_RELAY_*` env；非法配置 fail-fast；启动 banner 与 `--json` 输出 cluster 状态（不含 secret） |
| `test/cluster-sync.test.mjs` | 新增 16 项单元测试 |
| `test/cluster-sync-integration.test.mjs` | 新增 2 项三 relay 真实 HTTP 集成测试 |
| `package.json` | 新增 `test:cluster-sync` / `test:cluster-sync:integration` |
| `deploy/relay/` | 新增滚动重启脚本与 cluster drop-in 示例（见 `docs/RELAY-V3.0.0-DEPLOY-RUNBOOK.md`） |

### 10.3 与设计的偏差（均为收紧，不是放宽）

1. `operator.key.registered` **不导入**：设计 §2.1 已列为排除项，实现中在导入与落盘两处都拒绝；
2. cluster 诊断（`healthz.cluster`）只暴露 node id / peer id+url / 游标 / 计数 / 时间，不含 secret 与 payload；
3. 未启用 cluster 时 `/healthz.features` 与 2.1.5 完全一致（现有 209 项 relay/health 测试保持全绿）；
4. `attachCluster()` 仅为测试（三台 OS 随机端口先监听、后建立 peer 关系）而增加，生产仍走启动配置。

### 10.4 本地验证结果（详见 `docs/RELAY-CLUSTER-SYNC-V3.0.0-VERIFICATION.md`）

```
单元测试            test/cluster-sync.test.mjs            16/16 pass
三 relay 集成测试   test/cluster-sync-integration.test.mjs 2/2 pass
回归：relay/health  test/relay.test.mjs + health.test.mjs 209/209 pass
回归：能力声明      test/relay-health-capabilities.test.mjs 5/5 pass
lint               eslint（变更文件）                     0 errors
CLI smoke          healthz: version=3.3.15, features 含 relay-cluster-sync-v1,
                   cluster.enabled=true, node_id/peers 正确；未签名 cluster 路由 401
```

### 10.5 部署前剩余步骤（需用户确认）

1. 生成并分发三台共用的 cluster secret（systemd drop-in，0600，不进仓库）；
2. 按 `docs/RELAY-V3.0.0-DEPLOY-RUNBOOK.md` 执行 B→C→A 滚动部署（每台：备份 → 停 → 覆盖代码 → 加 drop-in → 启 → healthz/首同步门禁）；
3. 验收 `relay_version=3.0.0`、`features` 含 `relay-cluster-sync-v1`、三台设备/任务互相可见；
4. 观察 24h（同步失败计数、状态目录增长、无 5xx）后再宣布完成。

