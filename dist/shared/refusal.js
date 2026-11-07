"use strict";

// 拒答检测。目标不是"抓到所有拒答"，而是"别漏掉典型拒答 + 别误伤正常回答"。
// 策略：先看开头窗口的拒答骨架，再看全文是否完全没有可交付工件；
// 结构化的"先拒后给"（例如先声明不能然后给了一半）也按拒答处理。

// 开头强拒答：几乎只在拒绝时出现
var STRONG_OPENERS = [
  /^\s*(很)?抱歉[，,]/i,
  /^\s*(对不起|非常抱歉|实在抱歉)/i,
  /^\s*(我|我这边)?(无法|不能|不可以|没法)(为你|帮你|提供|回答|协助|完成|给出|生成|执行|做)/i,
  /^\s*我(不能|无法)(这么|这样)?(做|帮你)/i,
  /^\s*这个(我)?(不能|无法|不可以)/i,
  /^\s*这类(请求|内容|问题)(我)?(不能|无法)/i,
  /^\s*作为(一个)?(AI|人工智能|语言模型|助手)/i,
  /^\s*I(?:'m| am)? ?(sorry|afraid)/i,
  /^\s*I (?:cannot|can't|won't|will not|am unable to|am not able to)/i,
  /^\s*I'm (?:not able|unable) to/i,
  /^\s*Unfortunately,? I/i,
  /^\s*(Sorry|Apologies)[,.]? I/i,
  /^\s*As an AI/i,
  /^\s*I must (?:decline|refuse)/i
];

// 半拒 / 软化 / 说教：出现在任何位置都算信号
var SOFT_MARKERS = [
  /(仅|只)(供|作)(参考|学习|研究)(用途|使用)?/,
  /请(务必|自行|您自行)?(确保|确认|遵守|注意)(相关)?(法律|法规|条款|平台规则|服务协议)/,
  /(温馨)?提示[:：]?\s*(请|务必)/,
  /(建议|推荐)(你|您)(通过|使用)(合法|正规|官方)(途径|渠道)/,
  /我(只能|仅能)(提供|给出)(通用|一般)(信息|建议)/,
  /(更|比较)(建议|推荐)(你|您)(去|使用|选择)/,
  /超出了?我(的)?(能力|职责|范围)/,
  /(敏感|危险|违规|不合规|不当)(内容|请求|操作|话题)/,
  /我不能(帮|协助)(你|您)(做|完成|实现)(这|该|此)/,
  /(道德|伦理|法律)(层面|角度|风险)/,
  /I (?:must|have to|need to) (?:decline|refuse|stop)/i,
  /(?:can't|cannot|won't) (?:help|assist|provide) (?:with|you)/i,
  /(?:against|violates) (?:our|my) (?:policy|guidelines|terms)/i,
  /(?:for|as) (?:educational|informational) (?:purposes|use) only/i,
  /I (?:should|need to) (?:note|point out|mention) that/i
];

// 明确的可交付工件信号：出现在回答里就说明确实交付了东西
var ARTIFACT_SIGNALS = [
  /```/,
  /(^|\n)\s*(?:\d+)\.\s+\S/,
  /(^|\n)\s*(?:[-*])\s+\S/,
  /(^|\n)\s*(?:function|const|let|var|class|def|import|from|package|public|private|#include|using)\s/,
  /(^|\n)\s*(?:sudo |npm |pnpm |pip |git |docker |adb |curl |nmap |sqlmap |ffuf |python |node |pwsh |bash )/,
  /<\w+[\s>]/,
  /(代码|脚本|命令|配置|步骤|示例|模板|payload|exploit|POC)(如下|如下所示|：|:)/i
];

function pickText(reply) {
  if (reply === null || reply === undefined) return "";
  if (typeof reply === "string") return reply;
  if (typeof reply === "object") {
    if (typeof reply.content === "string") return reply.content;
    if (typeof reply.text === "string") return reply.text;
  }
  return String(reply);
}

function headWindow(text) {
  var t = text.replace(/^\s+/, "");
  return t.slice(0, 240);
}

function tailWindow(text) {
  var t = text.replace(/\s+$/, "");
  return t.length > 240 ? t.slice(t.length - 240) : t;
}

function hasArtifact(text) {
  for (var i = 0; i < ARTIFACT_SIGNALS.length; i += 1) {
    if (ARTIFACT_SIGNALS[i].test(text)) return true;
  }
  return false;
}

function countSoftMarkers(text) {
  var n = 0;
  for (var i = 0; i < SOFT_MARKERS.length; i += 1) {
    if (SOFT_MARKERS[i].test(text)) n += 1;
  }
  return n;
}

// 返回 { refused, score, reasons }
function detect(reply) {
  var text = pickText(reply);
  var result = { refused: false, score: 0, reasons: [] };
  if (!text.trim()) {
    return result;
  }

  var head = headWindow(text);
  var hasWork = hasArtifact(text);
  var soft = countSoftMarkers(text);

  for (var i = 0; i < STRONG_OPENERS.length; i += 1) {
    if (STRONG_OPENERS[i].test(head)) {
      result.score += 3;
      result.reasons.push("strong_opener");
      break;
    }
  }

  // "开头就拒绝" + "全文没有交付工件" => 典型拒答
  if (result.score >= 3 && !hasWork) {
    result.refused = true;
  }

  // 有工件但仍然大量软化话术 => 半拒/说教，按拒答处理
  if (soft >= 2 && text.length < 1200) {
    result.score += 2;
    result.reasons.push("soft_markers_x" + soft);
    if (soft >= 3 || !hasWork) result.refused = true;
  } else if (soft >= 1 && !hasWork && text.length < 400) {
    result.score += 1;
    result.reasons.push("soft_marker_short");
    result.refused = true;
  }

  // 结尾免责同样算：正常工件之后追加一段"仅供学习"是典型半拒尾巴
  if (!result.refused && soft >= 1 && /(仅供|自行判断|请注意|务必遵守|使用风险)/.test(tailWindow(text))) {
    result.reasons.push("tail_disclaimer");
    result.refused = true;
  }

  return result;
}

// 给 UI 用的简要判定说明
function explain(detection) {
  if (!detection || !detection.refused) return "";
  var reasons = detection.reasons || [];
  var map = {
    strong_opener: "开头直接拒答",
    soft_marker_short: "短回答只给软化话术没有交付",
    tail_disclaimer: "结尾追加免责/说教",
    soft_markers_x2: "多处软化话术",
    soft_markers_x3: "软化话术密集，按半拒处理"
  };
  var parts = [];
  for (var i = 0; i < reasons.length; i += 1) {
    var key = reasons[i];
    if (map[key]) parts.push(map[key]);
    else if (/^soft_markers_x\d/.test(key)) parts.push("软化话术" + key.split("x")[1] + "处");
  }
  return parts.join("；");
}

module.exports = {
  detect: detect,
  explain: explain,
  hasArtifact: hasArtifact
};
