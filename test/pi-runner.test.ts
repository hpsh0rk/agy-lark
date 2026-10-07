import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { runPi, resolvePiBinary, buildPiEnvironment } from '../src/core/pi-runner.js';
import { BridgeError } from '../src/core/errors.js';

test('pi-runner: 单元与流式事件测试套件', async (t) => {
  await t.test('resolvePiBinary: 优先级与路径解析', () => {
    assert.equal(resolvePiBinary('/custom/bin/pi'), '/custom/bin/pi');
    const defaultResolved = resolvePiBinary();
    assert.ok(defaultResolved.includes('pi'));
  });

  await t.test('buildPiEnvironment: 补全 PATH 环境变量', () => {
    const env = buildPiEnvironment();
    assert.ok(env.PATH && env.PATH.length > 0);
  });

  await t.test('runPi: 成功解析 NDJSON 流式事件、Token 统计与回调', async () => {
    // 创建一个临时 mock 脚本模拟 pi --mode json
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mock-'));
    const mockScriptPath = path.join(tmpDir, 'mock-pi.js');

    const mockScriptContent = `#!/usr/bin/env node
console.log('Some non-json startup log line');
console.log(JSON.stringify({ type: 'session', id: 'session_pi_12345', cwd: process.cwd() }));
console.log(JSON.stringify({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', delta: 'Hello, ' }
}));
console.log(JSON.stringify({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', delta: 'from Pi!' }
}));
console.log(JSON.stringify({
  type: 'turn_end',
  message: {
    usage: { input: 120, output: 45, reasoning: 10, cacheRead: 50, totalTokens: 165 }
  }
}));
process.exit(0);
`;
    fs.writeFileSync(mockScriptPath, mockScriptContent, { mode: 0o755 });

    let capturedInit: any = null;
    let deltas: string[] = [];

    const result = await runPi(
      {
        prompt: 'say hello',
        cwd: tmpDir,
        onInit: (info) => {
          capturedInit = info;
        },
        onDelta: (chunk) => {
          deltas.push(chunk);
        },
      },
      {
        binary: mockScriptPath,
        timeoutMs: 0,
      }
    );

    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.conversationId, 'session_pi_12345');
    assert.equal(result.response, 'Hello, from Pi!');
    assert.deepEqual(deltas, ['Hello, ', 'from Pi!']);
    assert.ok(capturedInit);
    assert.equal(capturedInit.conversationId, 'session_pi_12345');
    assert.ok(result.usage);
    assert.equal(result.usage.inputTokens, 120);
    assert.equal(result.usage.outputTokens, 45);
    assert.equal(result.usage.thinkingTokens, 10);
    assert.equal(result.usage.cacheReadTokens, 50);
    assert.equal(result.usage.totalTokens, 165);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test('runPi: 进程异常退出报错 E_PI_RUN_FAILED', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mock-fail-'));
    const mockScriptPath = path.join(tmpDir, 'mock-pi-fail.js');

    const mockScriptContent = `#!/usr/bin/env node
console.error('Fatal: Invalid API Key');
process.exit(1);
`;
    fs.writeFileSync(mockScriptPath, mockScriptContent, { mode: 0o755 });

    await assert.rejects(
      async () => {
        await runPi(
          {
            prompt: 'test error',
            cwd: tmpDir,
          },
          {
            binary: mockScriptPath,
            timeoutMs: 0,
          }
        );
      },
      (err: any) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'E_PI_RUN_FAILED');
        assert.ok(err.message.includes('Fatal: Invalid API Key'));
        return true;
      }
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test('runPi: 响应 AbortSignal 中断 E_PI_ABORTED', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mock-abort-'));
    const mockScriptPath = path.join(tmpDir, 'mock-pi-abort.js');

    const mockScriptContent = `#!/usr/bin/env node
setTimeout(() => {
  console.log('done');
}, 10000);
`;
    fs.writeFileSync(mockScriptPath, mockScriptContent, { mode: 0o755 });

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);

    await assert.rejects(
      async () => {
        await runPi(
          {
            prompt: 'long task',
            cwd: tmpDir,
            signal: ac.signal,
          },
          {
            binary: mockScriptPath,
            timeoutMs: 0,
          }
        );
      },
      (err: any) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'E_PI_ABORTED');
        return true;
      }
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test('runPi: 退出码为 0 但包含 503 或 stopReason: error 时必须 reject 拒绝', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mock-503-'));
    const mockScriptPath = path.join(tmpDir, 'mock-pi-503.js');

    const mockScriptContent = `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'session', id: 'conv-503', cwd: process.cwd() }));
console.log(JSON.stringify({
  type: 'turn_end',
  message: {
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage: '503: all accounts are temporarily unavailable, please retry later'
  }
}));
console.log(JSON.stringify({
  type: 'auto_retry_end',
  success: false,
  finalError: '503: all accounts are temporarily unavailable, please retry later'
}));
process.exit(0);
`;
    fs.writeFileSync(mockScriptPath, mockScriptContent, { mode: 0o755 });

    await assert.rejects(
      async () => {
        await runPi(
          { prompt: 'test 503', cwd: tmpDir },
          { binary: mockScriptPath, timeoutMs: 0 }
        );
      },
      (err: any) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'E_PI_RUN_FAILED');
        assert.ok(err.message.includes('503: all accounts are temporarily unavailable'));
        return true;
      }
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test('runPi: options.imagePaths 正确作为 @image 传参', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mock-img-'));
    const mockScriptPath = path.join(tmpDir, 'mock-pi-img.js');
    const dummyImg = path.join(tmpDir, 'test.png');
    fs.writeFileSync(dummyImg, 'fake-png');

    const mockScriptContent = `#!/usr/bin/env node
const args = process.argv.slice(2);
const hasImageArg = args.includes('@' + process.env.TEST_IMG);
if (!hasImageArg) {
  process.exit(1);
}
console.log(JSON.stringify({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', delta: 'Image received!' }
}));
process.exit(0);
`;
    fs.writeFileSync(mockScriptPath, mockScriptContent, { mode: 0o755 });

    process.env.TEST_IMG = dummyImg;
    const res = await runPi(
      {
        prompt: 'describe image',
        cwd: tmpDir,
        imagePaths: [dummyImg],
      },
      { binary: mockScriptPath, timeoutMs: 0 }
    );

    assert.equal(res.response, 'Image received!');
    delete process.env.TEST_IMG;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test('runPi: 成功捕获 tool_execution_start 与 tool_execution_end 并触发 onStep', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mock-tool-'));
    const mockScriptPath = path.join(tmpDir, 'mock-pi-tool.js');

    const mockScriptContent = `#!/usr/bin/env node
console.log(JSON.stringify({
  type: 'tool_execution_start',
  toolName: 'read_file',
  args: { path: 'src/index.ts' }
}));
console.log(JSON.stringify({
  type: 'tool_execution_end',
  toolName: 'read_file',
  result: 'file content ok',
  isError: false
}));
console.log(JSON.stringify({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', delta: 'File read successfully.' }
}));
process.exit(0);
`;
    fs.writeFileSync(mockScriptPath, mockScriptContent, { mode: 0o755 });

    const capturedSteps: any[] = [];
    const res = await runPi(
      {
        prompt: 'read index',
        cwd: tmpDir,
        onStep: (step) => {
          capturedSteps.push(step);
        },
      },
      { binary: mockScriptPath, timeoutMs: 0 }
    );

    assert.equal(res.status, 'SUCCESS');
    assert.equal(res.response, 'File read successfully.');
    assert.ok(capturedSteps.length >= 2, '应捕获至少 2 个 step 事件');
    assert.equal(capturedSteps[0].stepType, 'tool');
    assert.equal(capturedSteps[0].state, 'ACTIVE');
    assert.equal(capturedSteps[0].toolName, 'read_file');
    assert.ok(capturedSteps[0].summary.includes('read_file'));
    assert.equal(capturedSteps[1].stepType, 'tool');
    assert.equal(capturedSteps[1].state, 'DONE');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
