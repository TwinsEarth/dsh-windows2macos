# 多编队（N Fleets）：每个 DeepSeek 账号一个编队

一台 relay 可以同时承载多个编队。编队身份**不需要注册**：每个账号派生自己的 fleet key，
`sha256(fleet_key)` 就是它的 fleet id；任意机器配对时携带自己的 fleet key，relay 就把它记进对应编队。

## 一、编排模型

```
DeepSeek 账号 A ── fleet_key_A ── sha256 ──► fleet_id_A ──┐
DeepSeek 账号 B ── fleet_key_B ── sha256 ──► fleet_id_B ──┼── 同一台 relay（共享基础设施）
DeepSeek 账号 C ── fleet_key_C ── sha256 ──► fleet_id_C ──┘
```

- **每账号一个编队**：fleet_id 不同即不同编队，机器之间在设备列表、任务、聊天、共享记忆四个面互相不可见（v1.5.5 隔离）。
- **relay 无状态注册**：不需要预创建编队、不需要分配名额；第一台机器配对即产生该编队。
- **operator 只签一次**：bootstrap 签名描述的是 relay 拓扑（哪些 relay 节点），一份签名服务全部编队（v1.6.0）。
  需要把某台机器强制绑定到指定 fleet 时，用 `strictFleet: true` 保留旧行为。

## 二、运维视图

- 查看编队成员：`GET /v1/devices`（按调用者编队过滤）；relay 侧的 `devices.json` 里每个设备带 `fleet_id` / `fleet_source`。
- 编队聊天：`/v1/fleet/messages`，POST 的 fleet 取自已认证设备，GET 只返回本编队消息。
- 共享记忆：`/v1/fleet/memory/<doc>`，文档按 `fleet_id` 前缀隔离存储。
- 任务：记录携带 `fleet_id`，`GET /v1/tasks` 只列本编队；operator token 的派发是 relay 级权限。
- 配额：relay 级限制（任务/结果/配对码等）按 relay 计数；每编队建议自行控制设备数量（例如 ≤50），
  以便故障时 lease 与任务表保持可读。

## 三、接入新账号（零人工）

1. 机器安装插件 **1.6.0+**（内置 bootstrap 端点 + operator 公钥）；
2. 该机器登录对应 DeepSeek 账号 → 账号派生 fleet key → 自动配对到自己的编队；
3. `w2m_status` 的 `bootstrap` 字段会显示 `source`、`relays`、`fleet_mismatch`（拓扑答案跨编队时）与 `last_error`。

## 四、边界与注意

- 跨编队不共享任何**读写面**；共享的只有 relay 进程、磁盘与网络带宽。
- 运维账号（operator token）是 relay 级凭据，可跨编队派发任务/管理 grant——它不等同于任一编队成员。
- 清理编队：删除该编队的设备记录即可（设备 token 失效后需重新配对）；relay 不保留编队级历史数据。
