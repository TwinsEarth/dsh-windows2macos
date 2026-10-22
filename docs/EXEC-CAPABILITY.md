# Node 代码执行能力（子插件能力，DSH 界面激活）

**状态：v1.4.2 实现。** 把"允许该机器执行任意 Node 代码"从一份静态 allow-list 变成了
**插件界面里的一个显式开关**：客户在 DSH 的 composer 座位（目标机器旁）看到
`Node 执行：拒绝 | 临时 24 小时 | 永久`，点选即生效，不需要手改配置文件。

## 为什么需要它

`node -e` 前缀等于放行任意 Node 代码，等效远程代码执行（RCE）。此前的做法是让用户手改
`~/.w2m/machine.json` 的 `allowedCommands`：容易写成永久、没有到期、没有 UI 提示、没有审计措辞。
把这一条能力单独做成"子插件能力"，其余 allow-list 语义不变，就能做到：

- **默认拒绝**：文件缺失/损坏/过期都读作 `denied`，fail-closed；
- **三档显式选择**：拒绝 / 临时 24h（可配置 TTL，上限 7 天）/ 永久；
- **到期自失效**：临时档写入绝对 `expires_at_ms`，agent 每次任务前读取，过期即拒绝，不需要重启；
- **可审计**：每次任务的结果信封记录 `authorization.provenance = "exec-capability"`，并在 warnings 里
  写明 `EXEC_CAPABILITY: node code execution …`；台账里仍是 task id + argv + 机器。

## 组成

| 层 | 文件 | 作用 |
|---|---|---|
| util | `src/util/exec-capability.mjs` | 状态文件读写、过期判定、固定前缀 `node -e`、`describeExecCapability` |
| host 路由 | `src/plugin/exec-capability-route.mjs` | `GET/POST /api/w2m/capability`，同源、在 host 认证栅栏内 |
| agent | `src/agent/agent.mjs` | 每次任务前读文件；allow-list 拒绝后、grant 之前/之后按策略并集判定；stage 同样覆盖 |
| client | `lib/client.js` | `conversation.input.left` 座位第三个控制（order 42），三档菜单 + 风险提示 |

## 状态文件

`~/.w2m/exec-capability.json`（每台机器本地，不通过 relay 同步）：

```json
{ "protocol": "w2m-exec-capability/v1", "state": "temporary",
  "activated_at_ms": 1792650000000, "expires_at_ms": 1792736400000,
  "actor": { "kind": "operator", "id": "plugin-ui", "at": "..." } }
```

## 生效顺序

```
允许执行 ⇔ allow-list 匹配
          ∨ grant 授权（显式、单次、≤10 分钟、可撤销）
          ∨ exec-capability 激活（本机 UI 开关；临时档未过期）
```

本机开关与 grant 是**并列的两种授权来源**：grant 适合"操作员对某一次跨机执行签字"，
capability 适合"本机机主长期/为期一天地打开这个能力"。结果信封的 provenance 会区分二者。

## 撤销

界面切回"拒绝"即可；或删除 `~/.w2m/exec-capability.json`；或手改 `state: "denied"`。
agent 下一个任务生效，不需要重启；插件自身回滚仍是"覆盖 `…w2m-dsh-plugin.pre-<ver>` 后重启 DSH"。

## 测试

`test/exec-capability.test.mjs`：默认拒绝、三态写入、24h 到期边界、非法输入、路由 GET/POST/405；
`test/client-bundle.test.mjs`：第三个座位控制被注册、inject 面、样式与激活契约。
