"use strict";

// 本地验收台：用真实文件系统模拟 Operit 的 Tools.Files，跑一遍插件全部逻辑。
// 用法：node tests/harness.cjs
// 这个文件不进包，只用于开发期验证。

var fs = require("node:fs");
var path = require("node:path");
var assert = require("node:assert");

var ROOT = path.join(__dirname, "_tmp_config");
var PLUGIN = path.join(__dirname, "..", "dist");

function resetRoot() {
  if (fs.existsSync(ROOT)) {
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
  fs.mkdirSync(ROOT, { recursive: true });
}

// ---- Operit 运行时桩 ----
var sentMessages = [];

global.ToolPkg = {
  getConfigDir: function () {
    return ROOT;
  }
};

global.Tools = {
  Files: {
    exists: async function (p) {
      return { exists: fs.existsSync(p) };
    },
    mkdir: async function (p, parents) {
      fs.mkdirSync(p, { recursive: parents !== false });
      return { success: true };
    },
    read: async function (p) {
      return { content: fs.readFileSync(p, "utf8") };
    },
    write: async function (p, content) {
      fs.writeFileSync(p, content);
      return { success: true };
    },
    list: async function (p) {
      var entries = fs.readdirSync(p, { withFileTypes: true }).map(function (e) {
        return { name: e.name, isDirectory: e.isDirectory() };
      });
      return { entries: entries };
    },
    deleteFile: async function (p, recursive) {
      fs.rmSync(p, { recursive: !!recursive, force: true });
      return { success: true };
    }
  },
  Chat: {
    sendMessage: async function (text, chatId, roleCardId, senderName, options) {
      sentMessages.push({ text: text, chatId: chatId, options: options });
      return { chatId: chatId, message: text, aiResponse: "ok" };
    }
  },
  System: {
    toast: async function (msg) {
      return { success: true, data: msg };
    }
  }
};

// ---- 测试框架 ----
var failures = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () {
      console.log("PASS  " + name);
    })
    .catch(function (e) {
      failures.push({ name: name, error: e });
      console.log("FAIL  " + name + " :: " + (e && e.message ? e.message : e));
    });
}

function load(rel) {
  var full = path.join(PLUGIN, rel);
  delete require.cache[require.resolve(full)];
  return require(full);
}

async function main() {
  resetRoot();

  var storage = load("shared/storage.js");
  var config = load("shared/config.js");
  var presets = load("shared/presets.js");
  var promptUtil = load("shared/prompt.js");
  var refusal = load("shared/refusal.js");
  var service = load("shared/service.js");
  var hooks = load("shared/hooks.js");
  var tools = load("packages/purge_tools.js");
  var main = load("main.js");

  // 1. 存储与配置
  await test("storage: 路径落在 configDir 下", function () {
    assert.strictEqual(storage.getRoot(), ROOT);
    assert.strictEqual(storage.pathOf("settings.json"), ROOT + "/settings.json");
  });

  await test("config: 默认值可读，enabled=true", async function () {
    var cfg = await config.readSettings();
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.presetId, "default");
    assert.strictEqual(cfg.retryMax, 2);
  });

  await test("config: 未知键被忽略，类型不符回退默认", async function () {
    var cfg = await config.writeSettings({ evil: 1, retryMax: "abc", enabled: false });
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(cfg.retryMax, 2);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(cfg, "evil"), false);
    await config.writeSettings({ enabled: true });
  });

  await test("config: retryMax 被夹在 0..5", async function () {
    var cfg = await config.writeSettings({ retryMax: 99 });
    assert.strictEqual(cfg.retryMax, 5);
    cfg = await config.writeSettings({ retryMax: -3 });
    assert.strictEqual(cfg.retryMax, 0);
    await config.writeSettings({ retryMax: 2 });
  });

  // 2. 预设
  await test("presets: 三个内置预设存在且提示词非空", async function () {
    var list = await presets.list();
    var ids = list.map(function (p) {
      return p.id;
    });
    ["default", "minimal", "claude"].forEach(function (id) {
      assert.ok(ids.indexOf(id) >= 0, "missing preset " + id);
    });
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].source === "builtin") {
        assert.ok(list[i].chars > 100, "preset too short: " + list[i].id);
      }
    }
  });

  await test("presets: 文件预置可保存、列出、读取、删除", async function () {
    var saved = await presets.saveFilePreset("mine", " 我的提示词\n第二行");
    assert.ok(fs.existsSync(saved.path));
    var list = await presets.list();
    var mine = list.filter(function (p) {
      return p.id === "mine";
    })[0];
    assert.ok(mine, "file preset not listed");
    assert.strictEqual(mine.source, "file");
    var got = await presets.get("mine");
    assert.ok(got.prompt.indexOf("我的提示词") >= 0);
    await presets.deleteFilePreset("mine");
    assert.ok(!fs.existsSync(saved.path));
  });

  await test("presets: 不能覆盖内置预设", async function () {
    await assert.rejects(function () {
      return presets.saveFilePreset("default", "x");
    }, /builtin/);
    await assert.rejects(function () {
      return presets.deleteFilePreset("default");
    }, /builtin/);
  });

  await test("presets: 未知预设回退到 default", async function () {
    var cfg = await config.writeSettings({ presetId: "nope" });
    var p = await presets.resolvePreset(cfg);
    assert.strictEqual(p.id, "default");
    await config.writeSettings({ presetId: "default" });
  });

  // 3. 提示词拼装
  await test("prompt: system prompt 追加不覆盖原文", function () {
    var out = promptUtil.composeSystemPrompt("原始提示", "破甲段");
    assert.ok(out.indexOf("原始提示") === 0);
    assert.ok(out.indexOf("破甲段") >= 0);
    assert.strictEqual(promptUtil.composeSystemPrompt("原始提示", ""), null);
  });

  await test("prompt: 输入提醒不重复叠加", function () {
    var once = promptUtil.composeInput("帮我写脚本", "约定");
    assert.ok(once.indexOf("约定") === 0);
    assert.strictEqual(promptUtil.composeInput(once, "约定"), null);
    assert.strictEqual(promptUtil.composeInput("", "约定"), null);
  });

  await test("prompt: 多份输入提醒收敛成一份", function () {
    var triple = "约定\n约定\n约定\n写脚本";
    var fixed = promptUtil.composeInput(triple, "约定");
    assert.strictEqual(fixed, "约定\n写脚本");
    assert.strictEqual(promptUtil.composeInput(fixed, "约定"), null);
  });

  await test("prompt: system prompt 已注入过则跳过", function () {
    var block = "<operit_purge>x</operit_purge>";
    var first = promptUtil.composeSystemPrompt("base", block);
    assert.ok(first.indexOf(block) >= 0);
    assert.strictEqual(promptUtil.composeSystemPrompt(first, block), null);
  });

  await test("prompt: 旧轮次的输入提醒会被剥掉，最新一轮保留", function () {
    var result = promptUtil.stripReminderFromHistory([
      { kind: "SYSTEM", content: "sys" },
      { kind: "USER", content: "约定\n第一轮" },
      { kind: "ASSISTANT", content: "答" },
      { kind: "USER", content: "约定\n第二轮" }
    ], "约定");
    assert.ok(result, "should report a change");
    assert.strictEqual(result[1].content, "第一轮");
    assert.strictEqual(result[3].content, "约定\n第二轮");
  });

  await test("prompt: 没有任何提醒时返回 null（不产生无意义改写）", function () {
    assert.strictEqual(
      promptUtil.stripReminderFromHistory([
        { kind: "USER", content: "第一轮" },
        { kind: "USER", content: "第二轮" }
      ], "约定"),
      null
    );
  });

  await test("prompt: 历史无 SYSTEM 时插入一条", function () {
    var out = promptUtil.appendToHistory(
      [{ kind: "USER", content: "hi" }],
      "破甲段"
    );
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].kind, "SYSTEM");
    assert.strictEqual(out[0].content, "破甲段");
  });

  await test("prompt: 历史有 SYSTEM 时追加并保留元数据", function () {
    var out = promptUtil.appendToHistory(
      [{ kind: "system", content: "原系统", metadata: { a: 1 } }],
      "破甲段"
    );
    assert.strictEqual(out.length, 1);
    assert.ok(out[0].content.indexOf("原系统") === 0);
    assert.ok(out[0].content.indexOf("破甲段") > 0);
    assert.deepStrictEqual(out[0].metadata, { a: 1 });
  });

  await test("prompt: 只对 CHAT 链路生效", function () {
    assert.strictEqual(promptUtil.isChatPayload({ functionType: "SUMMARY" }), false);
    assert.strictEqual(promptUtil.isChatPayload({ promptFunctionType: "TITLE_GENERATION" }), false);
    assert.strictEqual(promptUtil.isChatPayload({ functionType: "CHAT" }), true);
    assert.strictEqual(promptUtil.isChatPayload({}), true);
  });

  // 4. 拒答检测
  await test("refusal: 基线样本全部判对", async function () {
    var res = await service.testDetect();
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data.pass, true, JSON.stringify(res.data.cases, null, 2));
  });

  await test("refusal: 正常长回答不误伤", function () {
    var text = "先说结论：这段代码能跑。\n\n```js\nconsole.log(1)\n```\n\n然后解释为什么。第二段继续讲细节，讲完之后给验收命令。";
    assert.strictEqual(refusal.detect(text).refused, false);
  });

  await test("refusal: 开头拒答 + 无工件 = 命中", function () {
    var d = refusal.detect("很抱歉，我无法提供这类内容。");
    assert.strictEqual(d.refused, true);
    assert.ok(d.reasons.indexOf("strong_opener") >= 0);
  });

  await test("refusal: 给了工件但尾注免责 = 命中", function () {
    var d = refusal.detect("```bash\nnmap -sV 10.0.0.1\n```\n请自行判断使用场景，注意法律风险。");
    assert.strictEqual(d.refused, true);
    assert.ok(d.reasons.indexOf("tail_disclaimer") >= 0 || d.reasons.some(function (r) {
      return r.indexOf("soft_markers") === 0;
    }));
  });

  await test("refusal: 英文拒答命中", function () {
    var d = refusal.detect("I'm sorry, but I can't help with that. As an AI, I should note this may violate policy.");
    assert.strictEqual(d.refused, true);
  });

  await test("refusal: 空回答不判拒答", function () {
    var d = refusal.detect("");
    assert.strictEqual(d.refused, false);
  });

  // 5. 钩子
  await test("hooks: system prompt 钩子注入且保留原文", async function () {
    var cfg = await config.readSettings();
    assert.strictEqual(cfg.enabled, true);
    var evt = {
      eventName: "after_compose_system_prompt",
      eventPayload: { stage: "after_compose_system_prompt", chatId: "c1", functionType: "CHAT", systemPrompt: "宿主内置提示" }
    };
    var out = await hooks.onSystemPromptCompose(evt);
    assert.ok(out, "hook returned null");
    assert.ok(out.systemPrompt.indexOf("宿主内置提示") === 0);
    assert.ok(out.systemPrompt.indexOf("<operit_purge") >= 0);
  });

  await test("hooks: 关闭后 system prompt 钩子返回 null", async function () {
    await config.writeSettings({ enabled: false });
    var out = await hooks.onSystemPromptCompose({
      eventName: "after_compose_system_prompt",
      eventPayload: { stage: "after_compose_system_prompt", chatId: "c1", systemPrompt: "x" }
    });
    assert.strictEqual(out, null);
    await config.writeSettings({ enabled: true });
  });

  await test("hooks: 非 CHAT 链路不注入", async function () {
    var out = await hooks.onSystemPromptCompose({
      eventName: "after_compose_system_prompt",
      eventPayload: { stage: "after_compose_system_prompt", chatId: "c1", functionType: "SUMMARY", systemPrompt: "x" }
    });
    assert.strictEqual(out, null);
  });

  await test("hooks: 输入钩子插入提醒，二次调用不叠加", async function () {
    var evt = {
      eventName: "submit_requested",
      eventPayload: { chatId: "c1", text: "写个脚本" }
    };
    var out = await hooks.onChatInput(evt);
    assert.ok(out);
    assert.strictEqual(out.action, "replace");
    assert.ok(out.text.indexOf("写个脚本") >= 0);
    var second = await hooks.onChatInput({
      eventName: "submit_requested",
      eventPayload: { chatId: "c1", text: out.text }
    });
    assert.strictEqual(second, null);
  });

  await test("hooks: 拒答命中触发自动重答并计数", async function () {
    sentMessages.length = 0;
    await config.writeSettings({ enabled: true, autoRetryOnRefusal: true, retryMax: 2 });
    await config.writeState({ chats: {}, stats: { refusals: 0, retries: 0, blocks: 0 } });
    var out = await hooks.onChatMessage({
      eventName: "message_persisted",
      eventPayload: {
        chatId: "c1",
        sender: "ai",
        content: "抱歉，我不能帮你做这件事。建议你通过合法途径处理。"
      }
    });
    assert.strictEqual(out, null);
    assert.strictEqual(sentMessages.length, 1, "expected one retry message");
    assert.strictEqual(sentMessages[0].chatId, "c1");
    var st = await config.readState();
    assert.strictEqual(st.stats.refusals, 1);
    assert.strictEqual(st.stats.retries, 1);
  });

  await test("hooks: 连续拒答受 retryMax 限制", async function () {
    sentMessages.length = 0;
    await config.writeSettings({ enabled: true, autoRetryOnRefusal: true, retryMax: 2 });
    await config.writeState({ chats: { c1: { enabled: true, retryAttempts: 2 } }, stats: { refusals: 0, retries: 0, blocks: 0 } });
    await hooks.onChatMessage({
      eventName: "message_persisted",
      eventPayload: { chatId: "c1", sender: "ai", content: "很抱歉，我无法提供这类内容。" }
    });
    assert.strictEqual(sentMessages.length, 0, "should not retry past limit");
  });

  await test("hooks: 用户新消息清空连续拒答计数（无护栏时）", async function () {
    await config.writeState({ chats: { c1: { enabled: true, retryAttempts: 2, guardUntil: 0 } }, stats: { refusals: 0, retries: 0, blocks: 0 } });
    await hooks.onChatMessage({
      eventName: "message_persisted",
      eventPayload: { chatId: "c1", sender: "user", content: "再来一次" }
    });
    var st = await config.readState();
    assert.strictEqual(st.chats.c1.retryAttempts, 0);
  });

  await test("hooks: 自触发的继续消息不重置计数（防无限循环）", async function () {
    var future = Date.now() + 60000;
    await config.writeState({
      chats: { c1: { enabled: true, retryAttempts: 2, guardUntil: future } },
      stats: { refusals: 0, retries: 0, blocks: 0 }
    });
    await hooks.onChatMessage({
      eventName: "message_persisted",
      eventPayload: { chatId: "c1", sender: "user", content: "继续" }
    });
    var st = await config.readState();
    assert.strictEqual(st.chats.c1.retryAttempts, 2, "guard window must keep the counter");
  });

  await test("hooks: runtime 钩子记录 slot，重答按同一 surface 发", async function () {
    await config.writeState({
      chats: { c2: { enabled: true, runtime: "floating" } },
      stats: { refusals: 0, retries: 0, blocks: 0 }
    });
    await hooks.onChatRuntime({
      eventName: "state_changed",
      eventPayload: { chatId: "c2", slot: "floating", state: "processing" }
    });
    var st = await config.readState();
    assert.strictEqual(st.chats.c2.runtime, "floating");

    sentMessages.length = 0;
    await config.writeState({
      chats: { c2: { enabled: true, runtime: "floating" } },
      stats: { refusals: 0, retries: 0, blocks: 0 }
    });
    await hooks.onChatMessage({
      eventName: "message_persisted",
      eventPayload: { chatId: "c2", sender: "ai", content: "抱歉，我不能帮你做这个。" }
    });
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].options.runtime, "floating");
  });

  await test("hooks: 正常回答不触发重答", async function () {
    sentMessages.length = 0;
    await config.writeState({ chats: {}, stats: { refusals: 0, retries: 0, blocks: 0 } });
    await hooks.onChatMessage({
      eventName: "message_persisted",
      eventPayload: {
        chatId: "c2",
        sender: "ai",
        content: "结论先说：脚本在下面。\n\n```python\nprint('hi')\n```\n\n运行 python x.py 即可，期望输出 hi。"
      }
    });
    assert.strictEqual(sentMessages.length, 0);
  });

  await test("hooks: 工具拦截默认放行", async function () {
    var out = await hooks.onToolLifecycle({
      eventName: "tool_call_intercept",
      eventPayload: { toolName: "delete_file", parameters: { path: "/sdcard/x" } }
    });
    assert.deepStrictEqual(out, { action: "allow" });
  });

  await test("hooks: 任何钩子在异常输入下都返回 null/allow 而不抛", async function () {
    assert.strictEqual(await hooks.onSystemPromptCompose(null), null);
    assert.strictEqual(await hooks.onChatMessage(null), null);
    assert.strictEqual(await hooks.onChatInput({}), null);
    // 非拦截阶段：平凡返回 null，不干预宿主
    assert.strictEqual(await hooks.onToolLifecycle(undefined), null);
    assert.strictEqual(await hooks.onToolLifecycle({ eventName: "tool_execution_result" }), null);
    // 拦截阶段：即使 payload 畸形也必须显式放行
    assert.deepStrictEqual(
      await hooks.onToolLifecycle({ eventName: "tool_call_intercept" }),
      { action: "allow" }
    );
    assert.deepStrictEqual(
      await hooks.onToolLifecycle({ eventName: "tool_call_intercept", eventPayload: { toolName: 42 } }),
      { action: "allow" }
    );
  });

  // 6. 工具入口
  await test("tools: purge_status 返回完整字段", async function () {
    var res = await tools.purge_status();
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data.enabled, true);
    assert.strictEqual(res.data.configDir, ROOT);
  });

  await test("tools: purge_toggle 校验参数类型", async function () {
    var bad = await tools.purge_toggle("yes");
    assert.strictEqual(bad.success, false);
    var okRes = await tools.purge_toggle(false);
    assert.strictEqual(okRes.data.enabled, false);
    await tools.purge_toggle(true);
  });

  await test("tools: purge_set_preset 拒绝不存在的预设", async function () {
    var bad = await tools.purge_set_preset("nope");
    assert.strictEqual(bad.success, false);
    var good = await tools.purge_set_preset("claude");
    assert.strictEqual(good.success, true);
    assert.strictEqual(good.data.presetId, "claude");
    await tools.purge_set_preset("default");
  });

  await test("tools: purge_set_custom_prompt 覆盖与清除", async function () {
    var res = await tools.purge_set_custom_prompt("自定义");
    assert.strictEqual(res.data.customPromptChars, 3);
    var out = await hooks.onSystemPromptCompose({
      eventName: "after_compose_system_prompt",
      eventPayload: { stage: "after_compose_system_prompt", chatId: "c1", systemPrompt: "base" }
    });
    assert.ok(out.systemPrompt.indexOf("自定义") >= 0);
    await tools.purge_set_custom_prompt("");
    var after = await config.readSettings();
    assert.strictEqual(after.customPrompt, "");
  });

  await test("tools: purge_self_check 全绿", async function () {
    var res = await tools.purge_self_check();
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data.pass, true, JSON.stringify(res.data.checks, null, 2));
  });

  await test("tools: 日志写入与读取", async function () {
    var res = await tools.purge_read_log(10);
    assert.strictEqual(res.success, true);
    assert.ok(res.data.count > 0, "log should contain retry/toggle entries");
    var cleared = await tools.purge_clear_log();
    assert.strictEqual(cleared.success, true);
    var after = await tools.purge_read_log(10);
    assert.strictEqual(after.data.count, 0);
  });

  // 7. main 注册
  await test("main: registerToolPkg 注册全部钩子且不抛", function () {
    var calls = [];
    var saved = { register: {} };
    var methods = [
      "registerSystemPromptComposeHook",
      "registerPromptFinalizeHook",
      "registerPromptEstimateFinalizeHook",
      "registerChatInputHook",
      "registerChatMessageHook",
      "registerChatRuntimeHook",
      "registerToolLifecycleHook",
      "registerToolboxUiModule",
      "registerNavigationEntry",
      "registerAppLifecycleHook"
    ];
    var savedToolPkg = global.ToolPkg;
    methods.forEach(function (m) {
      saved.register[m] = savedToolPkg[m];
      savedToolPkg[m] = function (def) {
        calls.push({ method: m, def: def });
      };
    });
    try {
      var ret = main.registerToolPkg();
      assert.strictEqual(ret, true);
      assert.strictEqual(calls.length, methods.length);
      // 每个注册项都有 id 与 function（UI 模块用 screen）
      calls.forEach(function (c) {
        assert.strictEqual(typeof c.def.id, "string");
        if (c.method === "registerToolboxUiModule") {
          assert.strictEqual(typeof c.def.screen, "string");
        } else if (c.method === "registerNavigationEntry") {
          assert.strictEqual(typeof c.def.route, "string");
          assert.ok(fs.existsSync(path.join(PLUGIN, "ui/dashboard/index.ui.js")));
        } else {
          assert.strictEqual(typeof c.def.function, "function", c.method + " missing function");
        }
      });
    } finally {
      methods.forEach(function (m) {
        savedToolPkg[m] = saved.register[m];
      });
      global.ToolPkg = savedToolPkg;
    }
  });

  // 8. manifest 与包结构
  await test("manifest: 字段齐全，路径真实存在", function () {
    var manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
    assert.strictEqual(manifest.schema_version, 1);
    assert.strictEqual(manifest.toolpkg_id, "com.yg.operit_purge");
    assert.strictEqual(manifest.api_version, "1.0.1");
    assert.ok(fs.existsSync(path.join(__dirname, "..", manifest.main)), "main missing");
    manifest.subpackages.forEach(function (sp) {
      assert.ok(fs.existsSync(path.join(__dirname, "..", sp.entry)), "subpackage missing: " + sp.entry);
    });
    manifest.resources.forEach(function (r) {
      assert.ok(fs.existsSync(path.join(__dirname, "..", r.path)), "resource missing: " + r.path);
    });
  });

  // 收尾
  console.log("");
  if (failures.length) {
    console.log("共 " + failures.length + " 项失败：");
    failures.forEach(function (f) {
      console.log(" - " + f.name);
      if (f.error && f.error.stack) console.log(f.error.stack.split("\n").slice(0, 4).join("\n"));
    });
    process.exitCode = 1;
  } else {
    console.log("全部通过");
  }
  if (fs.existsSync(ROOT)) {
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
}

main().catch(function (e) {
  console.error("harness crashed:", e);
  process.exitCode = 1;
});
