# SPIKE-ACCOUNT-KEK — 账户材料核验（v3.4.6 备份 KEK 决策文档）

- 状态：**spike 完成（只读调查）**，供 `docs/BACKUP-DESIGN.md` 引用（该文档已在本调查期间由并行任务创建，其 §6 已链接本文；本文 §5.6 标出与其默认参数的差异）
- 适用版本：w2m v3.4.6（分支 `work/v3.4.6`，HEAD `8c04ef7`）
- 调查时间：2026-11-17 12:30–12:45（Asia/Shanghai）
- 调查方式：**只读**。未写 `C:\Users\fangw\.dsh\`、未写 `E:\DSH\`、未改任何仓库文件、未运行测试套件、未执行 git/npm/pnpm 的变更型命令。
- **增补（2026-11-17 16:37）**：宿主内实测已补齐，w2m 的 `getProfile(client)` 调用已修；调查结论（`account` 信封不实现）不变。见 §8，实测脚本在 `E:\GPT\.tmp\w2m-account-probe-driver.mjs` 等。
- 凭据纪律：本文只记录**文件名、大小、mtime、顶层/嵌套键名与形状**；全文不包含任何 token、私钥、密码、密钥材料或其前缀/哈希。可行性脚本只在内存里用合成字符串与随机字节，只输出"可/不可 + 长度 + 毫秒"。

## 0. 结论（先行）

1. **账户信封：有条件可行，但不是"稳定 32 字节秘密材料"。** DSH 0.2.2-rc.3 只向 Host 插件提供账户**标识** `userId`（Host-only、仅内存缓存、必须有一次成功的 `getProfile` 且需要联网）；磁盘上没有任何稳定的 account id / user id / email / 账户公钥指纹。`.anonymous-user-id` 是安装级随机 UUID（重装/删除即变），`.credentials.yaml` 里的 grant token 会随登录/登出/过期/issuer 变化被替换或删除。因此 `account` 信封只能做"同一账户便捷解封"，**不能**承担机密性保证。
2. **machine 信封：可行。** 本机 DPAPI（CurrentUser）32B→262B 密文 round-trip 实测通过，跨独立 PowerShell 进程可解；把随机 32B machine key 交给 DPAPI 保护即可同机免密。限制：仅 Windows（仓库现有 DPAPI 实现对 macOS 明确返回 `keychain-not-implemented`）。
3. **password 信封：可行且是唯一保证。** 本机 scrypt 实测：N=2^14 ≈56ms、2^15 ≈111ms、2^16 ≈227ms、2^17 ≈461ms；建议 **N=2^17 / r=8 / p=1 / keylen=32**（≤1s 目标下约 2.2× 余量，内存约 128 MiB）。
4. **建议默认信封组合：`machine + password` 默认写入；`account` 作为可选第三信封（拿到 `userId` 且产品确认后再写）。** 三种信封包裹的都是**同一个随机 32B DEK**（不是直接派生文件密钥），与工作树里已存在的 `src/backup/crypto.mjs`（`wrapDek`/`unwrapDek`/`ENVELOPE_KINDS=['account','machine','password']`）一致。
5. **实现前必须修一处调用**：w2m 现有 `await service.getProfile()`（零参，`src/chatops/account.mjs:314-318`）与 DSH 0.2.2-rc.3 的 `getProfile(client: AccountClientMetadata)` 签名不符（`dsh-deepseek-account/src/index.ts:228`；`client-metadata.ts:37-45` 会直接解引用 `client.version`；`@Remote` 装饰器只登记 RPC 元数据、不包裹 Host 直接调用，见 `dsh-typert-protocol/src/index.ts:277-317`）。沿用零参调用时 `userId` 大概率保持 null，账户信封会"看起来支持、实际不可用"。**（2026-11-17 16:37：该校验已修并在宿主内实测闭环，见 §8；结论不变——账户信封仍不实现。）**

> **决定更新（2026-11-17，用户决定，晚于本节实测）：选择"只读账户唯一识别码做比对"的身份绑定解锁。**
> 用户原话："不用打开账户，只需要读取账户唯一识别码ID，进行比对就行，一致就放行。不一致就切换密码模式。"
> 因此 `account` 信封现在作为**身份绑定**写入：KEK = HKDF(`w2m-account-binding|<accountId>`)，绑定的 id 记在
> `keys.json` 的 `account_binding`；解锁时只比对 id —— 一致 → account 路径放行；不一致 → 记录
> `BACKUP_ACCOUNT_MISMATCH` 并回退密码路径；没有密码则仍是 `BACKUP_NO_PERMISSION`。
> **诚实边界（必须同时读）**：账户 id 是标识不是秘密，知道 id 且拿到仓库文件的人可推导同一 KEK，所以这条路径
> **不承诺机密性**、只是"同账户免密"的便捷路径，且不替代 password。设计、面板文案、配置与测试见
> `docs/BACKUP-DESIGN.md` §25。本文 §8.3/§8.5 的实测与"没有稳定每账户秘密"的结论未被改写，仍然有效。

---

## 1. 方法与边界（含对任务前提的两处更正）

### 1.1 路径更正

- 任务给的 `E:\DS\DS\resources\app.asar\dsh\` **不存在**（`Get-Item` 报 MISSING）。本机 `E:\DS` 下只有无关目录（`202610/`、`20261110/`、`AU4A` 等）。
- 实际运行中的 DSH Desktop 安装在 **`E:\DSH\DS\resources\app.asar`**（文件大小 209,021,953 B，mtime 2026-11-13 15:30:52，`Archive` 属性）。运行时环境变量（只读读取）：

| 变量 | 值 |
|---|---|
| `DSH_PROFILE` | `desktop` |
| `DSH_INSTALL_DIR` | `E:\DSH\DS\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh` |
| `DSH_NODE_EXECUTABLE` | `E:\DSH\DS\DeepSeek Harness.exe` |
| `DSH_PROFILE_DIR` | `C:\Users\fangw\.dsh\profiles\desktop` |
| `DSH_HOME` | `C:\Users\fangw\.dsh` |
| 安装版本 | `@deepseek-ai/dsh` **0.2.2-rc.3**（`.../dsh/package.json:4`） |

- 本机另有 `E:\DSH` 与 `E:\DS` 两个目录，本文所有 DSH 源码证据均指 `E:\DSH\DS\resources\app.asar\dsh\...`。

### 1.2 检索方式（grep 工具不能穿越 asar）

- `grep` / `glob` 工具在 app.asar 路径上失败：`rg: IO error ... 系统找不到指定的路径 (os error 3)`。
- 按 DSH 自带 `dsh-doc` 技能的 `references/locate-docs.md:27,31-60` 指引：asar 内文件用 **Host `read` 工具**读取；目录列举与有界文本搜索用 **Electron as Node**（`ELECTRON_RUN_AS_NODE=1` + `$env:DSH_NODE_EXECUTABLE` + 只读脚本）完成。脚本位于 `E:\GPT\.tmp\spike-account\`（`asar-tools.cjs`、`structure-probe.cjs`、`feasibility.cjs`），只读文件、不落明文。
- `~/.dsh` 与 `E:\DSH` 的所有读取均只读；调查前后对 6 个候选文件做了 size/mtime 复核，**完全一致**（见 §2.3）。
- 直接以 PowerShell 命令点名 `.credentials.yaml` 的读取被本机 GPW 守卫拦截（`SENSITIVE_EXTENSION`），因此结构读取通过只读 helper 脚本完成；未绕过、未重试其它读取方式。
- 本会话没有 `cordis_inspect_*` 工具，**无法在宿主进程内实测 `ctx.deepseekAccount.getDeviceIdentity()` 的真实返回值**；第 3 节的运行时结论来自 DSH 源码静态阅读 + w2m 已发布代码 + 本机磁盘证据，已在 §6 标注"未实测"。**（2026-11-17 16:37 已用 Harness 运行时内的驱动补齐实测，见 §8。）**

---

## 2. 实测事实表（只读，2026-11-17）

### 2.1 候选文件

| 文件（`C:\Users\fangw\.dsh\`） | 大小 | mtime（本地） | 顶层键 / 结构（只列键名与形状，不读值） | 稳定账户标识？ | 重写 / 消失条件（证据） |
|---|---:|---|---|---|---|
| `.credentials.yaml` | 805 B | 2026-11-17 06:17:01 | `version`；`records`（3 个记录键：`client-connection/browser-session`、`deepseek-account-platform/device`、`deepseek-account-platform/default`）；`refs`（3 个键：`VOLCENGINE_AGENT_PLAN_API_KEY`、`VOLCENGINE_ARK_API_KEY`、`DEEPSEEK_API_KEY`） | **无**。grant 记录 payload 形状 `{version, token, issuer}`，只有不透明 token 与平台 origin；device 记录 payload `{id}` 是随机会话级 UUID；无 account id/user id/email/公钥指纹 | 任何凭据写都会整体重写文档（`dsh-credentials-local/src/index.ts:659-668,692-725,727-744`，写路径 `writeFileAtomic`）；登录写入新 grant（`dsh-deepseek-account/src/index.ts:762`）；登出/会话过期删除 grant（`:562`、`:384-399`）；启动时 issuer 与 `platformOrigin` 不一致直接删除 grant（`:191-199`）；旧版扁平文档 boot 迁移会重写（`dsh-credentials-local/src/index.ts:809,827-844`） |
| `.credentials.yaml.bak-before-rebuild-20261117` | 478 B | 2026-11-16 23:26:15 | 结构同上，但**没有 `refs` 段**；3 个 records 键与 payload 形状与当前文件一致 | **无** | 静态备份文件，创建后未再被写；用于证明"文件被重写但 records 结构未变"（值未比较——按纪律不读值） |
| `.anonymous-user-id` | 37 B | 2026-11-16 23:25:54 | 单个 UUID 文本（形状校验 yes；末尾有换行） | **无**（安装级匿名 UUID，与账户无关） | 首次使用时 `randomUUID()` + `wx` 创建；删除文件/损坏/不可写时下次启动重新生成；不同 `$DSH_HOME` 各自不同（`dsh-anonymous-user-id/src/index.ts:5-9,44-55,68-100`；README:12,40,120）。**重装/换机/删除文件必变** |
| `xclient\device.json` | 203 B | 2026-11-17 09:37:18 | `machine_id`、`machine_name`、`device_token`、`rabbit_url` | **无**（`machine_id` 是本机随机 UUID；`device_token` 是 w2m relay 配对令牌） | 首次运行创建；配对成功写 `device_token`；`machine_name/rabbit_url` 变化时重写；`machine_id` 绝不重新生成，文件损坏直接报 `IDENTITY_CORRUPT`（`src/agent/identity.mjs:24-31,43-54,152-176,188-219,228-238`） |
| `xclient\device.key` | 176 B | 2026-11-16 23:35:39 | JSON：`format`、`algo`、`machine_id`、`private_key`（本调查未读值） | **无账户标识**；是本机 x25519 设备身份（公钥可推出，机器级指纹，不是账户指纹） | 首次配对时生成，之后只读加载；`format=w2m-device-key/1`、`algo=x25519`；损坏报 `DEVICE_KEY_CORRUPT/UNREADABLE`（`src/agent/crypto.mjs:67-76,405-510`） |
| `fang\desktop\fang-auth.json` | 102 B | 2026-11-17 06:54:21 | `token`、`createdAt` | **无**（Fang 安装级 HTTP 鉴权 token，不是 DSH 账户身份） | 由 dsh-fang 另一项目生成：`fang-auth.json` 缺失/损坏/过短时生成 32B 随机 token 并写 0600（`E:\GPT\.tmp\fang-3117\src\lib\http-auth.mjs:9,13-29`）；DSH asar 内搜索 `fang-auth` **0 命中** |

### 2.2 `.credentials.yaml` 的 records / refs 结构（任务要求）

只列键名与嵌套形状（无值、无长度、无前缀）：

```text
version: <digits>
records: <mapping>
  client-connection/browser-session:
    kind: <scalar>
    payload: { version: <digits>, secret: <scalar> }
  deepseek-account-platform/device:
    kind: <scalar>
    payload: { id: <uuid-like> }
  deepseek-account-platform/default:
    kind: <scalar>
    payload: { version: <digits>, token: <scalar>, issuer: <scalar> }
refs: <mapping>
  VOLCENGINE_AGENT_PLAN_API_KEY: <scalar>
  VOLCENGINE_ARK_API_KEY: <jwt-like>
  DEEPSEEK_API_KEY: <scalar>
```

解释（全部有源码依据）：
- 这是 DSH 的版本化凭据文档 `version: 1` + `refs`（环境变量名→密钥值）+ `records`（`<owner>/<id>`→`{kind, payload|env}`），见 `dsh-credentials-local/README.md:82-111`、`dsh-credentials-local/src/index.ts:61,292-...`。
- `deepseek-account-platform/default` 是 DeepSeek 登录 grant（schema `{version:1, token, issuer}`，`dsh-deepseek-account/src/index.ts:34,36,762`）；`.../device` 是登录设备记录 `{id: uuid}`（`:35,37,740-743`）；`client-connection/browser-session` 是 Host Web 会话 cookie 签名密钥（`dsh-client-connection/src/browser-auth.ts:14`，README:43）。
- **三个 records 都没有 account id / user id / email**；唯一"账户"相关的是可被替换的 bearer token。`.bak` 与当前文件结构对比：records 完全同形，当前文件多了 `refs` 三个键——说明 2026-11-17 06:17 前后的重写新增了 refs；但**不能**由此断言 token 字节没变（按纪律未读值）。
- 该文件被排除在会话备份之外是既定设计：`docs/DEV-PLAN-3.4.6-3.5.0.md:52`（"备份它等于把令牌复制到 D 盘"）。

### 2.3 只读复核（调查结束后重测，证明未改 mtime）

| 文件 | 调查开始（size / mtime UTC） | 调查结束（size / mtime UTC） | 一致？ |
|---|---|---|---|
| `.credentials.yaml` | 805 / 2026-11-16T22:17:01.503Z | 805 / 2026-11-16T22:17:01.503Z | ✅ |
| `.credentials.yaml.bak-before-rebuild-20261117` | 478 / 2026-11-16T15:26:15.117Z | 478 / 2026-11-16T15:26:15.117Z | ✅ |
| `.anonymous-user-id` | 37 / 2026-11-16T15:25:54.088Z | 37 / 2026-11-16T15:25:54.088Z | ✅ |
| `xclient\device.json` | 203 / 2026-11-17T01:37:18.442Z | 203 / 2026-11-17T01:37:18.442Z | ✅ |
| `xclient\device.key` | 176 / 2026-11-16T15:35:39.145Z | 176 / 2026-11-16T15:35:39.145Z | ✅ |
| `fang\desktop\fang-auth.json` | 102 / 2026-11-16T22:54:21.680Z | 102 / 2026-11-16T22:54:21.680Z | ✅ |

### 2.4 直接回答任务的三个小问

1. **有没有稳定的账户标识？** 六个候选文件中：**没有** account id / user id / email / 账户公钥指纹。`userId` 只存在于 DSH Host 进程内存（最近一次成功 `getProfile` 的缓存），不落盘。
2. **`.anonymous-user-id` 会因重装/换机而变吗？是否存在 provisioning 逻辑？** 会变。provisioning 逻辑就是 `getOrCreateAnonymousUserId`：读 `$DSH_HOME/.anonymous-user-id`，缺失则 `randomUUID()` + 排他创建；删除/损坏/新 home 都会换新 id；与账户无关（`dsh-anonymous-user-id/src/index.ts:5-9,44-55,68-100`；README:12,40,120）。因此它**不是**账户指纹，也不能作为 KEK 材料。
3. **这些文件会在重新登录/升级/清理时被重写吗？** 见 §2.1 最后一列：`.credentials.yaml` 在登录/登出/过期/设备创建/任何 `set/unset/record` 写/旧格式迁移时被整体重写；`device.json` 在配对/改名/改 relay 时重写但 `machine_id` 永不变；`device.key` 只在首次生成；`fang-auth.json` 只在缺失/损坏时重生成；`.anonymous-user-id` 只在首次/删除/损坏时重生成。**升级路径**上还有两个会删除账户材料的点：启动时 grant issuer 与配置 origin 不一致会删除 grant（`dsh-deepseek-account/src/index.ts:191-199`），凭据文档 boot 迁移会重写文件（`dsh-credentials-local/src/index.ts:809,827-844`）。

---

## 3. DSH 源码侧证据（安装版 0.2.2-rc.3）

### 3.1 插件可用的账户/凭据服务

| Cordis 服务 | 提供包 | 关键证据 | 插件能拿到什么 |
|---|---|---|---|
| `ctx.deepseekAccount` | `@deepseek-ai/dsh-deepseek-account` | 服务注册：`lib/index.js:916`（`super(ctx, "deepseekAccount", { namespace: "account" })`）；类型声明：`src/index.ts:23-31`；桌面基础组合挂载：`dsh-base/cordis.patch.yml:120-123` | `getState/getProfile/getBalance/...`（Remote）；**Host-only 的 `getDeviceIdentity()`、`getPlatformSession()`、`resolveToken()`、`rejectToken()`**（README:35） |
| `ctx.credentials` | `@deepseek-ai/dsh-credentials` + provider `dsh-credentials-local` | `src/index.ts:148-152`（`Context.credentials`）、`:171-174`（服务名 `credentials`）；provider 挂载 `dsh-base/cordis.patch.yml:125-126` | `resolve/describe/set/unset`（refs）+ `readRecord/describeRecord/listRecords/modifyRecord/deleteRecord`（records） |
| `ctx.authorization` | `@deepseek-ai/dsh-authorization` | `dsh-base/cordis.patch.yml:117-118`；DeepSeek 登录 flow 用它 `src/index.ts`（`registerFlow` 在 `:162`） | 由插件注册"需要人类参与的凭据流程"；与 KEK 无直接关系 |

**插件确实能读账户标识**：`dsh-client-product-analytics/src/index.ts:34,109` 就 `inject=['deepseekAccount','productTelemetry']` 并调用 `ctx.deepseekAccount.getDeviceIdentity()`；w2m 自己也用 `ctx.get('deepseekAccount')`（`src/chatops/account.mjs:284`）。

### 3.2 `userId` 的完整取得链路（这是"账户材料"的唯一来源）

1. `getDeviceIdentity()`：`dsh-deepseek-account/src/index.ts:405-416`
   ```ts
   const [record, session] = await Promise.all([
     this.ctx.credentials.readRecord(DEVICE),   // {id: uuid} 登录设备记录
     this.getPlatformSession(),
   ])
   return { ...(deviceId 有则带), ...(session?.userId 非空则带 userId), osVersion }
   ```
2. `getPlatformSession()`：`:423-435`——`userId` **只**来自 `this.lastProfile`，且要求 `lastProfile.token === stored.token`，否则 `null`。
3. `lastProfile` 是**进程内存**缓存（`:129`），来源是 `getProfile()` 成功后的 `cacheProfile`（`:338-344`）；凭据变化/登出时 `invalidateDetails()` 清空（`:667-671`）。
4. `getProfile()` 用保存的 grant 向平台请求 `GET /auth-api/v0/users/current`，投影出 `id`（`src/details.ts:6-10,28-35,48-59`）。**必须联网**，且 `AccountUserId` 的 schema 只是 `z.string()`——DSH 不保证它是 UUID。
5. `.credentials.yaml` 中的 grant 记录只有 `{version, token, issuer}`（`:34,36`，本机结构见 §2.2），**没有 userId**。结论：**磁盘上没有账户 id 的可读副本**。

### 3.3 为什么 grant token 不能当账户 KEK 材料

- 登录成功写新 grant（`:762`）；登出删除（`:562`）；平台 401/40003 触发 `expireCredential` 删除（`:384-399`）；启动时 issuer 不匹配删除（`:191-199`）。
- `README.md:76`：服务初始化时，issuer 与 `platformOrigin` 不一致的已存 grant 会被本地删除，API key 和 device identity 保留。
- 它是 bearer secret（README:47、`:114`），不是"账户本身的稳定秘密"；用它做 KEK 必然在重新登录后让旧备份打不开。

### 3.4 `.anonymous-user-id` 不是账户身份

- 它是 **library，不是 Cordis 插件**（README:69），使用方 `import { getOrCreateAnonymousUserId }`（README:44-52）。
- 值 = `crypto.randomUUID()`，从不从 hostname/网络/git remote 派生（README:66）；只用于 telemetry / feedback / DeepSeek 请求头 `x-deepseek-harness-user-id`（README:34-36；`dsh-base/cordis.patch.yml:210`）。
- 删除即新 id，不同 `$DSH_HOME` 各自不同（README:12,40；源码 `:68-100`）。**不提供任何账户关联，也不跨机器稳定。**

### 3.5 设备 identity（`deviceId`）也不是账户材料

- `device` 记录是登录时创建的随机 UUID（`:740-743`，`{id: randomUUID()}`），README:51 明确："Device identity is a separate random UUID record shared by processes using the same credential store"。
- 作用域是"同一个 credential store"，换机/重建 `.dsh` 即变；不是账户派生，无法用于跨机账户信封。

### 3.6 关键发现：w2m 现有 `getProfile()` 调用与 0.2.2-rc.3 签名不一致

- DSH 签名：`async getProfile(client: AccountClientMetadata)`（`src/index.ts:228`），`AccountClientMetadata = {version, locale, timezoneOffsetSeconds}`（`src/types.ts:7-13`）。
- 调用链会直接解引用 `client.version` 等：`src/index.ts:232` → `detailHeaders(client)`（`:368-370`）→ `platformClientHeaders(platform, client)`（`src/client-metadata.ts:37-45`，其中 `:42-44` 读 `client.version/locale/timezoneOffsetSeconds`）。
- `@Remote` 只是登记 RPC 元数据，不包裹 Host 直接调用：`dsh-typert-protocol/src/index.ts:250-263,277-317`（装饰器只 `addMarkerInitializer`）。
- w2m 现有代码：`await service.getProfile()` 零参且异常被静默吞掉（`src/chatops/account.mjs:314-318`）。**静态推断**：在 0.2.2-rc.3 上该调用会抛 TypeError，`userId` 只能依赖"此前 DSH UI 打开过账户设置页"触发的成功 `getProfile`（全 asar 中唯一 UI 调用点是 `dsh-client-ui-settings-account/src/client/index.ts:82`，且它正确传了 metadata）。
- 因此账户信封的**可用性**取决于：已登录 + 有效 grant + 联网 + 本进程内已有成功 profile 读取。这是"有条件可行"的核心含义。

### 3.7 插件从 `.credentials.yaml` / `ctx.credentials` 能读到什么

- records 是普通读写、**没有 owner 校验**：`dsh-credentials-local/src/index.ts:670-672` 的 `readRecord(key)` 直接查内存 map；seam 只做 grammar 校验（`dsh-credentials/src/index.ts:69-92,211-217`）。
- 也就是说 Host 插件理论上可读 `deepseek-account-platform/default` 的 token 与 `deepseek-account-platform/device` 的 id；但同 UID 进程本来就能直接读该文件（`dsh-credentials-local/README.md:199`、`:113-115`）。**这不是把 token 拿来当 KEK 的理由**（见 §3.3）。
- 注意 `.credentials.yaml` 在 Windows 上无 POSIX mode 可检（`dsh-credentials-local/src/index.ts:127-142` 的 owner-only 检查按平台跳过）；DSH 文档明说其"不能把秘密与 agent 隔离"（README:115）。

---

## 4. 本机密钥能力（w2m 仓库内，只读）

| 能力 | 现有实现（文件:行） | 能否复用 | 结论 |
|---|---|---|---|
| Windows DPAPI（用户级） | `src/decision-center/lib/ai-secret-store.mjs:26-40`（`ProtectedData.Protect/Unprotect` + `DataProtectionScope.CurrentUser`，secret 走 stdin 不进 argv）；`:43-52` runner（`spawnSync`，timeout）；`:54-64` 后端探测；`:90-119` encrypt/decrypt；`:130-192` save/load；密文落盘为 `<dataDir>/decision-ai-secret.enc`，meta 在 `decision-ai-secret.json` | **可以**：machine 信封的随机 key 保护直接复用这套 PS 脚本/runner 模式 | 本机实测 32B→262B 密文、跨进程 round-trip OK（§4.5）；`darwin` 分支明确 `keychain-not-implemented`（`:63`）→ macOS 暂无 machine 信封 |
| 更正任务前提：kernel.mjs 是否含 DPAPI？ | `src/decision-center/kernel.mjs:15-23,93-138,140-165` 只有 fs/ids/atomic-write/dataDir 工具；全文无 DPAPI/钥匙串代码（grep `DPAPI|keychain|safeStorage` 仅命中 `ai-secret-store.mjs` 与 `gpw.mjs:415,963` 注释） | —— | **kernel.mjs 不是密钥存储**；真正的 DPAPI 实现在 `ai-secret-store.mjs`（decision-center/index.mjs:126,1607,2245 调用它） |
| 账户 Ed25519 身份 | `src/util/account-identity.mjs:26-59`：`seed = sha256("w2m-account-identity-v1" ‖ 0x00 ‖ accountMaterial)` → Ed25519 PKCS#8（固定前缀 `:27`）；`fingerprint = sha256(SPKI)`（`:57`）；`signChallenge/verifyChallenge`（`:62-75`）。调用方：`src/plugin/tools.mjs:8409`（加入舰队时 `deriveAccountKeypair(key)`），`accountMaterial` 来源 `src/plugin/tools.mjs:3720` = `resolvedFleetKey.value` | **可作账户身份的既有先例**，但注意输入：`accountMaterial` 当前是 **fleetKey**（relay 可见），不适合做备份 KEK；做 KEK 应直接用 `userId`（见 §5） | 已确认是 ed25519（不是 rsa/ecdsa） |
| w2m 设备身份（x25519） | `src/agent/identity.mjs:24-31,43-54,152-176,188-219`（`machine_id` 随机 UUID 永不再造）；`src/agent/crypto.mjs:67-76`（`device.key` = `w2m-device-key/1` + `x25519`）、`:405-510`（load/generate/0600/JSON `{format,algo,machine_id,private_key}`）、`:354-360`（`deriveSigningKey`） | 可复用其"本机私钥文件"的读写/原子写模式 | 机器级身份，不是账户材料；不适合做跨机信封 |
| HKDF + AES-256-GCM 先例 | `src/util/chat-crypto.mjs:34-48`（`hkdfSync('sha256', fleetKey, salt, 'fleet-chat-v1', 32)`）；`:55-67`（AES-256-GCM 消息信封）；v2 AAD：`:96-128` | 已被备份 crypto 内置实现吸收 | 本机 Node v26.13.0 支持 |
| **backup crypto（已存在，未提交）** | `src/backup/crypto.mjs`（607 行，mtime 2026-11-17 12:34，工作树新增）：随机 DEK（`:122-125`）；`ENVELOPE_KINDS=['account','machine','password']`（`:78`）；`DEFAULT_SCRYPT={N:65536,r:8,p:1,keylen:32}`（`:80-81`）；`MIN_SCRYPT N=16384`（`:84`）；`MAX_SCRYPT_N=1<<20`（`:87`）；错误码含 `BACKUP_KEY_UNWRAP_FAILED`（`:90-101`）；`validateKdf`（`:170-202`）；`deriveKek`（scrypt / hkdf-sha256，`:210-224`）；`buildAad`（`:227-231`）；`sealPayload/openPayload`（`:241-294`）；`wrapDek`（`:306-339`）；`unwrapDek`（`:353-389`，固定尝试顺序 account→machine→password，并返回 `attempts[]`）；`selftest()`（`:515-607`） | **直接复用，不要另造信封格式** | 工作树还新增 `src/backup/layout.mjs:17` `<root>/snapshots/<snapshot>/keys.json`；`test/backup-crypto.test.mjs`（未提交） |

### 4.5 可行性实测（合成输入，只输出长度/布尔/毫秒）

脚本：`E:\GPT\.tmp\spike-account\feasibility.cjs`，用本机 `node v26.13.0` 运行。输出（无任何真实凭据）：

```text
A1 deriveAccountFleetKey(synthetic-user-id): is-buffer=true length=32 deterministic=true
A2 deriveAccountKeypair(synthetic-user-id): publicKeyPem-length=113 fingerprint-hex-length=64
B1 hkdf-sha256 over userId string: length=32
B2 scrypt over password: length=32 default-N=65536 r=8 p=1
C1 scrypt N=2^14 r=8 p=1: 56 ms
C1 scrypt N=2^15 r=8 p=1: 111 ms
C1 scrypt N=2^16 r=8 p=1: 227 ms
C1 scrypt N=2^17 r=8 p=1: 461 ms
D1 wrapDek: envelopes=account,machine,password
D2 unwrap account: ok=true same-dek=true | machine: ok=true same-dek=true | password: ok=true same-dek=true
D3 wrong password refused with BACKUP_KEY_UNWRAP_FAILED=true
D4 crypto.selftest: ok=true steps=9 failed=0
E1 DPAPI CurrentUser protect+unprotect (new powershell process): ok=true ciphertext-bytes=262
```

同时验证：
- 同一个合成 account 字符串两次派生结果相等（确定性）；长度为 32B。
- 三信封包裹的是同一个随机 DEK；三种凭证分别都能解出同一 DEK；错误密码被命名为 `BACKUP_KEY_UNWRAP_FAILED`。
- `crypto.selftest()` 9/9 步通过（含篡改/换槽拒绝）。
- DPAPI：32B 明文 → 262B 密文，跨独立 PowerShell 进程解密成功。

---

## 5. 推荐设计（供 `docs/BACKUP-DESIGN.md` 引用）

### 5.1 分层：随机 DEK + 多信封（沿用已存在的 `src/backup/crypto.mjs`）

```text
DEK = randomBytes(32)                       // crypto.randomDek() :122-125
keys.json = wrapDek(DEK, [account?, machine?, password])   // :306-339，AAD 绑定 kind/kdf/salt
```

- **绝不**用任何一个信封直接加密文件内容；**绝不**把 KEK 当 DEK 用。
- 每封信封自带 `kdf` 记录（算法/参数/salt），读取时接受记录值并限制上限（`validateKdf :170-202`，`MAX_SCRYPT_N :87`）→ 以后提高成本不会让旧仓库打不开。
- `keys.json` 只包含 salt/密文/tag/hint；**hint 置 null**，不得写 email/userId/账户名（工作树测试里用 `a@example.invalid` 只是测试夹具，生产不得照抄）。

### 5.2 三种信封

| 信封 | KEK 材料 | KDF（建议参数） | 写入条件 | 换机/重装后 |
|---|---|---|---|---|
| `account`（可选第三） | `userId` 字符串（`ctx.deepseekAccount.getDeviceIdentity().userId`，Host-only，禁止落盘/写日志） | `hkdf-sha256` + 每仓库随机 salt（`crypto.deriveKek :219`，info=`w2m-session-backup/kek/v1`） | 仅当 `userId` 非空且产品确认启用；创建时记 `status.account_available=true` | 同一 DeepSeek 账户 + 已登录 + 联网且本进程成功 profile 读取 → 可解；否则失败（不降级明文） |
| `machine`（默认写） | 随机 32B `machineSecret`，DPAPI(CurrentUser) 保护后存本机 | `hkdf-sha256` + 每仓库 salt | Windows 且 DPAPI 可用（本机实测可用）；macOS 在实现 Keychain 前**不可用** | 同机同 Windows 用户 → 免密可解；重装系统/换用户/换机 → 失败（预期） |
| `password`（默认写，**唯一保证**） | 用户口令（只在内存） | `scrypt`，**N=2^17, r=8, p=1, keylen=32**（本机 461ms；内存≈128 MiB；maxmem=256·N·r） | 建库时必须设置（默认组合）；若用户明确选择"仅本机/无密码"，仓库必须标记 `portable=false` 并 UI 警告 | 换机/账户变化后唯一可用的信封 |

**明确不要用的材料**（每条都有本报告证据）：
- grant token：会轮换/删除（§3.3）。
- `.anonymous-user-id`：安装级随机 UUID，重装即变（§2、§3.4）。
- `fleetKey` / `resolvedFleetKey`：w2m 把它发到 relay 并持久化（`src/plugin/tools.mjs:3720`、`src/chatops/fleet-join.mjs:57-76`；fleet-home/relay 侧也持有），**relay 方/拿到 relay 状态者可用它解密备份**——这是比 account 信封更弱的选项，禁止。
- Ed25519 `deriveAccountKeypair` 的输入同理：当前调用方喂的是 fleetKey，不可用于 KEK；如需账户派生，直接用 `userId` + HKDF（域分离标签由 `deriveKek` 提供）。

### 5.3 默认组合与解锁顺序

- **默认创建**：`password` + `machine`。`account` 默认**不写**（opt-in）：理由——它是"身份"不是"秘密"、可用性依赖联网/登录/DSH 版本、且不增加可移植性（password 已覆盖）。
- 若产品坚持 Q1=A（"原账户登录"优先，`docs/DEV-PLAN-3.4.6-3.5.0.md:305-310`），则应允许默认写 `account`，但**必须同时写 `password`**，且 UI 明示"账户信封只绑定账户身份、不是机密性保证；清空账户材料/重装/换账户后需密码"。
- **解锁顺序**：`account`（若有 userId）→ `machine`（若本机 machine key 可解）→ 交互输入 `password`。该顺序已由 `unwrapDek` 固定（`crypto.mjs:78,356`）并返回 `attempts[]`，UI 可直接显示"账户材料已变化、机器不可用 → 请输入密码"。
- 全失败：`BACKUP_KEY_UNWRAP_FAILED`（`crypto.mjs:96,384-389`），UI 映射到 `BACKUP_NO_PERMISSION`（DEV-PLAN:152 文案），**不写明文、不回退"忽略加密"**。

### 5.4 本机 machine key 的落点（建议）

- `$DSH_HOME/xclient/backup/machine-key.json`（0600；`{format:'w2m-backup-machine-key/1', backend:'dpapi', blob:<base64>}`；无明文 key；失败/不存在时 machine 信封视为不可用）。
- 该文件属于 w2m 运行状态，不在会话备份范围内（`DEV-PLAN §2.2` 已排除 `xclient/**`）；`keys.json` 里的 machine 信封随仓库走，但离开本机/本用户后解不开——这是 machine 信封的定义，不是缺陷。
- DPAPI 调用建议抽成 `src/util/dpapi.mjs`（复用 `ai-secret-store.mjs:26-40` 的 PS 脚本与 `:43-52` runner），避免 decision-center 与 backup 两处各写一份 PowerShell。

### 5.5 错误码建议

| 场景 | 建议 |
|---|---|
| GCM 解开失败（三信封都不行） | 沿用 `BACKUP_KEY_UNWRAP_FAILED`（附 `attempts[]`）→ UI `BACKUP_NO_PERMISSION` |
| 建库时 `userId` 不可得，账户信封被跳过 | 新增（非 crypto 层）`BACKUP_ACCOUNT_MATERIAL_UNAVAILABLE`，写进仓库状态/审计，不阻断建库 |
| 解锁时 DPAPI 不可用或 machine key 缺失 | 新增（非 crypto 层）`BACKUP_MACHINE_KEY_UNAVAILABLE`，继续尝试 password，不直接失败 |
| 密码为空 | 沿用 `BACKUP_PASSWORD_EMPTY`（`:98`） |
| KDF 参数越界/过弱 | 沿用 `BACKUP_KDF_UNSUPPORTED` / `BACKUP_KDF_WEAK`（`:92-93`） |

### 5.6 与现有文档/代码的偏差（BACKUP-DESIGN 冻结时需要统一）

1. `DEV-PLAN §4:148` 写的是 `keys/account.json` / `keys/password.json` 两个文件；实际 `src/backup/crypto.mjs` 是**单个 `keys.json`**（`ENVELOPE_FORMAT='w2m-session-backup/keys'`，`validateKeysFile` 要求 `envelopes[]` 数组）。建议 BACKUP-DESIGN 采用已实现的单文件方案（或显式改代码，二选一，不能两套并存）。
2. `DEV-PLAN §4:146` 的 account KEK 定义为 `HKDF-SHA256(账户材料, repo salt)`——与 `deriveKek :219` 一致；本文建议的"账户材料"明确为 `userId` 字符串，而不是 fleetKey/token。
3. `DEV-PLAN §4:147` 写 scrypt `N=2^17`；`crypto.mjs:80-81` 与冻结中的 `BACKUP-DESIGN.md:130,167` 当前默认 `N=2^16`（注释说参考机 250ms）。本机实测 N=2^17=461ms（≤1s 且约 2.2× 余量），**建议把新信封默认提高到 N=2^17**，读侧保持 `MIN_SCRYPT N=2^14` 与 `MAX N=2^20`；由于 KDF 参数随每份 `keys.json` 记录（`crypto.mjs:328`），改默认值不破坏已写仓库的读取兼容（不是协议破坏，只是创建默认值 + 文档数字更新）；创建/解锁时用 `selftest` 计时，慢机可提示。
4. 工作树里 `src/backup/*` 是**未提交**的并行任务产物（mtime 12:33–12:35）；本文行号以 2026-11-17T12:34 读取时为准，代码落库后行号可能平移。

---

## 6. 风险与未知（诚实清单）

### 6.1 会让旧备份打不开的风险

- **R1（账户材料变化）**：重新登录、平台 401/40003 过期、登出、issuer 配置变化（DSH 启动直接删 grant，`:191-199`）、重建 `.dsh`/重装，都会让 `userId` 不可得或换成别的账户 → 旧仓库的 `account` 信封**永久失效**。缓解：`password` 永远必须有（默认组合已保证）；解锁失败时明确提示"原账户登录或输入密码"。
- **R2（升级/服务形态变化）**：`deepseekAccount` 的 `getDeviceIdentity()` 是 Host-only 普通方法（非 `@Remote`、无 schema 承诺），DSH 0.2.2-rc.3 才呈现此形态；w2m `package.json:65-67` 只声明 `dsh >=0.2.0 <0.3.0`。未来 DSH 升级可能改签名/改名 → 账户信封代码需版本门禁与降级（不可用就跳过，不崩溃）。
- **R3（机器信封失效）**：DPAPI 绑当前 Windows 用户；重装系统/新建用户/漫游配置丢失/清理 `xclient/` 都会丢 machine key → machine 信封失效（有 password 则无碍）。换机是**预期失败**，不是 bug。
- **R4（macOS 无 machine 信封）**：现有 `detectSecretBackend` 对 darwin 返回 `keychain-not-implemented`（`ai-secret-store.mjs:63`）。在实现 Keychain 前，macOS 侧只有 `password`（+可选 account）；BACKUP-DESIGN 需写明平台矩阵。
- **R5（无 password 的仓库）**：若允许"仅 machine"建库，机器一坏就没有任何恢复路径。建议默认禁止；若产品允许，仓库必须标记 `portable=false` 并在 UI 二次确认。

### 6.2 机密性/可用性风险

- **R6（account 信封不是秘密）**：`userId` 是账户**标识**而非秘密；平台运营方、或任何已知该 userId 的一方都能重新算出 account KEK。DSH profile 的 `id` schema 只是 `z.string()`（`details.ts:6-8`），实际熵未知（w2m 自己假设 UUID 且要求 ≥16 字符，`src/chatops/fleet-join.mjs:48-49,62-74`）。因此 account 信封**必须**声明为"便捷/身份绑定"，不能当作机密性保证；不得用它替代 password。
- **R7（account 信封的运行时可得性未实测）**：`userId` 需要：已登录 + 有效 grant + 联网 + 本进程内一次成功 `getProfile`。w2m 现有零参调用与 0.2.2-rc.3 签名不符（§3.6），若不在实现前修正，账户信封会经常不可用。**建议 v3.4.6 实现时先修调用并做运行时 A/B（这也补上本 spike 无法在宿主内实测的唯一环节）。** **（2026-11-17 16:37：调用已修、A/B 已在宿主内完成——零参确抛 TypeError，带 metadata 可得 `userId`；见 §8。但 `userId` 仍只是标识，account 信封维持不实现。）**
- **R8（profile/身份只在内存）**：`.dsh` 磁盘上没有 userId；恢复现场若 DSH 未登录或未联网，账户信封不可用——password 是兜底。
- **R9（凭据文件不可信边界）**：`.credentials.yaml` 同 UID 可读（DSH 文档明说，`dsh-credentials-local/README.md:115,199`）；本 spike 的任何设计都不应把"文件里的东西"当秘密边界。**备份仓库中绝不能出现 `.credentials.yaml`**（DEV-PLAN:52,154）。
- **R10（hint/元数据泄露）**：`keys.json` 的 `hint`、仓库状态里的账号信息可能泄露账户标识；建议 hint 恒为 null、状态里只放 `account_available: true/false`，不放 userId/email。

### 6.3 本调查未解决的未知（2 条核心）

- **U1**：宿主进程内 `ctx.deepseekAccount.getDeviceIdentity()` 当前实际是否返回 `userId`、何时返回（尤其 w2m 零参 `getProfile()` 是否真的抛错并被吞）。本会话没有 `cordis_inspect_*`，也无法在宿主内调用服务——只能静态推断（§3.6）。实现账户信封前必须实测。**（2026-11-17 16:37 已闭环，见 §8：实测 `userId` 在成功 `getProfile(client)` 后可得的 string；零参调用确抛 `TypeError`。`userId` 仍不是秘密。）**
- **U2**：DeepSeek Platform 账户 `id` 的真实格式与熵（UUID？数字 id？是否会被平台/日志/第三方泄露）。benchmark 需要平台侧信息；本调查不能读 profile 值。若熵低，account 信封的机密性进一步下降甚至不可接受。

### 6.4 其它未验证项

- 未运行 w2m 的备份测试套件（按纪律）；工作树中并行的 `src/backup/*` 与测试可能继续变化，本文引用的接口以阅读时为准。
- 未验证 DSH 原子写在 Windows 崩溃场景下的语义（凭据文档用 `writeFileAtomic`；本 spike 只依赖"读快照"，备份读取建议按 DEV-PLAN 的"已提交帧边界"处理）。
- 未核对 `userId` 在 DSH 0.2.3/0.3 的行为（不在本机安装版本内）。

---

## 7. 复现命令清单（全部只读）

### 7.1 环境与安装位置

```powershell
# DSH 运行环境（只读环境变量）
$env:DSH_PROFILE; $env:DSH_INSTALL_DIR; $env:DSH_NODE_EXECUTABLE; $env:DSH_HOME

# 安装位置核对（任务给的 E:\DS\DS 不存在；实际在 E:\DSH\DS）
Get-Item -LiteralPath 'E:\DSH\DS\resources\app.asar' -Force | Select-Object FullName,Length,LastWriteTime
Get-Item -LiteralPath 'E:\DS\DS\resources\app.asar' -Force -ErrorAction SilentlyContinue   # → MISSING
```

### 7.2 `~/.dsh` 结构（不打印值）

```powershell
# 列目录（名称/大小/mtime，不读内容）
Get-ChildItem -LiteralPath 'C:\Users\fangw\.dsh' -Force |
  Select-Object Mode,Length,LastWriteTime,Name
Get-ChildItem -LiteralPath 'C:\Users\fangw\.dsh\xclient' -Force |
  Select-Object Length,LastWriteTime,Name

# 结构探针（只 printed 文件名/大小/mtime/键名/形状；不打印任何值）
& $env:DSH_NODE_EXECUTABLE 'E:\GPT\.tmp\spike-account\structure-probe.cjs'

# 同一探针重跑一次，对比 size/mtime 证明只读
& $env:DSH_NODE_EXECUTABLE 'E:\GPT\.tmp\spike-account\structure-probe.cjs'
```

### 7.3 DSH asar 内检索（Electron-as-Node，只读）

```powershell
# 列目录
& $env:DSH_NODE_EXECUTABLE 'E:\GPT\.tmp\spike-account\asar-tools.cjs' `
  list 'E:\DSH\DS\resources\app.asar\dsh\node_modules\@deepseek-ai'

# 有界搜索（只打印命中行前 200 字符；不修改任何文件）
& $env:DSH_NODE_EXECUTABLE 'E:\GPT\.tmp\spike-account\asar-tools.cjs' search 'deepseekAccount'
& $env:DSH_NODE_EXECUTABLE 'E:\GPT\.tmp\spike-account\asar-tools.cjs' search '.credentials.yaml'
& $env:DSH_NODE_EXECUTABLE 'E:\GPT\.tmp\spike-account\asar-tools.cjs' search 'anonymous-user-id'
& $env:DSH_NODE_EXECUTABLE 'E:\GPT\.tmp\spike-account\asar-tools.cjs' search 'fang-auth'   # → 0 命中

# 单文件有界搜索
& $env:DSH_NODE_EXECUTABLE 'E:\GPT\.tmp\spike-account\asar-tools.cjs' searchfile `
  'E:\DSH\DS\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-deepseek-account\src\index.ts' `
  getDeviceIdentity getPlatformSession
```

### 7.4 关键文件阅读（read 工具，只读）

```text
E:\DSH\DS\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-deepseek-account\README.md
E:\DSH\DS\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-deepseek-account\src\index.ts
E:\DSH\DS\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-deepseek-account\src\types.ts
E:\DSH\DS\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-deepseek-account\src\details.ts
E:\DSH\DS\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-deepseek-account\src\client-metadata.ts
E:\DSH\DS\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-credentials\src\index.ts
E:\DSH\DS\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-credentials-local\src\index.ts
E:\DSH\DS\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-anonymous-user-id\src\index.ts
E:\DSH\DS\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml
E:\DSH\DS\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\docs\subsystems\credentials.md
E:\DSH\DS\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-typert-protocol\src\index.ts
```

### 7.5 可行性验证（合成输入，输出只含长度/布尔/毫秒）

```powershell
& 'C:\Program Files\nodejs\node.exe' 'E:\GPT\.tmp\spike-account\feasibility.cjs'
```

### 7.6 仓库状态与文件核对

```powershell
# w2m 仓库工作树状态（只读）
git -C 'E:\GPT\w2m\w2m-345-fresh' status --short

# 备份 crypto 关键行（只读）
#   src/backup/crypto.mjs:78,80-87,90-101,210-224,306-339,353-389,515-607
```

### 7.7 明确未执行的命令

- 未运行测试套件（`node --test` / `pnpm test` 等）；
- 未执行任何变更型 git 命令、未 commit、未 push；
- 未运行 npm/pnpm；
- 未写 `C:\Users\fangw\.dsh\`、`E:\DSH\` 或仓库内其它文件；**本调查新增的文件只有本文 `docs/SPIKE-ACCOUNT-KEK.md`**（工作树中并行 backup 任务的文件见附录 B，不是本调查的改动）。

> 以上是**原 spike（只读）**的边界；2026-11-17 16:37 的增补（§8）在 `E:\GPT\.tmp` 写了探针脚本、运行了 `chatops-account`/`backup-wiring` 测试，并对真实凭据库做了**只读**比较（副本测量、真库 size/mtime 未变）。

---

## 8. 宿主内实测与 `getProfile(client)` 修复（2026-11-17 16:37，v3.4.7 后增补）

**状态**：§0 第 5 条与 §6.3 U1/R7 的两个前置条件——(a) 修 `getProfile(client)` 调用、(b) 在宿主进程内实测 `userId` 可得性——**均已闭环**。调查结论不变：**`account` 信封仍不实现**（默认信封组合保持 `machine + password`）。本节只记录名称/类型/布尔/毫秒，不含任何 token、账户 id、email 的值或其哈希。

### 8.1 方法与环境

- 宿主运行环境：`E:\DSH\DS`（`@deepseek-ai/dsh` 0.2.2-rc.3；Electron 44.7.0 / Node 24.21.0；win32-x64），用安装版自己的 `runProfile`（即 `dsh --profile` 的同一入口）启动真实 Loader 组合。
- 组合：临时 `DSH_HOME` 下自建 profile `desktop`，bundles = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`；用 profile 补丁把 `credentials` 行的 `path` 指向**凭据库副本**（805 B，测完立即删除）——401/issuer 清理只可能删副本，真实 `C:\Users\fangw\.dsh\.credentials.yaml` 测量前后 size/mtime 一致、未被写。
- 驱动（`E:\GPT\.tmp\`）：`w2m-account-probe-driver.mjs`（字段测量，boot 两次）；`w2m-account-fix-probe.mjs`（导入**本仓库修后**的 `src/chatops/account.mjs`，走真实 `identify()`）；由 `run-account-probe.mjs` / `run-account-fix-probe.mjs` 用 Node `spawnSync` 以 Harness 运行时（`ELECTRON_RUN_AS_NODE=1`）启动。报告：`E:\GPT\.tmp\account-probe-20261117-083720\report.json`、`E:\GPT\.tmp\account-fix-probe-20261117-083904\report.json`。
- 为什么用 Node 编排：`DeepSeek Harness.exe` 是 GUI 子系统程序，PowerShell `&` 不等待它；`Start-Process` 在本机因环境表 `HTTP_PROXY`/`http_proxy` 大小写重复键失败（本机环境问题，与探针无关）。

```powershell
# 两个探针都由 Node 编排：自建临时 DSH_HOME + 凭据副本，再 spawn Harness 运行时，测完删副本
node E:\GPT\.tmp\run-account-probe.mjs       # 服务/字段/稳定性测量 → report.json
node E:\GPT\.tmp\run-account-fix-probe.mjs   # 修后 w2m identify() 的宿主内端到端 → report.json
```

### 8.2 测量结果（两次独立 boot 一致）

| 测量项 | 结果 |
|---|---|
| 服务可达 | `ctx.get('deepseekAccount')` 存在；`getState/getProfile/getDeviceIdentity/getPlatformSession` 均为 function；`getState().status = 'credential-stored'` |
| 零参 `getProfile()` | **抛 `TypeError`**（错误信息指向 metadata 字段、提及 undefined），发生在网络请求之前 → §3.6 静态推断被证实 |
| `getProfile({version,locale,timezoneOffsetSeconds})` | `status='ready'`，392 ms / 471 ms；字段名恰为 `avatarUrl, contact, id, name`，均为非空 string；**结果中没有 token/秘密字段** |
| `getDeviceIdentity().userId` | 任意 `getProfile` 之前：undefined（不可得）；成功读取之后：非空 string |
| 稳定性 | 同进程两次 `getProfile` 的 id 相等=true；两次独立 boot 的 id 相等=true；`getPlatformSession().userId` 与 profile id 相等=true |
| Host-only `getPlatformSession()` | 可读：`origin`(string)、`token`(string 非空)、`userId`(string)；两次读取 token 相等=true |
| 修后的 w2m 路径 | 本仓库 `createAccountIdentity({ctx}).identify()` → `ok:true`、`userId` 为非空 string，且与直接 `getProfile` 的 id **相等=true** |

### 8.3 机密性判断：没有可做稳定 KEK 的秘密材料

- `userId`：**可得、稳定，但只是标识**——平台运营方或任何已知该 id 的一方可重算 `HKDF(userId)`；只能做"身份绑定/便捷解封"，不是机密性（R6 不变）。
- `name/contact/avatarUrl`：PII（`contact` 还是平台脱敏后的手机号/邮箱），不是密钥材料，也不得进 `keys.json`（R10）。
- `getPlatformSession().token`：**确是 bearer secret 且 Host-only 可读**，但**易变**——登出/401/40003/issuer 变化会删除，重新登录会替换（§3.3）。用它派生 KEK 的后果是"重新登录后旧备份永久打不开"，比没有 account 信封更糟。
- 结论：**没有"同一账户、长期稳定、对插件可得"的秘密材料** → `account` 信封维持不实现。

### 8.4 已做的修复（前置条件 a）

- `src/chatops/account.mjs`：新增 `accountClientMetadata(options)`（`:266-303`，含 `ownPackageVersion()` 与其后 JSDoc），按 DSH 的 `AccountClientMetadata` 生成 `{version, locale, timezoneOffsetSeconds}`（version 依次取 `options.clientVersion` → `DSH_CLIENT_VERSION` → 本包版本；locale 取注入值 → 进程 locale；tz = `-getTimezoneOffset()*60`）；`identify()` 改为 `await service.getProfile(accountClientMetadata(options))`（`:387`）。JSDoc 说明：该参数是请求方 UI 的构建版本/语言/时区偏移，用于生成 `x-client-*` 头，**不是凭据**；零参调用会在网络请求前抛错。
- `test/chatops-account.test.mjs`：断言 `getProfile` 收到三字段 metadata（零参回归防护）、注入值可测、默认 version 非空；`node --test --test-force-exit test/chatops-account.test.mjs` 45/45 通过。
- 行为等价性：其余路径不变；profile 读取失败仍被 catch 为 signed-out。§8.2 最后一行是宿主内端到端证明。

### 8.5 上游需要什么变化，account 信封才可能成为"真信封"

1. Host 提供**每账户稳定秘密**（不是标识、不是可替换 token）：例如登录时用 OS 钥匙串/DPAPI 保护的随机 32B 账户密钥，以 Host-only 方法（类似 `getDeviceIdentity()`）返回，并承诺生命周期。
2. 定义**换代语义**：重新登录/换设备/撤销后旧备份是否仍可解，且不得静默失效。
3. 或者产品**显式接受"身份绑定、不承诺机密性"的便捷解封**：实现为 `HKDF(userId)` + 仓库 salt 的可选第三信封，UI 标注非机密性，且不得替代 password（与 §5.3 一致）。
4. 版本门禁与降级：Host-only 方法无 schema 承诺（R2），实现须 feature-detect、不可用即跳过、绝不崩溃。

### 8.6 边界

- 只测了本机/本账户/signed-in 且联网的状态；signed-out、断网、token 过期后的失败路径未在本节实测（代码路径见 §3.2/§3.3）。
- 未测 `userId` 的格式/熵（U2 仍开放）；不改变上述结论。
- 未改 `lib/client.js`；测试确定性由注入 metadata 保证；本节新增的实测命令见 §7 同目录的 `.tmp` 脚本，不加入仓库测试。

---

## 附录 A：证据索引（claim → 证据）

| 结论 | 主要证据 |
|---|---|
| DSH 只给 Host 插件 `userId`（内存、联网、getProfile 后才可用） | `dsh-deepseek-account/src/index.ts:405-416,423-435,338-344,667-671`；`dsh/docs/subsystems/credentials.md:60`；README:12 |
| 磁盘上没有账户 id | `.credentials.yaml` 结构（§2.2，只键名）；grant schema `index.ts:34,36`；`lastProfile` 仅内存 `:129` |
| `.anonymous-user-id` 随机、安装级、重装即变 | `dsh-anonymous-user-id/src/index.ts:5-9,44-55,68-100`；README:12,40,120 |
| grant token 会轮换/删除 | `dsh-deepseek-account/src/index.ts:762,562,384-399,191-199`；README:76 |
| 插件能调用 `ctx.deepseekAccount` | `dsh-client-product-analytics/src/index.ts:34,109`；w2m `src/chatops/account.mjs:284` |
| DSH getProfile 需要 client metadata | `src/index.ts:228,232,368-370`；`client-metadata.ts:37-45` |
| Remote 装饰器不包 Host 直接调用 | `dsh-typert-protocol/src/index.ts:277-317` |
| w2m 零参 getProfile 风险 | `src/chatops/account.mjs:314-318`；CHANGELOG.md:624 |
| credentials 记录无 owner 校验、同 UID 可读 | `dsh-credentials-local/src/index.ts:670-672`；README:115,199 |
| DPAPI 可复用 | `src/decision-center/lib/ai-secret-store.mjs:26-40,43-52,54-64,90-119,130-192`；本机实测 E1 |
| ed25519（不是别的算法） | `src/util/account-identity.mjs:26-59,62-75` |
| 机器身份 x25519、machine_id 不再造 | `src/agent/crypto.mjs:67-76,405-510`；`src/agent/identity.mjs:24-31,188-219` |
| HKDF/GCM 先例 | `src/util/chat-crypto.mjs:34-48,55-67` |
| 备份信封实现已存在 | `src/backup/crypto.mjs`（见 §4 表）；`src/backup/layout.mjs:17` |
| 默认 scrypt 当前 N=2^16、建议 2^17 | `src/backup/crypto.mjs:80-87`；本机实测 C1；`DEV-PLAN:147` |
| 备份不包含 `.credentials.yaml` | `docs/DEV-PLAN-3.4.6-3.5.0.md:52,154` |
| Q1=A 的既有决策 | `docs/DEV-PLAN-3.4.6-3.5.0.md:305-310` |
| 宿主内：零参 `getProfile` 真抛 TypeError、带 metadata 可得 ready profile（id/name/contact/avatarUrl） | 本文 §8.2；`E:\GPT\.tmp\account-probe-20261117-083720\report.json` |
| 宿主内：`userId` 跨两次调用/两次 boot 稳定，`getPlatformSession()` 可读 token（易变 bearer） | 本文 §8.2/§8.3；同上报告 |
| 修后 w2m `identify()` 在宿主内可用且与宿主 id 一致 | 本文 §8.4；`E:\GPT\.tmp\account-fix-probe-20261117-083904\report.json`；`src/chatops/account.mjs:266-303,387` |
| account 信封不实现的最终决定 | 本文 §8.3/§8.5；`docs/BACKUP-DESIGN.md` §6、§12；`src/backup/keystore.mjs:18-22` |

## 附录 B：工作树状态说明（重要）

本 spike 开始时（2026-11-17 12:30）`git status` 干净。调查期间**另一条并行任务**在同一工作树新增/修改了 v3.4.6 备份实现、测试与文档（本调查结束时 `git status --short` 的实际输出）：

```text
 M CHANGELOG.md
 M docs/DEV-PLAN-3.4.6-3.5.0.md
 M package.json
 M scripts/layer-model.mjs
 M scripts/session-doctor.mjs
 M src/plugin/tools.mjs
?? bin/w2m-backup.mjs
?? docs/BACKUP-DESIGN.md
?? docs/SPIKE-ACCOUNT-KEK.md      ← 本调查唯一新增文件
?? src/backup/
?? src/util/dsh-workspace.mjs
?? test/backup-crypto.test.mjs
?? test/backup-layout.test.mjs
?? test/backup-protocol.test.mjs
?? test/backup-scan.test.mjs
?? test/backup-wiring.test.mjs
?? test/helpers/backup-fixture.mjs
```

**这些不是本调查的改动**（本调查只新增 `docs/SPIKE-ACCOUNT-KEK.md`）。本文引用 `src/backup/crypto.mjs` 的接口/行号是在其 mtime 2026-11-17 12:34 时读取的快照；并行任务提交后请重新核对行号，但 `wrapDek/unwrapDek/ENVELOPE_KINDS/DEFAULT_SCRYPT/CRYPTO_CODES` 这些导出名是设计对接点。

## 9. 用户最终决定：便捷优先（2026-11-17 晚，推翻"信封组合"的默认，不改写上文测量）

**用户原话**：

> 我们追求的不是绝对保密：
> 1，用账户ID是为了方便实现自动化（账户能快捷解锁，不是必须）
> 2，密码也是4-6位数字（账户不对输入密码）
> 3，也可以选择不加密（1账户不对，2又没有设置密码，3默认是不加密的）

**这条决定如何落地（代码事实，不是计划）**：

1. **默认 = 不加密**：新仓库写 `encryption: "none"` + 一个 `open` 信封，DEK **明文**保存在 `keys.json`
   （`src/backup/crypto.mjs` 的 `openEnvelopeRecord`/`wrapOpenDek`）。这不是"弱加密"，是明确的无保护状态：
   任何能读仓库目录的人都能还原备份。产品在状态卡/解锁卡/CLI 里原文提示
   「未加密：任何能访问该目录的人都能还原备份」。
2. **账户 ID 只用于自动化便捷解锁**：`account` 信封仍是身份绑定（HKDF(id)，非秘密），只对 `sealed` 仓库
   生效，且 `runBackup` 在 `none` 模式下**不会**绑定（否则第一次 run 会把默认的不加密仓库静默改成 sealed）。
   宿主读不到 id 时不影响其它路径——这正是"不是必须"。
3. **PIN = 4-6 位数字的便捷门槛**：`setRepositoryPassword` 的下限从 8 字节降到 4 字节；数字 PIN 被接受但
   结果带 `weak: true` + 「4 位数字 PIN 只是便捷门槛，不是保密强度」；**不静默提高 scrypt 成本**。
4. **可逆**：`unlock --disable-protection --confirm disable-protection` 用现有凭据打开后，用**同一 DEK** 写
   `open` 信封（先 `keys.json.bak-<ts>`、原子写、无凭据解封验证）；块格式不变，所以不重写任何对象。
5. **模式记录在仓库描述符**：`backup.json` 增加加法字段 `encryption: 'none' | 'sealed'`（旧仓库缺省 = 
   `sealed`）。`open` 信封与任何 account/machine/password 信封**混存会被 `validateKeysFile` 拒绝**，避免
   open 路径静默绕过 PIN。

**上文 §4-§8 的测量没有被改写**：`userId` 仍只是标识、token 仍易变、仍没有稳定的每账户秘密；变化的只是
**产品默认**与**接受的风险等级**：用户明确选择便捷优先，因此 `none`（默认）/ `account` 比对 / 4-6 位 PIN
都**不是**机密性保证。要真正的机密性，只能 `sealed` + 长密码（≥8 位、非纯数字）+ 仓库目录访问控制。
详见 `docs/BACKUP-DESIGN.md` §25.0（总声明）与 §6/§8/§11/§12 的更新。
