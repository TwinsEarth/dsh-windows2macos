# 备份&还原设计（`w2m-session-backup/v1`）

> 状态：**v3.4.6 协议冻结**。本文定义仓库布局、清单格式、块切分、加密信封、错误码与兼容承诺。
> 后续版本只能**新增字段**，不能改既有字段语义（§9）。
> 相关文档：[会话找回复盘](RETRO-SESSION-RECOVERY-20261117.md)、[账户材料 spike](SPIKE-ACCOUNT-KEK.md)、[开发计划](DEV-PLAN-3.4.6-3.5.0.md)。

## 1. 目标与非目标

**目标**

1. 把 `$DSH_HOME` 里**不可再生的东西**（会话日志、附件对象、工作区索引）完整备份到 `D:\DeepSeekHarness\BackUP`，默认每天 22:00（时区可配）。
2. 还原后 **DSH 能直接打开**——不是"文件回去了"，而是"侧边栏看得见、点得开、能继续对话"。
3. **三种保护状态（不是绝对保密，§25.0）**：默认 `none`（不加密；DEK 明文在 `keys.json`，任何人读到仓库目录即可还原）、`sealed` + 账户 ID 比对（同账户快捷解锁）、`sealed` + 4-6 位数字 PIN（账户不匹配时的便捷门槛）。`sealed` 下解锁走**账户 / 本机 / PIN** 信封，任一条可用即可；无权限时给具名提示而不是 EPERM。
4. 会话被**持续写入**时也能安全备份（只读快照语义，绝不改源文件）。

**非目标（v1 明确不做）**

- 不备份工作区里的项目源码（`workspace path` 下的文件）——它属于 git，不属于 DSH 状态。
- 不备份派生缓存（§5），包括 `sessions/.event-cache/` 与 `storages/session_projcache/`。
- 不提供"事件级合并"：备份只存**原始字节**。要改事件内容，那是 `dsh-fix` 的职责，且必须过医生门禁（§7 G1）。
- 不做云端/Relay 异地副本（v3.5.0 只做到网络盘/SMB）。

## 2. 为什么先冻结协议（而不是先写引擎）

2026-11-16/17 的会话找回实战里，四类失败全部来自"边写边改格式"：注册表被客户端回写、zstd 首帧混装、`surfaceOp` 缺失、`seq` 引用失效。备份的问题更严重——**仓库比进程活得久**。一份 2026 年写出的仓库，可能在 2027 年由另一个版本还原；如果字段含义漂移，那不是报错，是静默丢数据。所以 v3.4.6 只交付"形状"：布局、清单、加密、只读扫描，一行写盘逻辑都没有。

## 3. 仓库布局

```
<root>/backup.json                             描述符：format/version/block_size/cipher/encryption（明文）
<root>/objects/<aa>/<sha256>                   内容寻址的加密块（去重单元，明文块哈希命名）
<root>/snapshots/<snapshot_id>/manifest.json   路径/大小/时间/哈希（明文，不含消息正文）
<root>/keys.json                               仓库级 DEK 的加密信封（权威副本；v3.4.7）
<root>/snapshots/<snapshot_id>/keys.json       同一份信封的副本（快照可独立还原）
<root>/current/<workspace>/<session>.json      当前版本指针：rel/sha256/blocks/snapshot_id
<root>/old/<workspace>/<session>/<ts>-<sha12>.json   被取代版本的可还原记录（v3.4.7 轮转）
<root>/archive/<date>/archived-sessions-<ts>.tar.zst 归档会话打包（v3.4.8）
<root>/index.jsonl                             追加式快照日志：只有 id 与计数，没有路径
<root>/tmp/                                    临时区；backup.lock 也在这里（单写者锁）
```

**v3.4.7 对布局的三处细化**（协议还没发布，在 v1 内提前定稿并记录理由）：

1. **DEK 属于仓库，不属于快照**：块是内容寻址的，跨快照复用（一个会话增长 10%，其余块全部复用）要求新旧快照能用同一把钥匙解密。所以 DEK 在首次运行生成，权威信封存 `<root>/keys.json`，每个快照再存一份**副本**——副本让"一个 snapshot 目录 + objects/"可以独立还原，代价只是每个快照多几百字节。
2. **`old/` 存可还原记录，不存整文件加密副本**：整文件副本（原计划的 `.zst.enc`）会把同一份字节在 `objects/` 之外再存一遍，114 MB 的会话每天变化就会为十份保留窗口累积 1.1 GB——正好抵消内容寻址去重。记录里只有 rel/size/sha256/blocks/snapshot_id，还原时从 `objects/` 取字节，体积为几百字节。
3. **`current/` 存指针，不存副本**：同上；"这个会话现在是哪个版本"是一个指针问题。

默认根目录：Windows `D:\DeepSeekHarness\BackUP`；其它平台 `~/DSH-BackUP`。优先级：显式配置 > `W2M_BACKUP_DIR` > 平台默认。

**布局拒绝的事（每条是具名错误码，不是 EPERM）**

| code | 何时 | 为什么单独一个码 |
|---|---|---|
| `BACKUP_DIR_UNRESOLVED` | 配置给了非字符串 / 空 | 配置错误，不是权限问题 |
| `BACKUP_DIR_INSIDE_SOURCE` | 根目录在 `$DSH_HOME` 里 | 仓库会把自己备份进去，首次运行就指数膨胀 |
| `BACKUP_PATH_IS_FILE` | 目标是文件 | 目标搞错了，先说清楚 |
| `BACKUP_DRIVE_MISSING` | 盘符/父目录不存在 | 运维错误，改权限没用 |
| `BACKUP_DIR_NOT_WRITABLE` | 存在但不可写（含写探针失败） | 权限问题，换目录或修 ACL |
| `BACKUP_DIR_NOT_A_REPO` | 目录里有别家 `backup.json` | **绝不**在别人的数据上初始化 |
| `BACKUP_DESCRIPTOR_UNREADABLE` | 描述符存在但不是 JSON/结构不对 | 可能是损坏，需要人看一眼 |
| `BACKUP_REPO_VERSION_UNSUPPORTED` | 仓库版本高于本程序 | 新版语义可能被误读，只读不写 |

`backup.json`（描述符）：

```json
{
  "format": "w2m-session-backup",
  "version": 1,
  "block_size": 4194304,
  "cipher": "aes-256-gcm",
  "created_at": "2026-11-17T00:00:00.000Z"
}
```

## 4. 清单（manifest）格式 v1

字段列表**冻结**，`validateManifest` 对未知键直接拒绝（拼写错误不许静默忽略）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `format` | string | 固定 `w2m-session-backup/manifest` |
| `version` | integer | 固定 `1` |
| `snapshot_id` | string | `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`，目录名 |
| `created_at` | string | ISO 时间 |
| `dsh_home` | string | 备份来源（仅本机文档用；不含凭据） |
| `block_size` | integer | 固定 `4194304`（4 MiB） |
| `block_algo` | string | 固定 `sha256` |
| `cipher` | string | 固定 `aes-256-gcm` |
| `counts` | object | `files/bytes/blocks/block_bytes/sessions/attachments`，**必须**与 `files` 自洽 |
| `files` | array | 文件条目，按 `rel` 升序，`rel` 大小写不敏感唯一 |
| `registry` | object | `workspaces/registered/archived/pinned` 四个计数 |
| `exclusions` | array | `{rel, reason}`，把"没备份什么、为什么"写进数据 |

**文件条目**

| 字段 | 类型 | 说明 |
|---|---|---|
| `rel` | string | POSIX 相对路径；拒绝绝对路径、`..`、反斜杠、空段、UNC |
| `kind` | string | `session` \| `attachment` |
| `size` | integer | 字节 |
| `mtime_ms` | number | 源文件 mtime（还原冲突判断用） |
| `sha256` | string | 全文件 sha256（64 位小写 hex） |
| `blocks` | array | `{index, offset, length, sha256}`，offset 从 0 连续、长度之和 == size、`index` == 下标 |
| `session_id` / `workspace` / `format_version` / `flags` | | 仅 `session`；`rel` 必须以 `sessions/<workspace>/<session_id>/` 开头 |
| `attachment_id` | string | 仅 `attachment`；`rel` 必须 == `attachments/v1/objects/<aa>/<id>` 且 `aa == id[0..2]` |

**为什么清单是明文**：它只含路径、大小、时间和哈希，不含任何消息正文；而 `status`/`scan` 需要在**未解锁**时展示"备份了多少、什么时候"。代价是路径会暴露会话 id 与工作区名——这一点写在 §8 威胁模型里，不假装没有。正文在块里，块才是加密的。

**索引行（`index.jsonl`，v1 冻结）**：快照提交后追加一行，只有计数与摘要，不含任何路径/工作区名——`status` 因此可以在未解锁时展示"备份了多少"，而 `verify`（v3.4.8）用 `digest` 把索引与清单串起来。

| 字段 | 类型 | 说明 |
|---|---|---|
| `format` | string | 固定 `w2m-session-backup/index` |
| `version` | integer | 固定 `1` |
| `snapshot_id` | string | `YYYYMMDDTHHMMSSZ-<8 hex>`，字典序 = 时间序 |
| `created_at` | string | ISO 时间 |
| `files` / `bytes` / `blocks` / `sessions` / `attachments` | integer | 全部由清单推导，不单独记录 |
| `digest` | string | 清单 canonical JSON 的 sha256 |

尾部半行（append 时崩溃）被读成 `torn_tail` 而不是"索引损坏"：快照仍在磁盘上，可以重新索引；中间某行损坏则逐行报告，其余行照常可读。提交时 **append 后立刻回读校验**——索引是"某个快照已提交"的唯一记录，半写必须在提交时就发现，而不是等到还原那天。

**块切分**：固定 4 MiB 定长切块（不滚动哈希）。勘察显示跨会话去重率 **0%**（不同会话内容本就不重复），去重收益全部来自**同一会话的历史版本之间**；定长块在这种 append-only 场景下已经能复用除尾部块外的全部数据（172 MB 中 153.8 MB 可复用），滚动哈希只增加实现风险。

## 5. 备份范围与排除

| 备份 | 路径 |
|---|---|
| 会话日志 | `sessions/<workspace>/<session>/session.vN.jsonl.zstd` |
| 附件对象 | `attachments/v1/objects/<aa>/<sha256>` |
| 工作区索引 | `storages/workspace.json`（作为**参考**写入清单 registry 计数；还原按 §7 G2 协议写回） |

| 排除（`EXCLUSIONS`，报告里带理由） | 原因 |
|---|---|
| `sessions/.event-cache` | 日志的派生投影，客户端会重建；还原它等于还原一个过期视图 |
| `storages/session_projcache` | 会话列表/标题的投影缓存，不是状态 |

## 6. 加密信封

一个备份用**一把随机 32 字节 DEK**；DEK 不被密码派生，而是被"包裹"成多份信封，随快照保存为 `keys.json`：

```json
{
  "format": "w2m-session-backup/keys",
  "version": 1,
  "created_at": "...",
  "envelopes": [
    { "kind": "account",  "kdf": { "algo": "hkdf-sha256", "keylen": 32, "salt": "base64" },
      "sealed": { "alg": "aes-256-gcm", "nonce": "base64", "ciphertext": "base64", "tag": "base64" }, "hint": null },
    { "kind": "machine",  "kdf": { "algo": "hkdf-sha256", ... }, "sealed": {...} },
    { "kind": "password", "kdf": { "algo": "scrypt", "N": 65536, "r": 8, "p": 1, "keylen": 32, "salt": "base64" }, "sealed": {...} }
  ]
}
```

| 信封 | 材料来源 | 作用 | 可得性 |
|---|---|---|---|
| `open` | **DEK 明文**写在 `keys.json` 的 `open` 记录里（无 KDF、无 sealed 负载） | **不加密**（默认）：不需要任何凭据即可解封 | 一直可得；**等于没有机密性**：任何能读仓库目录的人都能还原（§25.0） |
| `account` | HKDF(`w2m-account-binding|<accountId>`)：账户**标识**，不是秘密（§25） | 身份绑定：同账户免密（比对 id，一致放行） | 宿主能读到 `userId` 时；**不承诺机密性** |
| `machine` | 本机随机 key，由 OS 钥匙串/DPAPI 保护 | 同机免密 | Windows 可得（DPAPI）；macOS 未实现 |
| `password` | 用户 PIN/密码（4-6 位数字是预期用法），scrypt | 换机/清材料/账户不一致时的便捷门槛 | **必须永远可用**；**不是保密强度**（§25.0） |

**保护状态（2026-11-17 用户最终决定，见 §25.0）**：仓库级模式记在 `backup.json` 的加法字段
`encryption: 'none' | 'sealed'`（旧仓库没有该字段 = `sealed`）。**新建仓库默认 `none`**（`open` 信封，DEK
明文）；只有调用方明确要求（提供 PIN/密码、`machineKey: true`、可解析的账户 id 绑定，或显式
`run --encrypt sealed` / `backupEncryption: sealed`）才建 `sealed` 仓库。`open` 记录**绝不与任何凭据信封
混存**：`validateKeysFile` 具名拒绝（否则 open 路径会静默绕过已设置的 PIN）。把 `sealed` 转回 `none` 的显式
命令是 `w2m-backup unlock --disable-protection --confirm disable-protection`（同一 DEK，不重写任何块）。

**spike 之后的结论（2026-11-17，见 `docs/SPIKE-ACCOUNT-KEK.md` §0）**

1. DSH 0.2.2-rc.3 只向 Host 提供账户**标识** `userId`（仅内存缓存、需已登录+联网+一次成功 `getProfile`），磁盘上没有稳定的 account id/email/公钥指纹；`.anonymous-user-id` 是安装级随机 UUID，grant token 会随登录/过期/issuer 变化被替换或删除。**`userId` 是标识不是秘密**——只用它派生 KEK 等于"任何人都能解密"的加密表演，所以 v3.4.7 **默认不写 `account` 信封**；只有当宿主能提供真正的每账户秘密（或产品明确接受这种非机密性"便捷解封"）才启用。
2. `machine` 信封可行：本机 DPAPI（CurrentUser）32B→262B 密文 round-trip 实测通过，跨进程可解；仓库里已有实现可复用（`src/decision-center/lib/ai-secret-store.mjs`）。macOS 分支目前明确 `keychain-not-implemented`，所以非 Windows 机器在 **`sealed` 模式**下只有 PIN/密码路径（默认 `none` 不需要任何路径）。
3. scrypt 实测：N=2^14≈56 ms、2^15≈111 ms、2^16≈227 ms、**2^17≈461 ms**（参考机）；默认取 **N=2^17 / r=8 / p=1**（约 1 s 预算的 2.2× 余量，单次 128 MiB 内存）。
4. 因此（本次最终决定之前）**默认信封组合 = `machine` + `password`**；`account` 是可选第三信封。**2026-11-17 最终决定（§25.0）改写了默认**：新仓库默认 `encryption: "none"`，只写 `open` 信封；`machine`/`password`/`account` 只在显式选择 `sealed`（提供 PIN、`machineKey: true`、账户绑定或配置 `backupEncryption: sealed`）时写入。

> **2026-11-17 16:37 增补**：上一条的两项前置条件已闭环——`getProfile(client)` 已修（`src/chatops/account.mjs` 的 `accountClientMetadata`）并在宿主内实测（`docs/SPIKE-ACCOUNT-KEK.md` §8）：`userId` 可得且跨调用/跨 boot 稳定，但**仍只是标识**；Host-only `getPlatformSession()` 能读到 bearer token，但它在登出/401/重新登录时被删除或替换，**不是稳定的每账户秘密**。结论不变：`account` 仍默认不写。

> **2026-11-17 决定增补**：用户明确选择"只读账户唯一识别码做比对，一致就放行，不一致就切换密码/PIN 模式"，于是
> `account` 作为**身份绑定**启用（不承诺机密性、不替代 password）。**最终决定（§25.0）进一步把默认改成不加密**：
> 只有在 `sealed` 仓库里 `account` 才随成功 run 写入（`none` 仓库永不绑定，因为它本来就不需要凭据）。设计、面板、
> 配置与诚实安全声明见 **§25**；本节的"`account` 默认不写"是决定之前的结论，保留作为历史记录。

规则：

1. **AAD 绑定**：每份信封的 AAD = `w2m-session-backup|<version>|account/machine/password|aes-256-gcm|<salt>`。所以信封不能被挪到别的 kind 槽、KDF 参数不能被改小——都会变成认证失败。
2. **参数随文件记录**：每条信封自带 `kdf`，日后提高 scrypt 成本不会让旧仓库打不开；读取接受文件记录的值，但有上界 `MAX_SCRYPT_N = 2^20`（防恶意文件逼出 GB 级内存），写入拒绝低于 `N = 16384`（`BACKUP_KDF_WEAK`）。
3. **GCM 分不清"密码错"和"文件被改"**：两者都是 `BACKUP_DECRYPT_AUTH_FAILED` / `BACKUP_KEY_UNWRAP_FAILED`，文案必须同时说明两种可能。**不允许**在代码或 UI 里断言"密码错误"。
4. **正文块**：`objects/<aa>/<sha256>` 是 `W2MBLOB1 | nonce | ciphertext | tag`，AAD = `w2m-session-backup/object|<plaintext sha256>|<plaintext length>`；打开后再校验 `sha256(明文) == 文件名`。块被搬到别的哈希位上会认证失败。
5. **DLQ/自检**：`w2m-backup selftest` 在**用户自己的机器上**跑一遍真实 wrap/unwrap + 三种必须失败的篡改，建库前必须先绿。
6. **仓库级 DEK（v3.4.7 定稿）**：一把随机 DEK 服务整个仓库（见 §3 细化 1）。**保护模式决定信封组合**：
   `none`（默认）只写一个 `open` 信封（DEK 明文；§25.0）；`sealed` 写 `account`/`machine`/`password` 中
   可用的组合（默认写 `machine`（可用时）+ `password`（提供时））。`sealed` 建库时**至少一个信封可用**才
   允许，否则 `BACKUP_NO_PERMISSION`——写一个谁也打不开的仓库比不写更糟。`none` 不需要凭据，因此不会因为
   "没有凭据"被拒。定时任务没有 PIN 可输：`none` 模式照常可跑；`sealed` 模式只能走 `machine` 信封，没有
   OS keystore 的平台具名拒绝（`BACKUP_NO_PERMISSION`），人工路径是 `w2m-backup run --password-stdin`
   （PIN/密码只经 stdin/env，绝不进 argv）。
7. **open 信封的实现边界**：只新增一种信封记录，**不改**块/清单/轮转/校验/归档/镜像/gc 的任何代码路径——
   `sealObject`/`openObject` 仍用同一把 DEK；区别只在"钥匙从哪来"。因此关闭保护不重写任何对象，只是
   `keys.json` 多/换一条记录。

## 7. 门禁（来自 2026-11-17 复盘，必须接进还原路径）

| 门禁 | 内容 | 落在 |
|---|---|---|
| **G1** 还原候选先过医生 | `restore` 只发布通过 `scripts/session-doctor.mjs`（`diagnoseSessionFile`）的候选日志；失败即拒绝，绝不"先写后看" | v3.4.6 已有检查器；接线在 v3.4.8 |
| **G2** 注册表写入协议 | `workspace.json` 由客户端所有（会用内存态回写）。写入必须：暂停/等客户端 → 写入 → **回读校验** → 客户端下次保存后复查；文档与 UI 都要说明"一次写入可能不生效" | v3.4.6 本文冻结；实现 v3.4.8 |
| **G3** 禁止手工事件 | 备份只存**原始字节**；任何重构路径必须过 G1 + "未来追加"模拟（追加一条事件后仍能加载） | v3.4.6 本文冻结 |
| **G4** seq 重编号工具 | 删/插事件的唯一合法方式：全局 renumber + 改写 `sourceEventSeqs`/`messageSeqs`/`headerSeq` + 医生校验 | v3.4.8 |
| **G5** 校验只用运行时 | 结论性校验必须用运行时同一份代码（`restoreCurrent → Session.fromRestore`，`mode=current`）；自写解析器只能用于**预筛**，不能作为证据 | v3.4.6 本文冻结；接线 v3.4.8 |

> 这五条不是"最佳实践"，是那次实战里**每一条都对应一次真实失败**。

## 8. 威胁模型

| 威胁 | 对策 | 残余风险 |
|---|---|---|
| 仓库目录被拷走/云盘同步泄露 | 块级 AES-256-GCM；DEK 只在信封里；**默认 `none` 时 DEK 明文在 `keys.json`** | 清单明文暴露会话 id/工作区名/大小/时间（**接受并声明**）；**`none` 模式下整个仓库可被还原**（这是默认状态，见 §25.0）；`sealed` 模式仍有下面的 PIN 残险 |
| 只防"误操作/随手分享/换机" | 三种模式（§25.0）：不加密（默认）/ 账户比对 / 4-6 位数字 PIN | **都不是机密性**：知道账户 id 且有仓库文件的人可推导 account KEK；4-6 位数字 PIN 可被穷举；两者都是便捷门槛 |
| 真正要防"文件泄露后仍保密" | 只能 `sealed` + **长密码**（≥8 位、非纯数字）+ 仓库目录访问控制（ACL/加密卷） | 产品**不承诺**默认配置下的机密性；scrypt 参数随文件记录 |
| 攻击者改一个字节 | GCM tag + AAD + 打开后哈希 | 无法区分"改"与"密码错"（协议如实上报） |
| 密码被穷举 | scrypt（默认 N=2^16,r=8,p=1，参数随文件） | 弱密码仍可被字典攻击；UI 应给强度提示（v3.4.9） |
| 仓库被换入别的会话内容 | 块按明文哈希寻址 + 全文件哈希 + 清单计数自洽 | 攻击者若能同时改清单，需要重算全部哈希（无签名） |
| 进程在备份中途崩溃 | 块先写 `tmp/` 再 rename；清单最后写；残留块无害（内容寻址） | v1 不做事务日志；`verify` 会发现半写快照 |

**明确没有做的事**：清单没有签名（签名会引入"密钥轮换"复杂度）；仓库没有删除保护（`gc` 行为在 v3.4.7 定义，默认只删无引用块）。

## 9. 版本兼容承诺

1. `format` 字符串标识**协议族**，`version` 标识**协议版本**。v1 内只允许**新增可选字段**；删除字段、改字段语义、改 `block_size`/`block_algo`/`cipher` 都是 v2。
2. 读方遇到 `version > 1` 必须**拒绝**（`MANIFEST_VERSION_UNSUPPORTED` / `BACKUP_REPO_VERSION_UNSUPPORTED`），不得"尽力解析"。
3. 写方遇到旧版本仓库：v1 直接拒绝（v2 才谈迁移）。
4. 加密参数（scrypt N/r/p、salt）**永远随文件**，不是程序常量；算法替换 = 新 `cipher`/`kdf.algo` 值，旧文件继续可读。
5. 任何协议字段变更必须同时改：本文、`test/backup-protocol.test.mjs`、`docs/DEV-PLAN` 的版本计划。

## 10. 组件边界（v3.4.7）

| 模块 | 职责 | 写盘？ |
|---|---|---|
| `src/backup/layout.mjs` | 路径解析、`inspectLayout`（只读）、`ensureLayout`（建库，v3.4.7 才调用）、具名错误 | `ensureLayout` 会写（测试/未来引擎用） |
| `src/backup/scan.mjs` | 会话/附件/注册表枚举、header 读取、可选 hash/deep | **绝不** |
| `src/backup/manifest.mjs` | 清单 schema、块切分、路径规范化、严格校验、摘要 | 只读源文件 |
| `src/backup/crypto.mjs` | scrypt/hkdf 派生、AES-256-GCM 封包、四信封（open/account/machine/password）、块对象、`selftest` | **绝不**（纯内存） |
| `src/backup/repo.mjs` | 快照 id、快照两文件、`index.jsonl` 行格式与读写、`commitSnapshot`、只读 `openRepo` | 仅 `commitSnapshot`/`appendIndex` 会写（测试与 v3.4.7 引擎；路由与 CLI 不调用） |
| `src/backup/engine.mjs` | `runBackup`：锁 → 建库 → 开 KEK → 扫描 → 按 scope 选会话 → 写缺失块（去重）→ 提交快照 → 轮转 | 会写（这是引擎） |
| `src/backup/rotation.mjs` | `current/` 指针、`old/` 版本记录、每会话保留窗口 | 会写 |
| `src/backup/gc.mjs` | 引用收集（快照 + old + current）、孤儿块删除、old 保留窗口；任一引用不可读即**拒绝删除** | 会写（`dryRun` 时只读） |
| `src/backup/locks.mjs` | `tmp/backup.lock`：`wx` 原子创建、死 pid/超龄/不可读三种回收、只释放自己的锁 | 只写锁文件 |
| `src/backup/atomic.mjs` | `writeFileAtomic`（tmp → fsync → rename）、`writeJsonAtomic`、`readJsonSafe` | 会写 |
| `src/backup/keystore.mjs` | 打开/创建仓库 DEK：`none`（open 信封）/ `sealed`（machine + password/PIN + 可选 account），模式创建/升级/降级（`setRepositoryPassword` / `setEncryptionMode`），PIN 轮换（`rotatePassword`，§25.8） | 写 `keys.json`、同步 `backup.json` 的 `encryption` |
| `src/backup/machine-key.mjs` | 32B 随机机器秘密 + OS 钥匙串（Windows DPAPI，实测 round-trip）；macOS/Linux 明确 `unavailable` | 写 `$DSH_HOME/xclient/backup/machine.key` |
| `src/backup/schedule.mjs` | 备份计划配置（默认 22:00 Asia/Shanghai）、时间/时区严格校验、next/missed 计算 | **绝不** |
| `src/plugin/backup.mjs` + `lib/backup.js` | `dsh-backup` 子插件：`ctx.effect` 拥有的定时器 + `GET/POST /api/w2m/backup/run`（POST 需 `{"confirm":"run"}`） | 经引擎写 |
| `src/backup/routes.mjs` | `GET /api/w2m/backup/status`、`GET /api/w2m/backup/scan`（只读，主插件挂载） | **绝不** |
| `src/backup/cli.mjs` + `bin/w2m-backup.mjs` | `status` / `scan` / `selftest` / `run` / `list` / `gc`（`scan --manifest` 在内存里构建清单） | `run`/`gc` 经引擎写；其余只读 |
| `src/util/dsh-workspace.mjs` | `workspace.json` 解析，doctor 与 scan **共用一份** | **绝不** |
| `src/util/daily-clock.mjs` | 时区日历算术（解析/下一班/漏班），更新检查与备份计划**共用一份** | **绝不** |

**接线决策（与计划的一次偏差，记录原因）**：计划原写"v3.4.6 在 `cordis.patch.yml` 增加 `dsh-backup` 行、默认 disabled"。实际改为**由主插件挂只读路由**，`dsh-backup` 子插件行推迟到 v3.4.7 与引擎一起引入。理由：只读路由没有需要"关掉"的副作用，而一个默认关闭的行会让状态卡片在默认配置下直接报"未启用"——把可用功能藏起来。子插件真正有意义是在**它可能写盘**之后（定时器、还原、打包）。

## 11. 错误码总表（供 UI 映射，v3.4.9）

| code | 中文文案（建议） |
|---|---|
| `BACKUP_DIR_UNRESOLVED` | 备份目录没有配置，或配置值不是路径 |
| `BACKUP_DIR_INSIDE_SOURCE` | 备份目录不能放在 DSH 数据目录里面 |
| `BACKUP_PATH_IS_FILE` | 备份位置是一个文件，不是目录 |
| `BACKUP_DRIVE_MISSING` | 备份盘不存在：请插上磁盘或换一个目录 |
| `BACKUP_DIR_NOT_WRITABLE` | 没有写入权限：请换目录或修改权限 |
| `BACKUP_DIR_NOT_A_REPO` | 该目录已有其它格式的备份，未做任何修改 |
| `BACKUP_REPO_VERSION_UNSUPPORTED` | 备份仓库版本比当前程序新，请升级插件 |
| `BACKUP_KDF_WEAK` | 加密参数过弱，拒绝创建 |
| `BACKUP_DECRYPT_AUTH_FAILED` | 解锁失败：密码/账户不对，或文件被改动过（无法区分） |
| `BACKUP_KEY_UNWRAP_FAILED` | 当前凭据打不开这份备份，请用原账户或解锁密码 |
| `BACKUP_PASSWORD_EMPTY` | 请输入解锁 PIN/密码（至少 4 个字符；4-6 位数字是便捷门槛，不是保密强度） |
| `BACKUP_ENVELOPE_MALFORMED` | 信封结构无效；**同一 `keys.json` 里的 `open` 信封不能与 account/machine/password 混存**（会静默绕过凭据） |
| **`BACKUP_NO_PERMISSION`** | **没有权限：请用原账户登录，或输入解锁 PIN/密码**（v3.4.8 解锁失败的统一对外码；`none` 模式不需要凭据，不会出现此码） |
| `BACKUP_ACCOUNT_MISMATCH` | 当前账户不是原账户：已改走密码路径（§25；`attempts` 里的具名原因，对外仍可能是 `BACKUP_NO_PERMISSION`） |
| `BACKUP_ACCOUNT_ID_INVALID` / `BACKUP_ACCOUNT_BINDING_UNKNOWN` | 账户 id 不可用 / 已有 account 信封但缺 `account_binding` 元数据，无法比对（拒绝且不改写） |
| `BACKUP_SELFTEST_FAILED` | 加密自检未通过：这台机器上的备份不可信 |
| `MANIFEST_*` | 清单校验失败（具体到字段路径，供诊断用） |
| `BACKUP_LOCKED` | 另一个备份正在运行（含持有者 pid/主机/开始时间） |
| `BACKUP_BUSY` | 本进程内已有一次备份在跑 |
| `BACKUP_CONFIRM_REQUIRED` | 面板请求缺少 `{"confirm":"run"}` 确认令牌 |
| `BACKUP_SCOPED_NOTHING` | 选定的范围没有匹配到任何会话（含未知 session id） |
| `BACKUP_SCOPE_INVALID` | scope 不是 all/active/archived/selected |
| `BACKUP_WRITE_FAILED` / `BACKUP_DISK_FULL` | 写入失败 / 卷已满 |
| `BACKUP_GC_UNSAFE` | 有引用不可读，**拒绝删除任何块** |
| `BACKUP_SCHEDULE_TIME_INVALID` / `BACKUP_SCHEDULE_ZONE_INVALID` | 计划时间/时区配置非法 |
| `BACKUP_ROTATION_ENTRY_INVALID` / `BACKUP_ROTATION_WRITE_FAILED` | 轮转输入/写入失败 |
| `BACKUP_ROTATION_POLICY_INVALID` | 保留策略值非法（v3.5.0：`--max-old-days` / `backupOldVersionDays` 必须是 0 或正整数） |
| `BACKUP_MIRROR_INVALID` | 异地副本路径非法（仓库/home 内、等于仓库根、是文件、真实路径不可解析），本次备份未开始 |
| `BACKUP_MIRROR_SYMLINK` | 异地副本经 symlink/junction 的真实路径落在仓库/home 内，本次备份未开始 |
| `BACKUP_MIRROR_FAILED` | 异地副本复制失败；主库备份**已提交且可用**，下次同步会自动补齐 |
| `BACKUP_CONFIG_INVALID` | 备份子插件配置项非法（含 `backupEncryption`；`run --encrypt` 非法值在 CLI 是退出码 2） |
| `BACKUP_REPO_SNAPSHOT_*` / `BACKUP_REPO_INDEX_LINE_INVALID` | 快照或索引行不可用 |
| `BACKUP_SCAN_HEADER_UNREADABLE` / `BACKUP_SCAN_NOT_ZSTD` | 会话日志头部不可读/不是 zstd |

## 12. 未决问题

1. **账户信封 → 已定稿为"便捷优先"（§25.0，2026-11-17 用户最终决定）**：用户明确"追求的不是绝对保密"：默认**不加密**（`none`，DEK 明文在 `keys.json`）；账户 id 只做比对以便自动化快捷解锁；PIN 是 4-6 位数字、只在账户不匹配时使用。spike 的结论（`userId` 是标识不是秘密、token 易变）未被改写；因此 `account` 信封**只当便捷路径**，永不替代 password，也不当机密性承诺。等上游提供"每账户稳定秘密"后再评估更强的账户信封（条件清单见 `docs/SPIKE-ACCOUNT-KEK.md` §8.5、§9）。
2. **清单是否也该加密**：v1 选择明文（§4 理由）。若用户要求，v2 可加 `manifest.enc` + 明文 `snapshot.json`（只留计数）。
3. **`current/` 已定稿**：存指针（见 §3 细化 3），轮转与 gc 都以它为根之一。
4. **保留策略默认值已定稿**：每会话 10 份旧版本（Q4=A），`keepOldPerSession` 可配；轮转后立即裁剪，窗口不会无声增长。
5. **macOS 的 machine 信封**：需要 keychain 实现；在补齐之前，macOS 的 **`sealed` 模式**只有 PIN/密码路径（`none` 模式不需要凭据；v3.4.8 解锁流程要按平台给出不同文案）。

## 13. 引擎、调度与轮转（v3.4.7）

**一次备份的顺序**（顺序本身就是正确性的一部分）：

1. `withRepoLock`：单写者，或具名 `BACKUP_LOCKED`；
2. `ensureLayout`：首次运行建库；
3. `openRepoKey`：**先拿到钥匙再写任何块**——否则可能出现"块已写、仓库打不开"；
4. `scanHome`：只读枚举；
5. 按 scope 选会话（`all` / `active`（未归档）/ `archived` / `selected`），附件对象每次都带上；
6. 每个文件读一次：sha256 + 4 MiB 块切分 → 只写**内容地址不存在**的块（这一步就是去重）；
7. `commitSnapshot`：manifest + keys 副本 staging → rename → index append + 回读校验；
8. `rotateForEntry`：内容变化才记旧版本，并把 `current/` 前移。**轮转在提交之后**：中途崩溃时快照仍在、指针仍指旧版本，重跑只会幂等地重记一次。

**scope 语义**：`active` 排除 `archivedSessionIds` 里的会话；`archived` 只备它们；注册表读不到时 flags 为 `null`（未知按 active 处理——静默漏备比多备一个更难发现）。`selected` 必须给 id，未知 id 会列在结果的 `unknown_selected` 里；一个都没匹配到则 `BACKUP_SCOPED_NOTHING`。

**去重**：块按**明文** sha256 寻址（`objects/<aa>/<sha256>`），已存在即跳过写入并计入 `blocks_reused`。第二次备份未改动时应为 `blocks_new = 0`（测试断言），这也是"每天不重写 166 MB"的判据。

**原子写**（`atomic.mjs`）：tmp 同目录 → write → **fsync** → rename。文件名的内容地址只在字节落盘后才出现；否则下一次备份会认为块已存在，永久跳过一条坏块。

**轮转**：只有内容 sha256 变化才记 `old/`；记录含 rel/size/blocks/snapshot_id/superseded_by，可逐字节还原上一版。`keepOldPerSession`（默认 10）由轮转同步裁剪。

**调度**：默认 **22:00 Asia/Shanghai**，配置项 `backupTimes`（`HH:mm` 或 `HH:mm:ss` 数组）/ `backupTimeZone`/`backupCatchUpMs`（默认 12 小时）。机器睡眠跨过 22:00 后唤醒只**补跑一次**；`catchUpMs` 之外不补，避免"每次启动都备一次"。定时器由 `ctx.effect` 拥有，卸载即停。

**未无人值守的凭据边界**：定时任务不能弹窗，也不能存密码，因此只走 `machine` 信封；OS keystore 不可用时具名拒绝（`BACKUP_NO_PERMISSION`），人工用 `w2m-backup run --password-stdin`。

## 13.1 加固与闭环（2026-11-17 复盘后）

这一版把"能写"变成"写坏了也知道"：

| 场景 | 行为 |
|---|---|
| 进程在"块已写、快照未提交"之间崩溃 | 块留在 `objects/`；下次备份按内容地址复用（0 新块），不会重写整份 |
| 快照已提交、轮转步骤失败 | 引擎返回 `ok:false, committed:true, snapshot_id`——备份本身是持久的，失败的是"指针没前移"，不能报成"没备份" |
| 会话正被客户端追加、尾部帧不完整 | 用运行时同一份 `scanFrames` 检查，重读一次；仍截断则照存字节并在 `torn_sessions` 报告 |
| 备份运行中执行 gc | gc 先取仓库锁，拿不到即 `BACKUP_LOCKED` 且零删除 |
| 崩溃留下的 `.tmp-` / 空 objects 前缀 | gc 清理（临时文件仅超过 1 小时，避免删到正在写的那份） |
| 密码种子仓库遇到可用 OS keystore | 自动追加 `machine` 信封（DEK 不变），之后无人值守运行无需密码 |
| 还原依据 | 单测把块解回、按清单拼回整文件、与源文件逐字节比对；块被搬到别的地址必须认证失败 |

**可还原性证据**：`test/backup-engine.test.mjs` 的"reassembles every file from its blocks"读 `objects/`、用 DEK 逐个 `openObject`、按清单拼接，再与源文件 `deepEqual`。这条测试是 v3.4.8 还原实现的前置保证。

## 14. v3.4.7 的接口面（面板将在 v3.4.9 调用）

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/w2m/backup/status` | GET | 只读状态（仓库布局 + 快照数 + 最新 digest + index 健康） |
| `/api/w2m/backup/scan` | GET | 只读扫描（`?detail=1` 带逐会话行） |
| `/api/w2m/backup/run` | GET | 子插件挂载时的运行态（schedule + 上次结果 + 计数） |
| `/api/w2m/backup/run` | POST | `{"confirm":"run","scope?":"all|active|archived|selected","selected?":[],"dryRun?":bool}` |
| `w2m-backup run` | CLI | `--scope` / `--session` / `--keep-old` / `--dry-run` / `--password-stdin` / `--no-machine-key` |
| `w2m-backup list` / `gc` | CLI | 快照列表 / 孤儿块与 old 窗口清理（`--dry-run` 只报不删） |

`dsh-backup` 子插件行随包发布但 `disabled: false`（v3.5.0 起默认启用，操作员可关闭该行）：**启用它才意味着"定时器可以写盘"**。只读路由仍在主插件上，因此面板的"状态卡片"不需要先启用子插件。


## 15. 还原、解锁、校验与归档（v3.4.8）

### 15.1 还原流水线：先规划，后写入

```
plan  解块 → 运行时校验(G5) → 冲突分类 → 注册表计划        （零写入）
  ↓  --apply
预还原副本（被覆盖的会话文件 + workspace.json）
  ↓
原子写会话文件 → 写附件对象 → 注册表原子写 → 回读校验(G2)
  ↓
复读每个写入文件：sha256 必须等于计划值 + doctor 复验      （失败如实报告）
```

失败方向是明确的：规划失败 = 什么都没写；写入中途失败 = 写过的会话不完整，但预还原副本已经在
`sessions/.w2m-restore-backups/<ts>/`，报告会给出路径；注册表写后校验失败 = 会话在盘上但注册表没认，
报 `BACKUP_REGISTRY_VERIFY_FAILED` 并重试。

### 15.2 四条门禁的接线状态

| 门禁 | v3.4.8 落点 |
|---|---|
| **G1** 候选先过 doctor 再发布 | `planRestore` 对每份解回的字节跑 `validateCandidate`，任一失败即整单拒绝；`applyRestore` 写后再复验 |
| **G2** 注册表写入协议 | `registry.mjs`：原子写 + 回读校验（会话已登记、archived/pinned 与计划一致）+ 明示"客户端内存态会回写" |
| **G3** 禁止手工事件 | 只写快照里的**原始字节**（解块后逐字节比对清单）；写入前做 `simulateFutureAppend`，追加一条合法事件后仍须通过校验 |
| **G4** seq 重编号工具 | v3.4.8 **本版不做**（还原只发布原始字节，从不删/插事件，所以不需要重编号）；2026-11-17 已补全为**独立工具** `src/backup/renumber.mjs` + `w2m-fix renumber`，见 §20 |
| **G5** 校验用运行时同一份代码 | `runtime-validate.mjs` 用安装的 Harness 跑 `sessionFormatCatalog.createRestore(..., validation:'current')`；自写 doctor 只预筛，不单独作为证据 |

> 2026-11-17 收口补记：G2 增加 `w2m-backup register` 一等公民入口（§22.1）；G3 的证据矩阵固化成测试（§22.2）；
> G4 的 `.bak` 兄弟副本有了保留上限（§22.3）；G5 的面板可显式勾选运行时终审（§22.4）。

### 15.3 运行时校验：为什么是子进程

Harness 的会话格式代码在 `resources/app.asar` 里，plain node 读不了。所以 node 侧只做两件事：
把 zstd 帧解成"header + 事件行"的 artifact，然后以 `ELECTRON_RUN_AS_NODE=1` 启动 Harness 本体跑
`runtime-driver.mjs`。driver 只做一件事：`createRestore(header,{validation:'current'})` → 逐行
`decodeRow` → `finish()`。判定行以 `W2M-RUNTIME-VALIDATE:` 前缀回传；**没有判定行 = 失败**，绝不
当成通过。找不到安装时默认 `BACKUP_RUNTIME_UNAVAILABLE` 拒绝还原。

### 15.4 归档包

`archive/<YYYY-MM-DD>/archived-sessions-<ts>.tar.zst`：

* 内层是 ustar（自写 reader/writer，无 PAX；长路径按 prefix+name 拆分，超长拒绝）；
* `manifest.json` 记录每一个文件的 rel/size/sha256/session_id/flags，来源快照 id 与 digest；
* 字节**从仓库解块**，进包前已逐文件对过快照清单——包内清单因此是可独立验证的；
* 默认只打 `flags.archived` 的会话，`--scope all` 打全部；
* 回读 `readArchive` 逐文件对 sha256；`extractArchive` 拒绝 `..` 逃逸条目。
* 包是**明文** tar：它写在用户自己的仓库目录里，manifest 与 README 都写明这一点；加密整包是 v2 议题。

### 15.5 解锁：两条真实路径

| 路径 | 材料 | 适用 |
|---|---|---|
| `machine` | OS keystore（Windows DPAPI CurrentUser）保护的 32B 随机秘密 | 定时任务、同一台机器上的面板还原 |
| `password` | 用户密码 + scrypt(N=2^17) | 换机器、换用户、机器信封不可用 |
| `account` | **不写**：spike 证明宿主只暴露账户标识，不暴露秘密 | — |

密码种子的仓库在首次遇到可用 keystore 的机器上自动追加 `machine` 信封（DEK 不变，旧块不受影响），
这是"密码种子 + 无人值守"能同时成立的唯一路径。面板路由从不接收密码。

### 15.6 为什么 G4（seq 重编号）不在 v3.4.8

还原全链路只写**快照里的原始字节**：解块 → 校验 → 原子写。整条路径没有任何"删一条/插一条"的步骤，
所以还原不需要重编号。G4 要解决的是"用户想手工修正历史"——那不是一个可以顺手交付的能力：它必须由
运行时给出 diff 证据、必须改写所有 `*Seq` 引用、必须过 doctor + 运行时双校验，并且要有一个"同一条
会话两处修改合并"的策略。把它做成还原的一部分会让 v3.4.8 的失败面凭空变大。设计留在此处，等真实修复
场景出现后单独提出。

**2026-11-17 更新（G4 收口）**：上面这段记录的是 v3.4.8 当时**为什么不在还原路径里**，该理由不变；工具本身已
作为独立能力补全（`src/backup/renumber.mjs` + `w2m-fix renumber`），不进 restore 路径，见 §20。

### 15.7 v3.4.8 新增错误码

| 码 | 含义 |
|---|---|
| `BACKUP_CANDIDATE_INVALID` | 候选日志没过静态预筛 |
| `BACKUP_RUNTIME_UNAVAILABLE` | 需要运行时校验但本机没有可用安装（可用 `--allow-static-validation` 显式降级） |
| `BACKUP_RUNTIME_REJECTED` | 安装的 Harness 拒绝了候选日志 |
| `BACKUP_FUTURE_APPEND_FAILED` | 追加一条合法事件后校验失败（"今天能开、明天打不开"） |
| `BACKUP_RESTORE_NO_SESSION` | 快照里没有请求的会话 |
| `BACKUP_RESTORE_WORKSPACE_UNKNOWN` | 备份所属工作区不在本机注册表，且没给 `--workspace-path` |
| `BACKUP_ATTACHMENT_CONFLICT` | 附件 id 相同但字节不同（内容寻址被破坏） |
| `BACKUP_RESTORE_VERIFY_FAILED` | 写入后复读字节/清单不一致 |
| `BACKUP_REGISTRY_UNREADABLE` / `BACKUP_REGISTRY_WRITE_FAILED` / `BACKUP_REGISTRY_VERIFY_FAILED` | 注册表读/写/回读失败 |
| `BACKUP_INDEX_MISMATCH` / `BACKUP_OLD_RECORD_BLOCK_MISSING` | 索引与快照目录不一致 / old 记录引用的块缺失 |
| `BACKUP_ARCHIVE_EMPTY` / `BACKUP_ARCHIVE_UNREADABLE` | 归档无内容 / 归档不可读 |
| `BACKUP_OBJECT_MISSING` / `BACKUP_SIZE_MISMATCH` / `BACKUP_MANIFEST_DIGEST_MISMATCH` | 块缺失 / 长度不符 / 摘要不符 |

### 15.8 v3.4.8 复盘后的加固（2026-11-17）

这一轮把"能还原"推到了"在真实仓库上也成立"，修掉的都是真实数据暴露出来的问题：

| 发现 | 修复 |
|---|---|
| 首次运行没有可用凭据时仍会创建半个仓库（ensureLayout 先于凭据检查） | 引擎在建目录之前判断密码或 OS keystore 是否至少有一条路，没有就返回 BACKUP_NO_PERMISSION，仓库目录一个字节都不建；对应单测断言 root 不存在 |
| run --dry-run 会创建仓库并要求解锁（不是只读） | dry-run 不建 layout、不取锁、不解锁：只在内存里数块并报告；在"仓库还不存在"时同样零写入 |
| 多会话还原的注册表是 last-write-wins：每个会话各自基于原始文档规划，连续 apply 只剩最后一个 | 注册表规划改为**整次还原一个文档**（planRegistryRestores），一次写、一次回读、逐会话校验；新增多会话还原测试 |
| 还原到全新 home（灾难恢复主场景）被拒：没有 workspace.json 就 BACKUP_REGISTRY_UNREADABLE | 允许在**显式给出 --workspace-path** 时创建最小注册表文档（unit/global/tables 形状与客户端一致），绝不凭空建；不给路径仍拒绝并提示 |
| 运行时批量校验在真实仓库上崩溃：15 个会话的 artifact JSON 数组超过 V8 最大字符串（Invalid string length）；放宽后又把 Electron 的 V8 堆打爆（exit 134） | 小 artifact 走"每约 96 MiB 一批"的 JSON 数组；超过 32 MiB 的**单会话走 NDJSON 流式驱动**（首行 header、逐行事件、逐条 decodeRow），内存不再与日志体积成正比。真实 15 会话计划验证通过 |
| 归档只能解压、不能还原（计划 4.3 要求"可解压、可校验、可还原"） | 新增 planRestoreFromArchive：从 .tar.zst 读字节，走与仓库还原**同一套**门禁/冲突/写入/注册表流程；CLI restore --archive <file> |
| 还原前副本只增不减 | 成功 apply 后按时间保留最新 N 份（默认 10），报告 pruned_pre_restore；失败路径不清理（那正是要用的那份） |
| identical 会话也被重写（无谓触碰客户端正在用的文件） | identical 跳过写入、仅补注册；报告 skipped，单测断言 mtime 不变 |
| verify 只验证快照块：backup.json、old 记录的摘要没查 | verify 增加 descriptor 形状检查；old 记录按其自身 sha256/size 重建并比对（不只查块存在） |
| 路由只有注册断言，没有行为断言 | 新增 v3.4.8 路由用例：三个写路由的确认令牌缺失即 400；unlock/verify 在未建库时报 BACKUP_REPO_NOT_INITIALIZED；Windows 上真实 DPAPI 走完 "run → archive → restore plan → apply（identical 跳过）" |

**实测（真实仓库，2026-11-17 加固后）**：restore 计划 15/15 会话由安装的 Harness 终审通过（含两个
artifact JSON 分别约 152 MB / 370 MB 的大会话，走流式路径），13 identical / 2 conflict，dry-run 零写入；
整轮计划约 114 s，成本集中在那两个大会话的解码与逐事件验证 —— **面板必须按会话按需规划**，不要一次性全量。

## 16. G2 收口：`workspace.json` 写入协议（v3.4.6 补全，v3.4.8 收口）

复盘 G2 的原文是"要么暂停客户端，要么写后**回读校验**并在客户端保存后复查"。v3.4.6 只冻结了这条规则，
v3.4.8 把三半全部落成代码、测试和运行时行为：

| 半 | 实现 | 行为 |
|---|---|---|
| **暂停客户端** | `src/backup/client.mjs` | `detectClientRunning()` 用 `tasklist`/`ps` 找客户端进程，**区分"没在跑"与"查不到"**。离线 CLI `restore --apply` 在客户端运行时**拒绝**（`BACKUP_CLIENT_RUNNING`），除非显式 `--allow-live-home`；面板路径在客户端内部，按定义是"活 home"，因此传 `allowLiveHome: true` 并依赖后两半 |
| **写后回读** | `src/backup/registry.mjs` | 原子写 → 重读 → 校验每个会话的登记、工作区 id、archived/pinned 三项；不整文件比对，以免把客户端无关改动当成失败 |
| **客户端保存后复查** | `src/backup/registry-watch.mjs` | 还原成功后按 2 s / 8 s / 20 s 采样注册表；发现登记丢失就**再应用一次计划并再校验**；每次采样都经 `onResult` 上报，面板写入 `state.last_registry_recheck` 并记日志。定时器由 `ctx.effect` 持有，卸载即取消 |

**为什么不用文件监视器**：客户端的保存是原子替换，watcher 会为每一次无关改动触发；固定几次采样覆盖"写完
后那一次保存"这个真实窗口，也不会长期占着用户文件句柄。

**测试**（`test/backup-g2.test.mjs`，10 项）：进程列表与定时器全部注入，因此不 spawn `tasklist`、不等 20 秒。
覆盖 Windows/linux/mac 检测、"查不到"与"没在跑"的区分、暂停门（拒绝/allow-live-home）、计划阶段的拒绝、
健康复查、客户端覆盖后的自动重放、定时器调度与取消、CLI 的两种结果。

**残余风险（写明，不掩盖）**：采样窗口之间客户端仍可再保存一次；若它比采样更频繁地保存，重放可能再次被覆盖。
面板会持续记 `warn`，`doctor` 能发现"盘上有、注册表里没有"的会话。彻底消除需要客户端提供协作钩子（v3.4.9
面板设计里再谈），当前协议把风险从"静默丢失"降为"有记录、可重放"。

### 16.1 真实事故与由此产生的保护

v3.4.8 的真实仓库验收中，一次 restore 被误用了真实 `DSH_HOME`（本应指向临时 home），把 05:35 的快照字节
写到了两个正在被客户端追加的会话日志上；客户端随后按自己的内存计数继续追加，导致日志出现 seq 间隙。
这次事故的直接后果被两条既有设计兜住：**预还原副本**保存了写前内容，**读回校验**立刻报告了不一致。
事后用"预还原副本 + 客户端追加的帧"无损重建了两个日志（doctor 通过，损坏原文另存），并据此补了两道保护：

* **apply 前再校验目标**：计划里记录 `existing_sha256`，写入前重读目标；变了就整体拒绝该会话
  （`BACKUP_RESTORE_TARGET_CHANGED`），避免覆盖"计划之后又被写过"的文件；
* **写后自动修复**：读回发现文件以"我们写入的字节"开头、后面是**帧对齐的客户端追加**时，自动写回
  "预还原副本 + 追加帧"并在结果里报告 `healed`（保留双方，不丢客户端事件）；否则报失败，预还原副本仍是退路。
* CLI 增加 `--allow-live-home` 门槛（客户端运行时默认拒绝还原到该 home），与 `--registry-recheck <ms>`
  （离线场景等待一次客户端保存窗口后再复查）。

## 17. G3 收口：只存原始字节 + "未来追加"模拟（v3.4.6 补全）

复盘 G3 的原文是"备份只存**原始字节**；任何重构路径必须过 G1 且做'未来追加'模拟"。v3.4.6 冻结了规则，
v3.4.8 把两半都做成可执行、可报告、可测试的东西，并在 v3.4.8 加固里补齐引擎与 verify 的报告面。

### 17.1 只存原始字节（证据链）

| 环节 | 事实 | 证据 |
|---|---|---|
| 引擎 | 读文件 → `splitBlocks` → 逐块 `sealObject` → 清单记 `sha256/size/mtime`；**从不解析后重写日志** | 引擎单测：损坏日志（seq 跳号）照样入库且清单 `sha256` 等于源文件哈希；另一条单测断言备份前后源文件**字节与 mtime 均不变** |
| 仓库 | 块按明文 sha256 内容寻址，`old/` 记录只存清单条目（不复制加密体） | 既有 repo/rotation 测试 |
| 还原 | 解块 → 认证解密 → 与清单 sha 比对 → 原子写 → 写后复读哈希 | restore 单测 + 真实仓库 15/15 会话还原计划 |
| 归档 | 包内字节来自仓库解块，入包前逐文件对清单 | archive 测试 |

### 17.2 "未来追加"模拟（一条实现，三处调用）

新增 `src/backup/future-append.mjs`：`countLogRows`（不解析 JSON 的行数）、`appendLegalEvent`（原始字节 + 一帧合法
`permission/preset`）、`futureAppendVerdict`（静态预筛）。`permission/preset` 是实测选出的**最弱合法追加**：
会话级、无 turn 状态、无 surface、无引用（`turn/start` 需要"下一个 turn 号"，依赖验证器不该去猜的状态）。

| 调用点 | 行为 |
|---|---|
| **引擎**（`runBackup`） | 对每个会话在**已读入内存的字节**上做模拟，结果写进 `future_append: {checked, failed, sessions}`；**不因此拒绝备份**——保留原始证据才是备份的职责，拒收发生在还原 |
| **还原**（`planRestore`/`planRestoreFromArchive`） | 通过 `validateCandidates(appendCheck: true)`：静态预筛后，把"原日志"和"追加后日志"**一起**交给安装的 Harness 批量终审；任一失败即整单拒绝（`BACKUP_RUNTIME_REJECTED`，detail 说明"after one legal append"） |
| **verify** | 默认对每个快照会话跑静态模拟（`BACKUP_FUTURE_APPEND_FAILED`）；`--runtime` 时把 append 后的 artifact 也放进同一批运行时校验，失败报 `BACKUP_RUNTIME_APPEND_FAILED` |

CLI `run` 的人类报告新增一行：`future append : 14/15 session(s) still load after one legal append`，并列出失败会话。

### 17.3 边界（写明）

* 追加事件是"最弱合法事件"，不是"用户下一条真实消息"：它证明日志的帧结构、seq 密度、保护头与 surface 规则
  没坏，但**不**模拟一次带工具/压缩/重试的真实回合。
* 引擎的模拟是静态预筛（便宜、可离线）；终审仍是运行时（G5）。两者失败都只报告，不修改日志。
* 备份端**不会**因为模拟失败而少存字节；是否需要告警由调用方决定（面板日志 / CLI 输出 / `future_append.failed`）。

### 17.4 真实实测，以及一个被真实数据抓到的布局 bug（2026-11-17）

**实测（默认仓库，`run --scope all`）**：15 会话 / 16 文件 / 171.5 MB，**2 新块 + 53 复用（96%）**，2 条 old 记录，
`machine` 解锁，**`future append: 15/15`**，总耗时 **26.1 s**。对照 v3.4.7 未做模拟时的 4.8 s：模拟对每份日志多做
一次解码与逐事件 parse，代价约 5×（171 MB 数据）；对每日一次的后台任务可接受，因此默认开启，但提供
`--no-future-append`（CLI）与 `backupFutureAppend: false`（面板配置）关闭。

**被真实数据抓到的 bug**：这次运行第一次在"还原前副本存在"的 home 上跑，135 s 后以
`BACKUP_REPO_SNAPSHOT_INVALID — MANIFEST_REL_PATH@$.files[16].rel, [17].rel` 失败。原因不是日志，而是布局：
v3.4.8 把还原前副本放在 `$DSH_HOME/sessions/.w2m-restore-backups/`，而会话扫描器递归遍历 `sessions/`，于是把
这些副本当成第 17、18 个会话；它们的 rel 含 `.` 段，清单校验拒绝。修复（四层）：

1. 还原前副本移到 `$DSH_HOME/.w2m-restore-backups/`（home 根、不在任何扫描根之下）；真实目录已迁移。
2. `listSessionDirs` 不再下探点目录（`.event-cache`、`.w2m-restore-backups` 都不会被当成工作区）。
3. 扫描器的 `EXCLUSIONS` 增加 `sessions/.w2m-restore-backups` 行，把"旧 home 里遗留的副本"写明为排除项。
4. 引擎在任何块写入**之前**用 `normalizeRelPath` 预校验每个 rel，坏路径立即返回
   `MANIFEST_REL_PATH`（并断言 objects 目录仍为空），不再先写块后失败。

测试：扫描器"遗留副本目录不被当成会话"、引擎"坏 rel 在写块前拒绝"各一条；仓库本身未受影响（快照/索引仍 2 条，
孤儿块由 gc 清理）。

## 18. 面板与侧边栏入口（v3.4.9）

UI 半只有一个文件：`lib/client.js`（手写、由 `window.__ModuleLoader__.load` 加载，无构建步骤）。新增
「备份&还原」面板与 GPW 同构，占两个槽位：

| 槽位 | 注册 | 行为 |
|---|---|---|
| `sidebar.panellist` | `id: 'w2m-backup'`, `order: 6`（GPW 的 4 之后） | 左侧导航一行：内联 SVG（`currentColor`）+ 文案；点击切换主面板 |
| `main` | `key: 'w2m-backup'`（必须等于 panellist id） | 面板页：状态条、四个一键操作、还原计划卡、解锁卡、日志区 |

**面板内容**

* **状态条**：仓库目录、初始化/加密、快照数、剩余空间、计划（22:00 Asia/Shanghai）与下次时间、上次备份摘要、
  运行态、注册表复查结果；数据来自 `GET /api/w2m/backup/run` 内嵌的只读 `status`（v3.4.9 新增；老宿主回退到
  `GET /api/w2m/backup/status`）。
* **四类一键操作**：`run`（立即备份，`{confirm:'run',scope:'all'}`）、`restore`（先取计划 → 展示
  new/identical/differs 与勾选列表 → 二次危险确认 → `{confirm:'restore',apply:true,sessions}`）、
  `archive`（`{confirm:'archive',scope:'archived'|'all'}`）、`verify`（`GET /verify`，展示 counts/problems/
  future_append/runtime；2026-11-17 起校验卡有「用安装的 Harness 终审（慢）」勾选框，勾上才请求
  `GET /verify?runtime=1`，见 §22.4）。操作期间按钮禁用、进度可见；失败可重试。
* **两个备份范围入口（v3.5.0 面板补全）**：操作区在原有四个之后新增 `backup-selected`（勾选会话 →
  `{confirm:'run',scope:'selected',selected:[ids]}`，无勾选时禁用）与 `backup-active`
  （`{confirm:'run',scope:'active'}`）；旁边的「备份范围」卡列出会话，来源是**只读**的
  `GET /api/w2m/backup/scan?detail=1`（`{ok,sessions:[{session_id,workspace,size,flags.archived}],totals:{sessions}}`；
  404/失败显示中性提示 +「刷新会话」重试，不阻塞面板其余部分），勾选只存在页面内存里、刷新即丢。两个入口
  仍然走带 `confirm:'run'` 的 POST：没有确认令牌不会写入任何字节，选中不持久化，扫描本身从不写盘；已归档
  会话仍由 `archived` 范围或 `all` 范围覆盖，`selected` 不会静默改变这一点。
* **解锁卡**：`GET /unlock` 描述路径——本机信封按钮 `POST {confirm:'unlock'}`；2026-11-17 起当仓库绑定了账户 id
  时还有**账户身份绑定行**（§25：一致 → 「用原账户解锁」可点；不一致/读不到 → 按钮禁用并提示改用密码；未绑定则
  原卡片不变，只显示后 4 位 `id_hint`）；密码路径**不在 HTTP 上传输**，面板显示终端命令
  `w2m-backup unlock --check --password-stdin`。`BACKUP_NO_PERMISSION` 的文案为
  「没有权限：请用原账户登录，或输入解锁密码」，`BACKUP_ACCOUNT_MISMATCH` 映射为「当前账户不是原账户：已改走
  解锁密码路径，请用密码解锁」（§25）。
* **日志区**：当前页内最多 50 条操作记录（时间、结果码、detail），失败时同时显示错误卡。
* **刷新**：挂载即读状态；之后 10 s 轮询只读状态（`typeof window !== 'undefined'` 守卫），页面卸载清定时器；
  每个操作完成后立即重读状态。
* **i18n**：`panel.backup.*` 共 145 个键 × 中/英（2026-11-17 增加 `verify.runtimeCounts` / `verify.runtimeHint`
  两键，`verify.runtime` 改为勾选框标签，见 §22.4；v3.5.0 增加两个范围入口与只读扫描卡 16 键；账户 ID 绑定再加
  `unlock.accountBound/accountMatched/accountMismatch/accountUnavailable`、`action.unlockAccount`、
  `reason.BACKUP_ACCOUNT_MISMATCH` 6 键，见 §25），随既有
  `registerDictionaries` 注册（内联字典是该 bundle 的实际机制；`locale/*.json` 只是商店清单元数据）；35 个
  reason-code 到文案的映射。
* **主题**：只用宿主 `--dsw-alias-*` 设计令牌，无字面色值、无媒体查询（深浅色由宿主切换）；窄宽度用
  `auto-fit` 网格。

**验证**

* `test/client-bundle.test.mjs`：新增 12 个 describe/测试——注册对与 `key===id`、order 在 GPW 后、SVG
  `currentColor`、四操作标记齐全、解锁双分支且**无密码输入框**、备份段静态扫描无 `type:'password'`/含密码的
  请求体、五条路由齐全、危险确认仅在 armed 后出现、**可重渲染 fake React 驱动四操作**（校验确认令牌、
  restore 先计划后 apply 且只带选中会话、unlock 只发确认令牌）、中英字典完整性、日志上限 50、同文档挂载两次
  只有一个 `<style>` 且无残留定时器。
* `test/loader-entry.test.mjs`（真实 Chromium，抛空 profile 安装当前 tarball）：新增断言——左侧边栏出现
  `[data-w2m-backup-sidebar]`、点击打开 `[data-w2m-backup-panel]`、四个 `data-w2m-backup-action` 齐全。
  该 profile 默认 `dsh-backup` 行关闭，因此面板显示"需要启用该行"的状态；四类操作的**写入**由
  `test/backup-run.test.mjs` 的路由级测试覆盖（含 Windows 真实 DPAPI 与确认令牌拒绝）。

## 19. G5 收口：校验只用运行时同一份代码（v3.4.6 补全）

复盘 G5 的原文是"结论性校验必须用运行时同一份代码（`restoreCurrent → Session.fromRestore`，`mode=current`）；
自写解析器只能**预筛**，不能作为证据"。v3.4.8 起接线，v3.4.9 收口，并修掉一个只有真实运行时才会暴露的漏洞。

### 19.1 证据链（谁是证据，谁是预筛）

| 层 | 文件 | 结论的地位 |
|---|---|---|
| 静态预筛 | `src/util/session-validate.mjs`（doctor） | 便宜、可离线、覆盖复盘实测的失败类；**不是证据**。它给出的"未来追加"结论带 `evidence: 'static-prefilter'` 标签 |
| 运行时终审 | `src/backup/runtime-validate.mjs` + `runtime-driver.mjs` | 用 `ELECTRON_RUN_AS_NODE=1` 启动安装的 Harness 本体，调用 `sessionFormatCatalog.createRestore(header, {validation:'current'})` → 逐行 `decodeRow` → `finish()`；结论带 `evidence: 'installed-harness'` |
| 门禁 | `validateCandidate` / `validateCandidates` | 先静态预筛（失败即拒，不 spawn）；通过后由运行时终审；`requireRuntime` 为真时**没有安装就拒绝**（`BACKUP_RUNTIME_UNAVAILABLE`），只有 `--allow-static-validation` 才接受纯静态证据，并在结果里写 `runtime_verified:false` |

**行数守恒（v3.4.9 新增的硬规则）**：`decodeRow` 对 seq 不落位的行是**静默丢弃**的（实测：首事件 seq=5 的日志
得到 `events: 0` 且不抛错）。因此 driver 现在要求 `restored.events.length === 输入事件数`，否则判为
`ok:false`，detail 写明"accepted only N of M event(s); rows were dropped, so this verdict is not evidence"。
没有这条规则，"运行时通过"会变成"运行时没吭声"——正是 G5 要禁的那种伪证据。

### 19.2 接线点

* **还原/归档还原**：`planRestore` / `planRestoreFromArchive` 对每份候选调用 `validateCandidates`，把"原日志"和
  "原日志 + 一帧合法追加"**一起**交给运行时批量终审（§17.2）；任一失败整单拒绝。
* **引擎（`run --runtime`）**：可选地对每个会话的"追加后日志"做一次运行时批量终审，结果写入
  `runtime_future_append: {available, evidence:'installed-harness', checked, failed, sessions}`；默认关闭
  （171 MB 真实 home 会多花约 20 s），静态报告同时保留并标 `static-prefilter`。
* **verify（`--runtime` / `GET /api/w2m/backup/verify?runtime=1`）**：对每个快照会话的**原日志与追加后日志**
  同批终审，失败码 `BACKUP_RUNTIME_REJECTED` / `BACKUP_RUNTIME_APPEND_FAILED`。面板自 2026-11-17 起用勾选框
  显式选择这条慢路径（§22.4）：默认不勾，报告只给标了 `static-prefilter` 的模拟结果——不勾就没有门禁级证据。
* **批量与流式**：小 artifact 每约 96 MiB 一批；单会话 JSON 超过 32 MiB 走 NDJSON 流式 driver（真实 152 MB /
  370 MB 会话实测通过）；verdict 缓存按"安装身份 + 内容摘要"分键，避免拿另一份安装的结论复用。
* **缓存终审 + nightly（v3.5.x）**：`?runtime=1` 同步跑完后把结论写成一个**记录**
  `{started_at, finished_at, ok, checked, failed, snapshots, reason_codes, evidence:'installed-harness'}`，
  原子持久化到 `<DSH_HOME>/xclient/w2m-backup/state.json`（`xclient/` 是本包自己的状态区；`storages/` 是客户端
  所有，插件不写）。`GET /verify?runtime=cached` 只读该记录、**绝不 spawn**；`finished_at` 超过 24 h 标
  `stale:true`，没有记录与不可解析的时间戳同样按 stale 报（"没有新证据"不是"新鲜"）。`GET /run` 的内嵌状态带
  `state.last_runtime_verify`（只会是缓存）。插件配置 `backupRuntimeVerify: 'off' | 'nightly'`（默认 `off`，
  非法值 `BACKUP_CONFIG_INVALID` 拒绝挂载）：`nightly` 只在**成功**的定时备份（含错过时段补跑）之后
  fire-and-forget 跑一次，失败只写 warning、记录照样持久化，**绝不让备份或调度失败**；CLI 手动入口
  `w2m-backup run --runtime-verify`（跑完后执行一次并持久化，失败只加 warning，备份结果不变）。

### 19.3 测试

* `test/backup-runtime.test.mjs`：driver 静态证明（含 `createRestore(` 与 `validation: 'current'`，且**不含**
  `diagnoseSessionBuffer`/`splitFrames`——运行时 driver 不许调用我们的解析器）；证据标签检查；seq 缺口日志
  被拒绝且事件数为 0；dense 日志通过且事件数为 2；无安装时 `BACKUP_RUNTIME_UNAVAILABLE`；`requireRuntime:false`
  时静态证据显式降级。
* `test/backup-engine.test.mjs`：`run --runtime` 正向（15/15 类场景用 runtime-valid home）与反向（坏日志的
  追加 artifact 被拒，`failed ≥ 1`，无静态回退）。
* `test/backup-verify.test.mjs`：`--runtime` 连 append 后 artifact 一起终审；缓存记录（字段/证据标签/去重 reason
  codes/24 h stale 边界/持久化路径/in-flight 单次 spawn/失败也持久化）与 CLI `run --runtime-verify` 的持久化记录。
* `test/backup-run.test.mjs`：`?runtime=cached` 不 spawn、过期标 stale、`?runtime=1` 更新缓存、`GET /run` 内嵌
  `state.last_runtime_verify`；`backupRuntimeVerify: 'off'|'nightly'` 的配置归一化，nightly 每个成功定时备份恰好
  跑一次、失败只 warning 且记录持久化、默认 off。
* `test/loader-entry.test.mjs`：真实 Chromium 页面（抛空 profile 安装当前 tarball）断言面板入口与四操作标记。

## 20. G4 收口：seq 重编号工具（v3.4.8/v3.4.9）

复盘 G4 的原文是"删/插事件的唯一合法方式是重编号工具：全局 renumber + 改写所有指向 seq 的引用 + 医生校验"。
v3.4.8 当时**没有做**（还原只发布原始字节，§15.6）；2026-11-17 补全为 `src/backup/renumber.mjs` + 固定 CLI 命令
`w2m-fix renumber` + `test/fix-renumber.test.mjs`。

### 20.1 规则

* **唯一入口**：手工改 JSON 文本是复盘点名的陷阱——删掉一行后 `seq` 不连续，`sourceEventSeqs`/`messageSeqs`/
  `headerSeq`/`surfaceOp.{startSeq,endSeq}` 仍指向旧位置，日志要么打不开、要么以"静默错位的历史"打开。除本工具
  外没有第二条合法路径。
* **输入前提**：待编辑日志必须是**已经 dense** 的 v4 日志（`seq === 数组下标`）。已经跳号的日志拒绝编辑——
  `deleteSeqs` 的地址会歧义，那类日志应该走还原（备份里有原始字节）。
* **引用规则**：任何键名匹配 `/(?:Seq|Seqs)$/`、值为整数（或整数数组）的字段都是引用，一律 old→new 改写；
  递归遍历，所以 `data.sourceEventSeqs`、`data.messageSeqs`、`headerSeq`、`surfaceOp.startSeq/endSeq` 以及将来
  新增的 `*Seq` 字段都被覆盖。指向**被删除事件**的引用直接拒绝（`RENUMBER_DANGLING_REFERENCE`，detail 给出事件
  类型/键/seq），不猜替代值。
* **插入事件**：`atSeq` 把事件插在"当前位于 atSeq 的事件之前"，`atSeq === 事件数` 追加。插入事件自身的 `seq`
  被覆盖为新的 dense 下标；它携带的 `*Seq` 引用按**编辑前**的 seq 解释（因此无法用新 seq 指向另一个插入事件）。
* **inherited 计数**：按"最后一个 `session/end-seed` 且 `data.inherited === true` 的位置"重算
  `inheritedEventCount`；`isSeeded:false` 的日志若算出非 0 直接拒绝（`RENUMBER_INPUT_INVALID`）。
* **编码**：header 单独一帧，随后一条事件一帧（与本包写日志的格式一致），不产生半帧；空编辑集且日志已 dense 时
  原样返回调用方字节（`changed:false`）。

### 20.2 流水线

```
parse（拆帧→解行；torn / 非 v4 / 非 dense / 非法编辑 → 具名拒绝）
  → 应用 delete/insert
  → renumber（seq = 0..N-1）
  → 改写所有 *Seq 引用（悬空 → 拒绝，不猜）
  → 重算 inheritedEventCount
  → 编码（header 单帧 + 每事件一帧）
  → 校验 RESULT：doctor 预筛(G1) + "未来追加"模拟(G3) + 安装 Harness 终审(G5，唯一证据)
  → apply：先写 <file>.bak-<时间戳> 并回读比对 → 原子写 → 回读 sha256 + doctor 复验
```

`planRenumber` 只读、零写入（plan 对象带原始字节、新字节、mapping、校验结论与备份路径）；`applyRenumber` 才写。
`--dry-run` 只走到 plan。

### 20.3 拒绝清单

| 码 | 何时 |
|---|---|
| `RENUMBER_TORN_INPUT` | 尾部有半帧（崩溃残留） |
| `RENUMBER_INPUT_INVALID` | 空文件/非 v4 header/行不是事件/非 dense 输入/越界编辑/插入 `session` header/`isSeeded:false` 却算出 inherited 事件 |
| `RENUMBER_DANGLING_REFERENCE` | 引用指向被删除的 seq（或本来就不存在） |
| `RENUMBER_STATIC_REJECTED` | 结果过不了 doctor（或静态"未来追加"模拟） |
| `RENUMBER_RUNTIME_UNAVAILABLE` | 需要运行时证据但本机没有可用安装，且未给 `--allow-static-validation` |
| `RENUMBER_RUNTIME_REJECTED` | 安装的 Harness 拒绝结果（或"结果 + 一条合法追加"） |
| `RENUMBER_TARGET_CHANGED` | plan 之后文件被客户端追加；apply 拒绝覆盖 |
| `RENUMBER_WRITE_FAILED` / `RENUMBER_VERIFY_FAILED` | 备份/写入失败；写后回读不一致（备份即回退路径） |

### 20.4 CLI

输出新增一行 `edits : -N deleted, +M inserted`（删除/插入条数；`--json` 亦有 `deleted`/`inserted` 字段），
配合 `events : before -> after` 与 `changed seqs` 一起读。

```
node bin/w2m-fix.mjs renumber --file <session.v4.jsonl.zstd> [--delete-seq <n>]...
                                  [--insert-file <json>] [--dry-run] [--allow-static-validation] [--json]
```

* `--delete-seq <n>` 可重复，`n` 是 dense 的零基 seq（即数组下标）。
* `--insert-file` 是 JSON 数组：`[{"atSeq":1,"event":{...}}]`。
* 默认**写入**（与 `fix`/`restore` 需要 `--apply` 不同）：结果已经被 plan 的全部门禁验证，且每次 apply 都先留
  `.bak-<时间戳>`；`--dry-run` 只规划并打印证据。退出码：0 成功、1 具名拒绝、2 用法错误。
* 人类输出：事件数前后、仅变化 seq 的 mapping（约 20 条封顶）、改写引用数、inherited 计数、static/runtime/
  future-append 证据、备份路径；失败打印 `reason_code` 与 detail。`--json` 输出 plan + applied 的可序列化摘要
  （不含 Buffer）。

### 20.5 测试与诚实边界

`test/fix-renumber.test.mjs`（21 项）覆盖：删中间事件（dense、递归引用改写、`surfaceOp` 改写、header/其他字段
保留、mapping/持有计数正确）、插入/追加、悬空引用拒绝且零写入、torn 拒绝、no-op、apply 后再 plan 的幂等、运行时
门禁（安装的 Harness 拒绝静态合法日志 → `RENUMBER_RUNTIME_REJECTED`；注入无安装 → `RENUMBER_RUNTIME_UNAVAILABLE`；
`--allow-static-validation` 才降级且标 `runtime_verified:false`）、`.bak` 保留原始字节 + 写后 sha/doctor 复验、
plan 后文件变化拒绝覆盖、dry-run 零写入、CLI 退出码/帮助/真实入口追加。

**"未来追加模拟失败"分支的可达性（2026-11-17 补齐论证）**：`planRenumber({futureAppendCheck})` 是一条**只有
测试能走**的缝，因为对 `renumberBuffer` 的产出它在构造上不可达：

1. `renumberBuffer` 用 `encodeLog` 规范重编码：header 单独一帧，之后每个事件恰好一帧、一行 JSON；
2. `seq` 被重写为 `0..N-1`（数组下标），附录事件 `permission/preset` 的 seq = 行数−1 = N，仍 dense；
3. 附录事件是会话级、无 turn 状态、无 surface、无任何 `*Seq`/`*Seqs` 键，因此 doctor 的 header/surface/引用
   规则都不会因它改变；header 规则只看第 0 帧，附录只追加新帧。

因此"doctor 通过 + 追加模拟不过"对规范产出**不可能**同时成立，`staticFuture.ok===false` 只可能由注入的
`futureAppendCheck` 产生；测试因此分两层钉住这条边界：`test/fix-renumber.test.mjs` 断言**生产源码中只有
`src/backup/renumber.mjs` 提到该选项**（没有生产调用者传它），并断言规范产出的 `static_future_append.ok` 为真、
安装 Harness 存在时 `future_append_evidence:'installed-harness'` 且结果是 dense；`test/backup-verify.test.mjs`
用缝确定性地驱动拒绝分支（零写入）。**函数级例外（诚实写出）**：非规范输入确实可能"doctor 过、追加模拟不过"
（例如多一行非事件文本使 `countLogRows` 算错下一个 seq，或帧外杂字节让 `scanFrames` 抛错），但那类输入在
`parseLog` 阶段就以 `RENUMBER_INPUT_INVALID` 被拒，根本到不了这个分支；备份/verify 对**原始字节**的追加模拟
仍会如实报告它们（§19.2）。

**诚实边界**：

* 它**改历史**。不是 backup/restore 的一部分——还原永远只发布快照里的原始字节，从不删/插事件；本工具只在
  "没有可用原始字节、必须从当前日志里移除或补一条事件"时使用。
* 每次成功 apply 都在同目录留下 `.bak-<时间戳>`；那是唯一回退路径，不要删。
* **能还原就不要用它"修"**：一条已经跳号/损坏的日志，正确做法是从备份还原并跑 verify；本工具拒绝非 dense 输入
  正是为了不把"修复"变成第二次损坏。
* 失败方向：plan 失败 = 零写入；写入失败 = 原文件仍在（备份先写好）；回读失败 = 报 `RENUMBER_VERIFY_FAILED` 并
  给出备份路径。
* 层规则：工具在 backup 层（复用 backup 的 doctor / 未来追加 / 运行时门禁），命令挂在 fix CLI 上；`fix -> backup`
  是同级边，已在 `scripts/layer-model.mjs` 声明，模块级无环（`backup/renumber -> fix/zstd`，从不 import
  `fix/cli`）。

## 21. 保留策略与异地副本（v3.5.0）

### 21.1 保留策略：份数 + 天数，两条规则同时生效

`old/` 旧版本记录（§13）此前只按"每会话最新 N 份"保留（`keepOldPerSession`，默认 10）。v3.5.0 增加可选的
年龄窗口 `maxAgeDays`（CLI `--max-old-days <n>`、插件配置 `backupOldVersionDays`）：

* **规则（两条同时生效）**：一条版本记录只有在"属于该会话最新 `keep` 份之内"**且**"`recorded_at` 不早于
  `now - maxAgeDays` 天"时才保留；任一条不满足即剪除。因此"最新但超过 N 天"仍按天剪除，"在 N 天窗口内但已超出
  最新 N 份"仍按份数剪除。份数与天数不是二选一，也不存在"哪个更宽松用哪个"。
* **0/缺省**：`0` 或未配置 = 仅按份数（保持 v3.4.7 语义），**不是**"立刻清空"。
* **校验**：`rotation.resolveMaxAgeDays` 在 `engine.runBackup`、`gc`、`rotateForEntry` 写任何盘之前校验；负数/
  小数/非数字具名拒绝 `BACKUP_ROTATION_POLICY_INVALID`；CLI 解析层直接以退出码 2 拒绝；插件 `normalizeConfig`
  对非法 `backupOldVersionDays` 拒绝挂载（`BACKUP_CONFIG_INVALID`）。
* **纯决策面**：`rotation.selectPrunable(records,{keep,maxAgeDays,now})` 不碰文件系统，`pruneOldVersions` 把每个
  会话桶交给它决定——一处规则，rotation 与 gc 两个入口共用。
* **gc 安全性不变**：`gc` 仍是"先收集全部引用（快照 + current + old）→ 有任何不可读即整体拒绝
  `BACKUP_GC_UNSAFE`（一个都不删）→ 删无引用块 → 再剪 old 记录 → 清 tmp"。顺序保证：一次 gc 中被剪掉的 old
  记录不会导致它引用的块在同一次运行里被删（引用集在删除前已固定），这些块最早下一次 gc 才可回收。
  **gc 永远不会删除任何仍被快照/current/old 引用的块**，这条规则没有因为保留策略而放宽。

### 21.2 异地副本（`mirrorRoot` / `backupMirrorDir` / `run --mirror`）

**布局**（镜像根 = 用户指定目录；本地盘/网络盘均可）：

```
<mirror>/
  backup.json                     # 仓库描述（首次复制；openRepo 需要它才能报告 initialized）
  keys.json                       # 权威信封文件（包裹后的 DEK，无明文密钥）
  objects/<aa>/<sha256>           # 本次快照引用的密封块（只补缺失 + 损坏即修）
  snapshots/<snapshotId>/
    manifest.json                 # 加密清单（与主库逐字节一致）
    keys.json                     # 该快照的信封副本
  index.jsonl                     # 按 snapshot_id 幂等追加
```

* **复制时机**：仅在**提交成功且轮转成功**之后；dry-run 不镜像。文件复制一律走 `atomic.writeFileAtomic`
  （临时文件 → fsync → rename），因此镜像里不会出现"名字承诺了内容却没有内容"的块。
* **只补缺失 + 损坏即修**：块按内容寻址，但"名字存在"不等于"内容正确"——镜像块必须与主库源块**字节长度一致**才
  视为已复制（截断/被外部工具改坏的块长度不符），否则用 `writeFileAtomic` 重写并计入 `copied.repaired`；快照
  `manifest.json`/`keys.json` 与根 `backup.json`/`keys.json` 体积小，按**逐字节比较**，长度或内容不符即重写并计入
  `copied.repaired`。完好镜像重复同步仍是幂等的：`copied:{files:0,bytes:0,repaired:0}`、零写入（测试比较镜像文件
  的 size+mtime 不变）。块只比长度是成本选择：本模块从不持 DEK，为省一次写而整块读取不划算；同长度位翻转留给还原
  时的清单 `sha256` 发现（见"边界与诚实说明"）。
* **索引幂等**：镜像 `index.jsonl` 只有在其中**尚无该 `snapshot_id`** 时追加一行（内容与主库 `readIndex()` 的条目
  一致）；重复同步不重复追加。若镜像索引尾部是半行（写入者被强杀），`readIndex` 不把它算作条目，新行以换行分隔
  追加，不会把半行拼接成坏行；即使那半行正是**该快照自己**未完成的追加行，重同步也只补出**一行**完整 JSON，
  `snapshot_id` 不会重复，半行仍作为 problem 如实报告（测试覆盖）。
* **永远不复制**：明文会话字节、明文附件、密码、锁文件、`tmp/`、`logs/`、`current/`、`old/`、`archive/`。
  镜像只承诺"已提交快照的灾难副本"，不是主库工作状态的同步盘；还原时按 `--snapshot` 从镜像快照走。
* **路径拒绝（词法判定 + 真实路径判定）**：`mirrorRoot` 指向仓库内部、`$DSH_HOME` 内部、等于仓库根、或本身是文件 →
  **写盘前**拒绝 `BACKUP_MIRROR_INVALID`（零提交，不留下半次备份）。跨盘/跨机器路径按"外部"处理（`path.relative`
  返回绝对路径）；包含判定按路径段而非字符串前缀（`D:\BackUP2` 不算 `D:\BackUP` 内部）。词法判定用 `path.resolve`
  不解链接，因此**再做一次真实路径判定**：取最深已存在前缀 `fs.realpathSync`（Windows 上解开 junction/symlink）
  再拼上尚未创建的剩余段，对**真实仓库根**与**真实 `$DSH_HOME`** 重复同样的包含判定；经 symlink/junction 实际落进
  仓库或 home → 具名拒绝 `BACKUP_MIRROR_SYMLINK`（零提交）。镜像路径还不存在（首次同步前，含多级未创建）是正常
  情况：按最深存在前缀解析、剩余段照常创建；存在的路径分量无法解析（`ELOOP`/`EACCES`/坏 junction）→ 具名拒绝，
  绝不"按词法假定在外面"。
* **失败语义（关键）**：镜像复制是**加法**，不是提交的前置条件。提交后复制失败**不回滚、不抛异常**：主库结果仍为
  `ok:true`（快照已持久化），结果带 `mirror:{ok:false, reason_code, reason, copied}` 与 `warnings`；
  下一次成功同步会自动补齐缺失块（只补缺失使修复成本等于增量）。
* **可还原性**：镜像带 `backup.json` + `keys.json` + 快照两文件 + 其引用的全部块；`openRepo(mirror)` 报告已初始化，
  用与主库相同的 DEK 对镜像块 `rebuildFile` 可得到与清单一致的 sha256（`test/backup-mirror.test.mjs` 的廉价款
  完整性校验）。
* **边界与诚实说明**：真实路径判定只保证"包含判定按文件系统实际指向执行"，不改变镜像的信任模型。仍**不做跨镜像
  去重**（每个镜像独立持有一份密封块，用空间换恢复独立性）；**未实现**镜像侧 `current/old` 视图与镜像 gc（镜像
  只增，清理由运维按需删快照目录）；**未实现** Relay/云端传输（Phase 3）。对象修复的判据是**字节长度**：同长度
  位翻转/内容篡改不在同步时检测（本模块不持 DEK、不重算清单），由还原时的清单 `sha256` 校验发现；镜像路径仍受
  §19 的 `$DSH_HOME` 判定约束，故"把镜像放进 home 图省事"明确不支持。

### 21.3 配置面与错误码

| 入口 | 保留策略 | 异地副本 |
|---|---|---|
| CLI | `w2m-backup run/gc --max-old-days <n>`（0 = 仅份数） | `w2m-backup run --mirror <dir>` |
| 插件配置 | `backupOldVersionDays`（非负整数，缺省 = 仅份数） | `backupMirrorDir`（路径，缺省 = 不同步） |
| 引擎 | `runBackup({maxOldVersionDays})` | `runBackup({mirrorRoot})` |

| 错误码 | 含义 |
|---|---|
| `BACKUP_ROTATION_POLICY_INVALID` | 保留策略值非法（负数/小数/非数字），写盘前拒绝 |
| `BACKUP_MIRROR_INVALID` | 镜像路径非法（仓库/home 内、等于仓库根、是文件、存在分量真实路径不可解析），零提交拒绝 |
| `BACKUP_MIRROR_SYMLINK` | 镜像经 symlink/junction 的真实路径落在仓库或 home 内（词法路径在外也算），零提交拒绝 |
| `BACKUP_MIRROR_FAILED` | 提交后复制失败；主库仍 `ok:true`，结果含 `mirror` 与 `warnings` |
| `BACKUP_GC_UNSAFE` | 存在不可读引用，gc 整体不删除（v3.4.7 规则不变） |

成功同步时 `mirror.copied:{files,bytes,repaired}`：`files`/`bytes` 是本次写入量，`repaired` 是其中"镜像已存在但
字节不符、被重写"的文件数（完好镜像为 0）。

### 21.4 测试

`test/backup-rotation.test.mjs`：`selectPrunable` 份数/天数/两者交互/0-缺省/非法值/注入 `now`；`pruneOldVersions`
与 rotation 的两条规则同时生效、dry-run 零删除。`test/backup-gc.test.mjs`：`maxOldVersionDays` 生效、被快照引用的
块不被删、`BACKUP_GC_UNSAFE` 不变。`test/backup-mirror.test.mjs`：只补缺失 + 第二次同步幂等（`copied.repaired:0`、
size+mtime 证明零写入）、截断块与损坏的 `backup.json`/快照 `manifest.json` 在下次同步被修（`copied.repaired>=1`
且字节与主库一致）、索引只追加一次 + 尾部半行（含某快照自己的半行）不重复 `snapshot_id`、镜像路径四类拒绝、
symlink/junction 真实路径逃逸具名拒绝（环境禁止建 junction 时按名跳过）与不存在的多级镜像路径仍可创建、复制失败
不回滚（`ok:true` + `mirror.ok:false` + warnings + 主库可读）、镜像侧
`openRepo`+`rebuildFile` 完整性、`resolveMirrorRoot` 的路径段包含判定。`test/backup-run.test.mjs`：引擎传递与
CLI `--max-old-days`/`--mirror` 解析。插件配置归一化在 `test/backup-run.test.mjs` 覆盖（`backupOldVersionDays` /
`backupMirrorDir`）。

## 22. G2/G3/G4/G5 收口补记（2026-11-17）

v3.4.9 面板与 v3.5.0 非 UI 半之后，复盘门禁的四个"最后一段"补成可执行、可测试的入口。本节只记新增面与诚实边界，
既有协议（§15–§21）不变。

### 22.1 G2：`w2m-backup register` 一等公民入口（`src/backup/register.mjs`）

2026-11-17 的现场修复是"手写脚本把磁盘上的会话加进 `workspace.json`"。那次脚本有两个缺陷：没有走 G2 协议
（客户端门禁 + 回读 + 保存后复查），且用默认值重建 archived/pinned —— 把一个**已归档**的会话静默取消了归档。
`register` 把这个动作变成一个具名命令，流水线就是 G2 的三半：

```
解析每个 --session 对应的磁盘目录（与 doctor 同一个 listSessionDirs 走法，工作区 slug 取路径段）
  → 客户端门禁：客户端在跑就拒绝（BACKUP_CLIENT_RUNNING），除非 --allow-live-home
  → 读注册表视图，取会话**当前**的 archived/pinned；已登记 = 该 id 完全 no-op（不重写，不可能改旗标）
  → 复制 workspace.json 到 <DSH_HOME>/.w2m-restore-backups/register-<ts>/workspace.json（回退路径）
  → 整次一个文档 planRegistryRestores → 原子写 → 回读校验（applyRegistryRestore）
  → 可选 --registry-recheck <ms>：等一个客户端保存窗口后复查（recheckRegistry）
  → 可选 --watch <minutes>：按 2/8/20/60 s、之后每 60 s 采样直到分钟预算；发现被覆盖就重放同一 plan
（宿主内有第二条路径：ctx.workspaceRegistry.attachSession，见下）
```

* 输入：`--session <id>`（可重复）、`--workspace-path <dir>`（**唯一**能创建/挂接未知工作区的方式）、
  `--allow-live-home`、`--registry-recheck <ms>`、`--watch <minutes>`、`--json`、`--dsh-home`、`--dry-run`。
* 返回 `{ok, registered, already_registered, unknown, actions, verified, backup_file, recheck?, watch?, residual_risk}`；
  磁盘上找不到的 id 整单拒绝 `BACKUP_REGISTER_SESSION_MISSING` 并列出（register 只让已存在会话可见，不创建会话）。
* **有界 watch（v3.5.x）**：apply 成功后按 2 s / 8 s / 20 s / 60 s、之后每 60 s 采样，直到 `--watch` 的分钟预算
  （0 = 默认，不监视）。任一样本显示登记被客户端覆盖，就用 `recheckRegistry` **重放同一 plan**（注册表副本已在
  apply 时取过，不会写第二份），计 `clobbered/reapplied`；最终报告
  `watch: {minutes, samples, clobbered, reapplied, stable_at}`，并在文本输出打一行诚实残余风险：
  `a client save after the watch window can still remove it; re-run or enable the plugin route`。watch 缩小并量化
  了窗口，**没有**消除它。
* **宿主服务路径（v3.5.x，安装的 Harness 存在时）**：Harness 的 `@deepseek-ai/dsh-workspace` 把
  `ctx.workspaceRegistry` 注册到 Cordis 宿主上下文；它拥有内存域与 `storages/workspace.json`，先持久化再改内存并
  发 `domain/changed`，GUI 读的是该投影。因此 `registerThroughHost()` 用 `resolveByPath`/`create` +
  `attachSession(sessionId)` 登记，**不写文件，也就没有客户端保存可覆盖**（`residual_risk:null`）。面板路由
  `POST /api/w2m/backup/register {confirm:'register', session_ids}` 优先走它；宿主没有该服务（或离线 CLI）时才退回上面的
  文件路径（响应 `via:'file-write'`，带 watch 与残余风险），**不会静默降级**。服务自己的 `attachSession` 校验
  （会话必须被 `sessionPersistence` 认识、header cwd 必须 realpath 到工作区路径）拒绝时按 `BACKUP_REGISTER_HOST_*`
  具名报告，不回退文件写。
* 退出码与 restore 一致：0 成功、1 具名拒绝、2 用法错误。
* 归档/置顶 = **读出来再写回**，绝不默认；已登记会话不进 plan，因此第二次运行是 no-op（`already_registered`），
  连注册表副本都不写。`register-*` 目录只由 register 自己按份数保留（默认 10，0 = 全留，当前次副本永不删）；
  `listPreRestoreSnapshots` 只认时间戳目录，restore 的保留策略不会把注册表副本算进去、也不会删它。
* 测试：`test/backup-g2.test.mjs` 新增 15 条（watch 调度/预算/时钟注入、无覆盖 `clobbered:0`、模拟覆盖后
  `reapplied:1` 且不写第二份副本、CLI `--watch` 的 JSON/文本/残余风险行/参数错误、`registerThroughHost` 的
  服务写入/已登记 no-op/无服务具名拒绝/attach 拒绝不回退）；`test/backup-run.test.mjs` 新增 2 条路由测试
  （无服务时 file-write + 30 s 有界 watch + residual_risk；有 `ctx.workspaceRegistry` 时 host-service、
  workspace.json 字节不变、不跑 watch）；面板代价见 §22.4。
* 残余风险：**只有文件路径有**（离线 CLI，或配置隐藏了 workspace 服务的宿主）——watch 窗口之后的客户端保存仍可能
  覆盖；要彻底消除，必须在宿主内走 `workspaceRegistry` 服务（面板路由已优先这样做），或停掉客户端再跑 CLI。
  服务路径的残留边界是 Harness 自己的 `attachSession` 校验范围（cwd 已不存在等灾难恢复场景它不接），那种 case 由
  CLI 文件路径 + watch 兜住。

### 22.2 G3：一条证据测试覆盖每条"会改字节/改声明"的路径

| 路径 | 证据断言（`test/backup-verify.test.mjs`） |
|---|---|
| restore 计划 | 每个候选的 `validation.future_append === true`，且 `runtime_verified === true`（安装 Harness 时；无安装则跳过） |
| renumber 计划 | 结果带 `validation.future_append`（静态路径 = `true`，标 `static-prefilter`）；未来追加模拟失败时 plan 拒绝 `RENUMBER_STATIC_REJECTED` 且零写入 |
| verify 报告 | `future_append.evidence === 'static-prefilter'`、`runtime_verified.evidence === 'installed-harness'`——报告不能把预筛当门禁（G5） |

renumber 的"追加后日志失败"分支用 `planRenumber({futureAppendCheck})` 测试缝驱动。该分支对规范产出**不可达**：
`renumberBuffer` 规范重编码（header 单帧 + 每事件一帧、`seq===下标`、附录 `permission/preset` 是下一 dense seq、
无 surface/引用），doctor 通过则追加模拟必过（完整论证与"函数级例外"见 §20.5）。测试因此同时机器校验：生产源码
中**只有** `src/backup/renumber.mjs` 提到该选项（无生产调用者传它），且规范 plan 的
`static_future_append.ok===true`；安装 Harness 存在时 `future_append_evidence==='installed-harness'`。
§22.2 新增：`test/backup-verify.test.mjs` 仍用缝驱动"拒绝且零写入"的调用点。

### 22.3 G4：renumber 兄弟副本保留上限

`applyRenumber` 每次成功都写 `<file>.bak-<timestamp>`，此前无上限。现在成功写入并回读校验后调用
`pruneRenumberBackups({file, keep, dryRun, protect})`：

* 只看本工具命名的副本（`<log>.bak-<YYYYMMDDTHHMMSSZ>[-<n>]`；`w2m-fix fix` 的 `.bak-<stamp>` 不匹配、不删）；
* 按名字里的时间戳保留最新 `keep` 份，**当前次运行的副本用 `protect` 传入，永不删除**（plan 与 prune 之间时钟
  漂移或别的写入者时间戳更新时，"改日志"不能变成"删掉回退路径"）；`0` = 全留；无法删除的旧副本留在列表里，
  不把删除失败升级成写入失败；
* 只在成功路径剪：失败路径保留全部副本（最新那份正是现场要用的）。
* CLI：`w2m-fix renumber --keep-backups <n>`（默认 5，0 = 全留）；非负整数之外的用法错误退出 2。结果与人类输出
  新增 `backups kept : N of M (pruned K; --keep-backups 5)`。测试：`test/fix-renumber.test.mjs` 新增 6 条（保留最新
  N、dry-run 零删除、当前次副本永不删、keep=0、默认 5、CLI 解析/帮助/真实入口）。

### 22.4 G5：面板勾选运行时终审（慢）

校验卡新增一个**默认关闭**的勾选框（i18n `panel.backup.verify.runtime`，zh「用安装的 Harness
终审（慢）」/ en `Runtime verdict with the installed Harness (slow)`），旁边一行提示
`panel.backup.verify.runtimeHint`：会用安装的 Harness 逐条终审、可能耗时数分钟、本机必须已安装。勾上时
`verifyNow` 请求 `GET /api/w2m/backup/verify?runtime=1`（宿主路由已支持，§19.2），不勾就是便宜的那条。结果区域
仍显示 `runtime_verified` 计数（文案键改为 `panel.backup.verify.runtimeCounts`，原 `…verify.runtime` 已被勾选框
标签使用）；问题列表里的稳定码经 `backupReasonText` 翻成可操作句子（`BACKUP_RUNTIME_UNAVAILABLE` /
`BACKUP_RUNTIME_REJECTED` 本来就在映射表里）。校验卡改为常驻（之前结果为空时整卡不渲染），否则勾选框在点
「全量校验」之前无处可点。面板 i18n 由 121 键增至 123 键（`…verify.runtimeCounts` 与 `…verify.runtimeHint` 为
新增，`…verify.runtime` 为复用改文案）。测试：`test/client-bundle.test.mjs` 新增 1 条（未勾选只请求无参数 URL、
勾选后请求 `?runtime=1`、默认关闭、中英字典有标签与提示、问题码走映射），既有 67 条保持通过（checkbox 计数
按 `data-w2m-backup-session` 收窄）。

**缓存终审与「立即运行」按钮（v3.5.x 补）**：校验卡现在先显示缓存记录：`state.last_runtime_verify` 的
`finished_at`（本地时间）、`checked/failed`、快照数、证据标签 `installed-harness`，以及 24 h 过期徽标
（`data-w2m-backup-runtime-cached = none|fresh|stale`，stale 时另渲染 `data-w2m-backup-runtime-stale` 标签）。
「立即运行（慢，需要安装 Harness）」按钮（`data-w2m-backup-action="verify-runtime"`）是唯一同步触发终审的控件：
请求 `GET /api/w2m/backup/verify?runtime=1`，期间 `busy='verify-runtime'` 禁用所有操作并显示进度，结束后重读
`GET /run` 的内嵌状态刷新缓存块。原勾选框保留：它决定「全量校验」按钮走静态（无 `?runtime`）还是运行时
（`?runtime=1`），两个入口共享同一份缓存记录。i18n 新增 zh/en 键：`panel.backup.action.verifyRuntime`、
`panel.backup.busy.verifyRuntime`、`panel.backup.log.verifyRuntime`、`panel.backup.verify.cachedTitle/cachedLine/
cachedNone/stale/fresh`。测试：`test/client-bundle.test.mjs` 新增 3 条（缓存三态与证据标签/过期徽标；运行按钮
禁用态与忙碌文案；真实页面点击 `verify-runtime` 发 `?runtime=1`、点击「修复注册表」发
`{confirm:'register', session_ids:[未登记会话]}`）。

**面板的「修复注册表」按钮（G2，v3.5.x 补）**：状态卡新增 `data-w2m-backup-action="repair-register"`，登记**勾选
会话**，没有勾选时登记只读扫描里的**未登记会话**；两者皆空则禁用（不发空请求）。成功后显示
`已登记/已存在/被覆盖/已重放` 四个计数；只有 file-write 路径（响应 `residual_risk` 为字符串）才渲染一行
`panel.backup.register.residual` 残余风险，host-service 路径不渲染（服务自己持久化并推送 GUI，没有可覆盖的文件
写入）。i18n：`panel.backup.action.repairRegister`、`panel.backup.busy.repairRegister`、
`panel.backup.status.registerFix`、`panel.backup.register.done/residual`、`panel.backup.log.repairRegister`。

### 22.5 诚实边界（本次不承诺的）

* register 的文件路径仍依赖客户端门禁 + 保存后复查/有界 watch；**窗口之后的客户端保存仍可能覆盖**（§16 末同一条
  残余风险）。watch 把它缩小到一个明确预算并给出 `clobbered/reapplied` 数据，不声称消除。消除路径只有一条：
  在宿主内走 `ctx.workspaceRegistry`（面板路由在有该服务时优先走它；离线 CLI 没有宿主上下文）；该服务也有自己的
  边界——`attachSession` 要求会话被 `sessionPersistence` 认识且 header cwd realpath 到工作区，cwd 已消失的灾难
  恢复场景它不接，那种 case 仍要离线 CLI + watch。
* 面板运行时终审仍是 opt-in（慢）：勾选框让「全量校验」同步跑 `?runtime=1`，或点「立即运行（慢）」按钮；缓存块
  只读最近一次记录并明确标 stale（>24 h）。nightly 只在配置 `backupRuntimeVerify: 'nightly'` 时启用，默认 `off`；
  失败的终审只记 warning 并持久化失败记录，**不**让备份/调度失败，也**不**回滚已提交备份。
* renumber 的"追加后失败"拒绝分支在规范产出上不可达（§20.5 论证），只由测试缝驱动；生产代码里该选项只有一个
  定义处、没有调用者，测试机器校验了这一点。文件级例外（非规范输入）由 `parseLog` 在更早处具名拒绝，不会走到分支。
* renumber 副本保留只处理**兄弟副本**；它不清理 `$DSH_HOME` 其它位置的副本，也不动 `old/` 版本记录（那是
  §21 的保留策略）。
* 本次不 bump 版本号、不跑 preflight、不提交；G2/G4 的新测试挂在既有套件上（`backup-g2` / `fix-renumber`），
  没有新增测试文件，`package.json#scripts.test` 清单不变。


## 23. 双解锁：给机器信封仓库补 password 信封（2026-11-17）

**问题**：调度的无人值守备份只会创建 `machine` 信封（定时器不能输入密码）。如果这台机器重装/换用户，
DPAPI 解不开，仓库就再也打不开——而 `password` 是唯一跨机器的路径。此前只在"建库时提供了密码"才会写
password 信封，**事后无法补**。

**实现**：`addPasswordEnvelope(keys, dek, password)` + `setRepositoryPassword({root, dshHome, password, ...})`
（`src/backup/keystore.mjs`）与 CLI `w2m-backup unlock --set-password`：
1. 先用现有凭据打开仓库（machine 或已有 password）——拿到的 **DEK 不变**；
2. 用同一个 DEK 再包一个 `password` 信封（scrypt，现有 KDF floor）；
3. 写前把原 `keys.json` 复制为 `keys.json.bak-<ts>`，再用原子写替换；
4. 写后**只用新密码**单独解一次并与 DEK 比对，失败即报错（旧文件仍在备份路径）。

**约束与边界**：密码只从 stdin（`--password-stdin`）或 `W2M_BACKUP_PASSWORD` 读取，绝不走 argv/配置；
最短 4 字节（4-6 位数字 PIN 是预期用法，见 §25.0）；重复调用是 no-op（不会重写文档）；已有 password 信封的
仓库不会被覆盖——换 PIN 由独立的轮换命令负责（`rotatePassword` / `w2m-backup unlock --rotate-password`，见
§25.8），它不是本函数的副作用。

## 24. `oldFormat: full`：字面兼容的整文件加密副本（P2，未发布）

**问题**：§13/§21 的 `old/` 存的是**去重记录**（`<ts>-<sha12>.json`：rel/size/sha256/blocks +
`snapshot_id`/`superseded_by`），能逐字节还原上一版，但磁盘上并不存在"上一版文件"这个对象。计划里原本写的是
`old/<ws>/<sid>/<ts>-<sha12>.zst.enc`（把上一版整文件加密复制过去）；用户明确要这个**字面兼容**选项，同时
默认必须保持去重记录（否则 §13 开头算过的那笔账重新成立）。

**实现**：新增选项 `oldFormat: 'records' | 'full'`，默认 `records`（行为、结果形状、`old/` 文件都与本功能之前
逐字节一致）。`full` 在**每次真正轮转时**，除现有记录外再写**一份**密封整文件副本：

```
old/<ws>/<sid>/<ts>-<sha12>.json       # 版本记录（不变；format 仍是 w2m-session-backup/old-version v1）
old/<ws>/<sid>/<ts>-<sha12>.json.enc   # full 新增：该版本的整文件密文（同一 stamp、同一 sha12）
```

* **记录新增字段**（纯加法，旧读取者忽略）：`full_copy: {file, sha256, size}`，`file` 是仓库相对路径
  （正斜杠），`sha256`/`size` 是**明文整文件**的摘要与长度（`openObject` 校验用的同一身份）。
* **明文来源**：不是重读磁盘上已经变化/消失的源文件，而是用该版本记录自己的 blocks 经
  `materialize.rebuildFile`（还原路径的同一实现）重建，并先与记录的 `sha256`/`size` 比对；不一致即拒绝。
* **封印身份**：复用块对象的信封形状（`sealObject`：`MAGIC | nonce | ciphertext | tag`，AES-256-GCM），
  但 AAD 容器名不同——`w2m-session-backup/old|<sha256>|<length>`（块是
  `w2m-session-backup/object|<sha256>|<length>`；见 `crypto.OLD_COPY_KIND`）。两个命名空间不互通：整文件副本
  不能当块打开，块也不能当副本打开，测试两条都断言。**没有新密码学，只有新的 AAD 身份**。
* **写序**：先写 `.enc`（`writeFileAtomic`），再写记录。记录里出现 `full_copy` 就保证副本已经在盘上。

**存储诚实**：`full` 让每个被淘汰版本的字节**再加一份**（在去重 blocks 之上整文件复制）。按 §13 的例子，
114 MB 的会话每天变一次、窗口 10 份 ≈ 多 1.1 GB——这正是默认 `records` 要避免的成本，所以 `full` 是 opt-in，
且 CLI 人类输出会写 "storage doubles per superseded version"。此外 `full` 轮转时整文件会在内存里重建一次
（与 restore 相同的峰值），默认模式没有这笔开销。

**失败与崩溃语义**：

| 情况 | 行为 |
|---|---|
| 副本重建失败（块缺失/认证失败/记录的 sha 不符） | 轮转拒绝 `BACKUP_ROTATION_WRITE_FAILED`；**不写记录**（记录不能承诺不存在的副本） |
| 副本写失败（目录不可写/`old/` 是文件/磁盘满） | 同上，具名拒绝；`current/` 指针不前移 |
| 记录已写、写指针前崩溃 | 与 v3.4.7 相同：重跑按幂等文件名重记；`full` 会重写同名 `.enc` |
| 副本已写、记录写失败 | 留下一个无人引用的 `.enc`：**无害**，`gc` 下次安全运行时清掉（见下） |
| 记录已剪、副本未删（崩溃窗口） | 同上，孤儿 `.enc` 由 `gc` 清理 |

**剪枝与 gc**：`pruneOldVersions` 在剪掉一条记录时**先删记录、再删配对副本**（顺序写进代码注释与本文；反过来会
留下"记录指向缺失副本"的坏状态）。`gc` 在安全路径（引用集已收集且无不可读）上，于剪枝之后扫描 `old/` 下所有
`.json.enc`，删除**没有任何剩余记录引用**的副本；被记录引用的副本永不删。`BACKUP_GC_UNSAFE`（任一引用不可读）
仍然整体拒绝、零删除——孤儿副本清理也不会越过这条规则。结果新增：`old_versions.full_copies_pruned`、
`orphan_full_copies: {scanned, removed, reclaimed_bytes}`；`pruneOldVersions` 结果新增 `full_copies_removed`。

**接口面**：

| 入口 | 形状 |
|---|---|
| CLI | `w2m-backup run --old-format records\|full`（非法值退出码 2；人类输出新增 `old format` 行，仅 `full` 时打印） |
| 插件配置 | `backupOldFormat: 'records' \| 'full'`，缺省 `records`；非法值拒绝挂载 `BACKUP_CONFIG_INVALID` |
| 引擎 | `runBackup({oldFormat})`，写盘前校验；结果 `old_format` 恒有，`full_old_versions: [<相对路径>…]` 仅 `full` 时出现 |
| 轮转 | `rotateForEntry({format, dek})` / `recordSupersededVersion({format, dek})`；`dek` 仅 `full` 需要 |
| 整文件副本 cap | `runBackup({maxFullCopyBytes, allowLargeFullCopy})` / 配置 `backupFullCopyMaxMb`（缺省 300，`0` = 不设上限）/ CLI `--max-full-copy-mb <n>` 与 `--allow-large-full-copy`；写盘前拒绝见 §24.2 |
| 错误码 | `BACKUP_ROTATION_FORMAT_INVALID`（未知 `oldFormat`，写盘前）、`BACKUP_ROTATION_WRITE_FAILED`（副本或记录写失败） |
| cap 错误码 | `BACKUP_FULL_COPY_APPROVAL_REQUIRED`（`full` 副本超限且未特批，写盘前、零写入，见 §24.2） |

**兼容性**：记录的 `format`/`version` 字段不变（仍 `w2m-session-backup/old-version` v1），`full_copy` 只是新增
可选字段；`listOldVersions`/`readOldRecords` 只认 `.json`，`.json.enc` 不会被当记录读取；`verify` 仍按记录
blocks 重建旧版本，不把 `.enc` 计入引用。

**测试**（挂在既有套件上，无新测试文件）：`test/backup-rotation.test.mjs`（默认/非法值、写记录+副本、用
`openObject` 以 `old` 身份解开并逐字节比对、块身份解不开、records 模式无 `.enc`、剪枝删配对副本、副本写失败/
重建失败/缺 DEK 三种具名拒绝且零记录、指针不动）；`test/backup-gc.test.mjs`（孤儿副本删、被引用副本留、剪枝
连带删、dry-run 只报不删、`BACKUP_GC_UNSAFE` 零删除）；`test/backup-engine.test.mjs`（`runBackup({oldFormat:'full'})`
轮转并回报 `full_old_versions`、默认无该键、非法值在 ensureLayout 前拒绝、副本写失败时 `committed:true` +
`BACKUP_ROTATION_WRITE_FAILED`）；`test/backup-run.test.mjs`（CLI 解析/退出码 2/真实入口、人类输出、插件配置归一化）。

**诚实边界（本次不承诺的）**：

* **还原/归档/校验不用这份副本**：restore/archive/verify 仍走记录 + blocks；`.enc` 是"字面兼容"的额外副本，
  可以用仓库 DEK 与 `openObject(bytes, dek, {sha256, size, kind:'old'})` 手工验证（测试即这么做的），但还没有
  "从 full 副本直接还原"的命令。要看副本内容，用现有记录即可；副本的用途是让磁盘上真的存在上一版整文件。
* **镜像不含 `old/`**（§21.2 的"永不复制"不变）：异地副本只承诺已提交快照，`full` 的整文件副本不进镜像。
* **不去重副本**：`.enc` 按版本整份写；同一会话两次轮转之间未变的字节不会被合并（这正是 opt-in 的代价）。
  也不跨仓库去重。
* **`verify` 尚未逐份解密 `.enc`**：损坏的副本要等 gc/人工按上面的 `openObject` 方式发现；记录本身的完整性
  校验不变。
* 本次不 bump 版本号、不跑 preflight、不提交；与 §13/§21 的默认行为完全一致（默认 `records`）。

### 24.1 迁移：给既有 `old/` 记录补整文件副本（`w2m-backup old-backfill`）

**问题（为什么需要一次性迁移）**：`full` 只在**版本被淘汰的那一刻**写整文件副本。本功能之前创建的仓库里，`old/`
只有去重记录；把配置切到 `full` 之后，**已有记录**仍然没有副本，要等对应会话**再次变化**才会补上——而最老的那些
版本（迁移最想保住的部分）可能再也不会变化。因此 `full` 上线时提供一条显式迁移命令，而不是把"下一次 run 会慢慢
修好"当成立不住的安慰。

**做什么**：`w2m-backup old-backfill`（`src/backup/old-backfill.mjs` 的
`backfillOldFullCopies({root, dshHome, password?, accountId?, platform?, runner?, machineKey?, dryRun?, limit?})`）
对每条**没有** `full_copy` 的记录：用该记录自己的 blocks 经 `materialize.rebuildFile` 重建明文 → 与记录的
`sha256`/`size` 比对 → 用 `sealObject`（`kind: 'old'`，即 `w2m-session-backup/old|<sha256>|<length>`）封印 →
写到与 full 模式**同名**的 `<record>.json.enc`（`FULL_COPY_SUFFIX` / `oldFullCopyPath` 的命名契约）→ 最后原子地
给记录补 `full_copy: {file, sha256, size}`（记录的 `format`/`version` 不变）。写序与轮转一致：**先副本、后记录**。
仓库 key 打不开 → `BACKUP_NO_PERMISSION`；另一个写者持锁 → `BACKUP_LOCKED`；目录不是本仓库格式 →
`BACKUP_REPO_NOT_INITIALIZED`（迁移命令绝不向任意目录写 `keys.json`）。逐记录的失败用
`BACKUP_OLD_RECORD_INVALID`（记录描述的字节与自身 blocks 重建结果不符、或 `full_copy.file` 越出 `old/`）与
`BACKUP_OLD_BACKFILL_FAILED`（重建/写入/记录更新失败）报告在 `failed: [{record, reason_code, detail}]` 里。

**先 dry-run，再迁移**：`w2m-backup old-backfill --dry-run`（可加 `--json`）只读旧记录内容与副本文件长度做计划：
报告 would-backfill / would-repair / already-full / orphan 计数，并明确打印 "nothing was written"；它**不取锁、
不打开 key**（与 `run --dry-run` 同一规则），所以不可能产生任何写入。先跑它确认路径与数量，再去掉 `--dry-run`。

**幂等**：对已迁移的记录，第二次运行只报 `skipped`（`backfilled: 0, repaired: 0, bytes_written: 0`）；不重写
记录、不重写副本。可以安全地重复执行，也可在中断后直接重跑。

**修复（torn copy）**：崩溃可能留下**短写**的 `.enc`。`backfill` 把记录里 `full_copy.size`（明文长度）+
`SEALED_COPY_OVERHEAD`（`MAGIC|nonce|tag` = 36 字节）当作副本**应有的磁盘长度**，长度不符或文件缺失时重建并
**重写**该副本（`repaired`）；副本元数据与记录不一致时一并把记录里的 `full_copy` 改回正确值。孤儿 `.json.enc`
（没有任何记录引用）只**计数**（`orphans`），**不在此命令删除**——删除只属于 `gc` 的安全路径（§24 的
`collectOrphanFullCopies`），保持"没有完整引用集就不删副本"的规则。

**限制与诚实边界**：`--limit <n>` 限制本次**写副本**的数量（0 = 只出计划；已完整的记录/失败记录不消耗预算），
用于大仓库分批迁移，反复运行直到 `backfilled`/`repaired` 为 0。副本检查只覆盖**长度**：长度正确但内容被同长度
篡改的副本不会被本命令发现（`verify` 也尚未逐份解密 `.enc`，见上面的诚实边界）。本命令不改配置、不自动启用
`full`、不自动运行（引擎**不**自动回填），只补磁盘上已有的记录；`run`/`gc` 的默认行为不变。

### 24.2 整文件副本的 300 MB 上限与「特批」流程（v3.5.0）

**问题**：§24 的 `full` 让每个被淘汰版本的字节**再加一份**。默认窗口 10 份时，一个 400 MB 的会话每次变化都会
悄悄多出 400 MB；如果它每天变一次，一年就是 ~146 GB。`full` 是用户明确要的选项，但"一次写入就能让仓库翻倍"
不能是**无人值守**路径的默认结果——尤其不能是 22:00 定时备份的默认结果。

**常量与默认值**：`rotation.mjs` 的 `DEFAULT_FULL_COPY_MAX_BYTES = 300 * 1024 * 1024`（300 MiB）。配置面：

| 入口 | 形状 | 缺省 |
|---|---|---|
| 引擎 | `runBackup({maxFullCopyBytes, allowLargeFullCopy})` | 缺省 300 MiB；`0` = **不设上限**（显式关闭，不是缺省） |
| 插件配置 | `backupFullCopyMaxMb: <非负整数>`（MB；`0` = 不设上限） | `300`；非法值拒绝挂载 `BACKUP_CONFIG_INVALID` |
| CLI | `run --max-full-copy-mb <n>`（MB，`0` = 不设上限）、`run --allow-large-full-copy` | 缺省 300 MB；非法值退出码 2 |
| 面板 | 从 describe 的 `full_copy_max_mb` 读取；不写请求体里的 cap | 与行配置一致 |

`maxFullCopyBytes: 0` 是**显式**的"我接受任意大小的整文件副本"，不是"没有配置"；非法值（负数、小数、字符串、
`true`）一律具名拒绝（引擎 `BACKUP_ROTATION_POLICY_INVALID`，插件配置 `BACKUP_CONFIG_INVALID`，CLI 退出码 2），
绝不静默回退到默认或静默关闭上限。

**写盘前拒绝（选定的设计：零部分状态）**：`full` 模式下，引擎在**落盘布局（ensureLayout）、取锁、开 key 之前**
先用只读扫描得到本次要备份的会话及其文件大小（`scan.mjs` 的 `size` 正是"将被淘汰、成为旧版本"的那一版的大小）。
只要任一文件 **大于** cap 且本次运行没有显式批准（`allowLargeFullCopy` 严格等于 `true`），运行返回：

```
{ ok:false,
  reason_code: "BACKUP_FULL_COPY_APPROVAL_REQUIRED",
  codes: ["BACKUP_FULL_COPY_APPROVAL_REQUIRED"],
  detail: "<计数、cap 字节数、前 20 个会话的 session_id/rel/size/cap 的可读列表>",
  full_copy_oversized: [{session_id, rel, size, cap}, ... 最多 20 条],
  over_cap_count: <全部超限会话数>,
  cap_bytes: <本次生效的 cap 字节数>,
  dry_run: <boolean> }
```

**什么都不会写**：不建仓库目录、不写 blocks/snapshot/index、不写 `old/` 记录、不动 `current/` 指针、不写镜像。
因此"被拒绝"是一个**完整、安全、可重试**的状态，而不是半个快照；`records` 模式不写整文件副本，**完全忽略**这个
cap（它不是 `full` 的成本来源）。任何真值（`1`、`"yes"`）都不算批准——批准是操作者的一个明确动作，不能从
truthy 值推断。首次备份同样受检查（第一版超大也先拒绝，而不是"先写一次再说"）。**`--dry-run` 也返回同一个
拒绝**：计划本身同样受 cap 约束，避免 dry-run 说"没问题"而真跑被拒；它的结果里 `dry_run: true` 原样保留。

**批准路径（三条，都是显式动作）**：

1. **引擎**：`runBackup({allowLargeFullCopy: true, ...})` 重跑同一次备份。成功结果新增
   `full_copy_approved_over_cap: [{session_id, size}]`（只在该次运行确实批准了超限会话时出现），并且**被轮转到
   `old/` 的那条旧版本记录自己的 `full_copy` 上**写入 `approved_over_cap: true` + `cap_bytes`——批准与它买下的字节
   记在同一个文件里，读 `old/` 的人无需翻运行日志就知道这是"被特批过的副本"。
2. **CLI**：`w2m-backup run --allow-large-full-copy` 直接非交互批准。**没有**该 flag 且 stdin 是 TTY 时，CLI 拒绝后
   只问一次：`N 个会话的 full 副本超过 <cap> MB（<前几个 session_id>）：是否特批本次写入？[y/N] `，默认 N；
   回答 `y`/`yes`/`是` 才带批准重跑**同一次** run（只能批准这一次，不是永久关闭 cap），回答其它则保持拒绝并且
   **零写入**。stdin **不是** TTY 时不提问：打印 `--allow-large-full-copy` 提示并以退出码 1 结束（`--json` 模式下
   问题与提示走 stderr，stdout 保持可解析的 JSON）。人类输出列出超限会话、cap 与下一步命令；批准成功时打印
   `approved cap` 行。
3. **面板**：`POST /api/w2m/backup/run` 的拒绝响应里带 `reason_code === 'BACKUP_FULL_COPY_APPROVAL_REQUIRED'`
   时，面板打开确认对话框（`role="dialog"`、`[data-w2m-backup-approval-dialog]`），列出超限会话与大小，
   提供「特批并继续」（重新 POST `{confirm:'run', scope, allowLargeFullCopy:true, …}`）与「取消」（只关闭，**不发
   任何请求**）。对话框**从不自动批准**（只有确认按钮会带上 flag），也不涉及任何密码/PIN；打开/关闭遵循与解锁
   对话框相同的焦点/ESC/遮罩规则。

**定时路径：绝不等待人工**。22:00 的调度（含错过的时段补跑）没有人可问，所以它**不**调用任何交互批准、也不
阻塞：引擎在写盘前拒绝，插件的 `runNow` 把这次拒绝记为 `state.last_result` 的**具名待批准状态**：
`{ ok:false, reason_code:'BACKUP_FULL_COPY_APPROVAL_REQUIRED', full_copy_approval_required:true, over_cap_count,
cap_bytes, full_copy_max_mb, scope, full_copy_oversized:[…], warnings:[…] }`（同时 `last_error`、`failures` 与一条
warn 日志照旧，仓库零改动）。面板从 `GET /run` 内嵌状态读到它时，显示
「有 X 个会话的旧版本副本超过 300 MB，需要特批」的待批准卡（`[data-w2m-backup-approval-pending]`）和
「查看并特批」动作；用户点开的是**同一个**确认对话框，确认后才用记录里的 `scope` 重发批准请求。也就是说：
**定时运行不写、不跳过、也不假装成功**——它留下一个可见、可操作的 pending 状态，下一次成功运行会替换它。

**测试**（挂在既有套件上，无新测试文件）：`test/backup-engine.test.mjs`（注入 1 KiB cap + 大 fixture：写盘前拒绝
且仓库未创建/已有仓库逐字节不变、`codes`/`full_copy_oversized`/`over_cap_count` 形状、`allowLargeFullCopy:true`
成功且结果列出批准、旧记录 `full_copy.approved_over_cap === true`＋`cap_bytes`、副本仍能按 `old` 身份逐字节解开、
`records` 忽略 cap、`0` 关闭 cap、非法 cap 在建仓前拒绝、truthy 非布尔不算批准）；`test/backup-rotation.test.mjs`
（`resolveMaxFullCopyBytes` 归一化、记录标注只在批准时出现、未批准时记录形状不变、`records` 记录无标注）；
`test/backup-run.test.mjs`（配置归一化与非法值、定时拒绝进入 `last_result` 且仓库未创建、显式路由批准才写入、CLI
flag 解析/退出码、非 TTY 打印 flag 不提问、注入 TTY 的 y/N 两条路径与 `--json` stdout 干净）；`test/client-bundle.test.mjs`
（待批准卡文案与 cap 占位、对话框 `role=dialog`＋会话/大小列表、确认才发 `allowLargeFullCopy:true`、取消不发请求、
定时 pending 打开同一对话框、中英字典完整）。

**诚实边界**：cap 判断用的是**扫描时**的会话文件大小（不是磁盘上 `current/` 记录里上一版的大小）——对活日志
两者可能相差一次追加；这是"写盘前拒绝"必须接受的近似，偏差方向是可能多问一次批准，而不会少问。批准**只对
一次运行**有效，不会改变配置、不会永久关闭 cap；要永久关闭必须显式配置 `0` 并承担无限副本的代价。本次不 bump
版本号、不跑 preflight、不提交。

## 25. 保护模式（用户最终决定：便捷优先，不是绝对保密，2026-11-17）

### 25.0 用户最终决定：三种保护状态，默认不加密

**用户原话（最终决定）**：

> 我们追求的不是绝对保密：
> 1，用账户ID是为了方便实现自动化（账户能快捷解锁，不是必须）
> 2，密码也是4-6位数字（账户不对输入密码）
> 3，也可以选择不加密（1账户不对，2又没有设置密码，3默认是不加密的）

**一句话：本产品的目标不是绝对保密。** 它防的是**误操作、随手分享、换机/换账户后的打不开**，不是"拿到
仓库文件的人也打不开"。仓库级模式记在 `backup.json` 的加法字段 `encryption: 'none' | 'sealed'`（旧仓库
没有该字段 = `sealed`）；真正的行为以 `keys.json` 的信封为准（`open` = `none`，其余 = `sealed`）。

| 状态 | 凭据 | 它实际防什么 | 它不防什么 |
|---|---|---|---|
| **`none`（默认）** | 无。`keys.json` 里的 `open` 信封**明文保存 DEK** | 只防"忘了密码/账户换了"：仓库永远打得开 | **一切**：任何能访问仓库目录的人都能还原备份（状态卡与解锁卡都显示这句警告） |
| **`sealed` + 账户比对** | 宿主账户唯一识别码，与绑定的 id 比对；一致即免密 | 账户不匹配时的误用；自动化快捷解锁 | 知道该账户 id 且拿到仓库文件的人（可推导 account KEK） |
| **`sealed` + 4-6 位数字 PIN** | scrypt(PIN)，PIN 只在终端/stdin 输入 | 账户不一致、或换机时没有 PIN 的人 | 4-6 位数字空间很小，可被穷举；它不是保密强度 |

**模式的创建 / 升级 / 降级（实现规则）**：

1. **默认**：新建仓库 `none`，写一个 `open` 信封；不需要任何凭据，也不会因为"没有凭据"被拒。
2. **升级为 `sealed`**：以下任一明确要求——提供 PIN/密码（`run --password-stdin` /
   `setRepositoryPassword`）、`machineKey: true`、可解析的账户 id（`backupAccountBinding`）、或显式
   `run --encrypt sealed` / `backupEncryption: sealed`。向 `open` 仓库写入 PIN 或 account 绑定时，**同一次
   写入删除 `open` 记录**并同步 `backup.json` 的 `encryption: sealed`（否则 open 路径会静默绕过凭据）。
3. **降级为 `none`**：`setEncryptionMode({mode:'none'})` / CLI
   `w2m-backup unlock --disable-protection --confirm disable-protection`——先用**现有凭据**打开，再用**同一
   DEK** 写 `open` 记录，先备份 `keys.json.bak-<ts>` 再原子写，最后用**无凭据**解一次验证。不重写任何
   块（块格式不变）。
4. **混存拒绝**：`validateKeysFile` 拒绝同时含 `open` 与任何 account/machine/password 信封的文档；这是
   `BACKUP_ENVELOPE_MALFORMED`，不是"优先选一个"。
5. **弱凭据提示**：4-6 位数字 PIN 被接受（下限 4 字节），但结果带 `weak: true` + 警告
   「4 位数字 PIN 只是便捷门槛，不是保密强度」；**不静默提高 scrypt 成本**来假装它更强。

**什么时候才值得选 `sealed` + 强密码**：当威胁是"仓库文件本身会泄露"（共享盘、云同步、别人能读 D 盘）而不是
"自己忘了/账户不对"。那就必须 `sealed` + **≥8 位、非纯数字的长密码**（`weak` 为 false），并且仍然用 ACL /
加密卷保护仓库目录；本产品不会宣称默认配置具备这种保护。

**用户此前的账户决定（历史记录，仍然有效）**：

> 不用打开账户，只需要读取账户唯一识别码ID，进行比对就行，一致就放行。不一致就切换密码模式。

**问题**：§23 完成后仓库有 `machine` + `password` 两个信封。`machine` 换机/重装即失效，`password` 是唯一跨机器
路径但每次都要求人输入密码。spike（`docs/SPIKE-ACCOUNT-KEK.md`）证明宿主能稳定读到账户**标识** `userId`
（Host-only，`src/chatops/account.mjs` 的 `createAccountIdentity({ctx}).identify()`，`getProfile(client)` 已修），
但**没有**稳定的每账户秘密。用户明确选择了"只拿这个标识做比对"的第三条路。

### 25.1 账户路径是什么：身份绑定，不是机密性（必须先读）

**先读 §25.0：本产品默认不加密，账户路径只是便捷路径。** 在 `sealed` 模式下，仓库多一个 `account` 信封：
DEK 被 `HKDF(w2m-account-binding|<accountId>)` 包裹（`deriveKek`，hkdf-sha256，随机
salt 随信封记录），绑定的账户 id 与绑定时间记在 `keys.json` 根字段：

```json
{
  "format": "w2m-session-backup/keys",
  "version": 1,
  "account_binding": { "account_id": "<host userId>", "bound_at": "2026-11-17T…Z" },
  "envelopes": [
    { "kind": "machine", ... },
    { "kind": "account", "kdf": { "algo": "hkdf-sha256", "keylen": 32, "salt": "base64" }, "sealed": {...} }
  ]
}
```

> ### 诚实安全声明（用户已知并接受，§25.0 是总声明）
>
> **本产品的目标不是绝对保密。账户 id 是标识，不是秘密；4-6 位数字 PIN 是便捷门槛，不是保密强度；默认
> 模式甚至不加密。** 任何知道该账户 id 且拿到仓库文件（`keys.json` + `objects/`）的人，都能推导出同一个
> account KEK 并解开备份；任何能读到仓库目录的人都能解开 `none` 模式。这正是"便捷优先"这一决定的直接
> 代价，用户在原话里明确接受。因此：
>
> * `none`（默认）下**没有任何机密性**：`open` 信封明文保存 DEK。状态/解锁卡必须显示
>   「未加密：任何能访问该目录的人都能还原备份」，不许把默认说成"已加密"。
> * `account` 信封**永不替代** `password` 信封：`password`（PIN）仍是跨机器/跨账户的便捷路径；
> * 面板/CLI/日志**永远不打印完整账户 id**，只打印后 4 位（`id_hint`，形如 `…abcd`）；
> * `keys.json` 里**明文**保存了账户 id（比对需要它）；这不是新增的机密性假设，但它是可识别信息，仓库文件
>   仍应按"可泄露会话清单"对待（§8 的威胁模型不变：真正的秘密是长密码与机器密钥）；
> * 仅当 `backupAccountBinding`（默认 `true`）开启**且仓库是 `sealed`**时才读取/绑定账户 id；`none` 仓库
>   永不绑定（它已经不需要凭据）。关闭后行为与本功能之前完全一致。

### 25.2 匹配 / 不匹配流程

候选凭据顺序由协议固定（`crypto.unwrapDek` 的 `CREDENTIAL_ENVELOPE_KINDS`）：**account → machine → password**。
`open` 信封不是凭据：它存在时直接返回 DEK（`kind: "open"`，`unlocked_via: "none"`），不尝试也不要求任何凭据。

| 情况 | 行为 |
|---|---|
| 仓库是 `none`（`open` 信封） | 不需要凭据，直接解封；`unlocked_via: "none"`；结果带未加密警告 |
| 仓库绑定了账户 id，宿主读到的 id **一致** | account 信封参与解封（无密码、无 machine 也可打开，`unlocked_via: "account"`） |
| 仓库绑定了账户 id，宿主 id **不一致** | 不尝试 account 信封；`attempts` 记录 `{kind:"account", ok:false, code:"BACKUP_ACCOUNT_MISMATCH"}`，继续 machine/password |
| 不一致且没有可用的 machine/password | 对外仍是统一的 `BACKUP_NO_PERMISSION`（与 §11 一致；不新增第二套"拒绝"文案） |
| 仓库未绑定账户 id | 不比较（`account.matched: null`），行为与本功能之前一致 |
| 宿主读不到 id（未登录/无账户服务/绑定关闭） | 不比较（`matched: null`），面板提示改用密码 |

结果字段（`openRepoKey` / `describeUnlock` / `unlockRepo` / 状态路由都带，纯加法）：

```js
encryption: 'none' | 'sealed' | null,       // 仓库真实保护模式（null = 还没有 key 文档/未初始化）
available_paths: ['none'] | ('account'|'machine'|'password')[],  // 实际存在哪些解封路径
warning: '未加密：任何能访问该目录的人都能还原备份' | null,       // 仅 none 模式
account: { bound: true|false, matched: true|false|null, id_hint: '…abcd'|null }
```

`matched` 只在"仓库有绑定且调用方给了 id"时才是布尔值；其余情况 `null`（没有可比较的对象，不猜）。
**完整账户 id 绝不出现在任何结果、CLI 输出、HTTP 响应或日志里**——只有 `id_hint`（后 4 位）。
**DEK 也绝不出现在任何结果对象里**：`none` 模式下它明文存在 `keys.json` 的 `open` 信封中（这是它的定义），
但 describe/status/run/CLI 结果都不回显它；`openRepoKey` 的内部 `dek` Buffer 只给包内调用者（引擎/verify/
restore）使用。

### 25.3 绑定（写入）语义

`addAccountEnvelope(keys, dek, accountId)`：在现有 `keys.json` 上追加 `account` 信封 + `account_binding` 元数据，
**复用现有 envelope 机制**（`wrapDek`/`validateKeysFile`，没有新密码学）。`validateKeysFile` 把 `account_binding`
作为**可选**字段校验（形状/长度/ISO 时间），没有它的旧文件照常可读。

`bindAccount({root, dshHome, accountId, ...})`：用**现有凭据**打开仓库（machine 或已有 password）→ 同一 DEK 再包
一个 account 信封 → 复制 `keys.json` 为 `keys.json.bak-<ts>` → 原子写 → **只用 account 凭据解一次并与 DEK 比对**。
规则：

* 幂等：已绑定同一 id → `added: false`，不重写文件；
* 已绑定**不同** id → 具名拒绝 `BACKUP_ACCOUNT_MISMATCH`，永不静默改绑；
* 账户 id 不可用（空/非字符串/超长）→ `BACKUP_ACCOUNT_ID_INVALID`；
* 存在 `account` 信封但没有 `account_binding` 元数据（无法比对）→ `BACKUP_ACCOUNT_BINDING_UNKNOWN`，不覆盖、不猜；
* 绑定**永远发生在一次成功 run 之后**（或操作员显式调用 `bindAccount`），账户 id 本身**不能**成为建库理由：
  `sealed` 建库仍要求 machine 或 password/PIN（§6 规则 6）；`none` 建库不需要任何凭据。
* **只对 `sealed` 仓库绑定**：`runBackup` 在 `encryption: "none"` 时跳过 account 绑定（否则第一次 run 会把默认
  的不加密仓库静默改成 sealed）。直接调用 `addAccountEnvelope`/`bindAccount` 于 `open` 文档时会移除 `open`
  记录并把它转成 `sealed`（同一 DEK）——这是显式操作，不是运行路径的副作用。

**真实仓库迁移不在本次代码任务内**（由 lead 执行）；`bindAccount` 可独立调用，一行示例（PowerShell，先替换
`<accountId>`；正斜杠路径在 Windows Node 下合法）：

```powershell
node --input-type=module -e "import { bindAccount } from 'file:///E:/GPT/w2m/w2m-345-fresh/src/backup/keystore.mjs'; console.log(JSON.stringify(bindAccount({ root: 'D:/DeepSeekHarness/BackUP', dshHome: process.env.USERPROFILE + '/.dsh', accountId: '<accountId>' }), null, 2))"
```

### 25.4 宿主接线（无账户网络调用要求）

* 面板路由（`src/plugin/backup.mjs`）：`GET/POST /api/w2m/backup/unlock`、restore/archive/verify 每次请求用
  `createAccountIdentity({ctx}).identify()` **best effort** 读一次宿主 id（`ctx.get('deepseekAccount')`；无服务/未登录
  → `null`，绝不抛错、绝不因此拒绝请求），传给 `describeUnlock`/`unlockRepo`/`openRepoKey`。用户已修好的
  `getProfile(client)` 路径只在 `userId` 缺失时才可能触发一次 profile 读取（signed-out 时会被 catch 成 null）。
* 成功 run 后：`runBackup({accountId})` 在快照提交/轮转之后调用 `bindAccount`，失败**只记 warning**，不改 `ok`、
  不导致回滚；结果新增 `account_binding: {bound, added, id_hint, reason_code?}`（只在提供 id 时出现）。
* 配置：`backupAccountBinding: boolean`（默认 `true`；`false` = 不读 id、不绑定、不比较）。`cordis.patch.yml` 的
  dsh-backup 行显式写 `backupAccountBinding: true`。
* CLI（离线、手动）：`w2m-backup unlock --account-id <id>`（描述/比对）与 `unlock --check --account-id <id>`（尝试），
  `w2m-backup run --account-id <id>`（成功后绑定）。CLI 不会自己读宿主 id：id 只能由宿主或操作员提供，避免又造一个
  "可手填的账户凭据"（见 `src/chatops/account.mjs` 开头的原则）。`--account-id` 是高级/手动参数，其余命令不变。

### 25.5 面板文案与解锁对话框（`lib/client.js`）

解锁卡按仓库的 `encryption` 画三种状态（HTTP 仍不接收任何凭据，按钮只发 `{"confirm":"unlock"}`）。卡片保留只读说明
和原有按钮，**动作面**是卡片标题栏的「解锁…」按钮（`data-w2m-backup-unlock-open`）打开的模态对话框：

* 对话框是 `data-w2m-backup-unlock-dialog`，带 `role="dialog"`、`aria-modal="true"`、`aria-labelledby` 指向标题；
  遮罩是 `data-w2m-backup-unlock-overlay`。关闭路径：× 按钮、Esc、点击遮罩。打开时焦点进入第一个可用控件
  （`disabled` 与 `aria-disabled="true"` 跳过，没有可用控件时落在对话框容器上），关闭后焦点回到触发按钮；
  不锁 body 滚动（窄宽度下面板自身滚动）。
* 标题下按 `GET /api/w2m/backup/unlock` 的 describe 渲染当前保护状态，五态写进
  `data-w2m-backup-unlock-dialog-state`：`none`（未加密）/ `account-matched`（账户一致）/ `account-mismatch`
  （账户不一致）/ `unbound`（未绑定原账户）/ `unknown`（读不到 describe，不猜凭据是否可用）。打开对话框本身
  不重新请求；「我已运行，刷新状态」才重新读 `GET /unlock` 与 `/run` 内嵌状态并重画。
* **选项 A「用本机/原账户解锁」**：只 `POST /api/w2m/backup/unlock`，请求体**恰好** `{"confirm":"unlock"}`，
  没有密码或任何其他凭据字段；本机/原账户路径不可用时按钮禁用并说明原因；失败走 `backupReasonText`
  （`panel.backup.reason.*`，未知码原样显示）。
* **选项 B「使用解锁密码（在终端输入）」**：**浏览器里没有密码输入框**，整个对话框 DOM 里没有任何
  `input`/`textarea`。显示可复制的 `<code>` 命令 `w2m-backup unlock --check --password-stdin`（复制走
  `navigator.clipboard.writeText`，失败回退 `document.execCommand('copy')`）与「我已运行，刷新状态」；未加密时
  明确说明不需要密码。
* **密码提示词（`password_hint`，公开元数据）**：用户可以在设置 4–6 位 PIN 时附带一条"备注提示词"
  （`w2m-backup unlock --set-password --hint "周六生日"`），它作为**可选根字段** `password_hint:
  {text, updated_at}` 写进仓库的 `keys.json`（与 `account_binding` 同级，纯加法；`validateKeysFile` 接受它，
  拒绝 `text` 非字符串或超过 120 字符，以及"有提示词却没有 password 信封"的文档）。它**按设计就是公开的**：
  以明文躺在仓库里，任何能读 `keys.json` 的人都能看到，所以只能用来提示"PIN 大概是什么"，绝不能写 PIN 本身
  （写入时拒绝与 PIN 逐字相同的提示词，非字符串/空值/>120 字符同样拒绝）。正因为它不是秘密，CLI 允许它走
  argv（PIN 仍只能从 stdin/环境变量读）；`describeUnlock`、CLI `unlock`、插件 unlock（GET/POST）与 status
  payload 都以加法方式返回 `password_hint: {set, text}`（`set:false` 时 `text:null`）。对话框选项 B 在
  `password_hint.set` 时显示「密码提示：<text>」（`data-w2m-backup-unlock-hint`）；没有 PIN 时显示「未设置密码」
  （`data-w2m-backup-unlock-hint-none`）。
* **轮换说明（用户撤销"不提供轮换"决定后）**：选项 B 另给一句「轮换需要在终端运行：旧凭据解开 → 去掉旧 PIN →
  写新 PIN（旧 PIN 随后失效）」（`data-w2m-backup-unlock-rotation`）和一条可复制的
  `w2m-backup unlock --rotate-password --hint "…"`（`data-w2m-backup-unlock-rotate-command`，复制走与选项 B
  同一套 clipboard 回退）。面板**仍然没有密码输入框**，也**没有**接收密码的 HTTP 端点：轮换只在终端运行，
  这正是"PIN 不进浏览器"规则对轮换的延续。
* **提示词写入语义（set / rotate 分工）**：`setRepositoryPassword({password, hint})` 只在**本次真的新增** password
  信封时写提示词；仓库已有 password 信封时调用是 no-op（`added:false`），已有 PIN 与提示词都保持不变——要改
  既有 PIN/提示词时必须用 `rotatePassword`（CLI `unlock --rotate-password`），它让新提示词**替换**旧提示词；
  不传 `hint`（或 `--clear-hint`）则**丢弃**旧提示词，提示词永远不会追加/嵌套。
* 末尾一行 `w2m-backup unlock --disable-protection --confirm disable-protection`（关闭保护）**只作为可复制文本**
  展示，面板从不执行它。
* **密码永远不进浏览器、不过 HTTP**：对话框里常驻 `panel.backup.unlock.dialog.passwordNeverInBrowser` 的说明；
  新增文案键（zh+en）为 `panel.backup.unlock.dialog.*`：`open`、`title`、`subtitle`、`state.*`、`optionA`、
  `optionAHint`、`localUnavailable`、`optionB`、`optionBHint`、`hintLabel`（「密码提示：{hint}」）、`hintNone`
  （「未设置密码」）、`rotation`（「轮换需要在终端运行：旧凭据解开 → 去掉旧 PIN → 写新 PIN（旧 PIN 随后失效）」）、
  `rotationCommand`（「轮换命令（只复制，不在面板里执行）」）、`noPasswordNeeded`、`commandCaption`、`copy`、
  `copied`、`refresh`、`refreshing`、`close`、`busy`、`failed`、`success`、`passwordNeverInBrowser`、
  `disableProtection`。

| 状态 | 文案（中） | 按钮（卡片与对话框） |
|---|---|---|
| `encryption: none`（默认） | 「未加密：任何能访问该目录的人都能还原备份」+「仓库未加密：不需要账户或 PIN，直接可以解锁」+ 关闭保护说明 | 「解锁」可点（无凭据） |
| `sealed`，`bound: true, matched: true` | 本机账户与原账户一致，可直接解锁。 | 「用原账户解锁」可点 |
| `sealed`，`bound: true, matched: false` | 当前账户不是原账户：请使用解锁 PIN。（面板只提示） | 禁用的账户按钮；文案说明 PIN 只在终端输入（`w2m-backup unlock --check --password-stdin`），并显示「4 位数字 PIN 只是便捷门槛，不是保密强度」 |
| `sealed`，`bound: true, matched: null` | 读取不到本机账户 ID（可能未登录，或账户绑定已关闭）：请使用解锁 PIN。 | 禁用 |
| `sealed`，`bound: false` | 不显示账户行 | — |

状态卡同时显示保护模式徽标（`未加密（默认）` 用警告色 / `已加密`）与未加密警告行；仓库真实模式来自
`GET /api/w2m/backup/status` 的 `encryption` / `repository.encryption` 与 `GET /api/w2m/backup/unlock` 的
`encryption`，面板不自行推断。行内仍显示"原账户绑定：{hint}（只显示后 4 位）"；新错误码
`BACKUP_ACCOUNT_MISMATCH`、`BACKUP_CONFIG_INVALID` 走 `panel.backup.reason.*` 文案映射（未知码仍原样显示）。

### 25.6 测试与验证

* `test/backup-keystore.test.mjs`：新增"默认 `none` + `open` 信封 + 无凭据可开"、"显式 `sealed` 无凭据被拒"、
  "4 位 PIN 建 sealed 仓库并拒绝无凭据打开"、"往 open 仓库加 PIN → 删 open、转 sealed、此后无凭据打不开"、
  "`setEncryptionMode('none')` 把 sealed 转回 open（同 DEK、无凭据可开、幂等）"、"open 与任何凭据信封混存被
  `validateKeysFile` 拒绝"、"DEK 不出现在 describe/status/conversion 结果"；外加既有 machine-only/account 绑定
  （改用 `machineKey: true` 显式要求 sealed），以及 §25.8 的旋转用例（旧 PIN 失效/新 PIN 可开/DEK 不变/
  只剩一个 password 信封/提示词替换与清除/`.bak` 存在/无凭据或无 password 信封被具名拒绝/校验失败恢复）。
* `test/backup-crypto.test.mjs`：open 记录形状/明文语义/`unwrapDek` attempts、混存与畸形记录拒绝。
* `test/backup-access.test.mjs`：`describeUnlock` 报告 `encryption`/`available_paths`/未加密警告；无凭据
  `unlockRepo` 得 `via: "none"` 且不带 DEK；sealed 仓库报告 `sealed`。
* `test/backup-engine.test.mjs`：无凭据首次建库 `encryption: "none"`、第二次仍去重；`password: "1234"` 建
  sealed 并拒绝无凭据 run；非法 `encryption` 与 `none + password` 在 `ensureLayout` 前拒绝；显式 sealed 无凭据
  的 `BACKUP_NO_PERMISSION`。
* `test/backup-run.test.mjs`：配置 `backupEncryption` 默认 `none`/非法值拒绝；插件默认 run 成功且
  `unlocked_via: "none"`、显式 sealed 才拒绝；CLI `run --encrypt none|sealed`/`--no-encryption`、退出码、
  `unlock --set-password` 的 4 位 PIN 与警告行、`--disable-protection --confirm` 前后状态、§25.8 的
  `unlock --rotate-password`（flag 解析、两行 stdin `old\nnew`、`--old-password-stdin`/`W2M_BACKUP_OLD_PASSWORD`、
  `--hint` 替换与 `--clear-hint`、人类输出与 `--json`、退出码 0/1/2）。
* `test/backup-verify.test.mjs` / `test/backup-restore.test.mjs`：`none` 仓库无需密码即可 verify / plan+apply
  restore。
* `test/client-bundle.test.mjs`：解锁卡三态（未加密/账户一致/账户不一致 + PIN 提示）、状态卡模式徽标、未加密
  警告、新 i18n 键与 `BACKUP_CONFIG_INVALID` 映射。
* `test/client-bundle.test.mjs`（解锁对话框，v3.5.x）：卡片触发器打开模态（`role`/`aria-modal`/`aria-labelledby`/
  遮罩）、Esc 与遮罩关闭、焦点进入对话框与回到触发器、选项 A 请求体恰好 `{"confirm":"unlock"}` 且全程无密码、
  选项 B 命令复制（clipboard + `execCommand` 回退）与「刷新状态」重读 describe、失败原因文案、五态映射与中英字典键；
  §25.8 起还断言轮换说明与可复制的 `--rotate-password --hint "…"` 命令出现、中英字典有 `rotation`/
  `rotationCommand`，且对话框仍然没有任何 `input`/`textarea`。
* `test/loader-entry.test.mjs` + `test/helpers/dsh-page-boot.mjs`（真实浏览器）：打开备份面板 → 点「解锁…」→
  `[data-w2m-backup-unlock-dialog]` 带 `role="dialog"` 且焦点在对话框内 → Esc 后对话框与遮罩消失。
* `docs/SPIKE-ACCOUNT-KEK.md` §9 记录"用户最终决定：便捷优先"。

### 25.7 诚实边界（本次不承诺的）

* **不是机密性**：见 §25.0 的声明。默认 `none` 下仓库目录本身即可解密；`sealed` 下知道账户 id 的人可推导
  account KEK、4-6 位数字 PIN 可被穷举。这些都不是缺陷，是"便捷优先"决定的直接代价。
* **默认不加密是产品行为，不是错误**：状态卡/解锁卡/CLI 明确显示「未加密：任何能访问该目录的人都能还原备份」，
  不把 `none` 说成"已加密"。
* 账户 id 由宿主提供；**CLI 不会自己读**。宿主未登录/断网/无账户服务时 account 路径不可用，PIN 路径照旧。
* 面板的账户路径按钮与 machine 按钮都只发同一个确认令牌；面板从不接收密码，PIN 路径仍只在离线 CLI。
* `account` 信封**不能**在"换账户 + 无 machine + 无 password"时救回仓库：那是 PIN 路径的职责。
* **轮换需要现有可用凭据**（2026-11-17 用户撤销"不提供轮换"后的边界，详见 §25.8）：`rotatePassword` 先用
  machine/account/旧 PIN 之一打开仓库再改写 password 信封，所以"忘了 PIN 且本机 DPAPI 不可用、账户也不匹配"时
  仍然**打不开仓库**——轮换不是恢复手段。提示词（`password_hint`）也只是提示，不是恢复手段，且它按设计是
  公开明文。
* 已经存在的旧快照目录里的 `keys.json` 副本没有新绑定/新模式变化（只写根 `keys.json`，下一次快照起副本才更新）；
  从旧快照直接还原仍走它自己那份 `keys.json`。
* 关闭保护**不会**重写 `objects/`：块仍是同一把 DEK 封的密文；"不加密"准确地说只是"钥匙明文存在旁边"。
* 不 bump 版本号、不跑 preflight、不提交；真实仓库迁移由 lead 用 §25.3 的命令或 `unlock` 命令执行。

### 25.8 PIN 轮换（2026-11-17 决定撤销：轮换存在）

**背景**：此前的决定是"不提供 PIN 轮换"。用户在同一天撤销该决定，原话是"需要'旧凭据解开→移除旧 password
信封→写新信封'的轮换命令；目前若忘了密码且本机 DPAPI 不可用，仓库无法打开"。于是新增 `rotatePassword` 与
`w2m-backup unlock --rotate-password`。这是**加法**改动：`setRepositoryPassword` 的"已有 password 信封 = no-op"
行为不变（"加 PIN"和"换 PIN"是两个不同的承诺），轮换是独立命令；包入口 `lib/backup.js` 也再导出
`rotatePassword`。

**API**（`src/backup/keystore.mjs`）：

```js
rotatePassword({ root, dshHome, newPassword, hint?, oldPassword?, accountId?, platform?, runner?, machineKey?, now? })
```

**前置条件（缺一即具名拒绝，零写入）**：

| 条件 | 行为 |
|---|---|
| 仓库没有 key 文档 | `BACKUP_DIR_NOT_A_REPO`（轮换绝不创建仓库） |
| 没有可用凭据（machine/account/`oldPassword` 都开不了） | `BACKUP_NO_PERMISSION`，detail 说明 "rotate needs a working credential; run it on the machine that can open the repository, or pass the old PIN" |
| 仓库没有 password 信封（未加密或只有 machine/account） | `BACKUP_NO_PASSWORD_ENVELOPE`——轮换不是"加 PIN"，加 PIN 用 `--set-password` |
| 新 PIN < 4 字节 / hint 非法（非字符串、空、>120 字符、等于新 PIN） | `BACKUP_PASSWORD_EMPTY`/`BACKUP_NO_PERMISSION`/`BACKUP_PASSWORD_HINT_INVALID`，均在写仓库前拒绝 |
| 新旧 PIN 逐字相同 | `BACKUP_ROTATION_VERIFY_FAILED`（相同 PIN 会让"旧 PIN 随后失效"不成立，直接拒绝而不写） |

**写与验证（顺序即安全语义）**：

1. 用现有凭据打开仓库（`openRepoKey` 的 account → machine → password 顺序；`oldPassword` 走 password 槽），
   拿到**同一个 DEK**；
2. 删除**所有** `password` 信封，用同一 DEK 写**恰好一个**新 password 信封（scrypt，沿用现有 KDF floor；
   4 位 PIN 仍被接受并标记 `weak: true`）；account/machine 信封原样保留；
3. `password_hint` 换成新 hint（`{text, updated_at}`），不传或传 null 时**删除**；提示词只替换，不追加、不嵌套；
4. 写前把 `keys.json` 复制为 `keys.json.bak-<ts>`，再用 `writeFileAtomic` 替换；
5. **双向验证**（对**从磁盘重读**的文档，不是内存副本）：(a) 只用新 PIN 解出的 DEK 必须与打开时的 DEK 相同；
   (b) 只用旧 PIN 必须解不开，并且**任何**轮换前的 password 信封记录（salt+tag）都不得残留。任一失败 → 用
   `.bak` 覆盖 `keys.json` 并返回 `BACKUP_ROTATION_VERIFY_FAILED`（`restored: true`）：**永不**留下"旧 PIN 还能开"
   的文档。结构检查让调用方没提供旧 PIN 时也能如实返回 `old_password_still_opens: false`（旧 PIN 已无信封可解）。

**结果**：`{ok, rotated: true, mode_after: 'sealed', envelopes, backup_file, hint: {set, text|null}, weak,
old_password_still_opens: false, warning?, ...}`；失败共用同一 shape（`rotated: false`、`restored`、
`reason_code`、`detail`）。DEK 与 PIN 都不出现在结果里。

**CLI**：`w2m-backup unlock --rotate-password [--hint "…" | --clear-hint]`。新 PIN 与 `--set-password` 同渠道
（`--password-stdin` 或 `W2M_BACKUP_PASSWORD`；绝无 argv）；旧 PIN 只在本机/账户路径开不了时才需要，来自
`W2M_BACKUP_OLD_PASSWORD` 或 `--old-password-stdin`；两者共用 stdin 时用两行格式 `old\nnew`（`--password-stdin`，
行序为旧、新）。`--hint` **替换**旧提示词，省略 `--hint`（或 `--clear-hint`）则丢弃；`--clear-hint` 不能与
`--hint` 同用，`--password-stdin`/`--old-password-stdin` 不能同用，`--rotate-password` 不能与 `--set-password`/
`--disable-protection` 同用（均退出码 2）。人类输出：`rotated : yes`、`hint : …`、`keys backup : …`、
`old PIN no longer opens : confirmed`；退出码 0/1/2 与 `--json` 形状不变。

**面板**：解锁对话框选项 B 显示轮换说明与可复制的 `w2m-backup unlock --rotate-password --hint "…"`，
**没有**密码输入框，也**没有**新的接收密码 HTTP 端点；轮换仍只在终端运行。

**测试**：`test/backup-keystore.test.mjs`（machine+password 与 password-only 两种仓库、旧 PIN 失效/新 PIN 可开/
DEK 不变/恰好一个 password 信封/提示词替换与清除/`.bak` 存在、无凭据与无 password 信封两种具名拒绝且零写入、
`unwrap` 测试缝让旧 PIN 在写后"仍可解"以驱动恢复路径）、`test/backup-access.test.mjs`（describe/attempt 在轮换后
报告新提示词、旧 PIN 不再解锁）、`test/backup-run.test.mjs`（CLI flag/两行 stdin/旧 PIN 的两个渠道/人类输出/
`--json`/退出码）、`test/client-bundle.test.mjs`（命令与说明、中英字典键、仍无密码输入）。

## 26. 镜像写入时的链接防护（realpath 加固补记）

§21.2 已经在**校验时**把镜像根解析成真实路径（`fs.realpathSync` 取最深已存在前缀，解开 symlink/junction）并与真实仓库根、
真实 `$DSH_HOME` 做包含判定。仍有一类窗口：镜像根通过校验之后、真正写文件之前，攻击者（或一次误操作）在镜像树**内部**
造一个 junction/symlink，或把某个目录换成链接，写入就会落到仓库、home 或任意目录。

修复（`src/backup/mirror.mjs`）：

* `syncToMirror` 在写入前**重新解析**镜像根的真实路径（根在校验后变成链接 → 具名拒绝），并把该真实路径作为守卫根；
* 新增 `guardWritablePath(realRoot, target)`：目标必须在守卫根之下；从目标父目录向上走到守卫根，**每个已存在的祖先**
  都必须解析到它自己（`realPathTolerant` 的真实路径 == 词法路径），否则拒绝 `BACKUP_MIRROR_SYMLINK`；
  无法解析的分量拒绝 `BACKUP_MIRROR_INVALID`；
* 每个写入点都过守卫：对象块、快照目录（先对将要创建的路径守卫再 mkdir）、快照两个文件、根 `backup.json`/`keys.json`、
  `index.jsonl`（append 前）。
* 失败语义不变：镜像阶段的拒绝只让本次镜像失败（`ok:true` + `mirror.ok:false`），**不回滚**已提交的备份。

**边界**：守卫与 `writeFileAtomic` 之间仍是毫秒级 TOCTOU（原子写自己先写 tmp 再 rename，链接若在 tmp 目录内被换仍可能
影响那一次写）；彻底关闭需要句柄级写入（`O_NOFOLLOW` 链）或目录 fd 打开，当前 Node/Windows 组合不做承诺。守卫覆盖的是
"镜像树内部出现链接"这一实际可达的破坏面，测试用真实 junction 验证（环境禁止时按名 skip）。

### 20.6 为什么不进面板（有意的边界）

`renumber` 是**受控修复工具**，不是日常操作，因此面板（备份&还原）里没有它的入口——这是决定，不是遗漏：

* **它改历史**：删除/插入事件会改变会话记录本身，必须由人判断"删哪一条、插什么"，不能做成一键按钮；
* **入口固定为 `w2m-fix renumber`**（`bin/w2m-fix.mjs`），与 `dsh-fix` 的修复语义放在一起；`--dry-run` 先看映射与门禁结论，
  apply 才写，并始终先留 `<file>.bak-<时间戳>`（保留数量见 `--keep-backups`）；
* **门禁比面板操作更重**：静态 doctor + 未来追加模拟 + 安装的 Harness 终审（G5），任一失败零写入；
* 面板只暴露非破坏性/可回滚的操作（备份、还原计划、归档、校验、注册表修复、解锁），破坏性历史编辑留在 CLI。
* **优先还原**：如果备份能取回原始日志，先用 `w2m-backup restore` 还原，而不是 `renumber`——renumber 是有意改历史，
  `.bak` 只是最后一次写入前的副本，不替代备份；CLI 的帮助与每次 plan 输出都会打印这条提醒。

发现路径：`w2m-fix --help` 的第一段就是"the one legal way to delete/insert events in a v4 session log (gate G4)"；
`docs/BACKUP-DESIGN.md` §20 与本轮 `--keep-backups` 说明给出完整参数。若未来要在面板暴露它，必须先有"逐事件预览 +
双人确认 + 只读审计记录"的设计，否则不做。
