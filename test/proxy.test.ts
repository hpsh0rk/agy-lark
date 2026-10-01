import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyProxyEnvironment } from '../src/core/config.js';
import type { BridgeConfig } from '../src/core/types.js';

const MANAGED = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];

/** 在干净环境里跑断言，结束后原样还原这 4 个变量。 */
function withCleanProxyEnvironment(run: () => void): void {
  const saved = new Map(MANAGED.map((name) => [name, process.env[name]]));
  for (const name of MANAGED) delete process.env[name];
  try {
    run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('proxy: 只填补缺失的变量，shell 已有的代理不被覆盖', () => {
  withCleanProxyEnvironment(() => {
    process.env.HTTPS_PROXY = 'http://shell-injected:9999';

    const applied = applyProxyEnvironment({
      proxy: {
        http: 'http://127.0.0.1:7890',
        https: 'http://127.0.0.1:7890',
        no: '127.0.0.1,localhost',
      },
    } as BridgeConfig);

    assert.deepEqual(applied, ['HTTP_PROXY', 'NO_PROXY']);
    assert.equal(process.env.HTTPS_PROXY, 'http://shell-injected:9999');
    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:7890');
    assert.equal(process.env.ALL_PROXY, undefined);
  });
});

test('proxy: 未配置时不写入任何变量', () => {
  withCleanProxyEnvironment(() => {
    assert.deepEqual(applyProxyEnvironment({} as BridgeConfig), []);
    assert.equal(process.env.HTTPS_PROXY, undefined);
  });
});
