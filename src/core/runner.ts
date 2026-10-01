import { spawn, type ChildProcess } from 'node:child_process';
import { BridgeError } from './errors.js';
import { ImageHarvester } from './image-harvester.js';
import type { AgyRunOptions, AgyRunResult, AgyUsage } from './types.js';

/**
 * 终止 agy 进程树 (先 SIGTERM，1 秒后 SIGKILL 兜底)。
 *
 * @returns `true` = 已对目标进程发出终止信号；
 *          `false` = 进程尚未 spawn 成功 (无 pid)，本次调用是幂等 no-op。
 *          无 pid 并非失败：调用方 (abort / timeout 清理路径) 无需额外处理。
 */
export function killProcessTree(child: ChildProcess): boolean {
  const pid = child.pid;
  if (pid === undefined) {
    // 进程尚未 spawn 成功，没有可终止的目标 —— 幂等 no-op
    return false;
  }

  try {
    // Send SIGTERM to process group if possible, else direct process
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // 进程可能已自行退出，SIGTERM 失败不构成错误
    }
  }

  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // 进程已退出，SIGKILL 失败不构成错误
      }
    }
  }, 1000).unref();

  return true;
}

export async function runAgy(options: AgyRunOptions, binary = 'agy'): Promise<AgyRunResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs || 600000; // 10 minutes default

  const args: string[] = [
    '-p',
    options.prompt,
    '--output-format',
    'stream-json',
    '--dangerously-skip-permissions',
  ];

  if (options.conversationId) {
    args.push('--conversation', options.conversationId);
  }

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.effort) {
    args.push('--effort', options.effort);
  }

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

  return new Promise<AgyRunResult>((resolve, reject) => {
    let child: ChildProcess;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let capturedConvId = options.conversationId || '';
    let finalResult: AgyRunResult | null = null;
    let lineBuf = '';
    let stderrBuf = '';
    let warnedNonJsonLine = false;

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
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      cleanup();
      const msg = err instanceof Error ? err.message : String(err);
      return reject(
        new BridgeError(
          'E_AGY_NOT_FOUND',
          `启动 agy 失败: ${msg}`,
          '请确认本地已正确安装并配置 agy 命令，且具备执行权限'
        )
      );
    }

    if (options.signal) {
      if (options.signal.aborted) {
        killProcessTree(child);
        return finish(() => {
          reject(new BridgeError('E_AGY_ABORTED', '任务在启动前已被取消', '用户主动终止了会话'));
        });
      }
      options.signal.addEventListener('abort', () => {
        killProcessTree(child);
        finish(() => {
          reject(new BridgeError('E_AGY_ABORTED', '任务已被用户中止', '会话已被 /stop 指令或超时中断'));
        });
      });
    }

    timeoutTimer = setTimeout(() => {
      killProcessTree(child);
      finish(() => {
        reject(
          new BridgeError(
            'E_AGY_TIMEOUT',
            `执行超时 (${Math.round(timeoutMs / 1000)} 秒)`,
            '任务耗时过长，已自动终止进程以释放资源'
          )
        );
      });
    }, timeoutMs);

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        // 空行不是错误：agy 的 stream-json 允许行间空行，无内容可解析
        return;
      }

      let event: any;
      try {
        event = JSON.parse(trimmed);
      } catch {
        // 非 JSON 行 (如 agy 的进度提示) 不致命，但必须可观测：只告警一次，避免刷屏
        if (warnedNonJsonLine) return;
        warnedNonJsonLine = true;
        console.warn(`[agy-lark] 忽略无法解析为 JSON 的 agy 输出行: ${trimmed.slice(0, 200)}`);
        return;
      }

      if (event.event === 'init' && event.conversation_id) {
        capturedConvId = event.conversation_id;
        harvester.setConversationId(capturedConvId);
        options.onInit?.({
          conversationId: capturedConvId,
          cwd: event.init?.cwd || options.cwd,
          tools: event.init?.tools || [],
          permissionMode: event.init?.permission_mode,
        });
      } else if (event.event === 'step_update' && event.step_update) {
        const su = event.step_update;
        if (su.conversation_id && !capturedConvId) {
          capturedConvId = su.conversation_id;
          harvester.setConversationId(capturedConvId);
        }

        if (su.step_type === 'agent_response' && typeof su.text_delta === 'string') {
          options.onDelta?.(su.text_delta);
        }

        options.onStep?.({
          index: su.step_index ?? -1,
          stepType: su.step_type || 'unknown',
          state: su.state || 'ACTIVE',
          toolName: su.tool_name,
          textDelta: su.text_delta,
          durationSeconds: su.duration_seconds,
        });

        // Fast-fail if image tool errored to avoid endless shell fallbacks
        if (su.state === 'ERROR' && su.tool_name === 'generate_image') {
          const errDetail = su.tool_info?.error?.message || '生成图片配额超限或模型不可用';
          killProcessTree(child);
          finish(() => {
            reject(
              new BridgeError(
                'E_IMAGE_GEN_FAILED',
                `图片生成工具调用失败: ${errDetail}`,
                '请检查配额或稍后重试'
              )
            );
          });
        }
      } else if (event.event === 'result' && event.result) {
        const res = event.result;
        const rawUsage = res.usage || {};
        const usage: AgyUsage = {
          inputTokens: rawUsage.input_tokens || 0,
          outputTokens: rawUsage.output_tokens || 0,
          thinkingTokens: rawUsage.thinking_tokens || 0,
          cacheReadTokens: rawUsage.cache_read_tokens || 0,
          totalTokens: rawUsage.total_tokens || 0,
        };

        finalResult = {
          status: res.status === 'SUCCESS' ? 'SUCCESS' : 'ERROR',
          response: res.response || '',
          conversationId: res.conversation_id || capturedConvId,
          durationSeconds: res.duration_seconds || (Date.now() - startedAt) / 1000,
          usage,
        };
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

      // Final sweep for generated images
      const remainingImages = harvester.harvestFinal();
      for (const img of remainingImages) {
        if (!discoveredImages.includes(img)) {
          discoveredImages.push(img);
        }
      }

      finish(() => {
        if (code !== 0 && !finalResult) {
          return reject(
            new BridgeError(
              'E_AGY_RUN_FAILED',
              `agy 异常退出 (退出码 ${code}): ${stderrBuf.trim().slice(-300)}`,
              '请检查 agy 运行日志与环境'
            )
          );
        }

        const result: AgyRunResult = finalResult || {
          status: code === 0 ? 'SUCCESS' : 'ERROR',
          response: '',
          conversationId: capturedConvId,
          durationSeconds: (Date.now() - startedAt) / 1000,
          imagePaths: discoveredImages,
        };
        result.imagePaths = discoveredImages;

        options.onResult?.(result);
        resolve(result);
      });
    });
  });
}
