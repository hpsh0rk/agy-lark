import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { downloadImageFromLark } from '../src/lark/downloader.js';

test('downloader: downloadImageFromLark 正确下载并落盘保存图片', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-down-test-'));
  const mockClient: any = {
    im: {
      messageResource: {
        get: async (req: any) => {
          assert.equal(req.path.message_id, 'om_msg_123');
          assert.equal(req.path.file_key, 'img_test_key');
          assert.equal(req.params.type, 'image');
          return {
            writeFile: async (dest: string) => {
              fs.writeFileSync(dest, 'mock-image-binary-data');
            },
          };
        },
      },
    },
  };

  const savedPath = await downloadImageFromLark(mockClient, 'om_msg_123', 'img_test_key', tmpDir);
  assert.ok(fs.existsSync(savedPath));
  assert.equal(fs.readFileSync(savedPath, 'utf8'), 'mock-image-binary-data');
  assert.ok(savedPath.includes('.agy-images'));

  // 验证若文件已存在则复用
  const secondPath = await downloadImageFromLark(mockClient, 'om_msg_123', 'img_test_key', tmpDir);
  assert.equal(secondPath, savedPath);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
