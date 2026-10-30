# 联合开发 & 编队协作测试用例 v2.0.8

图例：✅ 已执行通过；⚠️ 部分通过/有限证据；🚫 被环境阻断；⬜ 计划未执行。
配套计划：[TEST-PLAN-JOINT-FLEET-2.0.8.md](TEST-PLAN-JOINT-FLEET-2.0.8.md)

## A. 联合开发（JD）

| ID | 级别 | 前置 | 步骤 | 预期 | 状态 / 证据 |
|---|---|---|---|---|---|
| JD-01 | P0 | CLI/stateDir | `w2m-joint plan` 创建 2 步计划 | 返回 plan_sha256；可 list/get；命令哈希稳定 | ✅ 既有 evidence（joint plan 92e299aa…） |
| JD-02 | P0 | 无签名审批 | `--allow-unsigned-approval` 派发 | 拒绝 `UNKNOWN_FLAG`，无 POST | ✅ joint-cli |
| JD-03 | P0 | operator key | 审批后派发一次 | relay 收到 1 次；审计 sending→sent；审批被消费 | ✅ 真实 relay 2.0.5 |
| JD-04 | P0 | 已消费审批 | 重放同一审批 | `APPROVAL_ALREADY_USED`，0 次 POST | ✅ joint-cli |
| JD-05 | P0 | 伪造/过期审批 | 篡改签名或超 TTL | `APPROVAL_SIGNATURE_INVALID` / `APPROVAL_EXPIRED` | ✅ plan-store/operator-key |
| JD-06 | 🛡 | 审批字段 | 改 plan_sha / base / target | 拒绝，绑定字段不符 | ✅ merge-approval；JOINT-R5 |
| JD-07 | P0 | DSH 在线 | 计划含 DSH/ToFuture 两步，派发 | 两步均 done；progress=complete | ⚠️ 曾 s1 done/s2 refused（allowlist）；需复测 |
| JD-08 | P0 | 已合并 | rollback ref 恢复 | 目标回旧 head；审批不可复用 | ⬜ 现场演练 |
| JD-09 | P1 | 合并冲突 | 3-way/CAS 冲突 | 具名冲突，不静默覆盖 | ✅ merge-engine 套件 |

## B. 编队协作（FC）

| ID | 级别 | 前置 | 步骤 | 预期 | 状态 / 证据 |
|---|---|---|---|---|---|
| FC-01 | P0 | relay 在线 | `w2m_devices` | 只返回本编队设备，口径含 online/offline_reason | ✅ ToFuture/DSH/macmini 004945 |
| FC-02 | P0 | 两机 | 派发 `node --version`（assignee） | verdict=consistent；签名=signed | ✅ 任务 01M64TEK…（ToFuture） |
| FC-03 | P0 | 两机 | 不指定 assignee 派发 | **测试纪律禁止**；应显式目标 | ✅ TD-01 已固化 |
| FC-04 | P0 | 一机离线 | 派发到离线机 | lease expired → partial，不伪造 ok | ✅ 任务 01M64TR…（DSH expired） |
| FC-05 | P1 | 两机在线 | 编队聊天收发 | 双方可读，密文 v2 门控生效 | ✅ 既有 chess 会话 |
| FC-06 | P1 | composer | 选择目标机后派发 | 仅选中机收到任务 | ⚠️ 需 UI 现场复核 |
| FC-07 | P0 | 设备 token | `fleet_id` 为空 | 不显示“已加入”，返回 FLEET_UNBOUND | ✅ fleet-binding 单测 4/4 |
| FC-08 | P0 | 同机双 agent | 同时起两份 localside | 必须拒绝/二选一，避免版本跳变 | ⬜ 需负例演练 |
| FC-09 | P1 | 结果回传 | P2P 结果 ACK 超时 | 回退 relay 并显式记录 | ✅ P2P_ACK_TIMEOUT 可见 |

## C. 编队绑定与版本（FB）

| ID | 级别 | 前置 | 步骤 | 预期 | 状态 / 证据 |
|---|---|---|---|---|---|
| FB-01 | P0 | token 有效 | 读取自身设备记录 | `fleet_id` 非空 → state=bound | ✅ ToFuture fleet_id=004945 |
| FB-02 | P0 | token 有效 + fleet_id=null | 启动 agent | `FLEET_UNBOUND`；有 fleetKey 时自动 re-admission | ✅ 单测 + 真实修复 |
| FB-03 | P0 | 错 relay 的 token | 启动 | 401 → 重新配对，不静默 | ✅ 实测 202.182→43.142 |
| FB-04 | P0 | 无 fleetKey | 启动 | 返回可执行 remedy，不显示已加入 | ✅ fleet-binding 单测 |
| FB-05 | P0 | 配置 2.0.8 | `w2m_status.fleet` | 含 fleet_id/state/code/token_present/remedy | ✅ 宿主 2.0.8 输出 |
| FB-06 | P0 | 三机同名 | 读 relay caps | 版本稳定，无 2.0.7/2.0.8 跳变 | ⚠️ macmini 仍 2.0.7 |
| FB-07 | P1 | 备用链路 | 起 secondary-link | 不得覆盖主 device.json / 不得抢编队 | ✅ 已禁用 keeper |
| FB-08 | P1 | 计划任务 | 禁用 standby keeper 后重启 | 本机不再出现 ToFuture-standby | ✅ 已禁用 |

## D. P2P 加密握手（PH）

| ID | 级别 | 前置 | 步骤 | 预期 | 状态 / 证据 |
|---|---|---|---|---|---|
| PH-01 | P0 | Electron 宿主 | 探测 chacha | 原生缺失时 fallback 可用 | ✅ 宿主 native=false，caps 6/6 |
| PH-02 | P0 | JS/原生双端 | AEAD 交叉验证 | 密文逐字节一致、双向可解、篡改拒绝 | ✅ 52/52 |
| PH-03 | P0 | 非本机目标 | 派发一次任务 | 两端 handshakes≥1、encrypted≥1、refused=0 | ⚠️ 2026-10-30 复测 task 01M64WBW…：`Unknown cipher` 消失，但 `P2P_FRAGMENT_UNACKED` + `P2P_CHANNEL_CLOSED`；DSH 仍 `COMMAND_NOT_ALLOWED`；handshakes 仍 0 |
| PH-04 | P0 | 本机自派 | 向 ToFuture 派发 | 明文是设计行为，不作握手证据 | ✅ 已确认 NO_KEY/PLAINTEXT_PEER |
| PH-05 | P1 | 旧版对端 | 2.0.7 对 2.0.8 | 明确错误/拒绝，不静默降级 | ⬜ 需 macmini 升级前后对比 |
| PH-06 | P1 | stateDir 缺失 | 结果回传 | `P2P_NO_STATE_DIR` 可见，回退 relay | ✅ 任务 01M64TE… envelope 证据 |

## E. 文件 E2E（XF）

| ID | 级别 | 前置 | 步骤 | 预期 | 状态 / 证据 |
|---|---|---|---|---|---|
| XF-01 | P0 | 本地 | 分块 + bitmap + 逐块校验 | 乱序/续传/篡改/穿越均拒绝 | ✅ xfer-foundation/ferry 12/12 |
| XF-02 | P0 | relay 在线 | publishRef → listPublishedRefs | 同 rootCid 可读回，控制面无字节 | ✅ 真实 relay 2.0.5 |
| XF-03 | P0 | 单机 | sender/receiver 双进程 loopback | rootCid/落盘 SHA 一致 | ✅ 262144B verified=true |
| XF-04 | P0 | 单机 | `--peer` 候选地址探测 | 选中候选（192.168.56.1），verified=true | ✅ 131072B，artifact.ready=true |
| XF-05 | P0 | 两机 | 跨机 sender/receiver | 对端落盘一致，relay 零字节 | 🚫 DSH 离线；macmini allowlist |
| XF-06 | P0 | 传输中断 | kill 接收端再重启 | bitmap 续传，根哈希最终一致 | ⬜ 计划 |
| XF-07 | 🛡 | 路径穿越 | destination=`../x` | 拒绝（safeRelative） | ✅ ferry 单测 |
| XF-08 | P0 | 完成 | artifact.ready | relay 决策可见，仅元数据 | ✅ 实测 artifact_ready_published=true |

## F. 发布门禁（RG）

| ID | 级别 | 步骤 | 预期 | 状态 / 证据 |
|---|---|---|---|---|
| RG-01 | P0 | commit | 目标分支含 v2.0.8 | ✅ `0ecedb4c…b526d7` |
| RG-02 | P0 | tag | `v2.0.8` 指向同一 commit | ✅ |
| RG-03 | P0 | GitHub Release | 200，正文含变更/回滚 | ✅ |
| RG-04 | P0 | npm | 2.0.8=latest，shasum 一致 | ✅ `adf91572…` |
| RG-05 | P0 | CI | success | ✅ |
| RG-06 | P0 | Compat | success | ✅ 双 run |
| RG-07 | P0 | Release workflow | success | ✅ |
| RG-08 | P0 | healthz | relay 在线且 features 符合 | ✅ 2.0.5 + chat-enc-v2 |
| RG-09 | P0 | preflight | GREEN，0 fail | ✅ 3267 tests / 3246 pass / 21 skip |

## G. 安全负例（SEC）

| ID | 级别 | 步骤 | 预期 | 状态 |
|---|---|---|---|---|
| SEC-01 | 🛡 | 伪造审批签名 | 拒绝，无派发 | ✅ |
| SEC-02 | 🛡 | 重放审批 | 拒绝 | ✅ |
| SEC-03 | 🛡 | 空 allowlist 派发 | agent 拒绝，具名 COMMAND_NOT_ALLOWED | ✅ macmini/旧 ToFuture |
| SEC-04 | 🛡 | token 写入文档/技能 | 扫描拒绝 | ✅ skills/preflight |
| SEC-05 | 🛡 | relay 存文件字节 | 拒绝 DATA_PLANE_REFUSED | ✅ |
| SEC-06 | 🛡 | 明文聊天镜像 | 无 feature 时保持 v1 | ✅ chat-crypto-aad |

## H. 混合版本治理（MV）

| ID | 级别 | 步骤 | 预期 | 状态 |
|---|---|---|---|---|
| MV-01 | P0 | 统计 26 台名册 | 区分 bound/unknown/old，不用 state 字段 | ✅ 26 台 / 20 台 null / ~20 编队 |
| MV-02 | P0 | 三机统一 2.0.8 | 三机 caps=2.0.8 | ⚠️ ToFuture/DSH 2.0.8，macmini 2.0.7 |
| MV-03 | P0 | 版本门 | 混合期 warn，不 enforce | ✅ 默认 warn |
| MV-04 | P1 | 发布后 10 分钟 | devices_unbound=0 | ⬜ 需监控指标上线 |

## I. 测试纪律（TD）

| ID | 要求 | 状态 |
|---|---|---|
| TD-01 | 派发必须显式 assignee/target_machines | ✅ 已固化 |
| TD-02 | 禁止裸 replicate 全 fleet | ✅ 本轮 23 台泛洪已取消并记录 |
| TD-03 | 无 assignee 负例仅隔离环境且立即取消 | ✅ |
| TD-04 | plugin_version=null 只观测，不纳入验收 | ✅ |
| TD-05 | 未实跑项标 PLANNED/BLOCKED，不写成通过 | ✅ 本文档执行 |

## 当前汇总

- P0 已通过：JD 1–6、FC 1/2/4/7、FB 1–5、PH 1/2/4、XF 1–4/7/8、RG 1–9、SEC 1–6；
- 阻断：PH-03、XF-05（DSH 离线 / macmini allowlist）；
- 待补：JD-07 复测、JD-08 回滚、FC-08 双实例、XF-06 续传、MV-02 三机统一。
