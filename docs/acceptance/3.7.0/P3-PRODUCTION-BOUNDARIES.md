# P3 验收：服务生命周期与生产边界

日期：2026-11-24  
分支：`work/v3.7.0-v2-baseline`  
代码基线：`0aec4af`（P2 多 peer 编排）

## 目标

把 V2 从“可跑通的文件分发”收紧为可长期运行的本地服务：share/add 的路径、可读性、symlink、敏感路径和允许根全部有明确判定；下载默认落到固定目录，经 staging + 原子 rename 才发布；下载有单文件和总量上限；share metadata 可持久化并在重启后以显式 `add` 恢复；帧与队列有诊断指标；V2 帧上限统一为 4 MiB（含 header）。

## 实现

### 路径与 share

- 新增 `src/agent/webtorrent/path-safety.mjs`：
  - 与 `src/plugin/path-policy.mjs` 同语义的 `sensitiveMatch`（`.ssh`/`.aws`/`.gnupg`/`.kube`/`.docker`/`credentials`、`.env`/`id_rsa`/`wallet.dat` 等、`.pem`/`.key`/`.p12`/`.kdbx` 等扩展名）。
  - `canonicalKey`、`inside`、`realpathPrefix`：对最长已存在前缀做 realpath，再把不存在的尾段词法拼接；因此 symlink 解析后仍按真实路径检查允许根。
  - `checkPathScope` 返回 `PATH_OUTSIDE_ROOT`、`PATH_NOT_FOUND`、`PATH_NOT_READABLE`、`SENSITIVE_PATH` 等稳定码，不依赖插件层。
- `service.share`：
  - 先过 service 自己的 sensitive + 允许根检查，再检查存在性、类型、`R_OK`；目录额外 `readdirSync` 验证可读。
  - 默认允许根：用户目录、`tmpdir()`、项目 cwd、`download_root`；显式 `allowedRoots` 时仍把 `download_root` 加入，保证默认下载目录可用。
  - 同路径 seed 幂等：记录 `source_key`（realpath canonical key），symlink 与真实路径指向同一目标时复用；兼容旧记录的 `input_path` 词法比较。
  - 单文件超过 `max_file_bytes` 时在 seed 前拒绝 `P2P_V2_FILE_TOO_LARGE`。

### add、staging 与配额

- `path` 可选：
  - 缺省为 `<download_root>/<infoHash>`；`download_root` 缺省 `<state_dir>/downloads`。
  - 有持久化的下载记录时优先复用其 `download_path`/`staging_path`，便于显式恢复；仍重新过允许根与敏感检查。
  - 明确给出 `path` 时必须在允许根内，且是已存在或可创建的目录；文件占位返回 `P2P_V2_DEST_INVALID`。
- staging：
  - 单文件/多文件都先写入目标同卷 sibling `.w2m-partial-<infoHash>`（无 hash 的 torrent file 使用进程级临时名），目标目录只创建空壳，不接收半文件。
  - `torrent.done` 后检查每个 `torrent.files` 的 staging 文件大小 ≥ 声明长度，再逐项 `renameSync` 到目标；目录优先整体 rename，已存在时递归合并。完成后删除 staging。
  - 校验失败保留 staging 供显式重试；`status` 显示 `finalized:false` 和 `finalize_error`，不会把 `done` 报成 true。
  - `torrent.files[].path` 必须是 staging 内相对路径；绝对路径、盘符或 `..` 直接 `P2P_V2_FINALIZE_FAILED`，防止恶意 metadata 越界。
- 上限：
  - `max_file_bytes` 默认 10 GiB；`max_download_bytes` 默认 10 GiB。
  - add 在 `infoHash` 后和 `ready` 后各检查一次；单文件超限 `P2P_V2_FILE_TOO_LARGE`，总量超限 `P2P_V2_QUOTA_EXCEEDED`，staging 卷可用空间不足 `P2P_V2_DISK_FULL`。
  - 失败会销毁本次 torrent 并删除 staging，不留下半文件。
  - magnet 无 40-hex btih 在加载引擎前返回 `P2P_V2_MAGNET_INVALID`；解析出的 hash 与 magnet 不一致同样拒绝。

### 状态与恢复

- `<state_dir>/shares.json` 原子写入 share metadata：`share_id`、`info_hash`、`name`、`mode`、`transport`、`input_path`、`source_key`、`download_path`、`staging_path`、`peers`、`created_at`。
- attach/detach/stop 后重写；写失败只记 `P2P_V2_STATE_WRITE_FAILED`，不破坏在线 share。
- 构造时读取 metadata 到 `status.restore.shares`，**不自动重新下载**；恢复策略固定 `explicit_add`，调用方必须显式 `add` 同一 magnet。
- `stopAll` 清空活动记录和 restore 候选并落盘。

### 帧、背压与指标

- `TORRENT_FRAME_MAX_CHUNK_BYTES = 4 MiB - TORRENT_FRAME_HEADER_BYTES`（header 26 字节）；`TORRENT_ADAPTER_MAX_WRITE_BYTES` 直接复用该常量，不再保留 4 MiB - 128 的第二套上限。
- `peer-adapter` 新增 `onWrite(bytes)`，service 在 transport.send 成功后累加 `frames_out`/`bytes_out`；入站继续累加 `frames_in`/`bytes_in`，未知/过期路由计入 `orphan_frames`。
- `status.backpressure`：`write_timeout_ms`、`ready_timeout_ms`、`metadata_timeout_ms`、`max_frames_per_second`、`max_buffered_bytes`、当前 `buffered_bytes`、当前窗口 `frames_per_second_in/out` 和上一窗口 `last_window`。
- `status.storage`：`download_root`、`allowed_roots`、`max_file_bytes`、`max_download_bytes`；`status.state` 给出 metadata 路径和错误码。
- `last_error` 统一带 `code`；错误详情只包含路径/文件名/长度/引擎消息，不打印文件内容。

## 测试

| 证据 | 结果 |
|---|---|
| `node --test --test-force-exit test/p2p-v2.test.mjs` | **34/34，0 fail，0 skip** |
| `test/p2p-v2-live.mjs`（真实 WebTorrent 3.0.21，2 节点） | **1/1，0 fail** |
| `test:p2p-webrtc` | 87/87，0 fail |
| `test:teams` | 39/39，0 fail |
| remote-view 三套件 | 24/24，0 fail |
| `test/claims.test.mjs` | 47 pass / 0 fail / 1 skip（48 tests，重打包后） |
| `test:tools-surface` | 3/3，0 fail |
| `test/acceptance-doc.test.mjs` | 6/6，0 fail |
| `npm run layer-check` | clean |
| 改动文件 ESLint（`--no-cache`） | 0 error / 0 warning |

P3 新增用例：

1. source 在允许根外：`P2P_V2_PATH_OUTSIDE_ROOT`，不加载引擎。
2. symlink/junction 指向允许根外：realpath 解析后仍拒绝。
3. service 层 sensitive 底线：插件 guard 被绕过时 `.ssh` 仍返回 `P2P_V2_SENSITIVE_PATH`。
4. add 缺省 path：落到 `<download_root>/<infoHash>`；未完成时目标为空，staging 有文件。
5. 完成后原子发布：staging 文件移入目标，staging 删除，`done:true`。
6. 单文件超限和总量超限分别返回 `P2P_V2_FILE_TOO_LARGE` / `P2P_V2_QUOTA_EXCEEDED`，staging 不残留。
7. 坏 magnet 在加载引擎前拒绝；magnet hash 与解析 hash 不一致拒绝并销毁 torrent。
8. metadata 超时返回 `P2P_V2_TORRENT_METADATA_TIMEOUT` 并保留 staging 路径。
9. 半文件：staging 512/1024 时目标不出现文件，`finalized:false`；补齐 1024 后恢复发布。
10. 重启候选：新 service 读到 `restore.count=1`，`shares=[]`，不自动下载。
11. 帧上限边界：`4 MiB` 帧可编码，`4 MiB + 1` 被拒绝。
12. 指标：adapter 写入后 `frames_out`/`bytes_out` 累加，`backpressure` 字段可读。

日志：`.matrix/baseline-370/p3-*.log`。

## 已知边界

- 真实 WebTorrent 的 live 证据仍为 2 节点；3 节点同进程会触发 native OOM/访问冲突，未纳入稳定套件。
- 物理磁盘配额是 best-effort：`statfsSync` 不可用时只保留配置上限，不会阻止写入。
- 多文件最终发布按 entry 逐个 rename；同卷单文件是原子 rename，多文件不是整棵树的单次原子操作。若中途失败，已移动的文件都是完整文件，剩余文件留在 staging。
- 重启恢复只复用 WebTorrent 自己的 partial 文件和 V2 的稳定 staging 名；没有自动重新 add、没有后台守护。
- `max_frames_per_second`/`max_buffered_bytes` 当前是诊断阈值，不主动丢弃帧；4 MiB 协议上限不变。

## 结论

P3 完成：share/add 的路径安全、默认落盘、staging + 原子发布、配额与单文件上限、metadata 持久化、显式恢复、背压诊断、统一帧上限和指标均已落地；P0/P1/P2 的 peer 编排与 V1 pair 所有权未被改变。
