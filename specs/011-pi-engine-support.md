# 任务规格: 支持 Pi Coding Agent (pi) 多引擎接入与动态切换

> 状态: Implemented
> 创建时间: 2026-10-02
> 对应模块: agy-lark (core/pi-runner, core/types, core/config, lark/dispatcher, lark/cards, test/pi-runner)
> 关联反馈: 用户请求「如果要支持pi的桥接通过飞书请求派而不是agy，需要多少的一个改造成本，适合写到当前项目里面吗？改造一下吧」

---

## 1. 范围与边界 (Scope & Guardrails)

### 背景与架构动机
1. 当前 `agy-lark` 的飞书接入层（WebSocket 长连接、Thread 会话隔离、卡片打字机流式更新、工作区绑定）已高度成熟稳定，占整个项目 70% 以上代码。
2. 用户需要支持接入 `pi`（Pi Coding Agent CLI，`@earendil-works/pi-coding-agent`，位于 `~/.local/bin/pi`）。
3. 采用“多后端引擎适配（Multi-Engine Adapter）”策略，保留原有的 `agy` 完整能力，新增 `pi` 引擎支持。
4. 既支持在全局配置文件中指定默认引擎 (`"engine": "pi" | "agy"`)，也支持在飞书聊天中通过 `/engine` 指令在当前 Thread 随时热切换。

### 要做 (Goals)
1. **类型与配置扩展 (`src/core/types.ts`, `src/core/config.ts`)**:
   - 定义 `AgentEngine = 'agy' | 'pi'`。
   - `BridgeConfig` 增加 `engine?: AgentEngine` 与 `pi?: PiConfig`（含 `binary`, `provider`, `defaultModel`, `thinking`, `timeoutMs`）。
   - `SessionEntry` 增加 `engine?: AgentEngine`。
   - `loadBridgeConfig` 支持从 `config.json` 解析 `engine` 和 `pi` 配置。
2. **Pi 进程驱动与流式事件解析器 (`src/core/pi-runner.ts`)**:
   - 实现 `runPi(options: AgyRunOptions, piConfig?: PiConfig)`。
   - 命令行：`pi -p --mode json [--session-id <id>] [--model <model>] [--thinking <level>] <prompt>`。
   - 流式解析：处理 `pi` 的 NDJSON 事件流：
     - `session`: 捕获会话 ID。
     - `message_update`: 提取 `assistantMessageEvent.delta`（支持 `text_delta` 与 `thinking_delta` 流式展示）。
     - `turn_end`: 汇总 `usage`（`input`, `output`, `cacheRead`, `reasoning`, `totalTokens`）。
   - 超时与中断：复用进程树终止（`killProcessTree`），响应 `AbortSignal` 与 `timeoutMs`。
   - 容错保护：过滤非 JSON 行（警告、状态提示），自动补全系统 PATH（`/opt/homebrew/bin`, `~/.local/bin`）。
3. **模型与配额适配 (`src/core/models.ts`, `src/lark/dispatcher.ts`)**:
   - `models.ts` 增加 `fetchPiModels(binary)`，支持解析 `pi --list-models` 及高质量兜底列表。
   - `/model` 命令与卡片回调根据当前会话的引擎返回对应可用模型。
   - `/quota` 命令在 `pi` 模式下显示当前会话用量与 API Key 计费说明；在 `agy` 模式下保留 Google 配额穿透。
4. **飞书分发调度与卡片指令扩展 (`src/lark/dispatcher.ts`, `src/lark/cards.ts`)**:
   - 新增 `/engine` 指令：
     - `/engine`: 查询当前会话引擎与全局默认配置。
     - `/engine pi`: 将当前 Thread/Chat 切换为 `pi` 引擎。
     - `/engine agy`: 将当前 Thread/Chat 切换为 `agy` 引擎。
   - `/status` 卡片中展示生效引擎（`⚙️ 当前引擎: pi` 或 `agy`）。
   - `/help` 卡片补充 `/engine` 指令说明。
   - 流式等待卡片显示对应引擎名称（`pi 正在思考与分析需求...`）。
5. **测试与质量保障**:
   - 编写 `test/pi-runner.test.ts`：覆盖流式解析、Session 续聊、中断处理与 Token 统计。
   - 编写 `test/engine-switch.test.ts`：覆盖 `/engine` 指令切换与状态维护。
   - 运行全量测试套件并保证 100% 通过。

### 不做 (Non-Goals)
- 不暴力删除或破坏任何原有的 `agy` 依赖与配额穿透逻辑。
- 不引入重型前端或外部中间件，保持零外部守护进程的纯本地长连接模式。

---

## 2. 契约 (Contract)

### 2.1 配置契约 (`config.json`)
```json
{
  "engine": "pi",
  "pi": {
    "binary": "~/.local/bin/pi",
    "provider": "local",
    "defaultModel": "deepseek-v4.1-flash",
    "thinking": "high",
    "timeoutMs": 600000
  },
  "agy": { ... },
  "lark": { ... },
  "workspace": { ... }
}
```

### 2.2 命令行指令契约
- `/engine`: 输出当前会话引擎（`pi` 或 `agy`）及切换用法。
- `/engine <pi|agy>`: 切换当前会话引擎，返回切换成功确认卡片。

---

## 3. 验收标准 (Acceptance Criteria)

- [x] AC1: `config.json` 支持 `engine: 'pi' | 'agy'` 及 `pi` 配置节，默认根据配置启动对应引擎。
- [x] AC2: `runPi` 能够正确拉起 `pi` 子进程，通过 `--session-id` 实现多轮对话记忆，并通过 NDJSON 流式输出驱动飞书打字机卡片。
- [x] AC3: 飞书支持通过 `/engine pi` / `/engine agy` 随时热切换当前会话后端，并在 `/status` 中清晰显示。
- [x] AC4: `/stop` 指令能正确终止正在运行的 `pi` 或 `agy` 任务进程树。
- [x] AC5: 所有单元测试与端到端测试绿灯通过，构建 `npm run build` 无类型错误。
