# W2M 发布状态

> 项目：**DSH: Windows2MacOS** · 当前版本 **0.1.2**（跨区域 / 跨网络）
> 上一版本 **0.0.1**（同一局域网）。本文记录已完成的发布动作与仍需跟进的事项。

---

## 1. 当前版本 v0.1.2（跨区域 / 跨网络）✅

| 事项 | 结果 | 凭据 |
|---|---|---|
| 版本 | `0.1.2` | `package.json` |
| Release | https://github.com/TwinsEarth/dsh-windows2macos/releases/tag/v0.1.2 | tag `v0.1.2` |
| 资产 | `twinsearth-w2m-dsh-plugin-0.1.2.tgz`（159,660 B）+ `SHA256SUMS` | 由 **CI 自动构建并发布**（`release.yml`），不是手工上传 |
| 资产 sha256 | `2b55d7d10a1b292b8d4ce6add9631085027a443d6f5ad1c9974346fc7f52f344` | 与本地重建**逐字节一致**（已验证） |
| CI | **5/5 全绿**：windows 20/22、macos 22、ubuntu 22、可复现性 job | run 37646434086 |
| Release workflow | **success** | run 37646442275 |
| 测试 | **315 用例 / 314 pass / 1 skip / 0 fail** | relay 91 · agent 105 · plugin 73 · e2e+crossnetwork 46 |
| 商店投稿 | PR [#6783](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/6783) **OPEN / MERGEABLE / 1 文件**，已更新到 0.1.2 | 2 commits |

### v0.1.2 修掉的三个真实缺陷
1. **子路径部署完全不可用** —— `new URL('/v1/stream', rabbitUrl)` 会吃掉路径前缀，挂在 `/w2m` 下的中继对所有请求回 404（含插件）。改为纯拼接。
2. **重启后下发的任务会永久丢失** —— 中继重启后、机器流重连前发出的 offer 再也不会送达，lease 一路 `offered` 到被 sweep 判 expired（而两台机器全程 `online=true streams=1`）。两条独立原因：
   - 补投路径**从未真正可达**：`this.logger(...)` 在响应头已发出后无条件调用（`logger:null` 是文档里的静默取值）→ `TypeError` → 顶层 catch 二次响应 → `Cannot write headers after they are sent`，正好摧毁它要修的那条 SSE 路径。次生错误掩盖了真实错误，这也是它藏这么久的原因。
   - **上一个进程的游标被采信**：seq 从 0 重来，`Last-Event-ID: 42` 让新进程以为那些事件已消费，连同 `task.cancel` / `notice` 一起吞掉。
3. **发布产物跨平台不可复现** —— zlib 把宿主 OS 写进 gzip 头第 9 字节（Windows=10/NTFS，Linux=3/Unix）；tar 载荷完全相同，只差这一个字节。原先的"可复现"检查只在同一台 runner 上 pack 两次，检测不到宿主相关字节。

> **教训（已写进源码注释）**：送达保证必须来自**补投**（与游标无关）；失步判定只能当诊断，不能当安全网 —— `from > lastSeq + 1` 这个判定在 gap 里多塞几个事件后就会静默失效。

---

## 2. 上一版本 v0.0.1（局域网）✅

| 事项 | 结果 |
|---|---|
| Release | https://github.com/TwinsEarth/dsh-windows2macos/releases/tag/v0.0.1 |
| 资产 sha256 | `28f78a9ed22c829a5b0ee1f78c074062c25a2c10044fd126b9c3371b3d60e3fc` |
| 说明 | 该资产是 CI 自动化之前手工上传的；**0.1.2 起改由 `release.yml` 在打 tag 时自动构建并发布**，不再手工同步哈希 |

### 自动发版流程（0.1.2 起）
```
1. 冻结代码 → 确认全部测试通过
2. git tag -a v<version> && git push origin v<version>
3. release.yml 自动：校验 tag 与 package.json 一致 → 跑全部测试 → pack
   → 解包验证 5 个工具能注册 → 建 Release 并上传 tgz + SHA256SUMS
```
**不要再手工 pack/upload** —— 那正是 0.0.1 出现"线上资产与 tag 源码不一致"的原因。

---

## 3. 待跟进 ⏳

1. **PR #6783 仍 OPEN**：唯一硬性阻塞是 upstream 的「仓库创建满 1 天」（2026-10-08T13:19:15Z 后自动满足）。**不要 force-push、不要关掉重开**（first-time contributor 的 fork PR 需维护者批准 workflow，前一个 PR #6352 就卡在这里）。
2. **三种部署形态的真实网络层未实测**：Tailscale/WireGuard、公网 VPS+TLS、Cloudflare Tunnel/ngrok 都只做了语义等价测试（127.0.0.1 + 注入头）。`docs/DEPLOY.md` §7 列了每项的验证命令与"未在本机验证"标注。
3. **真实的 Windows↔macOS 互联未实测**：CI 矩阵证明各平台跑得过，但矩阵里的两台机器不会互相通信；机器到机器链路目前只在同一主机的两个进程间验证过。
4. **npm 未发布**：本机无 npmjs 凭据。tarball 通道已验证可用，商店也接受只给 tarball（4414 条中有 347 条如此）。
5. **跨机状态视图**：当前 RTT 走同机状态文件；跨区域下"插件在 A 机、agent 在 B 机"时无效。正确做法是走中继（心跳 body 带 `rtt_ms`），属 v0.1.3 范畴。

---

## 4. 复跑验证（任何人可复现）

```powershell
cd E:\DS\w2m
$node = 'C:\Users\fangw\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node scripts/check-entrypoints.mjs                    # 入口可导入（曾抓到真实缺陷）
& $node --test --test-force-exit test/relay.test.mjs test/agent.test.mjs test/tools.test.mjs
& $node --test --test-force-exit test/e2e.test.mjs test/crossnetwork.test.mjs
& $node scripts/pack.mjs --out dist                      # 应与线上资产同哈希
& $node scripts/probe-restart.mjs                        # 重启丢 offer 的原始诊断探针
```

**两个易踩的坑**：
- `npm test` 曾因 `node --test test/` 在 Node 24 上被当成模块路径，**一个测试都没跑却报失败**；已改为显式文件列表 + `--test-force-exit`。
- 端到端套件必须带 `--test-force-exit`：每个模拟机器都持有 SSE 长连，否则断言跑完事件循环也不退出。
