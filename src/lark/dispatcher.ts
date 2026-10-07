import * as lark from '@larksuiteoapi/node-sdk';
import { WorkspaceManager } from '../core/workspace.js';
import { SessionStore, buildSessionKey } from '../core/sessions.js';
import { runAgy, runAgentEngine } from '../core/runner.js';
import { BridgeError } from '../core/errors.js';
import { fetchAvailableModels, fetchModelsForEngine, getCachedModels, getPiProviderInfo, resolveModelForEngine } from '../core/models.js';
import { fetchQuotaSummary, getCachedQuota } from '../core/quota.js';
import { TaskManager } from '../core/task-manager.js';
import type { BridgeConfig, SessionEntry, AgentEngine, ExecutionStep } from '../core/types.js';
import { checkAccess } from './access-control.js';
import { buildHelpCard, buildBindCard, buildModelCard, buildStreamingCard, buildTasksCard, buildEngineCard } from './cards.js';
import { uploadImageToLark } from './uploader.js';
import { parseLarkMessage } from './parser.js';
import { downloadImageFromLark } from './downloader.js';

export class MessageDispatcher {
  private client: lark.Client;
  private config: BridgeConfig;
  private workspace: WorkspaceManager;
  private sessions: SessionStore;
  private taskManager: TaskManager;
  private processedMessageIds: Map<string, number> = new Map();

  constructor(
    client: lark.Client,
    config: BridgeConfig,
    workspace: WorkspaceManager,
    sessions: SessionStore,
    taskManager?: TaskManager
  ) {
    this.client = client;
    this.config = config;
    this.workspace = workspace;
    this.sessions = sessions;
    this.taskManager = taskManager || new TaskManager();
  }

  public getTaskManager(): TaskManager {
    return this.taskManager;
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
    const senderOpenId = data.sender?.sender_id?.open_id;

    // 2. 访问控制检查：白名单外的用户/会话不消耗任何资源，直接忽略
    const access = checkAccess(this.config.accessControl, { chatId, senderOpenId });
    if (!access.allowed) {
      console.log(
        `[agy-lark] 已拒绝白名单外消息: sender=${senderOpenId || 'unknown'} chat=${chatId} (${access.reason})`
      );
      if (this.config.accessControl?.notifyDenied) {
        try {
          const card = buildStreamingCard({
            text: `🚫 **无访问权限**\n当前用户或会话不在本机器人的访问控制白名单内。\n如需使用，请联系机器人管理员将以下 open_id 加入白名单：\n\`${senderOpenId || 'unknown'}\``,
            status: 'error',
          });
          await this.replyCard(chatId, messageId, chatType, card);
        } catch {
          // 提示失败不影响拦截结果
        }
      }
      return;
    }

    const { text: extractedText, imageKeys } = parseLarkMessage(message);

    // Strip bot mention markers e.g. "@_user_1 "
    const cleanText = extractedText.replace(/@_user_\d+\s*/g, '').trim();
    if (!cleanText && imageKeys.length === 0) {
      // 纯 @机器人 / 表情等无有效内容消息：显式记录后跳过（不是错误）
      console.log(`[agy-lark] 忽略空内容消息: message_id=${messageId}`);
      return;
    }

    // Record active target for proactive notifications
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

    // Check commands (only plain text commands without media)
    if (cleanText.startsWith('/') && imageKeys.length === 0) {
      const handled = await this.handleCommand(cleanText, messageId, chatId, chatType, threadId, session);
      if (handled) return;
    }

    // Regular prompt execution with multimodal support - 异步启动，避免阻塞 WebSocket 事件循环导致飞书超时重投
    this.executePromptWithMedia(cleanText, imageKeys, messageId, chatId, chatType, threadId, session).catch((err) => {
      console.error(`[agy-lark] Prompt 执行异步异常 [${messageId}]:`, err);
    });
  }

  private async executePromptWithMedia(
    text: string,
    imageKeys: string[],
    messageId: string,
    chatId: string,
    chatType: 'p2p' | 'group',
    threadId: string | undefined,
    session: SessionEntry
  ): Promise<void> {
    let finalPrompt = text;
    const downloadedPaths: string[] = [];

    if (imageKeys.length > 0) {
      for (const imgKey of imageKeys) {
        try {
          const imgPath = await downloadImageFromLark(this.client, messageId, imgKey, session.cwd);
          downloadedPaths.push(imgPath);
        } catch (err: any) {
          console.error(`[agy-lark] 图片下载失败 [messageId=${messageId}, key=${imgKey}]:`, err?.message || err);
        }
      }

      if (downloadedPaths.length > 0) {
        const engine: AgentEngine = session.engine || this.config.engine || 'pi';
        const userPrompt = text || '请分析并总结这张图片的内容。';
        if (engine === 'pi') {
          // pi 原生支持 @file 多模态挂载，不强求 agy 专属的 view_file 引导
          finalPrompt = userPrompt;
        } else {
          const imageList = downloadedPaths.map((p) => `- ${p}`).join('\n');
          finalPrompt = `【用户随附图片已保存至本地】:\n${imageList}\n请优先调用 view_file 工具查看并结合图片内容回答。\n\n${userPrompt}`;
        }
      }
    }

    return this.executePrompt(finalPrompt, messageId, chatId, chatType, threadId, session, downloadedPaths);
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

      case '/model':
      case '/models': {
        const engine: AgentEngine = session.engine || this.config.engine || 'pi';
        const isPi = engine === 'pi';
        const effectiveModel = resolveModelForEngine(session, engine, this.config);
        const models = await fetchModelsForEngine(engine, this.config);
        const piProviderInfo = isPi ? getPiProviderInfo(this.config.pi) : undefined;
        const quota =
          !isPi && this.config.agy?.quota?.enabled
            ? (getCachedQuota() ?? (await fetchQuotaSummary(this.config.agy.quota)))
            : undefined;

        if (arg1) {
          const matched = models.find(
            (m) =>
              m.id.toLowerCase() === arg1.toLowerCase() ||
              m.id.toLowerCase().includes(arg1.toLowerCase()) ||
              m.displayName.toLowerCase().includes(arg1.toLowerCase())
          );
          const targetModel = matched ? matched.id : arg1;
          const updatePayload: Partial<SessionEntry> = {
            model: targetModel,
            ...(isPi ? { piModel: targetModel } : { agyModel: targetModel }),
          };
          this.sessions.update(session.sessionKey, updatePayload);
          const card = buildModelCard({
            currentModel: targetModel,
            models,
            sessionUsage: session.totalUsage,
            engine,
            piProviderInfo,
            quota,
          });
          await this.replyCard(chatId, messageId, chatType, card);
          return true;
        }

        const card = buildModelCard({
          currentModel: effectiveModel,
          models,
          sessionUsage: session.totalUsage,
          engine,
          piProviderInfo,
          quota,
        });
        await this.replyCard(chatId, messageId, chatType, card);
        return true;
      }

      case '/quota': {
        const engine: AgentEngine = session.engine || this.config.engine || 'pi';
        const isPi = engine === 'pi';
        if (isPi) {
          const info = getPiProviderInfo(this.config.pi);
          const usage = session.totalUsage || {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            totalTokens: 0,
          };
          const card = buildStreamingCard({
            text:
              `📊 **Pi 执行引擎用量与授权信息**\n\n` +
              `• 接入 Provider: **${info.provider}**\n` +
              `• 服务端点: ${info.baseUrl ? `\`${info.baseUrl}\`` : '本地 / 环境变量配置'}\n` +
              `• 模型库规模: **${info.modelCount}** 个配置模型\n` +
              `• 计费与配额: **API Key / Token 按量计费**（不受 Google Cloud 额度限制）\n\n` +
              `**📈 当前会话 Token 统计**:\n` +
              `• 输入 Tokens: **${usage.inputTokens.toLocaleString()}**\n` +
              `• 输出 Tokens: **${usage.outputTokens.toLocaleString()}**\n` +
              `• 缓存命中 Tokens: **${usage.cacheReadTokens.toLocaleString()}**\n` +
              `• 累计总 Tokens: **${usage.totalTokens.toLocaleString()}**\n\n` +
              `如需查看 Google Cloud 额度，请通过 \`/engine agy\` 切换为 agy 引擎后查看。`,
            status: 'done',
            engine: 'pi',
          });
          await this.replyCard(chatId, messageId, chatType, card);
          return true;
        }

        const quota = await fetchQuotaSummary(this.config.agy?.quota);
        const models = await fetchAvailableModels(this.config.agy?.binary);
        const card = buildModelCard({
          currentModel: session.model || this.config.agy?.defaultModel,
          models,
          sessionUsage: session.totalUsage,
          quota,
          engine: 'agy',
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
        const currentEngine = session.engine || this.config.engine || 'pi';
        const effectiveModel = resolveModelForEngine(session, currentEngine, this.config);
        const card = buildStreamingCard({
          text:
            `📍 **当前会话状态**:\n` +
            `• 执行引擎: **${currentEngine.toUpperCase()}**\n` +
            `• 项目别名: \`${session.projectName || '未命名'}\`\n` +
            `• 物理路径: \`${session.cwd}\`\n` +
            `• 会话上下文 ID: \`${session.conversationId || '暂未创建'}\`\n` +
            `• 生效模型: \`${effectiveModel || '跟随系统默认'}\`\n` +
            `• 会话类型: \`${session.chatType}\``,
          status: 'done',
          engine: currentEngine,
          model: effectiveModel,
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

        if (arg1 === 'engine' && (arg2 === 'agy' || arg2 === 'pi')) {
          this.config.engine = arg2;
          const effectiveModel = resolveModelForEngine(session, arg2, this.config);
          this.sessions.update(session.sessionKey, {
            model: effectiveModel,
          });
          const card = buildStreamingCard({
            text:
              `⚙️ **全局默认引擎已变更**\n` +
              `全局默认执行引擎现已变更为: **${arg2 === 'pi' ? 'Pi Coding Agent (pi)' : 'Antigravity CLI (agy)'}**\n\n` +
              `当前会话模型已自适应校准为: \`${effectiveModel || '系统默认'}\`。\n` +
              `新发起的会话也将默认使用此引擎。`,
            status: 'done',
            engine: arg2,
            model: effectiveModel,
          });
          await this.replyCard(chatId, messageId, chatType, card);
          return true;
        }

        const card = buildStreamingCard({
          text:
            `⚙️ **当前全局配置**:\n` +
            `• 全局默认执行引擎: **${(this.config.engine || 'agy').toUpperCase()}**\n` +
            `• 默认项目创建根目录: \`${this.workspace.getDefaultRoot()}\`\n` +
            `• agy 默认模型: \`${this.config.agy.defaultModel || '系统默认'}\`\n` +
            `• pi 默认模型: \`${this.config.pi?.defaultModel || '系统配置默认'}\`\n` +
            `• 思考强度: \`${this.config.agy.effort || 'high'}\`\n\n` +
            `• 修改默认引擎: \`/config engine <agy|pi>\`\n` +
            `• 修改默认创建路径: \`/config default_root <path>\``,
          status: 'done',
        });
        await this.replyCard(chatId, messageId, chatType, card);
        return true;
      }

      case '/tasks':
      case '/ps': {
        const activeTasks = this.taskManager.getActiveTasks();
        const card = buildTasksCard(activeTasks, this.taskManager);
        await this.replyCard(chatId, messageId, chatType, card);
        return true;
      }

      case '/engine': {
        if (arg1 === 'pi' || arg1 === 'agy') {
          const effectiveModel = resolveModelForEngine(session, arg1, this.config);
          this.sessions.update(session.sessionKey, {
            engine: arg1,
            model: effectiveModel,
          });
          const piProviderInfo = arg1 === 'pi' ? getPiProviderInfo(this.config.pi) : undefined;
          const globalEngine = this.config.engine || 'pi';
          const card = buildEngineCard({
            currentEngine: arg1,
            globalEngine,
            effectiveModel,
            piProviderInfo,
          });
          await this.replyCard(chatId, messageId, chatType, card);
          return true;
        }

        const currentEngine = session.engine || this.config.engine || 'pi';
        const effectiveModel = resolveModelForEngine(session, currentEngine, this.config);
        const piProviderInfo = currentEngine === 'pi' ? getPiProviderInfo(this.config.pi) : undefined;
        const globalEngine = this.config.engine || 'pi';

        const card = buildEngineCard({
          currentEngine,
          globalEngine,
          effectiveModel,
          piProviderInfo,
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
        const currentTask = this.taskManager.getActiveTaskBySession(session.sessionKey);
        const allActive = this.taskManager.getActiveTasks();
        const currentEngine = session.engine || this.config.engine || 'pi';
        const effectiveModel = resolveModelForEngine(session, currentEngine, this.config);

        let taskStatusText = '⚪ 空闲';
        if (currentTask) {
          const elapsed = (Date.now() - currentTask.startedAt) / 1000;
          taskStatusText = `🟢 正在执行 [${currentTask.id}] (已运行 ${this.taskManager.formatDuration(elapsed)})`;
        }

        const card = buildStreamingCard({
          text:
            `📊 **会话活跃状态**: ${taskStatusText}\n` +
            `• 当前生效引擎: **${currentEngine.toUpperCase()}**\n` +
            `• 全局后台运行任务数: **${allActive.length}** 个\n` +
            `• 累计消耗 Tokens: **${usage.totalTokens.toLocaleString()}**\n` +
            `• 累计缓存命中: **${usage.cacheReadTokens.toLocaleString()}**\n` +
            `• 当前工作目录: \`${session.cwd}\`\n` +
            `• 生效模型: \`${effectiveModel || '系统默认'}\`\n` +
            `• 上次活跃时间: ${new Date(session.lastActive).toLocaleTimeString()}\n\n` +
            `查看运行中的后台任务详情: \`/tasks\``,
          status: 'done',
          engine: currentEngine,
          model: effectiveModel,
        });
        await this.replyCard(chatId, messageId, chatType, card);
        return true;
      }

      case '/stop': {
        if (arg1 === 'all') {
          const aborted = this.taskManager.abortAll();
          const card = buildStreamingCard({
            text: `🛑 **已中止所有后台任务** (共终止 ${aborted.length} 个任务)。`,
            status: 'done',
          });
          await this.replyCard(chatId, messageId, chatType, card);
          return true;
        }

        if (arg1) {
          const task = this.taskManager.abortTask(arg1);
          if (task) {
            const card = buildStreamingCard({
              text: `🛑 **已成功中止指定任务 [${task.id}]**\n• 执行引擎: \`${task.engine}\`\n• 耗时: ${this.taskManager.formatDuration(task.durationSeconds || 0)}`,
              status: 'done',
              engine: task.engine,
            });
            await this.replyCard(chatId, messageId, chatType, card);
          } else {
            const card = buildStreamingCard({
              text: `未找到正在运行的任务 \`${arg1}\`，可能已执行完毕或已被中止。\n可发送 \`/tasks\` 查看当前正在运行的任务。`,
              status: 'error',
            });
            await this.replyCard(chatId, messageId, chatType, card);
          }
          return true;
        }

        const abortedList = this.taskManager.abortSessionTasks(session.sessionKey);
        if (abortedList.length > 0) {
          const card = buildStreamingCard({
            text: `🛑 **已成功中止当前会话正在运行的任务**：[${abortedList.map((t) => t.id).join(', ')}]。`,
            status: 'done',
          });
          await this.replyCard(chatId, messageId, chatType, card);
        } else {
          const card = buildStreamingCard({
            text: '当前会话没有正在运行的后台任务。\n如需查看其他会话/Thread 的后台任务，请发送 `/tasks`。',
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
    session: SessionEntry,
    inputImagePaths?: string[]
  ): Promise<void> {
    const running = this.taskManager.getActiveTaskBySession(session.sessionKey);
    if (running) {
      const elapsed = (Date.now() - running.startedAt) / 1000;
      const durationStr = this.taskManager.formatDuration(elapsed);
      const card = buildStreamingCard({
        text:
          `⚠️ **当前会话已有任务 [${running.id}] 正在执行中**（已运行 ${durationStr}）。\n\n` +
          `• 任务内容: ${running.prompt.slice(0, 80)}...\n` +
          `• 为避免意外打断长任务，原任务正在后台继续运行。\n` +
          `• 查看所有任务: \`/tasks\`\n` +
          `• 强行中止此任务: \`/stop\` 或 \`/stop ${running.id}\`\n` +
          `• 如需并行运行新任务，推荐在群聊中开启 **新话题（Thread）** 发起！`,
        status: 'error',
        engine: running.engine,
      });
      await this.replyCard(chatId, messageId, chatType, card);
      return;
    }

    const engine: AgentEngine = session.engine || this.config.engine || 'pi';
    const effectiveModel = resolveModelForEngine(session, engine, this.config);

    if (session.model !== effectiveModel) {
      this.sessions.update(session.sessionKey, {
        model: effectiveModel,
        ...(engine === 'pi' ? { piModel: effectiveModel } : { agyModel: effectiveModel }),
      });
    }

    const task = this.taskManager.createTask({
      sessionKey: session.sessionKey,
      chatId,
      chatType,
      threadId,
      messageId,
      engine,
      projectName: session.projectName,
      cwd: session.cwd,
      prompt,
    });

    // Initial streaming card
    const initialCard = buildStreamingCard({
      text: `_${engine.toUpperCase()} 正在思考与分析需求..._`,
      status: 'running',
      engine,
      taskId: task.id,
      project: session.projectName,
      model: effectiveModel,
    });

    let botMessageId = '';
    try {
      botMessageId = await this.replyCard(chatId, messageId, chatType, initialCard);
      this.taskManager.setBotMessageId(task.id, botMessageId);
    } catch (e: any) {
      this.taskManager.finishTask(task.id, 'error', e.message);
      return;
    }

    let streamText = '';
    const steps: ExecutionStep[] = [];
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
        engine,
        taskId: task.id,
        project: session.projectName,
        model: effectiveModel,
        imageKeys: [...uploadedImageKeys],
        steps: [...steps],
      });
      this.updateCard(botMessageId, card).catch(() => {});
    };

    try {
      const timeoutMs =
        engine === 'pi'
          ? (this.config.pi?.timeoutMs ?? 0)
          : (this.config.agy?.timeoutMs ?? 0);

      const result = await runAgentEngine(
        engine,
        {
          prompt,
          cwd: session.cwd,
          conversationId: session.conversationId,
          model: effectiveModel,
          effort: engine === 'pi' ? (this.config.pi?.thinking as any) : this.config.agy?.effort,
          timeoutMs,
          signal: task.abortController.signal,
          imagePaths: inputImagePaths,
          onInit: (info) => {
            if (info.conversationId && info.conversationId !== session.conversationId) {
              this.sessions.update(session.sessionKey, { conversationId: info.conversationId });
            }
          },
          onDelta: (delta) => {
            streamText += delta;
            triggerPatch(false);
          },
          onStep: (stepInfo) => {
            if (stepInfo.stepType === 'tool') {
              const existing = steps.find(
                (s) => s.index === stepInfo.index || (s.toolName === stepInfo.toolName && s.state === 'ACTIVE')
              );
              if (existing) {
                existing.state = stepInfo.state;
                if (stepInfo.durationSeconds !== undefined) {
                  existing.durationSeconds = stepInfo.durationSeconds;
                }
                if (stepInfo.summary) {
                  existing.summary = stepInfo.summary;
                }
              } else {
                steps.push({
                  index: stepInfo.index,
                  stepType: stepInfo.stepType,
                  state: stepInfo.state,
                  toolName: stepInfo.toolName,
                  summary: stepInfo.summary || `调用 ${stepInfo.toolName || '工具'}`,
                  durationSeconds: stepInfo.durationSeconds,
                });
              }
              triggerPatch(false);
            }
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
        this.config
      );

      if (patchTimer) clearTimeout(patchTimer);

      if (result.status === 'ERROR') {
        const errorDetail = result.response.trim() || '执行异常，未返回有效结果';
        this.taskManager.finishTask(task.id, 'error', errorDetail);
        const finalCard = buildStreamingCard({
          text: streamText.trim() ? `${streamText}\n\n⚠️ **执行出错**` : '❌ **执行未成功完成**',
          status: 'error',
          engine,
          taskId: task.id,
          errorMessage: errorDetail,
          durationSeconds: (Date.now() - startedAt) / 1000,
          project: session.projectName,
          model: effectiveModel,
          steps: [...steps],
        });
        await this.updateCard(botMessageId, finalCard);
        return;
      }

      this.taskManager.finishTask(task.id, 'completed');

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
        engine,
        taskId: task.id,
        durationSeconds: (Date.now() - startedAt) / 1000,
        project: session.projectName,
        model: effectiveModel,
        imageKeys: uploadedImageKeys,
        steps: [...steps],
      });

      await this.updateCard(botMessageId, finalCard);
    } catch (err: any) {
      if (patchTimer) clearTimeout(patchTimer);

      const isAborted = err.code === 'E_AGY_ABORTED' || err.code === 'E_PI_ABORTED';
      this.taskManager.finishTask(task.id, isAborted ? 'aborted' : 'error', err?.message);

      const errorText = err.hint ? `${err.message}\n💡 建议: ${err.hint}` : err.message;
      const finalCard = buildStreamingCard({
        text: streamText ? `${streamText}\n\n*(任务已中断)*` : (isAborted ? '任务已中断。' : '❌ **执行失败**'),
        status: isAborted ? 'done' : 'error',
        engine,
        taskId: task.id,
        errorMessage: isAborted ? undefined : errorText,
        durationSeconds: (Date.now() - startedAt) / 1000,
        project: session.projectName,
        model: effectiveModel,
        steps: [...steps],
      });

      await this.updateCard(botMessageId, finalCard);
    }
  }
}
