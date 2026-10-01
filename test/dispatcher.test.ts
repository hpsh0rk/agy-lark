import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MessageDispatcher } from '../src/lark/dispatcher.js';
import { WorkspaceManager } from '../src/core/workspace.js';
import { SessionStore } from '../src/core/sessions.js';
import type { BridgeConfig } from '../src/core/types.js';

function setupDispatcher() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-disp-test-'));
  const configPath = path.join(tmpDir, 'workspace.json');
  const workspace = new WorkspaceManager(configPath);
  workspace.setDefaultRoot(tmpDir);
  const sessions = new SessionStore(path.join(tmpDir, 'sessions.json'));

  const replies: any[] = [];
  const mockClient: any = {
    im: {
      message: {
        reply: async (req: any) => {
          replies.push(req);
          return {
            code: 0,
            msg: 'ok',
            data: { message_id: `om_reply_${replies.length}` },
          };
        },
      },
      messageResource: {
        get: async (req: any) => ({
          writeFile: async (dest: string) => {
            fs.writeFileSync(dest, 'mock-image-data');
          },
        }),
      },
    },
  };

  const config: BridgeConfig = {
    lark: { appId: 'test_app', appSecret: 'test_secret' },
    workspace: { defaultRoot: tmpDir, projects: {} },
    agy: { binary: '/bin/echo', effort: 'high', timeoutMs: 5000 },
  };

  const dispatcher = new MessageDispatcher(mockClient, config, workspace, sessions);

  const makeMessageEvent = (text: string, messageId = `om_${Date.now()}_${Math.random()}`) => ({
    message: {
      message_id: messageId,
      chat_id: 'oc_test_chat',
      chat_type: 'p2p',
      content: JSON.stringify({ text }),
    },
  });

  return { dispatcher, workspace, sessions, replies, tmpDir, makeMessageEvent };
}

test('dispatcher: /bind add 成功关联已有物理目录', async () => {
  const { dispatcher, workspace, sessions, replies, tmpDir, makeMessageEvent } = setupDispatcher();

  const existingDir = path.join(tmpDir, 'my-existing-web');
  fs.mkdirSync(existingDir);

  await dispatcher.handleMessage(makeMessageEvent(`/bind add web-proj ${existingDir}`));

  assert.equal(replies.length, 1);
  const sentCard = JSON.parse(replies[0].data.content);
  assert.equal(sentCard.header.title.content, '🎯 项目工作区管理 (Workspace Binding)');

  // 验证 workspace.json 已持久化
  assert.equal(workspace.getProjectPath('web-proj'), existingDir);

  // 验证当前会话已生效绑定并更新 cwd
  const session = sessions.get('feishu:dm:oc_test_chat');
  assert.ok(session);
  assert.equal(session.projectName, 'web-proj');
  assert.equal(session.cwd, existingDir);
  assert.equal(session.conversationId, undefined);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('dispatcher: /bind link 同样成功关联已有项目', async () => {
  const { dispatcher, workspace, sessions, replies, tmpDir, makeMessageEvent } = setupDispatcher();

  const existingDir = path.join(tmpDir, 'linked-app');
  fs.mkdirSync(existingDir);

  await dispatcher.handleMessage(makeMessageEvent(`/bind link linked-app ${existingDir}`));

  assert.equal(replies.length, 1);
  assert.equal(workspace.getProjectPath('linked-app'), existingDir);

  const session = sessions.get('feishu:dm:oc_test_chat');
  assert.equal(session?.projectName, 'linked-app');
  assert.equal(session?.cwd, existingDir);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('dispatcher: /bind add 缺少参数时返回用法提示卡片', async () => {
  const { dispatcher, replies, tmpDir, makeMessageEvent } = setupDispatcher();

  await dispatcher.handleMessage(makeMessageEvent('/bind add'));

  assert.equal(replies.length, 1);
  const card = JSON.parse(replies[0].data.content);
  const cardJson = JSON.stringify(card);
  assert.ok(cardJson.includes('/bind add <项目别名> <已有目录路径>'), '应返回语法提示');
  assert.ok(cardJson.includes('缺少项目别名或物理路径参数'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('dispatcher: /bind add 关联不存在的目录时返回错误卡片', async () => {
  const { dispatcher, workspace, replies, tmpDir, makeMessageEvent } = setupDispatcher();

  const notFound = path.join(tmpDir, 'does-not-exist');
  await dispatcher.handleMessage(makeMessageEvent(`/bind add ghost-proj ${notFound}`));

  assert.equal(replies.length, 1);
  const cardJson = JSON.stringify(JSON.parse(replies[0].data.content));
  assert.ok(cardJson.includes('关联已有项目失败'), '应提示关联失败');
  assert.ok(cardJson.includes('目标目录不存在'));
  assert.equal(workspace.getProjectPath('ghost-proj'), undefined);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('dispatcher: /bind create 缺少参数返回用法提示卡片', async () => {
  const { dispatcher, replies, tmpDir, makeMessageEvent } = setupDispatcher();

  await dispatcher.handleMessage(makeMessageEvent('/bind create'));

  assert.equal(replies.length, 1);
  const cardJson = JSON.stringify(JSON.parse(replies[0].data.content));
  assert.ok(cardJson.includes('/bind create <项目名>'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('dispatcher: /bind delete 缺少参数返回用法提示卡片', async () => {
  const { dispatcher, replies, tmpDir, makeMessageEvent } = setupDispatcher();

  await dispatcher.handleMessage(makeMessageEvent('/bind delete'));

  assert.equal(replies.length, 1);
  const cardJson = JSON.stringify(JSON.parse(replies[0].data.content));
  assert.ok(cardJson.includes('/bind delete <项目别名>'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function waitForFile(filePath: string, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fs.existsSync(filePath);
}

test('dispatcher: 收到富文本 post 图文混排消息，自动下载图片并触发执行', async () => {
  const { dispatcher, replies, tmpDir } = setupDispatcher();

  const postEvent = {
    message: {
      message_id: 'om_post_001',
      chat_id: 'oc_test_chat',
      chat_type: 'p2p',
      message_type: 'post',
      content: JSON.stringify({
        content: [
          [{ tag: 'img', image_key: 'img_test_123' }],
          [{ tag: 'text', text: '总结这张图' }],
        ],
      }),
    },
  };

  await dispatcher.handleMessage(postEvent);

  const downloadedFile = path.join(tmpDir, '.agy-images', 'om_post_001_img_test_123.png');
  const found = await waitForFile(downloadedFile);
  assert.ok(found, '图片应被正确下载');

  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('dispatcher: 收到纯图片消息，自动下载并赋予默认提示词触发执行', async () => {
  const { dispatcher, tmpDir } = setupDispatcher();

  const imageEvent = {
    message: {
      message_id: 'om_img_002',
      chat_id: 'oc_test_chat',
      chat_type: 'p2p',
      message_type: 'image',
      content: JSON.stringify({
        image_key: 'img_pure_456',
      }),
    },
  };

  await dispatcher.handleMessage(imageEvent);

  const downloadedFile = path.join(tmpDir, '.agy-images', 'om_img_002_img_pure_456.png');
  const found = await waitForFile(downloadedFile);
  assert.ok(found, '纯图片消息中的图片应被下载');

  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

