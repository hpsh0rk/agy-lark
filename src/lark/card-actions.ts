import type { WorkspaceManager } from '../core/workspace.js';
import type { SessionStore } from '../core/sessions.js';
import type { QuotaConfig } from '../core/types.js';
import { fetchAvailableModels, getCachedModels } from '../core/models.js';
import { fetchQuotaSummary, getCachedQuota } from '../core/quota.js';
import { buildBindCard, buildHelpCard, buildModelCard } from './cards.js';

export interface CardActionContext {
  workspace: WorkspaceManager;
  sessions: SessionStore;
  agyBinary: string;
  defaultModel?: string;
  /** 额度取数配置；不传则用 core/quota.ts 的内置默认值 */
  quota?: QuotaConfig;
}

export type ToastType = 'info' | 'success' | 'error' | 'warning';

export interface CardActionToast {
  type: ToastType;
  content: string;
}

/**
 * 新版卡片回传交互回调 (card.action.trigger) 的响应结构体。
 * 参考: https://open.feishu.cn/document/feishu-cards/card-callback-communication
 *
 * ⚠️ card 必须是 `{ type: 'raw', data: <卡片 JSON> }`。
 * 直接把卡片对象塞进 card 字段是旧版回调 (card.action.trigger_v1) 的格式，
 * 新版回调会判定为非法卡片（错误码 200673）并**静默丢弃卡片更新**，
 * 表现就是「只弹了一个 toast，卡片没有任何变化」。
 *
 * ⚠️ 回调必须在 3 秒内响应，超时飞书会丢弃整个响应（toast + card 都不会展示）。
 */
export interface CardActionResponse {
  toast?: CardActionToast;
  card?: { type: 'raw'; data: Record<string, unknown> };
}

function respond(card: Record<string, unknown>, toast?: CardActionToast): CardActionResponse {
  return {
    ...(toast ? { toast } : {}),
    card: { type: 'raw', data: card },
  };
}

/** 下拉选择类组件的选中项回传值在 `action.option`；按钮 / 折叠按钮组在 `action.value`。 */
const SELECT_TAGS = new Set(['select_static', 'multi_select_static']);

/**
 * 取出卡片回传的交互数据。
 *
 * ⚠️ 不同组件的回传位置不同（飞书官方「按钮 / 下拉选择-单选」文档的回调示例）：
 * - `button` / `overflow`：自定义回传值在 `action.value`
 * - `select_static` / `multi_select_static`：**选中项**的回传值在 `action.option`，
 *   而 `action.value` 只有在组件自身配置了 `value` / `behaviors` 时才有值。
 *
 * 早期实现只读 `action.value`，导致模型 / 项目下拉框选中后一律被判为
 * 「未知的卡片操作」并直接返回，表现为「选完没有任何反馈、卡片也不更新」。
 */
function pickActionPayload(
  action: any
): { payload: unknown; source: 'value' | 'option' } | undefined {
  const tag = typeof action?.tag === 'string' ? action.tag : '';
  const order: Array<'value' | 'option'> = SELECT_TAGS.has(tag)
    ? ['option', 'value']
    : ['value', 'option'];

  for (const source of order) {
    const candidate = action?.[source];
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === 'string' && candidate.trim() === '') continue;
    if (
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      Object.keys(candidate).length === 0
    ) {
      continue;
    }
    return { payload: candidate, source };
  }
  return undefined;
}

/**
 * 把回传数据解包成「对象」或「action 名字符串」。
 * 兼容历史卡片 / 旧版客户端把 JSON 再包一层字符串（双重编码）的情况。
 */
function normalizeActionPayload(
  payload: unknown
): { ok: true; value: unknown } | { ok: false } {
  if (typeof payload !== 'string') return { ok: true, value: payload };

  let current: unknown = payload;
  let depth = 0;
  while (typeof current === 'string' && depth < 3) {
    const trimmed = current.trim();
    if (!trimmed) return { ok: false };

    let next: unknown;
    try {
      next = JSON.parse(trimmed);
    } catch {
      // 第一层就解析失败 → 报文非法；已解过一层 → 把该字符串当作 action 名
      return depth === 0 ? { ok: false } : { ok: true, value: current };
    }
    depth += 1;
    if (next === current) break;
    current = next;
  }
  return { ok: true, value: current };
}

/** 从解包结果中提取 action 名与业务数据。 */
function extractAction(normalized: unknown): { name: string; data: any } {
  if (typeof normalized === 'string') return { name: normalized, data: {} };
  if (!normalized || typeof normalized !== 'object') return { name: '', data: {} };

  const obj = normalized as Record<string, any>;
  if (typeof obj.action === 'string') return { name: obj.action, data: obj };

  // 兼容 { action: { action: 'help', ... } } 这类多包一层的情况
  if (obj.action && typeof obj.action === 'object') {
    const inner = obj.action as Record<string, any>;
    return { name: typeof inner.action === 'string' ? inner.action : '', data: inner };
  }
  return { name: '', data: obj };
}

function describePayload(payload: unknown): string {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const raw = text ?? String(payload);
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}

export async function handleCardAction(
  data: any,
  ctx: CardActionContext
): Promise<CardActionResponse> {
  const tag = typeof data?.action?.tag === 'string' ? data.action.tag : 'unknown';
  const picked = pickActionPayload(data?.action);
  if (!picked) {
    console.warn(`[agy-lark] 卡片回调缺少可识别的回传数据 (组件=${tag})`);
    return { toast: { type: 'error', content: '未收到可识别的卡片操作数据，请重试' } };
  }

  const normalized = normalizeActionPayload(picked.payload);
  if (!normalized.ok) {
    console.warn(
      `[agy-lark] 卡片回传数据解析失败 (组件=${tag}) 原始回传=${describePayload(picked.payload)}`
    );
    return { toast: { type: 'error', content: '卡片数据解析失败，请重试' } };
  }

  const { name: actionName, data: parsed } = extractAction(normalized.value);
  const startedAt = Date.now();
  console.log(
    `[agy-lark] 收到卡片操作 [${actionName || '(缺少 action 字段)'}] 组件=${tag} ` +
      `回传字段=${picked.source} 原始回传=${describePayload(picked.payload)}`
  );

  if (!actionName) {
    return { toast: { type: 'error', content: '卡片数据缺少操作标识，请重试' } };
  }

  try {
    const res = await dispatchCardAction(actionName, parsed, data, ctx);
    console.log(`[agy-lark] 卡片操作 [${actionName}] 已响应，耗时 ${Date.now() - startedAt}ms`);
    return res;
  } catch (err: any) {
    // 兜底：任何未预期异常都必须回一个明确的失败提示，不能静默无响应
    console.error(`[agy-lark] 卡片操作 [${actionName}] 异常:`, err);
    return { toast: { type: 'error', content: `卡片操作失败: ${err?.message || err}` } };
  }
}

async function dispatchCardAction(
  actionName: string,
  parsed: any,
  data: any,
  ctx: CardActionContext
): Promise<CardActionResponse> {
  // 新版回调把上下文放在 context 里，旧版回调平铺在顶层，两者都兼容。
  const chatId = data.context?.open_chat_id || data.open_chat_id || '';
  const chatType =
    data.context?.open_chat_type === 'group' || data.open_chat_type === 'group' ? 'group' : 'p2p';

  // 卡片回调不携带 thread_id，无法用 open_message_id 还原出消息会话的 sessionKey。
  // 若拿 open_message_id 当 threadId 会新建一个「影子会话」，导致切换的模型/项目
  // 落不到真正在对话的那个会话上。因此优先按 chatId 复用最近活跃的会话。
  const session =
    ctx.sessions.findLatestByChatId(chatId) ??
    ctx.sessions.getOrCreate({
      chatId,
      chatType,
      defaultCwd: ctx.workspace.getDefaultRoot(),
    });

  // ---- 启动卡片上的三个快捷入口按钮 ----
  if (actionName === 'help') {
    return respond(buildHelpCard(), { type: 'info', content: '已展开指令帮助' });
  }

  if (actionName === 'bind_card') {
    return respond(
      buildBindCard({
        currentProject: session.projectName,
        currentPath: session.cwd,
        defaultRoot: ctx.workspace.getDefaultRoot(),
        projects: ctx.workspace.listProjects(),
      }),
      { type: 'info', content: '已展开项目工作区面板' }
    );
  }

  if (actionName === 'model_card') {
    // 模型列表（spawn agy，冷路径可达 3s+）与额度（HTTP）并行取数；
    // 两者命中缓存时均为毫秒级，确保在飞书 3 秒回调超时前返回。
    const [models, quota] = await Promise.all([
      getCachedModels() ?? fetchAvailableModels(ctx.agyBinary),
      getCachedQuota() ?? fetchQuotaSummary(ctx.quota),
    ]);
    return respond(
      buildModelCard({
        currentModel: session.model || ctx.defaultModel,
        models,
        sessionUsage: session.totalUsage,
        quota,
      }),
      { type: 'info', content: '已展开模型与额度面板' }
    );
  }

  // ---- 卡片内的具体操作 ----
  if (actionName === 'switch_project') {
    const projName = parsed.projectName;
    if (!projName) {
      return { toast: { type: 'error', content: '未获取到要绑定的项目别名，请重新打开面板' } };
    }

    const targetPath = ctx.workspace.getProjectPath(projName);
    if (!targetPath) {
      return { toast: { type: 'error', content: `项目别名 "${projName}" 不存在` } };
    }

    const updated = ctx.sessions.update(session.sessionKey, {
      projectName: projName,
      cwd: targetPath,
      conversationId: undefined, // Reset conversation ID when project changes
    });
    if (!updated) {
      return { toast: { type: 'error', content: '会话不存在，项目绑定失败，请重新打开面板' } };
    }

    const updatedCard = buildBindCard({
      currentProject: projName,
      currentPath: targetPath,
      defaultRoot: ctx.workspace.getDefaultRoot(),
      projects: ctx.workspace.listProjects(),
    });

    return respond(updatedCard, {
      type: 'success',
      content: `已成功绑定并切换到项目: ${projName}`,
    });
  }

  if (actionName === 'prompt_create_project') {
    return {
      toast: {
        type: 'info',
        content: `请直接回复: /bind create <项目名> (将在 ${ctx.workspace.getDefaultRoot()} 下创建)`,
      },
    };
  }

  if (actionName === 'prompt_add_project') {
    return {
      toast: {
        type: 'info',
        content: '请直接回复: /bind add <项目别名> <已有目录路径> (例如: /bind add my-web ~/project/my-web)',
      },
    };
  }

  if (actionName === 'prompt_delete_project') {
    return {
      toast: {
        type: 'info',
        content: '请直接回复: /bind delete <项目别名> 移除项目映射',
      },
    };
  }

  if (actionName === 'switch_model') {
    const modelId = parsed.modelId;
    if (!modelId) {
      return { toast: { type: 'error', content: '未获取到要切换的模型 ID，请重新打开模型面板' } };
    }

    const updated = ctx.sessions.update(session.sessionKey, {
      model: modelId,
    });
    if (!updated) {
      return { toast: { type: 'error', content: '会话不存在，模型切换失败，请重新打开模型面板' } };
    }

    // 打开模型面板时已拉取并缓存过列表，命中缓存即可避免在热路径上 spawn `agy models`，
    // 从而保证在飞书 3 秒回调超时前返回（超时会让 toast 与卡片更新一起被丢弃）。
    const [models, quota] = await Promise.all([
      getCachedModels() ?? fetchAvailableModels(ctx.agyBinary),
      getCachedQuota() ?? fetchQuotaSummary(ctx.quota),
    ]);
    const updatedCard = buildModelCard({
      currentModel: modelId,
      models,
      sessionUsage: updated.totalUsage ?? session.totalUsage,
      quota,
    });

    return respond(updatedCard, {
      type: 'success',
      content: `模型已切换为: ${modelId}`,
    });
  }

  return { toast: { type: 'info', content: `未识别的卡片操作: ${actionName || '(空)'}` } };
}
