# Operit Purge — 快速开始

## 装包

1. 把 `operit_purge.toolpkg` 推到手机：
   `adb push operit_purge.toolpkg /sdcard/Download/`
2. Operit → 插件/包管理 → 从本地导入 → 选中该文件。
3. 导入后确认「破甲工具」子包为启用状态。

## 三步确认生效

1. 侧边栏 → **破甲控制台**：
   - 总开关在「已启用」
   - 系统提示词注入为开
   - 自动重答为开
2. 点 **运行自检** → 应显示「全部通过」。
3. 在任意会话问一句会触发拒答的问题，观察日志出现 `refusal chat=...`，随后出现 `retry_sent`。

## 常用操作

- 换语气：破甲控制台 → 当前预设 → Claude 语气 → 点「使用」
- 用自己的提示词：自定义提示词框 → 写 → 保存（优先级高于预设）
- 关掉自动重答但保留注入：注入点里把「拒答自动重答」关掉
- 只在某个会话启用：设置文件里加 `"watchAllChats": false`，再用工具 `purge_status` 检查

## 文件位置

配置都在 `ToolPkg.getConfigDir()`：

```
settings.json      # 开关与预设选择
state.json         # 每会话重答计数与统计
presets/*.md       # 自定义预设（首行是标题）
logs/purge.log     # 拒答命中、重答、错误
```

改 `settings.json` 后不用重启 Operit，下一个请求即生效。
