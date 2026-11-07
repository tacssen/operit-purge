"use strict";

// 低层存储：所有持久化都落在 ToolPkg.getConfigDir() 下，便于备份与人工检查。
// Hook 可能在不同执行上下文中运行，因此不依赖模块级可变状态，每次按需读写文件。

var FALLBACK_ROOT = "/sdcard/Download/Operit/operit_purge";

function getRoot() {
  try {
    var dir = ToolPkg.getConfigDir();
    if (dir && String(dir).trim()) {
      return String(dir);
    }
  } catch (e) {
    // 某些上下文（如纯工具调用）可能没有 ToolPkg，退到固定路径。
  }
  return FALLBACK_ROOT;
}

function pathOf(name) {
  var root = getRoot();
  while (root.length > 1 && root.charAt(root.length - 1) === "/") {
    root = root.slice(0, -1);
  }
  return root + "/" + name;
}

async function exists(path) {
  try {
    var res = await Tools.Files.exists(path);
    return !!(res && res.exists);
  } catch (e) {
    return false;
  }
}

async function ensureDirs() {
  var root = getRoot();
  var dirs = [
    root,
    pathOf("presets"),
    pathOf("logs")
  ];
  for (var i = 0; i < dirs.length; i += 1) {
    try {
      await Tools.Files.mkdir(dirs[i], true);
    } catch (e) {
      // 目录已存在或受限时继续，后续写入会暴露真实错误。
    }
  }
}

async function readText(path, fallback) {
  if (fallback === undefined) fallback = "";
  try {
    var res = await Tools.Files.read(path);
    if (res && typeof res.content === "string") {
      return res.content;
    }
    return fallback;
  } catch (e) {
    return fallback;
  }
}

async function writeText(path, text) {
  await ensureDirs();
  var res = await Tools.Files.write(path, String(text), false);
  if (res && res.success === false) {
    throw new Error("write failed: " + path);
  }
  return true;
}

async function readJson(path, fallback) {
  var raw = await readText(path, "");
  if (!raw) return fallback;
  try {
    var parsed = JSON.parse(raw);
    if (parsed === null || parsed === undefined) return fallback;
    return parsed;
  } catch (e) {
    return fallback;
  }
}

async function writeJson(path, value) {
  return writeText(path, JSON.stringify(value, null, 2));
}

function nowMs() {
  return Date.now();
}

module.exports = {
  getRoot: getRoot,
  pathOf: pathOf,
  exists: exists,
  ensureDirs: ensureDirs,
  readText: readText,
  writeText: writeText,
  readJson: readJson,
  writeJson: writeJson,
  nowMs: nowMs
};
