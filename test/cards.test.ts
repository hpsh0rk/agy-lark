import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHelpCard,
  buildBindCard,
  buildModelCard,
  buildStreamingCard,
  buildStartupCard,
  buildShutdownCard,
  formatResetCountdown,
  renderProgressBar,
  renderQuotaSection,
} from '../src/lark/cards.js';

test('cards: buildHelpCard 生成符合飞书规范的卡片结构', () => {
  const card = buildHelpCard();
  assert.equal((card as any).header?.title?.tag, 'plain_text');
  assert.ok(Array.isArray((card as any).elements), 'elements 应为数组');
  assert.ok(JSON.stringify(card).includes('/bind'), '卡片应包含 /bind 说明');
  assert.ok(JSON.stringify(card).includes('/model'), '卡片应包含 /model 说明');
});

test('cards: buildBindCard 渲染下拉选择与操作按钮', () => {
  const card = buildBindCard({
    currentProject: 'agy-lark',
    currentPath: '/workspace/agy-lark',
    defaultRoot: '~/project',
    projects: {
      'agy-lark': '/workspace/agy-lark',
      'cli-bridge': '/workspace/cli-bridge',
    },
  });

  const jsonStr = JSON.stringify(card);
  assert.ok(jsonStr.includes('select_static'), '应包含静态下拉选择组件');
  assert.ok(jsonStr.includes('switch_project'), 'action.value 应包含 switch_project 操作');
  assert.ok(jsonStr.includes('➕ 新建项目'), '应包含新建项目按钮');
  assert.ok(jsonStr.includes('🗑️ 删除项目别名'), '应包含删除项目按钮');
});

test('cards: buildModelCard 渲染模型列表与用量信息', () => {
  const card = buildModelCard({
    currentModel: 'gemini-3.8-flash-high',
    models: [
      { id: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)', isThinking: true },
      { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6 (Thinking)', isThinking: true },
    ],
    sessionUsage: {
      inputTokens: 12000,
      outputTokens: 450,
      cacheReadTokens: 8000,
      totalTokens: 12450,
    },
  });

  const jsonStr = JSON.stringify(card);
  assert.ok(jsonStr.includes('gemini-3.8-flash-high'), '应包含当前模型');
  assert.ok(jsonStr.includes('12,000'), '应包含格式化后的 Token 数量');
  assert.ok(jsonStr.includes('8,000'), '应包含缓存读取命中数量');
  assert.ok(jsonStr.includes('switch_model'), '应包含切换模型的 action');
});

test('cards: buildStreamingCard 状态与图片嵌入', () => {
  const runningCard = buildStreamingCard({
    text: '正在扫描文件目录...',
    status: 'running',
    project: 'demo',
  });
  assert.equal((runningCard as any).header?.template, 'blue');

  const doneCard = buildStreamingCard({
    text: '代码审计完成！已生成依赖关系图。',
    status: 'done',
    durationSeconds: 4.2,
    imageKeys: ['img_v3_test123'],
  });
  assert.equal((doneCard as any).header?.template, 'green');
  const jsonStr = JSON.stringify(doneCard);
  assert.ok(jsonStr.includes('img_v3_test123'), '应包含图片的 key');
  assert.ok(jsonStr.includes('4.2s'), '应包含格式化后的执行耗时');
});

test('cards: buildStartupCard 包含应用名与快速开始按钮', () => {
  const card = buildStartupCard({
    botName: 'Antigravity Bot',
    defaultRoot: '~/project',
    defaultModel: 'gemini-3.8-flash-high',
    effort: 'high',
    yolo: true,
  });
  assert.equal((card as any).header?.template, 'turquoise');
  const jsonStr = JSON.stringify(card);
  assert.ok(jsonStr.includes('Antigravity Bot'), '应包含机器人名称');
  assert.ok(jsonStr.includes('YOLO'), '应包含 YOLO 模式提示');
  assert.ok(jsonStr.includes('bind_card'), '应包含工作区绑定按钮');
});

test('cards: 按钮 value 必须是对象、下拉 options.value 必须是字符串（飞书回传值约定）', () => {
  // 按钮：value 必须是 key-value JSON 对象，回调落在 action.value
  const startup = buildStartupCard({ defaultRoot: '/tmp', yolo: true }) as any;
  const startupButtons = startup.elements.find((e: any) => e.tag === 'action').actions;
  assert.equal(startupButtons.length, 3, '启动卡应有 3 个快捷入口按钮');
  for (const button of startupButtons) {
    assert.equal(
      typeof button.value,
      'object',
      `按钮「${button.text.content}」的 value 必须是对象（传 JSON 字符串会被飞书规范化掉）`
    );
    assert.equal(typeof button.value.action, 'string');
  }

  const bind = buildBindCard({
    currentPath: '/tmp',
    defaultRoot: '/tmp',
    projects: { demo: '/tmp/demo' },
  }) as any;
  const bindActionElements = bind.elements.filter((e: any) => e.tag === 'action');

  // 下拉：options[].value 必须是字符串，回调落在 action.option
  const bindSelect = bindActionElements[0].actions[0];
  assert.equal(bindSelect.tag, 'select_static');
  assert.equal(typeof bindSelect.options[0].value, 'string', '下拉 options.value 必须是字符串');
  assert.equal(JSON.parse(bindSelect.options[0].value).action, 'switch_project');

  const createButton = bindActionElements[1].actions.find((b: any) =>
    JSON.stringify(b.value).includes('prompt_create_project')
  );
  assert.equal(typeof createButton.value, 'object', '新建项目按钮的 value 必须是对象');

  const model = buildModelCard({ models: [{ id: 'm1', displayName: 'M1' }] }) as any;
  const modelSelect = model.elements.find((e: any) => e.tag === 'action').actions[0];
  assert.equal(typeof modelSelect.options[0].value, 'string', '模型下拉 options.value 必须是字符串');
  assert.equal(JSON.parse(modelSelect.options[0].value).action, 'switch_model');
});

test('cards: renderProgressBar 渲染剩余比例进度条', () => {
  assert.equal(renderProgressBar(1), '██████████');
  assert.equal(renderProgressBar(0), '░░░░░░░░░░');
  assert.equal(renderProgressBar(0.92), '█████████░');
  assert.equal(renderProgressBar(0.5), '█████░░░░░');
  // 越界输入不能抛异常
  assert.equal(renderProgressBar(-1), '░░░░░░░░░░');
  assert.equal(renderProgressBar(3), '██████████');
});

test('cards: formatResetCountdown 输出中文倒计时', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  assert.equal(formatResetCountdown('2026-09-30T12:00:30Z', now), '即将重置');
  assert.equal(formatResetCountdown('2026-09-30T12:30:00Z', now), '30 分钟后重置');
  assert.equal(formatResetCountdown('2026-09-30T17:00:00Z', now), '5 小时后重置');
  assert.equal(formatResetCountdown('2026-10-06T13:00:00Z', now), '6 天 1 小时后重置');
  assert.equal(formatResetCountdown('2026-10-01T12:00:00Z', now), '1 天后重置');
  assert.equal(formatResetCountdown(undefined, now), undefined);
  assert.equal(formatResetCountdown('not-a-date', now), undefined);
});

test('cards: renderQuotaSection 渲染分组、百分比与进度条', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const text = renderQuotaSection(
    {
      fetchedAt: now,
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', resetTime: '2026-10-06T13:00:00Z', remainingFraction: 0.91864115 },
            { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', resetTime: '2026-09-30T12:30:00Z', remainingFraction: 0.79 },
          ],
        },
      ],
    },
    now
  );

  assert.ok(text.includes('额度用量'), '应包含额度区块标题');
  assert.ok(text.includes('Gemini Models'), '应包含分组名');
  assert.ok(text.includes('Gemini Flash, Gemini Pro'), '应包含分组内的模型说明');
  assert.ok(text.includes('每周'), 'weekly 窗口应本地化为「每周」');
  assert.ok(text.includes('5 小时'), '5h 窗口应本地化为「5 小时」');
  assert.ok(text.includes('**92%**'), '应包含四舍五入后的剩余百分比');
  assert.ok(text.includes('█████████░'), '应包含进度条');
  assert.ok(text.includes('6 天 1 小时后重置'), '应包含重置倒计时');
  assert.ok(text.includes('30 分钟后重置'), '应包含 5 小时窗口的倒计时');

  // 无数据时降级为占位文案
  const fallback = renderQuotaSection(undefined, now);
  assert.ok(fallback.includes('暂不可用'), '无数据应显示降级文案');
});

test('cards: buildModelCard 嵌入额度区块（有数据 / 无数据两种）', () => {
  const models = [
    { id: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)', isThinking: true },
  ];

  const withQuota = JSON.stringify(
    buildModelCard({
      models,
      quota: {
        fetchedAt: Date.now(),
        groups: [
          {
            displayName: 'Claude and GPT models',
            description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
            buckets: [
              { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', resetTime: '2026-10-07T13:26:15Z', remainingFraction: 1 },
            ],
          },
        ],
      },
    })
  );
  assert.ok(withQuota.includes('额度用量'), '应渲染额度区块');
  assert.ok(withQuota.includes('Claude and GPT models'), '应渲染分组名');
  assert.ok(withQuota.includes('100%'), '应渲染剩余百分比');
  assert.ok(withQuota.includes('select_static'), '额度区块不得影响模型下拉');

  const withoutQuota = JSON.stringify(buildModelCard({ models }));
  assert.ok(withoutQuota.includes('暂不可用'), '无额度数据时应降级展示占位');
  assert.ok(withoutQuota.includes('select_static'), '降级时模型下拉仍应在');
});

test('cards: buildShutdownCard 包含停止原因与重启提示', () => {
  const card = buildShutdownCard({
    reason: '收到 SIGINT 终止信号 (用户停止)',
  });
  assert.equal((card as any).header?.template, 'carmine');
  const jsonStr = JSON.stringify(card);
  assert.ok(jsonStr.includes('SIGINT'), '应包含终止原因');
  assert.ok(jsonStr.includes('npm run lark'), '应包含重启建议命令');
});

