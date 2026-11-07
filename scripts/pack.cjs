"use strict";

// 打包：把 manifest + dist/ + resources/ 压成 operit_purge.toolpkg（本质是 ZIP）。
// 用法：node scripts/pack.cjs [输出目录]
// 不用第三方依赖，直接手写最小 ZIP writer（store 或 deflate），避免给手机侧引入额外运行时。

var fs = require("node:fs");
var path = require("node:path");
var zlib = require("node:zlib");

var ROOT = path.join(__dirname, "..");

function collect(dir, base) {
  base = base || "";
  var out = [];
  var items = fs.readdirSync(dir, { withFileTypes: true });
  for (var i = 0; i < items.length; i += 1) {
    var item = items[i];
    var full = path.join(dir, item.name);
    var rel = base ? base + "/" + item.name : item.name;
    if (item.isDirectory()) {
      out = out.concat(collect(full, rel));
    } else if (item.isFile()) {
      out.push({ rel: rel, full: full });
    }
  }
  return out;
}

function dosTime(date) {
  var y = date.getFullYear();
  var mo = date.getMonth() + 1;
  var d = date.getDate();
  var h = date.getHours();
  var mi = date.getMinutes();
  var s = Math.floor(date.getSeconds() / 2);
  var time = (h << 11) | (mi << 5) | s;
  var day = ((y - 1980) << 9) | (mo << 5) | d;
  return { time: time & 0xffff, day: day & 0xffff };
}

function crc32(buf) {
  var table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (var n = 0; n < 256; n += 1) {
      var c = n;
      for (var k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    crc32.table = table;
  }
  var crc = 0xffffffff;
  for (var i = 0; i < buf.length; i += 1) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  var entries = [];
  var offset = 0;
  var chunks = [];

  for (var i = 0; i < files.length; i += 1) {
    var f = files[i];
    var raw = fs.readFileSync(f.full);
    var isText = /\.(js|json|md|txt|svg|html|css|xml|yml|yaml)$/i.test(f.rel);
    var method = 0;
    var data = raw;
    if (raw.length > 1024 && isText) {
      var deflated = zlib.deflateRawSync(raw, { level: 9 });
      if (deflated.length < raw.length) {
        data = deflated;
        method = 8;
      }
    }
    var stamp = dosTime(fs.statSync(f.full).mtime);
    var nameBuf = Buffer.from(f.rel, "utf8");
    var crc = crc32(raw);

    var local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // UTF-8 flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, data);
    entries.push({
      nameBuf: nameBuf,
      crc: crc,
      compSize: data.length,
      rawSize: raw.length,
      method: method,
      time: stamp.time,
      day: stamp.day,
      offset: offset
    });
    offset += local.length + nameBuf.length + data.length;
  }

  var central = [];
  var centralSize = 0;
  for (var j = 0; j < entries.length; j += 1) {
    var e = entries[j];
    var head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(e.method, 10);
    head.writeUInt16LE(e.time, 12);
    head.writeUInt16LE(e.day, 14);
    head.writeUInt32LE(e.crc, 16);
    head.writeUInt32LE(e.compSize, 20);
    head.writeUInt32LE(e.rawSize, 24);
    head.writeUInt16LE(e.nameBuf.length, 28);
    head.writeUInt16LE(0, 30);
    head.writeUInt16LE(0, 32);
    head.writeUInt16LE(0, 34);
    head.writeUInt16LE(0, 36);
    head.writeUInt32LE(0, 38);
    head.writeUInt32LE(e.offset, 42);
    central.push(head, e.nameBuf);
    centralSize += head.length + e.nameBuf.length;
  }

  var end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat(chunks.concat(central, [end]));
}

function main() {
  // 默认写到 release/，这个目录纳入版本控制：手机上直接从仓库下载 .toolpkg 就能导入。
  var outDir = process.argv[2] || path.join(ROOT, "release");
  fs.mkdirSync(outDir, { recursive: true });

  var manifestPath = path.join(ROOT, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error("manifest.json missing");
    process.exit(1);
  }
  var manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  // 校验 manifest 里声明的路径都真实存在，避免打出坏包
  var required = [manifest.main];
  (manifest.subpackages || []).forEach(function (sp) { required.push(sp.entry); });
  (manifest.resources || []).forEach(function (r) { required.push(r.path); });
  var missing = [];
  required.forEach(function (rel) {
    if (!fs.existsSync(path.join(ROOT, rel))) missing.push(rel);
  });
  if (missing.length) {
    console.error("manifest references missing files: " + missing.join(", "));
    process.exit(1);
  }

  var files = [{ rel: "manifest.json", full: manifestPath }];
  files = files.concat(collect(path.join(ROOT, "dist"), "dist"));
  files = files.concat(collect(path.join(ROOT, "resources"), "resources"));

  var zip = buildZip(files);
  var out = path.join(outDir, "operit_purge.toolpkg");
  fs.writeFileSync(out, zip);

  console.log("wrote " + out);
  console.log("entries=" + files.length + " bytes=" + zip.length);
  files.forEach(function (f) { console.log("  " + f.rel); });
}

main();
