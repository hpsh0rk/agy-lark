#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { LarkBridgeService, loadBridgeConfig, resolveConfigPath, applyProxyEnvironment } from '../dist/index.js';

async function main() {
  const config = loadBridgeConfig();

  if (!config.lark.appId || !config.lark.appSecret) {
    const loadedPath = resolveConfigPath();
    const where = loadedPath
      ? `已加载配置文件: ${loadedPath}\n但它缺少 lark.appId / lark.appSecret。`
      : `未找到配置文件，请在以下任一位置创建 config.json:\n  1. ${path.join(process.cwd(), 'config.json')}\n  2. ${path.join(os.homedir(), '.agy-lark', 'config.json')}`;

    console.error(`
[agy-lark] 错误: 未配置飞书凭据 (Lark App ID / App Secret)。

配置只从 config.json 读取（不再支持环境变量）。
${where}

配置示例:
{
  "lark": {
    "appId": "cli_xxxxxxxx",
    "appSecret": "xxxxxxxx"
  }
}
`);
    process.exit(1);
  }

  console.log('----------------------------------------------------');
  console.log('🤖 启动 agy-lark 桥接网关服务');
  console.log(`• 飞书 App ID: ${config.lark.appId}`);
  console.log(`• 默认项目根目录: ${config.workspace.defaultRoot}`);
  console.log(`• 默认大模型: ${config.agy.defaultModel || '系统默认'}`);
  console.log(`• 思考强度: ${config.agy.effort || 'high'}`);
  const appliedProxy = applyProxyEnvironment(config);
  if (appliedProxy.length > 0) {
    console.log(`• 出网代理: ${appliedProxy.join(', ')} (来自 config.json)`);
  }
  console.log('----------------------------------------------------');

  const service = new LarkBridgeService(config);

  let isShuttingDown = false;
  const handleShutdown = async (reason, exitCode = 0) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[agy-lark] 触发服务退出 (${reason})，正在向飞书发送通知...`);
    try {
      await service.notifyShutdown(reason);
    } catch {
      // Best-effort
    }
    service.stop();
    process.exit(exitCode);
  };

  process.on('SIGINT', () => handleShutdown('收到 SIGINT 终止信号 (用户手动停止 / Ctrl+C)', 0));
  process.on('SIGTERM', () => handleShutdown('收到 SIGTERM 终止信号 (进程查杀 / kill)', 0));
  process.on('SIGHUP', () => handleShutdown('收到 SIGHUP 挂起信号', 0));

  process.on('uncaughtException', async (err) => {
    console.error('[agy-lark] 未捕获异常:', err);
    await handleShutdown(`服务异常崩溃: ${err.message}`, 1);
  });

  process.on('unhandledRejection', async (reason) => {
    console.error('[agy-lark] 未处理 Promise 异常:', reason);
    await handleShutdown(`未处理 Promise 异常: ${reason?.message || reason}`, 1);
  });

  await service.start();
}

main().catch((err) => {
  console.error('[agy-lark] 启动失败:', err);
  process.exit(1);
});
