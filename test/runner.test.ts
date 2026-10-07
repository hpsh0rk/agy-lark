import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgy, resolveAgyBinary, buildAgyEnvironment, summarizeToolCall } from '../src/core/runner.js';

test('runner: 工具调用描述与环境解析单元测试', async (t) => {
  await t.test('summarizeToolCall: 常见工具参数格式化与截断', () => {
    assert.equal(summarizeToolCall(), '思考与分析需求');
    assert.equal(summarizeToolCall('other_tool'), '调用 other_tool');
    assert.equal(
      summarizeToolCall('run_command', { CommandLine: 'find . -name "*.md"' }),
      '执行命令 `find . -name "*.md"`'
    );
    assert.equal(
      summarizeToolCall('view_file', { AbsolutePath: '/User/sh0rk/project/src/index.ts' }),
      '查看文件 `src/index.ts`'
    );
    assert.equal(
      summarizeToolCall('replace_file_content', { TargetFile: '/User/sh0rk/project/src/cards.ts' }),
      '编辑文件 `src/cards.ts`'
    );
    assert.equal(
      summarizeToolCall('grep_search', { query: 'buildStreamingCard' }),
      '检索 `buildStreamingCard`'
    );
    assert.equal(
      summarizeToolCall('generate_image', { prompt: 'a beautiful sunset over mountains' }),
      '生成图片: a beautiful sunset over m'
    );
  });

  await t.test('resolveAgyBinary 与 buildAgyEnvironment', () => {
    const resolved = resolveAgyBinary();
    assert.ok(resolved.includes('agy'));
    const env = buildAgyEnvironment();
    assert.ok(env.PATH && env.PATH.length > 0);
  });
});

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

  await t.test('非法模型错误拒绝与异常信息提取', async () => {
    await assert.rejects(
      async () => {
        await runAgy({
          prompt: 'test',
          cwd: process.cwd(),
          model: 'invalid-model-selection-xyz',
        });
      },
      (err: any) => {
        assert.equal(err.code, 'E_AGY_RUN_FAILED');
        assert.ok(
          err.message.includes('invalid model selection') || err.message.includes('not recognized'),
          `错误信息中应完整包含 CLI 报错，实际: ${err.message}`
        );
        return true;
      }
    );
  });
});

