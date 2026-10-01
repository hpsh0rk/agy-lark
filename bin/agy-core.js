#!/usr/bin/env node
import {
  runAgy,
  fetchAvailableModels,
  fetchQuotaSummary,
  WorkspaceManager,
  loadBridgeConfig,
  applyProxyEnvironment,
} from '../dist/index.js';

function renderCliBar(fraction, width = 12) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

function formatReset(isoStr) {
  if (!isoStr) return '';
  const diffMs = Date.parse(isoStr) - Date.now();
  if (diffMs <= 0) return '即将重置';
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}天${hours % 24}小时后重置`;
  if (hours > 0) return `${hours}小时${mins % 60}分钟后重置`;
  return `${Math.max(1, mins)}分钟后重置`;
}

function printHelp() {
  console.log(`
agy-core: Antigravity CLI 本地运行与工作区管理工具

用法:
  agy-core run "<prompt>" [选项]
  agy-core models
  agy-core quota [--json]
  agy-core projects [list | add <name> <path> | create <name> | remove <name>]
  agy-core config [default_root <path>]

选项:
  --cwd <path>           指定执行工作目录 (默认: 当前目录)
  --conversation <id>    续聊已有会话 ID
  --model <model>        指定生效大模型
  --effort <effort>      思考强度: low | medium | high | max (默认: high)
  --json, -j             以 JSON 格式输出配额结果 (用于 quota 命令)
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  const workspace = new WorkspaceManager();

  if (command === 'models') {
    console.log('正在获取支持的模型列表...');
    const models = await fetchAvailableModels();
    console.log('\n可用模型:');
    for (const m of models) {
      console.log(`  • ${m.id.padEnd(28)} ${m.displayName} ${m.isThinking ? '[Thinking]' : ''}`);
    }
    return;
  }

  if (command === 'quota') {
    const isJson = args.includes('--json') || args.includes('-j');
    const config = loadBridgeConfig();
    applyProxyEnvironment(config);
    const summary = await fetchQuotaSummary(config.agy?.quota);

    if (!summary) {
      if (isJson) {
        console.error(
          JSON.stringify({ error: 'quota_unavailable', message: '未能获取到配额信息' })
        );
      } else {
        console.error(
          '[agy-core] 未能获取到配额信息。请确认是否已登录 Antigravity CLI (或检查 macOS Keychain/令牌文件)。'
        );
      }
      process.exit(1);
    }

    if (isJson) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    console.log('----------------------------------------------------');
    console.log('📊 Antigravity 配额状态:');
    console.log('----------------------------------------------------');
    for (const group of summary.groups) {
      console.log(`\n• ${group.displayName}`);
      if (group.description) {
        console.log(`  ${group.description}`);
      }
      for (const b of group.buckets) {
        const pct = (b.remainingFraction * 100).toFixed(1).padStart(5);
        const bar = renderCliBar(b.remainingFraction, 12);
        const reset = b.resetTime ? ` (${formatReset(b.resetTime)})` : '';
        console.log(`  - ${b.displayName.padEnd(30)} ${bar} ${pct}%${reset}`);
      }
    }
    if (summary.description) {
      console.log(`\n💡 ${summary.description}`);
    }
    console.log('----------------------------------------------------');
    return;
  }

  if (command === 'projects') {
    const sub = args[1] || 'list';
    if (sub === 'list') {
      const projects = workspace.listProjects();
      console.log(`默认根目录: ${workspace.getDefaultRoot()}`);
      console.log('已注册项目:');
      const entries = Object.entries(projects);
      if (entries.length === 0) {
        console.log('  (暂无项目别名)');
      } else {
        for (const [k, v] of entries) {
          console.log(`  • ${k.padEnd(20)} -> ${v}`);
        }
      }
      return;
    }

    if (sub === 'add') {
      const name = args[2];
      const p = args[3];
      if (!name || !p) {
        console.error('用法: agy-core projects add <name> <path>');
        process.exit(1);
      }
      const res = workspace.registerProject(name, p);
      console.log(`已成功绑定: ${name} -> ${res}`);
      return;
    }

    if (sub === 'create') {
      const name = args[2];
      if (!name) {
        console.error('用法: agy-core projects create <name>');
        process.exit(1);
      }
      const res = workspace.createProject(name);
      console.log(`已新建项目: ${name} -> ${res}`);
      return;
    }

    if (sub === 'remove') {
      const name = args[2];
      if (!name) {
        console.error('用法: agy-core projects remove <name>');
        process.exit(1);
      }
      const ok = workspace.removeProject(name);
      console.log(ok ? `已移除项目别名: ${name}` : `项目别名不存在: ${name}`);
      return;
    }
  }

  if (command === 'config') {
    const key = args[1];
    const val = args[2];
    if (key === 'default_root' && val) {
      const res = workspace.setDefaultRoot(val);
      console.log(`已更新默认项目创建目录: ${res}`);
      return;
    }
    console.log(`当前默认项目创建目录: ${workspace.getDefaultRoot()}`);
    return;
  }

  if (command === 'run') {
    const prompt = args[1];
    if (!prompt) {
      console.error('用法: agy-core run "<prompt>" [选项]');
      process.exit(1);
    }

    let cwd = process.cwd();
    let conversationId;
    let model;
    let effort = 'high';

    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--cwd' && args[i + 1]) cwd = workspace.expandPath(args[++i]);
      if (args[i] === '--conversation' && args[i + 1]) conversationId = args[++i];
      if (args[i] === '--model' && args[i + 1]) model = args[++i];
      if (args[i] === '--effort' && args[i + 1]) effort = args[++i];
    }

    console.log(`[agy-core] 运行目录: ${cwd}`);
    if (conversationId) console.log(`[agy-core] 续聊会话: ${conversationId}`);
    if (model) console.log(`[agy-core] 模型: ${model}`);

    const result = await runAgy({
      prompt,
      cwd,
      conversationId,
      model,
      effort: effort,
      onInit: (info) => {
        console.log(`[agy-core] 会话初始化成功: ID=${info.conversationId}`);
      },
      onDelta: (text) => {
        process.stdout.write(text);
      },
      onImage: (images) => {
        console.log(`\n[agy-core] 捕获到生成图片: ${images.join(', ')}`);
      },
    });

    console.log('\n--- 执行结果 ---');
    console.log(`状态: ${result.status}`);
    console.log(`会话ID: ${result.conversationId}`);
    console.log(`耗时: ${result.durationSeconds.toFixed(1)}s`);
    if (result.usage) {
      console.log(
        `Token用量: 输入 ${result.usage.inputTokens}, 输出 ${result.usage.outputTokens}, 缓存命中 ${result.usage.cacheReadTokens}, 总计 ${result.usage.totalTokens}`
      );
    }
    if (result.imagePaths && result.imagePaths.length > 0) {
      console.log(`图片产物: ${result.imagePaths.join(', ')}`);
    }
    return;
  }

  printHelp();
}

main().catch((err) => {
  console.error('[agy-core] 错误:', err.message || err);
  process.exit(1);
});
