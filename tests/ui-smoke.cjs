"use strict";

// UI 冒烟测试：用桩 ctx 渲染 Screen，验节点树结构、action 可调用、切开关后状态真的变。
// Compose DSL 契约里 useState 的 setter 只接受值，这里也按同一语义实现桩。

var fs = require("node:fs");
var path = require("node:path");
var assert = require("node:assert");

var ROOT = path.join(__dirname, "_tmp_ui_config");
var PLUGIN = path.join(__dirname, "..", "dist");

function resetRoot() {
  if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
}

global.getLang = function () {
  return "zh";
};

global.ToolPkg = { getConfigDir: function () { return ROOT; } };
global.Tools = {
  Files: {
    exists: async function (p) { return { exists: fs.existsSync(p) }; },
    mkdir: async function (p, parents) { fs.mkdirSync(p, { recursive: parents !== false }); return { success: true }; },
    read: async function (p) { return { content: fs.readFileSync(p, "utf8") }; },
    write: async function (p, content) { fs.writeFileSync(p, content); return { success: true }; },
    list: async function (p) {
      return { entries: fs.readdirSync(p, { withFileTypes: true }).map(function (e) {
        return { name: e.name, isDirectory: e.isDirectory() };
      }) };
    },
    deleteFile: async function (p, recursive) { fs.rmSync(p, { recursive: recursive !== false, force: true }); return { success: true }; }
  },
  Chat: { sendMessage: async function () { return { aiResponse: "ok" }; } },
  System: { toast: async function (m) { return { data: m }; } }
};

// ---- ctx 桩 ----
function makeCtx() {
  var state = {};
  var memo = {};
  var actions = [];

  var modifierProxy = function () {
    var ops = [];
    var proxy = new Proxy({}, {
      get: function (target, prop) {
        if (prop === "toJSON") {
          return function () { return ops.map(function (o) { return o; }); };
        }
        return function () {
          var args = Array.prototype.slice.call(arguments);
          ops.push({ name: String(prop), args: args });
          return proxy;
        };
      }
    });
    return proxy;
  };

  function factoryFor(type) {
    return function (props, children) {
      var node = { type: type, props: props || {} };
      if (children) node.children = Array.isArray(children) ? children : [children];
      else if (props && Array.isArray(props.content)) node.children = props.content;
      // 收集函数 prop 作为 action
      var keys = Object.keys(node.props);
      for (var i = 0; i < keys.length; i += 1) {
        var k = keys[i];
        if (typeof node.props[k] === "function") {
          actions.push({ node: type, prop: k, fn: node.props[k] });
        }
      }
      return node;
    };
  }

  var UI = new Proxy({}, {
    get: function (target, prop) {
      if (prop === "then") return undefined;
      __factoryCache = __factoryCache || {};
      if (!__factoryCache[prop]) __factoryCache[prop] = factoryFor(String(prop));
      return __factoryCache[prop];
    }
  });
  var __factoryCache = null;

  var ctx = {
    UI: UI,
    MaterialTheme: {
      colorScheme: new Proxy({}, {
        get: function (t, p) {
          return { __colorToken: String(p) };
        }
      })
    },
    useState: function (key, initial) {
      if (!Object.prototype.hasOwnProperty.call(state, key)) state[key] = initial;
      return [state[key], function (v) { state[key] = v; }];
    },
    useMutable: function (key, initial) { return ctx.useState(key, initial); },
    useRef: function (key, initial) {
      if (!Object.prototype.hasOwnProperty.call(memo, key)) memo[key] = { current: initial };
      return memo[key];
    },
    useMemo: function (key, factory) {
      if (!Object.prototype.hasOwnProperty.call(memo, key)) memo[key] = factory();
      return memo[key];
    },
    Modifier: modifierProxy(),
    showToast: async function () { return { ok: true }; },
    reportError: function () {},
    callTool: async function () { return {}; },
    getEnv: function () { return undefined; },
    navigate: async function () { return undefined; }
  };
  ctx._state = state;
  ctx._actions = actions;
  return ctx;
}

function walk(node) {
  var out = [node];
  if (node && Array.isArray(node.children)) {
    node.children.forEach(function (c) {
      if (c) out = out.concat(walk(c));
    });
  }
  return out;
}

var failures = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () { console.log("PASS  " + name); })
    .catch(function (e) {
      failures.push({ name: name, error: e });
      console.log("FAIL  " + name + " :: " + (e && e.message ? e.message : e));
    });
}

function loadUI() {
  var full = path.join(PLUGIN, "ui/dashboard/index.ui.js");
  delete require.cache[require.resolve(full)];
  return require(full);
}

async function main() {
  resetRoot();
  var ui = loadUI();
  var Screen = ui.default;
  assert.strictEqual(typeof Screen, "function", "default export must be a function");
  assert.strictEqual(typeof ui.Screen, "function", "named Screen export must exist");

  var ctx = makeCtx();
  var tree;

  await test("ui: 首帧可渲染且返回合法节点", function () {
    tree = Screen(ctx);
    assert.ok(tree, "Screen returned nothing");
    assert.strictEqual(tree.type, "LazyColumn");
    assert.ok(Array.isArray(tree.children));
  });

  await test("ui: onLoad 挂在根节点上", function () {
    assert.strictEqual(typeof tree.props.onLoad, "function");
  });

  await test("ui: 首帧渲染不读盘（state 仍未填充）", function () {
    assert.strictEqual(ctx._state.status, null);
    assert.strictEqual(ctx._state.presets.length, 0);
  });

  await test("ui: onLoad 后状态被填充", async function () {
    await tree.props.onLoad();
    assert.ok(ctx._state.status, "status not loaded");
    assert.strictEqual(ctx._state.status.enabled, true);
    assert.ok(ctx._state.presets.length >= 3, "presets not loaded");
    assert.strictEqual(ctx._state.loadedOnce, undefined);
  });

  await test("ui: 二次渲染展示预设卡片与统计", function () {
    var ctx2 = makeCtx();
    // 复用同一 state store：把第一次的 state 灌进去
    Object.keys(ctx._state).forEach(function (k) {
      ctx2._state[k] = ctx._state[k];
    });
    var tree2 = Screen(ctx2);
    var nodes = walk(tree2).filter(function (n) { return n && n.type === "Text"; });
    var joined = nodes.map(function (n) { return String(n.props.text || ""); }).join("\n");
    assert.ok(joined.indexOf("破甲控制台") >= 0, "title missing");
    assert.ok(joined.indexOf("拒答命中") >= 0, "stats label missing");
    assert.ok(joined.indexOf("默认破甲") >= 0 || joined.indexOf("Default") >= 0, "preset title missing");
  });

  await test("ui: 总开关回调真的改状态并刷新", async function () {
    var ctx3 = makeCtx();
    Object.keys(ctx._state).forEach(function (k) {
      ctx3._state[k] = ctx._state[k];
    });
    var tree3 = Screen(ctx3);
    var switches = walk(tree3).filter(function (n) { return n && n.type === "Switch"; });
    assert.ok(switches.length >= 4, "expected >=4 switches, got " + switches.length);
    // 第一个是总开关
    await switches[0].props.onCheckedChange(false);
    assert.strictEqual(ctx3._state.status.enabled, false, "master toggle did not persist");
    await switches[0].props.onCheckedChange(true);
    assert.strictEqual(ctx3._state.status.enabled, true);
  });

  await test("ui: 注入点开关改的是对应字段", async function () {
    var ctx4 = makeCtx();
    Object.keys(ctx._state).forEach(function (k) {
      ctx4._state[k] = ctx._state[k];
    });
    var tree4 = Screen(ctx4);
    var switches = walk(tree4).filter(function (n) { return n && n.type === "Switch"; });
    var before = ctx4._state.status.inputReminder;
    await switches[2].props.onCheckedChange(!before);
    assert.strictEqual(ctx4._state.status.inputReminder, !before);
    await switches[2].props.onCheckedChange(before);
  });

  await test("ui: 预设按钮切换 activePreset", async function () {
    var ctx5 = makeCtx();
    Object.keys(ctx._state).forEach(function (k) {
      ctx5._state[k] = ctx._state[k];
    });
    var tree5 = Screen(ctx5);
    var buttons = walk(tree5).filter(function (n) {
      return n && n.type === "Button" && String(n.props.text || "").indexOf("使用") === 0;
    });
    assert.ok(buttons.length >= 1, "no use-preset button rendered");
    await buttons[0].props.onClick();
    assert.notStrictEqual(ctx5._state.activePreset, "default");
    // 还原
    await require(path.join(PLUGIN, "shared/service.js")).usePreset("default");
  });

  await test("ui: 自检与检测按钮产出结果", async function () {
    var ctx6 = makeCtx();
    Object.keys(ctx._state).forEach(function (k) {
      ctx6._state[k] = ctx._state[k];
    });
    var tree6 = Screen(ctx6);
    var buttons = walk(tree6).filter(function (n) { return n && n.type === "Button"; });
    var selfCheckBtn = buttons.filter(function (b) { return b.props.text === "运行自检"; })[0];
    var detectBtn = buttons.filter(function (b) { return b.props.text === "跑检测样本"; })[0];
    assert.ok(selfCheckBtn, "self-check button missing");
    assert.ok(detectBtn, "detect button missing");
    await selfCheckBtn.props.onClick();
    assert.ok(ctx6._state.checkResult, "self-check result not set");
    assert.strictEqual(ctx6._state.checkResult.pass, true);
    await detectBtn.props.onClick();
    assert.ok(ctx6._state.detectResult, "detect result not set");
    assert.strictEqual(ctx6._state.detectResult.pass, true);
  });

  await test("ui: 自定义提示词输入框写到草稿态", function () {
    var ctx7 = makeCtx();
    Object.keys(ctx._state).forEach(function (k) {
      ctx7._state[k] = ctx._state[k];
    });
    var tree7 = Screen(ctx7);
    var fields = walk(tree7).filter(function (n) { return n && n.type === "TextField"; });
    assert.strictEqual(fields.length, 1);
    fields[0].props.onValueChange("我的自定义");
    assert.strictEqual(ctx7._state.customDraft, "我的自定义");
  });

  await test("ui: 渲染出的节点没有 null 空洞", function () {
    var ctx8 = makeCtx();
    Object.keys(ctx._state).forEach(function (k) {
      ctx8._state[k] = ctx._state[k];
    });
    var tree8 = Screen(ctx8);
    var nodes = walk(tree8);
    nodes.forEach(function (n) {
      if (n === null) throw new Error("null child leaked into tree");
      assert.strictEqual(typeof n.type, "string", "node type must be a string");
    });
  });

  console.log("");
  if (failures.length) {
    console.log("共 " + failures.length + " 项失败：");
    failures.forEach(function (f) { console.log(" - " + f.name); });
    process.exitCode = 1;
  } else {
    console.log("全部通过");
  }
  if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
}

main().catch(function (e) {
  console.error("ui harness crashed:", e);
  process.exitCode = 1;
});
