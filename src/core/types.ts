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

export interface ExecutionStep {
  index: number;
  stepType: string;
  state: string;
  toolName?: string;
  summary: string;
  durationSeconds?: number;
}

export interface AgyStepInfo {
  index: number;
  stepType: string;
  state: string;
  toolName?: string;
  summary?: string;
  toolInfo?: {
    name?: string;
    parameters?: Record<string, unknown>;
    output?: string;
    error?: { message?: string };
  };
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
  imagePaths?: string[];
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

export type AgentEngine = 'agy' | 'pi';

/**
 * 访问控制（可选）。
 *
 * 机器人以 YOLO 模式在本机驱动 `agy` / `pi` 执行引擎，任何能向机器人发消息的
 * 用户理论上都可以触发本机命令执行。启用本配置后，只有白名单内的用户或会话
 * 可以触发消息处理与卡片交互，其余请求一律静默忽略（fail-closed）。
 */
export interface AccessControlConfig {
  /** 是否启用；默认 false（放行所有会话，仅建议纯私用且机器人不可被搜到时） */
  enabled?: boolean;
  /** 允许的用户 open_id 列表（命中即放行：私聊发起人、群聊发言人均适用） */
  allowUsers?: string[];
  /** 允许的会话 chat_id 列表（命中即放行整个群/单聊，群内所有成员均可使用） */
  allowChats?: string[];
  /** 拒绝时是否回复提示卡片；默认 false（静默忽略，避免群内刷屏与暴露机器人） */
  notifyDenied?: boolean;
}

export interface PiConfig {
  binary?: string;
  provider?: string;
  defaultModel?: string;
  thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutMs?: number;
}

export interface PiProviderInfo {
  provider: string;
  baseUrl?: string;
  api?: string;
  modelCount: number;
  defaultModel?: string;
}

export interface BridgeConfig {
  lark: LarkConfig;
  workspace: WorkspaceConfig;
  engine?: AgentEngine;
  agy: {
    binary?: string;
    defaultModel?: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
    timeoutMs?: number;
    quota?: QuotaConfig;
  };
  pi?: PiConfig;
  proxy?: ProxyConfig;
  accessControl?: AccessControlConfig;
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
  agyModel?: string;
  piModel?: string;
  engine?: AgentEngine;
  lastActive: number;
  totalUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
  };
}

export type AgentRunOptions = AgyRunOptions;
export type AgentRunResult = AgyRunResult;
export type AgentUsage = AgyUsage;
export type AgentStepInfo = AgyStepInfo;
export type AgentInitInfo = AgyInitInfo;
