# DSH 机器升级 2.0.8 + allowlist 修复清单

目标：DSH 侧具备 2.0.8 的 ChaCha20-Poly1305 纯 JS 回退与 peer key 逻辑，并让 allowlist 真正生效。
前置：DSH 机器本机操作；relay 保持 43.142.74.71:8787；编队 004945。

## 1. 升级前快照

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
$plugin  = "$profile\node_modules\@twinsearth\w2m-dsh-plugin"
Copy-Item "$profile\..\xclient\device.json" "$env:TEMP\device.json.dsh-bak" -Force
if (Test-Path $plugin) {
  (Get-Content "$plugin\package.json" -Raw | ConvertFrom-Json).version
}
Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Where-Object { $_.CommandLine -match 'w2m-localside' } |
  Select-Object ProcessId, CommandLine
```

记录：当前版本、localside 启动参数、`device.json` 位置。

## 2. 下载并校验 2.0.8

```powershell
$tmp = Join-Path $env:TEMP 'w2m-2.0.8.tgz'
Invoke-WebRequest 'https://registry.npmjs.org/@twinsearth/w2m-dsh-plugin/-/w2m-dsh-plugin-2.0.8.tgz' -OutFile $tmp
(Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
# 期望：700c06ba81195fc36c129bc2e9337c2cf2b678965decd456d3a73d05b9aa1251
```

## 3. 停旧进程（不要在这个窗口里启动升级脚本后再停自己）

```powershell
# 停独立 localside
Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Where-Object { $_.CommandLine -match 'w2m-localside' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 若由计划任务/WinSW 托管
Stop-ScheduledTask -TaskName 'W2M Localside agent' -ErrorAction SilentlyContinue
# 或：Restart-Service w2mlocalside
```

## 4. 替换插件树（脚本方式）

在 DSH 机器上执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\dsh-install-2.0.8.ps1 -ProfileName desktop
```

脚本会：校验 sha256 → 备份旧插件目录 → 解包 2.0.8 → 打印版本与新插件路径；**不会重启 DSH**。

手动等价步骤：

```powershell
$backup = "$plugin.bak-$(Get-Date -Format yyyyMMddHHmmss)"
Move-Item $plugin $backup
New-Item -ItemType Directory -Force $plugin | Out-Null
tar -xzf $tmp -C $plugin --strip-components=1
node -e "console.log(require('$($plugin -replace '\\','/')/package.json').version)"
```

## 5. 重启宿主 + 修复 allowlist

先重启 DSH（外部执行）：

```powershell
Stop-Process -Name 'DeepSeek Harness' -Force
Start-Sleep 3
Start-Process 'E:\DS\DeepSeek Harness.exe'
```

allowlist 必须落到**实际运行的 agent**：

### A. 独立 localside

```powershell
node "$plugin\bin\w2m-localside.mjs" `
  --rabbit http://43.142.74.71:8787 `
  --name DSH `
  --state "$env:USERPROFILE\.dsh\xclient\localside" `
  --fleet-key <004945 的 fleet key> `
  --allowed-commands '["node"]'
```

### B. 插件 autoStartAgent（没有独立进程）

在 DSH 的项目根放 `.w2m.json`：

```json
{ "allowedCommands": ["node"] }
```

再重启 DSH。

## 6. 验收

```powershell
# 版本
node -e "console.log(require('$($plugin -replace '\\','/')/package.json').version)"   # 2.0.8

# 执行（从 ToFuture 派发）
# w2m_run assignee=DSH command=["node","--version"]
# 期望：outcome=ok / exit_code=0；不再 COMMAND_NOT_ALLOWED

# P2P（ToFuture 侧）
# w2m_status.p2p.encryption:
#   handshakes >= 1
#   encrypted_channels >= 1
#   refused = 0
```

## 7. 回滚

```powershell
Stop-Process -Name 'DeepSeek Harness' -Force -ErrorAction SilentlyContinue
Remove-Item $plugin -Recurse -Force
Move-Item $backup $plugin
Start-Process 'E:\DS\DeepSeek Harness.exe'
```

`device.json` 用第 1 步备份恢复；relay 不参与回滚。

## 已知边界

- 脚本只安装文件，不重启 DSH、不改 allowlist；
- 若 DSH 是 Intel Mac 或非 arm64/x64 平台，需单独确认 sidecar/平台能力；
- DSH 若仍使用旧宿主进程，版本显示 2.0.8 但握手仍会超时，必须真正重启宿主。
