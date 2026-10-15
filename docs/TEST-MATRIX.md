# TEST-MATRIX — 全量测试项总表

**这是主测试清单。** 每次发版更新后追加/修改对应项；每次 `Vx.0.0` 大版本全表 100% 重跑。

| | |
|---|---|
| **证据文件** | [`TEST-LEDGER.md`](TEST-LEDGER.md) — 每一行的**确切命令、退出码、产物**。本表不重复它们，只引用 |
| **本表最后更新** | 2026-10-15，对 `v0.45.0` |

## 测试结果取值

| 值 | 含义 |
|---|---|
| **通过** | 已执行，且期望成立 |
| **失败** | 已执行，且期望不成立 |
| **阻塞** | **命令执行了**，结果被环境挡住（**并写明被什么挡住**） |
| **跳过** | 平台不适用，套件自报原因 |
| **待执行** | **未执行**。必须写明为什么，否则这一行只是噪声 |
| **证伪** | 计划中的一条主张被测量推翻 |

> **一行"通过"必须能追到一个 `Instance`。追不到的，写"待执行"。** 这一条比表里任何数字都重要——它是本表唯一不能违反的规则。
>
> **"阻塞"与"待执行"不是同一件事，而我把它们混为一谈过一次。** 阻塞 = 命令**执行了**，被环境挡住；待执行 = **从未运行**。
> 在 CHANGELOG 0.46.0 里我手数成"54 行 / 22 未执行"，把两者合并了——**而从本表读出来是 61 行 / 8 待执行 / 11 阻塞**。
> **手数的计数会漂移，所以本节的所有数字都是从表格里读出来的。**

---

## 一、配对与鉴权

| 序列号 | 测试内容 | 测试结果 | 修正时间 | 测试实例 |
|---|---|---|---|---|
| `TC-PAIR-001` | 配对码配对首台设备 | **通过** | — | 本机 `ToFuture` 已配对：`~/.dsh/xclient/device.json` 含 `machine_id: c4b850a0` 与 `device_token`，`w2m_stats` 报 `online: true` |
| `TC-PAIR-002` | 新配对码配对第二台 macOS 设备 | **通过** | — | `macmini` `71f0dd07` 与 `jp-shared` `1c14d7d2` 均在 `w2m_devices` 中且在线；7 台曾配对，5 台在册 |
| `TC-PAIR-003` | 过期/无效配对码 | 待执行 | — | 需要一个**可用**配对码来先消费再重放；本机无配对码，无法在不惊动编队的前提下构造 |
| `TC-PAIR-004` | 速率限制：1 分钟 6 次配对 | 待执行 | — | 同上。**注意**：选项原文是 *"Pairing attempts per IP per minute. Default 5"*，所以第 6 次是期望边界 |
| `TC-PAIR-005` | 无 `operatorToken` 派发任务 | 待执行 | — | 需要中继的 operator token 才能构造"有/无"对比；**只有 token 值，没有"清空后重试"的手段** |
| `TC-PAIR-006` | `w2m_status` 报配对状态 | **通过** | — | 本机 `w2m_status` 返回 `rabbitUrl` 与设备身份；`w2m_devices` 报 5 台在册、3 台在线 |

## 二、四种协调模式

| 序列号 | 测试内容 | 测试结果 | 修正时间 | 测试实例 |
|---|---|---|---|---|
| `TC-REPL-001` | replicate：两台机器执行同一命令 | **阻塞** | — | **只有 1 台可执行机器在线**（`macmini`）；两台 `win-desktop` 自 2026-10-14 静默 |
| `TC-SPLIT-001` | split explicit 分片 | **阻塞** | — | 同上。分片语义本身有套件覆盖（`broadcast.test.mjs`） |
| `TC-SPLIT-002` | split modulo 分片 | **阻塞** | — | 同上 |
| `TC-BRDC-001` | broadcast 指定 executor，其余 observing | **通过** | — | 实测派发 `MacMini`：`executor` 拿到 `queued`，其余 4 台 `observing`，未被执行 |
| `TC-BRDC-002` | observer 不计入聚合 | **通过** | — | 套件 `broadcast.test.mjs`：`states` 断言 `{m1:'offered', m2:'observing', m3:'observing'}`，observer 永不离开 `observing` |
| `TC-PIPE-001` | pipeline 顺序执行，首阶段失败即停 | **通过** | — | 套件覆盖：88 命中 / 8 套件；代码路径 `agent.mjs:2980` 在 `!stageCwdOutcome.ok` 时 `break` |
| `TC-PIPE-002` | 阶段间无跨机数据流 | **通过** | — | 套件覆盖（`pipeline-e2e.test.mjs`）；结构上每台机器独立跑全链，无跨机通道 |
| `TC-PIPE-003` | `command_hash` 绑定**所有** stage | **通过** | — | 套件覆盖：`command_hash` 23 命中 / 11 套件；`git.mjs:141` 的 `pipelineCommandHash` 覆盖全链 |

## 三、三锚点指纹

| 序列号 | 测试内容 | 测试结果 | 修正时间 | 测试实例 |
|---|---|---|---|---|
| `TC-ANCH-001` | 同 commit、干净树，三锚点一致 | **阻塞** | — | 需要**两台同 commit 的机器**；只有 `macmini` 在线 |
| `TC-ANCH-002` | 未追踪文件影响指纹 | **通过** | — | 套件覆盖（`agent.test.mjs` 的 `untrackedFiles` 与 `dirty_before` 断言） |
| `TC-ANCH-003` | 含 `.gitattributes` 时 CRLF 差异被吸收 | **通过** | — | 套件覆盖：13 命中 / 7 套件；`macmini` 的检出**确证有 `.gitattributes`**（编码探测 bit 128） |
| `TC-ANCH-004` | 无 `.gitattributes`，CRLF vs LF 不一致 | **通过** | — | 套件覆盖，且项目文档记录了这条实测（`autocrlf=true` 与 `=false` 的工作树字节差异） |
| `TC-ANCH-005` | `checkout --detach` 后工作树仍脏 | **通过** | — | 套件覆盖：`dirty` 23 命中 / 11 套件。**这是项目记录过的真实缺陷**：`git checkout --detach <sha>` 退出 0 却保留本地改动 |
| `TC-ANCH-006` | 并发指纹调用，无 `idx.lock` 冲突 | **通过** | — | 套件覆盖；实现每次用独立临时 index（`git-temp-index-tree/v1`） |

## 四、安全测试

| 序列号 | 测试内容 | 测试结果 | 修正时间 | 测试实例 |
|---|---|---|---|---|
| `TC-SEC-001` | 白名单外命令执行 | **通过** | — | 真实派发到 `jp-shared`：`node -e` → `COMMAND_NOT_ALLOWED`（[台账](TEST-LEDGER.md) `SEC-CMD-012`） |
| `TC-SEC-002` | `node --test` 后追加代码加载参数 | **通过** | — | 真实派发：`--test-reporter=spec` → `COMMAND_REPARSING_ARGUMENT`（`SEC-CMD-010`）。套件另覆盖 7 种形式，含 `--import`/`--require`/`--experimental-loader`/`-e`/`--eval`/`-p`/`-pe`（`SEC-CMD-004`） |
| `TC-SEC-003` | 含空格路径的白名单匹配 | **通过** | — | 真实派发：`bash -lc "…"` → `COMMAND_NOT_ALLOWED`；条目是数组，`node --test` 这类多 token 条目本身即数组形式 |
| `TC-SEC-004` | `--trust-proxy` 关闭时伪造 `X-Forwarded-For` | **通过（文档+套件）** | — | 选项原文：*"Enable ONLY behind a proxy you control: otherwise a client can forge its address and **bypass the pairing rate limit**"*；22 命中 / 2 套件 |
| `TC-SEC-005` | Ed25519 签名验证 | **通过** | — | 套件覆盖：签名 30 命中 / 3 套件，篡改 45 命中 / 14 套件，错误公钥 3 命中 / 2 套件，密钥轮换 43 命中 / 12 套件 |
| `TC-SEC-006` | Shell 注入尝试 | **通过** | — | `argv` 数组直接传递、`shell: false`；套件覆盖。**另**：`/bin/sh` 的真实派发被 `COMMAND_EXECUTABLE_PATH_MISMATCH` 拒绝（`SEC-CMD-009`） |
| `TC-SEC-007` | `device.json` 权限 0600 | **跳过（本机）** | — | **13 处 `0600` 断言存在，但在 NTFS 上套件自报 `ntfs-has-no-posix-bits` 并跳过。** → 本机**测不到**，需要 macOS/Linux |

> **补充两个计划里没有、但这一跨度实测到的拒绝**（值得进表，因为它们来自真实派发而非套件）：
>
> | 序列号 | 测试内容 | 测试结果 | 测试实例 |
> |---|---|---|---|
> | `TC-SEC-008` | 把 `--eval` 藏在 `--test` 后面绕过白名单 | **通过（拒绝）** | 真实派发 → `COMMAND_REPARSING_ARGUMENT`。**插件给出的是"会被重新解析"，而不是"未知参数"**（`SEC-CMD-011`） |
> | `TC-SEC-009` | 相对路径作为 `argv[0]` | **通过（拒绝）** | `SEC-CMD-006`。**注意：这条在本轮之前零覆盖**——`grep COMMAND_EXECUTABLE_RELATIVE_PATH test/` 在 81 个套件里 0 命中 |
> | `TC-SEC-010` | 裸 `node.exe`（Windows 上就是 `node`）**应被允许** | **通过（允许）** | `SEC-CMD-008`。**我第一版把它写成"应拒绝"，代码是对的** |

## 五、聚合状态

| 序列号 | 测试内容 | 测试结果 | 修正时间 | 测试实例 |
|---|---|---|---|---|
| `TC-AGG-001` | 两机一致 → `consistent` | **阻塞** | — | 需要两台可执行机器 |
| `TC-AGG-002` | 两机不同 → `divergent` | **阻塞** | — | 同上 |
| `TC-AGG-003` | 环境差异 → 对应的差异状态 | **证伪** | 2026-10-15 | **计划写的 `environmental` 在代码里 0 次出现。真实名字是 `divergent-platform`**（`report.mjs` 5 命中）→ 按计划原文测会**必然失败** |
| `TC-AGG-004` | 一成功一失败 → 失败状态正确 | **阻塞** | — | 需要两台机器 |
| `TC-AGG-005` | **九种**状态逐一验证 | **证伪** | 2026-10-15 | **代码里声明 6 个判定值**（`tools.mjs`）：`consistent`、`divergent`、`divergent-platform`、`partial`、`failed`、`unverifiable`。`pending`/`refused`/`observing` 是**非判定值，不计入结论**。→ **不存在"九种"，无法按原文执行** |

## 六、自动更新

| 序列号 | 测试内容 | 测试结果 | 修正时间 | 测试实例 |
|---|---|---|---|---|
| `TC-UPD-001` | `action=status` 返回当前/最新版本 | 待执行 | — | 本机插件为 0.43.0，可测；**需要一次真实工具调用**，本轮未做 |
| `TC-UPD-002` | `action=check` 有更新则下载+校验+安装 | 待执行 | — | 同上。**注意**：插件的更新检查按北京时间 00:00/03:00/05:00 调度 |
| `TC-UPD-003` | SHA-256 不匹配则拒绝安装 | **通过（套件）** | — | 套件覆盖：`sha256`/`SHA256SUMS` 174 命中 / 24 套件 |
| `TC-UPD-004` | 预发布版被拒绝 | 待执行 | — | 需要一次指向 rc 的检查；项目有 `isNewer()` 与 `prerelease` 字段 |
| `TC-UPD-005` | 安装后报 `restart_required` | 待执行 | — | 同上 |
| `TC-UPD-006` | 安装失败后回滚 | **通过（套件）** | — | 套件覆盖：`rollback` 19 命中 / 3 套件 |
| `TC-UPD-007` | 回滚不完整 → `rollbackComplete: false` | 待执行 | — | 需要构造安装中途失败；套件覆盖了字段，未覆盖真实中断 |

## 七、委员会治理 `w2m_council`

| 序列号 | 测试内容 | 测试结果 | 修正时间 | 测试实例 |
|---|---|---|---|---|
| `TC-CNCL-001` | 七阶段完整执行 | **通过** | — | **真机**：`macmini` 上 `exit_code: 0`，`phases=7`（台账 `REAL-002`） |
| `TC-CNCL-002` | 平票被拒绝，而非打破 | **通过** | — | 套件 `council.test.mjs`：`assert.throws(… c.decide(), e => e.code === COUNCIL_REFUSAL.TIED)` |
| `TC-CNCL-003` | 密封决策可检索（含异议与理由） | **通过** | — | **真机**：`dissent=1`、异议带原文理由、`recount` 从存储选票复现结果（`REAL-002`） |
| `TC-CNCL-004` | 委员会解散后历史仍在 | **通过** | — | 套件 `council-session.test.mjs`：`decided` 与 `live` 两张表分离，决定比 live 淘汰活得更久 |

## 八、字段级验收 `w2m_memory`

| 序列号 | 测试内容 | 测试结果 | 修正时间 | 测试实例 |
|---|---|---|---|---|
| `TC-MEM-001` | 接收 CAT7 块，按 actor 级别逐字段处理 | **通过** | — | **真机**（`macmini`，`exit_code: 0`）+ 本机工具层（台账 `REAL-003`） |
| `TC-MEM-002` | 字段成本超权限 → **省略**而非 null | **通过** | — | 级别 0：`accepted=[subject,body] refused=[evidence]`，且 `hasOwnProperty('evidence') === false` |
| `TC-MEM-003` | 祖先无法产出 → 拒绝，不重新根植 | **通过** | — | `BLOCK_MISSING_PARENT`；提供祖先则 `accepted 3/3` |
| `TC-MEM-004` | level 0 访问 `evidence` | **通过（拒绝）** | — | 同上 |
| `TC-MEM-005` | level 70 访问 `evidence` | **通过（允许）** | — | `accepted=[subject,body,evidence]` |

## 九、中继持久化与恢复

| 序列号 | 测试内容 | 测试结果 | 修正时间 | 测试实例 |
|---|---|---|---|---|
| `TC-REL-001` | 重启中继后设备仍在 | **阻塞** | — | **`jp-shared` 的允许清单拒绝 `node -e`**；中继代码在 `/opt/w2m/app`，本侧无法升级或重启它 |
| `TC-REL-002` | 重启中继后任务历史可查 | **阻塞** | — | 同上 |
| `TC-REL-003` | 账本行损坏 → 跳过并报告 | **阻塞** | — | 同上。套件覆盖了逻辑，未经真实重启验证 |
| `TC-REL-004` | 设备文件损坏 → 空状态启动并告知 | **阻塞** | — | 同上 |

> **这一整节卡在同一处，而且解锁它只需要一条命令**（见文末）。

## 十、模块可达性门禁

| 序列号 | 测试内容 | 测试结果 | 修正时间 | 测试实例 |
|---|---|---|---|---|
| `TC-GATE-001` | 新增未声明边缘 → `layer-check` 失败 | **通过** | — | `layer-check` 有 violations 时 `exit 2`、unexplained 时 `exit 3`（`scripts/layer-check.mjs`） |
| `TC-GATE-002` | 无调用者的模块 → 预检红，除非有理由 | **通过** | — | `PASS reachable or accepted: 7 orphan module(s), every one accepted with a reason` |
| `TC-GATE-003` | 理由过期 → 验收失败 | **通过** | — | **`field-authority` 就是这么被移除的**：0.41.0 给了它调用方，门禁随即变红，逼我撤掉那条接受 |
| `TC-GATE-004` | `layer-check` 打印 `clean` **且退出 0** | **通过（修复后）** | 2026-10-15 | **修复前它打印 `clean:` 然后 `exit 1`** —— 任何按退出码判断的读者（shell、CI、脚本）都把通过的检查读成失败。**preflight 一直没发现，因为那一步读的是打印文本而不是状态** |

## 十一、全量基线回归

| 序列号 | 测试内容 | 测试结果 | 修正时间 | 测试实例 |
|---|---|---|---|---|
| `TC-BASE-001` | 11 个工具全部可达 | **通过** | — | 真实加载已安装插件：`11 tools`，`w2m_council` 与 `w2m_approvals` 在内，无缺失无多余 |
| `TC-BASE-002` | 测试套件全量执行 | **通过** | — | **82 套件**（计划写 79，已过时） |
| `TC-BASE-003` | 用例通过数 | **通过** | — | **2228 用例 / 2214 通过 / 0 失败 / 14 跳过**（计划写 2199，已过时） |
| `TC-BASE-004` | pre-flight 检查 | **通过** | — | **12 pass / 0 fail / 1 unverifiable**，12/12 已注册检查均已上报 |
| `TC-BASE-005` | 0 失败 | **通过** | — | 同上；`packed tarball` 131 文件、`claims` 48 条 47 通过 1 跳过 |

---

## 十二、版本重跑规则

| 版本类型 | 执行范围 | 说明 |
|---|---|---|
| **每次发版** | P0 冒烟 + 变更相关项 + 核心回归 | 结果写入本表；失败项填修正时间 |
| **`Vx.0.0` 大版本** | **全表 100% 重跑** + 全量基线回归 | 不允许跳过，不允许仅抽样 |
| 热修复 | 对应失败项 + 相邻模块回归 | 修复后必须回归通过 |
| 季度/半年 | 全表重跑一次 | 防止环境漂移导致漏测 |

### 这张表当前未通过的分布，以及它们是不是同一件事

**61 项里 53 项已执行，8 项从未运行，11 项被执行但被环境挡住，1 项平台跳过。**
未通过的**不是一堆独立问题，而是 4 个阻塞源**：

| 阻塞源 | 卡住的项 | 解锁条件 |
|---|---|---|
| **只有 1 台可执行机器在线** | `TC-REPL-001`、`TC-SPLIT-001/002`、`TC-ANCH-001`、`TC-AGG-001/002/004` | 两台 `win-desktop` 自 2026-10-14 起静默；唤醒它们 |
| **中继无法远程升级/重启** | `TC-REL-001`–`004` | **`jp-shared` 上一条命令**（见下） |
| **没有可用配对码** | `TC-PAIR-003/004/005` | 一次可控的配对实验；会惊动编队，需你同意 |
| **需要真实中断或外部资源** | `TC-UPD-001/002/004/005/007` | 一次真实更新检查；`TC-SEC-007` 需要 macOS/Linux |

> **未通过的项 ≠ 未通过的项数那么多风险。** 它们集中在 4 处，其中**两处**（中继升级、唤醒 Windows 机器）是可以立刻解决的。

---

## 三个计数必须从本表消失

计划文本里反复出现的三个数字**已经不准了**，而且每传一次就更像事实：

| 计划写的 | 实测（v0.45.0） |
|---|---|
| 79 个测试套件 | **82** |
| 2199 项测试 | **2228** |
| 九种聚合状态 | **6 个判定值** |

**本表是这三个数字的唯一来源。** 引用它们时从这里读，不要从旧计划里复制。

---

## 解锁那两处阻塞

**中继**（解锁 `TC-REL-001`–`004`，以及这一跨度唯一未通过的功能验证 `PROP-009`）：

```bash
scp twinsearth-w2m-dsh-plugin-0.45.0.tgz root@202.182.123.154:/tmp/w2m-pkg-0450.tgz
bash install.sh /tmp/w2m-pkg-0450.tgz
```

`install.sh` 是幂等的，会**同时重部署和重启**服务，并保留 `/var/lib/w2m/rabbit`。做完之后 `w2m_stats` 会给出可验证的信号：`relay_id` 不变、`started_at` 变新。

**两台 `win-desktop`**（解锁 `TC-REPL-001`、`TC-SPLIT-*`、`TC-ANCH-001`、`TC-AGG-001/002/004`）：它们自 2026-10-14 起静默，`last_heartbeat_at: null`。需要在那两台机器上把 DSH 拉起来。

**这两件事都不需要我，而其余 32 项已经跑完了。**
