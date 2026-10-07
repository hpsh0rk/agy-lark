import type { AgentEngine } from './types.js';

export interface TaskRecord {
  id: string;
  sessionKey: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  threadId?: string;
  messageId: string;
  botMessageId?: string;
  engine: AgentEngine;
  projectName?: string;
  cwd: string;
  prompt: string;
  startedAt: number;
  status: 'running' | 'completed' | 'aborted' | 'error';
  abortController: AbortController;
  durationSeconds?: number;
  error?: string;
}

let counter = 1000;

function generateTaskId(): string {
  counter += 1;
  const rand = Math.random().toString(36).substring(2, 5);
  return `t-${counter % 10000}-${rand}`;
}

export class TaskManager {
  private tasks: Map<string, TaskRecord> = new Map();
  private maxHistory = 100;

  public createTask(params: {
    sessionKey: string;
    chatId: string;
    chatType: 'p2p' | 'group';
    threadId?: string;
    messageId: string;
    engine: AgentEngine;
    projectName?: string;
    cwd: string;
    prompt: string;
  }): TaskRecord {
    const id = generateTaskId();
    const abortController = new AbortController();
    const record: TaskRecord = {
      id,
      sessionKey: params.sessionKey,
      chatId: params.chatId,
      chatType: params.chatType,
      threadId: params.threadId,
      messageId: params.messageId,
      engine: params.engine,
      projectName: params.projectName,
      cwd: params.cwd,
      prompt: params.prompt,
      startedAt: Date.now(),
      status: 'running',
      abortController,
    };

    this.tasks.set(id, record);
    this.pruneHistory();
    return record;
  }

  public setBotMessageId(taskId: string, botMessageId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.botMessageId = botMessageId;
    }
  }

  public finishTask(taskId: string, status: 'completed' | 'aborted' | 'error', error?: string): void {
    const task = this.tasks.get(taskId);
    if (task && task.status === 'running') {
      task.status = status;
      task.durationSeconds = (Date.now() - task.startedAt) / 1000;
      task.error = error;
    }
  }

  public abortTask(taskId: string): TaskRecord | undefined {
    const task = this.tasks.get(taskId);
    if (task && task.status === 'running') {
      task.status = 'aborted';
      task.durationSeconds = (Date.now() - task.startedAt) / 1000;
      task.abortController.abort();
      return task;
    }
    return undefined;
  }

  public abortSessionTasks(sessionKey: string): TaskRecord[] {
    const aborted: TaskRecord[] = [];
    for (const task of this.tasks.values()) {
      if (task.sessionKey === sessionKey && task.status === 'running') {
        task.status = 'aborted';
        task.durationSeconds = (Date.now() - task.startedAt) / 1000;
        task.abortController.abort();
        aborted.push(task);
      }
    }
    return aborted;
  }

  public abortAll(): TaskRecord[] {
    const aborted: TaskRecord[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === 'running') {
        task.status = 'aborted';
        task.durationSeconds = (Date.now() - task.startedAt) / 1000;
        task.abortController.abort();
        aborted.push(task);
      }
    }
    return aborted;
  }

  public getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  public getActiveTaskBySession(sessionKey: string): TaskRecord | undefined {
    for (const task of this.tasks.values()) {
      if (task.sessionKey === sessionKey && task.status === 'running') {
        return task;
      }
    }
    return undefined;
  }

  public getActiveTasks(): TaskRecord[] {
    const active: TaskRecord[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === 'running') {
        active.push(task);
      }
    }
    // 按开始时间正序排列（运行时间最长的在前）
    return active.sort((a, b) => a.startedAt - b.startedAt);
  }

  public getAllTasks(): TaskRecord[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.startedAt - a.startedAt);
  }

  public formatDuration(seconds: number): string {
    const sec = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(sec / 3600);
    const minutes = Math.floor((sec % 3600) / 60);
    const remainingSec = sec % 60;

    if (hours > 0) {
      return `${hours}小时 ${minutes}分 ${remainingSec}秒`;
    }
    if (minutes > 0) {
      return `${minutes}分 ${remainingSec}秒`;
    }
    return `${remainingSec}秒`;
  }

  private pruneHistory(): void {
    if (this.tasks.size <= this.maxHistory) return;
    const completedOrAborted: TaskRecord[] = [];
    for (const t of this.tasks.values()) {
      if (t.status !== 'running') {
        completedOrAborted.push(t);
      }
    }
    completedOrAborted.sort((a, b) => a.startedAt - b.startedAt);
    while (this.tasks.size > this.maxHistory && completedOrAborted.length > 0) {
      const oldest = completedOrAborted.shift();
      if (oldest) {
        this.tasks.delete(oldest.id);
      }
    }
  }
}
