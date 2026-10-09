# W2M 发布状态

> 项目：**DSH: Windows2MacOS** · 当前版本 **0.4.0**（P2P 直连默认 + 共享服务器）
> 上一版本 **0.3.9**（P2P 传输层，未接入任务路径）、**0.2.3**（每日自更新）、**0.1.2**（跨区域 / 跨网络）、**0.0.1**（同一局域网）。
> 本文记录已完成的发布动作与仍需跟进的事项。

---

## 0. 当前版本 v0.4.0（P2P 成为默认路径）✅

| 事项 | 结果 |
|---|---|
| 版本 | `0.4.0` |
| 新增 | `src/agent/p2p-node.mjs`（宣告 / 打洞 / 长连接）、`accept()`（响应侧）、`src/relay/stun-server.mjs` + `bin/w2m-stun.mjs`（自带 STUN 响应器）、`deploy/shared-server/`（一条命令部署会合点主机） |
| 默认 | **P2P 直连**：`p2pMode: auto` 真正生效（此前 `p2p.mode` 无人读取）；`rabbitUrl` 留空即用共享服务器 `http://202.182.123.154:8787`，STUN 默认第一位是 `202.182.123.154:3478`；`w2m_status` 用 `rabbit_source` 说明地址来源 |
| 共享服务器 | 中继（`:8787`，另有 nginx `:80`）、STUN（`:3478/udp`）、systemd 单元、ufw 规则、以及作为舰队一员的 Localside（`jp-shared`），全部在线 |
| 测试 | **29 个套件**：新增 `p2p-node`、`p2p-transport-fields`、`p2p-plugin`、`p2p-agent`、`stun-server`，已写入 `npm test` / `test:all` / `test:p2p` / `scripts/verify.{ps1,sh}` / `ci.yml` / `release.yml` |

### 三个实测结论，不是推理结论

1. **中继必须把自己的 offer 压后 `p2pOfferGraceMs`（1200 ms）**，否则直连永远赢不了：SSE 是已建立连接上的推送，而打洞至少要一个 RTT —— 环回实测里中继副本每次都先到。压后由执行端自己的租约心跳取消（它一开始干活就续约），因此不需要新增任何消息类型。
2. **直连结果帧只带任务与机器身份，不带信封**：`result_path` 是信封自身字段且被 `envelope_sha256` 覆盖，所以必须先拿到确认才能构造信封。直连省下的是"等中继副本的时间"，不是字节 —— 写在 `PROTOCOL-v0.4.0.md` 里，而不是留给读者去猜。
3. **跨真网一跳已实测**：派发端在中国移动的**对称 NAT** 之后，执行端在东京。`HELLO` → `HELLO_ACK` **331.61 ms**，账本为 `jp-shared` 记录 `transport: "p2p"`、`result_path: "p2p"`。对称 NAT 挡的是"被拨入"，不是"主动拨出" —— 这也是派发方负责打洞的原因。

### 这次部署暴露的两件事（都已写进文档）

- **要接受打洞的机器必须有可达的 UDP 端口。** 共享服务器上第一次打洞失败，原因就是 ufw 没放行 agent 的临时 UDP 端口；放行后立刻成功。今天端口是临时的，所以规则要覆盖区间 —— **固定 `--p2p-port` 是下一步**（`CHANGELOG.md` 与 `README.md` 都标为待办，而不是当作已解决）。
- **节点自检抓到的真实缺陷**：STUN 响应的属性 padding 少了一字节（15 字节 `ERROR-CODE` 后必须补到 4 的倍数），导致每个 `0x0111` 响应长度声明为 39 而非 40。客户端解码器与一份手写十六进制期望都没发现 —— 它们与实现共享了同一个错误假设；只有按 RFC 布局算出来的向量抓到它，现已用长度断言 + 整包比对固定住。

### 本机跑不全绿的两个套件（HEAD 上同样失败，非本次改动）

| 套件 | 现象 | 原因 |
|---|---|---|
| `agent`（1 例） | `finds python in the bundled DSH runtime when PATH has none` | 本机 DSH 运行时布局与测试假设不同（运行时在应用目录而不是 `DSH_HOME` 下）；已在干净 `git worktree` 的 HEAD（0f89806）复现同样失败 |
| `pipeline-e2e`（2 例） | 阶段命令没有执行，`order.txt` / `stop.txt` 不存在 | 允许清单的字符串条目按空格切词，而本机 Node 装在 `C:\Program Files\nodejs`（路径含空格）→ 字符串条目永远匹配不上；CI 的 Node 路径无空格，故 CI 全绿。已写入 `docs/TROUBLESHOOTING.md` §10 |

其余 27 个套件本机全绿（含 `p2p-node` / `p2p-agent` / `p2p-plugin` / `p2p-transport-fields` / `stun-server`），CI 在 windows / macos / ubuntu 三平台矩阵上全绿。

---
## 1. 上一版本 v0.2.3（每日自更新）✅

| 事项 | 结果 |
|---|---|
| 版本 | `0.2.3` |
| 新增 | 插件内置**时区感知调度器**：北京时间每天 **00:00 / 03:00 / 05:00** 检查 GitHub 更新，有新版则校验 SHA-256 后自动安装；新增第 6 个工具 `w2m_update` |
| 默认 | **关闭**（`autoUpdate: true` 开启）。会替换自己安装的插件不应在用户不知情时启动 |
| 测试 | **435 用例 / 434 pass / 1 skip / 0 fail**（relay 91 · agent 105 · plugin 73 · schedule 39 · auto-update 34 · update-source 50 · update-install 28 · update-wiring 15） |

### 为什么不用宿主的 `@deepseek-ai/dsh-schedule`
它**存在**于运行时（已实测），但**不适用**：其提醒绑定到 Agent Session、通过往 Session 收件箱投递消息；其 README 明确写 *"cannot be mounted alone in a headless or SDK-only composition"*，且**发布的 Web 组合默认不含 `schedule` 行**。插件自有的周期任务没有 Session 可绑，因此自带定时器 —— 通过 `ctx.effect` 可逆持有。

### 设计上刻意做的取舍（每条都有测试）
1. **绝不降级**：`isNewer` 严格大于；**预发布单独拦截**（`0.2.0-rc.1` 按 SemVer 高于 `0.1.2`，只靠比较会把候选版推给稳定安装）。比较函数回答"谁更高"，策略层回答"能不能装"。
2. **先校验再落盘**：tarball 必须匹配该 Release 的 `SHA256SUMS`；不匹配**零字节写入**（连 staging 都不建）。
3. **回滚保证的是清单，不是树**：还原 `package.json`/`pnpm-lock.yaml` 不会撤销 pnpm 对 `node_modules` 已做的事。所以结果里带 `rollbackComplete`（树是否重新与还原后的清单一致？）+ `reconciliation` 对账命令，插件侧暴露为 `reconciliation_needed`。**这是唯一需要人的状态。**
4. **查询失败 ≠ 已是最新**：两者在日志里长得一样，只有一个有问题，所以失败记为 **error**。
5. **不重启 DSH**：安装改变的是**下次启动**加载什么；重写一个活跃 Cordis 容器已加载的模块不是插件该做的事，所以状态报 `restart_required` 而不是暗示新代码已生效。

### 修掉的两个真实缺陷
- **`ctx.effect?.(...)` 曾用可选链调用**（`apply()` 内）。宿主没有该方法时，计划任务**注册不到任何地方、也永不释放** —— 无报错、无日志，只是每天该跑的东西静默不存在。已改为必备调用，启用该功能时缺失即按名报错（`W2M_NO_EFFECT`）；实测 Cordis 4.0.4 确实提供它，所以严格化不会打断当前宿主。
- **CI 的显式文件列表没有包含新套件**：`ci.yml`/`release.yml` 只跑了 relay/agent/tools/e2e，新增的 4 个套件（166 用例）**在 CI 里根本不会执行**。已补齐，并核验"仓库里每个 `*.test.mjs` 都被 CI 与 Release 覆盖"。`scripts/verify.{ps1,sh}` 的默认套件列表同样过时，已补。

---

## 2. 上一版本 v0.1.2（跨区域 / 跨网络）✅

| 事项 | 结果 | 凭据 |
|---|---|---|
| 版本 | `0.1.2` | `package.json` |
| Release | https://github.com/TwinsEarth/dsh-windows2macos/releases/tag/v0.1.2 | tag `v0.1.2` |
| 资产 | `twinsearth-w2m-dsh-plugin-0.1.2.tgz` + `SHA256SUMS` | 由 **CI 自动构建并发布**（`release.yml`），不是手工上传 |
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

## 3. 上一版本 v0.0.1（局域网）✅

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

## 4. 待跟进 ⏳

1. **PR #6783 仍 OPEN**：唯一硬性阻塞是 upstream 的「仓库创建满 1 天」（2026-10-08T13:19:15Z 后自动满足）。**不要 force-push、不要关掉重开**（first-time contributor 的 fork PR 需维护者批准 workflow，前一个 PR #6352 就卡在这里）。
2. **三种部署形态的真实网络层未实测**：Tailscale/WireGuard、公网 VPS+TLS、Cloudflare Tunnel/ngrok 都只做了语义等价测试（127.0.0.1 + 注入头）。`docs/DEPLOY.md` §7 列了每项的验证命令与"未在本机验证"标注。
3. **真实的 Windows↔macOS 互联未实测**：CI 矩阵证明各平台跑得过，但矩阵里的两台机器不会互相通信；机器到机器链路目前只在同一主机的两个进程间验证过。
4. **npm 未发布**：本机无 npmjs 凭据。tarball 通道已验证可用，商店也接受只给 tarball（4414 条中有 347 条如此）。
5. **跨机状态视图**：当前 RTT 走同机状态文件；跨区域下"插件在 A 机、agent 在 B 机"时无效。正确做法是走中继（心跳 body 带 `rtt_ms`），属 v0.1.3 范畴。

---

## 5. 复跑验证（任何人可复现）

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
