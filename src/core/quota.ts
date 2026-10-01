import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { QuotaBucket, QuotaConfig, QuotaGroup, QuotaSummary } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * 额度接口的 User-Agent。
 *
 * ⚠️ 后端会校验 UA 前缀：不带 `antigravitycli/` 一律返回
 * 403 `SUBSCRIPTION_REQUIRED`。实测 `antigravitycli/1.2.14` 与
 * `antigravitycli/1.2.14 (darwin; arm64)` 均可通过。
 */
export const DEFAULT_QUOTA_USER_AGENT = 'antigravitycli/1.2.14';

/** macOS Keychain 中 Antigravity CLI 存放令牌的 service / account。 */
export const DEFAULT_KEYCHAIN_SERVICE = 'gemini';
export const DEFAULT_KEYCHAIN_ACCOUNT = 'antigravity';

/**
 * Antigravity / Gemini CLI 公开 OAuth 客户端 ID。
 * 仅在「Keychain 与令牌文件都过期」时用于自刷新 access_token。
 * 客户端 Secret 严禁硬编码在源码中，需通过 `config.json` 的 `agy.quota.oauthClientSecret` 注入。
 */
export const DEFAULT_OAUTH_CLIENT_ID = '';
export const DEFAULT_OAUTH_CLIENT_SECRET = '';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const QUOTA_ENDPOINT =
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';

/** 额度缓存有效期：卡片回调要求 3 秒内响应，命中缓存避免重复取数。 */
export const QUOTA_CACHE_TTL_MS = 60_000;

/** access_token 过期前多久就视为需要刷新。 */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** Keychain 中值的编码前缀（Go keyring 库）。 */
const KEYRING_PREFIX = 'go-keyring-base64:';

interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  /** 过期时间戳（毫秒），未知则 undefined */
  expiresAt?: number;
}

let quotaCache: { at: number; summary: QuotaSummary } | undefined;
let tokenCache: StoredToken | undefined;

function defaultTokenPath(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
}

function parseTokenPayload(payload: unknown): StoredToken | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const root = payload as Record<string, any>;
  const token = (root.token && typeof root.token === 'object' ? root.token : root) as Record<string, any>;

  const accessToken = token.access_token;
  if (typeof accessToken !== 'string' || !accessToken) return undefined;

  let expiresAt: number | undefined;
  if (typeof token.expiry === 'string') {
    const parsed = Date.parse(token.expiry);
    if (!Number.isNaN(parsed)) expiresAt = parsed;
  } else if (typeof token.expiry_date === 'number') {
    expiresAt = token.expiry_date;
  }

  return {
    accessToken,
    refreshToken: typeof token.refresh_token === 'string' ? token.refresh_token : undefined,
    expiresAt,
  };
}

/** 从 macOS Keychain 读取 CLI 写入的令牌（非 macOS 或未登录时返回 undefined）。 */
async function readKeychainToken(opts: QuotaConfig): Promise<StoredToken | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const service = opts.keychainService || DEFAULT_KEYCHAIN_SERVICE;
  const account = opts.keychainAccount || DEFAULT_KEYCHAIN_ACCOUNT;

  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      { timeout: opts.timeoutMs || 5000 }
    );
    const raw = stdout.trim();
    if (!raw) return undefined;

    const json = raw.startsWith(KEYRING_PREFIX)
      ? Buffer.from(raw.slice(KEYRING_PREFIX.length), 'base64').toString('utf8')
      : raw;

    return parseTokenPayload(JSON.parse(json));
  } catch {
    // 未登录 / 无该条目 / 无权限：交给下一级来源
    return undefined;
  }
}

/** 从 CLI 的令牌文件读取（CLI 只在登录时写入，通常已过期，作为兜底）。 */
function readTokenFile(opts: QuotaConfig): StoredToken | undefined {
  const filePath = opts.tokenPath || defaultTokenPath();
  try {
    if (!fs.existsSync(filePath)) return undefined;
    return parseTokenPayload(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return undefined;
  }
}

interface HttpResult {
  status: number;
  body: string;
}

/** curl 输出末尾附带的 HTTP 状态码标记 */
const HTTP_STATUS_MARKER = '\n__AGY_HTTP_STATUS__:';

let curlChecked = false;
let curlAvailable = false;

/** 检测系统 curl 是否可用（只检测一次）。 */
async function hasCurl(): Promise<boolean> {
  if (!curlChecked) {
    curlChecked = true;
    curlAvailable = await new Promise<boolean>((resolve) => {
      execFile('curl', ['--version'], (err) => resolve(!err));
    });
  }
  return curlAvailable;
}

/**
 * POST 请求。
 *
 * 优先走系统 `curl`：它天然遵守 `http_proxy` / `https_proxy` / `all_proxy` / `no_proxy`，
 * 而 Node 内置 `fetch`（undici）**默认不读代理环境变量**，
 * 在需要代理才能访问 Google 的网络下会直接超时。
 * 仅当系统无 curl 时才回退到 `fetch`（直连场景）。
 */
async function httpPost(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number
): Promise<HttpResult | undefined> {
  if (await hasCurl()) {
    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
    const headerArgs = Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
    try {
      const { stdout } = await execFileAsync(
        'curl',
        [
          '-sS',
          '-X',
          'POST',
          url,
          ...headerArgs,
          '--data-binary',
          body,
          '--max-time',
          String(timeoutSec),
          '-w',
          `${HTTP_STATUS_MARKER}%{http_code}`,
        ],
        { timeout: timeoutMs + 2000, maxBuffer: 4 * 1024 * 1024 }
      );

      const idx = stdout.lastIndexOf(HTTP_STATUS_MARKER);
      if (idx < 0) return undefined;
      const status = Number(stdout.slice(idx + HTTP_STATUS_MARKER.length).trim());
      if (!Number.isFinite(status)) return undefined;
      return { status, body: stdout.slice(0, idx) };
    } catch (err: any) {
      // curl 已执行但失败（网络/超时）：不再回退 fetch，避免翻倍等待
      // 脱敏告警：避免 err.message 携带命令行参数（可能包含凭据）泄露到终端日志
      const safeReason = err?.code ? `code=${err.code}` : (err?.name || '网络超时或执行失败');
      console.warn(`[agy-lark] 额度相关请求失败 (${safeReason})`);
      return undefined;
    }
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, body: await res.text() };
  } catch (err: any) {
    const safeReason = err?.name || 'fetch 失败';
    console.warn(`[agy-lark] 额度相关请求失败 (${safeReason})`);
    return undefined;
  }
}

/** 用 refresh_token 自刷新 access_token（不写回磁盘，避免干扰 CLI 自身状态）。 */
async function refreshAccessToken(
  token: StoredToken,
  opts: QuotaConfig
): Promise<StoredToken | undefined> {
  if (!token.refreshToken) return undefined;

  const clientId = opts.oauthClientId || DEFAULT_OAUTH_CLIENT_ID;
  const clientSecret = opts.oauthClientSecret || DEFAULT_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    // 未配置有效 OAuth 凭据，无法自刷新，安全降级
    return undefined;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: token.refreshToken,
    grant_type: 'refresh_token',
  });

  const result = await httpPost(
    TOKEN_ENDPOINT,
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    body.toString(),
    opts.timeoutMs || 8000
  );
  if (!result || result.status !== 200) return undefined;

  try {
    const data = JSON.parse(result.body) as Record<string, any>;
    if (typeof data.access_token !== 'string' || !data.access_token) return undefined;

    const expiresIn = Number(data.expires_in);
    return {
      accessToken: data.access_token,
      refreshToken: token.refreshToken,
      expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : undefined,
    };
  } catch {
    return undefined;
  }
}

function isUsable(token: StoredToken | undefined): token is StoredToken {
  if (!token) return false;
  if (token.expiresAt === undefined) return true; // 无过期信息时先尝试使用
  return token.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now();
}

async function resolveAccessToken(opts: QuotaConfig): Promise<string | undefined> {
  if (isUsable(tokenCache)) return tokenCache!.accessToken;

  const fromKeychain = await readKeychainToken(opts);
  if (isUsable(fromKeychain)) {
    tokenCache = fromKeychain;
    return fromKeychain!.accessToken;
  }

  const fromFile = readTokenFile(opts);
  if (isUsable(fromFile)) {
    tokenCache = fromFile;
    return fromFile!.accessToken;
  }

  const stale = fromKeychain || fromFile;
  if (!stale) return undefined;

  const refreshed = await refreshAccessToken(stale, opts);
  if (!isUsable(refreshed)) return undefined;
  tokenCache = refreshed;
  return refreshed!.accessToken;
}

function clampFraction(value: unknown): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/** 把接口原始响应归一化成稳定的 `QuotaSummary`（丢弃脏数据，绝不抛异常）。 */
export function normalizeQuotaSummary(payload: unknown): QuotaSummary | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const root = payload as Record<string, any>;
  const rawGroups = Array.isArray(root.groups) ? root.groups : [];

  const groups: QuotaGroup[] = [];
  for (const rawGroup of rawGroups) {
    if (!rawGroup || typeof rawGroup !== 'object') continue;
    const displayName = rawGroup.displayName;
    if (typeof displayName !== 'string' || !displayName) continue;

    const rawBuckets = Array.isArray(rawGroup.buckets) ? rawGroup.buckets : [];
    const buckets: QuotaBucket[] = [];
    for (const rawBucket of rawBuckets) {
      if (!rawBucket || typeof rawBucket !== 'object') continue;
      if (typeof rawBucket.displayName !== 'string' || !rawBucket.displayName) continue;

      buckets.push({
        bucketId: typeof rawBucket.bucketId === 'string' ? rawBucket.bucketId : '',
        displayName: rawBucket.displayName,
        window: typeof rawBucket.window === 'string' ? rawBucket.window : '',
        resetTime: typeof rawBucket.resetTime === 'string' ? rawBucket.resetTime : undefined,
        description: typeof rawBucket.description === 'string' ? rawBucket.description : undefined,
        remainingFraction: clampFraction(rawBucket.remainingFraction),
      });
    }

    if (buckets.length === 0) continue;
    groups.push({
      displayName,
      description: typeof rawGroup.description === 'string' ? rawGroup.description : undefined,
      buckets,
    });
  }

  if (groups.length === 0) return undefined;

  return {
    groups,
    description: typeof root.description === 'string' ? root.description : undefined,
    fetchedAt: Date.now(),
  };
}

/**
 * 拉取额度汇总。**任何失败都返回 `undefined`**（未开启 / 未登录 / 令牌过期 / 网络异常），
 * 由调用方降级展示，绝不把异常抛到卡片回调里。
 */
export async function fetchQuotaSummary(opts: QuotaConfig = {}): Promise<QuotaSummary | undefined> {
  if (opts.enabled === false) return undefined;

  const cached = getCachedQuota();
  if (cached) return cached;

  const token = await resolveAccessToken(opts);
  if (!token) return undefined;

  const result = await httpPost(
    QUOTA_ENDPOINT,
    {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': opts.userAgent || DEFAULT_QUOTA_USER_AGENT,
    },
    '{}',
    opts.timeoutMs || 8000
  );
  if (!result) return undefined;

  if (result.status !== 200) {
    // 令牌可能刚失效：清掉内存令牌，下次重新解析
    tokenCache = undefined;
    console.warn(`[agy-lark] 额度接口返回 ${result.status}，本次降级展示`);
    return undefined;
  }

  try {
    const summary = normalizeQuotaSummary(JSON.parse(result.body));
    if (!summary) return undefined;

    quotaCache = { at: Date.now(), summary };
    return summary;
  } catch {
    return undefined;
  }
}

/** 同步读取额度缓存（供飞书 3 秒回调热路径使用）。 */
export function getCachedQuota(): QuotaSummary | undefined {
  if (!quotaCache) return undefined;
  if (Date.now() - quotaCache.at > QUOTA_CACHE_TTL_MS) return undefined;
  return quotaCache.summary;
}

/** 清空额度与令牌缓存（测试与配置变更时使用）。 */
export function clearQuotaCache(): void {
  quotaCache = undefined;
  tokenCache = undefined;
}
