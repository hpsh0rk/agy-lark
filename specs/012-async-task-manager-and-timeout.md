# 任务规格: 异步任务管理器 (TaskManager) 与长任务超时解绑

> 状态: Planned
> 创建时间: 2026-10-02
> 对应模块: agy-lark (core/task-manager, core/runner, core/pi-runner, lark/dispatcher, lark/cards)
> 关联反馈: 用户长任务触发「耗时过长，已自动终止进程以释放资源 (600.3s)」，要求支持数小时长任务、取消 10 分钟强限制，并提供任务查看命令。

---

## 1. 范围与边界 (Scope & Guardrails)

### 背景与痛点
1. **硬编码 10 分钟看门狗**: 源码中使用 `options.timeoutMs || 600000`，不仅默认 10 分钟强杀，且 `0` 作为 falsy 值被错误回退为 600 秒，无法关闭超时。
2. **新消息盲杀运行中长任务 (Blind Abort)**: `dispatcher.ts` 在同一会话收到新消息时直接 `prevTask.abort()`，导致长任务执行中用户无法说话或查询状态。
3. **长任务状态不可见 (Blackbox)**: 缺乏全局任务注册表，用户无法得知后台正在运行哪些任务、已执行多长时间、如何单独停止。

### 要做 (Goals)
1. **彻底解绑超时限制 (Unlimited Timeout Support)**:
   - `timeoutMs === 0` 或 `timeoutMs < 0` 显式判定为 **禁用超时（无限制运行）**，不注册任何 `timeoutTimer`。
   - `config.json` 默认 `timeoutMs` 设为 `0`（不限时），支持自定义毫秒数。
   - 修复 `runner.ts` 与 `pi-runner.ts` 中的 falsy 判定缺陷：`options.timeoutMs !== undefined ? options.timeoutMs : (defaultTimeout ?? 0)`。
2. **构建任务管理器 (`src/core/task-manager.ts`)**:
   - 定义 `TaskInfo` 结构：
     - `taskId`: 短唯一 ID（如 `t-a1b2`）。
     - `sessionKey`, `chatId`, `threadId`, `messageId`, `botMessageId`。
     - `engine`: `'agy' | 'pi'`。
     - `projectName`: 项目别名。
     - `cwd`: 物理路径。
     - `prompt`: 提示词摘要。
     - `startedAt`: 启动时间戳。
     - `abortController`: 用于精准单任务取消。
     - `status`: `'running' | 'completed' | 'aborted' | 'error'`。
   - 提供 `startTask`、`finishTask`、`abortTask(taskId)`、`abortSessionTasks(sessionKey)`、`abortAll()`、`listActiveTasks()` 等操作。
3. **飞书指令扩展与卡片**:
   - 新增 `/tasks`（或 `/ps`）指令：列出所有当前正在运行的任务卡片（包含 ID、引擎、项目、已耗时、提示词摘要及停止按钮）。
   - 升级 `/stop` 指令：
     - `/stop`: 中止当前会话正在运行的任务。
     - `/stop <taskId>`: 中止指定 ID 的后台任务。
     - `/stop all`: 一键中止全部后台任务。
   - 优化指令执行策略：用户输入 `/tasks`、`/status`、`/help` 等命令时**绝不中断正在运行的后台长任务**。
4. **测试与质量保障**:
   - 编写 `test/task-manager.test.ts` 验证多任务生命周期、超时为 0 不中断、精准停止等特性。
   - 保证 `npm test` 绿灯。

### 不做 (Non-Goals)
- 不引入外部 Redis 或重型消息队列，保持单机纯内存 + 飞书长连接的高效无依赖架构。

---

## 2. 契约 (Contract)

### 2.1 `/tasks` 响应卡片契约
```
📋 当前运行中的后台任务 (N)
──────────────────────────────
🟢 [t-xxxx] <engine> | <projectName>
• 物理路径: <cwd>
• 运行时长: <hh小时 mm分 ss秒>
• 提示词: "<前60字...>"
• 停止: 发送 /stop t-xxxx
```

### 2.2 超时逻辑判定
```ts
const timeoutMs = options.timeoutMs !== undefined ? options.timeoutMs : (configTimeoutMs ?? 0);
if (timeoutMs > 0) {
  timeoutTimer = setTimeout(...);
} // <= 0 时完全不创建定时器
```

---

## 3. 验收标准 (Acceptance Criteria)

- [x] AC1: `timeoutMs: 0` 时，任务运行不再被 600 秒强杀，定时器不启动。
- [x] AC2: `TaskManager` 能正确登记并在后台跟踪所有异步任务。
- [x] AC3: 飞书端输入 `/tasks` 能正确展示所有运行中任务卡片及其已运行耗时。
- [x] AC4: 用户发送查询类指令时不影响后台运行中的长任务。
- [x] AC5: `/stop <taskId>` 与 `/stop all` 能够精准杀死对应子进程树。
- [x] AC6: 全量单元测试全部通过。
