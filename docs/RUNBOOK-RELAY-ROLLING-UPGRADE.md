# Relay 滚动升级手册：启用 Phase 2（chat / 项目房间同步）

- 适用：三台 relay（primary / tencent / vultr）从 v3.0.0 线滚动升级到带 **Relay Phase 2** 的构建（v3.5.0 线）
- 设计/ADR：`docs/RELAY-CLUSTER-SYNC-PHASE2-DESIGN.md`
- 前序手册：`docs/RELAY-V3.0.0-DEPLOY-RUNBOOK.md`（Phase 1：devices + task ledger 的首次上线）
- 前序设计：`docs/RELAY-CLUSTER-SYNC-DESIGN-v3.0.0.md`
- 性质：**操作手册**。每一步都给了可复制的命令与通过标准；没有通过标准的地方不写"应该没问题"。
- 前置：本文的每个线上动作仍需发布审批；本文不代表已经执行。

---

## 1. 这次升级改变了什么（先读）

Phase 2 给 relay 增加**两类**跨节点数据：

1. **fleet chat 持久化 + 复制**：消息/读水位/删除 tombstone 写入 `<state>/chat/` 并周期拉取（默认 60s）；
2. **项目房间共享对象同步**：成员、事件、artifact、decision、memory、refs、locks、reviews、notifications、read marks 按整项目快照合并（默认 1h）。

对既有行为的影响，以及**不会**发生的事：

- 设备线协议 `protocol_version` **不变**；既有路由/字段语义不变；`/healthz` 只增字段；
- Phase 1 同步（devices + ledger）不变；
- 旧 relay 不会调用新路由；新 relay 对旧 peer 跳过 Phase 2 域（`unsupported:true`，不算失败）；
- 新增的 state 文件（`chat/`、`projects/`、`instance-id.json`、`cluster/domains.json`）旧代码忽略 → **回滚安全**；
- relay state **不在** `$DSH_HOME` 备份扫描范围（`docs/BACKUP-DESIGN.md` §5）→ 升级/回滚都**不要删 state 目录**。

---

## 2. 前置检查（升级前，逐项打勾）

| # | 检查 | 命令 / 证据 |
|---|---|---|
| 1 | 三台 relay 当前 `healthz.ok=true`、`cluster.last_ok=true`、Phase 1 稳定 | 见 §3.1 的三台循环命令 |
| 2 | 三台 relay 的 `W2M_RELAY_NODE_ID` 稳定且互不相同（游标以它为准） | 各自 `curl /healthz` 看 `cluster.node_id` |
| 3 | 三台共用同一 `W2M_RELAY_CLUSTER_SECRET`（32 字节 base64，只在 drop-in 里） | 不打印 secret；只确认文件存在、0600、长度正确 |
| 4 | 三台 `W2M_RELAY_PEERS` 都只列另外两台、URL 可达 | `curl /healthz` 看 `cluster.peers[]` |
| 5 | 磁盘余量：`<state>/chat/` 上限 200 MiB（默认硬上限）+ 项目对象；至少预留 1 GiB | `df -h` / `dir` |
| 6 | 升级包已构建并校验过 sha256 | `sha256sum w2m-relay-<version>.tgz`，记录到交接单 |
| 7 | 回滚备份路径已确定（每台 `/opt/w2m/app.bak-<ts>`） | 见 §6 |
| 8 | 明确本次**不**做的事：不改设备线协议、不启用 chat HTTP 删除（尚不存在）、不把 relay state 纳入备份 | 见 §7 |

> 若 cluster 尚未在线上启用（仍是 2.1.5 单机 relay），先按 `docs/RELAY-V3.0.0-DEPLOY-RUNBOOK.md` 完成 Phase 1 上线，再回到本文做 Phase 2；不要一步同时引入两层未知。

---

## 3. 滚动顺序与单台步骤

### 3.1 顺序原则

- **一次只动一台**；动之前确认另外两台健康（`ok:true`）；
- **先备节点、后主节点**：tencent → vultr → primary（与 v3.0.0 手册一致）；
- 每台升级后等 **Phase 1 cluster 首同步** 成功（`cluster.last_ok=true`、`last_sync_at` 出现）再动下一台；
- Phase 2 域**不阻塞**单台门禁：新 relay 与仍为旧版的 peer 混跑时，`domains.chat/projects` 显示 `unsupported` 是**预期**，不是故障；三台都升级后自动开始同步（feature 缓存 5 分钟内刷新，无需重启）。

> 任意升级顺序都安全（协议只增不改）；推荐顺序是为了把"旧代码 + 新代码混跑"的窗口缩短到最小。

### 3.2 单台步骤（以 tencent 为例）

```bash
ssh root@106.53.197.47
cd /opt/w2m

# 3.2.1 停机前确认另外两台健康（在任意一台执行；期望两台都 ok=true）
for h in 43.142.74.71 202.182.123.154; do
  echo "== $h"; curl -fsS "http://$h:8787/healthz" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('ok=',j.ok,'version=',j.relay_version,'cluster=',j.cluster&&j.cluster.last_ok)})"
done

# 3.2.2 备份 + 停服务
ts=$(date +%Y%m%dT%H%M%S)
systemctl stop w2m-rabbit
cp -a /opt/w2m/app "/opt/w2m/app.bak-${ts}"
echo "backup=/opt/w2m/app.bak-${ts}"

# 3.2.3 覆盖代码（tar 只包含 bin/ src/ package.json 等运行物；不要覆盖 <state> 目录）
tar -xzf /tmp/w2m-relay-<version>.tgz -C /opt/w2m/app

# 3.2.4（如尚未配置）确认 cluster drop-in 里 Phase 2 相关环境变量
#   默认即可启用；只有要调参/关掉某域时才加这些行（见 §4）
#   W2M_RELAY_CHAT_SYNC_MS / W2M_RELAY_CHAT_RETENTION_DAYS / W2M_RELAY_CHAT_HARD_CAP_BYTES
#   W2M_RELAY_PROJECTS_SYNC_MS / W2M_RELAY_CHAT_SYNC=0 / W2M_RELAY_PROJECTS_SYNC=0
systemctl daemon-reload
systemctl start w2m-rabbit
```

### 3.3 每台升级后的健康门禁（必须全过再动下一台）

```bash
# 3.3.1 基础健康 + 版本 + 三个 feature（Phase 1 + 两个 Phase 2）
curl -fsS http://127.0.0.1:8787/healthz | tee /tmp/healthz.json
node -e "const j=require('/tmp/healthz.json'); console.log({
  ok:j.ok, version:j.relay_version,
  phase1:j.features.includes('relay-cluster-sync-v1'),
  chat:j.features.includes('relay-cluster-chat-v1'),
  projects:j.features.includes('relay-cluster-projects-v1'),
  domains:j.cluster && {chat:j.cluster.domains.chat.enabled, projects:j.cluster.domains.projects.enabled}
})"
# 期望：ok=true；phase1=true；chat/projects=true；domains.chat/projects.enabled=true

# 3.3.2 未签名的 peer 路由必须 401（不能被 device/operator token 绕过）
for p in /v1/cluster/ping /v1/cluster/chat /v1/cluster/projects; do
  printf '%s -> ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8787$p"
done
# 期望：三行都是 401

# 3.3.3 Phase 1 首同步（重启后 60–600s 随机；期间 last_sync_at 可能为 null）
watch -n 10 "curl -fsS http://127.0.0.1:8787/healthz | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.cluster.last_sync_at, j.cluster.last_ok, JSON.stringify(j.cluster.peers.map(p=>[p.id,p.last_ok_at,p.last_error]))) })\""
# 期望：last_sync_at 出现，last_ok=true，peer 的 last_ok_at 出现；last_error 为空

# 3.3.4 域状态（混合版本窗口内允许 unsupported，但 last_error 必须为空）
curl -fsS http://127.0.0.1:8787/healthz | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);for (const d of ['chat','projects']) console.log(d, JSON.stringify(j.cluster.domains[d].peers.map(p=>({id:p.id,unsupported:p.unsupported,last_error:p.last_error}))))})"
# 期望：旧 peer unsupported=true 且 last_error=null；新 peer unsupported=false、last_error=null

# 3.3.5 其它两台仍健康
for h in 43.142.74.71 202.182.123.154; do curl -fsS "http://$h:8787/healthz" | grep -o '"ok":true'; done
```

> 任一硬门禁（3.3.1 / 3.3.2 / 3.3.3 / 3.3.5）不过：**立刻按 §6 回滚该台**，不要继续下一台。

---

## 4. Phase 2 运行时参数（默认值即推荐值）

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `W2M_RELAY_CHAT_SYNC_MS` | `60000` | chat 拉取周期（最小 5000） |
| `W2M_RELAY_CHAT_SYNC_BOOT_MIN_MS` / `_MAX_MS` | `5000` / `60000` | 重启后 chat 首同步随机窗口 |
| `W2M_RELAY_CHAT_RETENTION_DAYS` | `7` | chat 保留天数 |
| `W2M_RELAY_CHAT_HARD_CAP_BYTES` | `209715200` | chat 日志硬上限（200 MiB） |
| `W2M_RELAY_CHAT_PAGE_BYTES` | `131072` | 单页明文字节（128 KiB） |
| `W2M_RELAY_PROJECTS_SYNC_MS` | `3600000` | 项目状态拉取周期（最小 60000） |
| `W2M_RELAY_CHAT_SYNC=0` | 未设 | 只关 chat 域，不影响 Phase 1 与项目域 |
| `W2M_RELAY_PROJECTS_SYNC=0` | 未设 | 只关项目域，不影响 Phase 1 与 chat 域 |

- 关域是**独立开关**：不需要为了关一个域而关整个 cluster；
- 调小周期只建议在验证窗口内临时使用，验证后调回默认；
- 修改 drop-in 后：`systemctl daemon-reload && systemctl restart w2m-rabbit`，然后重跑 §3.3 门禁。

---

## 5. 三台升级完成后的 Phase 2 验收

### 5.1 三台 feature/域状态一致

```bash
for h in 43.142.74.71 106.53.197.47 202.182.123.154; do
  echo "== $h"
  curl -fsS "http://$h:8787/healthz" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const d=j.cluster.domains;const bad=[];for(const n of ['chat','projects'])for(const p of d[n].peers)if(p.last_error||p.unsupported)bad.push(n+':'+p.id+':'+(p.last_error||'unsupported'));console.log(j.relay_version, j.features.filter(f=>f.startsWith('relay-cluster-')).join(','), 'cluster_last_ok='+j.cluster.last_ok, 'bad='+JSON.stringify(bad))})"
done
# 期望：三台都列出 relay-cluster-chat-v1,relay-cluster-projects-v1；cluster_last_ok=true；bad=[]
```

### 5.2 chat 跨 relay 可见（真实两跳）

```bash
# 在 primary 上用一台已配对设备的 device token 发一条消息，然后等 chat 周期（默认 60s）在另外两台读到。
# 读取端点：GET /v1/fleet/messages?session_id=<会话 id>（device 认证）
# 期望：三台对同一 session 返回同一批 message_id，顺序按 at_ms。
```

### 5.3 项目状态跨 relay 可见

```bash
# 在 primary（operator token）创建一个带成员的项目，等项目同步周期（默认 1h；验证窗口可临时调小
# W2M_RELAY_PROJECTS_SYNC_MS=60000 并重启，验证后调回），然后在 tencent/vultr 用成员 machine 的
# device token GET /v1/projects/<project_id>。
# 期望：三台返回同名项目、相同 members 与事件序列。
```

### 5.4 重启恢复（每台轮流做一次，低峰）

```bash
# 重启前记录某 session 的消息数；重启后不等待同步，直接读：
systemctl restart w2m-rabbit
sleep 5
curl -fsS http://127.0.0.1:8787/healthz | grep -o '"ok":true'
# 期望：重启后健康；同一 session 的历史仍在（chat 从 <state>/chat/ 装载，不依赖 peer 重拉）；
#       项目对象同样仍在（<state>/projects/objects.json）。
```

### 5.5 可选的脚本化证据（发布前留证，不进 npm 门禁）

```bash
# 三节点真实进程验证（3 个 w2m-rabbit 子进程 + 真实 HTTP cluster 路由，5 项断言）
node scripts/verify-relay-cluster-phase2.mjs

# 混合版本 + 滚动升级验证（需要 Relay 3.0.0 归档；4 项断言，含 unsupported 跳过与单向升级）
W2M_RELAY_OLD_TGZ=/path/to/w2m-relay-3.0.0.tgz node scripts/verify-relay-cluster-mixed.mjs
```

> 这两个脚本在本机/构建机上跑（会自己开进程与端口），**不在线上三台执行**。
>
> 2026-11-17 构建机基线：`verify-relay-cluster-phase2.mjs` **9/9 PASS**；
> `verify-relay-cluster-mixed.mjs`（默认 Relay 3.0.0 归档）**6/6 PASS**，含混合版本跳过与滚动升级后 chat 收敛。
> 这两个数字是构建机的记录，线上三台仍按 §5.1–§5.4 复核。

---

## 6. 回滚（单台）

```bash
systemctl stop w2m-rabbit
rm -rf /opt/w2m/app
mv /opt/w2m/app.bak-<ts> /opt/w2m/app          # 用 §3.2.2 记录的备份路径
systemctl daemon-reload
systemctl start w2m-rabbit
curl -fsS http://127.0.0.1:8787/healthz | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.ok,j.relay_version,j.features)})"
# 期望：ok=true；版本回到升级前；features 不含 relay-cluster-chat-v1 / relay-cluster-projects-v1
```

- **不要删除 state 目录**：旧代码忽略 Phase 2 新文件，回滚后 Phase 1 数据不受影响；再次升级时 chat/项目数据继续可见；
- 回滚一台不影响另外两台：它们只是少一个 peer（Phase 1 继续；Phase 2 对该 peer 自动 `unsupported`）；
- **不要**为了"清干净"删 `<state>/chat/`、`<state>/projects/`、`<state>/cluster/domains.json`、`<state>/instance-id.json`：删 chat 日志会永久丢历史（并让 peer 的字节游标因 generation 对不上而重拉，但丢失的数据无法恢复）；删 `instance-id.json` 会让同一批历史记录换一个 origin，peer 上表现为重复历史。

---

## 7. 禁止事项（明确写出来，避免"顺手试试"）

1. **不要**改 `W2M_RELAY_NODE_ID`（换 id = 换游标身份；peer 会把你看成新节点，重复/错位拉取）；
2. **不要**在两台 relay 之间复制 state 目录，或让两个进程同时写一个 state 目录；
3. **不要**删/改 `<state>/chat/replication.jsonl` 手工内容（它 append-only；要压缩走 `prune` 路径，runbook 不提供手改日志的步骤）；
4. **不要**把 relay 的 `--state` 目录当成"已备份"：它不在 `$DSH_HOME` 备份扫描范围（`docs/BACKUP-DESIGN.md` §5）；
5. **不要**对外宣称"跨 relay 聊天删除可用"：数据层 tombstone 已闭环，但**设备面 HTTP 删除路由不存在**（ADR §5.4）；
6. **不要**在没有 cluster secret / peers 配置的 relay 上期待 Phase 2：域不会挂载，路由 404；
7. **不要**在混合版本窗口内因为 `domains.*.peers[].unsupported=true` 而回滚——那是设计预期的跳过；只有 `last_error` 非空或 Phase 1 门禁失败才回滚；
8. **不要**在这次升级里顺手 bump 包版本或改设备线协议/`PROTOCOL.md`：Phase 2 的兼容契约是 feature bits，版本号由发布流程统一处理。

---

## 8. 观察项（升级后 24h）

| # | 观察 | 期望 / 判据 |
|---|---|---|
| 1 | 三台 `cluster.last_ok=true`，`last_error` 不长期停留 `UNAUTHORIZED`/`TIMEOUT` | 偶发失败下一轮自愈；持续失败查 secret/网络 |
| 2 | `cluster.domains.chat.peers[].offset` 单调递增（Generation 变化时归零后重新增长） | 不长期为 0、不倒退 |
| 3 | `<state>/chat/replication.jsonl` 大小 | 受 7 天保留 + 200 MiB 硬上限约束；增长异常查 `W2M_RELAY_CHAT_RETENTION_DAYS`/硬上限配置 |
| 4 | `journalctl -u w2m-rabbit` | 无 5xx、无 chat prune/append 失败刷屏；单次失败允许但不应持续 |
| 5 | 客户端 | 聊天/项目页读取正常；无新错误码（本次无设备面协议变化） |
| 6 | `healthz.domains` 的 `last_changed`/`last_conflicts`（项目域） | 稳定后 `last_changed` 应降到 0 附近；`last_conflicts` 持续增长要查合并冲突来源 |

---

## 9. 完成标准（交接单逐项打勾）

- [ ] 三台 `relay_version` 为升级目标版本，`features` 含 `relay-cluster-sync-v1` + `relay-cluster-chat-v1` + `relay-cluster-projects-v1`
- [ ] 三台 `cluster.last_ok=true`，两个 peer 的 Phase 1 `last_ok_at` 出现、`last_error` 为空
- [ ] 三台 Phase 2 域 `enabled=true`；peer 的 `unsupported` 全为 `false`、`last_error` 全为 `null`
- [ ] 至少一次 chat 跨 relay 可见（§5.2）与一次项目跨 relay 可见（§5.3）
- [ ] 至少一台做了重启恢复验证（§5.4）
- [ ] 24h 观察项（§8）无异常；回滚备份路径、tar sha256、升级时间记录进交接单
- [ ] 明确记录：本次未启用 chat HTTP 删除（不存在该路由）；relay state 不在备份范围

---

## 附录 A：快速对照表（出问题时先看这里）

| 现象 | 最可能原因 | 处理 |
|---|---|---|
| `features` 里没有两个 Phase 2 feature | cluster 未启用 / 域被 `=0` 关掉 / 用了不含 Phase 2 的构建 | 查 drop-in 与 `W2M_RELAY_CHAT_SYNC`/`W2M_RELAY_PROJECTS_SYNC`；确认部署物来自本次构建 |
| `/v1/cluster/chat` 返回 404 | 该 relay 未启用 cluster（或旧版本） | 预期行为；升级并配置 cluster 后出现 |
| 域 `unsupported=true` | peer 是旧版本（Phase 2 前） | 预期；三台都升级后 5 分钟内自动消失 |
| 域 `last_error=UNAUTHORIZED` | cluster secret 不一致 / node id 不在 peers 列表 | 核对 secret（不打印内容）与 peers 配置 |
| chat 跨 relay 看不到新消息 | 周期未到（默认 60s）/ 本机域被关 / 消息只写在本机日志 | 等一个周期；查 `domains.chat.peers[].offset` 是否推进 |
| 重启后 chat 历史不见了 | 用了不同的 `--state` 目录（例如新目录） | 恢复原 state 路径；不要用新目录重启 |
| 项目页状态不一致 | 项目同步周期默认 1h；或合并冲突 | 等周期；查 `domains.projects` 的 `last_changed`/`last_conflicts` |
