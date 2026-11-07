"use strict";

// 提示词拼装：把所有注入点收敛到几个纯函数，便于单测。

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function appendBlock(base, extra) {
  var b = nonEmpty(base) ? base.trim() : "";
  var e = nonEmpty(extra) ? extra.trim() : "";
  if (!e) return b;
  if (!b) return e;
  return b + "\n\n" + e;
}

function prependBlock(base, extra) {
  var b = nonEmpty(base) ? base.trim() : "";
  var e = nonEmpty(extra) ? extra.trim() : "";
  if (!e) return b;
  if (!b) return e;
  return e + "\n\n" + b;
}

// system prompt：追加到末尾，避免破坏宿主原有的分段结构。
// 幂等：宿主可能在一轮里多次 compose，已经带标记就不再追加，防止 N 份提示词。
function composeSystemPrompt(currentPrompt, purgePrompt) {
  if (!nonEmpty(purgePrompt)) return null;
  var base = nonEmpty(currentPrompt) ? currentPrompt : "";
  if (base.indexOf("</operit_purge>") >= 0) return null;
  return appendBlock(base, purgePrompt);
}

// 用户输入：短提醒放在最前面，模型更容易把它当本轮指令而不是历史内容。
// 幂等：已经有一份就返回 null；有多份则收敛成一份（宿主可能把 replace 结果回写输入框）。
function composeInput(text, reminder) {
  if (!nonEmpty(text) || !nonEmpty(reminder)) return null;

  var count = 0;
  var idx = text.indexOf(reminder);
  while (idx >= 0) {
    count += 1;
    idx = text.indexOf(reminder, idx + reminder.length);
  }

  if (count === 0) {
    return reminder + "\n" + text;
  }
  if (count === 1) {
    return null;
  }
  var body = text.split(reminder).join("").trim();
  return reminder + "\n" + body;
}

function toPromptTurnKind(kind) {
  var k = String(kind || "").trim().toUpperCase();
  if (k === "SYSTEM" || k === "USER" || k === "ASSISTANT" || k === "SUMMARY") return k;
  if (k === "TOOL_CALL" || k === "TOOLCALL") return "TOOL_CALL";
  if (k === "TOOL_RESULT" || k === "TOOLRESULT") return "TOOL_RESULT";
  return null;
}

// preparedHistory：没有 SYSTEM 时插入一条，有则在第一条 SYSTEM 后追加。
// 用追加而不是替换，保留宿主/角色卡原有内容。
function appendToHistory(history, purgePrompt) {
  if (!nonEmpty(purgePrompt)) return null;
  if (!Array.isArray(history)) return null;
  var next = history.slice();
  var systemIndex = -1;
  for (var i = 0; i < next.length; i += 1) {
    var item = next[i];
    if (!item || typeof item !== "object") continue;
    if (toPromptTurnKind(item.kind) === "SYSTEM") {
      systemIndex = i;
      break;
    }
  }
  if (systemIndex < 0) {
    var head = { kind: "SYSTEM", content: purgePrompt.trim() };
    next.unshift(head);
    return next;
  }
  var turn = next[systemIndex];
  var content = nonEmpty(turn.content) ? turn.content : "";
  // 幂等：已经注入过就不再叠加
  if (content.indexOf("</operit_purge>") >= 0) return null;
  next[systemIndex] = {
    kind: turn.kind,
    content: appendBlock(content, purgePrompt)
  };
  if (turn.toolName !== undefined && turn.toolName !== null) {
    next[systemIndex].toolName = turn.toolName;
  }
  if (turn.metadata !== undefined && turn.metadata !== null) {
    next[systemIndex].metadata = turn.metadata;
  }
  return next;
}

// 历史里每轮都带一句提醒会白白吃 token，而且会稀释本轮的那一句。
// 策略：除最后一个 USER 轮，其余 USER 轮的提醒前缀全部剥掉。
function stripReminderFromHistory(history, reminder) {
  if (!nonEmpty(reminder) || !Array.isArray(history)) return null;
  var lastUser = -1;
  for (var i = 0; i < history.length; i += 1) {
    var item = history[i];
    if (item && typeof item === "object" && toPromptTurnKind(item.kind) === "USER") lastUser = i;
  }
  if (lastUser < 0) return null;

  var changed = false;
  var next = history.map(function (item, index) {
    if (!item || typeof item !== "object") return item;
    if (toPromptTurnKind(item.kind) !== "USER") return item;
    if (index === lastUser) return item;
    var content = typeof item.content === "string" ? item.content : "";
    if (!content || content.indexOf(reminder) < 0) return item;
    var stripped = content.split(reminder).join("").replace(/^\s*\n/, "").trim();
    if (!stripped) return item;
    var clone = { kind: item.kind, content: stripped };
    if (item.toolName !== undefined && item.toolName !== null) clone.toolName = item.toolName;
    if (item.metadata !== undefined && item.metadata !== null) clone.metadata = item.metadata;
    changed = true;
    return clone;
  });

  return changed ? next : null;
}

// 只处理主聊天链路；摘要、标题生成等不应被注入。
function isChatPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  var promptFunctionType = payload.promptFunctionType;
  if (typeof promptFunctionType === "string" && promptFunctionType.trim() !== "") {
    return promptFunctionType.trim().toUpperCase() === "CHAT";
  }
  var functionType = payload.functionType;
  if (typeof functionType === "string" && functionType.trim() !== "") {
    return functionType.trim().toUpperCase() === "CHAT";
  }
  return true;
}

function resolveStage(event) {
  if (!event || typeof event !== "object") return "";
  var payload = event.eventPayload;
  if (payload && typeof payload.stage === "string" && payload.stage.trim() !== "") {
    return payload.stage.trim();
  }
  return typeof event.eventName === "string" ? event.eventName : "";
}

module.exports = {
  nonEmpty: nonEmpty,
  appendBlock: appendBlock,
  prependBlock: prependBlock,
  composeSystemPrompt: composeSystemPrompt,
  composeInput: composeInput,
  appendToHistory: appendToHistory,
  stripReminderFromHistory: stripReminderFromHistory,
  isChatPayload: isChatPayload,
  resolveStage: resolveStage
};
