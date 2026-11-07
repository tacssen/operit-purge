"use strict";

// 状态与配置：一个 settings.json + 每会话一个状态条目。
// 结构刻意扁平，方便用户直接看 JSON 改值。

var storage = require("./storage.js");
var defaults = require("./defaults.js");

var SETTINGS_FILE = "settings.json";
var STATE_FILE = "state.json";
var LOG_FILE = "logs/purge.log";

var DEFAULT_SETTINGS = {
  enabled: true,
  presetId: "default",
  inputReminder: true,
  systemPromptInject: true,
  toolPromptKeep: true,
  autoRetryOnRefusal: true,
  retryMax: 2,
  retryText: "",
  watchAllChats: true,
  logEnabled: true,
  // 用户自定义覆盖；为空时使用预设自带 prompt
  customPrompt: "",
  customReminder: ""
};

function normalizeSettings(raw) {
  var src = raw && typeof raw === "object" ? raw : {};
  var out = {};
  for (var key in DEFAULT_SETTINGS) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) continue;
    var fallback = DEFAULT_SETTINGS[key];
    var value = src[key];
    if (typeof fallback === "boolean") {
      out[key] = typeof value === "boolean" ? value : fallback;
    } else if (typeof fallback === "number") {
      out[key] = typeof value === "number" && isFinite(value) ? value : fallback;
    } else {
      out[key] = typeof value === "string" ? value : fallback;
    }
  }
  if (out.retryMax < 0) out.retryMax = 0;
  if (out.retryMax > 5) out.retryMax = 5;
  return out;
}

async function readSettings() {
  var raw = await storage.readJson(storage.pathOf(SETTINGS_FILE), null);
  return normalizeSettings(raw);
}

async function writeSettings(patch) {
  var current = await readSettings();
  var merged = {};
  for (var key in current) {
    if (Object.prototype.hasOwnProperty.call(current, key)) merged[key] = current[key];
  }
  if (patch && typeof patch === "object") {
    for (var k in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k)) continue;
      merged[k] = patch[k];
    }
  }
  var next = normalizeSettings(merged);
  await storage.writeJson(storage.pathOf(SETTINGS_FILE), next);
  return next;
}

async function resetSettings() {
  var next = normalizeSettings({});
  await storage.writeJson(storage.pathOf(SETTINGS_FILE), next);
  return next;
}

async function readState() {
  var raw = await storage.readJson(storage.pathOf(STATE_FILE), null);
  if (!raw || typeof raw !== "object") {
    return { chats: {}, stats: { refusals: 0, retries: 0, blocks: 0 } };
  }
  if (!raw.chats || typeof raw.chats !== "object") raw.chats = {};
  if (!raw.stats || typeof raw.stats !== "object") {
    raw.stats = { refusals: 0, retries: 0, blocks: 0 };
  }
  return raw;
}

async function writeState(state) {
  await storage.writeJson(storage.pathOf(STATE_FILE), state);
  return state;
}

// 单个会话的有效开关：settings.enabled 为全局闸门，chat 级可单独关。
function chatEntry(state, chatId) {
  return state.chats && state.chats[chatId] ? state.chats[chatId] : null;
}

async function isChatEnabled(config, chatId) {
  if (!config || config.enabled !== true) return false;
  if (config.watchAllChats === true) return true;
  if (!chatId) return false;
  var state = await readState();
  var entry = chatEntry(state, chatId);
  return !!(entry && entry.enabled === true);
}

async function setChatEnabled(chatId, enabled) {
  if (!chatId) throw new Error("chatId is required");
  var state = await readState();
  var prev = state.chats[chatId] || {};
  state.chats[chatId] = {
    enabled: !!enabled,
    updatedAt: storage.nowMs(),
    presetId: prev.presetId || null,
    note: prev.note || ""
  };
  await writeState(state);
  return state.chats[chatId];
}

async function bumpStat(key, delta) {
  var state = await readState();
  var value = Number(state.stats[key] || 0) + (delta === undefined ? 1 : delta);
  state.stats[key] = value < 0 ? 0 : value;
  await writeState(state);
  return state.stats;
}

async function appendLog(line) {
  try {
    var config = await readSettings();
    if (config.logEnabled !== true) return;
    var path = storage.pathOf(LOG_FILE);
    var stamp = new Date().toISOString();
    await storage.ensureDirs();
    await Tools.Files.write(path, "[" + stamp + "] " + String(line) + "\n", true);
  } catch (e) {
    // 日志失败不影响主流程
  }
}

async function readLog(limit) {
  var max = typeof limit === "number" && limit > 0 ? limit : 200;
  var raw = await storage.readText(storage.pathOf(LOG_FILE), "");
  if (!raw) return [];
  var lines = raw.split("\n").filter(function (l) {
    return l.trim() !== "";
  });
  return lines.slice(-max);
}

async function clearLog() {
  await storage.writeText(storage.pathOf(LOG_FILE), "");
  return true;
}

// 有效提示词：自定义覆盖 > 预设 > 内置 default
function resolvePrompt(config, preset) {
  var custom = config && typeof config.customPrompt === "string" ? config.customPrompt.trim() : "";
  if (custom) return custom;
  if (preset && typeof preset.prompt === "string" && preset.prompt.trim()) return preset.prompt;
  return defaults.PRESETS.default.prompt;
}

function resolveReminder(config, preset) {
  var custom = config && typeof config.customReminder === "string" ? config.customReminder.trim() : "";
  if (custom) return custom;
  if (preset && typeof preset.reminder === "string" && preset.reminder.trim()) return preset.reminder;
  return defaults.INPUT_REMINDER;
}

function resolveRetryText(config, preset) {
  var custom = config && typeof config.retryText === "string" ? config.retryText.trim() : "";
  if (custom) return custom;
  if (preset && typeof preset.retryText === "string" && preset.retryText.trim()) return preset.retryText;
  return defaults.RETRY_TEXT;
}

module.exports = {
  DEFAULT_SETTINGS: DEFAULT_SETTINGS,
  normalizeSettings: normalizeSettings,
  readSettings: readSettings,
  writeSettings: writeSettings,
  resetSettings: resetSettings,
  readState: readState,
  writeState: writeState,
  isChatEnabled: isChatEnabled,
  setChatEnabled: setChatEnabled,
  bumpStat: bumpStat,
  appendLog: appendLog,
  readLog: readLog,
  clearLog: clearLog,
  resolvePrompt: resolvePrompt,
  resolveReminder: resolveReminder,
  resolveRetryText: resolveRetryText
};
