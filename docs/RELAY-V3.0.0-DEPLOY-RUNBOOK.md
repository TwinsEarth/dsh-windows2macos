# Relay v3.0.0 部署手册（B → C → A 滚动，待用户确认后执行）

- 目标：三台 relay 从 2.1.5 升级到 **3.0.0**，并启用三节点数据同步（devices + task ledger）
- 设计：`docs/RELAY-CLUSTER-SYNC-DESIGN-v3.0.0.md`
- 本地验证：`docs/RELAY-CLUSTER-SYNC-V3.0.0-VERIFICATION.md`
- 前置：本文档的每个部署动作都要等用户确认；在此之前不执行任何线上变更。

---

## 0. 角色与顺序

| 顺序 | 节点 | 地址 | 理由 |
|---|---|---|---|
| 1 | tencent | 106.53.197.47:8787 | 先备节点，风险最小 |
| 2 | vultr | 202.182.123.154:8787 | 备节点；境外链路，最后验证跨区同步 |
| 3 | primary | 43.142.74.71:8787 | 主节点，最后重启；确保前两台健康 |

**约束**：任意时刻只重启一台；重启前另外两台 `healthz.ok=true`；重启后等健康 + 首次同步
（或超时记录）再动下一台。客户端 active-passive 会自动切换，正常无需改配置。

---

## 1. 构建部署物（在开发机）

```bash
cd E:/GPT/w2m-222        # tag v3.3.15 基线 + 本次 cluster sync 代码
node --check src/relay/server.mjs
node --check src/relay/cluster-sync.mjs

# relay 运行物：bin/ src/ package.json
tar -czf /tmp/w2m-relay-3.0.0.tgz bin src package.json
sha256sum /tmp/w2m-relay-3.0.0.tgz   # 记录到交接单，部署后核对
```

> 不改 package.json 的版本号：relay 通过 systemd `W2M_RELAY_VERSION=3.0.0` 报告 3.0.0
> （`server.mjs` 支持该覆盖，插件包版本仍随 v3.3.15 发布线）。

---

## 2. 生成 cluster 凭据（只做一次）

```bash
# 共享 secret：三台同一值，只写入各台 systemd drop-in（0600），不进仓库
openssl rand -base64 32 > /tmp/w2m-cluster-secret.txt

# 三个稳定 node id（写入 drop-in；不可随意更改，游标以它为准）
# node-primary / node-tencent / node-vultr 建议用固定随机串：
for n in primary tencent vultr; do
  printf 'node-%s = node-%s\n' "$n" "$(openssl rand -hex 8)"
done
```

注意：
- 不要把 secret 贴进聊天/工单/仓库；
- 三台 relay 的 `W2M_RELAY_NODE_ID` 必须不同，`W2M_RELAY_PEERS` 只列另外两台（不含自己）。

---

## 3. 每台 relay 的安装步骤（逐台执行）

以 tencent 为例（其余两台同理，只替换 node id / peers）：

```bash
ssh root@106.53.197.47
cd /opt/w2m

# 3.1 备份
ts=$(date +%Y%m%dT%H%M%S)
systemctl stop w2m-rabbit
cp -a /opt/w2m/app "/opt/w2m/app.bak-${ts}"

# 3.2 部署 relay 代码（把本机 /tmp/w2m-relay-3.0.0.tgz scp 到 relay 后）
tar -xzf /tmp/w2m-relay-3.0.0.tgz -C /opt/w2m/app

# 3.3 cluster drop-in（0600）
mkdir -p /etc/systemd/system/w2m-rabbit.service.d
cat > /etc/systemd/system/w2m-rabbit.service.d/cluster.conf <<'EOF'
[Service]
Environment=W2M_RELAY_VERSION=3.0.0
Environment=W2M_RELAY_NODE_ID=node-<tencent-node-id>
Environment=W2M_RELAY_PEERS=[{"id":"node-<primary-node-id>","url":"http://43.142.74.71:8787"},{"id":"node-<vultr-node-id>","url":"http://202.182.123.154:8787"}]
Environment=W2M_RELAY_CLUSTER_SECRET=<粘贴 /tmp/w2m-cluster-secret.txt 内容>
EOF
chmod 600 /etc/systemd/system/w2m-rabbit.service.d/cluster.conf

# 3.4 启动
systemctl daemon-reload
systemctl start w2m-rabbit
```

---

## 4. 健康门禁（每台重启后必须通过）

```bash
# 4.1 基础健康 + 版本 + 新 feature
curl -fsS http://127.0.0.1:8787/healthz | tee /tmp/healthz.json
node -e "const j=require('/tmp/healthz.json'); console.log({
  ok:j.ok, version:j.relay_version,
  feature:j.features.includes('relay-cluster-sync-v1'),
  cluster:j.cluster && {enabled:j.cluster.enabled, node:j.cluster.node_id, peers:j.cluster.peers.map(p=>p.id)}
})"
# 期望：ok=true, version="3.0.0", feature=true, cluster.enabled=true

# 4.2 首次同步（重启后 60–600s 随机触发；期间 healthz.cluster.last_sync_at 为 null）
watch -n 10 "curl -fsS http://127.0.0.1:8787/healthz | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.cluster.last_sync_at, j.cluster.last_ok, JSON.stringify(j.cluster.peers.map(p=>[p.id,p.last_ok_at,p.last_error]))) })\""
# 期望：last_sync_at 出现，last_ok=true，两个 peer 的 last_ok_at 出现

# 4.3 未签名集群路由必须 401（不应被 device/operator token 绕过）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/v1/cluster/ping   # 期望 401

# 4.4 另外两台仍健康（从本机远程探测）
curl -fsS http://106.53.197.47:8787/healthz | grep -o '"ok":true'
curl -fsS http://43.142.74.71:8787/healthz | grep -o '"ok":true'
```

> 门禁不通过：立刻回滚该台（§7），不要继续下一台。

---

## 5. 跨节点验收（三台都升级完成后）

```bash
# 5.1 三台版本/feature/集群状态一致
for h in 43.142.74.71 106.53.197.47 202.182.123.154; do
  echo "== $h"; curl -fsS "http://$h:8787/healthz" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.relay_version, j.features.includes('relay-cluster-sync-v1'), j.cluster.last_ok, j.cluster.peers.map(p=>p.id+':'+(p.last_error||'ok')).join(','))})"
done

# 5.2 设备可见性（用任一 device token；三台应返回同一批 machine_id）
for h in 43.142.74.71 106.53.197.47 202.182.123.154; do
  curl -fsS -H "authorization: Bearer <device_token>" "http://$h:8787/v1/devices" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.devices.map(d=>d.machine_id).sort().join(','))})"
done

# 5.3 任务事实跨节点（在 A 上创建任务后，下一轮同步在 B/C 的 /v1/tasks 可见）
#     用 operator token 在 primary 创建，等 1 个同步周期或先手动触发：
#     - 测试期可临时把 W2M_RELAY_SYNC_INTERVAL_MS 调小（如 60000）再调回；
#     - 或重启一台（首同步 60–600s 随机）来加速验证。

# 5.4 故障演练（可选，低峰）：重启一台 relay，确认另外两台一直健康；
#     重启机恢复后 healthz.cluster.last_ok=true，游标继续推进。
```

---

## 6. 观察项（上线后 24h）

```
1. 每台 healthz.cluster.last_ok 持续为 true；last_error 不长期停留在 UNAUTHORIZED/TIMEOUT
2. peer 的 ledger_offset 单调递增（不倒退）
3. 状态目录增长：/var/lib/w2m/app/cluster/ledger.jsonl（受 1h 周期和任务量影响）
4. journalctl -u w2m-rabbit 无 5xx / 无 cluster 异常日志
5. 客户端任务/聊天不受影响（relay 层只增功能，不改既有路由）
```

---

## 7. 单台回滚

```bash
systemctl stop w2m-rabbit
rm -rf /opt/w2m/app
mv /opt/w2m/app.bak-<timestamp> /opt/w2m/app
rm -f /etc/systemd/system/w2m-rabbit.service.d/cluster.conf
systemctl daemon-reload
systemctl start w2m-rabbit
curl -fsS http://127.0.0.1:8787/healthz | grep -o '"relay_version":"[^"]*"'
# 期望回到 2.1.5；features 不含 relay-cluster-sync-v1
```

- `cluster/` 状态目录可以保留（旧代码不读它），下次升级可直接复用游标；
- 回滚一台不会影响另外两台（它们只是少一个 peer，另一 peer 仍同步）。

---

## 8. 完成标准

- [ ] 三台 `relay_version=3.0.0`，`features` 含 `relay-cluster-sync-v1`
- [ ] 三台 `cluster.enabled=true`、两个 peer 的 `last_ok_at` 均出现、`last_error` 为空
- [ ] 设备列表在三个 relay 上一致（跨节点同步生效）
- [ ] 至少一次任务事实跨节点可见（或 24h 内观察到 ledger_offset 推进）
- [ ] 24h 观察无回归、无 5xx
- [ ] 交接单记录：部署时间、tar sha256、回滚备份路径、观察结果
