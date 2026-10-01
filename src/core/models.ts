import { spawn } from 'node:child_process';
import type { ModelInfo } from './types.js';

/** 模型列表缓存有效期：飞书卡片回调要求 3 秒内响应，命中缓存可避免超时丢响应。 */
export const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

let modelCache: { at: number; models: ModelInfo[] } | undefined;

/**
 * 读取已缓存的模型列表（未命中或已过期返回 undefined）。
 * 供卡片回调等「必须在 3 秒内响应」的路径同步取用，避免在热路径上 spawn `agy models`。
 */
export function getCachedModels(): ModelInfo[] | undefined {
  if (!modelCache) return undefined;
  if (Date.now() - modelCache.at > MODEL_CACHE_TTL_MS) return undefined;
  return modelCache.models;
}

/** 清空模型缓存（测试与配置变更时使用）。 */
export function clearModelCache(): void {
  modelCache = undefined;
}

export async function fetchAvailableModels(binary = 'agy'): Promise<ModelInfo[]> {
  const cached = getCachedModels();
  if (cached) return cached;

  const models = await queryModels(binary);
  modelCache = { at: Date.now(), models };
  return models;
}

async function queryModels(binary: string): Promise<ModelInfo[]> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['models'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
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
        // Strip ANSI control characters from spinners etc.
        const line = rawLine.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
        if (!line || line.startsWith('Fetching') || line.startsWith('Usage:') || line.startsWith('List available')) {
          continue;
        }

        // Typical line: "gemini-3.8-flash-high     Gemini 3.8 Flash (High)"
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
