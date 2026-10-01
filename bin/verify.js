#!/usr/bin/env node
import { execSync } from 'node:child_process';
import * as lark from '@larksuiteoapi/node-sdk';
import { loadBridgeConfig, resolveConfigPath } from '../dist/index.js';

async function verify() {
  console.log('====================================================');
  console.log('🔍 agy-lark 运行环境与接入配置自检 (Pre-flight Check)');
  console.log('====================================================\n');

  let passed = true;

  // 1. 检查 Node.js 版本
  const nodeVersion = process.version;
  console.log(`[1/5] Node.js 环境: ${nodeVersion}`);
  const major = parseInt(nodeVersion.replace('v', '').split('.')[0], 10);
  if (major < 18) {
    console.error('  ❌ 错误: Node.js 版本必须 >= 18 (当前: ' + nodeVersion + ')');
    passed = false;
  } else {
    console.log('  ✅ Node.js 版本检测通过');
  }

  // 2. 检查 agy CLI 可执行程序
  // 配置只从 config.json 读取（不再支持环境变量），agy 路径以 config.agy.binary 为准
  const config = loadBridgeConfig();
  const configPath = resolveConfigPath();
  console.log(`\n[2/5] Antigravity CLI (agy) 可执行程序检测: (binary=${config.agy.binary || 'agy'})`);
  const agyBin = config.agy.binary || 'agy';
  try {
    const agyPath = execSync(`which ${agyBin} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
    if (agyPath) {
      console.log(`  ✅ 找到 agy 路径: ${agyPath}`);
    } else {
      console.error(`  ❌ 警告: 在系统 PATH 中未直接找到 ${agyBin}，尝试运行验证...`);
    }

    const versionOut = execSync(`${agyBin} --version 2>&1`, { encoding: 'utf8' }).trim();
    console.log(`  ✅ agy 运行正常: ${versionOut.split('\n')[0]}`);
  } catch (err) {
    console.error(`  ❌ 错误: 无法调用 ${agyBin}:`, err.message);
    passed = false;
  }

  // 3. 检查本地模型列表
  console.log('\n[3/5] 检测 agy 本地大模型支持列表:');
  try {
    const modelsOut = execSync(`${agyBin} models 2>&1`, { encoding: 'utf8' });
    const count = (modelsOut.match(/gemini|claude|gpt/gi) || []).length;
    console.log(`  ✅ 成功获取模型支持列表，解析到相关模型词频: ${count}`);
  } catch (err) {
    console.error('  ❌ 错误: 获取 agy models 失败:', err.message);
    passed = false;
  }

  // 4. 加载并检查配置
  console.log('\n[4/5] 检查配置文件与凭据加载:');
  console.log(`  • 配置文件: ${configPath || '未找到 (仅使用内置默认值)'}`);
  console.log(`  • 默认项目根目录: ${config.workspace.defaultRoot}`);
  console.log(`  • 默认大模型: ${config.agy.defaultModel || '系统自动选定'}`);
  console.log(`  • 思考强度: ${config.agy.effort}`);

  if (!config.lark.appId || !config.lark.appSecret) {
    console.error('  ❌ 错误: 未配置飞书凭据 (Lark App ID / App Secret)。');
    console.error('     请在 config.json 的 lark 块中配置 appId / appSecret（配置不再从环境变量读取）');
    passed = false;
  } else {
    const maskedSecret = config.lark.appSecret.slice(0, 4) + '****' + config.lark.appSecret.slice(-4);
    console.log(`  ✅ 飞书凭据已就绪: App ID=${config.lark.appId}, App Secret=${maskedSecret}`);
  }

  // 5. 校验飞书服务端连接与机器人激活状态
  console.log('\n[5/5] 校验飞书开放平台通信与机器人状态:');
  if (config.lark.appId && config.lark.appSecret) {
    try {
      const client = new lark.Client({
        appId: config.lark.appId,
        appSecret: config.lark.appSecret,
      });

      // 验证 token 交换
      const tokenRes = await client.auth.tenantAccessToken.internal({
        data: {
          app_id: config.lark.appId,
          app_secret: config.lark.appSecret,
        },
      });

      if (tokenRes.code !== 0) {
        throw new Error(`获取 tenant_access_token 失败 [${tokenRes.code}]: ${tokenRes.msg}`);
      }
      console.log('  ✅ 成功交换飞书租户凭证 (tenant_access_token 有效期: ' + tokenRes.expire + '秒)');

      // 获取机器人信息
      const botRes = await client.request({
        url: '/open-apis/bot/v3/info',
        method: 'GET',
      });

      if (botRes.code === 0 && botRes.bot) {
        console.log(`  ✅ 机器人状态正常:`);
        console.log(`     - 应用名称: ${botRes.bot.app_name}`);
        console.log(`     - 激活状态: ${botRes.bot.activate_status === 2 ? '已激活 (Active)' : botRes.bot.activate_status}`);
        console.log(`     - 机器人 OpenID: ${botRes.bot.open_id}`);
        console.log(`\n  🔗 飞书快捷对话直达链接:`);
        console.log(`     https://applink.feishu.cn/client/bot/open?appId=${config.lark.appId}`);
        console.log(`     (在浏览器或飞书打开此链接，可直接唤起与机器人的单聊窗口！)`);
        console.log(`  🔍 客户端搜索说明: 请搜索机器人名称「${botRes.bot.app_name}」（搜索 agy 会搜不到）`);
      } else {
        console.warn(`  ⚠️ 获取机器人详情返回非0 [${botRes.code}]: ${botRes.msg}`);
      }
    } catch (err) {
      console.error('  ❌ 飞书开放平台连通性校验失败:', err.message);
      passed = false;
    }
  }

  console.log('\n====================================================');
  if (passed) {
    console.log('🎉 所有环境与配置自检全部通过！可以直接启动:');
    console.log('   npm run lark  (或 node bin/agy-lark.js)');
    console.log('====================================================\n');
    process.exit(0);
  } else {
    console.error('💥 自检存在未通过项，请对照上述提示进行修复。');
    console.log('====================================================\n');
    process.exit(1);
  }
}

verify().catch((err) => {
  console.error('自检执行异常:', err);
  process.exit(1);
});
