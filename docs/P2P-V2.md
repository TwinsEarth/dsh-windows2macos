# P2P V2 操作者指南（`dsh-p2p-v2`）

状态：随 `@twinsearth/w2m-dsh-plugin@3.7.1` 发布
适用：需要在一组已互信的 W2M 机器之间分发大文件的场景
设计依据：`docs/design/P2P-V2-WEBTORRENT.md`

## 1. 它做什么、不做什么

`dsh-p2p-v2` 是一个**文件面**子插件：WebTorrent 负责分片与多 peer 调度，`webrtc-v1` 共享 pool 负责 peer 之间的加密字节通道。

- 做：一个 seed 对多个 leecher、多个 seed 对同一文件、断点续传、每 share 的 peer 增删、下载配额与 staging。
- 不做：不替换任务分发，不新建第二个调度器，不把文件字节走 relay，不做公共 tracker/DHT 发现，不自动接受远程写入。
- 任务分发、Teams、远程桌面仍走原来的 `dsh-p2p-webrtc` 共享 pool；V2 只借用，不拥有也不关闭 pair。

V2 默认关闭。启用它是两步：给宿主一个 WebTorrent 引擎，再把 `dsh-p2p-v2` 行打开。

## 2. 安装

### 2.1 安装插件

```bash
dsh plugin add @twinsearth/w2m-dsh-plugin
```

确认 profile 的 bundle 列表包含包名（没有进 bundle 的包永远不会加载）：

```yaml
# ~/.dsh/profiles/<profile>/dsh.profile.yml
plugins:
  - '@twinsearth/w2m-dsh-plugin'
```

包本身仍然零运行时依赖：**不要把 `webtorrent` 加进本包的 `dependencies`**。引擎是操作者资产。

### 2.2 准备 WebTorrent 引擎

推荐把引擎装在插件之外的固定目录，并把 row 指向入口文件，避免宿主解析路径不确定：

```bash
npm install --prefix /opt/w2m-webtorrent webtorrent@3.0.21
# 入口：/opt/w2m-webtorrent/node_modules/webtorrent/index.js
```

也可以让宿主自己解析：

```yaml
webTorrentModule: 'webtorrent'
```

缺引擎不会让插件挂载失败：`p2p_v2_status` 会显示 `engine.available:false`，`share`/`add` 返回 `P2P_V2_WEBTORRENT_UNAVAILABLE`。这是命名拒绝，不是静默空 torrent。

### 2.3 在生产 profile 显式启用

`cordis.patch.yml` 里的 `dsh-p2p-v2` 行默认 `disabled: true`。生产 profile 覆盖该行并打开：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: dsh-p2p-v2
  disabled: false
  config:
    webTorrentModule: '/opt/w2m-webtorrent/node_modules/webtorrent/index.js'
    stateDir: '/var/lib/w2m/p2p-v2'
    downloadRoot: '/var/lib/w2m/p2p-v2/downloads'
    allowedRoots:
      - '/srv/w2m-share'
      - '/var/lib/w2m/p2p-v2/downloads'
    trackers: []
    allowNativeTrackers: false
```

保留默认关闭的 row 是有意的：升级包不会在没有操作者同意时悄悄打开文件写入面。

## 3. 配置

| 键 | 默认 | 作用 |
|---|---|---|
| `webTorrentModule` | `'webtorrent'` | 宿主解析名，或指向外部安装的绝对入口 |
| `stateDir` | `<DSH_HOME>/p2p-v2` | `shares.json` 与默认下载根 |
| `downloadRoot` | `<stateDir>/downloads` | 未给 `path` 时的下载目录 |
| `allowedRoots` | `[]` | 额外允许根；默认仍含用户目录、项目 cwd、tmpdir、downloadRoot |
| `trackers` | `[]` | 仅 `allowNativeTrackers:true` 时发布 |
| `allowNativeTrackers` | `false` | 打开公共 tracker；不同隐私合同，慎用 |
| `maxShares` | `8` | 同时存在的 share 上限 |
| `maxPeersPerShare` | `16` | 单 share 的逻辑 peer 上限 |
| `maxConns` | `32` | 共享 pool 连接上限 |
| `maxFileBytes` | `10737418240` | 单文件上限（10 GiB） |
| `maxDownloadBytes` | `10737418240` | 单次下载总量上限（10 GiB） |
| `maxFramesPerSecond` | `2048` | 诊断阈值，不主动丢帧 |
| `maxBufferedBytes` | `4194304` | 背压诊断阈值（4 MiB） |
| `readyTimeoutMs` | `30000` | 等 torrent ready 的预算 |
| `metadataTimeoutMs` | `10000` | 等 info hash / metadata 的预算 |
| `writeTimeoutMs` | `15000` | 单次 adapter 写入超时 |

所有路径在 service 层再做一次敏感路径、允许根与 `realpath` 检查；直接调用 service 不能绕过。

## 4. 最短示例：一台发、一台收

设 A 的 machine id 为 `machine-a`，B 为 `machine-b`。先确认两边都在线：

```json
{"tool":"w2m_devices","args":{}}
```

A 上种子一个文件，只允许 B 拉取：

```json
{"tool":"p2p_v2_share","args":{
  "path":"/srv/w2m-share/model.bin",
  "peers":["machine-b"],
  "confirm":"share"
}}
```

返回里有 `magnet`、`info_hash`、`share_id`。把 `magnet` 交给 B：

```json
{"tool":"p2p_v2_add","args":{
  "magnet":"magnet:?xt=urn:btih:<info_hash>&dn=model.bin",
  "path":"/var/lib/w2m/p2p-v2/downloads/model",
  "peers":["machine-a"],
  "confirm":"add"
}}
```

`add` 在 metadata 就绪后就返回，不等待整个文件完成；用 `p2p_v2_status` 看进度：

```json
{"tool":"p2p_v2_status","args":{"share_id":"<share_id>"}}
```

关注字段：`state`、`progress`、`peer_count`、`seeders`、`leechers`、`bytes_in/out`、`storage`、`backpressure`、`finalized`、`last_error`。

## 5. 多 peer 编排

### 一个 seed 对两个 leecher

A 上：

```json
{"tool":"p2p_v2_share","args":{
  "path":"/srv/w2m-share/model.bin",
  "peers":["machine-b","machine-c"],
  "confirm":"share"
}}
```

B、C 各自用同一个 magnet 执行 `p2p_v2_add`，`peers` 都指向 `machine-a`。每个 peer 独立成败：某一个连不上只写进 `peer_errors`，其他继续。

### 两个 seed 提供同一文件

B 也种同一文件：

```json
{"tool":"p2p_v2_share","args":{
  "path":"/srv/w2m-share/model.bin",
  "peers":["machine-c"],
  "confirm":"share"
}}
```

C 下载时可以把两个 seed 都放进 `peers`：

```json
{"tool":"p2p_v2_add","args":{
  "magnet":"magnet:?xt=urn:btih:<info_hash>",
  "peers":["machine-a","machine-b"],
  "confirm":"add"
}}
```

限制：真实 provider 的 P5 矩阵验证了 2 seed + 2 leecher 的确定性编排，但**单个 leecher 同时从两个真实 seed 拉取同一 torrent 的真实 swarm 仍未验收**；生产使用多 seed 前请先在自己的网络做小文件演练。

### 增删 peer

```json
{"tool":"p2p_v2_attach","args":{"share_id":"<share_id>","machine":"machine-d"}}
{"tool":"p2p_v2_detach","args":{"share_id":"<share_id>","machine":"machine-d"}}
```

`attach` 按 `(share_id, machine)` 幂等，超过 `maxPeersPerShare` 命名拒绝；`detach` 只移除逻辑流，不关闭 V1 pair，其他 torrent、任务分发、远程桌面不受影响。

## 6. 配额、断点续传与停止

- 下载先写目标同卷 `.w2m-partial-<infoHash>`，`done` 后校验并 rename/merge 到目标目录。目标目录不会出现半文件。
- 单文件超 `maxFileBytes` 返回 `P2P_V2_FILE_TOO_LARGE` 并销毁 torrent；总量超 `maxDownloadBytes` 或卷空间不足返回 `P2P_V2_QUOTA_EXCEEDED` / `P2P_V2_DISK_FULL`。
- 停止一个 share：

```json
{"tool":"p2p_v2_stop","args":{"share_id":"<share_id>"}}
```

`stop` 销毁 torrent 和 adapter、删除 share 记录，但**保留 staging**。进程重启后 `p2p_v2_status` 的 `restore` 只给出候选，不会自动下载；再次 `add` 同一 magnet 会复用 staging 继续，只追加缺失 piece。

`stopAll` 才会销毁 WebTorrent client 并退订共享 pool；它不清除已下载文件，也不停止 pool。

## 7. 回滚

回滚到 V1 任务分发只需要一步：把生产 profile 的 `dsh-p2p-v2` 行改回 `disabled: true`，重启 DSH。

```yaml
- id: dsh-p2p-v2
  disabled: true
```

回滚口径：

- V2 不修改 V1 配置；禁用 V2 不影响 `dsh-p2p-webrtc`、任务分发、Teams 或远程桌面。
- 不回滚共享 pool，不调用 `closePeer()`；已经在跑的任务连接不会被拆掉。
- 已下载文件不被删除；恢复后不再续传，只是停止 torrent。需要保留的 staging 由操作者自行清理。
- `shares.json` 保留的是元数据，禁用后不再加载为活动 share。

## 8. 故障排查

| 现象 | 先查 | 处理 |
|---|---|---|
| `P2P_V2_WEBTORRENT_UNAVAILABLE` | `p2p_v2_status.engine`、`webTorrentModule` | 安装引擎或改成绝对入口；重启 DSH |
| `P2P_V2_POOL_UNAVAILABLE` | `dsh-p2p-webrtc` 行、`w2m_devices` | 先修 V1 pool；V2 不尝试 relay 搬文件 |
| `P2P_V2_PEER_UNREACHABLE` | 目标是否在线、machine id 是否写错、NAT/防火墙 | 换 peer 或先做 V1 连通性检查；其他 peer 不受影响 |
| `P2P_V2_PEERS_UNREACHABLE` | `peer_errors` | 全部 peer 都失败，torrent 已销毁；修正后重试 |
| `P2P_V2_TORRENT_READY_TIMEOUT` | seed 是否 attach、magnet 是否含正确 btih | torrent 保留，可后补 `p2p_v2_attach` |
| `P2P_V2_QUOTA_EXCEEDED` | `maxDownloadBytes`、卷剩余 | 清理或调大配额；不会发布半文件 |
| `finalized:false` | `finalize_error`、staging 完整性 | 保留 staging，修正后显式恢复；目标目录不出现半文件 |
| 进度不动 | `peer_count`、`bytes_in/out`、`backpressure` | 确认目标端 `add` 的 `peers` 指向 seed；检查 4 MiB 帧上限与写入超时 |

## 9. 安全边界

- 默认无公共 announce：`trackers:[]`、`allowNativeTrackers:false`，info hash 不离开编队。
- magnet 只返回给调用方，由调用方决定发给谁；V2 没有自动 offer/accept。
- V2 帧穿过 V1 Noise 通道；relay 只做认证、租约与控制面，不见文件字节。
- 文件写入必须 `confirm:"add"`；share 必须 `confirm:"share"`，且在创建目录、加载引擎之前检查。
- 敏感路径、允许根外路径、symlink 逃逸按命名错误拒绝。
