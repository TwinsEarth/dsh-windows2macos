# P2 计划：P2P/relay 并发测试、`old/ .enc` 流式解密、客户端 bundle 体积

> 来源：`docs/AUDIT-3.5.2.md` §6.2 的三条 P2 风险。原则同 P1：**先立守卫（可测的基线），再动代码**；
> 每片独立提交、行为冻结、可单片 revert。基线 HEAD `3f16871`（3.5.2 + 审计 + P1 计划），pre-flight 4317/4295/0/22 全绿。

---

## 0. 事实核对（先纠正"想当然"）

### 0.1 `old/ .enc` 是**单块 AEAD**，不是分块格式

`src/backup/crypto.mjs` 的 `sealObject()` 返回 `{alg, nonce, ciphertext, tag}`（base64 四字段），
`createCipheriv(AEAD, key, nonce)` 一次加密整文件；`openObject()` 也必须一次性持有全部密文才能验 tag。
因此**"流式解密"不是改调用方式，而是改格式**：需要新增分块封存格式 v2（v1 继续可读），不是简单换个 API。

### 0.2 P2P 有可注入接缝，relay 有可注入时钟

- `src/agent/p2p.mjs` / `p2p-node.mjs` 的 options 已含 **`bindUdpSocket`**（可注入 socket）、`punch`、`discover`、
  `nowMs`、`crypto`、`getJson/postJson` —— 足以做"丢包/乱序/重复/半途断开"的确定性故障注入。
- `src/relay/server.mjs` 的 `createRelayServer` 接受 **注入的 state（含 `nowMs`）与 `persistence`**，
  所以"租约过期/心跳竞争/重启中途"可以用假时钟+内存持久化确定性地测。
- 现有覆盖：`p2p-race.test.mjs`、`relay-*` 15 个套件、Phase 2 真实进程脚本已存在；缺的是**故障注入的系统化矩阵**。

### 0.3 客户端 bundle 是**手写发布 bundle，没有构建步骤**

`lib/client.js` 594,539 B / 9,965 行，文件头明确"这是 shipped bundle，不是编译产物；`load()` 表形状即协议"。
因此体积治理有两条合法路径：**文件内分解**（不影响加载契约）或**增加多客户端模块**（需要 DSH 客户端加载契约支持，
要先查 `dsh-doc`/loader-entry 的约束）。**不能**直接引入 minifier 构建步骤（会破坏"无构建、无依赖"的发布承诺）。

---

## 1. 工作流 F：P2P/relay 并发与故障注入测试

### 目标

把"依赖集成测试碰运气"变成**确定性故障矩阵**：同一场景在丢包率 0/5/20%、乱序、重复、半途断开、时钟跳跃下
断言协议结果（要么成功且幂等，要么具名失败，绝不静默丢结果）。

### 切片

| # | 切片 | 内容 | 验收 |
|---|---|---|---|
| F1 ✅ | 注入式 UDP 故障层 | **已实现** `test/helpers/fault-udp.mjs`（526 行）：seeded PRNG、内存端点 + 注入式 base socket、`drop/duplicate/reorder/latency/goSilent`、有界队列 | 7 项自测：同 seed 同顺序、计数、溢出报错 |
| F2 ✅ | P2P 可靠通道矩阵 | **已实现** `test/p2p-fault.test.mjs`：0/5/20% 丢包、乱序、重复、半途 close、重开；**发现并修复产品 bug**（完成后重复包被二次投递 / incoming 永不清理），见下 | 24/24（含原 skip 转绿）；无真实 socket |
| F3 ✅ | relay 租约竞争矩阵 | **已实现** `test/relay-concurrency.test.mjs`：心跳/过期边界、halt=never/now 接管、写任务拒绝接管、重启中途恢复、重复 offer/result 幂等 | 8/8；relay.test 189/189 不回归 |
| F4 | 真实进程回归 | 把 F2/F3 的关键场景加进 `scripts/verify-relay-cluster-phase2.mjs` 的 mixed-version 场景 | 本机真实进程脚本 9/9 + 6/6 仍通过 |

**风险控制**：故障注入只经注入接缝，不 monkey-patch 全局；随机种子显式化；测试失败信息必须给出"哪个包/哪个租约"。

**F 的产出**：修复了 `P2PChannel` 的接收侧重复抑制缺口——新增完成消息有界 LRU（`recentMessageLimit` 1024 / `recentMessageTtlMs` 60 s）、
`incoming` 过期清扫（`unref` 定时器 + 查找时过期）、计数器 `duplicateFragmentsDropped/messagesDeduped/staleAssembliesSwept`；
ACK 语义与线协议不变。`test/p2p-fault.test.mjs` 24/24、p2p 回归 115/115 + 142/142。

---

## 2. 工作流 O：`old/ .enc` 分块封存 v2（流式校验/恢复）

### 目标

新增 `chunked-v2` 封存格式，使 verify/restore 可以**逐块**解密校验，峰值内存 ≈ 一个块（当前 512 MiB + 堆守卫整文件）。

### 格式（提案，写进 BACKUP-DESIGN §28）

```
magic   "W2MOLD2\n"                      8 B
header  {v:2, alg, chunkBytes, size, sha256(明文)}   JSON, 明文（含身份不泄密的元数据）
chunks  [ nonce(12) | ciphertext | tag(16) ] × N     per-chunk AEAD
AAD     "w2m-session-backup/old-chunked|sha256|size|chunkIndex"
```

- 每块独立 nonce（随机）+ AAD 含序号 ⇒ 可乱序校验、可截断检测（header 的 size/chunkBytes 决定块数）。
- 读取端先看 magic：`v1` 走现有 `openObject()`（保持兼容，整文件读取仍受 `oldCopyMaxBytes` 守卫）；`v2` 走流式。
- 写端：`rotation` 新副本默认 v2；记录 `full_copy.format: 'chunked-v2'`（v1 记录无该字段，视为 v1）。
- 迁移：**不重写旧副本**（旧 v1 继续可读）；`gc` 不变；mirror 按字节复制（格式无关）。

### 切片

| # | 切片 | 内容 | 验收 |
|---|---|---|---|
| O1 | 格式 v2 编解码 + 单测 | `sealObjectChunked/openObjectChunked`（含流式 sink），AAD/截断/错块/错序拒绝 | `test/backup-chunked.test.mjs`：往返、篡改、截断、乱序、v1/v2 自动识别 |
| O2 | verify 流式化 | verify 对 v2 副本逐块校验；峰值内存断言（子进程 `--max-old-space-size`） | verify 套件 + 内存门槛 |
| O3 | restore/old-restore 流式化 | 从 v2 副本恢复时流式写回（临时文件 → 原子 rename）；v1 保持现状 | restore 套件 + v1/v2 混合仓库 |
| O4 | rotation 写 v2 + 文档 | 新副本写 v2；BACKUP-DESIGN §28；验收记录 | 真机跑一次 full 副本 + 恢复演练 |

**风险**：这是**协议扩展**（不是纯重构）。要求 v1 读取永不改变；v2 只对新写入生效；`verify` 必须同时覆盖两种格式；
升级/降级路径（新版写 v2、旧版读不了 v2）需在文档明确"旧版不能读 v2 副本，请用 ≥3.6 读取"。

---

## 3. 工作流 C：客户端 bundle 体积

### 现状与判断

- 594 KB / 9,965 行，**体积大头不是数据，是内联 UI 组件**：`UpdateSettingsSection` 3,454 行 + `renderChatText` 1,142 行，
  两者合计 ≈ 46% 行数。
- 无构建步骤（发布承诺），所以可行手段只有：**文件内分解**（不改变 bundle 形状）、**拆出独立客户端模块**（需查契约）、
  **删除死代码/合并重复 i18n 表**（收益小）。

### 切片

| # | 切片 | 内容 | 验收 |
|---|---|---|---|
| C1 | 体积预算守卫（**本提交已完成**） | `test/client-budget.test.mjs`：文件字节/行数预算 + 单函数行数上限（当前最大 3,454，阈值 3,600），越界即失败 | 新套件绿；进入 `scripts.test`/`test:all` |
| C2 | 设置面板分解 | `UpdateSettingsSection` → 壳 + 4 个子组件（同文件内 module scope），目标单函数 <600 行 | client-bundle 106/106 + loader-entry |
| C3 | chat 渲染分解 | `renderChatText` → markdown/代码块/附件三段 | 同上 |
| C4 | 多客户端模块可行性 | 查 `dsh-doc` 与 `test/loader-entry.test.mjs` 的加载契约：能否一个包注册多个 client 模块（独立 specifier），能则拆 2–3 个文件并保持 compose | loader-entry 真实 Loader 测试通过；面板功能无变化 |
| C5 | 文档收尾 | AUDIT 风险表更新、README 客户端说明 | pre-flight 绿 |

**风险控制**：C2/C3 是纯视图分解，必须"文件内"完成、不改 `load()` 表；C4 未验证契约前不实施。

---

## 4. 推荐顺序与工作量

| 顺序 | 切片 | 工作量 |
|---|---|---|
| 1 | **C1**（已完成） | 0.2 会话 |
| 2 | F1 → F2（P2P 故障矩阵） | 2 会话 |
| 3 | F3（relay 租约竞争） | 1–2 会话 |
| 4 | C2 → C3（client 文件内分解） | 2–3 会话 |
| 5 | O1 → O2 → O3 → O4（v2 格式） | 3–4 会话（含真机） |
| 6 | F4 / C4 / C5 收尾 | 1 会话 |

**为什么 C1 先做**：它把"client.js 不能继续变大"变成 CI 事实；后续任何 UI 改动都受约束，且不阻塞其它工作流。
**为什么 O 排在后面**：它是唯一改文件格式的工作流，需要单独发布窗口与真机恢复演练，不能和纯重构混在一起。
