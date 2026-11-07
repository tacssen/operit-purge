"use strict";

// 预设管理：内置预设来自 defaults.js，文件预设在 configDir/presets/<id>.md。
// 文件预设只读取首行标题与正文，不做复杂解析，便于用户手改。

var storage = require("./storage.js");
var defaults = require("./defaults.js");

function builtinList() {
  var out = [];
  for (var id in defaults.PRESETS) {
    if (!Object.prototype.hasOwnProperty.call(defaults.PRESETS, id)) continue;
    var p = defaults.PRESETS[id];
    out.push({
      id: p.id,
      source: "builtin",
      title: p.title,
      description: p.description,
      preview: String(p.prompt).slice(0, 240),
      chars: String(p.prompt).length
    });
  }
  return out;
}

async function listFiles() {
  var dir = storage.pathOf("presets");
  var out = [];
  try {
    var listing = await Tools.Files.list(dir);
    var entries = listing && listing.entries ? listing.entries : [];
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      var name = entry && entry.name ? String(entry.name) : "";
      if (!name || !/\.(md|txt)$/i.test(name)) continue;
      var id = name.replace(/\.(md|txt)$/i, "");
      var path = dir + "/" + name;
      var text = await storage.readText(path, "");
      var lines = text.split("\n");
      var title = lines.length > 0 ? String(lines[0]).replace(/^\s*#\s*/, "").trim() : id;
      out.push({
        id: id,
        source: "file",
        title: { zh: title || id, en: title || id },
        description: {
          zh: "文件预设：" + path,
          en: "File preset: " + path
        },
        preview: text.slice(0, 240),
        chars: text.length,
        path: path
      });
    }
  } catch (e) {
    // 目录不存在时视为无文件预设
  }
  return out;
}

async function list() {
  return builtinList().concat(await listFiles());
}

async function get(id) {
  var key = String(id || "").trim();
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(defaults.PRESETS, key)) {
    var p = defaults.PRESETS[key];
    return {
      id: p.id,
      source: "builtin",
      title: p.title,
      description: p.description,
      prompt: p.prompt,
      reminder: p.reminder,
      retryText: p.retryText
    };
  }
  var path = storage.pathOf("presets/" + key + ".md");
  var text = await storage.readText(path, "");
  if (!text) {
    var alt = storage.pathOf("presets/" + key + ".txt");
    text = await storage.readText(alt, "");
    if (!text) return null;
    path = alt;
  }
  var lines = text.split("\n");
  var title = lines.length > 0 ? String(lines[0]).replace(/^\s*#\s*/, "").trim() : key;
  return {
    id: key,
    source: "file",
    title: { zh: title || key, en: title || key },
    description: { zh: "文件预设：" + path, en: "File preset: " + path },
    prompt: text,
    reminder: defaults.PRESETS.default.reminder,
    retryText: defaults.PRESETS.default.retryText,
    path: path
  };
}

async function resolvePreset(config) {
  var wanted = config && config.presetId ? String(config.presetId) : "default";
  var found = await get(wanted);
  if (found) return found;
  return await get("default");
}

async function saveFilePreset(id, text) {
  var key = String(id || "").trim().replace(/[^A-Za-z0-9_-]/g, "");
  if (!key) throw new Error("preset id must contain letters, digits, _ or -");
  if (Object.prototype.hasOwnProperty.call(defaults.PRESETS, key)) {
    throw new Error("cannot overwrite builtin preset: " + key);
  }
  var path = storage.pathOf("presets/" + key + ".md");
  await storage.writeText(path, String(text || ""));
  return { id: key, path: path };
}

async function deleteFilePreset(id) {
  var key = String(id || "").trim();
  if (!key) throw new Error("preset id is required");
  if (Object.prototype.hasOwnProperty.call(defaults.PRESETS, key)) {
    throw new Error("cannot delete builtin preset: " + key);
  }
  var md = storage.pathOf("presets/" + key + ".md");
  var txt = storage.pathOf("presets/" + key + ".txt");
  var removed = false;
  if (await storage.exists(md)) {
    await Tools.Files.deleteFile(md);
    removed = true;
  }
  if (await storage.exists(txt)) {
    await Tools.Files.deleteFile(txt);
    removed = true;
  }
  if (!removed) throw new Error("preset not found: " + key);
  return true;
}

module.exports = {
  builtinList: builtinList,
  list: list,
  get: get,
  resolvePreset: resolvePreset,
  saveFilePreset: saveFilePreset,
  deleteFilePreset: deleteFilePreset
};
