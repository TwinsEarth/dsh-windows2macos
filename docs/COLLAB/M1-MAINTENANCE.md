# M1 运维通道（v1.3.2-beta）设计规格

> 状态：**设计稿**。本文只定义"怎么做、边界在哪、如何验收"，不含实现。
> 上游：`docs/MULTI-MACHINE-COLLABORATION-PLAN.md` 的 M1。
> 版本：`1.3.2-beta.*`（beta 默认走 GitHub prerelease，不入 npm）。

---

## 1. 目标与非目标

### 目标（本版本必须做到）

1. **远程升级**：操作员不登录机器，即可把编队里任意一台机器上的本项目插件 / relay / agent 升级到指定版本，并完成重启。
2. **远程重启**：按固定顺序重启本项目的 systemd 单元（Linux）或服务（Windows），不依赖 SSH。
3. **远程诊断**：收集一组**预先定死**的只读诊断信息（版本、服务状态、日志尾部、磁盘、端口），结果回传 relay。
4. **无需生前 allow-list**：目标机器即使 allow-list 为空，也能完成上述操作（这是本版本存在的理由）。
5. **可审计**：每次请求有签名、有发起者、有 hash、有结果，落在 relay 事件日志与机器本地日志里，事后可追。

### 非目标（明确不做，避免范围蔓延）

- 不做任意命令执行（那是 M2 的"任务级授权"领域）。
- 不做文件下发/上传（诊断结果走既有 blob 通道，不新增文件传输语义）。
- 不接管 DSH 自身的安装/升级（只处理**本插件**及其 relay/agent 服务；DSH 本体升级属于另一条线）。
- 不实现 Windows 之外的平台（含 macOS）在 1.3.2 的范围；Windows 用"计划任务 + 队列目录"的等价设计，macOS 放 1.3.3 之后（见 §10）。

---

## 2. 拓扑与信任边界

```
操作员（控制端 DSH 插件）
  │  1. 签名 maintenance request（operator 私钥）
  ▼
relay（可信传输，但不可信为授权方）
  │  2. 作为普通 task 的附件下发（maintenance_request 字段），或本地投放
  ▼
机器上的 agent（非特权用户，如 w2m）
  │  3. 只做一件事：把已验证形状的 request 写成文件放进队列目录
  ▼
队列目录 /var/lib/w2m/maintenance/queue（root 可写，agent 只可写文件、不可执行）
  │  4. root/SYSTEM 权限的独立单元（path unit 或 timer）轮询
  ▼
维护执行器（固定 action：update / restart / diag）
  │  5. 验签 → 校验 action 参数 → 执行 → 写结果
  ▼
结果目录 /var/lib/w2m/maintenance/done
  │  6. agent 读取结果 → 作为 task 结果回报 relay
```

**信任边界**：

| 主体 | 能做什么 | 不能做什么 |
|---|---|---|
| 操作员私钥 | 签发 maintenance request | 不直接接触目标机 shell |
| relay | 转发、存 hash、记账 | 不能伪造 request（无操作员私钥）；不能改 action 参数（hash 绑定） |
| agent（w2m 用户） | 写 request 文件、读 done 文件 | 不能执行维护动作、不能改 root 单元、不能提权 |
| root 维护单元 | 执行白名单 action、验证签名 | 不解释用户输入、不跑任意 shell/脚本、不接受路径穿越 |
| 其他编队成员 | 看到任务/结果 | 无法代签、无法重放 |

---

## 3. 请求协议（Request Envelope）

### 3.1 文件格式

请求文件为 UTF-8 JSON，**单行、≤ 64 KiB**，文件名 `<unix_ms>-<request_id>.json`：

```json
{
  "protocol": "w2m-maintenance/v1",
  "request_id": "01M6...26 字符 ULID",
  "action": "update",
  "params": {
    "target": "plugin",
    "version": "1.3.2-beta.1",
    "artifact_sha256": "64 hex",
    "artifact_urls": ["https://registry.npmjs.org/...tgz", "https://github.com/.../....tgz"],
    "restart_after_update": true
  },
  "machine_id": "目标机器 machine_id（必须完全匹配）",
  "nonce": "16-64 字符随机串",
  "issued_at": "2026-10-21T13:00:00Z",
  "expires_at": "2026-10-21T13:10:00Z",
  "issued_by": "operator 名（仅审计展示，不参与授权）",
  "signature": {
    "alg": "ed25519",
    "key_id": "operator 公钥指纹前 16 hex",
    "value_base64": "签名值"
  }
}
```

### 3.2 签名覆盖范围

签名对象是**规范化 JSON**（键按字典序、无空白、UTF-8），覆盖除 `signature` 外的所有字段：

```
canonical = JSON.stringify(sortKeys({protocol, request_id, action, params, machine_id, nonce, issued_at, expires_at, issued_by}))
```

规则：

- 校验方**重新规范化**，不信任文件里的字段顺序。
- `action` 与 `params` 都在签名内 → relay 或传输层改不了动作与参数。
- `machine_id` 在签名内 → 请求不能换机重放。
- `expires_at` 在签名内 → 操作员给的时限不可延长。

### 3.3 校验顺序（fail-closed，任何一步失败都拒绝并写结果）

```
1. 文件大小/形状/协议版本
2. 签名验证（操作员公钥，key_id 找公钥；未知 key_id 拒绝）
3. machine_id 与本地一致
4. nonce 未使用（本地已执行记录 + 结果目录去重；跨重启保留）
5. request_id 未执行过（幂等）
6. 时间：issued_at ≤ now ≤ expires_at，且 expires_at - issued_at ≤ 10 分钟
7. action ∈ {update, restart, diag}，params 按 action 白名单逐字段校验
8. exec 前再次检查 artifact sha256 与 action 约束（TOCTOU 防护）
```

---

## 4. 动作规格（Action Semantics）

### 4.1 `update`

参数：`target ∈ {plugin, relay, agent}`、`version`、`artifact_sha256`、`artifact_urls[]`（最多 3 个，按顺序尝试）、`restart_after_update`。

步骤（全部固定、无 shell 拼接）：

1. 下载 artifact 到临时文件（仅 https；每个 URL 超时 60s；总大小上限 200 MiB）。
2. 计算 sha256，必须与参数完全一致，否则删文件并失败（`UPDATE_HASH_MISMATCH`）。
3. **当前版本备份**：目录软链/时间戳副本（`/opt/w2m/app.old`），保留最近 1 份。
4. 解包到 staging 目录，校验包内 `package.json.version === version`（防"hash 对但版本错"）。
5. 原子换入（rename），保留旧树。
6. 如 `restart_after_update=true` → 执行 restart 动作（同一套固定流程）。
7. **健康检查**：本机服务 `is-active` + relay `/healthz` 200 + 版本回报；失败则**自动回滚**到旧树并重启，结果中标记 `rolled_back: true`。
8. 写结果文件（成功/失败/回滚、耗时、版本、sha）。

### 4.2 `restart`

参数：`targets ∈ {rabbit, agent, all}`、`wait_healthy`（默认 true）。

固定顺序（Linux）：

```
rabbit（relay）→ 等待 /healthz 200（≤60s）
agent（localside）→ 等待心跳上报（≤120s，经 relay 可观测）
stun 可选 → 等待端口监听
```

禁止：重启任意其他单元；禁止 `systemctl restart` 参数拼接。

### 4.3 `diag`

固定只读清单（输出上限每项 32 KiB，总计 ≤ 256 KiB）：

- `version`：插件/relay/agent 的 package.json 版本、安装路径、文件 mtime
- `services`：各单元 `is-active`、`MainPID`、最近一次启动时间
- `journal`：每个单元最近 100 行（截断）
- `disk`：`df -h` 关键路径
- `ports`：本机监听中与 w2m 相关的端口
- `allowlist`：当前 allow-list（只报告，不改动）
- `relay`：本地缓存的 relay 可达性/healthz 摘要

结果作为文本 + JSON 写入结果目录，agent 以 blob 回报（超过内联阈值自动走 blob 通道）。

---

## 5. 执行单元（Privileged Runner）

### 5.1 Linux（systemd）

两个文件，安装时由 deploy 脚本放置：

```
/etc/systemd/system/w2m-maintenance.path     → 监听 queue 目录
/etc/systemd/system/w2m-maintenance.service  → 执行 runner（Type=oneshot）
```

约束：

- `User=root`（或专用 `w2m-maint` 用户 + 指定 capability），`NoNewPrivileges=yes` 仍可（不 exec shell）。
- `ProtectSystem=strict` + `ReadWritePaths=/opt/w2m /var/lib/w2m/maintenance`；`ProtectHome=yes`；`PrivateTmp=yes`；`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`；`SystemCallFilter` 白名单按需收紧。
- runner 只调用内部 JS 模块的固定函数（`update/restart/diag`），**不 exec 用户输入**；health check 用内置 HTTP client。
- 同一时刻只执行一个请求：`ExecCondition`/flock 串行化；执行期间 path unit 继续触发会被排队（目录里多个文件按 mtime 顺序处理）。

### 5.2 Windows（计划任务）

- 一个以 `SYSTEM` 运行的计划任务（或 Windows 服务），每分钟轮询 `%ProgramData%\w2m\maintenance\queue`。
- 同样的 JSON 协议；动作实现用 Node（包内固定模块）；服务控制用 SCM API（不调用外部 shell）。
- 结果写 `done` 目录；agent 读结果回报。

### 5.3 目录权限

| 路径 | 属主 | 权限 |
|---|---|---|
| `queue/` | root | 0770 root:w2m（agent 可写文件，不可删/改他人文件） |
| `done/` | root | 0750 root:w2m |
| `state/`（已执行 nonce/request_id） | root | 0700 |

agent 写请求时使用 `O_CREAT|O_EXCL`，文件名含 request_id，避免覆盖；结果由 runner 以 root 写。

---

## 6. 与 relay / agent 的集成（本版本的最小改动）

1. **agent**：收到 task 时若存在合法形状的 `maintenance_request` 字段（大小、JSON、协议版本），不走 allow-list，而是：
   - 写入 queue 目录；
   - 轮询 done 目录（≤120s）；
   - 把结果文件作为 task 结果回报（status ok/failed，附结果 blob）。
2. **relay**：透传 `maintenance_request` 字段（限 64 KiB），把 request_id 与 hash 写入 ledger（`maintenance.request` 事件）；不解释内容。
3. **插件工具**（控制端）：新增一个调用入口（名字在实现时确定）负责：生成 request → 签名 → 随 task 派发 → 等待结果；**不新增任意命令能力**。
4. **兼容性**：旧 relay 直接丢弃未知任务字段（不报错）→ 新控制端对旧 relay 返回明确错误 `MAINTENANCE_UNSUPPORTED_RELAY`，不静默失败。

> 说明：本版本操作员签名的验证在**目标机 root runner** 内完成；agent 只搬文件。这样即使 agent 被攻破，也无法伪造维护动作。

---

## 7. 状态机与幂等

```
pending → claimed（runner 读取并加锁） → executing → done | failed | rolled_back
```

- `request_id` 幂等：done 目录已存在同名结果 → 直接返回既有结果，不重复执行。
- 重放：nonce + request_id 同时进入本地已执行集合（`state/`，跨重启保留），重复请求返回 `MAINTENANCE_REPLAY`。
- 超时：executing 超过 15 分钟由 runner 自终止并写 `failed`（`MAINTENANCE_TIMEOUT`）。
- 崩溃恢复：启动时扫描 `claimed/` 下的残留文件，转为 `failed` 并记录。

---

## 8. 验收（本版本必须用真实任务触发）

### 8.1 功能验收（真实机器）

1. **空 allow-list 机器升级**：在一台 allow-list 为空的机器（验收对象：TwinsEarth / jp-shared）上，操作员签一次 `update` 请求 → 目标机完成插件升级 → 重启 → 版本回报 `1.3.2-beta.x`。全程不需要 SSH。
2. **relay 升级**：同样流程升级 relay 主机（验收对象：jp-shared），relay_id 变化、uptime 归零、`/healthz` 200、任务状态从持久化恢复。
3. **重启**：对 agent/relay 分别发 `restart`，验证固定顺序与健康等待。
4. **诊断**：发 `diag`，结果包含版本/服务/日志/磁盘，并作为 blob 可读取。
5. **审计**：ledger 中有 `maintenance.request`（request_id、hash、机器、结果状态），与机器本地日志一致。

### 8.2 负向验收（必须自动化，进单测/集成测试）

```
· 未签名 / 签名错误 / 未知 key_id → 拒绝
· 过期 / 未来 issued_at / TTL>10min → 拒绝
· machine_id 不匹配 → 拒绝
· 重放同一 request_id / nonce → 拒绝
· action 不在白名单 → 拒绝
· update: sha 不符 / 包内版本不符 / URL 非 https → 拒绝，不落盘执行
· restart: 目标越界（如 sshd）→ 拒绝
· diag: 输出超限 → 截断并标记
· relay 透传被篡改 params → 签名不符 → 拒绝
· agent 伪造 request 文件（无签名）→ 拒绝
· 执行失败 → 回滚成功且结果标记 rolled_back
```

### 8.3 兼容与回归

- 旧版 agent + 新版 relay：不崩溃，返回 `MAINTENANCE_UNSUPPORTED_AGENT`。
- 新版 agent + 旧版 relay：任务里无字段，行为与 v1.3.1 一致。
- 无 DSH / 无 relay 的纯本地路径：手工把请求文件放入 queue 也能执行（验收脚本模拟）。

---

## 9. 失败模式与回滚

| 失败 | 处置 |
|---|---|
| 下载失败/超时 | 重试下一个 URL（≤3），全失败 → failed，不改动现有安装 |
| sha 不符 | 删除临时文件，failed（不换树） |
| 换树后健康检查失败 | 自动回滚到 app.old + 重启，结果 `rolled_back` |
| 重启后 agent 不心跳 | relay 侧任务超时；控制端可再发一次 restart（幂等） |
| 请求文件损坏 | runner 拒绝并写 failed，不执行 |
| 队列目录被清空 | 本地 `state/` 仍能防重放；结果目录丢失只影响审计展示，不影响执行 |
| 操作员私钥泄露 | 轮换 operator key；旧 key_id 进撤销列表（request 校验时拒绝） |

---

## 10. 开放问题（实现前需要确认）

1. **操作员签名密钥的形态**：复用现有 operator token 派生 Ed25519？还是引入独立的 operator key（推荐，职责分离）？密钥存 DSH 配置还是系统 keychain？
2. **Windows 优先级**：1.3.2-beta 是否先只做 Linux（TwinsEarth 是 Windows，需要确认它是否必须在本版本覆盖）？若必须，Windows runner 是否用计划任务（SYSTEM）即可。
3. **macOS**：1.3.3+ 再做，还是 1.3.2 一并设计（实现可延后）？
4. **升级目标范围**：本版本只升级"本插件包"，还是也支持 relay 包（同一 tarball）与 DSH 本体？建议先只做本插件 + relay（同一包），DSH 本体单列。
5. **健康检查的判定**：relay `/healthz` 200 是否足够？是否要加"任务能派发成功"的端到端探针（更真实但更重）。

---

## 11. 交付物清单（实现阶段）

```
src/maintenance/protocol.mjs      request 形状/规范化/签名与验证（与 M2 共用）
src/maintenance/actions/update.mjs
src/maintenance/actions/restart.mjs
src/maintenance/actions/diag.mjs
src/maintenance/runner.mjs        root 侧入口，固定 action 分派 + 状态机
src/agent/agent.mjs               新增 maintenance_request 搬运与结果回报（小改动）
src/relay/state.mjs + server.mjs  字段透传 + ledger 事件（小改动）
src/plugin/tools.mjs              控制端发起入口（签名→派发→等待）
deploy/server/w2m-maintenance.path / .service（Linux）
deploy/windows/w2m-maintenance.xml（Windows 计划任务）
test/maintenance-protocol.test.mjs / test/maintenance-runner.test.mjs
test/maintenance-e2e.test.mjs（本地模拟 relay + 真 root 不可行时的降级方案）
docs/COLLAB/M1-MAINTENANCE.md（本文）
```

## 12. 版本与发布

- `1.3.2-beta.1` 起；beta 政策：GitHub prerelease，不入 npm。
- 门禁：preflight 两遍 GREEN + M1 验收任务实跑（至少 Linux 一台 + 可选 Windows 一台）。
- 向下兼容：不改变现有 task/agent 协议，只新增可选字段与新文件；旧机器不受影响。
