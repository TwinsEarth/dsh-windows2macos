# v2.1.0 远程桌面子插件（仅查看）落地方案

状态：DRAFT，待 P0 spike 与决策确认；未改代码、未发布。
专家评审：国内网络架构工程师 + 视频流工程师（只读）。
目标：设置页开关；开启后侧边栏出现 iMac 图标标签；仅查看、不可控制；后续版本再开放鼠标操控。

## 1. 结论

1. v2.1.0 的现实目标是 **加密、可用的 1–2 fps 查看**，不是 RustDesk 级 30fps 远控；10fps+ 需要 sidecar/不可靠传输，排 P4。
2. **不 vendor RustDesk/hbb_common**（AGPL 边界 + 与现有 P2P 重复）；只借鉴分层与自适应思路，sidecar 必须可选、独立进程、外部二进制。
3. 先做 P0 三个 spike（浏览器流、macOS TCC/采集、VK 握手），再写 UI；UI 是最不会失败的部分。
4. 媒体 E2E 加密，relay 只做信令/授权/密文回退；目标端默认拒绝，每次会话显式同意。
5. v2.1.0 不做：输入控制、剪贴板、文件、音频、录制、无人值守、多查看者、Windows 被查看端。

## 2. 分层

```
L5 浏览器：sidebar iMac 标签 + canvas 查看页 + 设置页开关
L4 DSH 宿主：remote-view route/service/session（同源 /api/w2m/remote/*）
L3 agent：view 会话、采集、同意、帧加密（view.* P2P 路由）
L2 传输：P2PChannel（优先）| relay 密文帧（回退）；VK 会话加密
L1 relay：/v1/remote/signal、/v1/remote/stream、/v1/remote/frame（只密文）
L0 平台：macOS screencapture/sips（P0）→ ScreenCaptureKit（P3/P4）
```

同包内子模块 `src/plugin/remote-view/*` + `src/agent/view/*`，不拆 npm 包；单版本、单 patch row。

## 3. UI 接口

- `settings.section`：远程桌面开关（默认关闭），写 `<stateDir>/remote-view.json`（0600）。
- `sidebar.panellist`：iMac 图标，仅开关开启时渲染；关闭时返回 null。
- `main`：查看页（目标选择、同意状态、canvas、直连/中继徽标、停止、“仅查看”常驻说明）。
- 每个 slot 独立 try/catch，不新增 inject；动态显隐需 P0 验证外壳是否折叠空行，失败则提示刷新。

## 4. 信令与安全

- 身份：fleet 准入（relay）+ X25519 device key（通道认证）+ 临时 X25519 三重 DH 派生 VK（媒体 E2E）。
- invite/accept：`k_mac = HKDF(ECDH(static keys))` 密封；VK 派生后媒体/控制分方向密钥。
- 目标端授权：默认拒绝；每次 `osascript display dialog`，30s 超时；可选内存态“允许 30 分钟”，不落盘。
- relay：同 fleet 校验；只接受 `{session_id, seq, ct}`；拒绝 JPEG/PNG magic、明文 JSON、输入类型；TLS 强制（否则 `VIEW_RELAY_INSECURE`）。
- 错误码：VIEW_DISABLED/TARGET_BUSY/NO_ANSWER/CONSENT_DENIED/P2P_TIMEOUT/CAPTURE_DENIED/PLAINTEXT_MEDIA_REFUSED 等。

## 5. 视频链路（专家修订版）

### 5.1 安全上下文：不是部署要求

页面从本机 DSH GUI（`127.0.0.1`）加载，属于 potentially trustworthy origin；媒体帧由目标机经 P2P/relay 到本机宿主，再由同源 route 给浏览器。因此：

| 拓扑 | 页面 origin | isSecureContext | WebCodecs | P1 |
|---|---|---|---|---|
| A 本机 DSH 面板 | 127.0.0.1 | true | 可用 | 主路径 |
| B 本机 DSH + HTTPS | https | true | 可用 | 可选 |
| C 局域网直开 DSH | http://192.168.x.x | false | 不可用 | 仅 JPEG 档 |
| D 局域网 HTTPS 反代 | https | true | 可用 | 需证书运维 |

P1 不要求 HTTPS；运行时探针 `isSecureContext / VideoDecoder / createImageBitmap`，C 拓扑只走 JPEG。不要把整个 DSH GUI 绑到 0.0.0.0；局域网只读查看应使用独立端口 + 一次性 token。

### 5.2 渲染：SSE + createImageBitmap（P1 默认）

每帧独立 JPEG/WebP/AVIF，经同源 SSE 下发：
`{ session_id, seq, ts_ms, w, h, mime, bytes, data_b64 }`；无变化发 `view.unchanged`。
前端 `createImageBitmap(new Blob([bytes]))` → canvas `drawImage`；不需要 WebCodecs，不需要 HTTPS。
“最新帧优先”：上一帧未投递完就丢新帧（dropped++），不排队。

### 5.3 编解码：帧内优先，视频档可选

| 层 | 编码 | 1–2fps 收益 | 结论 |
|---|---|---|---|
| 帧内 | JPEG | 地板，永可用 | P1 默认 |
| 帧内 | WebP | 体积 0.65–0.75× | P1.5 升级 |
| 帧内 | AVIF/HEIC | 0.5–0.7×，编码 100–300ms | P2（需 ffmpeg/Safari） |
| 帧间 | H.264/HEVC/AV1 | 1–2fps 下 IDR/GOP 成本抵消收益 | 可选加速档，非地板 |
| 帧间 | VP9 | 无 Apple 硬编 | 不建议 |

“不接受仅 H.264”的落法：**P1 的媒体地板不是 H.264，而是 JPEG**；HEVC/AV1 作为探测后的可选加速档，缺失不影响可用性。
1–2fps 最有效的省流不是换编码器，而是“画面未变”抑制（可砍 50–80% 帧）。

### 5.4 macOS 采集

- P1：`screencapture -x -t jpg -D 1`（1fps 稳，2fps 边际）；relay 档再加 `sips -Z 1024 -s formatOptions 45`。
- 2fps 可选：`ffmpeg -f avfoundation -framerate 2 -c:v mjpeg` 常驻，外部二进制、不打包、缺失即回落。
- TCC：Screen Recording 按责任进程归属；必须区分 `CAPTURE_DENIED / CAPTURE_BLANK / CAPTURE_FAILED`，目标端 GUI 给系统设置跳转。
- 采集 argv 固定，不走 allow-list。

### 5.5 同意 UI（目标端 DSH GUI）

目标端也跑 DSH GUI：同意弹窗显示 viewer/屏幕/分辨率/fps/时长；允许后常驻“正在被查看”横幅 + 停止按钮；默认拒绝、30s 超时、内存态授权 ≤30min；锁屏/关闭面板/停止 → 停采 ≤1s。headless 才用 osascript 兜底。

### 5.6 帧预算与传输

| 通道 | 单帧 raw 上限 | 目标 | 默认 fps | 超限行为 |
|---|---|---|---|---|
| P2P | 96 KiB | 64 KiB | 1（P1 只承诺 1fps） | 降分辨率，不分块 |
| relay | 47 KiB 硬顶 | 40 KiB | 1 | 降分辨率/1fps |

- relay 只接受 `{session_id, seq, ct}`；拒绝 JPEG/PNG magic、明文 JSON、输入类型；媒体必须 E2E 加密（TLS 不能替代）。
- 不把帧塞进 `/v1/fleet/messages`（4 KiB + 配额 + 通知不带正文）。
- 新 feature：`remote-frame-v1`；老 relay → `VIEW_RELAY_UNSUPPORTED`，不发第一帧。
- P1 建议：P2P 媒体 + relay 信令；relay 密文帧放 P1.5（40 KiB 清晰度有限，先做逃生门）。

### 5.7 P0 spike（3–4 人日）

1. S1 JPEG→canvas 1–2fps 渲染（≤30ms/帧）；
2. S2 macOS 采集 1/2fps + TCC 三形态（先跑，唯一能推翻 fps 目标）；
3. S3 安全上下文矩阵（127.0.0.1 vs 局域网 IP）；
4. S4 P2P 40/64/96/128 KiB 单帧预算；
5. S5 relay 47 KiB 边界/413/magic 拒绝；
6. S6 同意/撤销六态。

## 6. 阶段

| 阶段 | 目标 | 退出条件 | 人日 |
|---|---|---|---|
| P0 | 证伪浏览器流/TCC/VK 三假设 | 首帧延迟、采集耗时、权限拒绝行为、VK 单测 | 3–5 |
| P1 | 最小可用：P2P JPEG + relay 信令 + UI 开关/标签/同意 | Windows 看 Mac 1fps；错误码齐全；relay 无媒体明文 | 8–12 |
| P2 | 隐私/生命周期硬化 | 30min soak、锁屏暂停、限流、默认拒绝 | 5–8 |
| P3 | 密文中继回退 + TLS + 384KiB 帧上限 | 阻断 UDP 后仍 1fps；relay 无 JPEG magic | 8–12 |
| P4 | 可选 sidecar（非 RustDesk）10–15fps + 窗口选择 | sidecar 缺失时 P1 仍可用 | 10–15 |

## 7. 验收（节选）

- 开关关闭：无标签、`start` 返回 VIEW_DISABLED、无 UDP bind/relay stream。
- 开关开启：iMac 标签出现；roster 只列 `caps.view` 的 macOS 机器。
- 同意：拒绝/超时/忙/离线均有具名 code；默认拒绝。
- 性能：LAN 首帧 ≤2.5s；1fps 持续 10 分钟；停止 ≤1s；中继 ≥0.8fps。
- 安全：relay 请求体无 `FFD8FF`/`image/jpeg`；发真 JPEG 到 frame 端点返回 400；输入类型返回 VIEW_INPUT_FORBIDDEN。
- 零依赖：`dependencies` 不变；client bundle 测试通过；旧 relay/旧 agent 有明确降级。

## 8. 决策与待确认

已确认：

1. 接受 1–2 fps 查看；
2. relay 有 TLS；
3. macOS 目标端也跑 DSH GUI（同意 UI 放目标端 GUI）；
4. 不接受仅 H.264 → 媒体地板改为 JPEG，HEVC/AV1 作为可选加速档；
5. 允许局域网 HTTP → C 拓扑只走 JPEG，不要求 WebCodecs；
6. **relay 密文帧路径进 P1.5**；P1 为 P2P 媒体 + relay 信令，P2P 失败明确 `P2P_UNAVAILABLE`；
7. **P1 不包含 2fps 档**：只有 1fps 的对外承诺；2fps 在 S2 实测达标后仅作为隐藏实验开关，不进 UI/验收/文档承诺。
8. **允许 2fps 依赖外部 ffmpeg**（面向 P1.5）：可选、不打包、不自动下载、缺失回落；`dependencies` 保持为空。

P1 基线（无 ffmpeg）：`screencapture` 1fps + JPEG；有 ffmpeg：2fps 档可选。

## 9. 2fps 决策（2026-10-30）

结论：P1 不设 2fps 交付档位。

- 唯一保证的采集后端 screencapture 单帧 p50 215–360ms / p95 590ms，2fps 的 500ms 预算越界；
- 2fps 的收益仅约 250–450ms 新鲜度，1fps 与 2fps 同属幻灯片（8–15fps 才是感知门槛）；
- 1% 丢包下 57 分片帧受损概率 43%，一次 RTO 300ms 吃掉 2fps 预算 60%；
- P1 的坑应在同意/TCC/撤销，不在帧率；2fps 留 P1.5 视频档或 S2 后隐藏开关。

替代方案（P1 推荐）：1fps + 变化追帧 burst（检测到变化时最多 2.5fps 持续 0.75s，令牌桶）+ 首帧双发 + 帧龄 HUD + unchanged 抑制读数。
