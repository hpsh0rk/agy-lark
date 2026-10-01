import * as lark from '@larksuiteoapi/node-sdk';
import { WorkspaceManager } from '../core/workspace.js';
import { SessionStore, buildSessionKey } from '../core/sessions.js';
import { runAgy } from '../core/runner.js';
import { BridgeError } from '../core/errors.js';
import { fetchAvailableModels } from '../core/models.js';
import type { BridgeConfig, SessionEntry } from '../core/types.js';
import { buildHelpCard, buildBindCard, buildModelCard, buildStreamingCard } from './cards.js';
import { uploadImageToLark } from './uploader.js';

export class MessageDispatcher {
  private client: lark.Client;
  private config: BridgeConfig;
  private workspace: WorkspaceManager;
  private sessions: SessionStore;
  private activeTasks: Map<string, AbortController> = new Map();
  private processedMessageIds: Map<string, number> = new Map();

  constructor(client: lark.Client, config: BridgeConfig, workspace: WorkspaceManager, sessions: SessionStore) {
    this.client = client;
    this.config = config;
    this.workspace = workspace;
    this.sessions = sessions;
  }

  public async handleMessage(data: any): Promise<void> {
    const message = data.message;
    if (!message) {
      throw new BridgeError(
        'E_LARK_API_ERROR',
        '收到无法解析的飞书消息事件: 缺少 message 字段',
        '请检查开发者后台「事件与回调」中 im.message.receive_v1 的订阅配置与推送内容'
      );
    }

    const messageId = message.message_id;
    if (!messageId) {
      throw new BridgeError(
        'E_LARK_API_ERROR',
        '飞书消息事件缺少 message_id，无法执行幂等去重',
        '请确认订阅的是 im.message.receive_v1 (v2.0) 事件，而非旧版 v1 格式'
      );
    }

    // 1. 幂等去重检查 (彻底根治飞书超时重试导致的重复回复)
    if (this.processedMessageIds.has(messageId)) {
      console.log(`[agy-lark] 忽略重复消息推送: message_id=${messageId}`);
      return;
    }
    const now = Date.now();
    this.processedMessageIds.set(messageId, now);

    // 清理 10 分钟前的已处理 ID，限制内存占用
    if (this.processedMessageIds.size > 500) {
      for (const [id, ts] of this.processedMessageIds.entries()) {
        if (now - ts > 600000) {
          this.processedMessageIds.delete(id);
        }
      }
    }

    const chatId = message.chat_id;
    const chatType = message.chat_type === 'group' ? 'group' : 'p2p';
    const threadId = message.thread_id || message.root_id || (chatType === 'group' ? messageId : undefined);

    let rawText = '';
    try {
      const parsed = JSON.parse(message.content || '{}');
      rawText = parsed.text || '';
    } catch {
      rawText = message.content || '';
    }

    // Strip bot mention markers e.g. "@_user_1 "
    const cleanText = rawText.replace(/@_user_\d+\s*/g, '').trim();
    if (!cleanText) {
      // 纯 @机器人 / 图片 / 表情等无文本消息：没有内容可交给 agy，显式记录后跳过（不是错误）
      console.log(`[agy-lark] 忽略无文本消息: message_id=${messageId}`);
      return;
    }

    // Record active target for proactive notifications
    const senderOpenId = data.sender?.sender_id?.open_id;
    if (senderOpenId) {
      this.sessions.recordActiveTarget({
        receiveId: senderOpenId,
        receiveIdType: 'open_id',
      });
    } else if (chatId) {
      this.sessions.recordActiveTarget({
        receiveId: chatId,
        receiveIdType: 'chat_id',
      });
    }

    const session = this.sessions.getOrCreate({
      chatId,
      chatType,
      threadId,
      defaultCwd: this.workspace.getDefaultRoot(),
    });

    // Check commands
    if (cleanText.startsWith('/')) {
      const handled = await this.handleCommand(cleanText, messageId, chatId, chatType, threadId, session);
      if (handled) return;
    }

    // Regular prompt execution - 异步启动，避免阻塞 WebSocket 事件循环导致飞书超时重投
    this.executePrompt(cleanText, messageId, chatId, chatType, threadId, session).catch((err) => {
      console.error(`[agy-lark] Prompt 执行异步异常 [${messageId}]:`, err);
    });
  }

  private async replyCard(
    chatId: string,
    messageId: string,
    chatType: 'p2p' | 'group',
    card: Record<string, unknown>
  ): Promise<string> {
    const isGroup = chatType === 'group';
    const resp = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(card),
        msg_type: 'interactive',
        reply_in_thread: isGroup,
      },
    });

    if (resp.code !== 0 || !resp.data?.message_id) {
      throw new BridgeError(
        'E_LARK_API_ERROR',
        `发送卡片失败 [${resp.code}]: ${resp.msg}`,
        '请检查应用是否已开通 im:message 权限，以及机器人是否在会话可用范围内'
      );
    }
    return resp.data.message_id;
  }

  private async updateCard(cardMessageId: string, card: Record<string, unknown>): Promise<void> {
    try {
      await this.client.im.message.patch({
        path: { message_id: cardMessageId },
        data: {
          content: JSON.stringify(card),
        },
      });
    } catch (e) {
      // Ignore transient patch errors
    }
  }

  private async handleCommand(
    text: string,
    messageId: string,
    chatId: string,
    chatType: 'p2p' | 'group',
    threadId: string | undefined,
    session: SessionEntry
  ): Promise<boolean> {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg1 = parts[1];
    const arg2 = parts[2];

    switch (cmd) {
      case '/help': {
        const card = buildHelpCard();
        await this.replyCard(chatId, messageId, chatType, card);
        return true;
      }

      case '/bind': {
        if (arg1 === 'create') {
          if (!arg2) {
            const errCard = buildStreamingCard({
              text: '用法: `/bind create <项目名>`\n例如: `/bind create my-new-app`',
              status: 'error',
              errorMessage: '缺少项目名称参数',
            });
            await this.replyCard(chatId, messageId, chatType, errCard);
            return true;
          }

          try {
            const newPath = this.workspace.createProject(arg2);
            this.sessions.update(session.sessionKey, {
              projectName: arg2,
              cwd: newPath,
              conversationId: undefined,
            });
            const card = buildBindCard({
              currentProject: arg2,
              currentPath: newPath,
              defaultRoot: this.workspace.getDefaultRoot(),
              projects: this.workspace.listProjects(),
            });
            await this.replyCard(chatId, messageId, chatType, card);
          } catch (e: any) {
            const errCard = buildStreamingCard({
              text: `创建项目失败: ${e.message}`,
              status: 'error',
              errorMessage: e.hint || e.message,
            });
            await this.replyCard(chatId, messageId, chatType, errCard);
          }
          return true;
        }

        if (arg1 === 'add' || arg1 === 'link') {
          const targetPath = parts.slice(3).join(' ').trim();
          if (!arg2 || !targetPath) {
            const errCard = buildStreamingCard({
              text: '用法: `/bind add <项目别名> <已有目录路径>`\n例如: `/bind add my-web ~/project/my-web`',
              status: 'error',
              errorMessage: '缺少项目别名或物理路径参数',
            });
            await this.replyCard(chatId, messageId, chatType, errCard);
            return true;
          }

          try {
            const resolvedPath = this.workspace.registerProject(arg2, targetPath);
            this.sessions.update(session.sessionKey, {
              projectName: arg2,
              cwd: resolvedPath,
              conversationId: undefined,
            });
            const card = buildBindCard({
              currentProject: arg2,
              currentPath: resolvedPath,
              defaultRoot: this.workspace.getDefaultRoot(),
              projects: this.workspace.listProjects(),
            });
            await this.replyCard(chatId, messageId, chatType, card);
          } catch (e: any) {
            const errCard = buildStreamingCard({
              text: `关联已有项目失败: ${e.message}`,
              status: 'error',
              errorMessage: e.hint || e.message,
            });
            await this.replyCard(chatId, messageId, chatType, errCard);
          }
          return true;
        }

        if (arg1 === 'delete') {
          if (!arg2) {
            const errCard = buildStreamingCard({
              text: '用法: `/bind delete <项目别名>`\n例如: `/bind delete my-app`',
              status: 'error',
              errorMessage: '缺少要删除的项目别名',
            });
            await this.replyCard(chatId, messageId, chatType, errCard);
            return true;
          }

          const removed = this.workspace.removeProject(arg2);
          const currentProj = session.projectName === arg2 ? undefined : session.projectName;
          if (session.projectName === arg2) {
            this.sessions.update(session.sessionKey, { projectName: undefined });
          }
          const card = buildBindCard({
            currentProject: currentProj,
            currentPath: session.cwd,
            defaultRoot: this.workspace.getDefaultRoot(),
            projects: this.workspace.listProjects(),
          });
          await this.replyCard(chatId, messageId, chatType, card);
          return true;
        }

        const card = buildBindCard({
          currentProject: session.projectName,
          currentPath: session.cwd,
          defaultRoot: this.workspace.getDefaultRoot(),
          projects: this.workspace.listProjects(),
        });
        await this.replyCard(chatId, messageId, chatType, card);
        return true;
      }

      case '/model': {
        const models = await fetchAvailableModels(this.config.agy.binary);
        if (arg1) {
          const matched = models.find((m) => m.id === arg1 || m.id.includes(arg1));
          const targetModel = matched ? matched.id : arg1;
          this.sessions.update(session.sessionKey, { model: targetModel });
          const card = buildModelCard({
            currentModel: targetModel,
            models,
            sessionUsage: session.totalUsage,
          });
          await this.replyCard(chatId, messageId, chatType, card);
          return true;
        }

        const card = buildModelCard({
          currentModel: session.model || this.config.agy.defaultModel,
          models,
          sessionUsage: session.totalUsage,
        });
        await this.replyCard(chatId, messageId, chatType, card);
        return true;
      }

      case '/new':
      case '/reset': {
        this.sessions.reset(session.sessionKey);
        const card = buildStreamingCard({
          text: `🔄 **已重置会话上下文**\n当前绑定项目: \`${session.projectName || '默认'}\` (\`${session.cwd}\`)\n后续提问将开启全新对话。`,
          status: 'done',
        });
        await this.replyCard(chatId, messageId, chatType, card);
        return true;
      }

      case '/pwd': {
        const card = buildStreamingCard({
          text:
            `📍 **当前会话状态**:\n` +
            `• 项目别名: \`${session.projectName || '未命名'}\`\n` +
            `• 物理路径: \`${session.cwd}\`\n` +
            `• agy 会话 ID: \`${session.conversationId || '暂未创建'}\`\n` +
            `• 生效模型: \`${session.model || '跟随系统默认'}\`\n` +
            `• 会话类型: \`${session.chatType}\``,
          status: 'done',
        });
        await this.replyCard(chatId, messageId, chatType, card);
        return true;
      }

      case '/cd': {
        if (!arg1) {
          const card = buildStreamingCard({
            text: '用法: `/cd <path>`，例如: `/cd ~/project/my-app`',
            status: 'error',
          });
          await this.replyCard(chatId, messageId, chatType, card);
          return true;
        }

        try {
          const resolved = this.workspace.expandPath(arg1);
          this.sessions.update(session.sessionKey, {
            cwd: resolved,
            projectName: undefined,
            conversationId: undefined,
          });
          const card = buildStreamingCard({
            text: `📁 已将工作区切换至: \`${resolved}\`，会话已重新初始化。`,
            status: 'done',
          });
          await this.replyCard(chatId, messageId, chatType, card);
        } catch (e: any) {
          const card = buildStreamingCard({
            text: `切换路径失败: ${e.message}`,
            status: 'error',
          });
          await this.replyCard(chatId, messageId, chatType, card);
        }
        return true;
      }

      case '/config': {
        if (arg1 === 'default_root' && arg2) {
          const newRoot = this.workspace.setDefaultRoot(arg2);
          const card = buildStreamingCard({
            text: `⚙️ **配置已更新**\n默认新建项目根目录现已变更为: \`${newRoot}\``,
            status: 'done',
          });
          await this.replyCard(chatId, messageId, chatType, card);
          return true;
        }

        const card = buildStreamingCard({
          text:
            `⚙️ **当前全局配置**:\n` +
            `• 默认项目创建根目录: \`${this.workspace.getDefaultRoot()}\`\n` +
            `• 默认模型: \`${this.config.agy.defaultModel || '系统默认'}\`\n` +
            `• 思考强度: \`${this.config.agy.effort || 'high'}\`\n\n` +
            `修改默认创建路径: \`/config default_root <path>\``,
          status: 'done',
        });
        await this.replyCard(chatId, messageId, chatType, card);
        return true;
      }

      case '/status': {
        const usage = session.totalUsage || {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 0,
        };
        const isRunning = this.activeTasks.has(session.sessionKey);
        const card = buildStreamingCard({
          text:
            `📊 **会话活跃状态**: ${isRunning ? '🟢 正在执行任务中' : '⚪ 空闲'}\n` +
            `• 累计消耗 Tokens: **${usage.totalTokens.toLocaleString()}**\n` +
            `• 累计缓存命中: **${usage.cacheReadTokens.toLocaleString()}**\n` +
            `• 当前工作目录: \`${session.cwd}\`\n` +
            `• 上次活跃时间: ${new Date(session.lastActive).toLocaleTimeString()}`,
          status: 'done',
        });
        await this.replyCard(chatId, messageId, chatType, card);
        return true;
      }

      case '/stop': {
        const active = this.activeTasks.get(session.sessionKey);
        if (active) {
          active.abort();
          this.activeTasks.delete(session.sessionKey);
          const card = buildStreamingCard({
            text: '🛑 **已成功中止正在运行的 agy 任务**。',
            status: 'done',
          });
          await this.replyCard(chatId, messageId, chatType, card);
        } else {
          const card = buildStreamingCard({
            text: '当前会话没有正在运行的后台任务。',
            status: 'done',
          });
          await this.replyCard(chatId, messageId, chatType, card);
        }
        return true;
      }

      default:
        return false;
    }
  }

  private async executePrompt(
    prompt: string,
    messageId: string,
    chatId: string,
    chatType: 'p2p' | 'group',
    threadId: string | undefined,
    session: SessionEntry
  ): Promise<void> {
    const prevTask = this.activeTasks.get(session.sessionKey);
    if (prevTask) {
      prevTask.abort();
    }
    const abortController = new AbortController();
    this.activeTasks.set(session.sessionKey, abortController);

    // Initial streaming card
    const initialCard = buildStreamingCard({
      text: '_agy 正在思考与分析需求..._',
      status: 'running',
      project: session.projectName,
      model: session.model || this.config.agy.defaultModel,
    });

    let botMessageId = '';
    try {
      botMessageId = await this.replyCard(chatId, messageId, chatType, initialCard);
    } catch (e: any) {
      this.activeTasks.delete(session.sessionKey);
      return;
    }

    let streamText = '';
    let lastPatchTime = 0;
    let patchTimer: NodeJS.Timeout | null = null;
    const uploadedImageKeys: string[] = [];
    const startedAt = Date.now();

    const triggerPatch = (force = false) => {
      const now = Date.now();
      if (!force && now - lastPatchTime < 600) {
        if (!patchTimer) {
          patchTimer = setTimeout(() => {
            patchTimer = null;
            triggerPatch(false);
          }, 600 - (now - lastPatchTime));
        }
        return;
      }

      lastPatchTime = now;
      const card = buildStreamingCard({
        text: streamText,
        status: 'running',
        project: session.projectName,
        model: session.model || this.config.agy.defaultModel,
        imageKeys: [...uploadedImageKeys],
      });
      this.updateCard(botMessageId, card).catch(() => {});
    };

    try {
      const result = await runAgy(
        {
          prompt,
          cwd: session.cwd,
          conversationId: session.conversationId,
          model: session.model || this.config.agy.defaultModel,
          effort: this.config.agy.effort,
          timeoutMs: this.config.agy.timeoutMs,
          signal: abortController.signal,
          onInit: (info) => {
            if (info.conversationId && info.conversationId !== session.conversationId) {
              this.sessions.update(session.sessionKey, { conversationId: info.conversationId });
            }
          },
          onDelta: (delta) => {
            streamText += delta;
            triggerPatch(false);
          },
          onImage: async (imagePaths) => {
            for (const imgPath of imagePaths) {
              try {
                const imgKey = await uploadImageToLark(this.client, imgPath);
                if (!uploadedImageKeys.includes(imgKey)) {
                  uploadedImageKeys.push(imgKey);
                  triggerPatch(true);
                }
              } catch {
                // Best-effort image upload
              }
            }
          },
        },
        this.config.agy.binary
      );

      if (patchTimer) clearTimeout(patchTimer);

      // Upload any remaining images
      if (result.imagePaths) {
        for (const imgPath of result.imagePaths) {
          try {
            const imgKey = await uploadImageToLark(this.client, imgPath);
            if (!uploadedImageKeys.includes(imgKey)) {
              uploadedImageKeys.push(imgKey);
            }
          } catch {
            // Ignore
          }
        }
      }

      // Update session with final conversationId and usage
      const prevUsage = session.totalUsage || {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
      };
      const curUsage = result.usage;
      const newUsage = curUsage
        ? {
            inputTokens: prevUsage.inputTokens + curUsage.inputTokens,
            outputTokens: prevUsage.outputTokens + curUsage.outputTokens,
            cacheReadTokens: prevUsage.cacheReadTokens + curUsage.cacheReadTokens,
            totalTokens: prevUsage.totalTokens + curUsage.totalTokens,
          }
        : prevUsage;

      this.sessions.update(session.sessionKey, {
        conversationId: result.conversationId,
        totalUsage: newUsage,
      });

      const finalText = streamText.trim() || result.response.trim();
      const finalCard = buildStreamingCard({
        text: finalText,
        status: 'done',
        durationSeconds: (Date.now() - startedAt) / 1000,
        project: session.projectName,
        model: session.model || this.config.agy.defaultModel,
        imageKeys: uploadedImageKeys,
      });

      await this.updateCard(botMessageId, finalCard);
    } catch (err: any) {
      if (patchTimer) clearTimeout(patchTimer);

      const isAborted = err.code === 'E_AGY_ABORTED';
      const finalCard = buildStreamingCard({
        text: streamText ? `${streamText}\n\n*(任务已中断)*` : '任务已中断。',
        status: isAborted ? 'done' : 'error',
        errorMessage: isAborted ? undefined : err.hint || err.message,
        durationSeconds: (Date.now() - startedAt) / 1000,
      });

      await this.updateCard(botMessageId, finalCard);
    } finally {
      this.activeTasks.delete(session.sessionKey);
    }
  }
}
