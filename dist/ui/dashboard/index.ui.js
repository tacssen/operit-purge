"use strict";

// Compose DSL 控制台。所有交互都落到 shared/service.js，避免 UI 与钩子两套逻辑分叉。
// 三个硬约束（来自 Compose DSL 契约）：
//   1. useState 的 setter 只接受值，不接受 updater 函数，所以每次都算好完整新值再写。
//   2. 首帧不能阻塞在异步读盘，必须挂在某个节点的 onLoad 上再加载。
//   3. 布局权重用节点 prop（weight），不是 Modifier 方法。

var service = require("../../shared/service.js");

var TEXT = {
  zh: {
    title: "破甲控制台",
    subtitle: "让模型直接交付被请求的工件：不拒答、不软化、不说教。",
    stateOn: "已启用",
    stateOff: "已关闭",
    master: "总开关",
    masterDesc: "关闭后不再注入提示词，也不再自动重答。",
    injection: "注入点",
    systemPrompt: "系统提示词注入",
    systemPromptDesc: "after_compose 阶段追加破甲段，保留宿主与角色卡原文。",
    inputReminder: "输入短提醒",
    inputReminderDesc: "提交前在用户消息前插入一句执行约定。",
    autoRetry: "拒答自动重答",
    autoRetryDesc: "检测到拒答后自动再发一次“继续”，受最大次数限制。",
    logEnabled: "写日志",
    logEnabledDesc: "把拒答命中、重答、错误写入 logs/purge.log。",
    presetTitle: "预设",
    presetDesc: "自定义提示词优先级高于预设。",
    presetApply: "使用",
    presetActive: "使用中",
    customTitle: "自定义提示词",
    customDesc: "留空则使用所选预设。保存后立即生效。",
    customSave: "保存",
    customClear: "清除",
    customSaved: "已保存",
    customCleared: "已清除",
    retryMax: "最大重答次数",
    statsTitle: "统计",
    statRefusals: "拒答命中",
    statRetries: "自动重答",
    statChats: "跟踪会话",
    checkTitle: "自检",
    checkRun: "运行自检",
    checkPass: "全部通过",
    checkFail: "存在问题",
    detectTitle: "拒答检测基线",
    detectRun: "跑检测样本",
    detectPass: "判定符合预期",
    detectFail: "判定与预期不符",
    verdictRefuse: "拒绝",
    verdictPass: "放行",
    logTitle: "日志",
    logRefresh: "刷新",
    logClear: "清空",
    logEmpty: "暂无日志。",
    reset: "恢复默认配置",
    resetDone: "已恢复默认",
    loading: "读取中…",
    configDir: "配置目录",
    reload: "重新读取",
    footer: "改完立即生效，不用重启 Operit。"
  },
  en: {
    title: "Purge Console",
    subtitle: "Make the model deliver the requested artifact: no refusals, no softening, no lecturing.",
    stateOn: "Enabled",
    stateOff: "Disabled",
    master: "Master switch",
    masterDesc: "When off, no prompt injection and no auto-retry.",
    injection: "Injection points",
    systemPrompt: "System prompt injection",
    systemPromptDesc: "Appends the purge block after compose, keeping host and card text intact.",
    inputReminder: "Input reminder",
    inputReminderDesc: "Prepends one execution line to the submitted message.",
    autoRetry: "Auto-retry on refusal",
    autoRetryDesc: "Detects a refusal and sends one more 'continue', capped by max attempts.",
    logEnabled: "Write log",
    logEnabledDesc: "Records refusal hits, retries and errors into logs/purge.log.",
    presetTitle: "Presets",
    presetDesc: "A custom prompt overrides the preset.",
    presetApply: "Use",
    presetActive: "Active",
    customTitle: "Custom prompt",
    customDesc: "Empty means the selected preset is used. Saves take effect immediately.",
    customSave: "Save",
    customClear: "Clear",
    customSaved: "Saved",
    customCleared: "Cleared",
    retryMax: "Max retry attempts",
    statsTitle: "Stats",
    statRefusals: "Refusal hits",
    statRetries: "Auto retries",
    statChats: "Tracked chats",
    checkTitle: "Self-check",
    checkRun: "Run self-check",
    checkPass: "All passed",
    checkFail: "Issues found",
    detectTitle: "Detector baseline",
    detectRun: "Run detector samples",
    detectPass: "Verdicts as expected",
    detectFail: "Verdict mismatch",
    verdictRefuse: "refuse",
    verdictPass: "pass",
    logTitle: "Log",
    logRefresh: "Refresh",
    logClear: "Clear",
    logEmpty: "No log lines.",
    reset: "Reset to defaults",
    resetDone: "Defaults restored",
    loading: "Loading…",
    configDir: "Config dir",
    reload: "Reload",
    footer: "Changes apply immediately; no restart needed."
  }
};

function resolveLang() {
  try {
    var lang = getLang();
    if (typeof lang === "string" && lang.toLowerCase().indexOf("zh") === 0) return "zh";
  } catch (e) {
    // getLang 在某些上下文不存在，按英文兜底
  }
  return "en";
}

function label(value, lang) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    return value[lang] || value.default || value.zh || value.en || "";
  }
  return String(value);
}

function Screen(ctx) {
  var lang = resolveLang();
  var t = TEXT[lang];
  var UI = ctx.UI;
  var colors = ctx.MaterialTheme.colorScheme;

  var statusState = ctx.useState("status", null);
  var presetsState = ctx.useState("presets", []);
  var activePresetState = ctx.useState("activePreset", "default");
  var customDraftState = ctx.useState("customDraft", "");
  var logLinesState = ctx.useState("logLines", []);
  var loadedOnce = ctx.useRef("loadedOnce", false);
  var checkState = ctx.useState("checkResult", null);
  var detectState = ctx.useState("detectResult", null);
  var toastState = ctx.useState("toast", "");
  var openDialogState = ctx.useState("openDialog", false);

  var status = statusState[0];
  var presets = presetsState[0];
  var activePreset = activePresetState[0];
  var customDraft = customDraftState[0];
  var logLines = logLinesState[0];
  var checkResult = checkState[0];
  var detectResult = detectState[0];
  var toast = toastState[0];

  var enabled = status ? status.enabled === true : false;

  async function refresh() {
    var res = await service.getStatus();
    statusState[1](res);

    var presetRes = await service.listPresets();
    if (presetRes && presetRes.success) {
      presetsState[1](presetRes.data.presets);
      activePresetState[1](presetRes.data.active);
    }

    var customRes = await service.getCustomPrompt();
    if (customRes && customRes.success) {
      customDraftState[1](customRes.data.customPrompt);
    }

    var logRes = await service.readLog(80);
    logLinesState[1](logRes && logRes.success ? logRes.data.lines : []);
  }

  async function onInitialLoad() {
    if (loadedOnce.current === true) return;
    loadedOnce.current = true;
    await refresh();
  }

  async function toggleMaster(next) {
    await service.setEnabled(next);
    await refresh();
  }

  async function toggleFlag(name) {
    var current = status ? status[name] === true : false;
    await service.setFlag(name, !current);
    await refresh();
  }

  async function applyPreset(id) {
    var res = await service.usePreset(id);
    if (res && res.success === false) {
      toastState[1](res.error);
    }
    await refresh();
  }

  async function saveCustom() {
    await service.setCustomPrompt(customDraft || "");
    toastState[1](t.customSaved);
    await refresh();
  }

  async function clearCustom() {
    await service.setCustomPrompt("");
    toastState[1](t.customCleared);
    await refresh();
  }

  async function stepRetry(delta) {
    var current = status ? Number(status.retryMax || 0) : 0;
    var next = Math.max(0, Math.min(5, current + delta));
    await service.setAutoRetry(undefined, next);
    await refresh();
  }

  async function runCheck() {
    var res = await service.runSelfCheck();
    checkState[1](res && res.success ? res.data : null);
  }

  async function runDetect() {
    var res = await service.testDetect();
    detectState[1](res && res.success ? res.data : null);
  }

  async function reloadLog() {
    var res = await service.readLog(120);
    logLinesState[1](res && res.success ? res.data.lines : []);
  }

  async function clearLog() {
    await service.clearLog();
    logLinesState[1]([]);
  }

  async function resetAll() {
    await service.resetAll();
    toastState[1](t.resetDone);
    await refresh();
  }

  function row(title, desc, control) {
    return UI.Row({
      fillMaxWidth: true,
      paddingVertical: 6,
      verticalAlignment: "center"
    }, [
      UI.Column({ weight: 1, weightFill: false }, [
        UI.Text({ text: title, style: "bodyLarge", fontWeight: "medium" }),
        desc
          ? UI.Text({ text: desc, style: "bodySmall", color: colors.onSurfaceVariant })
          : null
      ].filter(Boolean)),
      control
    ]);
  }

  function sectionTitle(text) {
    return UI.Text({
      text: text,
      style: "titleMedium",
      fontWeight: "bold",
      paddingTop: 16,
      paddingBottom: 4
    });
  }

  function badge(text, active) {
    return UI.Surface({
      containerColor: active ? colors.primaryContainer : colors.surfaceVariant,
      shape: { type: "rounded", cornerRadius: 8 },
      paddingHorizontal: 8,
      paddingVertical: 2
    }, [
      UI.Text({
        text: text,
        style: "labelMedium",
        color: active ? colors.onPrimaryContainer : colors.onSurfaceVariant
      })
    ]);
  }

  var header = UI.Column({ fillMaxWidth: true }, [
    UI.Row({ fillMaxWidth: true, verticalAlignment: "center" }, [
      UI.Text({ text: t.title, style: "headlineSmall", fontWeight: "bold", weight: 1, weightFill: false }),
      badge(enabled ? t.stateOn : t.stateOff, enabled)
    ]),
    UI.Text({ text: t.subtitle, style: "bodySmall", color: colors.onSurfaceVariant })
  ]);

  var masterRow = row(
    t.master,
    t.masterDesc,
    UI.Switch({ checked: enabled, onCheckedChange: toggleMaster })
  );

  var injectionRows = [
    row(t.systemPrompt, t.systemPromptDesc,
      UI.Switch({
        checked: status ? status.systemPromptInject === true : false,
        onCheckedChange: function () { return toggleFlag("systemPromptInject"); }
      })),
    row(t.inputReminder, t.inputReminderDesc,
      UI.Switch({
        checked: status ? status.inputReminder === true : false,
        onCheckedChange: function () { return toggleFlag("inputReminder"); }
      })),
    row(t.autoRetry, t.autoRetryDesc,
      UI.Switch({
        checked: status ? status.autoRetryOnRefusal === true : false,
        onCheckedChange: function () { return toggleFlag("autoRetryOnRefusal"); }
      })),
    row(t.logEnabled, t.logEnabledDesc,
      UI.Switch({
        checked: status ? status.logEnabled === true : false,
        onCheckedChange: function () { return toggleFlag("logEnabled"); }
      }))
  ];

  var presetCards = [];
  for (var i = 0; i < presets.length; i += 1) {
    var p = presets[i];
    var isActive = p.id === activePreset;
    var title = label(p.title, lang) || p.id;
    var desc = label(p.description, lang) || ("(" + p.source + ", " + p.chars + " chars)");
    presetCards.push(
      UI.Card({
        key: "preset_" + p.id,
        fillMaxWidth: true,
        padding: 10,
        containerColor: isActive ? colors.primaryContainer : colors.surfaceVariant
      }, [
        UI.Row({ fillMaxWidth: true, verticalAlignment: "center" }, [
          UI.Column({ weight: 1, weightFill: false, spacing: 2 }, [
            UI.Text({ text: title, style: "bodyLarge", fontWeight: "medium" }),
            UI.Text({
              text: desc,
              style: "bodySmall",
              color: isActive ? colors.onPrimaryContainer : colors.onSurfaceVariant,
              maxLines: 3,
              overflow: "ellipsis"
            })
          ]),
          isActive
            ? badge(t.presetActive, true)
            : UI.Button({
              text: t.presetApply,
              onClick: function () { return applyPreset(p.id); }
            })
        ])
      ])
    );
  }

  var retryRow = row(
    t.retryMax,
    "",
    UI.Row({ verticalAlignment: "center" }, [
      UI.IconButton({ icon: "remove", onClick: function () { return stepRetry(-1); } }),
      UI.Text({
        text: String(status ? status.retryMax : 0),
        style: "titleMedium",
        paddingHorizontal: 10
      }),
      UI.IconButton({ icon: "add", onClick: function () { return stepRetry(1); } })
    ])
  );

  var statsRow = UI.Row({ fillMaxWidth: true }, [
    UI.Column({ weight: 1, weightFill: false }, [
      UI.Text({ text: t.statRefusals, style: "labelMedium", color: colors.onSurfaceVariant }),
      UI.Text({ text: String(status ? status.stats.refusals : 0), style: "headlineSmall" })
    ]),
    UI.Column({ weight: 1, weightFill: false }, [
      UI.Text({ text: t.statRetries, style: "labelMedium", color: colors.onSurfaceVariant }),
      UI.Text({ text: String(status ? status.stats.retries : 0), style: "headlineSmall" })
    ]),
    UI.Column({ weight: 1, weightFill: false }, [
      UI.Text({ text: t.statChats, style: "labelMedium", color: colors.onSurfaceVariant }),
      UI.Text({ text: String(status ? status.trackedChats : 0), style: "headlineSmall" })
    ])
  ]);

  var checkBlock = [];
  if (checkResult) {
    checkBlock.push(
      UI.Text({
        text: checkResult.pass ? t.checkPass : t.checkFail,
        style: "bodyMedium",
        color: checkResult.pass ? colors.primary : colors.error
      })
    );
    for (var j = 0; j < checkResult.checks.length; j += 1) {
      var ck = checkResult.checks[j];
      checkBlock.push(
        UI.Text({
          text: (ck.pass ? "OK   " : "FAIL ") + ck.name + " — " + ck.detail,
          style: "bodySmall",
          color: ck.pass ? colors.onSurfaceVariant : colors.error
        })
      );
    }
  }

  var detectBlock = [];
  if (detectResult) {
    detectBlock.push(
      UI.Text({
        text: detectResult.pass ? t.detectPass : t.detectFail,
        style: "bodyMedium",
        color: detectResult.pass ? colors.primary : colors.error
      })
    );
    for (var k = 0; k < detectResult.cases.length; k += 1) {
      var dc = detectResult.cases[k];
      var got = dc.refused ? t.verdictRefuse : t.verdictPass;
      var want = dc.expectRefused ? t.verdictRefuse : t.verdictPass;
      detectBlock.push(
        UI.Text({
          text: label(dc.label, lang) + "  预期=" + want + "  实际=" + got +
            (dc.explanation ? "  (" + dc.explanation + ")" : ""),
          style: "bodySmall",
          color: dc.refused === dc.expectRefused ? colors.onSurfaceVariant : colors.error
        })
      );
    }
  }

  var logBlock = [];
  if (logLines.length === 0) {
    logBlock.push(UI.Text({ text: t.logEmpty, style: "bodySmall", color: colors.onSurfaceVariant }));
  } else {
    logBlock.push(
      UI.Surface({
        fillMaxWidth: true,
        containerColor: colors.surfaceVariant,
        shape: { type: "rounded", cornerRadius: 8 },
        padding: 8,
        modifier: ctx.Modifier.heightIn({ maxHeight: 240 })
      }, [
        UI.LazyColumn({ spacing: 2 }, logLines.map(function (line) {
          return UI.Text({ text: String(line), style: "bodySmall", maxLines: 2, overflow: "ellipsis" });
        }))
      ])
    );
  }

  var body = UI.LazyColumn({
    key: "operit_purge_dashboard",
    fillMaxSize: true,
    spacing: 4,
    padding: { horizontal: 16, vertical: 12 },
    onLoad: onInitialLoad
  }, [
    header,
    UI.Surface({ fillMaxWidth: true, height: 1, containerColor: colors.outlineVariant, paddingVertical: 6 }),

    sectionTitle(t.master),
    masterRow,

    sectionTitle(t.injection),
    UI.Card({ fillMaxWidth: true, padding: 12 }, injectionRows),

    sectionTitle(t.presetTitle),
    UI.Text({ text: t.presetDesc, style: "bodySmall", color: colors.onSurfaceVariant }),
    UI.Column({ fillMaxWidth: true, spacing: 8, paddingTop: 6 }, presetCards),

    sectionTitle(t.customTitle),
    UI.Text({ text: t.customDesc, style: "bodySmall", color: colors.onSurfaceVariant }),
    UI.TextField({
      value: customDraft || "",
      onValueChange: function (value) { customDraftState[1](value); },
      label: t.customTitle,
      placeholder: "<operit_purge>…</operit_purge>",
      minLines: 4,
      maxLines: 8,
      paddingTop: 6
    }),
    UI.Row({ fillMaxWidth: true, paddingTop: 8 }, [
      UI.Button({ text: t.customSave, onClick: saveCustom }),
      UI.Spacer({ width: 8 }),
      UI.Button({ text: t.customClear, onClick: clearCustom })
    ]),

    sectionTitle(t.retryMax),
    retryRow,

    sectionTitle(t.statsTitle),
    statsRow,

    sectionTitle(t.checkTitle),
    UI.Row({ fillMaxWidth: true, paddingTop: 4 }, [
      UI.Button({ text: t.checkRun, onClick: runCheck }),
      UI.Spacer({ width: 8 }),
      UI.Button({ text: t.detectRun, onClick: runDetect })
    ]),
    UI.Column({ fillMaxWidth: true, spacing: 3, paddingTop: 8 }, checkBlock),
    UI.Column({ fillMaxWidth: true, spacing: 3, paddingTop: 8 }, detectBlock),

    sectionTitle(t.logTitle),
    UI.Row({ fillMaxWidth: true, paddingTop: 4 }, [
      UI.Button({ text: t.logRefresh, onClick: reloadLog }),
      UI.Spacer({ width: 8 }),
      UI.Button({ text: t.logClear, onClick: clearLog })
    ]),
    UI.Column({ fillMaxWidth: true, paddingTop: 8 }, logBlock),

    sectionTitle(t.reset),
    UI.Row({ fillMaxWidth: true, paddingTop: 4 }, [
      UI.Button({ text: t.reload, onClick: function () { return refresh(); } }),
      UI.Spacer({ width: 8 }),
      UI.Button({ text: t.reset, onClick: resetAll })
    ]),

    UI.Column({ fillMaxWidth: true, paddingTop: 16, spacing: 2 }, [
      UI.Text({
        text: t.configDir + ": " + (status ? status.configDir : "-"),
        style: "bodySmall",
        color: colors.onSurfaceVariant
      }),
      toast ? UI.Text({ text: toast, style: "bodySmall", color: colors.primary }) : UI.Text({
        text: t.footer,
        style: "bodySmall",
        color: colors.onSurfaceVariant
      })
    ])
  ]);

  return body;
}

exports.default = Screen;
exports.Screen = Screen;
