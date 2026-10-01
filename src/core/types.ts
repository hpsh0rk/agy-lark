export interface AgyUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface AgyInitInfo {
  conversationId: string;
  cwd: string;
  tools: string[];
  permissionMode?: string;
}

export interface AgyStepInfo {
  index: number;
  stepType: string;
  state: string;
  toolName?: string;
  textDelta?: string;
  durationSeconds?: number;
}

export interface AgyRunResult {
  status: 'SUCCESS' | 'ERROR';
  response: string;
  conversationId: string;
  durationSeconds: number;
  usage?: AgyUsage;
  imagePaths?: string[];
}

export interface AgyRunOptions {
  prompt: string;
  cwd: string;
  conversationId?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  timeoutMs?: number;
  signal?: AbortSignal;
  onInit?: (info: AgyInitInfo) => void;
  onDelta?: (text: string) => void;
  onStep?: (step: AgyStepInfo) => void;
  onImage?: (imagePaths: string[]) => void;
  onResult?: (result: AgyRunResult) => void;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  isThinking?: boolean;
}

/**
 * 额度（Quota）数据结构。
 * 对应 Antigravity CLI 内部接口 `v1internal:retrieveUserQuotaSummary` 的响应，
 * 也就是 CLI 里 `/used` 展示的那份数据。
 */
export interface QuotaBucket {
  bucketId: string;
  displayName: string;
  /** 额度窗口：`weekly` / `5h` 等 */
  window: string;
  /** ISO8601 时间字符串（UTC），下一次重置时刻 */
  resetTime?: string;
  description?: string;
  /** 剩余比例 0~1 */
  remainingFraction?: number;
}

export interface QuotaGroup {
  displayName: string;
  description?: string;
  buckets: QuotaBucket[];
}

export interface QuotaSummary {
  groups: QuotaGroup[];
  description?: string;
  /** 本地取数时间戳（毫秒） */
  fetchedAt: number;
}

/** 额度取数配置（全部可选，默认值见 core/quota.ts）。 */
export interface QuotaConfig {
  enabled?: boolean;
  userAgent?: string;
  keychainService?: string;
  keychainAccount?: string;
  tokenPath?: string;
  timeoutMs?: number;
  /** 自刷新 token 用的 OAuth 客户端（默认为 Antigravity CLI 内置的公开客户端） */
  oauthClientId?: string;
  oauthClientSecret?: string;
}

export interface WorkspaceConfig {
  defaultRoot: string;
  projects: Record<string, string>;
}

export interface ActiveTarget {
  receiveId: string;
  receiveIdType: 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id';
  updatedAt: number;
}

export interface LarkConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  notifyReceiveId?: string;
  notifyReceiveIdType?: 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id';
}

/**
 * 本机出网代理（可选）。
 *
 * `agy` 是 Go 二进制、额度取数走 `curl`，两者都只认 `HTTP_PROXY` /
 * `HTTPS_PROXY` / `ALL_PROXY` 环境变量（都不读 macOS 系统代理设置）。由 launchd
 * 拉起的进程没有交互式 shell 注入的代理变量，所以把它写进 config.json 是服务在
 * 后台运行时仍能连上 Google 的唯一来源。
 */
export interface ProxyConfig {
  http?: string;
  https?: string;
  all?: string;
  no?: string;
}

export interface BridgeConfig {
  lark: LarkConfig;
  workspace: WorkspaceConfig;
  agy: {
    binary?: string;
    defaultModel?: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
    timeoutMs?: number;
    quota?: QuotaConfig;
  };
  proxy?: ProxyConfig;
}

export interface SessionEntry {
  sessionKey: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  threadId?: string;
  projectName?: string;
  cwd: string;
  conversationId?: string;
  model?: string;
  lastActive: number;
  totalUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
  };
}
