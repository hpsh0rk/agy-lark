import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchAvailableModels,
  fetchPiModels,
  getFallbackModels,
  getFallbackPiModels,
  getCachedModels,
  clearModelCache,
  fetchModelsForEngine,
  getPiProviderInfo,
  resolveModelForEngine,
} from '../src/core/models.js';
import type { SessionEntry, BridgeConfig } from '../src/core/types.js';

test('models: 能从本地 agy models 获取模型列表', async () => {
  const models = await fetchAvailableModels();
  assert.ok(Array.isArray(models), '应返回数组');
  assert.ok(models.length > 0, '模型列表不应为空');

  const flash = models.find((m) => m.id.includes('flash'));
  assert.ok(flash, '应包含 flash 系列模型');
  assert.ok(flash.displayName.length > 0, '展示名称非空');

  const fallback = getFallbackModels();
  assert.ok(fallback.length >= 5, 'Fallback 模型定义完备');
  assert.ok(fallback.some((m) => m.id.includes('gemini')), 'agy 模型应包含 Gemini');
});

test('models: Pi 独立模型获取与兜底策略 (严禁混入 Gemini)', async () => {
  const piModels = await fetchPiModels();
  assert.ok(Array.isArray(piModels), 'Pi 模型应返回数组');
  assert.ok(piModels.length > 0, 'Pi 模型列表不应为空');

  // 严格校验：Pi 模型列表中严禁包含任何 gemini- 模型
  const hasGemini = piModels.some((m) => m.id.toLowerCase().includes('gemini'));
  assert.equal(hasGemini, false, 'Pi 引擎的模型列表中绝对不能出现 Gemini 模型');

  const fallbackPi = getFallbackPiModels();
  assert.ok(fallbackPi.length >= 4, 'Pi Fallback 模型定义完备');
  assert.ok(fallbackPi.some((m) => m.id.includes('deepseek')), 'Pi 默认应支持 DeepSeek');
  assert.equal(fallbackPi.some((m) => m.id.includes('gemini')), false);
});

test('models: agy 与 pi 的模型缓存独立隔离，互不污染', async () => {
  clearModelCache();
  assert.equal(getCachedModels('agy'), undefined, 'agy 初始应无缓存');
  assert.equal(getCachedModels('pi'), undefined, 'pi 初始应无缓存');

  const agyModels = await fetchAvailableModels('agy-mock-nonexistent');
  const piModels = await fetchPiModels();

  assert.ok(getCachedModels('agy'), 'agy 缓存应存在');
  assert.ok(getCachedModels('pi'), 'pi 缓存应存在');

  assert.deepEqual(getCachedModels('agy'), agyModels);
  assert.deepEqual(getCachedModels('pi'), piModels);

  // 清除 agy 缓存不影响 pi
  clearModelCache('agy');
  assert.equal(getCachedModels('agy'), undefined);
  assert.deepEqual(getCachedModels('pi'), piModels);

  // 清除 pi 缓存
  clearModelCache('pi');
  assert.equal(getCachedModels('pi'), undefined);
});

test('models: getPiProviderInfo 与 fetchModelsForEngine 路由分发', async () => {
  const providerInfo = getPiProviderInfo();
  assert.ok(providerInfo);
  assert.ok(typeof providerInfo.provider === 'string');

  const mockConfig: any = {
    agy: { binary: 'agy-nonexistent' },
    pi: { defaultModel: 'deepseek-v4.1-flash' },
  };

  const agyRes = await fetchModelsForEngine('agy', mockConfig);
  const piRes = await fetchModelsForEngine('pi', mockConfig);

  assert.ok(agyRes.some((m) => m.id.includes('gemini')), 'agyRes 应当包含 Gemini');
  assert.equal(piRes.some((m) => m.id.includes('gemini')), false, 'piRes 绝不包含 Gemini');
});

test('models: resolveModelForEngine 跨引擎模型隔离与防污染', () => {
  const config: BridgeConfig = {
    lark: {} as any,
    workspace: {} as any,
    engine: 'agy',
    agy: { defaultModel: 'gemini-3.8-flash-high' },
    pi: { defaultModel: 'deepseek-v4.1-flash' },
  };

  const baseSession: SessionEntry = {
    sessionKey: 'feishu:dm:test',
    chatId: 'oc_test',
    chatType: 'p2p',
    cwd: '/tmp',
    lastActive: Date.now(),
  };

  // 1. 当会话中遗留了 Pi 专属模型（如包含冒号或 deepseek/qwen）时，agy 引擎必须隔离并回退到 agy 默认模型
  const pollutedSession: SessionEntry = {
    ...baseSession,
    model: 'global:deepseek-v4.1-flash',
  };
  const resolvedAgy = resolveModelForEngine(pollutedSession, 'agy', config);
  assert.equal(
    resolvedAgy,
    'gemini-3.8-flash-high',
    'agy 引擎必须拦截 global:deepseek 模型并回退到 agy 默认模型，防止 agy 报错退出'
  );

  // 2. 当会话中遗留了 Gemini 模型时，pi 引擎必须隔离并回退到 pi 默认模型
  const geminiSession: SessionEntry = {
    ...baseSession,
    model: 'gemini-3.8-pro',
  };
  const resolvedPi = resolveModelForEngine(geminiSession, 'pi', config);
  assert.equal(
    resolvedPi,
    'deepseek-v4.1-flash',
    'pi 引擎必须拦截 gemini- 专有模型并回退到 pi 默认模型'
  );

  // 3. 当会话已分别记录 agyModel 和 piModel 时，严格独立隔离生效
  const isolatedSession: SessionEntry = {
    ...baseSession,
    agyModel: 'claude-sonnet-4-6',
    piModel: 'global:deepseek-v4.1-flash',
  };
  assert.equal(resolveModelForEngine(isolatedSession, 'agy', config), 'claude-sonnet-4-6');
  assert.equal(resolveModelForEngine(isolatedSession, 'pi', config), 'global:deepseek-v4.1-flash');

  // 4. 当通用合法模型时，平滑沿用
  const cleanSession: SessionEntry = {
    ...baseSession,
    model: 'claude-sonnet-4-6',
  };
  assert.equal(resolveModelForEngine(cleanSession, 'agy', config), 'claude-sonnet-4-6');
});

