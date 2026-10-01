import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MessageDispatcher } from '../src/lark/dispatcher.js';
import { WorkspaceManager } from '../src/core/workspace.js';
import { SessionStore } from '../src/core/sessions.js';
import type { BridgeConfig } from '../src/core/types.js';

test('dispatcher: 消息幂等去重 (防止多次重试推送导致重复回复)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-dedup-test-'));
  const storePath = path.join(tmpDir, 'sessions.json');
  const sessions = new SessionStore(storePath);
  const workspace = new WorkspaceManager(path.join(tmpDir, 'workspace.json'));

  const config: BridgeConfig = {
    lark: { appId: 'mock_app', appSecret: 'mock_secret' },
    workspace: { defaultRoot: tmpDir, projects: {} },
    agy: { defaultModel: 'mock_model', effort: 'low' },
  };

  let replyCount = 0;
  const mockClient: any = {
    im: {
      message: {
        reply: async () => {
          replyCount++;
          return { code: 0, data: { message_id: 'om_bot_reply_1' } };
        },
        patch: async () => {
          return { code: 0 };
        },
      },
    },
  };

  const dispatcher = new MessageDispatcher(mockClient, config, workspace, sessions);

  const duplicateEvent = {
    message: {
      message_id: 'om_dup_test_123',
      chat_id: 'oc_test_chat',
      chat_type: 'p2p',
      content: JSON.stringify({ text: '/help' }),
    },
    sender: {
      sender_id: { open_id: 'ou_user_1' },
    },
  };

  // 第 1 次接收
  await dispatcher.handleMessage(duplicateEvent);
  assert.equal(replyCount, 1, '首次处理应正常回复 1 次');

  // 第 2 次接收相同的 message_id (模拟飞书超时重投)
  await dispatcher.handleMessage(duplicateEvent);
  assert.equal(replyCount, 1, '重复 message_id 必须被幂等过滤，回复计数应依然为 1');

  // 第 3 次接收不同的 message_id
  const anotherEvent = {
    ...duplicateEvent,
    message: {
      ...duplicateEvent.message,
      message_id: 'om_new_test_456',
    },
  };
  await dispatcher.handleMessage(anotherEvent);
  assert.equal(replyCount, 2, '新的 message_id 应正常处理并回复');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
