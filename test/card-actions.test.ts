import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleCardAction, type CardActionContext } from '../src/lark/card-actions.js';
import { WorkspaceManager } from '../src/core/workspace.js';
import { SessionStore } from '../src/core/sessions.js';

// 不存在的二进制会让 fetchAvailableModels 走 fallback 模型列表，无需真实 agy。
const FAKE_AGY = 'agy-binary-that-does-not-exist';

function makeCtx(): { ctx: CardActionContext; sessions: SessionStore; workspace: WorkspaceManager } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-card-action-'));
  const sessions = new SessionStore(path.join(tmpDir, 'sessions.json'));
  const workspace = new WorkspaceManager(path.join(tmpDir, 'workspace.json'));
  const ctx: CardActionContext = {
    workspace,
    sessions,
    agyBinary: FAKE_AGY,
    defaultModel: 'config-default-model',
  };
  return { ctx, sessions, workspace };
}

/** 构造一条新版 card.action.trigger 事件（经 SDK parse 解包后的形状）。 */
function cardEvent(action: string, extra: Record<string, unknown> = {}) {
  return {
    event_type: 'card.action.trigger',
    schema: '2.0',
    operator: { open_id: 'ou_user_1' },
    context: { open_chat_id: 'oc_chat_1', open_message_id: 'om_card_1' },
    action: { tag: 'button', value: JSON.stringify({ action, ...extra }) },
  };
}

test('card-actions: 启动卡三个按钮都返回卡片更新（而不是只弹 toast）', async () => {
  const { ctx } = makeCtx();

  for (const action of ['help', 'bind_card', 'model_card']) {
    const res = await handleCardAction(cardEvent(action), ctx);

    assert.ok(res.card, `action=${action} 必须返回 card，否则卡片不会展开`);
    assert.equal(res.card!.type, 'raw', `action=${action} 的 card 必须包在 { type: 'raw' } 里`);
    assert.ok(
      Array.isArray((res.card!.data as any).elements),
      `action=${action} 的卡片 elements 应为数组`
    );
    assert.ok((res.card!.data as any).header, `action=${action} 的卡片应带 header`);
  }
});

test('card-actions: help 卡片含指令清单，model_card 卡片含模型下拉', async () => {
  const { ctx } = makeCtx();

  const help = await handleCardAction(cardEvent('help'), ctx);
  const helpJson = JSON.stringify(help.card!.data);
  assert.ok(helpJson.includes('/bind'), '帮助卡片应包含 /bind 说明');
  assert.ok(helpJson.includes('/model'), '帮助卡片应包含 /model 说明');

  const model = await handleCardAction(cardEvent('model_card'), ctx);
  const modelJson = JSON.stringify(model.card!.data);
  assert.ok(modelJson.includes('select_static'), '模型卡片应包含模型下拉选择器');
  assert.ok(modelJson.includes('switch_model'), '模型卡片应包含 switch_model 回传值');
});

test('card-actions: bind_card 卡片含项目下拉与新建/删除按钮', async () => {
  const { ctx, workspace } = makeCtx();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-proj-'));
  workspace.registerProject('demo', projectDir);

  const res = await handleCardAction(cardEvent('bind_card'), ctx);
  const json = JSON.stringify(res.card!.data);
  assert.ok(json.includes('switch_project'), '绑定卡片应包含 switch_project 回传值');
  assert.ok(json.includes('prompt_create_project'), '绑定卡片应包含新建项目按钮');
  assert.ok(json.includes('prompt_delete_project'), '绑定卡片应包含删除项目按钮');
});

test('card-actions: 卡片操作复用消息会话，不创建影子会话', async () => {
  const { ctx, sessions } = makeCtx();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cwd-'));

  // 模拟用户先发消息：p2p 无 threadId，sessionKey = feishu:dm:<chatId>
  const msgSession = sessions.getOrCreate({ chatId: 'oc_chat_1', chatType: 'p2p', defaultCwd: cwd });
  assert.equal(msgSession.sessionKey, 'feishu:dm:oc_chat_1');

  const res = await handleCardAction(cardEvent('switch_model', { modelId: 'claude-sonnet-4-6' }), ctx);

  assert.equal(res.toast?.type, 'success');
  assert.equal(
    sessions.get('feishu:dm:oc_chat_1')?.model,
    'claude-sonnet-4-6',
    '模型必须写在消息会话上'
  );
  assert.equal(sessions.listAll().length, 1, '不应新增影子会话');
});

test('card-actions: switch_project 切换成功返回更新卡片，别名不存在时只返回错误 toast', async () => {
  const { ctx, sessions, workspace } = makeCtx();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-proj-'));
  workspace.registerProject('demo', projectDir);
  sessions.getOrCreate({ chatId: 'oc_chat_1', chatType: 'p2p', defaultCwd: projectDir });

  const ok = await handleCardAction(cardEvent('switch_project', { projectName: 'demo' }), ctx);
  assert.equal(ok.toast?.type, 'success');
  assert.ok(ok.card, '成功切换应回传更新后的绑定卡片');
  assert.equal(sessions.get('feishu:dm:oc_chat_1')?.projectName, 'demo');

  const bad = await handleCardAction(cardEvent('switch_project', { projectName: 'nope' }), ctx);
  assert.equal(bad.toast?.type, 'error');
  assert.equal(bad.card, undefined, '失败时不应回传卡片');
});

test('card-actions: 未知 action 与非法 payload 走兜底而不抛异常', async () => {
  const { ctx } = makeCtx();

  const unknown = await handleCardAction(cardEvent('not_implemented'), ctx);
  assert.equal(unknown.toast?.type, 'info');

  const broken = await handleCardAction(
    { context: { open_chat_id: 'oc_chat_1' }, action: { value: '{not-json' } },
    ctx
  );
  assert.equal(broken.toast?.type, 'error');

  const empty = await handleCardAction({ context: { open_chat_id: 'oc_chat_1' } }, ctx);
  assert.equal(empty.toast?.type, 'error');
});

/**
 * 构造一条 select_static 下拉选择回调。
 * 飞书官方回调示例：选中项的回传值在 `action.option`，
 * `action.value` 仅在组件自身配置了 value / behaviors 时才有值。
 */
function selectEvent(action: string, extra: Record<string, unknown> = {}) {
  return {
    event_type: 'card.action.trigger',
    schema: '2.0',
    operator: { open_id: 'ou_user_1' },
    context: { open_chat_id: 'oc_chat_1', open_message_id: 'om_card_1' },
    action: { tag: 'select_static', option: JSON.stringify({ action, ...extra }) },
  };
}

test('card-actions: select_static 下拉选中项回传在 action.option，必须被正确识别', async () => {
  const { ctx, sessions } = makeCtx();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cwd-'));
  sessions.getOrCreate({ chatId: 'oc_chat_1', chatType: 'p2p', defaultCwd: cwd });

  const res = await handleCardAction(
    selectEvent('switch_model', { modelId: 'claude-opus-4-6-thinking' }),
    ctx
  );

  assert.equal(res.toast?.type, 'success', '下拉切换模型必须给出成功提示');
  assert.ok(res.card, '下拉切换模型必须回传更新后的卡片');
  assert.equal(res.card!.type, 'raw');
  assert.equal(sessions.get('feishu:dm:oc_chat_1')?.model, 'claude-opus-4-6-thinking');
});

test('card-actions: 下拉切换项目同样走 action.option', async () => {
  const { ctx, sessions, workspace } = makeCtx();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-proj-'));
  workspace.registerProject('demo', projectDir);
  sessions.getOrCreate({ chatId: 'oc_chat_1', chatType: 'p2p', defaultCwd: projectDir });

  const res = await handleCardAction(selectEvent('switch_project', { projectName: 'demo' }), ctx);

  assert.equal(res.toast?.type, 'success');
  assert.equal(sessions.get('feishu:dm:oc_chat_1')?.projectName, 'demo');
});

test('card-actions: action.value 为空对象时回退到 action.option', async () => {
  const { ctx, sessions } = makeCtx();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cwd-'));
  sessions.getOrCreate({ chatId: 'oc_chat_1', chatType: 'p2p', defaultCwd: cwd });

  const res = await handleCardAction(
    {
      context: { open_chat_id: 'oc_chat_1' },
      action: {
        tag: 'select_static',
        value: {},
        option: JSON.stringify({ action: 'switch_model', modelId: 'gpt-oss-120b-medium' }),
      },
    },
    ctx
  );

  assert.equal(res.toast?.type, 'success');
  assert.equal(sessions.get('feishu:dm:oc_chat_1')?.model, 'gpt-oss-120b-medium');
});

test('card-actions: switch_model 缺少 modelId 时给出明确失败提示', async () => {
  const { ctx } = makeCtx();
  const res = await handleCardAction(cardEvent('switch_model'), ctx);

  assert.equal(res.toast?.type, 'error');
  assert.ok(res.toast?.content.includes('模型'), '失败提示应指明是模型相关问题');
});

test('card-actions: 三个面板入口都带明确反馈提示（不再静默）', async () => {
  const { ctx } = makeCtx();

  for (const action of ['help', 'bind_card', 'model_card']) {
    const res = await handleCardAction(cardEvent(action), ctx);
    assert.ok(res.toast, `action=${action} 应带提示文案`);
    assert.ok(res.card, `action=${action} 应带卡片更新`);
  }
});

test('card-actions: 按钮 value 为对象（官方推荐形式）也能识别', async () => {
  const { ctx, sessions } = makeCtx();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cwd-'));
  sessions.getOrCreate({ chatId: 'oc_chat_1', chatType: 'p2p', defaultCwd: cwd });

  const res = await handleCardAction(
    {
      context: { open_chat_id: 'oc_chat_1' },
      action: { tag: 'button', value: { action: 'switch_model', modelId: 'claude-sonnet-4-6' } },
    },
    ctx
  );

  assert.equal(res.toast?.type, 'success');
  assert.equal(sessions.get('feishu:dm:oc_chat_1')?.model, 'claude-sonnet-4-6');
});

test('card-actions: 双重编码的 JSON 字符串能自动解包', async () => {
  const { ctx, sessions } = makeCtx();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cwd-'));
  sessions.getOrCreate({ chatId: 'oc_chat_1', chatType: 'p2p', defaultCwd: cwd });

  const doubleEncoded = JSON.stringify(
    JSON.stringify({ action: 'switch_model', modelId: 'gemini-3.1-pro-high' })
  );
  const res = await handleCardAction(
    { context: { open_chat_id: 'oc_chat_1' }, action: { tag: 'button', value: doubleEncoded } },
    ctx
  );

  assert.equal(res.toast?.type, 'success', '双重编码报文必须能自动解包');
  assert.equal(sessions.get('feishu:dm:oc_chat_1')?.model, 'gemini-3.1-pro-high');
});

test('card-actions: 回传对象缺少 action 字段时给出明确失败提示', async () => {
  const { ctx } = makeCtx();
  const res = await handleCardAction(
    { context: { open_chat_id: 'oc_chat_1' }, action: { tag: 'button', value: { key: 'value' } } },
    ctx
  );

  assert.equal(res.toast?.type, 'error');
  assert.ok(res.toast?.content.length > 0, '失败提示不能为空');
});
