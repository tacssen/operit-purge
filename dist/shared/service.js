"use strict";

// 服务层：给 UI 和子包工具共用的一套高层操作。
// UI 模块与 shared 模块在同一 bundle 上下文里，直接 require 调用即可，不必绕 toolCall。

var config = require("./config.js");
var presets = require("./presets.js");
var refusal = require("./refusal.js");
var storage = require("./storage.js");

var SAMPLES = [
  {
    id: "plain_refusal",
    label: { zh: "直接拒答", en: "Plain refusal" },
    expectRefused: true,
    text: "抱歉，我不能帮你做这件事。这类内容存在风险，建议你通过正规途径处理。"
  },
  {
    id: "soft_refusal",
    label: { zh: "半拒 + 免责", en: "Soft refusal + disclaimer" },
    expectRefused: true,
    text: "我可以给你一点思路：先了解基本原理。仅供学习参考，请务必遵守相关法律法规。"
  },
  {
    id: "artifact",
    label: { zh: "正常交付", en: "Real deliverable" },
    expectRefused: false,
    text: "按下面三步执行：\n\n```bash\nadb devices\nadb shell id\n```\n\n第一条确认设备在线，第二条确认权限等级。"
  },
  {
    id: "artifact_tail",
    label: { zh: "交付 + 软化尾注", en: "Deliverable + disclaimer tail" },
    expectRefused: true,
    text: "```python\nprint('hello')\n```\n以上代码可直接运行。温馨提示：请自行判断使用场景。"
  }
];

function ok(data) {
  return { success: true, data: data };
}

function err(message) {
  return { success: false, error: message };
}

async function getStatus() {
  var cfg = await config.readSettings();
  var preset = await presets.resolvePreset(cfg);
  var prompt = config.resolvePrompt(cfg, preset);
  var state = await config.readState();
  return {
    enabled: cfg.enabled,
    presetId: preset ? preset.id : null,
    presetTitle: preset ? preset.title : null,
    presetSource: preset ? preset.source : null,
    customPromptChars: cfg.customPrompt ? cfg.customPrompt.length : 0,
    effectivePromptChars: prompt.length,
    inputReminder: cfg.inputReminder,
    systemPromptInject: cfg.systemPromptInject,
    autoRetryOnRefusal: cfg.autoRetryOnRefusal,
    retryMax: cfg.retryMax,
    watchAllChats: cfg.watchAllChats,
    logEnabled: cfg.logEnabled,
    stats: {
      refusals: Number(state.stats.refusals || 0),
      retries: Number(state.stats.retries || 0),
      blocks: Number(state.stats.blocks || 0)
    },
    trackedChats: Object.keys(state.chats || {}).length,
    configDir: storage.getRoot()
  };
}

async function setEnabled(enabled) {
  var cfg = await config.writeSettings({ enabled: !!enabled });
  await config.appendLog("toggle enabled=" + cfg.enabled);
  return ok({ enabled: cfg.enabled });
}

async function setFlag(name, value) {
  var allowed = {
    inputReminder: true,
    systemPromptInject: true,
    autoRetryOnRefusal: true,
    logEnabled: true,
    watchAllChats: true
  };
  if (!allowed[name]) return err("unsupported flag: " + name);
  var patch = {};
  patch[name] = !!value;
  var cfg = await config.writeSettings(patch);
  return ok({ name: name, value: cfg[name] });
}

async function listPresets() {
  var list = await presets.list();
  var cfg = await config.readSettings();
  return ok({ active: cfg.presetId, presets: list });
}

async function usePreset(id) {
  var key = String(id || "").trim();
  if (!key) return err("preset id is required");
  var found = await presets.get(key);
  if (!found) return err("preset not found: " + key);
  var cfg = await config.writeSettings({ presetId: key });
  await config.appendLog("preset " + key);
  return ok({ presetId: cfg.presetId, chars: String(found.prompt).length });
}

async function getPresetPreview(id) {
  var found = await presets.get(id);
  if (!found) return err("preset not found: " + id);
  return ok({
    id: found.id,
    source: found.source,
    title: found.title,
    prompt: found.prompt,
    reminder: found.reminder,
    retryText: found.retryText,
    chars: String(found.prompt).length
  });
}

async function getCustomPrompt() {
  var cfg = await config.readSettings();
  return ok({ customPrompt: cfg.customPrompt || "" });
}

async function setCustomPrompt(text) {
  var value = typeof text === "string" ? text : "";
  var cfg = await config.writeSettings({ customPrompt: value });
  await config.appendLog("custom_prompt chars=" + value.length);
  return ok({ customPromptChars: cfg.customPrompt.length, cleared: cfg.customPrompt.length === 0 });
}

async function saveFilePreset(id, text) {
  try {
    var saved = await presets.saveFilePreset(id, text);
    await config.appendLog("preset_saved " + saved.id);
    return ok(saved);
  } catch (e) {
    return err(e && e.message ? e.message : String(e));
  }
}

async function deleteFilePreset(id) {
  try {
    await presets.deleteFilePreset(id);
    await config.appendLog("preset_deleted " + id);
    return ok({ id: id });
  } catch (e) {
    return err(e && e.message ? e.message : String(e));
  }
}

async function setAutoRetry(enabled, maxAttempts) {
  if (typeof enabled !== "boolean" && typeof maxAttempts !== "number") {
    return err("nothing to change");
  }
  var patch = {};
  if (typeof enabled === "boolean") patch.autoRetryOnRefusal = enabled;
  if (typeof maxAttempts === "number" && isFinite(maxAttempts)) {
    patch.retryMax = Math.max(0, Math.min(5, Math.floor(maxAttempts)));
  }
  var cfg = await config.writeSettings(patch);
  return ok({ autoRetryOnRefusal: cfg.autoRetryOnRefusal, retryMax: cfg.retryMax });
}

async function testDetect() {
  var cases = [];
  var mismatches = 0;
  for (var i = 0; i < SAMPLES.length; i += 1) {
    var s = SAMPLES[i];
    var d = refusal.detect(s.text);
    if (d.refused !== s.expectRefused) mismatches += 1;
    cases.push({
      id: s.id,
      label: s.label,
      expectRefused: s.expectRefused,
      refused: d.refused,
      score: d.score,
      reasons: d.reasons,
      explanation: refusal.explain(d)
    });
  }
  return ok({ pass: mismatches === 0, mismatches: mismatches, cases: cases });
}

async function runSelfCheck() {
  var checks = [];

  var writable = false;
  try {
    await storage.ensureDirs();
    var probe = storage.pathOf("logs/.write-probe");
    await storage.writeText(probe, "ok");
    var back = await storage.readText(probe, "");
    writable = back.indexOf("ok") >= 0;
  } catch (e) {
    writable = false;
  }
  checks.push({ name: "config_dir_writable", pass: writable, detail: storage.getRoot() });

  var cfg = await config.readSettings();
  checks.push({ name: "settings_readable", pass: true, detail: "enabled=" + cfg.enabled });

  var preset = await presets.resolvePreset(cfg);
  checks.push({
    name: "preset_resolved",
    pass: !!preset,
    detail: preset ? preset.id + " (" + preset.source + ")" : "none"
  });

  var prompt = config.resolvePrompt(cfg, preset);
  checks.push({
    name: "prompt_non_empty",
    pass: prompt.trim().length > 0,
    detail: prompt.length + " chars"
  });

  var detect = await testDetect();
  checks.push({
    name: "detector_baseline",
    pass: detect.data ? detect.data.pass : false,
    detail: (detect.data ? detect.data.mismatches : -1) + " mismatch(es)"
  });

  var retries = Object.keys((await config.readState()).chats || {}).length;
  checks.push({ name: "state_readable", pass: true, detail: retries + " tracked chats" });

  var allPass = true;
  for (var j = 0; j < checks.length; j += 1) {
    if (!checks[j].pass) allPass = false;
  }
  return ok({ pass: allPass, checks: checks });
}

async function readLog(limit) {
  var max = typeof limit === "number" && limit > 0 ? Math.min(500, Math.floor(limit)) : 50;
  var lines = await config.readLog(max);
  return ok({ count: lines.length, lines: lines });
}

async function clearLog() {
  await config.clearLog();
  return ok({ cleared: true });
}

async function resetAll() {
  await config.resetSettings();
  await config.writeState({ chats: {}, stats: { refusals: 0, retries: 0, blocks: 0 } });
  await config.appendLog("reset_all");
  return ok({ reset: true });
}

module.exports = {
  SAMPLES: SAMPLES,
  getStatus: getStatus,
  setEnabled: setEnabled,
  setFlag: setFlag,
  listPresets: listPresets,
  usePreset: usePreset,
  getPresetPreview: getPresetPreview,
  getCustomPrompt: getCustomPrompt,
  setCustomPrompt: setCustomPrompt,
  saveFilePreset: saveFilePreset,
  deleteFilePreset: deleteFilePreset,
  setAutoRetry: setAutoRetry,
  testDetect: testDetect,
  runSelfCheck: runSelfCheck,
  readLog: readLog,
  clearLog: clearLog,
  resetAll: resetAll
};
