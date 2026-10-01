import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SessionEntry, ActiveTarget } from './types.js';

export function buildSessionKey(chatType: 'p2p' | 'group', chatId: string, threadId?: string): string {
  if (chatType === 'p2p') {
    return `feishu:dm:${chatId}${threadId ? `:${threadId}` : ''}`;
  }
  return `feishu:group:${chatId}${threadId ? `:${threadId}` : ':main'}`;
}

export class SessionStore {
  private filePath: string;
  private sessions: Map<string, SessionEntry> = new Map();
  private lastTarget?: ActiveTarget;

  constructor(customPath?: string) {
    const home = os.homedir();
    const defaultDir = path.join(home, '.agy-lark');
    this.filePath = customPath || path.join(defaultDir, 'sessions.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        let list: SessionEntry[] = [];
        if (Array.isArray(parsed)) {
          list = parsed;
        } else if (parsed && typeof parsed === 'object') {
          list = parsed.sessions || [];
          this.lastTarget = parsed.lastTarget;
        }
        for (const item of list) {
          this.sessions.set(item.sessionKey, item);
        }
      }
    } catch {
      // Start with empty store if read fails
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = {
        lastTarget: this.lastTarget,
        sessions: Array.from(this.sessions.values()),
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch {
      // Best-effort persistence
    }
  }

  public recordActiveTarget(target: {
    receiveId: string;
    receiveIdType: 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id';
  }): void {
    this.lastTarget = {
      receiveId: target.receiveId,
      receiveIdType: target.receiveIdType,
      updatedAt: Date.now(),
    };
    this.save();
  }

  public getLastActiveTarget(): ActiveTarget | undefined {
    if (this.lastTarget) {
      return this.lastTarget;
    }
    // Fallback: check most recently active session
    let latest: SessionEntry | undefined;
    for (const session of this.sessions.values()) {
      if (!latest || session.lastActive > latest.lastActive) {
        latest = session;
      }
    }
    if (latest) {
      return {
        receiveId: latest.chatId,
        receiveIdType: 'chat_id',
        updatedAt: latest.lastActive,
      };
    }
    return undefined;
  }

  public get(sessionKey: string): SessionEntry | undefined {
    return this.sessions.get(sessionKey);
  }

  /**
   * 按 chatId 找到最近活跃的会话。
   *
   * 卡片回调 (card.action.trigger) 只带 open_chat_id / open_message_id，
   * 不带 thread_id，无法还原消息会话的 sessionKey。用它反查已有会话，
   * 避免卡片操作落到另一个「影子会话」上。
   */
  public findLatestByChatId(chatId: string): SessionEntry | undefined {
    if (!chatId) return undefined;
    let latest: SessionEntry | undefined;
    for (const session of this.sessions.values()) {
      if (session.chatId !== chatId) continue;
      if (!latest || session.lastActive > latest.lastActive) {
        latest = session;
      }
    }
    return latest;
  }

  public getOrCreate(params: {
    chatId: string;
    chatType: 'p2p' | 'group';
    threadId?: string;
    defaultCwd: string;
    defaultProjectName?: string;
  }): SessionEntry {
    const key = buildSessionKey(params.chatType, params.chatId, params.threadId);
    let entry = this.sessions.get(key);
    if (!entry) {
      entry = {
        sessionKey: key,
        chatId: params.chatId,
        chatType: params.chatType,
        threadId: params.threadId,
        projectName: params.defaultProjectName,
        cwd: params.defaultCwd,
        lastActive: Date.now(),
      };
      this.sessions.set(key, entry);
      this.save();
    }
    return entry;
  }

  public update(sessionKey: string, partial: Partial<SessionEntry>): SessionEntry | undefined {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return undefined;

    Object.assign(entry, partial, { lastActive: Date.now() });
    this.sessions.set(sessionKey, entry);
    this.save();
    return entry;
  }

  public reset(sessionKey: string): SessionEntry | undefined {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return undefined;

    entry.conversationId = undefined;
    entry.lastActive = Date.now();
    this.sessions.set(sessionKey, entry);
    this.save();
    return entry;
  }

  public listAll(): SessionEntry[] {
    return Array.from(this.sessions.values());
  }
}
