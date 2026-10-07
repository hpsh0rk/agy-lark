import * as lark from '@larksuiteoapi/node-sdk';
import type { BridgeConfig, ActiveTarget } from '../core/types.js';
import { WorkspaceManager } from '../core/workspace.js';
import { SessionStore } from '../core/sessions.js';
import { fetchAvailableModels, fetchPiModels } from '../core/models.js';
import { fetchQuotaSummary } from '../core/quota.js';
import { MessageDispatcher } from './dispatcher.js';
import { handleCardAction } from './card-actions.js';
import { checkAccess } from './access-control.js';
import { buildStartupCard, buildShutdownCard } from './cards.js';

export class LarkBridgeService {
  private client: lark.Client;
  private wsClient: lark.WSClient;
  private dispatcher: MessageDispatcher;
  private workspace: WorkspaceManager;
  private sessions: SessionStore;
  private config: BridgeConfig;
  private refreshTimer?: NodeJS.Timeout;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.workspace = new WorkspaceManager();
    this.sessions = new SessionStore();

    this.client = new lark.Client({
      appId: config.lark.appId,
      appSecret: config.lark.appSecret,
    });

    this.wsClient = new lark.WSClient({
      appId: config.lark.appId,
      appSecret: config.lark.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    });

    this.dispatcher = new MessageDispatcher(this.client, config, this.workspace, this.sessions);
  }

  public getNotificationTarget(): ActiveTarget | undefined {
    if (this.config.lark.notifyReceiveId) {
      return {
        receiveId: this.config.lark.notifyReceiveId,
        receiveIdType: this.config.lark.notifyReceiveIdType || 'open_id',
        updatedAt: Date.now(),
      };
    }
    return this.sessions.getLastActiveTarget();
  }

  public async sendNotification(card: Record<string, unknown>): Promise<boolean> {
    const target = this.getNotificationTarget();
    if (!target) return false;

    try {
      const resp = await this.client.im.message.create({
        params: { receive_id_type: target.receiveIdType as any },
        data: {
          receive_id: target.receiveId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      if (resp.code === 0) {
        return true;
      }
      console.warn(`[agy-lark] 发送通知返回码 [${resp.code}]: ${resp.msg}`);
      return false;
    } catch (err: any) {
      console.warn(
        `[agy-lark] 发送通知异常 [${target.receiveIdType}:${target.receiveId}]:`,
        err?.response?.data?.msg || err?.message
      );
      return false;
    }
  }

  public async notifyStartup(botName?: string): Promise<boolean> {
    const card = buildStartupCard({
      botName,
      defaultRoot: this.workspace.getDefaultRoot(),
      defaultModel: this.config.agy.defaultModel,
      effort: this.config.agy.effort,
      yolo: true,
    });
    return this.sendNotification(card);
  }

  public async notifyShutdown(reason: string, timeoutMs = 2500): Promise<boolean> {
    const card = buildShutdownCard({ reason });
    return Promise.race([
      this.sendNotification(card),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  public async start(): Promise<void> {
    let botName = 'Antigravity Bot';
    try {
      const botRes = await this.client.request({
        url: '/open-apis/bot/v3/info',
        method: 'GET',
      });
      if (botRes?.code === 0 && botRes?.bot?.app_name) {
        botName = botRes.bot.app_name;
      }
    } catch {
      // Best-effort
    }

    const eventDispatcher = new lark.EventDispatcher({
      verificationToken: this.config.lark.verificationToken,
      encryptKey: this.config.lark.encryptKey,
    });

    eventDispatcher.register({
      'im.message.receive_v1': async (data: any) => {
        try {
          await this.dispatcher.handleMessage(data);
        } catch (err) {
          console.error('[agy-lark] 消息处理异常:', err);
        }
      },
      'card.action.trigger': async (data: any) => {
        try {
          const access = checkAccess(this.config.accessControl, {
            chatId: data.context?.open_chat_id || data.open_chat_id,
            senderOpenId: data.operator?.open_id || data.open_id,
          });
          if (!access.allowed) {
            console.warn(
              `[agy-lark] 已拒绝白名单外卡片操作: operator=${data.operator?.open_id || data.open_id || 'unknown'} ` +
                `chat=${data.context?.open_chat_id || data.open_chat_id || 'unknown'} (${access.reason})`
            );
            return { toast: { type: 'error', content: '无权限：当前用户或会话不在访问控制白名单内' } };
          }
          const res = await handleCardAction(data, {
            workspace: this.workspace,
            sessions: this.sessions,
            agyBinary: this.config.agy.binary || 'agy',
            defaultModel: this.config.agy.defaultModel,
            quota: this.config.agy.quota,
            taskManager: this.dispatcher.getTaskManager(),
            config: this.config,
          });
          return res;
        } catch (err) {
          console.error('[agy-lark] 卡片交互处理异常:', err);
          return { toast: { type: 'error', content: '卡片交互处理失败' } };
        }
      },
    });

    console.log('[agy-lark] 正在建立飞书 WebSocket 长连接...');
    await this.wsClient.start({ eventDispatcher });
    console.log('[agy-lark] 飞书服务启动成功！已监听消息与卡片交互事件。');

    if (this.config.accessControl?.enabled) {
      const ac = this.config.accessControl;
      console.log(
        `🛡 访问控制: 已启用 (白名单 ${ac.allowUsers?.length || 0} 个用户 / ${ac.allowChats?.length || 0} 个会话)，` +
          `白名单外请求将被忽略`
      );
    } else {
      console.log(
        '⚠️ 访问控制: 未启用 —— 任何能给机器人发消息的用户都可以驱动本机执行引擎 (agy/pi)，' +
          '建议在 config.json 中配置 accessControl 白名单'
      );
    }

    // 预热模型列表与额度缓存，并定期后台刷新。
    // `agy models` 实测耗时 ~3.7s、额度取数走一次 HTTPS，均超过飞书卡片回调的 3 秒上限，
    // 因此热路径必须只读缓存，冷启动必须提前在后台完成。
    void this.prewarmCaches();
    this.refreshTimer = setInterval(() => void this.prewarmCaches(), 4 * 60 * 1000);
    this.refreshTimer.unref();

    const appLink = `https://applink.feishu.cn/client/bot/open?appId=${this.config.lark.appId}`;
    console.log('\n====================================================');
    console.log(`🤖 飞书机器人名称: ${botName}`);
    console.log(`🔗 飞书快捷对话直达链接:`);
    console.log(`   ${appLink}`);
    console.log(`💡 提示: 点击上方链接可直接在飞书桌面端/移动端打开与机器人的对话框！`);
    console.log(`🔍 飞书客户端搜索: 请在飞书搜索框搜索「${botName}」（而非 agy）`);
    console.log('====================================================\n');

    // 发送主动上线问候通知
    const target = this.getNotificationTarget();
    if (target) {
      console.log(`[agy-lark] 正在向目标 [${target.receiveIdType}:${target.receiveId}] 主动推送上线问候...`);
      const success = await this.notifyStartup(botName);
      if (success) {
        console.log('[agy-lark] ✅ 主动上线消息已送达飞书！');
      }
    } else {
      console.log('[agy-lark] 💡 暂未配置主动通知目标 (notifyReceiveId)。');
      console.log('   首次在飞书中向机器人发送任意消息后，机器人将自动记忆你的身份并在后续启动/停止时主动通知。');
    }
  }

  /** 预热模型列表与额度缓存（失败不影响服务，只记日志）。 */
  private async prewarmCaches(): Promise<void> {
    const startedAt = Date.now();
    const isAgyQuotaEnabled = !!this.config.agy?.quota?.enabled;
    const [agyModels, piModels, quota] = await Promise.all([
      fetchAvailableModels(this.config.agy.binary || 'agy').catch(() => undefined),
      fetchPiModels(this.config.pi).catch(() => undefined),
      isAgyQuotaEnabled ? fetchQuotaSummary(this.config.agy.quota).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    console.log(
      `[agy-lark] 缓存预热完成 (${Date.now() - startedAt}ms)：agy 模型 ${agyModels?.length ?? 0} 个，pi 模型 ${piModels?.length ?? 0} 个，` +
        `额度 ${quota ? `${quota.groups.length} 组` : (isAgyQuotaEnabled ? '不可用' : '未启用')}`
    );
  }

  public stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    try {
      this.wsClient.close();
      console.log('[agy-lark] 飞书长连接已断开');
    } catch {
      // Ignore
    }
  }
}
