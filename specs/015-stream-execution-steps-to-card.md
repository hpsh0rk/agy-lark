# 任务规格: 智能体多步执行过程实时流式反馈与卡片渲染 (Stream Execution Steps to Card)

> 状态: Completed
> 创建时间: 2026-10-03
> 对应模块: agy-lark (types, runner, pi-runner, dispatcher, cards, test)
> 关联反馈: 用户反馈「发送消息的时候，一直展示正在思考与执行，过了很久才返回。现在是只会返回最后一个回答吗？过程是不会返回的，是吗？」

---

## 1. 范围与边界 (Scope & Guardrails)

### 背景与痛点
1. 智能体（`agy` / `pi`）在执行代码探索、分析、查找或修改等较重任务时，通常经历思考、多轮工具调用（如 `run_command`、`view_file`、`grep_search` 等）、读取执行结果并多次循环，耗时可达数十秒至数分钟。
2. 现有链路中，`dispatcher.ts` 仅接入 `onDelta`（最终总结的纯文本流），未接入 `onStep`；`cards.ts` 的 `buildStreamingCard` 仅渲染 `params.text`。
3. 导致卡片在执行期间长时间呈现静态的 `_AGY 正在思考与分析需求..._`，用户无法感知当前动作（产生假死焦虑），且缺乏对智能体在本地执行命令的透明度与安全审计。

### 要做 (Goals)
1. **统一扩展步骤事件定义 (`types.ts`)**:
   - 在 `AgyStepEvent` 中丰富工具参数摘要、动作描述及步骤状态（`stepIndex`, `toolName`, `summary`, `state`, `durationSeconds`）。
   - 增加对进行中状态与历史步骤列表的统一承载接口 `ExecutionStep`。
2. **执行引擎步骤解析与规范化 (`runner.ts` & `pi-runner.ts`)**:
   - `runner.ts`: 从 `agy` 的 `step_update` 事件中提取 `tool_name`、`tool_info.parameters`，生成人性化的简明动作描述（例如：`run_command: find . -name "*.md"`、`view_file: src/index.ts`），正确回调 `options.onStep`。
   - `pi-runner.ts`: 解析 `pi` 的工具调用（`tool_execution_start` / `tool_execution_end` / `message_update`），派发标准化的 `onStep` 事件。
3. **调度器步骤流式收集与卡片触发 (`dispatcher.ts`)**:
   - 在 `dispatcher.ts` 中维护每个任务的步骤序列 `steps: ExecutionStep[]` 与当前动作 `currentStep`。
   - 实现 `onStep` 回调处理，触发卡片节流更新（复用现有的 600ms 防刷机制）。
4. **飞书 Card 2.0 过程流优雅渲染 (`cards.ts`)**:
   - `buildStreamingCard` 接收 `steps` 与当前步骤参数。
   - **执行中 (running)**：
     - 若尚无最终答案，优先高亮显示当前动作与步骤轨迹（如 `⏳ **当前动作**: 正在执行 \`run_command\` (find . -name "*.md")...`，已完成步骤以引用列表展示）。
     - 当最终答案文本 `streamText` 开始产生时，主区域无缝展示 Markdown 答复，步骤轨迹自动精简收拢为顶部/底部的可折叠/精简引用栏，绝不喧宾夺主。
   - **已完成 (done)**：
     - 主区域展示完整最终答案；底部展示精炼的执行审计轨迹（例如 `📋 执行轨迹: 共执行 2 步工具调用 (run_command: 0.1s, run_command: 0.9s)`）。
   - **出错 (error)**：
     - 清晰指出在哪一步骤出错。
5. **严密测试与类型门禁**:
   - 补充 `cards.test.ts`、`dispatcher.test.ts`、`runner.test.ts`、`pi-runner.test.ts` 对应测试用例。
   - 确保 `npm test` 与 `npm run build` 全部绿灯。

### 不做 (Non-Goals)
- 不破坏现有飞书 Card 2.0 契约与已有交互按钮逻辑。
- 不将大段未经处理的终端原始 stdout/stderr 刷入飞书卡片（避免超过卡片 30KB 大小限制及阅读干扰），只展示操作摘要与关键状态。

---

## 2. 详细接口设计 (Contracts)

### 2.1 步骤数据契约 (`types.ts`)

```typescript
export interface ExecutionStep {
  index: number;
  toolName?: string;
  summary: string;
  state: 'ACTIVE' | 'DONE' | 'ERROR';
  durationSeconds?: number;
}

export interface StreamingCardParams {
  text: string;
  status: 'running' | 'done' | 'error';
  durationSeconds?: number;
  engine?: string;
  taskId?: string;
  model?: string;
  project?: string;
  imageKeys?: string[];
  errorMessage?: string;
  steps?: ExecutionStep[];
}
```

---

## 3. 验收标准 (Acceptance Criteria)

- [x] AC1: 智能体在执行工具（`run_command`、`view_file` 等）期间，飞书卡片能实时显示当前正在执行的动作与耗时，不再长时间静态停留于假死提示。
- [x] AC2: 模型开始生成最终回答时，最终答复流式呈现在卡片主区域，步骤明细优雅收纳，视觉层次分明。
- [x] AC3: 任务完成（done）后，最终答复完整呈现，并保留精炼的工具执行轨迹审计。
- [x] AC4: 单元测试覆盖新增字段及卡片渲染逻辑，`npm test` 与 `npm run build` 100% 通过。
