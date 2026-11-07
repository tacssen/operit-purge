# Operit Purge 的破甲机制

本文件记录实现选型与踩过的坑，供后续维护和二次开发。

## 为什么不用注入/改包

dsh-purge 走的是改 asar、改 profile 那条路子，因为 DSH 的 system prompt 组装在进程内、只能靠 patch 拦。Operit 不一样，它把扩展点公开成 ToolPkg Hook：

| 想去哪儿 | dsh-purge 手段 | Operit 官方面 |
|---|---|---|
| system prompt | 改 asar 里的组装函数 | `registerSystemPromptComposeHook` |
| 发给模型的历史 | 改 profile/预设 | `registerPromptFinalizeHook` |
| 用户输入 | 宿主内 hook | `registerChatInputHook` |
| 模型回包 | 拦截 stream | `registerChatMessageHook`（只订阅，不改写） |

结论：能用官方 Hook 就不要动 APK。改包要跟版本、要重新签名、用户升级就失效；Hook 是官方契约，升级不破。

## 注入点为什么选 `after_compose_system_prompt`

`before_compose_system_prompt` 阶段 `systemPrompt` 还没拼完，追加进去的内容可能被后续 stage 覆盖。`compose_system_prompt_sections` 是结构化分段阶段，往里塞纯文本会破坏宿主的 section 结构。

`after_compose_system_prompt` 是最后一个能改完整提示词的阶段，追加到末尾最安全：前面是角色卡和宿主规则，后面是本插件的段。角色卡人格不会被替换掉，只是被"约束覆盖"。

## 三个幂等点

宿主在一轮里可能多次调用同一个 Hook（重试、重新组装、token 估算），所以注入必须幂等，否则会叠 N 份：

1. **system prompt**：检测 `</operit_purge>` 标记，已有就返回 `null`。
2. **用户输入**：数提醒出现的次数。0 次 → 插一句；1 次 → 返回 `null`；多次 → 收敛成一句。
3. **历史**：第一条 SYSTEM 里已有标记就不动。

另外在 `before_send_to_model` 阶段把**旧轮次** USER 消息里的提醒剥掉，只保留最新一轮那句。理由：每轮都带一句既吃 token，又稀释本轮指令——模型会把前几轮那句当历史噪声。

## 自动重答的死循环

`Tools.Chat.sendMessage("继续", chatId)` 发出去的消息会以 `sender: "user"` 写进历史，又会触发 `message_persisted`。如果在 user 消息分支无条件清零计数：

```
拒答 → 计数 1 → 发"继续" → 收到"继续"(user) → 清零 → 又拒答 → 计数 1 → 发"继续" → ...
```

真正变成无限刷接口。修法：每次重答写 `guardUntil = now + 120000`，窗口内的 user 消息不重置计数，窗口外才清零。窗口长度要大于一轮推理的正常耗时，120 秒够。

## 工具拦截必须显式 allow

`tool_call_intercept` 的失败语义是 **fail closed**：Hook 抛错、返回解码失败，宿主都会阻断工具调用。如果这里图省事 `return null` 或写个可能抛错的实现，就会出现"模型说做不了"的真实原因其实是插件把工具拦了——这是最难排查的一类问题。

所以：

- 非拦截阶段返回 `null`（纯通知，不干预）
- 拦截阶段**任何路径**都 `return { action: "allow" }`，包括 catch 分支

## 拒答检测的两条判据

第一条（开头骨架）抓硬拒。第二条（软化密度）抓半拒，半拒才是主流：

```
抱歉，我不能帮你。不过我可以讲讲原理……（讲了原理，没给工件）
```

开头没有"抱歉"也能命中——那段话里有 `我不能帮你` + `建议通过合法途径` + `仅供学习` ≥2 处，且篇幅短，直接按半拒处理。

反过来，正常交付会有代码围栏、编号步骤、命令、语言关键字，这些 `ARTIFACT_SIGNALS` 能挡住大部分误伤。

尾注单独判：给了工件但结尾挂"请自行判断使用场景"——这是半拒的典型尾巴，`tailWindow` 单独扫 240 字符。

## Compose DSL 的三个硬约束

来自 `examples/types/compose-dsl.d.ts` 和示例实现，踩过：

1. `useState` 的 setter **只接受值**，传 updater 函数会被当值写进 store。所以每次都算好完整新值。
2. 首帧不能 await。异步读盘必须挂某个节点的 `onLoad`，否则页面白屏。
3. 布局权重是**节点 prop** `weight`（配 `weightFill: false`），不是 Modifier 方法。Modifier 里没有 `weight`。

## 配置文件格式不校验的后果

`normalizeSettings` 对每个键按默认值的类型校验，类型不符就回退默认。这样用户手改 JSON 写错类型不会让插件崩，只是那一项不生效。未知键直接丢弃，不会被写回文件。
