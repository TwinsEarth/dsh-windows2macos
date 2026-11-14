# 契约 SDK 副本来源（PROVENANCE）

本目录是 `@twinsearth/dsh-fang-contract@1.1.1` 的**逐字节副本**，来源是 npm 上已发布的包，
不是对 dsh-fang / dsh-master 仓库的改动。按 w2m 会话守则（`E:/GPT/w2m/AGENTS.md`），
三个项目相互独立：w2m 只经由发布出来的版本化契约 SDK 互联，不 import 对方内部代码。

- 包名：`@twinsearth/dsh-fang-contract`
- 版本：`1.1.1`（`CONTRACT_VERSION` 常量与 package.json 一致）
- 来源：npm registry，`npm pack @twinsearth/dsh-fang-contract@1.1.1`
- 许可证：AGPL-3.0-or-later（见本目录 `LICENSE`）
- 语义不改：w2m 自己的方法放进 `w2m.*` 命名空间，不改 `fang.*` 任何语义。

| 文件 | 字节 | sha256 |
|---|---|---|
| LICENSE | 34523 | 0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0 |
| client.js | 4021 | b1c48a56c64e7058f40a6f1e3239f9e81619381c121fc3d2e1f5418b6e8c6b26 |
| constants.js | 3404 | 6ce1d813a6a61cfc991c4888f813e7baeff828802ba03f375c6b49e6b0329979 |
| envelope.js | 3164 | 68e8725a4b7d5c01e49b1364a201121278d3d45dac6e99dc0ee53f98232d380a |
| index.js | 780 | 67b5d687d4f8c47fd4d573fe5540362014ed0617e7df3533936e613a439b655c |
| negotiate.js | 3993 | 8a699b287b740a7d478c40981c0ae7915a6522ff856f3bc0b19f0cc077587c43 |
| relay.js | 9499 | 9f7150aaa026ea4ca629b749a2bc691579b72836af053e05228070a009f5b5b2 |
| server.js | 3255 | 5e7c884639fc365833f6fdca91f276c34db2b1d1a6938790c7e9b71c127e6c17 |
| transports.js | 16872 | 6712aabbe702ae559ff50027a3469c0ce031092e6b0a61fec51cfe80b69d0a6c |

升级流程：`npm pack` 取新版本 → 覆盖本目录 → 重跑生成脚本更新上表 →
`node scripts/check-contract-vendor.mjs`（本仓库的 pre-flight 会跑它）。
