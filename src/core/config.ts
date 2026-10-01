import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { BridgeConfig, ProxyConfig } from './types.js';

/**
 * 配置候选路径（按优先级排列，命中即止）：
 *   1. 显式传入的 customPath
 *   2. 当前工作目录下的 ./config.json
 *   3. 用户主目录下的 ~/.agy-lark/config.json
 */
function configSearchPaths(customPath?: string): string[] {
  return [
    customPath,
    path.join(process.cwd(), 'config.json'),
    path.join(os.homedir(), '.agy-lark', 'config.json'),
  ].filter(Boolean) as string[];
}

/**
 * 返回第一个存在的配置文件路径，用于诊断与报错提示。
 */
export function resolveConfigPath(customPath?: string): string | undefined {
  return configSearchPaths(customPath).find((p) => fs.existsSync(p));
}

/**
 * 加载桥接配置。
 *
 * ⚠️ 配置**只从配置文件读取，不读取任何环境变量**。
 * 飞书机器人凭据（appId / appSecret / verificationToken / encryptKey /
 * notifyReceiveId / notifyReceiveIdType）以及 workspace / agy 配置项，
 * 全部必须写在 config.json 中。
 */
export function loadBridgeConfig(customPath?: string): BridgeConfig {
  const home = os.homedir();
  let fileConfig: Partial<BridgeConfig> = {};

  for (const p of configSearchPaths(customPath)) {
    if (!fs.existsSync(p)) continue;
    try {
      fileConfig = JSON.parse(fs.readFileSync(p, 'utf8'));
      break;
    } catch {
      // 该文件无法解析，继续尝试下一个候选路径
    }
  }

  return {
    lark: {
      appId: fileConfig.lark?.appId || '',
      appSecret: fileConfig.lark?.appSecret || '',
      verificationToken: fileConfig.lark?.verificationToken || '',
      encryptKey: fileConfig.lark?.encryptKey || '',
      notifyReceiveId: fileConfig.lark?.notifyReceiveId || '',
      notifyReceiveIdType: (fileConfig.lark?.notifyReceiveIdType || 'open_id') as any,
    },
    workspace: {
      defaultRoot: fileConfig.workspace?.defaultRoot || path.join(home, 'project'),
      projects: fileConfig.workspace?.projects || {},
    },
    agy: {
      binary: fileConfig.agy?.binary || 'agy',
      defaultModel: fileConfig.agy?.defaultModel || '',
      effort: (fileConfig.agy?.effort as any) || 'high',
      timeoutMs: fileConfig.agy?.timeoutMs || 600000,
      quota: fileConfig.agy?.quota ? { ...fileConfig.agy.quota } : undefined,
    },
    proxy: fileConfig.proxy ? { ...fileConfig.proxy } : undefined,
  };
}

/** `proxy` 的字段到环境变量的映射；数组顺序即写入顺序。 */
const PROXY_ENVIRONMENT: Array<[keyof ProxyConfig, string]> = [
  ['http', 'HTTP_PROXY'],
  ['https', 'HTTPS_PROXY'],
  ['all', 'ALL_PROXY'],
  ['no', 'NO_PROXY'],
];

/**
 * 把 config.json 的 `proxy` 写进当前进程环境，返回真正写入的变量名。
 *
 * 只填补**尚未设置**的变量：交互式 shell 里由 ClashX 之类注入的代理优先级更高，
 * 而 launchd 拉起的进程一个都没有 —— 于是 `spawn('agy')` 会卡在连 Google 的
 * `SYN_SENT` 上直到超时。子进程（spawn agy / execFile curl）继承本进程环境，
 * 所以在启动时写一次就够了。
 */
export function applyProxyEnvironment(config: BridgeConfig): string[] {
  if (!config.proxy) return [];
  const applied: string[] = [];
  for (const [field, variable] of PROXY_ENVIRONMENT) {
    const value = config.proxy[field];
    if (!value || process.env[variable]) continue;
    process.env[variable] = value;
    applied.push(variable);
  }
  return applied;
}
