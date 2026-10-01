import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLarkMessage } from '../src/lark/parser.js';

test('parser: 纯文本消息解析', () => {
  const parsed = parseLarkMessage({
    message_type: 'text',
    content: JSON.stringify({ text: '你好，测试文本' }),
  });
  assert.equal(parsed.text, '你好，测试文本');
  assert.deepEqual(parsed.imageKeys, []);
});

test('parser: 富文本 post 消息图文混排解析', () => {
  const postContent = {
    title: '图文提问',
    content: [
      [
        { tag: 'img', image_key: 'img_v3_test_01' },
      ],
      [
        { tag: 'text', text: '总结一下这张图' },
      ],
    ],
  };

  const parsed = parseLarkMessage({
    message_type: 'post',
    content: JSON.stringify(postContent),
  });

  assert.ok(parsed.text.includes('图文提问'));
  assert.ok(parsed.text.includes('总结一下这张图'));
  assert.deepEqual(parsed.imageKeys, ['img_v3_test_01']);
});

test('parser: 富文本 post 消息多语言 zh_cn 格式解析', () => {
  const postContent = {
    zh_cn: {
      title: '',
      content: [
        [
          { tag: 'img', image_key: 'img_v3_02162_bc362427' },
        ],
        [
          { tag: 'text', text: '请看架构图' },
        ],
      ],
    },
  };

  const parsed = parseLarkMessage({
    message_type: 'post',
    content: JSON.stringify(postContent),
  });

  assert.equal(parsed.text, '请看架构图');
  assert.deepEqual(parsed.imageKeys, ['img_v3_02162_bc362427']);
});

test('parser: 纯图片消息解析', () => {
  const parsed = parseLarkMessage({
    message_type: 'image',
    content: JSON.stringify({ image_key: 'img_v3_pure_image_key' }),
  });

  assert.ok(parsed.text.includes('请分析'));
  assert.deepEqual(parsed.imageKeys, ['img_v3_pure_image_key']);
});

test('parser: 空内容或非法内容兜底', () => {
  const parsed1 = parseLarkMessage({
    message_type: 'text',
    content: '',
  });
  assert.equal(parsed1.text, '');
  assert.deepEqual(parsed1.imageKeys, []);

  const parsed2 = parseLarkMessage({
    message_type: 'unknown',
    content: 'not a json string',
  });
  assert.equal(parsed2.text, 'not a json string');
  assert.deepEqual(parsed2.imageKeys, []);
});
