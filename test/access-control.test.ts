import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAccess } from '../src/lark/access-control.js';
import { loadBridgeConfig } from '../src/core/config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('access-control: 未启用时一律放行（向后兼容）', () => {
  assert.deepEqual(checkAccess(undefined, { chatId: 'oc_x', senderOpenId: 'ou_x' }), { allowed: true });
  assert.deepEqual(checkAccess({}, { chatId: 'oc_x', senderOpenId: 'ou_x' }), { allowed: true });
  assert.deepEqual(checkAccess({ enabled: false, allowUsers: ['ou_a'] }, { senderOpenId: 'ou_stranger' }), {
    allowed: true,
  });
});

test('access-control: 启用后白名单用户命中即放行', () => {
  const config = { enabled: true, allowUsers: ['ou_owner', 'ou_teammate'], allowChats: [] };
  assert.deepEqual(checkAccess(config, { senderOpenId: 'ou_owner', chatId: 'oc_any' }), { allowed: true });
  assert.deepEqual(checkAccess(config, { senderOpenId: 'ou_teammate' }), { allowed: true });
});

test('access-control: 启用后白名单会话命中即放行（群内任意成员可用）', () => {
  const config = { enabled: true, allowUsers: [], allowChats: ['oc_group_ok'] };
  assert.deepEqual(checkAccess(config, { chatId: 'oc_group_ok', senderOpenId: 'ou_stranger' }), {
    allowed: true,
  });
});

test('access-control: 启用后用户与会话均未命中则拒绝 (fail-closed)', () => {
  const config = { enabled: true, allowUsers: ['ou_owner'], allowChats: ['oc_group_ok'] };
  const decision = checkAccess(config, { chatId: 'oc_other', senderOpenId: 'ou_stranger' });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) {
    assert.match(decision.reason, /白名单/);
  }
});

test('access-control: 启用但白名单为空时拒绝（防止白名单形同虚设）', () => {
  const decision = checkAccess({ enabled: true, allowUsers: [], allowChats: [] }, { senderOpenId: 'ou_owner' });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) {
    assert.match(decision.reason, /白名单为空/);
  }
});

test('access-control: 白名单中的空字符串项不参与命中', () => {
  const config = { enabled: true, allowUsers: [''], allowChats: ['', 'oc_ok'] };
  assert.deepEqual(checkAccess(config, { chatId: 'oc_ok' }), { allowed: true });
  assert.equal(checkAccess(config, { chatId: 'oc_other', senderOpenId: 'ou_x' }).allowed, false);
});

test('access-control: loadBridgeConfig 正确解析 accessControl 配置块', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ac-test-'));
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      lark: { appId: 'cli_xxxxxxxxxxxxxxxx', appSecret: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
      workspace: { defaultRoot: tmpDir, projects: {} },
      accessControl: {
        enabled: true,
        allowUsers: ['ou_owner'],
        allowChats: ['oc_group'],
        notifyDenied: true,
      },
    })
  );

  const config = loadBridgeConfig(configPath);
  assert.deepEqual(config.accessControl, {
    enabled: true,
    allowUsers: ['ou_owner'],
    allowChats: ['oc_group'],
    notifyDenied: true,
  });

  // 未写 accessControl 时应为 undefined（不改变既有行为）
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      lark: { appId: 'cli_xxxxxxxxxxxxxxxx', appSecret: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
      workspace: { defaultRoot: tmpDir, projects: {} },
    })
  );
  assert.equal(loadBridgeConfig(configPath).accessControl, undefined);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
