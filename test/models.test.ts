import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAvailableModels, getFallbackModels, getCachedModels, clearModelCache } from '../src/core/models.js';

test('models: 能从本地 agy models 获取模型列表', async () => {
  const models = await fetchAvailableModels();
  assert.ok(Array.isArray(models), '应返回数组');
  assert.ok(models.length > 0, '模型列表不应为空');

  const flash = models.find((m) => m.id.includes('flash'));
  assert.ok(flash, '应包含 flash 系列模型');
  assert.ok(flash.displayName.length > 0, '展示名称非空');

  const fallback = getFallbackModels();
  assert.ok(fallback.length >= 5, 'Fallback 模型定义完备');
});

test('models: 列表结果会被缓存，供卡片回调热路径同步取用', async () => {
  clearModelCache();
  assert.equal(getCachedModels(), undefined, '初始应无缓存');

  const models = await fetchAvailableModels('agy-binary-that-does-not-exist');

  const cached = getCachedModels();
  assert.ok(cached, '拉取后应写入缓存');
  assert.deepEqual(cached, models);
});
