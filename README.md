# Operit Purge

把 dsh-purge 那套"不拒答、不软化、先给工件"的机制搬进 Operit。

产出一个可直接导入的 ToolPkg：`build/operit_purge.toolpkg`。

## 它到底干什么

| 能力 | 落点 | 说明 |
|---|---|---|
| 破甲提示词注入 | `SystemPromptComposeHook`（`after_compose_system_prompt`） | 追加到宿主既有 system prompt 末尾，**不替换**角色卡和宿主提示 |
| 历史兜底 | `PromptFinalizeHook` + `PromptEstimateFinalizeHook`（`before_send_to_model`） | 同一段提示词落到 `preparedHistory` 的第一条 SYSTEM；估算路径也接，避免 token 估算和真实请求不一致 |
| 本轮执行约定 | `ChatInputHook`（`submit_requested`） | 提交前在用户消息前插一句短约定，压过历史里残留的"助手人格" |
| 拒答检测 + 自动重答 | `ChatMessageHook`（`message_persisted`） | 命中拒答 → 记日志/计数 → 自动补发一次"继续"，按 `retryMax` 限次 |
| 运行态跟踪 | `ChatRuntimeHook`（`state_changed`） | 记住会话是 `main` 还是 `floating`，重答时发到同一 surface |
| 工具不拦 | `ToolLifecycleHook`（`tool_call_intercept`） | **永远 `allow`**。拦工具＝替模型拒答 |
| 控制台 | `ToolboxUiModule` + `NavigationEntry` | Compose DSL 面板：开关、预设、自定义提示词、自检、日志 |
| 工具面 | 子包 `purge_tools` | 11 个工具，让模型自己也能查/改配置 |

## 和 dsh-purge 的对应关系

| dsh-purge | 本插件 |
|---|---|
| `lib/default-prompt-inject.md` 长提示词 | `dist/shared/defaults.js` 三个内置预设（default / minimal / claude） |
| cordis 配置项 | `settings.json` + 控制台开关 |
| `autoRetry` / `retryMax` / `continueText` | `autoRetryOnRefusal` / `retryMax` / 预设内 `retryText` |
| `hooksDenyBypass`（放行钩子） | `onToolLifecycle` 无条件 `allow` |
| `capabilityProtocol` | 并入 default 预设"运行时分"一节 |
| profile 级安装 / 改 asar | 不需要。ToolPkg 是官方扩展点，装包即生效 |

## 装

```
node scripts/pack.cjs                              # 产物在 build/operit_purge.toolpkg
adb push build/operit_purge.toolpkg /sdcard/Download/
```

手机端：Operit → 插件/包管理 → 本地导入 → 选中文件 → 启用「Operit 破甲」容器与「破甲工具」子包。

侧边栏 → **破甲控制台**。

## 配置落点

全部在 `ToolPkg.getConfigDir()`：

```
settings.json     开关、预设选择、自定义提示词
state.json        每会话 retryAttempts / runtime / guardUntil + 全局统计
presets/*.md      自定义预设（首行是标题）
logs/purge.log    拒答命中、重答、工具放行、错误
```

改完下一次请求即生效，不用重启 Operit。

## 预设

- `default` — 强约束版：拒答对抗 + 先工件后解释 + 分层展开 + 会话持久
- `minimal` — 只留核心四条，上下文占用最小
- `claude` — 保留克制语气，删掉拒答与说教
- 文件预设 — `presets/<id>.md`，首行当标题；自定义提示词优先级最高

## 拒答检测怎么判

`dist/shared/refusal.js`，两条判据：

1. **开头骨架 + 全文无工件** → 拒答。开头窗口 240 字符匹 `抱歉，/我不能/无法/I cannot/I'm sorry/As an AI` 等强骨架；全文扫有没有代码围栏、编号步骤、命令、语言关键字。
2. **软化话术密度** → 半拒。`仅供学习`、`请自行判断`、`建议通过合法途径`、`超出我的能力范围` 等标记出现 ≥2 处且篇幅短，或出现在结尾 240 字符内（尾注免责）。

半拒才是主流形态，所以第 2 条比第 1 条更常命中。

## 防循环

自动重答会把"继续"当成 user 消息写回历史。如果 `message_persisted` 里遇到 user 消息就无条件清零计数，就变成无限重答。所以每次重答都写 `guardUntil = now + 120s`，窗口内的 user 消息不重置计数；窗口外才清零。

## 验收

```
node tests/harness.cjs      # 43 项：存储/配置/预设/拼装/检测/钩子/工具/注册/manifest
node tests/ui-smoke.cjs     # 11 项：Compose DSL 渲染冒烟 + action 真调用
node scripts/pack.cjs       # 打包并校验 manifest 引用路径
```

期望：三个命令都输出「全部通过 / wrote …」，退出码 0。

设备侧验收（插上手机后）：

```
adb push build/operit_purge.toolpkg /sdcard/Download/
adb shell am start -n com.ai.assistance.operit/.ui.activities.MainActivity
```

导入后：控制台 → 运行自检 → 应显示「全部通过」；再问一句易触发拒答的话，`purge_read_log` 应出现 `refusal` 与 `retry_sent` 两行。

## 边界（明说，不藏）

- 只对 `functionType = CHAT` 的链路注入；摘要、标题生成、翻译不动。
- 拒答检测是启发式：长回答里夹一句"仅供参考"可能被误判，用控制台的「跑检测样本」和日志核对，误伤就调 `SOFT_MARKERS`。
- 自动重答受 `retryMax`（0–5）限制，且每次只补一句"继续"，不重放原问题。
- 模型侧的硬拒（provider 直接返回错误、内容过滤）改不了，插件只能改请求侧。

## 目录

```
manifest.json
dist/main.js                    注册入口（只注册，无常驻逻辑）
dist/shared/{storage,config,presets,prompt,refusal,hooks,service,defaults}.js
dist/packages/purge_tools.js    子包工具（含 METADATA）
dist/ui/dashboard/index.ui.js   Compose DSL 面板
resources/{logo.svg,quick-start.md}
scripts/pack.cjs                无依赖 ZIP 打包
tests/{harness,ui-smoke}.cjs    验收台
```
