# 任务规格: 双引擎模型隔离与异常吞没根治 (Engine Model Isolation & Error Resilience)

> 状态: Completed
> 创建时间: 2026-10-02
> 对应模块: agy-lark (core/types, core/models, core/runner, core/pi-runner, lark/dispatcher, lark/card-actions)
> 关联反馈: 用户反馈「图片提示词无返回内容，显示 ✅ agy 执行完成 但内容为空」，经排查确认两大根因：
> 1. 模型跨引擎交叉污染：在 Pi 模式下选中的 `global:deepseek-v4.1-flash` 在切换回 agy 引擎后被透传，导致 agy 二进制报错 `invalid model selection`。
> 2. 错误静默吞没：`runner.ts` 丢弃了 `res.error` 且在 `code !== 0` 时因 `finalResult` 存在而未 reject；`dispatcher.ts` 未校验 `result.status === 'ERROR'`，导致错误被当作成功完成并渲染为「（无返回内容）」。

---

## 1. 范围与边界 (Scope & Guardrails)

### 背景与痛点
1. **模型状态交叉污染**:
   `SessionEntry` 仅维护单一 `model` 字段。当用户在 `pi` 引擎下选择 DeepSeek/Qwen 等模型后，一旦全局或会话切换回 `agy`，`session.model` 仍是 Pi 模型。`agy` CLI 启动立即报错并退出。
2. **错误被粉饰为「执行完成」**:
   - `runner.ts` 的 `handleLine` 中 `response: res.response || ''` 丢弃了 CLI 在 `res.error` 中返回的报错信息。
   - `child.on('close')` 中判定 `if (code !== 0 && !finalResult)`，由于解析到了 `event: "result"` 的错误对象，`!finalResult` 为 false，导致异常退出被跳过而正常 resolve。
   - `dispatcher.ts` 在收到 resolve 的结果后直接将卡片状态标记为 `status: 'done'`，输出绿色的「✅ agy 执行完成」与「（无返回内容）」，彻底隐藏了真实的执行失败原因。

### 要做 (Goals)
1. **模型双引擎隔离与智能解析 (`resolveModelForEngine`)**:
   - 在 `SessionEntry` 中增加 `agyModel?: string` 和 `piModel?: string`。
   - 实现 `resolveModelForEngine(session, engine, config)`：
     - 若为 `agy`：优先取 `session.agyModel`；若通用 `session.model` 不含冒号且非 deepseek 等 pi 特有模型则沿用，否则平滑降级为 `config.agy.defaultModel`。
     - 若为 `pi`：优先取 `session.piModel`；若通用 `session.model` 非 `gemini-` 专有模型则沿用，否则回退到 `config.pi.defaultModel`。
   - 在卡片切换模型、`/model` 指令、`/engine` 指令和消息执行时，全链路调用 `resolveModelForEngine` 并自动清洗脏模型。
2. **错误全链路透传与拒绝（零静默吞没）**:
   - `src/core/runner.ts`：
     - `res.error` 必须完整采集：`response: res.response || res.error || ''`。
     - 当 `code !== 0` 时，无论是否存在 `finalResult`，必须 reject `BridgeError('E_AGY_RUN_FAILED', detail, hint)`。
     - 当 `finalResult.status === 'ERROR'` 时，必须 reject 抛出。
   - `src/core/pi-runner.ts`：
     - 当 `code !== 0` 时必须 reject 抛出 `BridgeError('E_PI_RUN_FAILED', detail, hint)`。
   - `src/lark/dispatcher.ts`：
     - 显式判断 `result.status === 'ERROR'` 并走统一的错误卡片分支，卡片标红 `❌ agy/pi 执行失败`，并展示 `> ⚠️ **错误详情**: ...`。
3. **清洗现有会话脏数据**:
   - 修复 `~/.agy-lark/sessions.json` 中已受污染的会话数据。
4. **测试与回归验证**:
   - 编写单元测试验证 `resolveModelForEngine` 的隔离防污染特性。
   - 编写单元测试验证 `runner.ts` 错误提取与 `code !== 0` 的 reject 行为。
   - 全量回归测试通过，重启服务验证。

---

## 2. 验证标准 (Acceptance Criteria)
1. 在 `agy` 引擎下，若会话模型此前为 Pi 模型，自动安全回退到 agy 默认模型，不再向 agy 传递非法 `--model`。
2. 当进程退出码非 0 或返回 `status: 'ERROR'` 时，卡片显示红色的「❌ 执行失败」和具体的错误信息，绝不允许出现「✅ 执行完成」但「（无返回内容）」。
3. `npm run build` 零错误，`npm test` 全部通过。
