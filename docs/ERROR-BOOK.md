# W2M 错误本

记录已经发生过、且会重复踩到的错误。每条包含：现象、根因、修复、防复发措施。新条目追加在最后。

| 编号 | 版本 | 状态 |
| --- | --- | --- |
| EB-001 | 3.5.8 → 3.5.9 | 已修复，GitHub Release 已发布；npm 待 2FA 批准 |
| EB-002 | 3.5.9 发布门禁 | 已修复，Compat 重跑验证中 |
| EB-003 | 3.5.8 npm 暂存包 | 待 reject，禁止批准 |

## EB-001 dsh-teams 启动报 `Cannot find module '../../lib/tool-kit.js'`

**现象**

启用 Teams 子插件时组件激活失败：

```
组件启用失败: dsh: warning: 1 entry did not activate dsh-teams
(@twinsearth/w2m-dsh-plugin/dsh-teams): Error: Cannot find module '../../lib/tool-kit.js'
Require stack:
- C:\Users\fangw\.dsh\profiles\desktop\node_modules\@twinsearth\w2m-dsh-plugin\src\plugin\teams-plugin.mjs
```

**根因**

`src/plugin/teams-plugin.mjs` 用 `createRequire(import.meta.url)` 加载 `../../lib/tool-kit.js`。该文件既不存在于源码树，也不在 npm 包内；同类子插件（`p2p-webrtc-plugin.mjs`、`backup-plugin.mjs`）都通过 `src/plugin/tools/shared.mjs` 的 `loadDefineTool` 获取 `defineTool`，Teams 这一处漏改。

**修复**

- 删除 `createRequire` 与 `lib/tool-kit.js` 引用，改为 `import { loadDefineTool } from './tools/shared.mjs'`（优先 `@deepseek-ai/dsh-tools`，缺包时回退）。
- 新增回归用例：不注入 `defineTool` 时 `apply` 仍能挂载 `w2m_team_status` / `w2m_team_room` / `w2m_team_artifact`。
- 提交 `67454f9`，版本升至 **3.5.9**；GitHub Release 与 tag 已发布，TGZ SHA-256 `a5b252cbe57d8b3ac199a75e1df832634fc0c44adfce5af4e3271069e79a39d6`。
- 本机安装副本已直接用修复文件覆盖，Node 实测入口可加载。

**防复发**

- 子插件加载宿主能力统一走 `tools/shared.mjs`，禁止再写包内不存在的相对路径。
- 回归测试必须覆盖“未注入依赖”的真实挂载路径，而不是只测注入 `defineTool` 的路径。
- 发布前在真实安装包内跑一次入口导入与 `apply`，不只跑源码树测试。

## EB-002 发布门禁因 opt-in 探针跳过而红

**现象**

Compat 工作流 `packed artifact mounts and boots in a real profile` 失败，preflight 报：

```
"shows the archive tab only for an enabled archive row" was SKIPPED
(W2M_SURFACES_PROBE=1 enables the archive row in the throwaway profile and drives this probe)
and that reason is not on the accepted list
```

同时汇总 `1 skipped` 与结果行上的 accepted skip 数不一致（0）。

**根因**

`test/loader-entry.test.mjs` 的 archive-tab 探针需要 `W2M_SURFACES_PROBE=1` 才运行；发布门禁跑整套测试时没有设置该变量，断言被 skip。`scripts/preflight.mjs` 的 `ACCEPTED_SKIPS` 只有 “boots the profile” 条目，没有这条 opt-in 跳过，于是“未评估断言”被当作门禁失败。

**修复**

真正的白名单有两处：`scripts/preflight.mjs` 的 `ACCEPTED_SKIPS`（整仓 preflight），以及 `.github/workflows/compat.yml` 内联 verdict 程序的 `ACCEPTED_UNVERIFIABLE` / `acceptedFor`（Compat 的 loader gate）。后者原本只接受 page half “boots the profile” 的跳过，opt-in 探针一律判红。

修复：
- `scripts/preflight.mjs` 新增 `surfaces-probe-archive-tab-opt-in`（suite `/^loader entry: the packed artifact/`、match 同上、maxCount 1）。
- `compat.yml` 新增 `OPT_IN_SKIPS` 名单，`acceptedFor` 对非 page 的跳过按“测试名 + 原因”精确匹配；错误文案改为“accepted lists cover only page half and named opt-in probes”。

提交：`21976d2`（preflight）与后续 compat 修复（因 git 端口被重置，用 GitHub Contents API 推送到 `work/v3.4.6`）。

**防复发**

- 新增任何 `skip`/`t.skip` 必须同步 `ACCEPTED_SKIPS`，否则门禁按“未评估断言”失败。
- 运行时 `t.skip()` 的跳过行也要计入汇总一致性（不要只靠套件级 skip）。
- 发布 tag 前在目标 CI 环境先跑一次 preflight，避免 tag 已发后才发现门禁策略缺条目。

## EB-003 3.5.8 的 npm 暂存包含启动缺陷

**现象**

`@twinsearth/w2m-dsh-plugin@3.5.8` 已 staged（id `dc1038b0-faec-446f-abcf-6f5e795ea7f8`），但其 tarball 里仍是引用 `lib/tool-kit.js` 的旧 `teams-plugin.mjs`。

**风险**

一旦有人批准该 stage，会把 EB-001 的启动缺陷发布到 npm。

**处置**

- 不要批准 `dc1038b0-faec-446f-abcf-6f5e795ea7f8`，执行 `npm stage reject`（需 2FA）清除。
- 3.5.9 已重新暂存，id `06bdf114-1678-4783-9ab3-e56a84ff8cff`，批准前先核对 tarball 内含修复。
- 已发布的版本号不得复用；修复必须走新版本。

**防复发**

- 版本发布后若发现阻断性缺陷，先 reject 未批准的 stage，再升版本重发。
- 批准 npm stage 前，用 `npm stage download` 解包核对关键文件内容，而不是只看版本号。
