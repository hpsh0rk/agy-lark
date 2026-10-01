import type { ModelInfo, QuotaSummary, SessionEntry } from '../core/types.js';

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
          '• **/bind**：管理工作区项目（切换项目、关联已有项目、新建项目、删除别名）\n' +
          '• **/model**：查看与切换大模型（附带 Token 消耗统计）\n' +
          '• **/new** 或 **/reset**：重置当前会话，开启全新上下文\n' +
          '• **/pwd**：查看当前会话绑定的物理路径与会话详情\n' +
          '• **/cd `<path>`**：临时切换当前会话的物理工作目录\n' +
          '• **/config `<key>` `<val>`**：查看或修改全局配置（如默认项目根目录）\n' +
          '• **/status**：查看当前会话状态与 Token 统计\n' +
          '• **/stop**：紧急终止当前正在执行的 `agy` 进程\n' +
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
  const cur = params.currentModel || '（跟随系统/默认）';
  const usage = params.sessionUsage || {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
  };

  const modelOptions = params.models.slice(0, 15).map((m) => ({
    text: {
      tag: 'plain_text',
      content: `${m.displayName} ${m.isThinking ? '🧠' : '⚡'}`,
    },
    value: JSON.stringify({ action: 'switch_model', modelId: m.id }),
  }));

  const elements: any[] = [
    {
      tag: 'markdown',
      content:
        `**当前生效模型**: \`${cur}\`\n\n` +
        `**📊 当前会话 Token 用量**:\n` +
        `• 输入 Token: **${usage.inputTokens.toLocaleString()}**\n` +
        `• 输出 Token: **${usage.outputTokens.toLocaleString()}**\n` +
        `• 缓存命中 (Cache Read): **${usage.cacheReadTokens.toLocaleString()}** tokens\n` +
        `• 累计总计: **${usage.totalTokens.toLocaleString()}** tokens\n`,
    },
    {
      tag: 'hr',
    },
    {
      tag: 'markdown',
      content: renderQuotaSection(params.quota),
    },
    {
      tag: 'hr',
    },
    {
      tag: 'markdown',
      content: '**选择并切换模型** (支持 Gemini、Claude、GPT 等):',
    },
    {
      tag: 'action',
      actions: [
        {
          tag: 'select_static',
          placeholder: {
            tag: 'plain_text',
            content: '点击选择大模型...',
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
          content: '💡 带 🧠 标记的模型具备思考链能力 (Thinking)；带 ⚡ 为高吞吐极速模型。',
        },
      ],
    },
  ];

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'indigo',
      title: {
        tag: 'plain_text',
        content: '🧠 模型选择与额度管理 (Models & Quota)',
      },
    },
    elements,
  };
}

export interface StreamingCardParams {
  text: string;
  status: 'running' | 'done' | 'error';
  durationSeconds?: number;
  model?: string;
  project?: string;
  imageKeys?: string[];
  errorMessage?: string;
}

export function buildStreamingCard(params: StreamingCardParams): Record<string, unknown> {
  let templateColor = 'blue';
  let titleText = '⚡ agy 正在思考与执行...';

  if (params.status === 'done') {
    templateColor = 'green';
    titleText = '✅ agy 执行完成';
  } else if (params.status === 'error') {
    templateColor = 'red';
    titleText = '❌ agy 执行失败';
  }

  const elements: any[] = [];

  // Main body markdown
  const bodyText = params.text.trim() || (params.status === 'running' ? '_思考中..._' : '_（无返回内容）_');
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

  // Render images if any
  if (params.imageKeys && params.imageKeys.length > 0) {
    elements.push({ tag: 'hr' });
    for (const imgKey of params.imageKeys) {
      elements.push({
        tag: 'img',
        img_key: imgKey,
        alt: {
          tag: 'plain_text',
          content: 'agy 生成的图片产物',
        },
        mode: 'fit_horizontal',
        preview: true,
      });
    }
  }

  // Footer notes
  const metaParts: string[] = [];
  if (params.project) metaParts.push(`📁 项目: ${params.project}`);
  if (params.model) metaParts.push(`🤖 模型: ${params.model}`);
  if (params.durationSeconds !== undefined) metaParts.push(`⏱️ 耗时: ${params.durationSeconds.toFixed(1)}s`);

  if (metaParts.length > 0) {
    elements.push({
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: metaParts.join('  |  '),
        },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: templateColor,
      title: {
        tag: 'plain_text',
        content: titleText,
      },
    },
    elements,
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

