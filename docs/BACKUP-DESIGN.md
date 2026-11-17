# 备份&还原设计（`w2m-session-backup/v1`）

> 状态：**v3.4.6 协议冻结**。本文定义仓库布局、清单格式、块切分、加密信封、错误码与兼容承诺。
> 后续版本只能**新增字段**，不能改既有字段语义（§9）。
> 相关文档：[会话找回复盘](RETRO-SESSION-RECOVERY-20261117.md)、[账户材料 spike](SPIKE-ACCOUNT-KEK.md)、[开发计划](DEV-PLAN-3.4.6-3.5.0.md)。

## 1. 目标与非目标

**目标**

1. 把 `$DSH_HOME` 里**不可再生的东西**（会话日志、附件对象、工作区索引）完整备份到 `D:\DeepSeekHarness\BackUP`，默认每天 22:00（时区可配）。
2. 还原后 **DSH 能直接打开**——不是"文件回去了"，而是"侧边栏看得见、点得开、能继续对话"。
3. 全程加密；解锁走**账户 / 本机 / 密码**三信封，任一条可用即可；无权限时给具名提示而不是 EPERM。
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
<root>/backup.json                             描述符：format/version/block_size/cipher（明文）
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
| `account` | 账户材料派生的 32 字节（spike 见 `docs/SPIKE-ACCOUNT-KEK.md`） | 同账户免密 | **有条件，且不作为机密性保证** |
| `machine` | 本机随机 key，由 OS 钥匙串/DPAPI 保护 | 同机免密 | Windows 可得（DPAPI）；macOS 未实现 |
| `password` | 用户密码，scrypt | 换机/清材料后唯一路径 | **必须永远可用** |

**spike 之后的结论（2026-11-17，见 `docs/SPIKE-ACCOUNT-KEK.md` §0）**

1. DSH 0.2.2-rc.3 只向 Host 提供账户**标识** `userId`（仅内存缓存、需已登录+联网+一次成功 `getProfile`），磁盘上没有稳定的 account id/email/公钥指纹；`.anonymous-user-id` 是安装级随机 UUID，grant token 会随登录/过期/issuer 变化被替换或删除。**`userId` 是标识不是秘密**——只用它派生 KEK 等于"任何人都能解密"的加密表演，所以 v3.4.7 **默认不写 `account` 信封**；只有当宿主能提供真正的每账户秘密（或产品明确接受这种非机密性"便捷解封"）才启用。
2. `machine` 信封可行：本机 DPAPI（CurrentUser）32B→262B 密文 round-trip 实测通过，跨进程可解；仓库里已有实现可复用（`src/decision-center/lib/ai-secret-store.mjs`）。macOS 分支目前明确 `keychain-not-implemented`，所以非 Windows 机器在 v3.4.7 只有密码路径。
3. scrypt 实测：N=2^14≈56 ms、2^15≈111 ms、2^16≈227 ms、**2^17≈461 ms**（参考机）；默认取 **N=2^17 / r=8 / p=1**（约 1 s 预算的 2.2× 余量，单次 128 MiB 内存）。
4. 因此**默认信封组合 = `machine` + `password`**；`account` 是可选第三信封，且写入前必须修掉一处调用：w2m 现有 `await service.getProfile()`（零参，`src/chatops/account.mjs`）与 DSH 的 `getProfile(client)` 签名不符，沿用零参时 `userId` 大概率恒为 null，会"看起来支持、实际不可用"。

规则：

1. **AAD 绑定**：每份信封的 AAD = `w2m-session-backup|<version>|account/machine/password|aes-256-gcm|<salt>`。所以信封不能被挪到别的 kind 槽、KDF 参数不能被改小——都会变成认证失败。
2. **参数随文件记录**：每条信封自带 `kdf`，日后提高 scrypt 成本不会让旧仓库打不开；读取接受文件记录的值，但有上界 `MAX_SCRYPT_N = 2^20`（防恶意文件逼出 GB 级内存），写入拒绝低于 `N = 16384`（`BACKUP_KDF_WEAK`）。
3. **GCM 分不清"密码错"和"文件被改"**：两者都是 `BACKUP_DECRYPT_AUTH_FAILED` / `BACKUP_KEY_UNWRAP_FAILED`，文案必须同时说明两种可能。**不允许**在代码或 UI 里断言"密码错误"。
4. **正文块**：`objects/<aa>/<sha256>` 是 `W2MBLOB1 | nonce | ciphertext | tag`，AAD = `w2m-session-backup/object|<plaintext sha256>|<plaintext length>`；打开后再校验 `sha256(明文) == 文件名`。块被搬到别的哈希位上会认证失败。
5. **DLQ/自检**：`w2m-backup selftest` 在**用户自己的机器上**跑一遍真实 wrap/unwrap + 三种必须失败的篡改，建库前必须先绿。
6. **仓库级 DEK（v3.4.7 定稿）**：一把随机 DEK 服务整个仓库（见 §3 细化 1）；信封仍是 `account`/`machine`/`password` 三种，默认写 `machine`（可用时）+ `password`（提供时）。**至少一个信封可用才允许建库**，否则 `BACKUP_NO_PERMISSION`——写一个谁也打不开的仓库比不写更糟。定时任务没有密码可输，只能走 `machine` 信封；没有 OS keystore 的平台会具名拒绝（`BACKUP_NO_PERMISSION`），人工路径是 `w2m-backup run --password-stdin`（密码只经 stdin/env，绝不进 argv）。

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
| 仓库目录被拷走/云盘同步泄露 | 块级 AES-256-GCM；DEK 只在信封里 | 清单明文暴露会话 id/工作区名/大小/时间（**接受并声明**） |
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
| `src/backup/crypto.mjs` | scrypt/hkdf 派生、AES-256-GCM 封包、三信封、块对象、`selftest` | **绝不**（纯内存） |
| `src/backup/repo.mjs` | 快照 id、快照两文件、`index.jsonl` 行格式与读写、`commitSnapshot`、只读 `openRepo` | 仅 `commitSnapshot`/`appendIndex` 会写（测试与 v3.4.7 引擎；路由与 CLI 不调用） |
| `src/backup/engine.mjs` | `runBackup`：锁 → 建库 → 开 KEK → 扫描 → 按 scope 选会话 → 写缺失块（去重）→ 提交快照 → 轮转 | 会写（这是引擎） |
| `src/backup/rotation.mjs` | `current/` 指针、`old/` 版本记录、每会话保留窗口 | 会写 |
| `src/backup/gc.mjs` | 引用收集（快照 + old + current）、孤儿块删除、old 保留窗口；任一引用不可读即**拒绝删除** | 会写（`dryRun` 时只读） |
| `src/backup/locks.mjs` | `tmp/backup.lock`：`wx` 原子创建、死 pid/超龄/不可读三种回收、只释放自己的锁 | 只写锁文件 |
| `src/backup/atomic.mjs` | `writeFileAtomic`（tmp → fsync → rename）、`writeJsonAtomic`、`readJsonSafe` | 会写 |
| `src/backup/keystore.mjs` | 打开/创建仓库 DEK：machine + password 信封，二者皆无则 `BACKUP_NO_PERMISSION` | 写 `keys.json` |
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
| `BACKUP_PASSWORD_EMPTY` | 请输入解锁密码 |
| **`BACKUP_NO_PERMISSION`** | **没有权限：请用原账户登录，或输入解锁密码**（v3.4.8 解锁失败的统一对外码） |
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
| `BACKUP_REPO_SNAPSHOT_*` / `BACKUP_REPO_INDEX_LINE_INVALID` | 快照或索引行不可用 |
| `BACKUP_SCAN_HEADER_UNREADABLE` / `BACKUP_SCAN_NOT_ZSTD` | 会话日志头部不可读/不是 zstd |

## 12. 未决问题

1. **账户信封**：spike 已给出结论（§6）：`userId` 不是秘密，默认不写；实现前必须做两件事——修 `getProfile(client)` 调用、在宿主进程内实测 `userId` 可得性（`docs/SPIKE-ACCOUNT-KEK.md` §6 唯一未闭环项）。
2. **清单是否也该加密**：v1 选择明文（§4 理由）。若用户要求，v2 可加 `manifest.enc` + 明文 `snapshot.json`（只留计数）。
3. **`current/` 已定稿**：存指针（见 §3 细化 3），轮转与 gc 都以它为根之一。
4. **保留策略默认值已定稿**：每会话 10 份旧版本（Q4=A），`keepOldPerSession` 可配；轮转后立即裁剪，窗口不会无声增长。
5. **macOS 的 machine 信封**：需要 keychain 实现；在补齐之前，macOS 只有密码路径（v3.4.8 解锁流程要按平台给出不同文案）。

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

`dsh-backup` 子插件行随包发布但 `disabled: true`：**启用它才意味着"定时器可以写盘"**。只读路由仍在主插件上，因此面板的"状态卡片"不需要先启用子插件。
