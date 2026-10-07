import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentEngine, BridgeConfig, ModelInfo, PiConfig, PiProviderInfo, SessionEntry } from './types.js';

/** 模型列表缓存有效期：飞书卡片回调要求 3 秒内响应，命中缓存可避免超时丢响应。 */
export const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

let agyModelCache: { at: number; models: ModelInfo[] } | undefined;
let piModelCache: { at: number; models: ModelInfo[] } | undefined;

/**
 * 读取已缓存的模型列表（未命中或已过期返回 undefined）。
 * 供卡片回调等「必须在 3 秒内响应」的路径同步取用，避免在热路径上 spawn 外部进程。
 */
export function getCachedModels(engine: AgentEngine = 'agy'): ModelInfo[] | undefined {
  const cache = engine === 'pi' ? piModelCache : agyModelCache;
  if (!cache) return undefined;
  if (Date.now() - cache.at > MODEL_CACHE_TTL_MS) return undefined;
  return cache.models;
}

/** 清空模型缓存（测试与配置变更时使用）。 */
export function clearModelCache(engine?: AgentEngine): void {
  if (!engine || engine === 'agy') {
    agyModelCache = undefined;
  }
  if (!engine || engine === 'pi') {
    piModelCache = undefined;
  }
}

/**
 * 根据指定引擎获取可用大模型列表，并自动落入对应引擎的缓存。
 */
export async function fetchModelsForEngine(engine: AgentEngine, config: BridgeConfig): Promise<ModelInfo[]> {
  if (engine === 'pi') {
    return fetchPiModels(config.pi);
  }
  return fetchAvailableModels(config.agy.binary);
}

/**
 * 获取 Antigravity (agy) 大模型列表（Gemini, Claude, GPT-OSS 等）。
 */
export async function fetchAvailableModels(binary = 'agy'): Promise<ModelInfo[]> {
  const cached = getCachedModels('agy');
  if (cached) return cached;

  const models = await queryAgyModels(binary);
  agyModelCache = { at: Date.now(), models };
  return models;
}

async function queryAgyModels(binary: string): Promise<ModelInfo[]> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['models'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.on('error', () => {
      resolve(getFallbackModels());
    });

    child.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        return resolve(getFallbackModels());
      }

      const models: ModelInfo[] = [];
      const lines = stdout.split('\n');
      for (const rawLine of lines) {
        const line = rawLine.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
        if (!line || line.startsWith('Fetching') || line.startsWith('Usage:') || line.startsWith('List available')) {
          continue;
        }

        const parts = line.split(/\s{2,}/);
        if (parts.length >= 2) {
          const id = parts[0].trim();
          const displayName = parts.slice(1).join(' ').trim();
          models.push({
            id,
            displayName,
            isThinking: displayName.toLowerCase().includes('thinking') || id.includes('high'),
          });
        } else {
          const single = line.split(/\s+/);
          if (single.length >= 2) {
            const id = single[0].trim();
            const displayName = single.slice(1).join(' ').trim();
            models.push({
              id,
              displayName,
              isThinking: displayName.toLowerCase().includes('thinking') || id.includes('high'),
            });
          }
        }
      }

      if (models.length > 0) {
        resolve(models);
      } else {
        resolve(getFallbackModels());
      }
    });
  });
}

/**
 * 获取 Pi Coding Agent (pi) 的模型列表。
 *
 * 优先读取用户在本地 ~/.pi/agent/models.json 与 settings.json 中已配置的有效 Provider 与模型列表，
 * 杜绝混入 Google Gemini 专有模型。
 */
export async function fetchPiModels(config?: PiConfig): Promise<ModelInfo[]> {
  const cached = getCachedModels('pi');
  if (cached) return cached;

  const models = queryPiModels(config);
  piModelCache = { at: Date.now(), models };
  return models;
}

function queryPiModels(config?: PiConfig): ModelInfo[] {
  const home = os.homedir();
  const modelsPath = path.join(home, '.pi', 'agent', 'models.json');
  const settingsPath = path.join(home, '.pi', 'agent', 'settings.json');
  const models: ModelInfo[] = [];
  const seenIds = new Set<string>();

  // 1. 读取 ~/.pi/agent/models.json 中声明的 Providers 与 Models
  if (fs.existsSync(modelsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
      if (data && typeof data === 'object' && data.providers) {
        for (const provKey of Object.keys(data.providers)) {
          const prov = data.providers[provKey];
          if (prov && Array.isArray(prov.models)) {
            for (const m of prov.models) {
              if (m && typeof m === 'object' && m.id && !seenIds.has(m.id)) {
                seenIds.add(m.id);
                const isThinking = !!m.reasoning || m.id.includes('reasoner') || m.id.includes('thinking');
                models.push({
                  id: m.id,
                  displayName: m.name ? `${m.name}` : m.id,
                  isThinking,
                });
              }
            }
          }
        }
      }
    } catch {
      // 容错继续
    }
  }

  // 2. 读取 settings.json 中的 defaultModel（如果未包含则追加）
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings && settings.defaultModel && typeof settings.defaultModel === 'string') {
        const def = settings.defaultModel;
        if (!seenIds.has(def)) {
          seenIds.add(def);
          models.unshift({
            id: def,
            displayName: def,
            isThinking: def.includes('reasoner') || def.includes('thinking') || def.includes('flash'),
          });
        }
      }
    } catch {
      // 容错继续
    }
  }

  // 3. 读取 config.json 中配置的 defaultModel
  if (config?.defaultModel && !seenIds.has(config.defaultModel)) {
    seenIds.add(config.defaultModel);
    models.unshift({
      id: config.defaultModel,
      displayName: config.defaultModel,
      isThinking: config.defaultModel.includes('reasoner') || config.defaultModel.includes('thinking'),
    });
  }

  // 4. 若无任何本地模型配置，提供 Pi 常见主流模型兜底（DeepSeek、Claude、OpenAI，绝不混入 Gemini）
  if (models.length === 0) {
    return getFallbackPiModels();
  }

  return models;
}

/**
 * 读取 Pi 的 Provider 与服务授权概要信息。
 */
export function getPiProviderInfo(config?: PiConfig): PiProviderInfo {
  const home = os.homedir();
  const modelsPath = path.join(home, '.pi', 'agent', 'models.json');
  const settingsPath = path.join(home, '.pi', 'agent', 'settings.json');

  let defaultProvider = config?.provider || 'local';
  let defaultModel = config?.defaultModel || '';
  let baseUrl = '';
  let api = '';
  let modelCount = 0;

  try {
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings && typeof settings === 'object') {
        if (settings.defaultProvider) defaultProvider = settings.defaultProvider;
        if (settings.defaultModel) defaultModel = settings.defaultModel;
      }
    }
  } catch (err: any) {
    console.warn(`[agy-lark] 读取 Pi settings 失败，使用默认 Provider 配置 [${settingsPath}]:`, err?.message || err);
  }

  try {
    if (fs.existsSync(modelsPath)) {
      const data = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
      if (data && typeof data === 'object' && data.providers) {
        const provObj = data.providers[defaultProvider] || Object.values(data.providers)[0];
        if (provObj && typeof provObj === 'object') {
          baseUrl = (provObj as any).baseUrl || '';
          api = (provObj as any).api || '';
          modelCount = Array.isArray((provObj as any).models) ? (provObj as any).models.length : 0;
        }
      }
    }
  } catch (err: any) {
    console.warn(`[agy-lark] 读取 Pi models 失败，模型计数归零 [${modelsPath}]:`, err?.message || err);
  }

  return {
    provider: defaultProvider,
    baseUrl,
    api,
    modelCount,
    defaultModel,
  };
}

/** Antigravity CLI 默认支持的模型兜底列表 */
export function getFallbackModels(): ModelInfo[] {
  return [
    { id: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)', isThinking: true },
    { id: 'gemini-3.8-flash-medium', displayName: 'Gemini 3.8 Flash (Medium)' },
    { id: 'gemini-3.7-flash-high', displayName: 'Gemini 3.7 Flash (High)', isThinking: true },
    { id: 'gemini-3.1-pro-high', displayName: 'Gemini 3.1 Pro (High)', isThinking: true },
    { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6 (Thinking)', isThinking: true },
    { id: 'claude-opus-4-6-thinking', displayName: 'Claude Opus 4.6 (Thinking)', isThinking: true },
    { id: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)' },
  ];
}

/** Pi Coding Agent 默认支持的模型兜底列表 (严禁混入 Google Gemini 模型) */
export function getFallbackPiModels(): ModelInfo[] {
  return [
    { id: 'deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash', isThinking: true },
    { id: 'claude-3-7-sonnet', displayName: 'Claude 3.7 Sonnet (Thinking)', isThinking: true },
    { id: 'claude-3-5-sonnet', displayName: 'Claude 3.5 Sonnet' },
    { id: 'gpt-4o', displayName: 'GPT-4o' },
    { id: 'deepseek-chat', displayName: 'DeepSeek Chat (V3)' },
    { id: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner (R1)', isThinking: true },
  ];
}

/**
 * 为指定引擎（agy 或 pi）解析适合该引擎的生效模型。
 * 杜绝跨引擎切换时的模型污染（如在 pi 选了 deepseek 切换到 agy 后导致 agy 启动崩溃，或在 agy 选了 gemini 传给 pi）。
 */
export function resolveModelForEngine(
  session: SessionEntry,
  engine: AgentEngine,
  config: BridgeConfig
): string | undefined {
  if (engine === 'agy') {
    // 1. 如果会话已记录专属于 agy 的模型，优先使用
    if (session.agyModel) {
      return session.agyModel;
    }
    // 2. 如果通用 session.model 存在，检查是否是合法/非 Pi 独占模型（如不包含冒号 Provider 前缀，且不含 deepseek / qwen 等）
    if (
      session.model &&
      !session.model.includes(':') &&
      !session.model.toLowerCase().includes('deepseek') &&
      !session.model.toLowerCase().includes('qwen')
    ) {
      return session.model;
    }
    // 3. 回退到 config 中配置的 agy 默认模型
    return config.agy?.defaultModel;
  } else {
    // engine === 'pi'
    // 1. 如果会话已记录专属于 pi 的模型，优先使用
    if (session.piModel) {
      return session.piModel;
    }
    // 2. 如果通用 session.model 存在，检查是否非 Google 专有模型（如不以 gemini- 开头）
    if (session.model && !session.model.toLowerCase().startsWith('gemini-')) {
      return session.model;
    }
    // 3. 回退到 config 中配置的 pi 默认模型
    return config.pi?.defaultModel;
  }
}
