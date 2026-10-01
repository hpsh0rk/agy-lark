import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgy } from '../src/core/runner.js';

test('runner: 端到端测试套件', { concurrency: false }, async (t) => {
  await t.test('单轮问答与用量捕获', async () => {
    let initCalled = false;
    let convId = '';
    let deltaText = '';

    const result = await runAgy({
      prompt: '只回复两个字：测试',
      cwd: process.cwd(),
      onInit: (info) => {
        initCalled = true;
        convId = info.conversationId;
      },
      onDelta: (chunk) => {
        deltaText += chunk;
      },
    });

    assert.equal(initCalled, true, '应收到 init 事件');
    assert.ok(convId.length > 10, '应捕获到有效 conversation_id');
    assert.equal(result.status, 'SUCCESS');
    assert.ok(result.response.includes('测试') || deltaText.includes('测试'));
    assert.ok(result.durationSeconds > 0, '执行耗时应大于 0');
    assert.ok(result.usage && result.usage.totalTokens > 0, '应返回 Token 用量统计');
  });

  await t.test('多轮会话续聊 (Conversation Resume)', async () => {
    // 第 1 轮
    const r1 = await runAgy({
      prompt: '我们的秘密暗号是【火星探索】。只需回复两个字：收到',
      cwd: process.cwd(),
    });

    assert.equal(r1.status, 'SUCCESS');
    const convId = r1.conversationId;
    assert.ok(convId && convId.length > 10);

    // 第 2 轮续聊
    const r2 = await runAgy({
      prompt: '请问我们刚才约定的秘密暗号是什么？',
      cwd: process.cwd(),
      conversationId: convId,
    });

    assert.equal(r2.status, 'SUCCESS');
    assert.ok(r2.response.includes('火星探索'), `第二轮应续聊同一会话并答出暗号，实际输出: ${r2.response}`);
    assert.equal(r2.conversationId, convId, '两轮会话 ID 应当一致');
  });
});

