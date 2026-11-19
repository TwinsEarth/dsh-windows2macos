# 决策中心 UX：会话名与可选选项人化（v3.6.1）

本文记录两处决策中心（`src/decision-center/**`、`lib/client.js` 的决策收件箱部分）的体验改造：
**本轮待选显示会话名而不是 Session ID**，以及**决策选项口语化（规则 + 可选智能改写）**。
契约以代码与测试为准；这里写的是设计、边界与失败方式。

## 1. 会话名出现在哪里

用户可见的会话标识全部改为名称，裸 Session ID 只保留在 tooltip 与调试属性里：

| 位置 | 之前 | 现在 |
|---|---|---|
| 抽屉卡片 meta（`.w2mDcMeta`） | `会话 <sessionId.slice(0,18)>` | `会话 <名称>`；裸 ID 在 `title=` |
| 会话筛选 chip（`.w2mDcSessionChip`） | `只看会话：<id 前 18 位>` | `只看会话：<名称>`；裸 ID 在 `title=` |
| 抽屉页脚 quota 行 | `<id 前 10 位>×N` | `<名称>×N` |
| 右侧「决策收件箱」页签行 | 只有 ticket 标题 | tooltip 里补上会话名 |
| 卡片 DOM | 无 | `data-w2m-dc-session-id="<裸 ID>"`（调试/可复制） |

名称解析顺序：

1. **ticket 自带提示**：`source.sessionTitle` / `source.sessionName`（`ingest` 也接受 `sessionTitle` 与
   `metadata.sessionTitle`）。调用方已经知道标题时，宿主不再查。
2. **宿主 session 服务**：`sessions` 或 `agents` 的 `list()` / `values()` / `entries()`，形状按存在性探测；
   服务缺失或形状不同不是错误，只是少一个来源。
3. **DSH 会话日志**：日志里的 `session/title` 事件，也就是 DSH 自己显示的标题。只读：打开日志、最多解码
   头部 2 MiB 的 zstd 帧，**不写、不改名、不截断**。模块级缓存按 `文件:大小` 记账（上限 256 条），
   追加写入只会在文件变大时重读。
4. 都没有 → **`null`**。客户端显示 `未命名会话 · 尾 6 位`（没有可用 id 时只显示 `未命名会话`），
   绝不把裸 ID 当主文本。

解析器在 `src/decision-center/lib/session-titles.mjs`（`createSessionTitleResolver`）：

* 单条缓存上限 **512**；命中 TTL **10 分钟**，未命中（null）TTL **60 秒**（负数缓存只抑制重复读日志，
  不会压过一个后来才出现的宿主标题）；
* `list()` 每批最多读 **20** 条会话日志（`maxLogReadsPerCall`），其余走缓存或下一次轮询；
* 路由 `GET /api/w2m/decisions/session-titles?ids=a,b,c` 接受最多 **50** 个 id，逐条返回
  `titles[id] = 标题 | null`；服务缺失时全部 `null`。

**为什么不用 workspace registry**：本机 `$DSH_HOME/storages/workspace.json` 记录的是工作区标题和
`sessionIds`，没有 per-session 标题；用它会把每个会话都标成文件夹名。因此它不作为标题来源。
session-log 读取器与 `queue-journal/lib/session-log.mjs` 有重叠，但 decision-center → queue-journal
是 `scripts/layer-model.mjs` 未声明的同层边；把读取器下移到 `util/` 是后续项（见 §6）。

## 2. 选项人化管线

位置：`src/decision-center/lib/option-humanizer.mjs`（纯函数与缓存）+ `src/decision-center/index.mjs`
（AI 调用、队列、限流、持久化）。**没有第二套 provider 栈**：智能 pass 复用 `advise` 使用的
`callAiChat`、`selectAiRuntime`、`aiGate`、日配额/熔断、`assertEndpointSafe` SSRF 预检与同一份
`AI_PROVIDERS` 配置。

### 2.1 规则 pass（总是同步）

创建 ticket 时立即执行，按钮从第一帧就是可读的：

* 去掉代码围栏/反引号/markdown 强调/图片/链接语法/裸 URL；
* 去掉前导编号（`1.`、`A.`、`-` 等，要求分隔符后有空格，避免把 `1.5` 吃掉）；
* 合并空白、去首尾引号与结尾标点；
* 整句 → 动作短语：去掉结尾 `吗/呢/吧`、开头 `是否/要不要/我们应该/请选择…`，取第一个句号前的动作
  （`酒吧/网吧/贴吧` 这类名词有保护，不会被当成语气词）；
* 按**显示列**截断（CJK/全角按 2 列），加 `…`，不切断码点；
* **`value` 永不改**；按 `value` 去重（同 value 的真重复只留一个）；不同 value 即使文字相同也不删，
  因为删掉就是少一个选择；
* 只有文字真的变了才写 `rawLabel`（原文），供 tooltip/调试；`optionsHumanized.mode='rules'`；
  幂等：第二次规则 pass 与当前 label 相同则不涨 `rev`、不触发 AI。

`optionHumanize:'off'` 时整段跳过，`optionsHumanized.mode='off'`，`rawLabel` 不写入。

### 2.2 智能 pass（异步、可选）

* 触发：`optionHumanize:'auto'` 且已配置 AI，且规则 pass **确实改动了文字**（没有东西可改时不花调用；
  已有短标签的 ticket 不会产生费用）。创建时 `fire-and-forget` 入队，并发 **1**、最多排 **20**。
* 手动：`POST /api/w2m/decisions/humanize-options`（body `{id, by}`）强制走一次智能；按钮在
  `busy` 期间禁用，失败给「智能优化失败，可稍后重试：…」。
* 请求：`temperature 0.2`、`max_tokens 400`、超时 `optionHumanizeTimeoutMs`（默认 10 s）。
* 提示词硬约束：只改 `label`；`value`、数量、顺序完全不变；不解释、不用 markdown；label ≤
  `optionLabelMaxChars` 个显示列；无法更好就保持原意。ticket/选项被声明为**不可信数据**。
* 解析与校验（`parseOptionHumanizeResponse`）：必须是 JSON 数组、长度相等、逐位 `value` 相同、
  label 非空且互不重复；任何一条不满足都**拒绝整次结果**，回落规则 label。错误路径：
  `option-humanize-json` / `-shape` / `-count` / `-value` / `-label` / `-duplicate`；HTTP/网络失败
  记 `ai-timeout` / `ai-rate-limited` / `ai-http-*` 等。
* 成功写 `optionsHumanized = {mode:'ai', at, model}`，每项保留 `rawLabel`（原始文案）。
* 缓存：`sha256(value|label|model)`，内存 **LRU 500**；全部命中时不发请求（手动重跑同一张票免费）。
* 限流：手动重跑复用 `src/util/rate-limit.mjs` 的滑动窗口，**6 次/分钟/ticket**，超限返回
  **429 + Retry-After**；同 ticket 手动重跑 single-flight，只发一次。
* 日志/审计只记 `mode/model/reason/token`，**不落原始选项文本，也不落 API Key**；AI 失败不会回滚
  ticket、不会阻塞创建。

### 2.3 路由形状（宿主约束）

DSH Connection 的 Fetch 路由是**精确路径**注册表（`@deepseek-ai/dsh-client-connection` 的
`createSharedFetchHandler` 以 `url.pathname` 查 `Map`；`rpc-host.ts`），插件无法注册
`/decisions/<id>/humanize-options` 这种带参数段的路径。因此手动路由是静态的
`POST /api/w2m/decisions/humanize-options`，id 放在请求体里；鉴权仍是宿主对精确路由的
owner-only fence（与其它决策路由同一层，客户端用 same-origin 凭据）。

## 3. 配置键

| 键 | 默认 | 说明 |
|---|---|---|
| `optionHumanize` | `'auto'` | `auto` = 规则同步 + 有 AI 且规则改动了文字时异步智能；`rules-only` = 只跑规则；`off` = 保留原文 |
| `optionLabelMaxChars` | `28` | 按钮文字显示列上限（CJK 按 2 列），超长截断加 `…`；范围 4–120 |
| `optionHumanizeTimeoutMs` | `10000` | 单次智能请求超时（毫秒），超时回落规则；范围 1–60 s |

`service.policy()` 与 `/api/w2m/decisions` 的 `aiStatus().optionHumanize` 会暴露这些值、缓存统计与队列长度。

## 4. 兼容性

* 所有既有决策动作（选择/自定义答复/AI 建议/放弃/批量/等待）行为不变；`resolve` 仍匹配 `value`。
* 选项数组仍是普通对象；`rawLabel` 是新增可选字段，旧客户端忽略它即可。
* ticket 存储新增 `optionsHumanized`，恢复时原样读回；旧 store 没有该字段时按 `null` 处理。
* `lib/client.js` 仍在预算内（`test/client-budget.test.mjs`：≤610,000 B / ≤10,050 行 / 单函数 ≤1,200）。

## 5. 测试

* `test/dc-ux.test.mjs` — 规则矩阵、句→动作短语、CJK 截断、幂等、prompt/解析矩阵、LRU 缓存、
  AI 成功/六种失败回落、off/rules-only、缓存命中、单飞、无 AI 手动路径、标题解析（服务/异步服务/缺失/
  真实 zstd 日志只读且字节不变）、缓存与读取预算、配置校验。
* `test/decision-routes.test.mjs` — 两个新路由的注册、标题解析与 null 语义、手动路由规则完成 + 限流 429 +
  未知 id 404 + 空 id 400 + 未配置 AI 的 409、精确路由形状。
* `test/client-bundle.test.mjs` — `dcSessionView`/`dcOptionView` 渲染契约（名称、tooltip 裸 ID、兜底格式、
  rawLabel 只在 tooltip、`data-w2m-dc-option-source`）、手动按钮 POST 同一路径 + 刷新 + busy 禁用 + 失败提示。

## 6. 后续（本次未做）

* 把会话日志标题读取器下移到 `src/util/`，让 queue-journal 与 decision-center 共用同一个读取器。
* 若宿主未来支持参数化 Fetch 路由，可把手动路由改成 `/decisions/<id>/humanize-options`，客户端只需改一行。
* 真实页面探针（`W2M_QUEUE_JOURNAL_PROBE=1`）目前只覆盖抽屉/批量/队列，不读取新的
  `data-w2m-dc-option-source` 与 `data-w2m-dc-session-id`；若要像素级回归，需要在
  `test/helpers/dsh-page-boot.mjs` 的 decision probe 里补一条读取（该文件不在本次写范围）。
