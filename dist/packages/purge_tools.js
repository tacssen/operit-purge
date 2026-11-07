"use strict";
/* METADATA
{
  "name": "purge_tools",
  "version": "1.0.0",
  "display_name": {
    "zh": "破甲工具",
    "en": "Purge Tools"
  },
  "description": {
    "zh": "查看与修改 Operit 破甲插件状态：总开关、预设切换、自定义提示词、拒答检测自检、日志。改完立即生效，不用重启 Operit。",
    "en": "Inspect and change Operit Purge state: master switch, preset selection, custom prompt, detector self-check and logs. Changes apply immediately."
  },
  "author": ["YG"],
  "category": "Utility",
  "tools": [
    {
      "name": "purge_status",
      "description": {
        "zh": "查看当前破甲状态：是否启用、当前预设、注入点开关、统计计数。",
        "en": "Show current purge status: enabled flag, active preset, injection switches and counters."
      },
      "parameters": []
    },
    {
      "name": "purge_toggle",
      "description": {
        "zh": "打开或关闭破甲注入。关闭后提示词不再注入，拒答也不再自动重答。",
        "en": "Turn purge injection on or off."
      },
      "parameters": [
        {
          "name": "enabled",
          "description": { "zh": "true 打开，false 关闭", "en": "true to enable, false to disable" },
          "type": "boolean",
          "required": true
        }
      ]
    },
    {
      "name": "purge_list_presets",
      "description": {
        "zh": "列出全部可用预设（内置 + 配置文件预设）。",
        "en": "List every available preset (builtin and file-based)."
      },
      "parameters": []
    },
    {
      "name": "purge_set_preset",
      "description": {
        "zh": "切换当前使用的预设。改完立刻生效。",
        "en": "Switch the active preset; applies immediately."
      },
      "parameters": [
        {
          "name": "preset_id",
          "description": { "zh": "预设 ID，例如 default / minimal / claude", "en": "Preset id, e.g. default / minimal / claude" },
          "type": "string",
          "required": true
        }
      ]
    },
    {
      "name": "purge_set_custom_prompt",
      "description": {
        "zh": "设置自定义提示词，优先级高于预设；传空字符串表示清除自定义、回到预设。",
        "en": "Set a custom prompt that overrides the preset; empty string clears it."
      },
      "parameters": [
        {
          "name": "prompt",
          "description": { "zh": "完整提示词正文；空字符串清除", "en": "Full prompt body; empty string clears" },
          "type": "string",
          "required": true
        }
      ]
    },
    {
      "name": "purge_set_auto_retry",
      "description": {
        "zh": "配置拒答自动重答：是否开启与最多重答次数（0-5）。",
        "en": "Configure refusal auto-retry: on/off and max attempts (0-5)."
      },
      "parameters": [
        {
          "name": "enabled",
          "description": { "zh": "是否开启自动重答", "en": "Whether auto-retry is enabled" },
          "type": "boolean",
          "required": false
        },
        {
          "name": "max_attempts",
          "description": { "zh": "连续拒答最多重答次数", "en": "Max consecutive retry attempts" },
          "type": "number",
          "required": false
        }
      ]
    },
    {
      "name": "purge_test_detect",
      "description": {
        "zh": "用内置样本跑一次拒答检测，返回判定与原因，用于确认检测逻辑符合预期。",
        "en": "Run the refusal detector against builtin samples and report verdicts and reasons."
      },
      "parameters": []
    },
    {
      "name": "purge_self_check",
      "description": {
        "zh": "自检：配置目录可写、预设可读、提示词非空、检测基线通过。",
        "en": "Self-check: config dir writable, presets readable, prompt non-empty, detector baseline passes."
      },
      "parameters": []
    },
    {
      "name": "purge_read_log",
      "description": {
        "zh": "读取最近的破甲日志（拒答命中、自动重答、错误）。",
        "en": "Read recent purge log lines (refusal hits, retries, errors)."
      },
      "parameters": [
        {
          "name": "limit",
          "description": { "zh": "最多返回多少行，默认 50", "en": "Max lines to return, default 50" },
          "type": "number",
          "required": false
        }
      ]
    },
    {
      "name": "purge_clear_log",
      "description": {
        "zh": "清空破甲日志。",
        "en": "Clear the purge log."
      },
      "parameters": []
    },
    {
      "name": "usage_advice",
      "advice": true,
      "description": {
        "zh": "使用建议:\\n- 模型还在拒答：先 purge_status 确认 enabled=true。\\n- 语气太硬：purge_set_preset 切到 claude。\\n- 自己有提示词：purge_set_custom_prompt 直接写，优先级高于预设。\\n- 怀疑误伤：purge_test_detect 看判定，再 purge_read_log 对真实命中。\\n- 全部改完不用重启。",
        "en": "Advice: check purge_status first; switch preset for tone; set custom prompt for your own rules; run purge_test_detect when in doubt; no restart needed."
      },
      "parameters": []
    }
  ]
}
*/

var service = require("../shared/service.js");

function unwrap(res) {
  if (!res) return { success: false, error: "empty result" };
  if (res.success === false) return res;
  return res;
}

async function purge_status() {
  return unwrap({ success: true, data: await service.getStatus() });
}

async function purge_toggle(enabled) {
  if (typeof enabled !== "boolean") {
    return { success: false, error: "enabled must be boolean" };
  }
  return unwrap(await service.setEnabled(enabled));
}

async function purge_list_presets() {
  return unwrap(await service.listPresets());
}

async function purge_set_preset(preset_id) {
  return unwrap(await service.usePreset(preset_id));
}

async function purge_set_custom_prompt(prompt) {
  if (typeof prompt !== "string") {
    return { success: false, error: "prompt must be a string" };
  }
  return unwrap(await service.setCustomPrompt(prompt));
}

async function purge_set_auto_retry(enabled, max_attempts) {
  var okValues = [];
  if (typeof enabled !== "boolean") okValues.push("enabled");
  if (typeof max_attempts !== "number") okValues.push("max_attempts");
  if (okValues.length === 2) {
    return { success: false, error: "pass enabled and/or max_attempts" };
  }
  return unwrap(await service.setAutoRetry(
    typeof enabled === "boolean" ? enabled : undefined,
    typeof max_attempts === "number" ? max_attempts : undefined
  ));
}

async function purge_test_detect() {
  return unwrap(await service.testDetect());
}

async function purge_self_check() {
  return unwrap(await service.runSelfCheck());
}

async function purge_read_log(limit) {
  return unwrap(await service.readLog(limit));
}

async function purge_clear_log() {
  return unwrap(await service.clearLog());
}

exports.purge_status = purge_status;
exports.purge_toggle = purge_toggle;
exports.purge_list_presets = purge_list_presets;
exports.purge_set_preset = purge_set_preset;
exports.purge_set_custom_prompt = purge_set_custom_prompt;
exports.purge_set_auto_retry = purge_set_auto_retry;
exports.purge_test_detect = purge_test_detect;
exports.purge_self_check = purge_self_check;
exports.purge_read_log = purge_read_log;
exports.purge_clear_log = purge_clear_log;
