import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceManager } from '../src/core/workspace.js';

test('WorkspaceManager: 注册与查询项目', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ws-test-'));
  const configPath = path.join(tmpDir, 'workspace.json');
  const ws = new WorkspaceManager(configPath);

  const testProjectDir = path.join(tmpDir, 'my-test-proj');
  fs.mkdirSync(testProjectDir);

  ws.registerProject('test-proj', testProjectDir);
  assert.equal(ws.getProjectPath('test-proj'), testProjectDir);

  const projects = ws.listProjects();
  assert.equal(projects['test-proj'], testProjectDir);

  // 非法别名校验
  assert.throws(() => {
    ws.registerProject('', testProjectDir);
  }, /项目名称不合法/);

  assert.throws(() => {
    ws.registerProject('invalid name with space', testProjectDir);
  }, /项目名称不合法/);

  // 不存在目录校验
  assert.throws(() => {
    ws.registerProject('non-exist', path.join(tmpDir, 'not-found-folder'));
  }, /目标目录不存在/);

  // 普通文件非目录校验
  const dummyFile = path.join(tmpDir, 'test-file.txt');
  fs.writeFileSync(dummyFile, 'hello', 'utf8');
  assert.throws(() => {
    ws.registerProject('file-proj', dummyFile);
  }, /不是目录/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('WorkspaceManager: 创建新项目与目录自动生成', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ws-test-'));
  const configPath = path.join(tmpDir, 'workspace.json');
  const ws = new WorkspaceManager(configPath);

  ws.setDefaultRoot(tmpDir);
  assert.equal(ws.getDefaultRoot(), tmpDir);

  const createdPath = ws.createProject('demo-app');
  assert.equal(createdPath, path.join(tmpDir, 'demo-app'));
  assert.ok(fs.existsSync(createdPath), '新项目物理文件夹应被创建');
  assert.equal(ws.getProjectPath('demo-app'), createdPath);

  // 重复创建应抛出结构化错误
  assert.throws(() => {
    ws.createProject('demo-app');
  }, /已存在/);

  // 移除项目别名
  const removed = ws.removeProject('demo-app');
  assert.equal(removed, true);
  assert.equal(ws.getProjectPath('demo-app'), undefined);
  // 物理文件应当保留
  assert.ok(fs.existsSync(createdPath), '移除别名不应删除物理文件');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
