# 任务规格: 敏感密钥代码剥离与本地配置隔离

> 状态: Implemented
> 创建时间: 2026-10-01
> 对应模块: agy-core (quota), config, tests
> 关联任务: 剥离代码中硬编码的 Google OAuth 客户端密钥，移入本地 gitignore 的 config.json，防止上传 GitHub 泄露或触发 Push Protection 拦截

---

## 1. 范围与边界 (Scope & Guardrails)

### 背景与风险
1. `src/core/quota.ts` 历史实现中内嵌了 Base64 编码的 Google OAuth Client Secret。
2. GitHub Secret Scanning 能够自动解码 Base64 并匹配 Google OAuth 凭据特征。推送至 GitHub 公开仓库会触发 Push Protection 拦截或导致凭据被吊销。
3. `httpPost` 错误处理中直接打印 `err.message`，在 `curl` 非零退出时会包含完整命令行参数，导致终端日志泄漏凭据。

### 要做 (Goals)
1. 将 `src/core/quota.ts` 中的 `DEFAULT_OAUTH_CLIENT_SECRET` 与 `DEFAULT_OAUTH_CLIENT_ID` 置为空字符串 `''`，彻底消除源码级凭据硬编码。
2. 将真实 OAuth 密钥迁移至本地受 `.gitignore` 保护的 `config.json`（`agy.quota.oauthClientSecret` 与 `oauthClientId`）。
3. 在 `config.example.json` 中增加 `oauthClientId` 与 `oauthClientSecret` 的空字段示例，指导开源用户配置。
4. 加固 `httpPost` 日志输出，禁止直接打印可能携带命令行参数的异常，防止运行时日志泄露。
5. 当缺少 `oauthClientSecret` 时，自刷新机制安全降级为 `undefined`，绝不抛出未捕获异常。
6. 新增单元测试覆盖「源码无内嵌密钥」与「缺省密钥时优雅降级」。

### 不做 (Non-Goals)
- 不破坏 macOS Keychain 默认优先读取的免配置体验。
- 不引入外部密钥服务或加密库依赖。

---

## 2. 契约 (Contract)

### 2.1 凭据解析契约
- 令牌自刷新时读取 `opts.oauthClientId || DEFAULT_OAUTH_CLIENT_ID` 与 `opts.oauthClientSecret || DEFAULT_OAUTH_CLIENT_SECRET`。
- 若任一为空，则认为无自刷新凭据，直接返回 `undefined` 并降级，不发起任何未授权网络请求。

### 2.2 配置契约 (`config.json`)
```json
{
  "agy": {
    "quota": {
      "enabled": true,
      "userAgent": "antigravitycli/1.2.14",
      "keychainService": "gemini",
      "keychainAccount": "antigravity",
      "oauthClientId": "<YOUR_OAUTH_CLIENT_ID>",
      "oauthClientSecret": "<YOUR_OAUTH_CLIENT_SECRET>"
    }
  }
}
```

---

## 3. 验收标准 (Acceptance Criteria)

- [x] AC1: `src/` 与 `bin/` 源码中经正则表达式扫描无任何 Google OAuth 客户端凭据或 Base64 编码密钥。
- [x] AC2: `DEFAULT_OAUTH_CLIENT_SECRET` 导出值为空字符串 `''`。
- [x] AC3: `config.json` 在本地正常支持配置 `oauthClientId` 与 `oauthClientSecret`，且位于 `.gitignore` 中。
- [x] AC4: `config.example.json` 提供清晰的占位说明且无真实私密值。
- [x] AC5: `npm test` 全绿，`npm run build` 成功，门禁扫描 0 违规。
