# W2M v0.0.1 发布状态

> 项目：**DSH: Windows2MacOS** · 版本 **0.0.1** · 发布日 2026-10-07
> 本文记录**已完成的发布动作**与**仍需跟进的事项**，供下次继续。

---

## 1. 已完成 ✅

| 事项 | 结果 | 凭据 |
|---|---|---|
| 源码仓库 | https://github.com/TwinsEarth/dsh-windows2macos （public） | 2 次提交，main 分支 |
| 首版提交 | `35fcdc8` DSH: Windows2MacOS v0.0.1（33 文件 / 13,825 行） | `git log` |
| 修复提交 | `dbaad9a` 修复插件 re-export 与 CLI 工厂名 + 新增两个门禁 | `git log` |
| Release | https://github.com/TwinsEarth/dsh-windows2macos/releases/tag/v0.0.1 | tag `v0.0.1` |
| 资产 | `twinsearth-w2m-dsh-plugin-0.0.1.tgz`（93,847 B）+ `SHA256SUMS` | `state=uploaded` |
| tarball sha256 | `7b3edbb32c29ef3ced32cfec91708a6292dc96d47d23973f68d534f6be8b2fb9` | 经 `gh release download` 复核一致 |
| Topics | `dsh-plugin` `deepseek-harness` `deepseek` `windows2macos` `multi-machine` `orchestration` | `gh repo view` |
| 商店投稿 PR | https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/6783 | **open**，**仅 1 个文件 +7 行** |
| 本地端到端 | 195 用例全绿（relay 61 / agent 79 / tools 45 / e2e 10）+ CLI 冒烟通过 | `scripts/verify.ps1` |

### 本地验证命令（可复跑）
```powershell
$node = 'C:\Users\fangw\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node E:\DS\w2m\scripts\check-entrypoints.mjs     # 入口可导入（曾抓到真实缺陷）
& $node E:\DS\w2m\scripts\pack.mjs --out E:\DS\w2m\dist
$env:DSH_HOME='E:\DS\_work\w2m\install-test2'
$dsh = 'E:\DS\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile w2mtest add (Resolve-Path E:\DS\w2m\dist\twinsearth-w2m-dsh-plugin-0.0.1.tgz).Path
& $node E:\DS\w2m\scripts\verify-installed.mjs "$env:DSH_HOME\profiles\w2mtest\node_modules\@twinsearth\w2m-dsh-plugin"
```

---

## 2. 待跟进 ⏳

### 2.1 PR #6783 需要仓库满 1 天（**唯一硬性阻塞，自愈**）
- 仓库创建于 **2026-10-07T13:19:15Z** → **2026-10-08T13:19:15Z** 之后即满足 upstream 的「仓库创建满 1 天」要求。
- **不需要重新提交或 force-push**。upstream `contributing.md` 明确：未满 1 天是自愈条件。
- 我在 PR 正文里已主动声明这一点。

### 2.2 CI 不会立刻跑（**不是内容问题，无法自行修复**）
- `gh pr checks 6783` → `no checks reported`。
- 原因（task-1 的前例已证实）：TwinsEarth 在该仓库是 **first-time contributor**，fork PR 的 workflow **需维护者点批准**才会执行。前一个 PR #6352 至今停留在这个状态。
- **正确做法：等待，或在 PR 里礼貌 ping 维护者。不要 force-push、不要关掉重开。**

### 2.3 上游 main 可能前进
- 我的分支基于 `08f3df4`。若 upstream 在我们之前合并了其他 PR，需要 rebase 到最新 main 再推（**普通 rebase + push，不要 force-push 到别人的分支**；推自己的 fork 分支可以 force）。

### 2.4 尚未做（非阻塞）
- **npm 发布**：本机无 npmjs 凭据（`pnpm whoami` → 未登录）。tarball 通道已验证可用，商店的一键安装会优先用「经仓库验证的 npm 包」，但**只给 tarball 也完全可以**（4414 条中有 347 条只有 tarball）。若你想发 npm，需要先 `pnpm login`。
- **Mac 真机验证**：所有实测都在 Windows 上完成。代码是平台中立的，但**未在 Mac 上跑过**。
- **`write: true` 的合并**：v0.0.1 只执行不合并。

---

## 3. 商店规范（复核用，来源：upstream `scripts/lib/entries.mjs`）

字段白名单 = `url / name / category / description / tarball`（`file` 由读取器注入）。
**`npm:` 是禁止字段**，写了会校验失败；npm 由 `probe-npm.mjs` 从仓库自动探测。

我们的条目：
```yaml
url: https://github.com/TwinsEarth/dsh-windows2macos
name: TwinsEarth/dsh-windows2macos
category: remote
tarball: https://github.com/TwinsEarth/dsh-windows2macos/releases/download/v0.0.1/twinsearth-w2m-dsh-plugin-0.0.1.tgz
description:
  en: '...'
  zh: '...'
```
- 文件名必须 = `slugFor(url)` = `TwinsEarth__dsh-windows2macos.yml` ✅
- `category: remote` 依据：该分类收录「局域网访问 / SSH / 跨机」类插件（例：`dsh-web-url-view`、`dsh-ssh-logs`）。选错不会被打回，维护者会改。
- tarball 必须 `https` + host ∈ {github.com, objects.githubusercontent.com, release-assets.githubusercontent.com} + 以 `.tgz`/`.tar.gz` 结尾 ✅
- **不要用 `releases/latest/download/<带版本号的名字>.tgz`**：下次发版即 404，站点会把它丢掉。我们用钉住 tag 的 URL ✅

**已用 upstream 自己的校验器验证通过**：
```powershell
cd E:\DS\_work\w2m\market\upstream
& $node --input-type=module -e "import('./scripts/lib/entries.mjs').then(m=>{const p=m.validateEntries(m.readEntries()); console.log(p.length?p.join('\n'):'ENTRY OK'); process.exit(p.length?1:0)})"
# → ENTRY OK
```

---

## 4. v0.0.1 修过的两个真实缺陷（值得记住）

两者都**通过了 `node --check` 与全部单元测试**，只会在 DSH 挂载插件时暴露：

1. `lib/tools.js` 重新导出了一个 `default` 绑定，而 `src/plugin/tools.mjs` **没有** default 导出。
   - `node --check` 只解析、不解析导入；单元测试直接 import `src/`，绕过了 `lib/`。
2. `bin/w2m-rabbit.mjs` 从 relay 导入 `createRelay`，而实际导出是 `createRelayServer`。

现在由两个门禁守着：`scripts/check-entrypoints.mjs`（导入真实挂载点）与 `scripts/verify-installed.mjs`（验证 profile 里**已安装的那份**副本）。

> 教训：**"装上了"不等于"能加载"**。发布前必须验证已安装副本的 import 与注册数。
