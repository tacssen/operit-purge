"use strict";

// ToolPkg 主入口：只做注册，不承担常驻逻辑。
// 注册函数必须是稳定的模块导出；这里把全部钩子再导出一次，
// 宿主就能走"函数 == 本模块导出"这条最稳的解析路径，不必依赖跨模块函数元数据。

var hooks = require("./shared/hooks.js");
var config = require("./shared/config.js");

var UI_SCREEN = "dist/ui/dashboard/index.ui.js";

function onAppCreate() {
  // 首次加载时把配置目录铺好，避免第一个工具调用因为目录缺失报错。
  try {
    config.readSettings().catch(function () {});
  } catch (error) {
    // 主入口里不允许抛错：一个异常会让整个注册会话失败。
  }
}

function registerToolPkg() {
  // 1) 系统提示词注入（破甲本体）
  ToolPkg.registerSystemPromptComposeHook({
    id: "operit_purge_system_prompt",
    function: exports.onSystemPromptCompose
  });

  // 2) 发模型前的历史兜底
  ToolPkg.registerPromptFinalizeHook({
    id: "operit_purge_prompt_finalize",
    function: exports.onPromptFinalize
  });

  // 3) token 估算走同一套，避免估算与请求不一致
  ToolPkg.registerPromptEstimateFinalizeHook({
    id: "operit_purge_prompt_estimate_finalize",
    function: exports.onPromptEstimateFinalize
  });

  // 4) 提交前插入本轮执行约定
  ToolPkg.registerChatInputHook({
    id: "operit_purge_chat_input",
    function: exports.onChatInput
  });

  // 5) 拒答检测 + 自动重答
  ToolPkg.registerChatMessageHook({
    id: "operit_purge_chat_message",
    function: exports.onChatMessage
  });

  // 6) 用户发新消息时清空连续拒答计数，并记住 runtime
  ToolPkg.registerChatRuntimeHook({
    id: "operit_purge_chat_runtime",
    function: exports.onChatRuntime
  });

  // 7) 工具调用放行（默认全放行，只记录）
  ToolPkg.registerToolLifecycleHook({
    id: "operit_purge_tool_lifecycle",
    function: exports.onToolLifecycle
  });

  // 8) 控制台 UI + 导航入口
  ToolPkg.registerToolboxUiModule({
    id: "operit_purge_dashboard",
    runtime: "compose_dsl",
    screen: UI_SCREEN,
    title: {
      zh: "破甲控制台",
      en: "Purge Console"
    }
  });

  ToolPkg.registerNavigationEntry({
    id: "operit_purge_nav",
    route: "toolpkg:com.yg.operit_purge:ui:operit_purge_dashboard",
    surface: "main_sidebar_plugins",
    icon: "shield",
    order: 30,
    title: {
      zh: "破甲控制台",
      en: "Purge Console"
    }
  });

  // 9) 启动时铺目录
  ToolPkg.registerAppLifecycleHook({
    id: "operit_purge_app_create",
    event: "application_on_create",
    function: exports.onAppCreate
  });

  return true;
}

exports.registerToolPkg = registerToolPkg;
exports.onAppCreate = onAppCreate;
exports.onSystemPromptCompose = hooks.onSystemPromptCompose;
exports.onPromptFinalize = hooks.onPromptFinalize;
exports.onPromptEstimateFinalize = hooks.onPromptEstimateFinalize;
exports.onChatInput = hooks.onChatInput;
exports.onChatMessage = hooks.onChatMessage;
exports.onChatRuntime = hooks.onChatRuntime;
exports.onToolLifecycle = hooks.onToolLifecycle;
