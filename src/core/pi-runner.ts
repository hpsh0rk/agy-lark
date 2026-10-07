import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { BridgeError } from './errors.js';
import { ImageHarvester } from './image-harvester.js';
import { killProcessTree, summarizeToolCall } from './runner.js';
import type { AgentRunOptions, AgentRunResult, AgentUsage, PiConfig } from './types.js';

/**
 * 寻找可执行的 pi 路径（支持显式配置、~/.local/bin/pi 以及 PATH 查找）。
 */
export function resolvePiBinary(customBinary?: string): string {
  if (customBinary && customBinary !== 'pi') {
    return customBinary;
  }
  const localBin = path.join(os.homedir(), '.local', 'bin', 'pi');
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  return 'pi';
}

/**
 * 确保子进程环境变量补全 Node 及本地 CLI 路径。
 */
export function buildPiEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const delimiter = path.delimiter;
  const paths = (env.PATH || '').split(delimiter);
  const candidateDirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.local', 'bin'),
  ];
  for (const dir of candidateDirs) {
    if (!paths.includes(dir) && fs.existsSync(dir)) {
      paths.unshift(dir);
    }
  }
  env.PATH = paths.join(delimiter);
  return env;
}

/**
 * 运行 Pi Coding Agent 进程，解析流式 NDJSON 输出并通过回调驱动卡片打字机更新。
 */
export async function runPi(
  options: AgentRunOptions,
  config?: PiConfig
): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const timeoutMs =
    options.timeoutMs !== undefined
      ? options.timeoutMs
      : config?.timeoutMs !== undefined
      ? config.timeoutMs
      : 0; // <= 0 表示无超时限制
  const binary = resolvePiBinary(config?.binary);

  const args: string[] = ['-p', '--mode', 'json'];

  if (options.conversationId) {
    args.push('--session-id', options.conversationId);
  }

  const model = options.model || config?.defaultModel;
  if (model) {
    args.push('--model', model);
  }

  const thinking = options.effort || config?.thinking;
  if (thinking) {
    args.push('--thinking', thinking);
  }

  if (config?.provider) {
    args.push('--provider', config.provider);
  }

  if (options.imagePaths && options.imagePaths.length > 0) {
    for (const img of options.imagePaths) {
      if (img && fs.existsSync(img)) {
        args.push(`@${img}`);
      }
    }
  }

  args.push(options.prompt);

  const harvester = new ImageHarvester({
    conversationId: options.conversationId,
    cwd: options.cwd,
    startedAt,
  });

  const discoveredImages: string[] = [];
  harvester.startPolling((newImages) => {
    for (const img of newImages) {
      if (!discoveredImages.includes(img)) {
        discoveredImages.push(img);
      }
    }
    options.onImage?.(newImages);
  });

  return new Promise<AgentRunResult>((resolve, reject) => {
    let child: ChildProcess;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let capturedConvId = options.conversationId || '';
    let responseText = '';
    let capturedError = '';
    let lineBuf = '';
    let stderrBuf = '';
    let capturedUsage: AgentUsage | undefined;

    const cleanup = () => {
      harvester.stopPolling();
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    try {
      child = spawn(binary, args, {
        cwd: options.cwd,
        env: buildPiEnvironment(),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      cleanup();
      const msg = err instanceof Error ? err.message : String(err);
      return reject(
        new BridgeError(
          'E_PI_NOT_FOUND',
          `启动 pi 失败: ${msg}`,
          '请确认已安装 pi (curl -fsSL https://pi.dev/install.sh | sh) 并具备执行权限'
        )
      );
    }

    if (options.signal) {
      if (options.signal.aborted) {
        killProcessTree(child);
        return finish(() => {
          reject(new BridgeError('E_PI_ABORTED', '任务在启动前已被取消', '用户主动终止了会话'));
        });
      }
      options.signal.addEventListener('abort', () => {
        killProcessTree(child);
        finish(() => {
          reject(new BridgeError('E_PI_ABORTED', '任务已被用户中止', '会话已被 /stop 指令或超时中断'));
        });
      });
    }

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        killProcessTree(child);
        finish(() => {
          reject(
            new BridgeError(
              'E_PI_TIMEOUT',
              `执行超时 (${Math.round(timeoutMs / 1000)} 秒)`,
              '任务耗时过长，已自动终止进程以释放资源'
            )
          );
        });
      }, timeoutMs);
    }

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;

      let event: any;
      try {
        event = JSON.parse(trimmed);
      } catch {
        // 忽略非 JSON 行 (例如 session warning 或环境日志)
        return;
      }

      if (event.type === 'session' && event.id) {
        capturedConvId = event.id;
        harvester.setConversationId(capturedConvId);
        options.onInit?.({
          conversationId: capturedConvId,
          cwd: event.cwd || options.cwd,
          tools: [],
        });
      } else if (event.type === 'message_update' && event.assistantMessageEvent) {
        const ame = event.assistantMessageEvent;
        if (ame.type === 'text_delta' && typeof ame.delta === 'string') {
          responseText += ame.delta;
          options.onDelta?.(ame.delta);
        }
        options.onStep?.({
          index: ame.contentIndex ?? 0,
          stepType: ame.type || 'message_update',
          state: 'ACTIVE',
          summary: '生成回答',
          textDelta: ame.delta,
        });
      } else if (event.type === 'tool_execution_start') {
        const summary = summarizeToolCall(event.toolName, event.args);
        options.onStep?.({
          index: Date.now(),
          stepType: 'tool',
          state: 'ACTIVE',
          toolName: event.toolName,
          summary,
          toolInfo: { name: event.toolName, parameters: event.args },
        });
      } else if (event.type === 'tool_execution_end') {
        options.onStep?.({
          index: Date.now(),
          stepType: 'tool',
          state: event.isError ? 'ERROR' : 'DONE',
          toolName: event.toolName,
          summary: summarizeToolCall(event.toolName),
          toolInfo: { name: event.toolName, output: typeof event.result === 'string' ? event.result : JSON.stringify(event.result) },
        });
      } else if (event.type === 'message_end' || event.type === 'turn_end') {
        const msg = event.message || {};
        if (msg.stopReason === 'error' || msg.errorMessage) {
          capturedError = msg.errorMessage || `执行异常中断: ${msg.stopReason}`;
        }
        if (event.type === 'turn_end' && msg.usage) {
          const rawUsage = msg.usage || {};
          capturedUsage = {
            inputTokens: rawUsage.input || 0,
            outputTokens: rawUsage.output || 0,
            thinkingTokens: rawUsage.reasoning || 0,
            cacheReadTokens: rawUsage.cacheRead || 0,
            totalTokens: rawUsage.totalTokens || 0,
          };
        }
      } else if (event.type === 'auto_retry_end') {
        if (event.success === false && event.finalError) {
          capturedError = event.finalError;
        }
      } else if (event.type === 'agent_end') {
        const lastMsg = Array.isArray(event.messages) ? event.messages[event.messages.length - 1] : undefined;
        if (lastMsg && (lastMsg.stopReason === 'error' || lastMsg.errorMessage)) {
          capturedError = lastMsg.errorMessage || capturedError;
        }
      } else if (event.type === 'error') {
        capturedError = event.message || event.error || capturedError;
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      lineBuf += chunk.toString('utf8');
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() || '';
      for (const line of lines) {
        handleLine(line);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on('close', (code) => {
      if (lineBuf.trim()) {
        handleLine(lineBuf);
      }

      const remainingImages = harvester.harvestFinal();
      for (const img of remainingImages) {
        if (!discoveredImages.includes(img)) {
          discoveredImages.push(img);
        }
      }

      finish(() => {
        if (code !== 0) {
          const detail =
            capturedError ||
            stderrBuf.trim().slice(-300) ||
            responseText.trim() ||
            `pi 异常退出 (退出码 ${code})`;
          return reject(
            new BridgeError(
              'E_PI_RUN_FAILED',
              detail,
              '请检查 pi 环境与模型 Provider API Key 配置'
            )
          );
        }

        // 即便退出码为 0，若捕获到致命错误或未返回任何文本，绝不粉饰为成功
        if (capturedError) {
          return reject(
            new BridgeError(
              'E_PI_RUN_FAILED',
              capturedError,
              '上游模型服务网关报错，请检查账号池状态或通过 /model 切换可用模型'
            )
          );
        }

        if (!responseText.trim()) {
          return reject(
            new BridgeError(
              'E_PI_RUN_FAILED',
              'Pi 未返回任何有效内容',
              '模型网关响应为空或请求已超时，请重试或切换模型'
            )
          );
        }

        const result: AgentRunResult = {
          status: 'SUCCESS',
          response: responseText,
          conversationId: capturedConvId,
          durationSeconds: (Date.now() - startedAt) / 1000,
          usage: capturedUsage,
          imagePaths: discoveredImages,
        };

        options.onResult?.(result);
        resolve(result);
      });
    });
  });
}
