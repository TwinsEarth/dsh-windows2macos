# P6 验收：打包、发布与回滚（3.7.1）

日期：2026-11-24
分支：`work/v3.7.0-v2-baseline`
基线：P5 最终提交 `8861636`
环境：macOS（Mac mini），Node `v22.23.2`，npm `10.9.8`
结论：**P6 打包与发布准备通过**；未执行 `npm publish` / `git tag` / GitHub Release，按“发布准备完毕”交付。

## 1. 发布物

| 项 | 值 |
|---|---|
| 包名 | `@twinsearth/w2m-dsh-plugin` |
| 版本 | `3.7.1` |
| tarball | `dist/twinsearth-w2m-dsh-plugin-3.7.1.tgz` |
| 文件数 | 635 |
| 运行时依赖 | `{}`（`dependencies` 为空，无 `optionalDependencies`） |
| 校验和 | 打包完成后写入 `dist/twinsearth-w2m-dsh-plugin-3.7.1.tgz.sha256`（不随包分发） |

发布包内已确认存在：

```text
package/docs/P2P-V2.md
package/lib/p2p-v2-plugin.js
package/src/plugin/p2p-v2-plugin.mjs
```

## 2. 包契约

| 要求 | 实际 | 结果 |
|---|---|---|
| `package.json` 版本 `3.7.1` | `"version": "3.7.1"` | 通过 |
| `exports` 增加 `./dsh-p2p-v2` | `"./lib/p2p-v2-plugin.js"` | 通过（P1 已建立，P6 回归锁定） |
| `test` 含 `test/p2p-v2.test.mjs` | 已含 | 通过 |
| `test:all` 含 `test/p2p-v2.test.mjs` | 已含 | 通过 |
| 不把 `webtorrent` 加入 `dependencies` | 无 `webtorrent` 键 | 通过 |
| `webtorrent` 也不进 `optionalDependencies` | 无该键 | 通过 |

清单一致性：`package.json`、`plugin.json`、`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`codex/mcp-servers.toml` 均指向 `3.7.1`。

干净前缀安装验证：

```text
installed 3.7.1 deps {}
subpath ok dsh-p2p-v2 7 function
```

即在临时目录 `npm install` 该 tarball 后，`@twinsearth/w2m-dsh-plugin/dsh-p2p-v2` 可解析，导出 `P2P_V2_ROW_ID='dsh-p2p-v2'`、7 个工具名和 `apply()`。

## 3. 配置默认

`cordis.patch.yml` 的 `dsh-p2p-v2` 行：

| 键 | 值 | 结论 |
|---|---|---|
| `disabled` | `true` | 保持默认关闭；生产 profile 显式启用 |
| `webTorrentModule` | `'webtorrent'` | 符合默认 |
| `trackers` | `[]` | 无公共 tracker |
| `allowNativeTrackers` | `false` | 默认不发布 |
| `maxShares` / `maxPeersPerShare` / `maxConns` | `8` / `16` / `32` | 上限存在 |
| `maxFileBytes` / `maxDownloadBytes` | `10737418240` / `10737418240` | 10 GiB 上限 |
| `readyTimeoutMs` / `metadataTimeoutMs` / `writeTimeoutMs` | `30000` / `10000` / `15000` | 有界等待 |

未修改该行默认值；启用方式写入 `docs/P2P-V2.md` §2.3，由生产 profile 覆盖 `disabled: false`。

## 4. 文档

- `docs/design/P2P-V2-WEBTORRENT.md`
  - 3.2 新增 **transport 接口**：定义/绑定分离、`ensure`/`send`/`onMessage`/`destroy` 契约、默认与未知名字拒绝、只释放本绑定。
  - 4.1 新增 **多 peer 编排**：一 seed 多 leecher、多 seed、同 peer 多 torrent、幂等 attach、上限、部分失败、detach。
  - 4.2 新增 **配额、staging 与恢复**：数量/字节配额、staging 同卷、重启只给候选、显式 add 续传、stop 保留 staging。
  - 文件头版本改为随 `3.7.1` 发布。
- `docs/P2P-V2.md` 新建，面向操作者：安装引擎、生产启用、配置表、最短 seed/add 示例、多 peer 示例、配额/续传/停止、回滚、故障排查、安全边界。
- `CHANGELOG.md` 新增 `[3.7.1]` 发布条目。

## 5. 测试证据

| 套件 | 结果 |
|---|---|
| `npm run test:p2p-v2`（含 p2p-v2、dispatch isolation、P5 单元、P5 集成、P5 resume） | 57 tests / 57 pass / 0 fail / 0 skip |
| `test/claims.test.mjs` | 48 tests / 47 pass / 0 fail / 1 skip |
| `test/acceptance-doc.test.mjs` | 6 / 6 pass |
| `test/tools.test.mjs` | 141 / 141 pass |
| `test/layer-model.test.mjs` | 24 / 24 pass |
| `npm run verify`（entrypoints + 10 个核心套件） | 770 tests / 754 pass / 0 fail / 16 skip |
| `npm run lint` | 0 errors / 297 warnings（既有 warning） |
| 干净前缀安装 + 子路径导入 | 通过 |

P6 新增的 wiring 断言锁定：版本 `3.7.1`、`exports['./dsh-p2p-v2']`、无 `webtorrent` 依赖、`test` / `test:all` 均含 `test/p2p-v2.test.mjs`、`docs/P2P-V2.md` 存在、row `disabled:true` 且默认无 tracker。

## 6. 回滚

操作：生产 profile 把 `dsh-p2p-v2` 行设回 `disabled: true`，重启 DSH。

口径与验证：

- 回到 V1 任务分发，`dsh-p2p-webrtc` 配置不变；V2 不修改 V1 配置。
- 不回滚共享 pool，不 `closePeer()`，不 `pool.stop()`；已运行的任务连接不拆。
- 已下载文件不删除；禁用后只停止 torrent，不再加载 `shares.json` 为活动 share。
- 操作者文档 §7 已写明该流程。

## 7. 未执行 / 不声明

- 未执行 `npm publish`、`git tag`、GitHub Release 或市场索引更新。按用户要求只交付“发布准备完毕”。
- P5 遗留限制不因 P6 打包而消失：Windows+Mac+Linux 三节点两两真实 V2 文件面未执行；真实 socket kill/重连未验证；单个 leecher 同时从两个真实 seed 拉取的真实 swarm 未验证。详见 `docs/acceptance/3.7.0/P5-ACCEPTANCE.md`。
- P6 为打包与文档窗口，没有新增传输逻辑；上述限制需要在后续真实网络验收中补。
