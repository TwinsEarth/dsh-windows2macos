# 文件传输与分块层（Transfer Layer）

状态：实现已存在（v2.0.8），本文固化契约；跨机链路仍受 P2P 握手/传输可靠性阻塞。
代码：`src/agent/transfer/{manifest,object-store,reference,ferry,want-block,publish}.mjs`
测试：`test/xfer-{foundation,ferry,publish,want-block}.test.mjs`

## 1. 分层

```
Content Addressing   manifest + rootCid + ArtifactRef
Chunk Store          分块文件、bitmap、原子 finalize
Transfer Session     want/chunk 窗口、逐块校验、续传
Delivery / Sink      dir / git / ssh，artifact_ready
Transport            P2P（UDP/iroh 可替换），relay 永不承载字节
```

## 2. 内容寻址

- 每块：`chunkHash[i] = SHA-256(chunkBytes[i])`；
- 根：对“有序块摘要 + 块数 + 总大小 + 版本标签”做域分离哈希，得到 `rootCid = "sha256:<hex>"`；
- `ArtifactRef v2` 至少包含：
  ```json
  { "rootCid", "size", "chunkCount", "chunkBytes",
    "originPeer", "sinkHint", "createdAt", "version": 2 }
  ```
- 读取端只接受 `verifyRefV2(ref)` 通过的引用；根不一致即拒绝，不做“尽力修复”。

## 3. 原语契约

### chunkFile(path, { chunkBytes })

- 输出 `{ ok, rootCid, size, chunkCount, chunkBytes, chunks[] }`；
- `chunkBytes` 默认 256 KiB，最小 16 KiB，最大 2 MiB；
- 分块读取，不一次性载入整个文件；
- 空文件/短读/权限错误返回具名错误码。

### createReceiver({ stateDir, sinkRoot, ref, destination })

- 建立 `<stateDir>/<transferId>/data.part` 与 `bitmap.json`；
- `destination` 必须经 `safeRelative` 校验，拒绝 `..`、绝对路径、盘符、NUL；
- 恢复时读取 bitmap，只请求缺失块。

### writeChunk(index, data, expectedSha256)

- 先校验 `index` 范围、`data.length`、`SHA-256(data) == expected`，全部通过才写入；
- 写 `data.part` 对应 offset，随后原子更新 bitmap（temp+rename）；
- 重复块：哈希一致则幂等成功，不一致拒绝 `XFER_CHUNK_HASH_MISMATCH`；
- 不信任调用方给出的长度/哈希。

### finalizeTransfer(rootCid)

- 要求 bitmap 全满；
- 重算根（不信任 bitmap），与 `ref.rootCid` 比较；
- `fsync` 数据与目录，`rename` 到最终路径（同目录，原子）；
- 幂等：已 finalize 且哈希一致则返回成功，不重复覆盖。

## 4. 可恢复传输

- bitmap 持久化 `<stateDir>/<transferId>/bitmap.json`，含 `chunks/chunk_bytes/last_chunk_bytes/hashes`；
- 崩溃恢复：只信任 bitmap 中标记完成且哈希复核通过的块；
- 会话状态：`transferId`、`rootCid`、已收块集合、最后错误；
- 传输中断不删除 `data.part`，由显式 abort/GC 清理；
- 同一 `rootCid` 允许多次会话，但同一 `transferId` 必须单写者（CAS/锁）。

## 5. 传输协议（want-block）

```
xfer.want   { transferId, rootCid, indices[] }     // 窗口 ≤ 8
xfer.chunk  { transferId, index, sha256, size, data }
xfer.error  { transferId, code, index? }
xfer.done   { transferId }
```

- 接收端按 bitmap 缺口发窗口请求；
- 每块独立校验，坏块只重试该块；
- 发送端不得读取/发送未请求的块；
- 流控：窗口上限 + 超时重发；irho/UDP 只替换传输，不改帧语义；
- relay 只承载 ref/元数据（publishRef），**永不承载 chunk 字节**。

## 6. 安全与限制

| 项 | 规则 |
|---|---|
| 路径 | `safeRelative`：拒绝穿越、绝对路径、盘符、保留名 |
| 大小 | 单块 ≤2 MiB；单文件上限由配置控制；防止磁盘打满 |
| 哈希 | SHA-256；算法升级需新版本标签，不静默混用 |
| 权限 | sink 目录 0600/0700；不写入 stateDir 之外 |
| 元数据 | 只发布 ref；不发布路径、token、聊天明文 |
| 拒绝 | 无效 ref/哈希/索引 → 具名错误，不重试到无限 |

## 7. 错误码（稳定面）

```
XFER_SOURCE_INVALID / XFER_ROOT_INVALID / XFER_CHUNK_INDEX_INVALID
XFER_CHUNK_LENGTH_INVALID / XFER_CHUNK_HASH_MISMATCH
XFER_WINDOW_INVALID / XFER_TRANSFER_MISMATCH / XFER_ROOT_MISMATCH
XFER_READ_SHORT / XFER_FINALIZE_INCOMPLETE / XFER_PATH_UNSAFE
XFER_CHUNK_TOO_LARGE / XFER_TIMEOUT / P2P_NO_CANDIDATES / P2P_UNREACHABLE
```

## 8. 当前实现与缺口

已实现并测试：

- chunkFile/分块校验/根计算（foundation 6/6）；
- receiver/writeChunk/bitmap/续传/穿越拒绝（ferry 6/6）；
- publishRef/listPublishedRefs（publish 3/3，真实 relay 验证）；
- want-block 窗口/逐块校验/篡改拒绝（want-block 4/4）；
- 同机 loopback 与 sender/receiver 候选探测（verified=true）。

缺口（阻塞跨机）：

1. P2P 加密握手未完成（PH-03）；
2. UDP 分片 ACK/重传（P2P_FRAGMENT_UNACKED）；
3. 跨机 sender/receiver（XF-05）需 DSH/macmini 可执行；
4. 断点续传跨机演练（XF-06）；
5. 大文件吞吐与背压（当前窗口 8 × 16 KiB 级）。

## 9. 验收

- 根与逐块哈希全部一致；
- 任意中断后重启，最终文件 SHA-256 与源一致；
- 路径穿越/篡改/错索引全部具名拒绝；
- relay 侧抓包/日志无文件字节；
- 两机 E2E：publish → want → finalize → artifact_ready；
- 性能目标（待定）：LAN 1 GiB < 60s，跨网按 P2P 传输能力单独定。

## 10. iroh-blobs / BLAKE3 评估（参考，不立即替换）

iroh-blobs 提供：BLAKE3 内容寻址、Merkle 树 verified streaming、天然断点续传、多源 want-list。
W2M 现状：SHA-256 + 扁平块哈希 + bitmap + 单源 want-block。

| 能力 | W2M 现状 | iroh-blobs | 结论 |
|---|---|---|---|
| 哈希 | SHA-256（OpenSSL/JS 可用） | BLAKE3（更快） | 不急着换；BLAKE3 需纯 JS/原生依赖 |
| 流式校验 | 逐块到达即校验 | Merkle 证明，支持部分验证 | 可后续加 Merkle，不破坏现有 ref |
| 断点续传 | bitmap 已实现 | 协议内建 | 已等价，无需替换 |
| 多源 | 单源 | 块级多 peer 并行 | 值得自研 want-list 调度，不必引入完整栈 |
| 依赖 | 零依赖 | Rust/原生绑定 | 与 tarball/Electron 约束冲突 |

建议：

1. **v2.x 保持 SHA-256 + bitmap**，不改变 ArtifactRef v2 与现有测试；
2. **v2.2.2 增加 `ArtifactRef v3`（feature flag）**：
   ```json
   { "rootCid", "hashAlg": "blake3"|"sha256", "merkleRoot",
     "chunkBytes", "chunkCount", "size", "originPeer", "version": 3 }
   ```
   双哈希过渡：v3 同时携带 `sha256Root`，旧端只读 v2，新端优先 v3；
3. **多源调度先自研**：want-list + peer 评分（时延/丢包/已成功率）+ 块租约，避免重复下载；
4. **iroh-blobs 只作为 sidecar 试验**：与 iroh 传输一起评估，不进入默认分发；
5. 验收：同一文件 v2/v3 root 可互证；中断续传 SHA-256 一致；多源重复块不重复写；无 BLAKE3 运行时回退 SHA-256 并记录 `hashAlg`。

风险：BLAKE3 在 Electron 可能同样缺原生实现（需纯 JS 回退）；Merkle 证明增加协议面；多源引入 Sybil/污染块，必须逐块哈希校验并限制来源。


- 根与逐块哈希全部一致；
- 任意中断后重启，最终文件 SHA-256 与源一致；
- 路径穿越/篡改/错索引全部具名拒绝；
- relay 侧抓包/日志无文件字节；
- 两机 E2E：publish → want → finalize → artifact_ready；
- 性能目标（待定）：LAN 1 GiB < 60s，跨网按 P2P 传输能力单独定。
