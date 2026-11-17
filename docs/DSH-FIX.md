# DSH-FIX：会话附件自修复子插件

> 适用版本：**v3.4.5+**　·　子插件：`@twinsearth/w2m-dsh-plugin/dsh-fix`　·　默认启用
> 移植自 [`xuzhunzhi/dsh-fix-attachments`](https://github.com/xuzhunzhi/dsh-fix-attachments)（MIT）

## 一句话

某条会话的图片附件对象被删除后，这条会话**每一轮**都报
`执行出错 · DeepSeek Messages transport failed`，重试再多次也没用。`dsh-fix` 在失败当场把
「读不出来的图片」降级成占位文本并让这一轮继续跑，不用新开会话，也不用等重启。

## 你是不是遇到了这个问题

对照以下几条，全中就是它：

- 某条会话**每一轮**都失败：`DeepSeek Messages transport failed`（错误码 `TRANSPORT`）；
- 每次尝试 **20–60 毫秒**就失败，**一个 HTTP 请求都没发出去** ← 决定性判据；
- 自动退避重试全部失败，这一轮就废了；
- 同机、同模型，**别的会话完全正常**；
- 换网络 / 代理 / key / provider 都没用；
- 那条会话的历史里**读过图、传过图**。

真因：图片附件是内容寻址存储的
（`<DSH_HOME>/attachments/v1/objects/<sha256 前 2 位>/<sha256>`）。对象文件一旦被删，
请求准备阶段每次都会重读它 → `ATTACHMENT_NOT_FOUND` → 被 DeepSeek Messages 适配器的兜底
`catch` 包成 `TRANSPORT`。**和网络无关**，重试只是白等。

## 插件怎么修

挂的是 agent loop 的 `agent/request-error` waterfall——和官方的上下文溢出恢复、图片预算
offload 是同一个扩展点：

1. 请求失败时先看失败码是不是 `TRANSPORT` / `ATTACHMENT_NOT_FOUND`；
2. 是的话扫**当前请求视图**（`session.surface.nodes`，被 compaction 阴影掉的老消息自动排除），
   逐个图片引用检查对象文件在不在；**已标记 `offloaded` 的跳过**；
3. 找到了就 `session.append('image/offload', { targets })`——官方 `compaction-image-offload`
   插件在图片超预算时用的就是这个机制，追加后适配器把这些图换成占位文本；
   随后 `await ctx.sessions.flush(session)` 过一道**持久化屏障**；
4. 返回 `{ kind: 'retry' }` 让这一轮**立刻重试**；这种「持久修复后的重试」不消耗 provider
   重试预算，也不会记一条 `llm/retry`；
5. 没有可修的图 → `next()`，把真网络错误原样交给下游。

两个刻意的设计：

- **不猜 cause 链**。判定依据是「视图上是否真的有读不出来的图」，而不是错误文案，
  所以真网络故障不会被它掩盖。
- **有收敛上界**。同一 session 同一轮最多修 `maxRepairsPerTurn` 次（默认 3）；
  修完那些图就变成 `offloaded`，下一次检查自然为空。

## 怎么确认它在跑

插件**挂载时**会写一个留痕文件，每次修复更新计数：

```bash
cat ~/.dsh/xclient/dsh-fix-state.json
```

```json
{
  "version": 1,
  "mountedAt": "2026-11-16T05:40:00.000Z",
  "objectsRoot": "C:\\Users\\you\\.dsh\\attachments\\v1\\objects",
  "maxRepairsPerTurn": 3,
  "repairs": 0,
  "lastRepair": null
}
```

- `mountedAt` 有值 = 插件确实被加载了；没有这个文件 = 没挂上（检查 profile 的 bundle 列表与
  `dsh-fix` 行是否被禁用）。
- `repairs` / `lastRepair` = 实际修过几次、最后一次修了哪些 `seq`。

## 配置

在 profile 的 `cordis.patch.yml` 里按 entry id 覆盖（`config` 是整体替换、不深合并）：

```yaml
- id: dsh-fix
  config:
    objectsRoot: 'D:\other-dsh-home\attachments\v1\objects'   # 可选：附件库换过位置时
    maxRepairsPerTurn: 3                                      # 可选：每轮最多修几次
    statePath: 'D:\other-dsh-home\xclient\dsh-fix-state.json' # 可选：留痕文件位置
```

## 离线 CLI

插件解决「DSH 能在进程内失败并重试」的情况；CLI 用来批量体检、或 DSH 起不来的场合。
**写操作前必须先退出 DeepSeek Harness**（它内存里存着自己的 next seq，并发追加会撞号）。

```bash
# 只报告：哪些会话坏了、要补几处
node cli/bin/dsh-fix-attachments.mjs scan

# 真的写（默认是空跑）：逐帧解压 session.v4.jsonl.zstd、自己算 compaction 阴影集、
# 追加一条带 checksum 的 image/offload 帧；写前备份、写后全量复核
node cli/bin/dsh-fix-attachments.mjs fix --apply

# 看某条会话的备份
node cli/bin/dsh-fix-attachments.mjs backups --session <目录名片段>

# 用最新备份回滚（回滚前的状态会另存为 pre-restore-*）
node cli/bin/dsh-fix-attachments.mjs restore --session <目录名片段> --apply
```

也可以走 npm bin 名：

```bash
w2m-fix scan
w2m-fix fix --apply
```

CLI 的拒绝条件（都是拒绝，不是猜测）：DeepSeek Harness 正在运行（`--force` 可越过）、
日志末尾有撕裂帧、会话格式版本不认识。CLI 需要 **Node ≥ 22.15**（同步 zstd API）；
插件本体没有这个要求。

## 边界

- **图片不会回来**。对象是内容寻址的，字节没了就是没了；插件/CLI 只是让会话能继续说下去。
- **不修根因**。对象仍可能继续消失，所以建议一直装着；离线 CLI 可定期 `scan` 体检。
- **不改 DSH 安装**：不碰 `app.asar`、不碰模型请求的其它环节，只追加一条持久事件。
- **只处理图片块**。其它类型附件不参与请求准备，不需要修。
- **不冒充官方**：社区移植，与 DeepSeek AI 无隶属关系。
- **与独立包 `dsh-fix-attachments` 不叠加**：v3.4.5 已包含该能力；同时安装只会多一个同功能
  监听器，建议在 profile 里移除独立包。
- **依赖核心 `image-offload` 行**（`dsh-base` 默认启用）：`image/offload` 的消息投影由官方
  `compaction-image-offload` 插件注册，本插件**不重复注册**（重复注册会让官方行挂载失败）。
  若在 profile 里显式禁用该行，本插件会把原始错误原样交回下游，而不是崩溃。

## 上游缺陷

这是止血。真正的修法在 DSH 一侧：让请求准备阶段把「存储字节取不出来」降级成占位文本，
并把 `ATTACHMENT_NOT_FOUND` 原样透出而不是包成 `TRANSPORT`。

## 测试

`test/dsh-fix.test.mjs` 覆盖：

- 插件：找到缺图 → 追加 offload → flush → 要求重试；无缺图时交给下游；非相关错误码跳过；
  取消信号；每轮上限；core 已注册同类型投影时可正常挂载；
- CLI：v4 格式探测、compaction 阴影排除、应用与幂等、备份/回滚、撕裂帧拒绝、格式版本拒绝、
  scan 只读、dry-run 与 `--help`；
- 装配：`lib/dsh-fix.js` 导出、`package.json` 的 exports/bin/files、`cordis.patch.yml` 的
  `dsh-fix` 行。

## License

MIT。上游 `dsh-fix-attachments` 版权所有 (c) 2026 xuzhunzhi，按 MIT 许可再分发；
完整许可见上游仓库的 `LICENSE`。
