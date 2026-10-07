# 任务规格: /engine 交互式卡片切换与 Pi 错误捕获及多模态加固

> 状态: Completed
> 创建时间: 2026-10-02
> 对应模块: agy-lark (cards, card-actions, dispatcher, pi-runner, types)
> 关联反馈:
> 1. 执行 `/engine` 指令应提供一键切换引擎的交互方式（如按钮点击），而不是仅输出静态文本。
> 2. 用户在 `pi` 引擎下发送图片提示词无返回内容，显示 `✅ pi 执行完成` 但 `（无返回内容）`，耗时 40.9s。

---

## 1. 根本原因排查与诊断

### 1.1 `/engine` 缺乏交互组件
* 现状：`/engine` 返回的仅为只读 Markdown 纯文本卡片，要求用户手动在聊天框敲键盘回复 `/engine pi` 或 `/engine agy`。
* 诉求：对齐 `/bind` 与 `/model` 的 Card 2.0 体验，提供卡片操作按钮 `[🚀 切换至 agy 引擎]` 和 `[⚡ 切换至 pi 引擎]`，点击即瞬时切换会话引擎并自适应校准模型。

### 1.2 `pi` 发送图片且无返回内容的根本原因
经深入调查与实机调用重现，确认由两个叠加问题导致：
1. **上游模型网关账号池耗尽 (503 Error)**：
   * 用户本地 Provider `http://localhost:7863/v1` 的 `global:deepseek-v4.1-flash` 上游账号池暂不可用，返回：
     `503: {"code":"no_healthy_account","gateway_hint":"no healthy account available in pool; check /status or retry later","message":"all accounts are temporarily unavailable, please retry later","type":"api_error"}`。
   * `pi` 内置了 3 次指数退避重试，退避耗时累计达 40.9 秒，最终失败。
2. **`pi-runner.ts` 错误吞没与零退出码误判**：
   * `pi` 在重试耗尽后以退出码 `0` 退出，但在事件流中输出了 `stopReason: "error"`, `errorMessage: "503..."` 以及 `auto_retry_end.success: false`。
   * `pi-runner.ts` 未采集这些错误事件，看到 `code === 0` 便盲目标记为成功，返回 `response: ''`，导致前端卡片被误判为 `✅ pi 执行完成` 并显示 `（无返回内容）`。
3. **多模态图片适配差异**：
   * `dispatcher.ts` 此前硬编码了 `请优先调用 view_file 工具查看并结合图片内容回答`。
   * `pi` 根本没有 `view_file` 工具，但原生支持 `@/path/to/image.png` 多模态输入。当引擎为 `pi` 时，必须通过 `@` 前缀原生挂载图片。

---

## 2. 解决方案设计

1. **交互式引擎管理卡片 (`buildEngineCard` & `switch_engine`)**:
   * 新增 `buildEngineCard(params: EngineCardParams)`：
     * 展示当前会话引擎、生效模型、全局默认引擎。
     * 提供 `[🚀 切换至 agy 引擎]`、`[⚡ 切换至 pi 引擎]`、`[🧠 模型面板]` 交互按钮。
   * 在 `card-actions.ts` 中处理 `switch_engine` 操作：
     * 更新 `session.engine`，并调用 `resolveModelForEngine` 自动纠偏生效模型。
     * 响应卡片更新及成功 toast。
2. **`pi-runner.ts` 错误全量捕获与零吞没**：
   * 监听 `turn_end`、`message_end`、`auto_retry_end` 中的 `errorMessage` 与 `stopReason === 'error'`。
   * 只要存在 `capturedError` 或 `responseText` 为空，一律 reject `BridgeError('E_PI_RUN_FAILED', capturedError || 'Pi 未返回有效结果', ...)`。
   * 卡片显式呈现红色 `❌ pi 执行失败`，并展示具体的 503 / 账号池报错。
3. **`pi` 原生多模态图片注入**：
   * 在 `AgentRunOptions` 中增加 `imagePaths?: string[]`。
   * `runPi` 启动参数中为图片增加 `@/path/to/img` 参数，让 `pi` 原生解析多模态图像。
   * `dispatcher.ts` 区分 `pi` 与 `agy` 的提示词包装逻辑。

---

## 3. 验证结果

1. **自动化测试套件**: 88/88 单元及集成测试通过（含 `buildEngineCard`、`switch_engine`、`pi-runner 503捕获`、`@image` 传参测试）。
2. **TypeScript 编译**: `npm run build` 0 警告 0 报错。
3. **后台守护进程**: launchd 服务平滑重启完成，WebSocket 链路已就绪。

