import type { AgentEngine, ExecutionStep, ModelInfo, PiProviderInfo, QuotaSummary, SessionEntry } from '../core/types.js';
import type { TaskRecord, TaskManager } from '../core/task-manager.js';

/**
 * ⚠️ 飞书卡片回传值约定（依据官方组件文档）：
 * - 按钮 `button` 的 `value` 必须是 **key-value JSON 对象**（传 JSON 字符串会被规范化掉），
 *   回调时落在 `action.value`；
 * - 下拉单选 `select_static` 的 `options[].value` 是 **字符串**，
 *   回调时落在 `action.option`（**不是** `action.value`）。
 *
 * 两者混用会导致「点击 / 选中后没有任何反馈」，改动时请勿互换。
 */
export function buildHelpCard(): Record<string, unknown> {
  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: '🤖 Antigravity CLI (agy) 指南',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content:
          '**欢迎使用 agy-lark 桥接服务！**\n直接发送任何问题或代码需求，机器人将调用本地 `agy` 进行交互。',
      },
      {
        tag: 'hr',
      },
      {
        tag: 'markdown',
        content:
          '### 📋 可用指令一览\n' +
          '• **/engine [pi|agy]**：查看或切换当前会话执行引擎（支持 Pi 与 Agy）\n' +
          '• **/tasks** 或 **/ps**：查看所有正在后台运行的长任务与耗时\n' +
          '• **/bind**：管理工作区项目（切换项目、关联已有项目、新建项目、删除别名）\n' +
          '• **/model**：查看与切换大模型（附带 Token 消耗统计）\n' +
          '• **/quota**：查看当前引擎的用量统计与配额状态\n' +
          '• **/new** 或 **/reset**：重置当前会话，开启全新上下文\n' +
          '• **/pwd**：查看当前会话绑定的物理路径与会话详情\n' +
          '• **/cd `<path>`**：临时切换当前会话的物理工作目录\n' +
          '• **/config `<key>` `<val>`**：查看或修改全局配置（如默认项目根目录）\n' +
          '• **/status**：查看当前会话状态与 Token 统计\n' +
          '• **/stop [taskId|all]**：终止当前会话或指定后台长任务\n' +
          '• **/help**：展示本帮助信息卡片\n',
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: '💡 提示：在群聊中，Bot 始终在话题 (Thread) 内流式回复，同话题共享上下文。',
          },
        ],
      },
    ],
  };
}

export interface BindCardParams {
  currentProject?: string;
  currentPath: string;
  defaultRoot: string;
  projects: Record<string, string>;
}

export function buildBindCard(params: BindCardParams): Record<string, unknown> {
  const projectEntries = Object.entries(params.projects);
  const options = projectEntries.map(([name, p]) => ({
    text: {
      tag: 'plain_text',
      content: `${name} (${p.length > 25 ? '...' + p.slice(-22) : p})`,
    },
    value: JSON.stringify({ action: 'switch_project', projectName: name }),
  }));

  const elements: any[] = [
    {
      tag: 'markdown',
      content:
        `**当前绑定项目**: \`${params.currentProject || '（未命名项目）'}\`\n` +
        `**物理工作目录**: \`${params.currentPath}\`\n` +
        `**默认新建根目录**: \`${params.defaultRoot}\``,
    },
    {
      tag: 'hr',
    },
  ];

  if (options.length > 0) {
    elements.push(
      {
        tag: 'markdown',
        content: '**快速切换已有项目**:',
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'select_static',
            placeholder: {
              tag: 'plain_text',
              content: '选择要绑定的项目...',
            },
            options,
          },
        ],
      }
    );
  } else {
    elements.push({
      tag: 'markdown',
      content: '*暂无注册的项目别名，请点击下方按钮新建或直接使用 /cd 切换路径。*',
    });
  }

  // Buttons for New, Add & Delete Project
  const actionButtons: any[] = [
    {
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: '➕ 新建项目',
      },
      type: 'primary',
      value: { action: 'prompt_create_project' },
    },
    {
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: '🔗 关联已有项目',
      },
      type: 'default',
      value: { action: 'prompt_add_project' },
    },
  ];

  if (projectEntries.length > 0) {
    actionButtons.push({
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: '🗑️ 删除项目别名',
      },
      type: 'danger',
      confirm: {
        title: {
          tag: 'plain_text',
          content: '确认删除项目别名',
        },
        text: {
          tag: 'plain_text',
          content: '请确认是否移除项目别名？（此操作仅删除快捷别名，不会删除本地物理文件）',
        },
      },
      value: { action: 'prompt_delete_project' },
    });
  }

  elements.push(
    {
      tag: 'action',
      actions: actionButtons,
    },
    {
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content:
            '💡 关联已有项目: 回复 "/bind add <别名> <路径>"；新建项目默认在 ' +
            params.defaultRoot +
            ' 下；可通过 "/config default_root <path>" 修改默认创建路径。',
        },
      ],
    }
  );

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: '🎯 项目工作区管理 (Workspace Binding)',
      },
    },
    elements,
  };
}

export interface ModelCardParams {
  currentModel?: string;
  models: ModelInfo[];
  sessionUsage?: SessionEntry['totalUsage'];
  /** 额度汇总（取数失败时为 undefined，卡片降级展示占位文案） */
  quota?: QuotaSummary;
  engine?: AgentEngine;
  piProviderInfo?: PiProviderInfo;
}

const QUOTA_WINDOW_LABELS: Record<string, string> = {
  weekly: '每周',
  '5h': '5 小时',
  '5-hour': '5 小时',
  daily: '每日',
};

/** 剩余比例 → 文字进度条，例如 0.92 → `█████████░` */
export function renderProgressBar(fraction: number, width = 10): string {
  const safe = Math.min(1, Math.max(0, fraction));
  const filled = Math.min(width, Math.max(0, Math.round(safe * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** 重置时刻（UTC ISO 字符串）→ 中文倒计时文案 */
export function formatResetCountdown(resetTime?: string, now = Date.now()): string | undefined {
  if (!resetTime) return undefined;
  const target = Date.parse(resetTime);
  if (Number.isNaN(target)) return undefined;

  const diffMs = target - now;
  if (diffMs <= 60_000) return '即将重置';

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟后重置`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时后重置`;

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days} 天 ${restHours} 小时后重置` : `${days} 天后重置`;
}

/** 渲染「额度用量」区块（markdown 文案）。 */
export function renderQuotaSection(quota?: QuotaSummary, now = Date.now()): string {
  if (!quota || quota.groups.length === 0) {
    return (
      '**📊 额度用量 (Quota)**\n' +
      '_暂不可用（未登录 Antigravity / 令牌过期 / 网络异常）_'
    );
  }

  const lines: string[] = ['**📊 额度用量 (Quota)**'];
  for (const group of quota.groups) {
    lines.push('');
    const modelsHint = group.description
      ? group.description.replace(/^Models within this group:\s*/i, '').trim()
      : '';
    lines.push(`**${group.displayName}**${modelsHint ? `（${modelsHint}）` : ''}`);

    for (const bucket of group.buckets) {
      const label = QUOTA_WINDOW_LABELS[bucket.window] || bucket.window || bucket.displayName;
      const countdown = formatResetCountdown(bucket.resetTime, now);

      if (bucket.remainingFraction === undefined) {
        lines.push(`• ${label}：_未知_${countdown ? ` · ${countdown}` : ''}`);
        continue;
      }

      const percent = Math.round(bucket.remainingFraction * 100);
      lines.push(
        `• ${label}  \`${renderProgressBar(bucket.remainingFraction)}\` **${percent}%**` +
          (countdown ? ` · ${countdown}` : '')
      );
    }
  }

  lines.push('', '> 同一组内的模型共享「每周 + 5 小时」双额度，按 token 成本比例消耗。');
  return lines.join('\n');
}

export function buildModelCard(params: ModelCardParams): Record<string, unknown> {
  const engine = params.engine || 'agy';
  const isPi = engine === 'pi';
  const cur = params.currentModel || (isPi ? '（跟随 Pi 默认）' : '（跟随系统/默认）');
  const usage = params.sessionUsage || {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
  };

  const modelOptions = params.models.slice(0, 20).map((m) => ({
    text: {
      tag: 'plain_text',
      content: `${m.displayName} ${m.isThinking ? '🧠' : '⚡'}`,
    },
    value: JSON.stringify({ action: 'switch_model', modelId: m.id, engine }),
  }));

  const elements: any[] = [
    {
      tag: 'markdown',
      content:
        `**当前生效模型**: \`${cur}\`\n` +
        `**⚙️ 执行引擎**: \`${isPi ? 'Pi Coding Agent (pi)' : 'Antigravity CLI (agy)'}\`\n\n` +
        `**📊 当前会话 Token 用量**:\n` +
        `• 输入 Token: **${usage.inputTokens.toLocaleString()}**\n` +
        `• 输出 Token: **${usage.outputTokens.toLocaleString()}**\n` +
        `• 缓存命中 (Cache Read): **${usage.cacheReadTokens.toLocaleString()}** tokens\n` +
        `• 累计总计: **${usage.totalTokens.toLocaleString()}** tokens\n`,
    },
    {
      tag: 'hr',
    },
  ];

  if (isPi) {
    const info = params.piProviderInfo;
    const providerStr = info?.provider || 'local';
    const endpointStr = info?.baseUrl ? `\`${info.baseUrl}\`` : '本地 / 环境变量配置';
    elements.push({
      tag: 'markdown',
      content:
        `**🔌 Pi 运行后端与授权配置**:\n` +
        `• 接入 Provider: **${providerStr}**\n` +
        `• API 服务端点: ${endpointStr}\n` +
        `• 模型库规模: **${info?.modelCount ?? params.models.length}** 个可用模型\n` +
        `• 计费与配额: **API Key / Token 按量计费**（不受 Google Cloud 额度限制）`,
    });
  } else {
    elements.push({
      tag: 'markdown',
      content: renderQuotaSection(params.quota),
    });
  }

  elements.push(
    {
      tag: 'hr',
    },
    {
      tag: 'markdown',
      content: isPi
        ? '**选择并切换 Pi 模型** (已读取本地可用模型):'
        : '**选择并切换 agy 模型** (支持 Gemini、Claude、GPT 等):',
    },
    {
      tag: 'action',
      actions: [
        {
          tag: 'select_static',
          placeholder: {
            tag: 'plain_text',
            content: isPi ? '点击选择 Pi 模型...' : '点击选择大模型...',
          },
          options: modelOptions,
        },
      ],
    },
    {
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: isPi
            ? '💡 带 🧠 标记的模型具备思考/推理能力 (Thinking)；发送 /engine 可切换为 agy 引擎。'
            : '💡 带 🧠 标记的模型具备思考链能力 (Thinking)；带 ⚡ 为高吞吐极速模型。',
        },
      ],
    }
  );

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: isPi ? 'violet' : 'indigo',
      title: {
        tag: 'plain_text',
        content: isPi
          ? '🧠 Pi 模型选择与用量概览 (Pi Models)'
          : '🧠 agy 模型选择与额度管理 (Models & Quota)',
      },
    },
    elements,
  };
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

export function buildStreamingCard(params: StreamingCardParams): Record<string, unknown> {
  const engineLabel = (params.engine || 'agy').toLowerCase() === 'pi' ? 'pi' : 'agy';
  let templateColor = 'blue';
  let titleText = `⚡ ${engineLabel} 正在思考与执行...`;

  if (params.status === 'done') {
    templateColor = 'green';
    titleText = `✅ ${engineLabel} 执行完成`;
  } else if (params.status === 'error') {
    templateColor = 'red';
    titleText = `❌ ${engineLabel} 执行失败`;
  }

  const elements: any[] = [];
  const toolSteps = (params.steps || []).filter((s) => s.stepType === 'tool');
  const hasStreamText = Boolean(params.text && params.text.trim());

  if (params.status === 'running') {
    if (!hasStreamText) {
      // 阶段 1：尚未产生最终答复文本（智能体正在思考或执行工具）
      if (toolSteps.length > 0) {
        const activeStep = toolSteps.find((s) => s.state === 'ACTIVE') || toolSteps[toolSteps.length - 1];
        const doneSteps = toolSteps.filter((s) => s !== activeStep && s.state === 'DONE');

        const stepLines: string[] = [];
        const isCurrentActive = activeStep.state === 'ACTIVE';
        stepLines.push(`**⏳ 当前执行**: ${activeStep.summary} ${isCurrentActive ? '_(执行中...)_' : '✅'}`);

        if (doneSteps.length > 0) {
          stepLines.push('');
          stepLines.push('**📋 已完成步骤**:');
          const recentDone = doneSteps.slice(-5);
          for (let i = 0; i < recentDone.length; i++) {
            const s = recentDone[i];
            const dur = s.durationSeconds !== undefined ? ` \`(${s.durationSeconds.toFixed(1)}s)\`` : '';
            stepLines.push(`> ${i + 1}. ${s.summary} ✅${dur}`);
          }
          if (doneSteps.length > 5) {
            stepLines.push(`> _... 以及更早的 ${doneSteps.length - 5} 个步骤_`);
          }
        }

        elements.push({
          tag: 'markdown',
          content: stepLines.join('\n'),
        });
      } else {
        elements.push({
          tag: 'markdown',
          content: params.text.trim() || `_${engineLabel.toUpperCase()} 正在思考与分析需求..._`,
        });
      }
    } else {
      // 阶段 2：大模型已开始流式打字输出最终回答
      if (toolSteps.length > 0) {
        elements.push({
          tag: 'markdown',
          content: `<font color="grey">⚡ 已完成 ${toolSteps.length} 步工具执行，正在生成答复：</font>`,
        });
      }
      elements.push({
        tag: 'markdown',
        content: params.text.trim(),
      });
    }
  } else {
    // 阶段 3：已完成 (done) 或 异常 (error)
    const bodyText = params.text.trim() || (params.status === 'done' ? '_（无返回内容）_' : '_执行未成功完成_');
    elements.push({
      tag: 'markdown',
      content: bodyText,
    });

    if (params.errorMessage) {
      elements.push({
        tag: 'markdown',
        content: `> ⚠️ **错误详情**: ${params.errorMessage}`,
      });
    }

    if (toolSteps.length > 0) {
      elements.push({ tag: 'hr' });
      const auditLines: string[] = [];
      auditLines.push(`**📋 执行轨迹审计** (共 ${toolSteps.length} 步工具调用):`);
      for (let i = 0; i < toolSteps.length; i++) {
        const s = toolSteps[i];
        const dur = s.durationSeconds !== undefined ? ` \`(${s.durationSeconds.toFixed(1)}s)\`` : '';
        const statusIcon = s.state === 'ERROR' ? '❌' : '✅';
        auditLines.push(`> ${i + 1}. ${s.summary} ${statusIcon}${dur}`);
      }
      elements.push({
        tag: 'markdown',
        content: auditLines.join('\n'),
      });
    }
  }

  // Render images if any
  if (params.imageKeys && params.imageKeys.length > 0) {
    elements.push({ tag: 'hr' });
    for (const imgKey of params.imageKeys) {
      elements.push({
        tag: 'img',
        img_key: imgKey,
        alt: {
          tag: 'plain_text',
          content: `${engineLabel} 生成的图片产物`,
        },
        mode: 'fit_horizontal',
        preview: true,
      });
    }
  }

  // Footer metadata (Card 2.0 规范：note 组件已废弃，使用灰色 markdown 富文本替代)
  const metaParts: string[] = [];
  if (params.taskId) metaParts.push(`🆔 任务: ${params.taskId}`);
  if (params.engine) metaParts.push(`⚙️ 引擎: ${params.engine}`);
  if (params.project) metaParts.push(`📁 项目: ${params.project}`);
  if (params.model) metaParts.push(`🤖 模型: ${params.model}`);
  if (params.durationSeconds !== undefined) {
    if (params.durationSeconds >= 60) {
      const mins = Math.floor(params.durationSeconds / 60);
      const secs = (params.durationSeconds % 60).toFixed(1);
      metaParts.push(`⏱️ 耗时: ${mins}m ${secs}s`);
    } else {
      metaParts.push(`⏱️ 耗时: ${params.durationSeconds.toFixed(1)}s`);
    }
  }

  if (metaParts.length > 0) {
    elements.push({
      tag: 'markdown',
      content: `<font color="grey">${metaParts.join('  |  ')}</font>`,
    });
  }

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: templateColor,
      title: {
        tag: 'plain_text',
        content: titleText,
      },
    },
    body: {
      elements,
    },
  };
}

export interface StartupCardParams {
  botName?: string;
  defaultRoot: string;
  defaultModel?: string;
  effort?: string;
  yolo?: boolean;
}

export function buildStartupCard(params: StartupCardParams): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'turquoise',
      title: {
        tag: 'plain_text',
        content: '🚀 Antigravity (agy) 飞书服务已就绪',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content:
          `**你好！我是你的 Antigravity AI 编程助手**（应用：\`${params.botName || 'Antigravity Bot'}\`）。\n` +
          '本地网关服务已成功启动并建立长连接，你可以直接向我发送编程需求，或者使用下方操作。',
      },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content:
          `• **默认大模型**：\`${params.defaultModel || '系统自动选定'}\`\n` +
          `• **思考强度**：\`${params.effort || 'high'}\`\n` +
          `• **执行模式**：\`YOLO (自动执行工具，免手动确认)\`\n` +
          `• **默认根目录**：\`${params.defaultRoot}\``,
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📖 查看指令帮助' },
            type: 'primary',
            value: { action: 'help' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📦 工作区项目绑定' },
            type: 'default',
            value: { action: 'bind_card' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🧠 模型选择与额度' },
            type: 'default',
            value: { action: 'model_card' },
          },
        ],
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: '💡 提示：在群聊中 @我 时，回复将自动收拢在 Thread 话题中，同话题持续保持上下文记忆。',
          },
        ],
      },
    ],
  };
}

export interface ShutdownCardParams {
  reason: string;
  timestamp?: string;
}

export function buildShutdownCard(params: ShutdownCardParams): Record<string, unknown> {
  const timeStr = params.timestamp || new Date().toLocaleString('zh-CN', { hour12: false });
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'carmine',
      title: {
        tag: 'plain_text',
        content: '⚠️ Antigravity (agy) 飞书服务已停止',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content:
          `**飞书网关服务已停止运行或捕获到终止信号。**\n\n` +
          `• **停止原因**：\`${params.reason}\`\n` +
          `• **停止时间**：\`${timeStr}\`\n` +
          `• **当前状态**：\`已离线 (WebSocket 已断开)\``,
      },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content:
          '💡 **如何恢复**：\n' +
          '请在本地或服务器终端重新执行启动指令：\n' +
          '```bash\n' +
          'npm run lark\n' +
          '```',
      },
    ],
  };
}

export function buildTasksCard(tasks: TaskRecord[], taskManager: TaskManager): Record<string, unknown> {
  const activeCount = tasks.length;
  const elements: any[] = [];

  if (activeCount === 0) {
    elements.push({
      tag: 'markdown',
      content: '⚪ **当前没有正在运行的后台任务。**\n\n发送任务需求后即可自动在后台异步执行，支持数小时长任务。',
    });
  } else {
    elements.push({
      tag: 'markdown',
      content: `📋 **当前正在运行中的后台任务 (${activeCount})**\n所有任务均在后台持续运行，不会因超时或发送新消息被中断。`,
    });
    elements.push({ tag: 'hr' });

    for (const task of tasks) {
      const elapsed = (Date.now() - task.startedAt) / 1000;
      const durationStr = taskManager.formatDuration(elapsed);
      const promptSnippet = task.prompt.length > 50 ? `${task.prompt.slice(0, 50)}...` : task.prompt;
      const proj = task.projectName ? `\`${task.projectName}\`` : `\`${task.cwd}\``;

      elements.push({
        tag: 'markdown',
        content:
          `🟢 **[${task.id}]** \`${task.engine.toUpperCase()}\` · ${proj}\n` +
          `• 运行时长: **${durationStr}**\n` +
          `• 任务内容: ${promptSnippet}\n` +
          `• 终止指令: \`/stop ${task.id}\``,
      });

      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: `🛑 终止任务 ${task.id}`,
            },
            type: 'danger',
            value: {
              action: 'stop_task',
              taskId: task.id,
            },
          },
        ],
      });

      elements.push({ tag: 'hr' });
    }
  }

  return {
    schema: '2.0',
    config: {
      update_multi: true,
    },
    header: {
      template: activeCount > 0 ? 'blue' : 'grey',
      title: {
        tag: 'plain_text',
        content: `⚡ 后台任务列表 (${activeCount})`,
      },
    },
    body: {
      elements,
    },
  };
}

export interface EngineCardParams {
  currentEngine: AgentEngine;
  globalEngine: AgentEngine;
  effectiveModel?: string;
  piProviderInfo?: PiProviderInfo;
}

export function buildEngineCard(params: EngineCardParams): Record<string, unknown> {
  const isPi = params.currentEngine === 'pi';
  const curName = isPi ? 'Pi Coding Agent (pi)' : 'Antigravity CLI (agy)';
  const globalName = params.globalEngine === 'pi' ? 'Pi Coding Agent (pi)' : 'Antigravity CLI (agy)';

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: isPi ? 'violet' : 'indigo',
      title: {
        tag: 'plain_text',
        content: '⚙️ 执行引擎管理 (Engine Switcher)',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content:
          `**当前会话执行引擎**: **${curName}**\n` +
          `• 对应生效模型: \`${params.effectiveModel || '系统默认'}\`\n` +
          `• 全局默认执行引擎: **${globalName}**\n\n` +
          `**💡 引擎特性与定位说明**:\n` +
          `• **agy (Antigravity)**: 深度集成 Google DeepMind CLI，支持 Gemini 3.8 / Claude / GPT 模型与 Google Cloud 额度池，具备全功能项目编辑与多模态。\n` +
          `• **pi (Pi Coding Agent)**: 轻量高速编程智能体，原生支持第三方 OpenAI 兼容 API、本地模型网关与终端流式推理。`,
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: isPi ? '🚀 切换为 agy 引擎' : '✅ 当前为 agy 引擎',
            },
            type: isPi ? 'primary' : 'default',
            value: { action: 'switch_engine', engine: 'agy' },
          },
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: isPi ? '✅ 当前为 pi 引擎' : '⚡ 切换为 pi 引擎',
            },
            type: isPi ? 'default' : 'primary',
            value: { action: 'switch_engine', engine: 'pi' },
          },
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: '🧠 模型面板',
            },
            type: 'default',
            value: { action: 'model_card' },
          },
        ],
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: '💡 点击上方按钮可一键切换当前会话引擎；修改全局默认引擎请发送 /config engine <agy|pi>。',
          },
        ],
      },
    ],
  };
}


