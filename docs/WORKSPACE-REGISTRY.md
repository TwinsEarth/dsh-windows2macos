# Workspace registry：为什么不能手改 `workspace.json`，以及怎么体检/自愈

> 适用：任何会碰 `$DSH_HOME/storages/workspace.json` 的脚本（备份演练、restore、批量 import、清理脚本），
> 以及 DSH 客户端升级后的回归检查。

## 1. 事故（2026-11-21）

一次真机演练的清理脚本直接 `JSON.parse` → 删 `tables.workspaces` 的行 → `JSON.stringify` 写回，
**没有同步删 `global.workspaceIds` 里的 id**。结果：

- `workspaceIds` 里 2 个 id 没有任何表行（悬空 id）；
- DSH 客户端启动时 `workspaceController` 挂载失败；
- 所有工作区操作报
  `workspace create failed: gateway/service-unavailable: typert gateway: workspace/create:
   active Service "workspaceController" is unavailable`。

**一个悬空 id 就能让整个工作区功能停摆**，这既是操作错误，也是客户端 `list()` 的健壮性缺陷（见 §6）。

## 2. 不变量

`storages/workspace.json`（unit `workspace` v2）必须满足：

| # | 不变量 | 违反后果 |
|---|---|---|
| 1 | `global.workspaceIds` 的每个 id 都在 `tables.workspaces` 有行 | **致命**：controller 挂载失败，所有工作区操作不可用 |
| 2 | `tables.workspaces` 的每一行都被 `workspaceIds` 列出 | 该工作区在界面上不可见（不致命） |
| 3 | `global.defaultWorkspaceId` 是"已列出且存在"的行 | 默认工作区无效，新建/打开可能异常 |

## 3. 规则：所有写入必须走注册表协议

- **唯一写入者**：`src/backup/registry.mjs`（plan → 原子写 → 读回校验 → 回报 client-overwrite 警告）。
- 备份/恢复路径只允许**复制**该文件（`src/backup/register.mjs`、`src/backup/restore.mjs` 的 pre-restore 副本）。
- 体检/自愈：`src/backup/workspace-registry-guard.mjs`。
- 其它脚本（drill、import、清理）**不得**自己拼 JSON 写回；需要增删工作区时调用 workspace 的 create/delete
  接口，让注册表自己维护序号与表行的一致性。
- 该规则由 `test/registry-write-policy.test.mjs` 机械检查（扫描 `src/`、`scripts/`、`bin/`、`tools/`，
  任何"写调用 + workspace.json 同行"且不在白名单内即失败）。

## 4. 体检 / 自愈

**首选（跨平台，随包发布）**：

```bash
# 只检查（不写）：0 自洽 / 1 不一致 / 2 不可读
node bin/w2m-fix.mjs workspace-registry --check

# 自愈：先写 workspace.json.bak-guard-<stamp>，再修悬空 id / 未列行 / 失效 session 引用 / 无效默认
node bin/w2m-fix.mjs workspace-registry --repair
```

`--repair` 是**唯一受支持**的修复入口：原子写 + fsync + 写后重新体检，幂等（已自洽时不重写），
只删悬空 id、保留可见行、只剪掉指向不存在日志的 session 引用，绝不删工作区行或会话日志。

**Windows 便捷包装**（`-Fix` 会先停 DSH 进程，因为客户端内存持有该文档）：

```powershell
powershell -NoProfile -File tools\dsh-workspace-guard.ps1        # 只检查
powershell -NoProfile -File tools\dsh-workspace-guard.ps1 -Fix    # 先备份、停进程、自愈、校验
powershell -NoProfile -File tools\dsh-workspace-guard.ps1 -Fix -NoStop   # 客户端已关闭时
```

旧的 `scripts/workspace-registry-guard.mjs` 仍保留（同样的 guard 模块、`--fix` 参数），供不方便调用
`w2m-fix` 的环境使用；两条命令共享同一实现。

自愈语义：**只删悬空 id；未列出的表行会被保留并补进 `workspaceIds`；指向不存在日志的 sessionId 会被剪掉；
无效默认改为第一个存活的 id**；写前备份、写后重新体检；已自洽时不重写（幂等）。修复后必须**重启 DSH 客户端**
让内存态重新加载。

## 5. 使用时机（写进演练/导入清单）

1. 演练或批量导入**之前**：跑一次 check，确认"索引自洽"；
2. 操作**之后**：再跑一次 check；不一致就 `-Fix`，重启客户端后再验一次；
3. **DSH 客户端升级后**：跑一次 check（新版本可能改变注册表 schema）；
4. 任何脚本改动涉及注册表后：`npm run test:workspace-guard`。

## 6. 建议上游修复（可提 issue）

> **Title**: `workspaceController` fails to mount (all workspace ops unavailable) when one
> `workspaceIds` entry has no row
>
> **Body**: If `storages/workspace.json` has a dangling id in `global.workspaceIds`, the `workspace`
> domain's `list()` throws during mount, so the whole `workspaceController` service is marked unavailable
> and `workspace/create` returns `gateway/service-unavailable`. Repairing the file by hand fixes it, but a
> single bad id should not disable every workspace operation. Expected: `list()` skips/needs-repair-warns
> the dangling entry (e.g. a `WORKSPACE_ID_DANGLING` warning in the diagnostics/log) and keeps serving the
> rows that do exist; the controller only refuses the affected id. A startup self-heal (drop dangling ids,
> reassign default) would also be reasonable. Repro: remove one row from `tables.workspaces` while keeping
> its id in `global.workspaceIds`, restart, then create a workspace.

## 7. 相关文件

| 文件 | 作用 |
|---|---|
| `src/backup/registry.mjs` | 注册表唯一写入者（读回协议） |
| `src/backup/workspace-registry-guard.mjs` | 体检/自愈实现（不变量、备份、幂等） |
| `scripts/workspace-registry-guard.mjs` | 跨平台 CLI（`--check` 默认 / `--fix` / `--json`） |
| `tools/dsh-workspace-guard.ps1` | Windows 包装：`-Fix` 会先停 DSH 再自愈 |
| `test/workspace-registry-guard.test.mjs` | 悬空 id / 未列行 / 无效默认 / 幂等 / 备份 |
| `test/registry-write-policy.test.mjs` | 禁止白名单外的手写 workspace.json |
