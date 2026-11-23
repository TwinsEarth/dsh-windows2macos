# P2P V2：WebTorrent 文件面 + V1 WebRTC 传输层

状态：设计冻结，按本文件实现
适用范围：`@twinsearth/w2m-dsh-plugin/dsh-p2p-v2`，复用 `@twinsearth/w2m-dsh-plugin/dsh-p2p-webrtc` 的共享 pool
版本：新增子插件 `dsh-p2p-v2`；package 版本由发布窗口决定，本文件不预判

## 1. 裁决

V2 **不替换 V1，也不新建第二个调度器**：

```text
任务分发 / 结果 / Teams / 远程桌面  -> 仍走 webrtc-v1 共享 pool 的 JSON 控制面
多对多文件分发                     -> WebTorrent 管分片，webrtc-v1 管 peer 字节
```

- 任务分发继续由 `w2m_run` 的 `pushOfferBestPath` 优先走 `webrtc-v1`；V2 只读取同一个 pool，不注册新的 dispatch 工具。
- WebTorrent 是文件分片引擎；它的 peer 流不是浏览器原生 `simple-peer`，而是一个包在 V1 pair 上的 Duplex 适配器。WebTorrent 看到的仍是标准 BitTorrent wire，V1 看到的是带标签的二进制帧。
- `transport` 为 `auto`/`webrtc`/`relay` 的语义不变；V2 文件字节**不经过 relay**。relay 仍只是认证、租约和控制面。
- WebTorrent 默认不启用公共 tracker、DHT、LSD、uTP、UPnP、NAT-PMP。只连调用方显式给出的编队 machine id；打开 `allowNativeTrackers` 才会发布到 `trackers`，这是不同的隐私合同。
- V2 行与 V1 行一样 `disabled: true`。启用需要两步：装/指向 WebTorrent 引擎，并把 row 打开。缺引擎时 mount 仍然成功，操作返回 `P2P_V2_WEBTORRENT_UNAVAILABLE`。

## 2. 为什么需要一条带标签的复用通道

`webrtc-v1` 的 `onMessage` 是**按 pair 广播**的，不是按消费者定向：

| 消费者 | 帧形态 |
|---|---|
| `deliver.mjs` | JSON：`task.offer` / `result.ack` / `view.*` |
| `teams/data-plane` | JSON：`team.artifact.chunk` / ack |
| `remote-view-route` | JSON：`view.hello` / `view.frame` |
| V2 WebTorrent | 二进制 BitTorrent wire |

如果 V2 直接发送裸 BitTorrent 字节，`deliver.mjs` 会对每个 chunk 尝试 `JSON.parse` 并打一条 warning。解决方案不是再开一条 DataChannel（那会破坏“一个 peer 一个 pool pair”的复用和远程桌面/Teams 的共享生命周期），而是在应用层加一个**只属于 V2 的帧标签**：

```text
magic "W2MT2\0" (6B) | info hash (20B, hex-decoded) | BitTorrent wire chunk
```

- JSON 帧首字节是 `{`，不可能与 magic 冲突。
- 生产者按 `info hash` 打标签；消费者按 `peer + info hash` 路由到对应的 torrent adapter。
- 同一个 peer 可以同时参与多个 torrent；每条 torrent 有自己的逻辑 Duplex，底层仍是同一个 V1 pair。
- `deliver.mjs` 在解析 JSON 前调用 `isTorrentFrame()`，命中即静默跳过；Teams / view 的非 JSON 路径本来就返回，不需要改动。

## 3. 组件与不变式

```text
P2PV2Service
  ├─ optional WebTorrent client (lazy dynamic import / injected factory)
  ├─ transportRegistry.get(name) -> definition.create({pool}) -> binding
  ├─ shares: Map<share_id, record>            // one torrent
  ├─ byInfoHash: Map<info_hash, record>
  ├─ adapters: Map<peer\0info_hash, Duplex>   // one logical peer stream
  └─ binding.onMessage -> decodeTorrentFrame -> adapter.feed
```

### 3.1 传输注册表（P1）

`src/agent/webtorrent/transports/registry.mjs` 把“传输定义”和“某次进程内的具体绑定”分开：

- `registerTorrentTransport(name, transport)` 注册 `{name, create({pool})}` 定义；同名的后注册覆盖前一条。
- `getTorrentTransport(name)` 查找定义；未知名字抛出带 `code: P2P_V2_TRANSPORT_UNKNOWN` 的命名错误，不回落到默认。
- 内置注册 `webrtc-v1`。`src/agent/webtorrent/transports/webrtc-v1.mjs#createWebRtcV1Transport({pool})` 只包装 `pool.ensure/send/onMessage`，`destroy()` 只退订自己的 handler，绝不调用 `pool.closePeer()` 或 `pool.stop()`。
- `share`/`add`/`attach` 都接受 `transport` 参数，缺省 `webrtc-v1`；share 记录保存该名字，后续 attach 缺省沿用 share 的传输。
- 同一进程可以注册 fake transport 做确定性测试；服务只从 `transportRegistry` 取定义，不直接对 pool 发字节。
- `multiplex.mjs` 不感知传输：帧标签仍是 `magic | info hash | chunk`，任何 transport 都只搬运带标签的 Buffer。

不变式：

1. **不拥有 pool**。V2 只 `getSharedWebRtcPool()`；`stop`/`detach` 只销毁 adapter，绝不 `closePeer`。
2. **惰性引擎**。mount 不 import WebTorrent、不 hash、不打开端口；`share` / `add` 才加载。
3. **先 infoHash 后 peer**。磁力链的 `add()` 必须先等 `infoHash` 事件再 `addPeer`；在 `ready` 前 attach，才能从 trackerless magnet 取到 metadata。
4. **默认无公共发现**。`tracker:false, dht:false, lsd:false, utp:false, natUpnp:false, natPmp:false`。
5. **失败命名**。`P2P_V2_POOL_UNAVAILABLE` / `P2P_V2_WEBTORRENT_UNAVAILABLE` / `P2P_V2_PEER_UNREACHABLE` / `P2P_V2_TORRENT_READY_TIMEOUT` 等，不把缺失引擎伪装成空 torrent。
6. **文件写入需要确认**。`p2p_v2_add` 的 `confirm:"add"` 在创建目录、加载引擎之前检查；`p2p_v2_share` 同理。

## 4. 工具面

| 工具 | 作用 | 关键约束 |
|---|---|---|
| `p2p_v2_status` | 引擎、share、peer、进度、swarm 计数、pool 状态 | 只读；不加载引擎；含 `transport`/`peer_count`/`seeders`/`leechers` |
| `p2p_v2_peers` | 已连接的 pool peer + 各 share 的 attach 状态 | 只读；不 dial；不返回 signal URL/token |
| `p2p_v2_share` | 种子一个文件/目录，返回 magnet | `confirm:"share"`；敏感路径拒绝；`peers` 数组逐个 attach |
| `p2p_v2_add` | 从 magnet 下载到目录 | `confirm:"add"`；先 infoHash 再 attach；`peers` 可含多个 seeder |
| `p2p_v2_attach` | 给一个 share 增加 V1 peer | 幂等 per (share, machine)；达到 `maxPeersPerShare` 拒绝；不 closePeer |
| `p2p_v2_detach` | 移除一个逻辑 peer 流 | 保留 V1 pair |
| `p2p_v2_stop` | 停一个 share / 全部 | 销毁 torrent；不停止 pool |

多对多不是“自动发现”：`share`/`add` 的 `peers` 是机器 id 数组，按集合去重、逐项 attach，本机 id 直接拒绝；`p2p_v2_peers` 只展示已经连上的 pair，不发起 dial。单个 peer 失败只记入 `peer_errors`，不阻断其他 peer；`add` 的全部 peer 都失败时返回 `P2P_V2_PEERS_UNREACHABLE` 并销毁刚建的 torrent。

## 5. 生命周期

### 5.1 seed

```text
p2p_v2_share(path, peers)
  -> path 存在性/类型检查
  -> 同路径已有 seed 记录：复用
  -> ensureClient()
  -> client.seed(path) 等待 seed callback
  -> record share
  -> peers 去重、逐个 attach：pool.ensure(machine) -> adapter -> torrent.addPeer
  -> 单个失败记入 peer_errors，share 仍成功
```

### 5.2 download

```text
p2p_v2_add(magnet, dest, peers)
  -> 目录创建/类型检查
  -> client.add(magnet) 返回 torrent
  -> 等 infoHash 事件
  -> record share
  -> peers 去重、逐个 attach（在 ready 之前）
  -> 全部失败：销毁 torrent + P2P_V2_PEERS_UNREACHABLE
  -> 部分成功：继续有界等待 ready；返回 metadata_ready，不等待整个文件完成
```

### 5.3 attach / stop

- `attach`：`pool.ensure` 失败 -> `P2P_V2_PEER_UNREACHABLE`；`torrent.addPeer` 失败 -> `P2P_V2_TORRENT_PEER_FAILED`；成功后 adapter 加入 `peer\0infoHash` 路由表。
- `detach`：`torrent.removePeer(machine)` + adapter.destroy；V1 pair 保留。
- `stop`：adapter 全销毁 -> 路由表清理 -> `torrent.destroy()`；share 记录删除；`stopAll` 才 `client.destroy()` 和退订 pool。

## 6. 失败矩阵

| 条件 | 结果 |
|---|---|
| `webtorrent` 未安装/入口不存在 | `P2P_V2_WEBTORRENT_UNAVAILABLE`；mount 正常 |
| WebTorrent 构造失败 | `P2P_V2_WEBTORRENT_INVALID` / `P2P_V2_WEBTORRENT_LOAD_FAILED` |
| pool 未启动 | `P2P_V2_POOL_UNAVAILABLE`；不尝试 relay 文件搬运 |
| `pool.ensure` 失败 | `P2P_V2_PEER_UNREACHABLE`，保留 `pool_code`；其他 peer 继续 |
| `add` 的每个 peer 都失败 | `P2P_V2_PEERS_UNREACHABLE`；刚建的 torrent 被销毁，不留空 share |
| magnet 无 metadata 且 peer 未连上 | `metadata_ready:false` + `P2P_V2_TORRENT_READY_TIMEOUT`；torrent 仍保留，可后补 attach |
| 同路径重复 share | `reused:true`，不重复 seed |
| 重复 add 同 info hash | `reused:true` |
| peer 超限/share 超限 | 命名拒绝，不静默淘汰 |
| 适配器写入超时 | `P2P_V2_SEND_TIMEOUT`；torrent peer 失败，pool 不关闭 |

## 7. 安全与隐私

- 文件路径由操作员显式给出；`p2p_v2_share`/`add` 先过 `sensitiveMatch`，`.ssh`、`.env`、私钥等直接拒绝。
- 默认没有公共 announce，info hash 不离开编队；magnet 只返回给调用方，由调用方决定发给谁。
- V2 帧经过 V1 Noise 通道；BitTorrent 的 wire 是内层协议，不额外暴露明文。
- `stop` 不关闭共享 pair，避免把任务分发、远程桌面、Teams 数据面一起拆掉。
- 文件写入需要 `confirm:"add"`；不实现目标端自动接受远程 offer。

## 8. 测试矩阵

| 层 | 证据 |
|---|---|
| 字节标签 | `test/p2p-v2.test.mjs` round-trip、坏 hash、空 chunk、JSON 不命中 |
| 传输抽象 | 注册表默认 `webrtc-v1`、未知名字命名拒绝；fake transport 上的同一 adapter 收发；V1 binding destroy 不关闭 pool/pair |
| 多 peer 编排 | `test/p2p-v2.test.mjs`：1 seed + 2 leecher、2 seed + 2 leecher、单 peer 失败其余成功、全部失败聚合、peer 上限/重复 attach、`p2p_v2_peers` 只读无 dial、同一 V1 pair 上任务 JSON 与 torrent 帧并发 |
| service | seed 真实临时文件、add 先 infoHash 后 attach、detach/stop 不 closePeer、缺引擎命名、share 复用/上限 |
| 接线 | package export、lib seam、cordis row disabled、7 工具 inert mount、confirm 拒绝 |
| 真实 WebTorrent | `test/p2p-v2-live.mjs`：两个真实 pool + 真实 signaling/Noise + 真实 WebTorrent，传输 256 KiB 文件并比对字节；用 `W2M_WEBTORRENT_MODULE` 指定外部引擎，默认 suite 不依赖 |

## 9. 落地边界

- 不新增 package runtime dependency；WebTorrent 只能通过外部入口或注入工厂。
- 不自动接受远程文件写入；没有 `offer` 协议。
- 不做公共 swarm / tracker 浏览器；`allowNativeTrackers` 是显式 opt-in。
- 不在本版做 fleet roster 自动发现、断点续传恢复、Teams artifact 迁移；这些需要单独的授权与验收。
