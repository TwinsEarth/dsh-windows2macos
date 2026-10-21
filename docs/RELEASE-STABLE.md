# 稳定版发布流程（Stable Release Runbook）

> 适用：本项目（`@twinsearth/w2m-dsh-plugin`）从版本决定到五方核验完成的全过程。
> 角色边界：**版本号与发布时间由用户决定**；执行者负责门禁、打包、推送、核验；**Stable 批准只能由用户操作**。
> 原则：门禁红绝不打 tag；先发布、后部署 relay；每个版本留证据。

---

## 0. 发布前条件（缺一不可）

```
[ ] 用户已明确版本号（稳定版 X.Y.Z；预发布必须 X.Y.Z-beta.N）
[ ] 工作区没有未完成的半成品改动（未发布的功能不能混进稳定版）
[ ] 本机 PATH 包含打包的 node 目录（否则 agent 测试会误报
    COMMAND_EXECUTABLE_PATH_MISMATCH）
[ ] 已阅读本次要发布的 CHANGELOG 条目（next section 写什么）
```

PATH 准备（Windows）：

```powershell
$node = 'E:\DS\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$env:PATH = (Split-Path $node) + ';' + $env:PATH
```

---

## 1. 版本 bump（5 个文件）

```
package.json
plugin.json
.claude-plugin/plugin.json
.claude-plugin/marketplace.json   （version + metadata.version + plugins[].version）
codex/mcp-servers.toml            （@X.Y.Z）
```

注意：用 Node 写 JSON，**不要用 PowerShell `ConvertTo-Json` 回写**（会带 BOM，pack 直接崩）。

---

## 2. CHANGELOG

- 新条目放在**最上面**（newest-first）。
- 标题格式：`## [X.Y.Z] — YYYY-MM-DD`。
- 必须写：改了什么、没有改什么（明确不包含项）、已知限制、验证数字。
- 排序规则由 `claims` 检查：**prerelease 按 semver 比较**（`X.Y.Z-beta.2 > X.Y.Z-beta.1`）。
- `package.json` 版本必须等于最新条目版本（claims 断言）。

---

## 3. 打包与门禁（两遍）

```powershell
Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
& $node scripts/pack.mjs
# 记录：bytes 与 sha256

& $node scripts/preflight.mjs   # 第一遍
& $node scripts/preflight.mjs   # 第二遍（必须同样 GREEN）
```

通过标准：

```
pre-flight: 15 pass, 0 fail, 1 unverifiable（host 环境项）
declared suite: N tests / pass / 0 fail / 14 skip
```

红灯常见原因与修法：

| 失败项 | 原因 | 修法 |
|---|---|---|
| lint | 未使用 import、Promise executor 返回、未定义变量 | 修代码；不得用 eslint-disable 绕过 |
| declared suite | 测试失败 | 先跑单个文件定位；PATH 问题看 `COMMAND_EXECUTABLE_PATH_MISMATCH` |
| claims | 版本顺序 / package 与最新条目不一致 / 文档未声明 / 未注册工具名 | 按断言修；新文档要么登记 shipped 要么排除并写理由 |
| layer-model | 新模块/新跨层 import 未声明 | 在 `scripts/layer-model.mjs` 声明层与允许边（不要放宽成环形） |
| packed tarball | dist 陈旧 / 文档缺失 / 工具数不符 | 删除 dist 重 pack；同步 verify-installed/README/preflight 的计数 |
| CHANGELOG shape | 非降序 / 格式不符 | 调整条目位置与标题 |

**门禁不绿：停止，不 commit，不打 tag。**

---

## 4. 提交与打 tag

```
1. 写 commit 消息（release: vX.Y.Z — <一句话主题>，正文列变更与验证数字）
2. 用推送脚本 commit + push main，取回 COMMIT_SHA（脚本输出 COMMIT_SHA=...）
3. 用 GitHub API 建 tag：POST /repos/<owner>/<repo>/git/refs
   { "ref": "refs/tags/vX.Y.Z", "sha": COMMIT_SHA }
4. 轮询 Release workflow：waiting 出现 = 进入 Stable 环境审批
```

```powershell
# 轮询示例（node）
# /repos/<repo>/actions/runs?per_page=8 → 找 name === 'Release' 且 head_sha 匹配
# jobs 里有 status === 'waiting' → 等待审批
```

---

## 5. Stable 审批（只能用户做）

```
GitHub → Actions → release run → Review deployments → Stable → Approve
```

审批后 workflow 继续：verify → pack → publish（GitHub release + npm）。

---

## 6. 五方核验（全部通过才算发布完成）

```
1. npm：latest 变为 X.Y.Z（注意传播延迟，可重试）
2. GitHub release：prerelease=false；资产包含 tgz + SHA256SUMS
3. 资产校验：下载 tgz 实算 sha256，必须与 SHA256SUMS 一致
4. Packages：dispatch packages workflow（inputs.version=X.Y.Z），job success
5. CI：该 commit 的 ci.yml run success
6. Compat：该 commit 的 compat.yml run success（红则视为不可发布，见下）
```

Compat 红的高频原因：打包产物与 loader gate 的 `EXPECTED_TOOLS` 不一致
（v1.3.0 实例）。定位方法：看 Compat 日志的 “registers every w2m_* tool” 子测试，
它会打印 live tools 与 expected 的差异。

---

## 7. relay 部署（发布包含 relay 变更时）

用**官方 release 资产**（sha 与五方核验一致），不要用本地 pack 产物。

```bash
# SSH（或 fleet 通道以 w2m 用户执行）
cd /opt/w2m && rm -rf app.bak && cp -a app app.bak
# 上传官方 tgz 到 /tmp
bash /opt/w2m/app.bak/deploy/server/deploy-w2m.sh /tmp/<tgz> <sha256>
# 若 systemd 拒绝重启（非 root）：kill -TERM <MainPID> 触发 Restart=always
systemctl status w2m-rabbit w2m-stun w2m-localside --no-pager
```

线上复核（必须做）：

```
/healthz 200；relay_id 变化、uptime 归零（证明是新进程）
/v1/fleet/members 200；未认证 /v1/fleet/messages 401
任务派发 → 目标机执行成功（plain task）
新版本特性路径生效（如 reduce 取件失败码、maintenance 字段透传）
磁盘占用正常；app.old 保留（回滚材料）
```

回滚：

```bash
systemctl stop w2m-rabbit w2m-stun w2m-localside
mv /opt/w2m/app /opt/w2m/app.1 && mv /opt/w2m/app.old /opt/w2m/app
systemctl start w2m-rabbit w2m-stun w2m-localside
```

---

## 8. 收尾

```
[ ] 证据入库：docs/acceptance/<version>/<case>.json（真实任务 task_id + 断言结果）
[ ] CHANGELOG 的验证数字与实际门禁输出一致
[ ] 需要时更新各机器插件（TwinsEarth / macmini / ToFuture），并在发布说明中标注 relay 版本
[ ] 若本版本被后续版本纠正，写明代替关系（如 v1.3.0 → v1.3.1）
```

---

## 9. 本会话踩过的坑（已修复，写下来防止复发）

1. **PATH 缺 node 目录** → agent 测试 18 个 `COMMAND_EXECUTABLE_PATH_MISMATCH`。跑门禁前先 prepend。
2. **PowerShell 回写 JSON 带 BOM** → pack 报 `Unexpected token '﻿'`。用 Node 写 JSON。
3. **CHANGELOG 比较器忽略 prerelease** → beta.1/beta.2 相等、顺序断言互相矛盾。已改成 semver 比较。
4. **陈旧 dist** → “packed package.json 与 tree 不一致”。发布前删除 dist 重 pack。
5. **工具数变化（16 tools）** 需要同步：README、verify-installed、preflight packed-tarball 计数、tool-cards、claims、update-wiring、p2p-plugin、marketplace 清单。
6. **Compat 只在打包产物+真实 profile 暴露**：本地 loader 检查可能跳过，必须看 Compat 的 capture 输出。
7. **npm 传播延迟**：dist-tag 未更新不等于发布失败，重试读取。
8. **relay 上的 systemd 权限**：w2m 用户不可 systemctl；要么 root（SSH/控制台），要么 kill 触发 Restart=always（并确认 localside 也会回来）。

---

## 10. 角色与红线（再次强调）

```
用户：决定版本号、批准 Stable、决定是否把 beta 部署到生产 relay
执行者：门禁、打包、推送、五方核验、部署与线上复核
红线：门禁红不打 tag；不用 beta 冒充稳定版；不未经用户同意部署生产；不自行决定版本号
```
