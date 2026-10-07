import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskManager } from '../src/core/task-manager.js';

test('TaskManager: 异步任务生命周期与控制', async (t) => {
  await t.test('创建任务并初始化状态', () => {
    const tm = new TaskManager();
    const task = tm.createTask({
      sessionKey: 'feishu:dm:chat1',
      chatId: 'chat1',
      chatType: 'p2p',
      messageId: 'msg_001',
      engine: 'pi',
      projectName: 'my-project',
      cwd: '/tmp/proj',
      prompt: '长效异步任务分析',
    });

    assert.ok(task.id.startsWith('t-'));
    assert.equal(task.status, 'running');
    assert.equal(task.engine, 'pi');
    assert.equal(task.abortController.signal.aborted, false);

    const active = tm.getActiveTasks();
    assert.equal(active.length, 1);
    assert.equal(active[0].id, task.id);
  });

  await t.test('设置 botMessageId 与完成任务', () => {
    const tm = new TaskManager();
    const task = tm.createTask({
      sessionKey: 'feishu:dm:chat2',
      chatId: 'chat2',
      chatType: 'p2p',
      messageId: 'msg_002',
      engine: 'agy',
      cwd: '/tmp',
      prompt: '编译与压测',
    });

    tm.setBotMessageId(task.id, 'bot_msg_999');
    assert.equal(tm.getTask(task.id)?.botMessageId, 'bot_msg_999');

    tm.finishTask(task.id, 'completed');
    const updated = tm.getTask(task.id);
    assert.equal(updated?.status, 'completed');
    assert.ok(updated?.durationSeconds !== undefined && updated.durationSeconds >= 0);

    // 完成后不在活跃列表
    assert.equal(tm.getActiveTasks().length, 0);

    const task2 = tm.createTask({
      sessionKey: 'feishu:dm:chat2b',
      chatId: 'chat2b',
      chatType: 'p2p',
      messageId: 'msg_002b',
      engine: 'pi',
      cwd: '/tmp',
      prompt: '编译被中断',
    });
    tm.finishTask(task2.id, 'aborted', '用户取消');
    assert.equal(tm.getTask(task2.id)?.status, 'aborted');
    assert.equal(tm.getTask(task2.id)?.error, '用户取消');
  });

  await t.test('精准中止单任务 (abortTask)', () => {
    const tm = new TaskManager();
    const task = tm.createTask({
      sessionKey: 'feishu:dm:chat3',
      chatId: 'chat3',
      chatType: 'p2p',
      messageId: 'msg_003',
      engine: 'pi',
      cwd: '/tmp',
      prompt: '超长推理任务',
    });

    assert.equal(task.abortController.signal.aborted, false);

    const aborted = tm.abortTask(task.id);
    assert.ok(aborted);
    assert.equal(aborted.id, task.id);
    assert.equal(aborted.status, 'aborted');
    assert.equal(task.abortController.signal.aborted, true);
    assert.equal(tm.getActiveTasks().length, 0);
  });

  await t.test('按会话与全局批量中止 (abortSessionTasks & abortAll)', () => {
    const tm = new TaskManager();
    const t1 = tm.createTask({
      sessionKey: 'feishu:dm:chatA',
      chatId: 'chatA',
      chatType: 'p2p',
      messageId: 'msg_A1',
      engine: 'agy',
      cwd: '/tmp',
      prompt: '任务A1',
    });

    const t2 = tm.createTask({
      sessionKey: 'feishu:dm:chatA',
      chatId: 'chatA',
      chatType: 'p2p',
      messageId: 'msg_A2',
      engine: 'pi',
      cwd: '/tmp',
      prompt: '任务A2',
    });

    const t3 = tm.createTask({
      sessionKey: 'feishu:dm:chatB',
      chatId: 'chatB',
      chatType: 'p2p',
      messageId: 'msg_B1',
      engine: 'pi',
      cwd: '/tmp',
      prompt: '任务B1',
    });

    assert.equal(tm.getActiveTasks().length, 3);

    // 中止会话 A 的所有任务
    const abortedA = tm.abortSessionTasks('feishu:dm:chatA');
    assert.equal(abortedA.length, 2);
    assert.equal(t1.abortController.signal.aborted, true);
    assert.equal(t2.abortController.signal.aborted, true);
    assert.equal(t3.abortController.signal.aborted, false);

    assert.equal(tm.getActiveTasks().length, 1);

    // 中止全局剩余所有任务
    const abortedAll = tm.abortAll();
    assert.equal(abortedAll.length, 1);
    assert.equal(t3.abortController.signal.aborted, true);
    assert.equal(tm.getActiveTasks().length, 0);
  });

  await t.test('时长格式化展示 (formatDuration)', () => {
    const tm = new TaskManager();
    assert.equal(tm.formatDuration(45), '45秒');
    assert.equal(tm.formatDuration(125), '2分 5秒');
    assert.equal(tm.formatDuration(3670), '1小时 1分 10秒');
    assert.equal(tm.formatDuration(7200), '2小时 0分 0秒');
  });
});
