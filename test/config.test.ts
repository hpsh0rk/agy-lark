import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadBridgeConfig } from '../src/core/config.js';

test('config: 超时配置与零值 (0) 判定', async (t) => {
  await t.test('显式设置 timeoutMs: 0 时应被识别为 0（无限制运行），而不是回退到 600000', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    const configPath = path.join(tmpDir, 'config.json');

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        lark: { appId: 'test_app', appSecret: 'test_secret' },
        engine: 'pi',
        pi: {
          binary: 'pi',
          timeoutMs: 0,
        },
        agy: {
          binary: 'agy',
          timeoutMs: 0,
        },
      })
    );

    const config = loadBridgeConfig(configPath);
    assert.equal(config.engine, 'pi');
    assert.equal(config.pi?.timeoutMs, 0, 'pi.timeoutMs 应该严格为 0');
    assert.equal(config.agy.timeoutMs, 0, 'agy.timeoutMs 应该严格为 0');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test('未配置 timeoutMs 时默认应为 0（不限时）', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-default-'));
    const configPath = path.join(tmpDir, 'config.json');

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        lark: { appId: 'test_app', appSecret: 'test_secret' },
        agy: {
          binary: 'agy',
        },
      })
    );

    const config = loadBridgeConfig(configPath);
    assert.equal(config.agy.timeoutMs, 0, '默认 timeoutMs 应该为 0');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
