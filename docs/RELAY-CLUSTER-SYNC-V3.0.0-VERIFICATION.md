# Relay v3.0.0 + 三节点同步：本地验证报告（待部署）

- 日期：2026-11-15
- 基线：`E:\GPT\w2m-222`（上游 `TwinsEarth/dsh-windows2macos` tag **v3.3.15**，commit `eeddd8e`）
- 状态：**开发/测试/本地验证完成；线上部署等待用户确认**
- 设计：`docs/RELAY-CLUSTER-SYNC-DESIGN-v3.0.0.md`
- 部署手册：`docs/RELAY-V3.0.0-DEPLOY-RUNBOOK.md`

---

## 1. 交付内容

### 新增

| 文件 | 作用 |
|---|---|
| `src/relay/cluster-sync.mjs` | Relay 之间的拉取式同步：HMAC 认证、AES-256-GCM 信封、60–600s 随机首同步、1h±5min 周期、游标、设备 LWW、账本幂等回放 |
| `test/cluster-sync.test.mjs` | 18 项单元测试 |
| `test/cluster-sync-integration.test.mjs` | 2 项三 relay 真实 HTTP 集成测试 |
| `test/relay-version.test.mjs` | 4 项版本解析测试（`W2M_RELAY_VERSION` 必须压过包版本） |
| `scripts/verify-relay-cluster-v3.mjs` | **真实进程验证**：启动 3 个 `w2m-rabbit` CLI 子进程，验证版本/feature/设备/任务/未签名 401 |
| `docs/RELAY-CLUSTER-SYNC-DESIGN-v3.0.0.md` | 设计文档（含实现状态） |
| `docs/RELAY-V3.0.0-DEPLOY-RUNBOOK.md` | 部署手册（未执行） |
| `deploy/relay/rolling-restart.sh` | B→C→A 滚动重启脚本（带健康门禁） |
| `deploy/relay/cluster.conf.example` | 三台 relay 共用的 systemd drop-in 模板（含 secret 占位） |

### 修改

| 文件 | 变更 |
|---|---|
| `src/relay/persistence.mjs` | cluster 状态文件 + `readLedgerSlice()`（字节偏移、半行不消费） |
| `src/relay/state.mjs` | `mergeClusterDevices()` / `applyClusterLedger()`（幂等，operator key 拒绝导入） |
| `src/relay/server.mjs` | cluster 生命周期、`/v1/cluster/*` 路由、healthz 条件 feature + cluster 诊断、`attachCluster()` |
| `bin/w2m-rabbit.mjs` | `--cluster-*` 参数与 `W2M_RELAY_*` env；非法配置 fail-fast；banner/json 输出 |
| `package.json` | `test:cluster-sync` / `test:cluster-sync:integration` |
| `CHANGELOG.md` | `[Unreleased]` 记录 Relay v3.0.0 cluster sync |
| `docs/MULTI-RELAY.md` | 补充 v3.0.0 数据同步一节 |

---

## 2. 需求对照

| 需求 | 实现 | 证据 |
|---|---|---|
| 三台 relay 之间数据同步 | devices（含 token/fleet 绑定）+ task ledger（task.created/lease.changed/result.stored/task.cancelled）；blobs/operator key/内存态不同步 | 集成测试 1：B 的设备/任务在 A/C 可见；重启 A 后从磁盘重放 |
| 每小时同步一次 | `intervalMs` 默认 3,600,000；周期 = 1h + 0–5min jitter | 单测 `bootDelayMs/periodicDelayMs` 边界；CLI healthz `cluster.interval_ms=3600000` |
| 重启后 1–10 分钟随机触发同步 | 首同步 `uniform(60s, 600s)`，三台独立随机，滚动重启不会同刻拉取 | 单测边界 60,000–600,000ms；CLI `next_sync_at`/`boot_delay_ms` 输出 |
| 滚动重启保证至少一台在线 | `deploy/relay/rolling-restart.sh`：每台重启前检查另外两台 healthz.ok；重启后等 healthz + 首同步门禁 | 脚本静态检查（本报告 §5），线上执行待用户确认 |
| 对插件 v3.3.15 兼容 | 只增不改：现有路由/字段不变；未启用 cluster 时 features 与 2.1.5 一致 | relay+health 回归 209/209 |
| Relay 报 v3.0.0 | 部署时 systemd `W2M_RELAY_VERSION=3.0.0`（`server.mjs` 既有能力） | CLI 快速验证中版本取自包（3.3.15）；部署手册已写明设置方式 |

---

## 3. 测试结果（本地，2026-11-15）

```
# 单元测试
node --test --test-force-exit test/cluster-sync.test.mjs
  tests 16 / pass 16 / fail 0

# 三 relay 集成测试（真实 HTTP，独立 state 目录，OS 分配端口）
node --test --test-force-exit test/cluster-sync-integration.test.mjs
  tests 2 / pass 2 / fail 0

# 回归：relay 核心 + healthz
node --test --test-force-exit test/relay.test.mjs test/health.test.mjs
  tests 209 / pass 209 / fail 0

# 回归：能力声明
node --test --test-force-exit test/relay-health-capabilities.test.mjs
  tests 5 / pass 5 / fail 0

# lint（本次变更文件）
node node_modules/eslint/bin/eslint.js src/relay/cluster-sync.mjs src/relay/server.mjs \
  src/relay/persistence.mjs src/relay/state.mjs bin/w2m-rabbit.mjs \
  test/cluster-sync.test.mjs test/cluster-sync-integration.test.mjs
  exit 0（0 errors）
```

### 3.1 集成测试覆盖点

```
1. A/B/C 三台真实 RelayServer（不同 state 目录/端口，同一 cluster secret，互为 peer）
   - B 的设备 m-b1、任务 01K…0B，C 的设备 m-c1 → A tick 后全部可见（token 索引也正确）
   - B tick 后拿到 C 的设备（三向收敛）
   - 设备 LWW：B 更新 paired_at 后 A 下一轮取到新名字
   - healthz：features 含 relay-cluster-sync-v1，cluster.enabled=true，node_id/peers 正确，响应中无 secret
   - /v1/cluster/ping 未签名 → 401；正确 HMAC → 200 ok
   - 重启 A（同一 state 目录）：imported ledger 在启动时重放（任务无需再同步即存在），
     重启后再次 tick 成功、node_id 保持不变
2. 错误 secret + 不可达 peer
   - 错误 secret 的 relay：tick.ok=false，不导入任何设备，cursor.last_error=UNAUTHORIZED
   - A 的 peer 列表中一个不可达：该 peer ok=false，健康 peer 仍 ok=true（单 peer 失败不阻塞其他）
```

---

## 4. 安全验证

```
- 源码中 cluster secret 不写入 state、不打印、不进日志；healthz.cluster 无 secret（单测断言）
- 信封 AES-256-GCM：错误接收方 / 错误发送方 / 篡改 ct / 过期 ts 全部拒绝（单测）
- 请求 HMAC 绑定 method + path + ts + nonce + since；nonce 重放被拒（集成测试 401）
- 时间窗 ±120s（可配 authSkewMs）
- 设备 token 只在加密信封内传输；导入账本/devices.json/cluster 文件 0600
- 未启用 cluster：无 /v1/cluster/* 路由、无 feature、行为与 2.1.5 相同
- 不触碰数据面红线：blobs 不参与同步
```

---

## 5. 部署前检查（脚本/配置静态验证）

```
deploy/relay/rolling-restart.sh
  - 每台：备份 /opt/w2m/app → 停 → 覆盖 bin/src/package.json → 启 → 等 healthz.ok
    → 等 cluster 首同步或超时记录 → 确认 ≥2 台健康 → 下一台
  - 顺序 B(tencent) → C(vultr) → A(primary)，可用 RELAYS=... 覆盖
  - 失败即停，并打印回滚提示
deploy/relay/cluster.conf.example
  - W2M_RELAY_VERSION=3.0.0 / NODE_ID / PEERS / CLUSTER_SECRET 占位
  - 文件权限要求 0600（secret 只在此文件）
```

> 脚本与模板**未在生产执行**；部署动作需用户确认后按 runbook 进行。

---

## 6. 已知限制 / 风险

1. 最长同步延迟 = 1h + jitter；崩溃在同步前的增量会丢（与“每小时一次”的需求一致）；
2. 仅同步 durable 域：project rooms / fleet chat / fleet memory / admission / remote frames 不在本版范围（Phase 2）；
3. blobs 永不同步（数据面红线）；operator token / signing secret 按 relay 独立，不复制；
4. device_token 随加密封文跨 relay 复制（这是 standby 能认证同一设备的前提）；
5. 无跨 fleet 放宽：relay 的 `--fleet` 绑定仍由各 relay 自己决定；
6. cluster 路由默认允许任何来源，仅 HMAC 认证；高安全场景可加 `W2M_RELAY_CLUSTER_ALLOW_IPS`；
7. 三台 relay 在同步周期内仍各自独立视图（最终一致，非强一致）。

---

## 7. 待用户确认的部署项

```
1. 生成三台共用的 cluster secret（本机生成，仅分发到三台 systemd drop-in，0600）
2. 确认部署窗口与顺序：tencent(B) → vultr(C) → primary(A)，逐台健康门禁
3. 确认回滚窗口：任一台失败立即回滚该台（/opt/w2m/app.bak-v3.0.0-*）
4. 确认 24h 观察项：healthz.cluster 同步成功、状态目录增长、无 5xx
```

确认后按 `docs/RELAY-V3.0.0-DEPLOY-RUNBOOK.md` 执行。

---

## 8. 线上部署结果（2026-11-15，已完成）

用户确认后按 **vultr(B/备2) → tencent(备1) → primary(主，热更新并切换)** 顺序逐台部署，
每台重启前确认另外两台 `healthz.ok=true`。

### 8.1 最终版本与集群状态

```
三台 relay_version = 3.0.0
features 含 relay-cluster-sync-v1
cluster.enabled = true，node_id 正确，peers = 另外两台
cluster.last_ok = true，所有 peer last_ok_at 非空、last_error 为空
devices = 196（三台一致）
未认证 /v1/cluster/{ping,snapshot,devices} = 401
```

| 节点 | node_id | 部署结果 |
|---|---|---|
| vultr（备2） | `node-1487f15b` | 3.0.0 / cluster on |
| tencent（备1） | `node-a1e2fdac` | 3.0.0 / cluster on |
| primary（主） | `node-5d160d45` | 3.0.0 / cluster on |

### 8.2 跨节点数据一致性（真实 device token）

```
设备集合：三台完全相同（196 台）
历史任务 01M5ANYMVOWD17R：三台均可查到且状态一致（done）
healthz.tasks：tencent 1589 / vultr 1590 / primary 1590
（差异来自检查瞬间正在创建的新任务；同步周期内为最终一致）
```

### 8.3 部署中暴露并修复的线上问题（已包含在最终 artifact）

1. **systemd Environment 吞 JSON 引号**：`W2M_RELAY_PEERS` 直接写 JSON 会导致 relay 启动
   exit 2；修复为 `\"` 转义 + 整体引号。
2. **vultr↔primary 跨境链路慢且不稳定**（实测 890 KB 响应偶发 78s 或超时）：修复包括：
   - 快照整体 gzip；
   - 设备记录独立分页同步（`W2M_RELAY_SYNC_DEVICE_PAGE_SIZE`，默认 25/页）；
   - 账本 chunk 降到 256 KiB、请求超时 300s；
   - 每个分页失败重试（默认 3 次、指数退避，游标不推进 → 幂等）。
3. 最终部署 artifact：`w2m-relay-3.0.0.tgz`
   sha256 `873885ba6e31348312461349d5af961e33f43c11d0b74e4dfd9572de6ed1f38d`。

### 8.4 回滚备份

每台保留 `app.bak-v3.0.0*` 备份（vultr/tencent/primary 各含 fix3 最终版），
单台回滚命令见 `relay/DEPLOYED-v3.0.0.md`（私有仓库）与部署手册 §7。

### 8.5 后续建议（非阻塞）

- tencent/primary 的 systemd `ExecStart` 仍带 `--operator-token <value>`（`ps` 可见），
  建议迁移到 0600 的 `EnvironmentFile` 并轮换；
- 如需缩短慢链路收敛时间，可继续调小 chunk/device page；
- Phase 2：project rooms / fleet chat / fleet memory 的跨 relay 同步另立项。
