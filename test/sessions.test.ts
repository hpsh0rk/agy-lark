import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionStore, buildSessionKey } from '../src/core/sessions.js';

test('sessions: 路由键构造与隔离', () => {
  const p2pKey = buildSessionKey('p2p', 'chat_123');
  assert.equal(p2pKey, 'feishu:dm:chat_123');

  const groupThreadKey = buildSessionKey('group', 'chat_456', 'thread_789');
  assert.equal(groupThreadKey, 'feishu:group:chat_456:thread_789');

  const groupMainKey = buildSessionKey('group', 'chat_456');
  assert.equal(groupMainKey, 'feishu:group:chat_456:main');
});

test('SessionStore: 会话创建、更新与重置生命周期', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-session-test-'));
  const storePath = path.join(tmpDir, 'sessions.json');
  const store = new SessionStore(storePath);

  const entry = store.getOrCreate({
    chatId: 'oc_test123',
    chatType: 'p2p',
    defaultCwd: '/Users/test/project',
    defaultProjectName: 'test-proj',
  });

  assert.equal(entry.sessionKey, 'feishu:dm:oc_test123');
  assert.equal(entry.cwd, '/Users/test/project');
  assert.equal(entry.conversationId, undefined);

  // 更新会话 conversationId 和使用量
  store.update(entry.sessionKey, {
    conversationId: 'uuid-1234',
    totalUsage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      totalTokens: 150,
    },
  });

  const updated = store.get(entry.sessionKey);
  assert.equal(updated?.conversationId, 'uuid-1234');
  assert.equal(updated?.totalUsage?.totalTokens, 150);

  // 会话重置: 清空 conversationId，保留工作区与项目名
  store.reset(entry.sessionKey);
  const resetEntry = store.get(entry.sessionKey);
  assert.equal(resetEntry?.conversationId, undefined);
  assert.equal(resetEntry?.projectName, 'test-proj');
  assert.equal(resetEntry?.cwd, '/Users/test/project');

  // 测试主动通知对象记录与恢复
  store.recordActiveTarget({
    receiveId: 'ou_target_123',
    receiveIdType: 'open_id',
  });
  const target = store.getLastActiveTarget();
  assert.equal(target?.receiveId, 'ou_target_123');
  assert.equal(target?.receiveIdType, 'open_id');

  // 重新实例化 store，验证磁盘持久化还原
  const store2 = new SessionStore(storePath);
  const target2 = store2.getLastActiveTarget();
  assert.equal(target2?.receiveId, 'ou_target_123');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
