import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import {
  clearQuotaCache,
  fetchQuotaSummary,
  getCachedQuota,
  normalizeQuotaSummary,
  DEFAULT_OAUTH_CLIENT_SECRET,
  DEFAULT_OAUTH_CLIENT_ID,
} from '../src/core/quota.js';

const SAMPLE = {
  groups: [
    {
      displayName: 'Gemini Models',
      description: 'Models within this group: Gemini Flash, Gemini Pro',
      buckets: [
        {
          bucketId: 'gemini-weekly',
          displayName: 'Weekly Limit Remaining',
          window: 'weekly',
          resetTime: '2026-10-06T14:39:09Z',
          description: 'You have used some of your weekly limit...',
          remainingFraction: 0.91864115,
        },
        {
          bucketId: 'gemini-5h',
          displayName: 'Five Hour Limit Remaining',
          window: '5h',
          resetTime: '2026-09-30T13:56:42Z',
          remainingFraction: 0.792657,
        },
      ],
    },
  ],
  description: 'Within each group, models share a weekly limit and a 5-hour limit.',
};

test('quota: normalizeQuotaSummary 解析分组与 bucket', () => {
  const summary = normalizeQuotaSummary(SAMPLE);
  assert.ok(summary, '应解析成功');
  assert.equal(summary!.groups.length, 1);

  const group = summary!.groups[0];
  assert.equal(group.displayName, 'Gemini Models');
  assert.equal(group.buckets.length, 2);
  assert.equal(group.buckets[0].window, 'weekly');
  assert.equal(group.buckets[0].remainingFraction, 0.91864115);
  assert.ok(summary!.fetchedAt > 0, '应记录取数时间');
});

test('quota: remainingFraction 越界会被裁剪到 [0,1]', () => {
  const summary = normalizeQuotaSummary({
    groups: [
      {
        displayName: 'G',
        buckets: [
          { displayName: 'over', window: 'weekly', remainingFraction: 1.8 },
          { displayName: 'under', window: '5h', remainingFraction: -0.4 },
        ],
      },
    ],
  });

  assert.equal(summary!.groups[0].buckets[0].remainingFraction, 1);
  assert.equal(summary!.groups[0].buckets[1].remainingFraction, 0);
});

test('quota: 脏数据被丢弃，全部无效时返回 undefined', () => {
  assert.equal(normalizeQuotaSummary(null), undefined);
  assert.equal(normalizeQuotaSummary('nope'), undefined);
  assert.equal(normalizeQuotaSummary({}), undefined);
  assert.equal(normalizeQuotaSummary({ groups: [] }), undefined);

  // 无 displayName 的分组 / 无 displayName 的 bucket / 空 bucket 的分组 全部丢弃
  const summary = normalizeQuotaSummary({
    groups: [
      { buckets: [{ displayName: 'x', window: 'weekly' }] },
      { displayName: 'Keep', buckets: [{ window: 'weekly' }, { displayName: 'ok', window: 'weekly' }] },
      { displayName: 'Empty', buckets: [] },
    ],
  });
  assert.equal(summary!.groups.length, 1);
  assert.equal(summary!.groups[0].displayName, 'Keep');
  assert.equal(summary!.groups[0].buckets.length, 1);
});

test('quota: 未开启或令牌不可用时返回 undefined 且不抛异常', async () => {
  clearQuotaCache();
  assert.equal(await fetchQuotaSummary({ enabled: false }), undefined);

  // 指向不存在的令牌文件 + 不存在的 Keychain 条目 → 无法解析令牌 → 直接降级，不发网络请求
  const summary = await fetchQuotaSummary({
    tokenPath: path.join(os.tmpdir(), 'agy-lark-not-exists', 'token.json'),
    keychainService: 'agy-lark-no-such-service',
    keychainAccount: 'agy-lark-no-such-account',
    timeoutMs: 2000,
  });
  assert.equal(summary, undefined, '取数失败必须降级为 undefined');
});

test('quota: 缓存读写与清理', () => {
  clearQuotaCache();
  assert.equal(getCachedQuota(), undefined, '初始应无缓存');
  clearQuotaCache();
  assert.equal(getCachedQuota(), undefined);
});

test('quota: agy-core quota 子命令注册与帮助信息', () => {
  const helpOut = execSync('node bin/agy-core.js --help', { encoding: 'utf8' });
  assert.ok(helpOut.includes('agy-core quota [--json]'), '帮助信息中应包含 quota 子命令');
});

test('quota: 源码中不硬编码 Client Secret 或 Client ID，默认值必须为空', () => {
  assert.equal(DEFAULT_OAUTH_CLIENT_SECRET, '', 'DEFAULT_OAUTH_CLIENT_SECRET 必须为空字符串');
  assert.equal(DEFAULT_OAUTH_CLIENT_ID, '', 'DEFAULT_OAUTH_CLIENT_ID 必须为空字符串');
});

test('quota: 令牌过期且未配置 oauthClientSecret 时自刷新安全降级', async () => {
  clearQuotaCache();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-quota-test-'));
  const expiredTokenPath = path.join(tmpDir, 'expired-token.json');
  fs.writeFileSync(
    expiredTokenPath,
    JSON.stringify({
      token: {
        access_token: 'expired_access_token',
        refresh_token: 'mock_refresh_token',
        expiry: '2000-01-01T00:00:00Z',
      },
    }),
    'utf8'
  );

  const summary = await fetchQuotaSummary({
    tokenPath: expiredTokenPath,
    keychainService: 'agy-lark-no-such-service',
    keychainAccount: 'agy-lark-no-such-account',
    oauthClientSecret: '',
    timeoutMs: 2000,
  });

  assert.equal(summary, undefined, '缺少 clientSecret 时自刷新应安全降级为 undefined');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
