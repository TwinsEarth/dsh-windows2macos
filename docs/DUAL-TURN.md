# 双 TURN 部署与按 pair 负载分发

本文记录 W2M 的两台腾讯云 TURN 节点、client 侧分发规则和验收口径。它不是“TURN 自带
L4 负载均衡”的说法：coturn 没有内建集群 VIP，W2M 做的是**每个 peer pair 稳定选主、另一台
作为 fallback**，让不同 pair 分布到不同 TURN 节点。

## 1. 节点拓扑

| 角色 | 公网地址 | 私网地址 | TURN 端口 | relay 端口池 |
| --- | --- | --- | --- | --- |
| turn-a | `43.142.74.71` | `10.0.0.10` | `3479` | `49160-49200` |
| turn-b | `134.175.243.146` | `192.168.0.5` | `3479` | `49160-49200` |

两台使用同一 `realm=w2m.webrtc`、同一 `w2m` 用户和同一长期凭证。凭证只出现在
`/etc/turnserver.conf`、客户端配置和部署环境变量中，不进入 git、日志或聊天。

腾讯云安全组必须放行：

- UDP `3479`（TURN/STUN）
- TCP `3479`（TCP fallback）
- UDP `49160-49200`（relay 端口池）

安全组在控制台；主机上的 UFW 只是第二层。只开 UFW 而安全组没开，外部 Allocate 仍然失败。

## 2. 客户端配置

`iceServers` 只放 STUN；TURN 单独放 `turnServers`：

```yaml
iceServers:
  - urls: ['stun:stun.l.google.com:19302']
turnServers:
  - urls: ['turn:w2m:<secret>@43.142.74.71:3479']
  - urls: ['turn:w2m:<secret>@134.175.243.146:3479']
turnPolicy: balanced
```

`turnPolicy`：

- `balanced`（默认）：按 pair 选主，主节点排第一，其他节点保留为 fallback；
- `primary`：只给该 pair 的主节点，硬 pin，失败时不自动换节点。

选主是确定性的：`sha256(sorted(localId, peerId) + serverKey)` 做加权 rendezvous
（权重为 1 时均匀分布）。排序后两端得到同一顺序，因此不会出现 A 选 turn-a、B 选 turn-b
的双重中继。不同 pair 的主节点不同，整体呈 active/active。

## 3. 部署

```bash
# 在目标 TURN 主机上，以 root 执行
sudo TURN_EXTERNAL_IP=134.175.243.146 \
     TURN_PRIVATE_IP=192.168.0.5 \
     TURN_SECRET='<same-secret>' \
     TURN_NAME=w2m-turn-2 \
     ./deploy/server/deploy-turn.sh
```

脚本会安装 coturn、写 `/etc/turnserver.conf`、启动并 enable。重复执行是幂等的。

## 4. 验收

从每台物理机分别对两台 TURN 做 relay-only Allocate：

```bash
npm run turn:probe -- \
  --provider-cwd "$HOME/w2m-webrtc-provider" \
  --turn "turn:w2m:<secret>@43.142.74.71:3479,turn:w2m:<secret>@134.175.243.146:3479" \
  --out .matrix/p7-physical/turn-allocate-dual-<host>.json
```

通过条件：每台 TURN 都返回至少一个 `typ relay` candidate，且 candidate 的地址是该节点的
公网 IP、端口落在 relay 池内。只有 `host`/`srflx` candidate 不算通过。

已有证据（三台物理机，均为 `turn:probe` 的 relay-only Allocate）：

- Mac：`.matrix/p7-physical/turn-allocate-dual-mac.json`，turn-a `49189`、turn-b `49171`；
  审计复测 `.matrix/p7-physical/turn-allocate-dual-mac-live.json`
  （`2026-11-24T08:10:11Z`），turn-a `49194`、turn-b `49192`，两台均 `typ relay`。
- HSD：`C:\Users\AU\w2m-p7\.matrix\p7-physical\hsd-turn-allocate-dual.json`，
  turn-a `49165`、turn-b `49194`，两台均 `typ relay`。
- TOFUTURE：`E:\DB\W2M\.matrix\p7-physical\tofuture-turn-allocate-dual.json`，
  turn-a `49172`、turn-b `49195`，两台均 `typ relay`。

数据面验收仍要看 `path=relay`：`PathSelector` 的 `relay` verdict 来自选中 candidate 的
local/remote `type === 'relay'`，不是 W2M relay 回退。`turn:probe` 只证明 Allocate 成功，
不证明 100 MiB 传输走了哪台 TURN。

## 5. 边界

- 不做 DNS 轮询、不做四层 VIP、不做 TURN 间级联；负载按 pair 分布，不做严格的 50/50。
- 选主只影响候选顺序，ICE 仍可因网络条件选择另一台；fallback 是候选集合，不是应用层重试。
- 任何“同机多进程、Cloudflare tunnel `/health`、本地 Teams V2 done”都不能替代真实
  `typ relay` 候选和跨物理机数据面。
