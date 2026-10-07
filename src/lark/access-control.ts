import type { AccessControlConfig } from '../core/types.js';

export interface AccessRequest {
  /** 消息/卡片所属会话 ID（群聊 chat_id 或私聊 chat_id） */
  chatId?: string;
  /** 发送者/操作者 open_id；卡片回调取 data.operator.open_id */
  senderOpenId?: string;
}

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * 访问控制判定（纯函数，供消息事件与卡片回调共用）。
 *
 * 语义：
 * - 未启用（`enabled` 缺省或 false）→ 一律放行（行为与历史版本兼容）。
 * - 启用后为 **fail-closed**：用户 open_id 或会话 chat_id 任一命中白名单才放行；
 *   两个白名单均为空时视为未配置完成，同样拒绝（否则白名单形同虚设）。
 * - 拒绝不抛异常，只返回原因，由调用方决定静默忽略还是提示。
 */
export function checkAccess(
  config: AccessControlConfig | undefined,
  req: AccessRequest
): AccessDecision {
  if (!config?.enabled) {
    return { allowed: true };
  }

  const users = new Set((config.allowUsers || []).filter(Boolean));
  const chats = new Set((config.allowChats || []).filter(Boolean));

  if (users.size === 0 && chats.size === 0) {
    return { allowed: false, reason: '访问控制已启用但白名单为空 (allowUsers/allowChats 均未配置)' };
  }

  if (req.senderOpenId && users.has(req.senderOpenId)) {
    return { allowed: true };
  }
  if (req.chatId && chats.has(req.chatId)) {
    return { allowed: true };
  }

  return { allowed: false, reason: '发送者与会话均不在访问控制白名单内' };
}
