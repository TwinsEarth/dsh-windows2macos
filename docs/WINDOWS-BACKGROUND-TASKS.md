# Windows 后台任务：不弹窗的正确做法

## 现象

用 `schtasks /TR "node.exe script.mjs"` 创建的计划任务，每次触发都会在桌面**弹出一个控制台窗口**。
本机曾因此出现"每隔 2–5 分钟自动弹窗"，来源是守护/守望任务：

| 任务 | 频率 | 实际行为 |
|---|---|---|
| standby keeper | 每 2 分钟 | 起 `powershell.exe` → 窗口闪烁 |
| TwinsEarth watcher | 每 5 分钟 | 起 `node.exe`，且脚本设计跑 6 小时 → 窗口+进程累积 |

## 正确做法

用 `wscript.exe //B wrapper.vbs` 注册任务；VBScript 里：

```vbs
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\...\node.exe"" ""C:\...\script.mjs"" --flag", 0, False
```

- `0` = 隐藏窗口（不显示控制台）
- `False` = 不等待（任务立即返回）

## 用工具生成（v1.6.5 起）

```powershell
node bin/w2m-hidden-task.mjs `
  --name w2m-standby-keeper `
  --every-minutes 2 `
  --command "E:\DS\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" `
  --arg "C:\Users\you\.dsh\xclient\standby-keeper.mjs" `
  --workdir "C:\Users\you"
```

输出：

```
scheduled w2m-standby-keeper every 2 min (hidden wrapper C:\Users\you\.dsh\xclient\w2m-standby-keeper-hidden.vbs)
```

删除：

```powershell
node bin/w2m-hidden-task.mjs --delete --name w2m-standby-keeper
```

## 原则

1. **不要**把长驻脚本挂到分钟级计划任务上（每次触发都会起一个新实例）——分钟级任务里只放"检查并退出"的短脚本；
2. 计划任务一律通过 VBS 隐藏包装启动，不要直接 `node.exe`；
3. 长期守护优先用系统服务/launchd/启动项，而不是高频计划任务；
4. 一次性任务（如远程重启）用完即删，避免残留（本机曾残留 3 个 `w2m-restart-*`）。
