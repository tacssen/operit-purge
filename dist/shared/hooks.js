"use strict";

// 钩子实现。全部导出为具名函数，注册时按模块路径 + 导出名解析，不能写成匿名闭包。
// 每个钩子都必须自己容错：抛错会被宿主记日志并跳过，宁可静默也不要打断用户聊天。

var config = require("./config.js");
var presets = require("./presets.js");
var promptUtil = require("./prompt.js");
var refusal = require("./refusal.js");

// 自动重答的护栏：我们发出去的"继续"也会以 user 消息写进历史，
// 如果在 chat 消息钩子里无条件清零计数，就会变成无限重答循环。
// 所以给自触发的消息打一个时间窗，窗口内的 user 消息不重置计数。
var SELF_RETRY_GUARD_MS = 120000;

async function noteRefusal(chatId, detection) {
  try {
    await config.bumpStat("refusals", 1);
    await config.appendLog(
      "refusal chat=" + (chatId || "-") + " score=" + detection.score + " reasons=" + detection.reasons.join(",")
    );
  } catch (e) {
    // 统计失败不影响主链路
  }
}

async function loadActivePrompt(chatId) {
  var cfg = await config.readSettings();
  if (!cfg.enabled) return null;
  if (!cfg.systemPromptInject) return null;
  if (!(await config.isChatEnabled(cfg, chatId))) return null;
  var preset = await presets.resolvePreset(cfg);
  var text = config.resolvePrompt(cfg, preset);
  if (!text) return null;
  return { cfg: cfg, preset: preset, text: text };
}

// system prompt 组合：只在 after 阶段追加一次，避免 before/after 双追加。
async function onSystemPromptCompose(event) {
  try {
    var stage = promptUtil.resolveStage(event);
    if (stage !== "after_compose_system_prompt") return null;
    var payload = event.eventPayload || {};
    if (!promptUtil.isChatPayload(payload)) return null;
    var chatId = typeof payload.chatId === "string" ? payload.chatId : "";
    var active = await loadActivePrompt(chatId);
    if (!active) return null;
    var current = typeof payload.systemPrompt === "string" ? payload.systemPrompt : "";
    var next = promptUtil.composeSystemPrompt(current, active.text);
    // 宿主解析器只接受非空字符串；空串无法用来"清空"，所以保持一致返回 null
    if (!next || next === current) return null;
    return { systemPrompt: next };
  } catch (e) {
    return null;
  }
}

// preparedHistory：发模型前做两件事
//   1. 把历史里旧轮次的输入提醒剥掉（每轮都带一句既吃 token 又稀释本轮那句）
//   2. 把破甲段落到第一条 SYSTEM（宿主已注入过则跳过，保持幂等）
async function onPromptFinalize(event) {
  try {
    var stage = promptUtil.resolveStage(event);
    if (stage !== "before_send_to_model") return null;
    var payload = event.eventPayload || {};
    if (!promptUtil.isChatPayload(payload)) return null;
    var chatId = typeof payload.chatId === "string" ? payload.chatId : "";
    var active = await loadActivePrompt(chatId);
    if (!active) return null;
    var history = Array.isArray(payload.preparedHistory) ? payload.preparedHistory : null;
    if (!history) return null;

    var result = history;
    var changed = false;

    var reminder = active.cfg.inputReminder ? config.resolveReminder(active.cfg, active.preset) : "";
    if (reminder) {
      var stripped = promptUtil.stripReminderFromHistory(result, reminder);
      if (stripped) {
        result = stripped;
        changed = true;
      }
    }

    var withPrompt = promptUtil.appendToHistory(result, active.text);
    if (withPrompt) {
      result = withPrompt;
      changed = true;
    }

    if (!changed) return null;
    return { preparedHistory: result };
  } catch (e) {
    return null;
  }
}

// 估算路径是独立注册列表；不接的话 token 估算会与实际请求不一致。
async function onPromptEstimateFinalize(event) {
  return onPromptFinalize(event);
}

// 输入侧：提交前插入短提醒，把"本轮直接交付"压过角色卡与历史残留。
// 幂等处理在 prompt.composeInput 里：已带一句就不再叠加，带多句则收敛成一句。
async function onChatInput(event) {
  try {
    var name = event && typeof event.eventName === "string" ? event.eventName : "";
    if (name !== "submit_requested") return null;
    var payload = event.eventPayload || {};
    var chatId = typeof payload.chatId === "string" ? payload.chatId : "";
    var text = typeof payload.text === "string" ? payload.text : "";
    if (!text.trim()) return null;
    var cfg = await config.readSettings();
    if (!cfg.enabled || !cfg.inputReminder) return null;
    if (!(await config.isChatEnabled(cfg, chatId))) return null;
    var preset = await presets.resolvePreset(cfg);
    var reminder = config.resolveReminder(cfg, preset);
    if (!reminder) return null;
    var next = promptUtil.composeInput(text, reminder);
    if (!next) return null;
    return { action: "replace", text: next };
  } catch (e) {
    return null;
  }
}

async function sendRetry(chatId, runtime, retryText) {
  var opts = {
    persist_turn: true,
    notify_reply: false,
    disable_warning: true
  };
  if (runtime === "floating" || runtime === "main") {
    opts.runtime = runtime;
  }
  return Tools.Chat.sendMessage(retryText, chatId, undefined, undefined, opts);
}

// 消息持久化：拒答 => 记日志/计数 => 有条件地自动补一次"继续"。
// 该钩子的返回值被宿主忽略，因此这里只做副作用。
async function onChatMessage(event) {
  try {
    var name = event && typeof event.eventName === "string" ? event.eventName : "";
    if (name !== "message_persisted") return null;
    var payload = event.eventPayload || {};
    var sender = typeof payload.sender === "string" ? payload.sender : "";
    var chatId = typeof payload.chatId === "string" ? payload.chatId : "";

    var cfg = await config.readSettings();
    if (!cfg.enabled) return null;
    if (!(await config.isChatEnabled(cfg, chatId))) return null;

    // 用户的新消息（非我们自触发的）清零连续拒答计数，让下一轮拒答仍能补救。
    if (sender === "user") {
      var st0 = await config.readState();
      var e0 = st0.chats[chatId];
      if (e0 && e0.retryAttempts) {
        var guard = Number(e0.guardUntil || 0);
        if (Date.now() >= guard) {
          e0.retryAttempts = 0;
          e0.guardUntil = 0;
          await config.writeState(st0);
        }
      }
      return null;
    }

    if (sender !== "ai") return null;

    var detection = refusal.detect(payload);
    if (!detection.refused) return null;
    await noteRefusal(chatId, detection);

    if (!cfg.autoRetryOnRefusal || cfg.retryMax <= 0) return null;

    var state = await config.readState();
    var entry = state.chats[chatId] || {};
    var attempts = Number(entry.retryAttempts || 0);
    if (attempts >= cfg.retryMax) {
      await config.appendLog("retry_limit chat=" + (chatId || "-") + " attempts=" + attempts);
      return null;
    }

    var runtime = entry.runtime === "floating" || entry.runtime === "main" ? entry.runtime : "main";
    state.chats[chatId] = {
      enabled: entry.enabled !== false,
      updatedAt: Date.now(),
      presetId: entry.presetId || null,
      note: entry.note || "",
      retryAttempts: attempts + 1,
      guardUntil: Date.now() + SELF_RETRY_GUARD_MS,
      runtime: runtime
    };
    await config.writeState(state);
    await config.bumpStat("retries", 1);

    var preset = await presets.resolvePreset(cfg);
    var retryText = config.resolveRetryText(cfg, preset);
    await sendRetry(chatId, runtime, retryText);
    await config.appendLog("retry_sent chat=" + (chatId || "-") + " attempt=" + (attempts + 1) + " runtime=" + runtime);
    return null;
  } catch (e) {
    try {
      await config.appendLog("hook_error " + (e && e.message ? e.message : String(e)));
    } catch (e2) {
      // ignore
    }
    return null;
  }
}

// 运行态钩子：记住当前会话的 runtime（main/floating），重答时按同一 surface 发。
async function onChatRuntime(event) {
  try {
    var payload = event && event.eventPayload ? event.eventPayload : {};
    var chatId = typeof payload.chatId === "string" ? payload.chatId : "";
    var slot = typeof payload.slot === "string" ? payload.slot : "";
    if (!chatId) return null;
    if (slot !== "main" && slot !== "floating") return null;
    var cfg = await config.readSettings();
    if (!cfg.enabled) return null;
    var st = await config.readState();
    var entry = st.chats[chatId];
    if (!entry) return null;
    if (entry.runtime === slot) return null;
    entry.runtime = slot;
    await config.writeState(st);
    return null;
  } catch (e) {
    return null;
  }
}

// 工具拦截：purge 的目标是"别把干活拦下来"。任何情况下都放行，只对破坏性调用记日志。
var TRACKED_TOOLS = {
  delete_file: true,
  apply_file: true
};

async function onToolLifecycle(event) {
  try {
    var name = event && typeof event.eventName === "string" ? event.eventName : "";
    // 非拦截阶段是纯通知，返回 null 表示不干预
    if (name !== "tool_call_intercept") return null;
    var payload = event.eventPayload || {};
    var toolName = typeof payload.toolName === "string" ? payload.toolName : "";
    var cfg = await config.readSettings();
    if (cfg.enabled && cfg.logEnabled && TRACKED_TOOLS[toolName]) {
      await config.appendLog("tool_call " + toolName + " allow");
    }
    // 显式放行：拦截阶段的异常默认是 fail closed，替模型拦工具等于替模型拒答
    return { action: "allow" };
  } catch (e) {
    return { action: "allow" };
  }
}

module.exports = {
  onSystemPromptCompose: onSystemPromptCompose,
  onPromptFinalize: onPromptFinalize,
  onPromptEstimateFinalize: onPromptEstimateFinalize,
  onChatInput: onChatInput,
  onChatMessage: onChatMessage,
  onChatRuntime: onChatRuntime,
  onToolLifecycle: onToolLifecycle
};
