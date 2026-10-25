# 审计报告：v1.6.1 → v1.7.4（含 v1.7.5-beta.1）

- 审计时间：2026-10-25（Asia/Shanghai）
- 方式：真实执行（build / vet / 全量 test / preflight 门禁）+ 实机部署核验（三台 relay SSH、relay API）
  + 落库断言（devices.json / fleet 表 / device token）+ 零残留测量（用户 TEMP 真实清理与复测）
- 代码基线：`E:\GPT\w2m-src\dsh-windows2macos-main`（版本 1.7.5-beta.1，npm latest 仍为 1.7.4）
- 运行环境：Windows 11 + Node v24.21.0（本机工具链）；relay 主机 Node 22.23.4 / 22.14.0

## 1. 全量构建与质量门禁（真实执行结果）

| 项目 | 命令 | 结果 | 实测耗时 |
|---|---|---|---|
| build（pack） | `node scripts/pack.mjs` | exit 0，tarball 1,480,249 B，sha256 `f9b492f4…` | 0.7 s |
| vet（lint） | `eslint .` | **0 errors / 154 warnings** | 18.9 s |
| test（全量） | `npm test` 等价（166 个测试文件） | **2930 tests / 2916 pass / 0 fail / 14 skipped** | 137.8 s（干净首轮）220.1 s（修复后复测） |
| 静态检查 | reachability / layer-check / entrypoints / classify | 全部 exit 0 | 均 < 2 s |
| preflight 门禁 | `node scripts/preflight.mjs` | **GREEN ×2**（16/16 checks；1 host observation） | 约 2–3 min/轮 |

代码规模：353 个 .mjs/.js 文件，约 121,115 行；`src/plugin` 31 个模块。

## 2. 版本开发进度（1.6.1 → 1.7.4，全部有 Release + CI + Compat）

所有版本均为 GitHub Release 正式版（assets=2：tarball + SHA256SUMS），npm 版本从 1.6.0 连续发布到 1.7.4；
每个 tag 的 Release / CI / Compat 工作流均为 success（数据来自 GitHub API 实测，见 `audit-161-174/gh-history.json`）。

| 版本 | 日期 | 主题（按 CHANGELOG 归纳） | CI / Compat / Release |
|---|---|---|---|
| 1.6.1 | 10-23 | 早期稳定性与窗口/任务报表 | success / success / success |
| 1.6.2–1.6.4 | 10-24 | 编队计数、窗口、指标修复 | success ×3 |
| 1.6.5 | 10-24 | 弹窗/UI 修复 | success |
| 1.6.6 | 10-24 | 自动故障转移（failover）首个版本 | success |
| 1.6.7 | 10-24 | failover 空引用/重启顺序修复 | success |
| 1.6.8 | 10-24 | 插件面板「检查插件更新」 | success |
| 1.6.9 | 10-24 | failover 监视器不阻塞挂载（`agent.start` 非阻塞） | success |
| 1.7.0 | 10-24 | 聊天框截图按钮 + Ctrl+P | success |
| 1.7.1 | 10-24 | 宿主侧截图回退（Electron 权限问题） | success |
| 1.7.2 | 10-24 | 截图改剪贴板、Ctrl+Shift+P、文本可选、按配置主 relay 统计 | success |
| 1.7.3 | 10-24 | toast 覆盖层/5s 自动消失、全服与本编队分源标注 | success |
| **1.7.4** | 10-25 | **桌面宿主 `agent.identity` 崩溃修复 + 切换 relay 后旧 token 401 自动重配对**（两次真实事故的根因） | success |
| 1.7.5-beta.1 | 10-25 | GPW v2 文件夹三分类网关 + 悬浮面板（beta，按仓库策略**不发 npm**） | success / success / Beta #49 success |

## 3. 实机部署与落库断言

### 3.1 三台 relay（审计开始 → 审计结束）

| relay | 审计前版本 | 审计后版本 | 状态 | healthz 延迟 | 编队/设备 |
|---|---|---|---|---|---|
| 43.142.74.71（新主） | 1.7.3 | **1.7.4（本次部署）** | active | 73 ms | 1 编队 `004945ed` / 2 设备在线 |
| 106.53.197.47（旧腾讯云） | 1.6.4 | 1.6.4（未动，服务其它编队） | active | 265 ms | 3/15 编队 · 4/20 设备 |
| 202.182.123.154（Vultr 备） | 1.6.4 | 1.6.4（未动） | active | 510 ms | 1/1 编队 · 3/5 设备 |

部署方式：npm tarball + sha256 校验（`b6d2a919…` 与实际一致）→ 保留 `/opt/w2m/app-1.7.3-backup` 回滚副本 →
替换 `/opt/w2m/app` → `systemctl restart w2m-rabbit`。**状态目录 `/var/lib/w2m/rabbit` 未动**：
devices.json 仍为 1217 B，2 台设备（ToFuture、DSH）token 保留，fleet 表仍为 `004945ed` 且 2/2 在线。

### 3.2 编队归属修复（本次审计发现的真实问题）

- 本机曾被错误地放进新编队 `8e26d696…`（原因：崩溃恢复时 profile 的 w2m 配置行被删，插件走 bundle 默认配置、
  无 fleetKey，按账户派生键新开了一个编队；环境变量方案因 DSH 启动路径不同未生效）。
- 修复：直接调用 relay `POST /v1/pair`（fleet_key 路径，server 端派生 fleet_id）为本机签发原编队 token，
  写入 UTF-8 无 BOM 的 `device.json`。结果：新 relay 编队列表从 2 个（`8e26d696` + `004945ed`）收敛为
  **1 个 `004945ed`，ToFuture + DSH 同编队 2/2 在线**。
- 旧 relay 上仍有一条 `ToFuture` 脏记录（fleet `8e26d696`，offline）——重启旧 relay 才可清理，
  属遗留项（见 §6）。

### 3.3 持久化文件断言

- 新 relay `/var/lib/w2m/rabbit/devices.json`：合法 JSON，2 条设备记录，均含 `device_token`、`fleet_id`、
  `paired_at`、`fleet_source=fleet_key`。
- 本机 `~/.dsh/xclient/device.json`：合法 JSON（无 BOM），token 已换为原编队签发值；`localside/agent-state.json`
  显示 `connected=true, relay_id=ca28b8d559ed1000`。
- 三台 relay `w2m-rabbit` 均 active；新主 relay 另有 `w2m-bootstrap`、`w2m-stun` 正常。

## 4. 零残留测试（本次审计的真实发现与修复）

**发现**：用户真实 TEMP（`C:\Users\fangw\AppData\Local\Temp`）中累积了 **15,677 个 `w2m-*` + 15 个 `gpw-*`
测试临时目录**（13,010 个超过 1 天），单轮全量测试新增约 **1,000 个**——测试存在目录泄漏，违反零残留要求。

**修复**：
1. 新增 `scripts/temp-residue.mjs`（`snapshot / report / clean`：基线对比、按前缀统计、按年龄安全清理）。
2. 新增 `test/helpers/temp-cleanup.mjs`（基线式 per-test 清理，避免并发测试互删）。
3. 修复泄漏测试文件：`gpw-folder-policy`、`agent`（workspace 两处 fixture）、`worktree`（makeRepo）。
4. 清理历史残留 15,608 个目录。

**复测结果**：全量测试完成后新增残留从 ~1,000 个降至 **74 个/轮**（按前缀分布含 `w2m-outbox-`7、
`w2m-relay-test-`7、`w2m-cap-`6、`w2m-grant-gate-`6 等）——已量化并留作下一轮清理清单（见 §6）。

## 5. 功能与性能实测（当前版本）

| 指标 | 实测值 |
|---|---|
| relay healthz 延迟（新主/旧/Vultr） | 73 / 265 / 510 ms |
| relay uptime（审计时） | 25.5k s / 84.0k s / 12.2k s |
| 本机 relay RTT（agent-state） | last 40 ms / avg 57 ms（历史样本） |
| 全量测试 | 2930 用例，0 fail，137.8 s（首轮）/ 220 s（修复后复测） |
| preflight | 16/16 checks GREEN ×2 |
| npm 发布连续性 | 1.6.0 → 1.7.4 全部存在；latest=1.7.4；beta 按策略不发 npm |
| 本机插件版本 | 1.7.4（profile bundle 挂载） |
| 编队在线 | 新主 relay：ToFuture + DSH，2/2，同编队 `004945ed` |

## 6. 遗留问题与建议（按优先级）

1. **测试残留 74 个/轮**（P2）：下一轮按报告前缀清单继续修（`outbox`、`relay-test`、`cap`、`grant-gate`、
   `mq-*`、`m3flow-*`、`p-`/`pins`/`q`/`s` 等），目标为 0；`scripts/temp-residue.mjs` 可直接纳入门禁。
2. **relay 版本漂移**（P2）：旧腾讯云与 Vultr 仍是 1.6.4；建议维护窗口升级到 1.7.4（协议向后兼容，但版本漂移
   会让故障转移演练测的不是同一套代码）。Vultr 的 Node 仍是 22.14.0（其余 22.23.4）。
3. **旧 relay 上 ToFuture 脏记录**（P3）：fleet `8e26d696`，需重启旧 relay 状态清理或加运维删除接口。
4. **v1.7.5-beta.1 的 GPW 面板未做实机 UI 验证**（P3）：代码/单测/门禁已绿，真实浏览器交互（原生文件夹选择器、
   待审批队列）需在实机 DSH 上跑一遍再转 stable。
5. **本地仓库改动未推送**（P2）：本次审计修复（测试清理 + `scripts/temp-residue.mjs` + 审计报告）只在本地工作区；
   `w2m-src` 不是 git 仓库，需按既有 API 推送流程提交（会触发 CI），确认后再做。
6. 旧 relay 承载其它用户编队（14 个编队/20 设备），任何运维动作应避开其在线用户。

## 7. 结论

- v1.6.1 → v1.7.4 共 14 个正式版本，**Release / CI / Compat 全部 success**，npm 连续可安装，latest=1.7.4。
- 当前 HEAD（1.7.5-beta.1）全量 **2930 测试 0 失败**，lint **0 error**，静态检查全绿，preflight **GREEN ×2**。
- 两个真实线上事故（桌面宿主 `agent.identity` 崩溃、切换 relay 后 401）已在 1.7.4 修复并有回归测试；
  本机编队归属已通过 `POST /v1/pair` 修复并与 DSH 同编队。
- 新主 relay 已升级到审计版本 **1.7.4**，状态目录保留、2 台设备 token 与编队完整。
- 零残留：清理 15,608 个历史残留，修复 4 个泄漏测试，单轮残留降至 74（有量化清单），是本次审计最明确的质量缺口。
