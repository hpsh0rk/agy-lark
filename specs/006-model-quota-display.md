# 任务规格: 模型面板展示额度（Quota）用量

> 状态: Implemented
> 创建时间: 2026-09-30
> 对应模块: agy-core (quota), agy-lark (cards, card-actions, client)
> 关联任务: 用户要求「模型选择与额度管理页面需要展示模型的额度情况，agy 里面执行 `/used` 可以查询到」

---

## 1. 范围与边界 (Scope & Guardrails)

### 背景与调研结论
- `agy models` 只返回 `模型ID + 展示名`，**不含额度**。
- CLI 的 `/used` 是**纯客户端 TUI 命令**：在 `--print` 模式下不会被展开
  （实测 `agy --print "/used"` 会把 `/used` 原样交给模型，模型只会胡乱执行 `ls` 之类），
  因此**不存在「调用 agy 子进程拿额度」的可行路径**。
- 额度真实来源是 Antigravity 内部接口：
  `POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`
  （响应结构 = `groups[].buckets[]`，含 `displayName / window / resetTime / remainingFraction`）。
- 该接口**必须携带 `User-Agent: antigravitycli/<version>`**，否则一律返回
  403 `SUBSCRIPTION_REQUIRED`（实测：缺 UA 403，带 UA 200）。
- 访问令牌来源（CLI 自己用的那份）：
  1. macOS Keychain：`security find-generic-password -s gemini -a antigravity -w`
     → 值形如 `go-keyring-base64:<base64(JSON)>`，JSON 为 `{token:{access_token,refresh_token,expiry},...}`；
  2. 文件 `~/.gemini/antigravity-cli/antigravity-oauth-token`（同结构，但 CLI 只在登录时写，通常已过期）；
  3. 两者都过期时，用 `refresh_token` 走 `https://oauth2.googleapis.com/token` 自刷新。

### 要做 (Goals)
1. 新增 `core/quota.ts`：取数 + 归一化 + TTL 缓存，**任何失败都不抛异常**（返回 `undefined`）。
2. 「🧠 模型选择与额度」卡片新增额度区块：按分组展示 `每周 / 5 小时` 剩余百分比、进度条与重置倒计时。
3. 服务启动时**预热**模型列表与额度缓存，并每 4 分钟后台刷新一次 ——
   因为 `agy models` 实测耗时 **3.7s**，已超过飞书卡片回调 3s 上限，冷路径必须避开。
4. 额度配置化（`agy.quota`），全部字段可选，缺省即可用；不新增任何 npm 依赖。

### 不做 (Non-Goals)
- 不实现 `/used` 的 TUI 等价物，不解析 TUI 输出。
- 不做逐模型（`retrieveUserQuota`）维度展示，只用分组汇总（与 `/used` 一致）。
- 不把额度写回 CLI 的 token 文件/Keychain（只读，避免干扰 CLI 自身状态）。
- 不在卡片上做额度告警/通知。

### 约束 (Guardrails)
- 分层：`core/quota.ts` 不依赖 `lark/`；`lark/` 单向依赖 `core/`。
- 向后兼容：`buildModelCard({quota})` 新增字段为可选，老调用方不受影响。
- 不新增依赖（用 Node 内置 `fetch` / `node:child_process`）。

---

## 2. 契约 (Contract)

### 2.1 类型（`core/types.ts`）
```ts
interface QuotaBucket { bucketId: string; displayName: string; window: string;
  resetTime?: string; description?: string; remainingFraction?: number }
interface QuotaGroup { displayName: string; description?: string; buckets: QuotaBucket[] }
interface QuotaSummary { groups: QuotaGroup[]; description?: string; fetchedAt: number }

interface QuotaConfig { enabled?: boolean; userAgent?: string; keychainService?: string;
  keychainAccount?: string; tokenPath?: string; timeoutMs?: number;
  oauthClientId?: string; oauthClientSecret?: string }
// BridgeConfig.agy.quota?: QuotaConfig
```

### 2.2 取数接口（`core/quota.ts`）
```ts
const DEFAULT_QUOTA_USER_AGENT = 'antigravitycli/1.2.14';
const QUOTA_CACHE_TTL_MS = 60_000;

/** 返回 undefined 表示取数失败/未开启，调用方降级展示。 */
export async function fetchQuotaSummary(opts?: QuotaConfig): Promise<QuotaSummary | undefined>;
export function getCachedQuota(): QuotaSummary | undefined;   // 同步读缓存，供 3s 热路径使用
export function clearQuotaCache(): void;                       // 测试/配置变更用
```
- 令牌解析顺序：Keychain → token 文件 → OAuth 自刷新；解析结果按 `expiry - 60s` 缓存。
- 请求：`POST v1internal:retrieveUserQuotaSummary`，body `{}`，头含 `Authorization` /
  `Content-Type` / `User-Agent`。
- 归一化：丢弃无 `displayName` 的分组与 bucket，`remainingFraction` 裁剪到 `[0,1]`。

### 2.3 卡片（`core`→`lark/cards.ts`）
```ts
buildModelCard({ currentModel?, models, sessionUsage?, quota?: QuotaSummary })
```
额度区块渲染规则：
- 有数据：`**📊 额度用量 (Quota)**` + 每个分组一行标题 + 每个 bucket 一行
  `• <窗口标签>  \`█████████░ 92%\` · 6天1小时后重置`；末尾附一句中文口径说明。
- 无数据：显示 `_暂不可用（未登录 Antigravity / 令牌过期 / 网络异常）_`，不影响卡片其余部分。
- 窗口标签：`weekly` → `每周`，`5h` → `5 小时`，其它取原值。
- 倒计时按 `resetTime`（UTC ISO）计算：`<1分钟` → `即将重置`；否则 `N天N小时/ N小时/ N分钟后重置`。

### 2.4 热路径与预热（`lark/client.ts` / `lark/card-actions.ts`）
- `CardActionContext` 新增 `quota?: QuotaConfig`。
- `model_card` / `switch_model` 用 `getCachedQuota() ?? await fetchQuotaSummary(cfg)`；
  模型列表用 `getCachedModels() ?? await fetchAvailableModels(...)`。
- `LarkBridgeService.start()` 末尾后台预热模型列表 + 额度，并 `setInterval(4min)` 刷新（`unref()`）。

### 2.5 HTTP 传输与代理（实测坑）
本机通过代理才能访问 Google（`http_proxy` / `https_proxy` / `all_proxy` = `http://127.0.0.1:7890`）。
- `curl` 会自动遵守这些环境变量 → 直提 200；
- Node 内置 `fetch`（undici）**默认不读代理环境变量** → 直接请求超时（实测 8s abort）。

因此 `httpPost()` 优先走系统 `curl`（`-sS -X POST ... --max-time N -w '\n__AGY_HTTP_STATUS__:%{http_code}'`，
用标记从 stdout 尾部取状态码，不依赖临时文件）；仅当系统无 curl 时才回退到 `fetch`。
若 curl 已执行但失败，不再回退，避免超时翻倍。

---

## 3. 验收标准 (Acceptance Criteria)

- [x] 单测：`normalizeQuotaSummary` 正确解析分组/bucket，裁剪越界 `remainingFraction`，丢弃脏数据。
- [x] 单测：`buildModelCard` 传入 `quota` 时渲染进度条与百分比；不传时显示「暂不可用」占位。
- [x] 单测：重置倒计时格式化（天/小时/分钟/即将重置）。
- [x] 单测：`fetchQuotaSummary` 在令牌不可用时返回 `undefined` 且不抛异常（离线可跑）。
- [x] `npm test` 全绿。
- [x] `npm run build` 通过，`dist/` 与 `src/` 一致。
- [x] 真机验证：卡片能显示与 CLI `/used` 一致的分组与剩余比例。

## 4. 变更清单 (Change List)

| 文件 | 变更 |
|---|---|
| `src/core/types.ts` | 新增 `QuotaBucket` / `QuotaGroup` / `QuotaSummary` / `QuotaConfig`；`BridgeConfig.agy.quota` |
| `src/core/quota.ts` | 新增：令牌解析（Keychain/文件/自刷新）+ 额度取数 + TTL 缓存 + 归一化 |
| `src/core/config.ts` | 解析 `agy.quota` 配置块 |
| `src/core/index.ts` | 导出 quota 模块 |
| `src/lark/cards.ts` | `buildModelCard` 新增额度区块（进度条 / 倒计时 / 降级占位） |
| `src/lark/card-actions.ts` | `model_card` / `switch_model` 附带额度数据 |
| `src/lark/client.ts` | 启动预热 + 每 4 分钟后台刷新额度与模型列表 |
| `config.example.json` | 补 `agy.quota` 示例（全可选） |
| `test/quota.test.ts`、`test/cards.test.ts` | 新增额度用例 |
| `dist/**` | `npm run build` 重新产出 |

## 5. 遗留 / 风险 (Out of Scope / Risks)

- `User-Agent: antigravitycli/<version>` 与 Keychain 的 `service/account` 名是**非公开约定**，
  官方升级后可能变化；两者都已做成配置项（`agy.quota.userAgent` / `keychainService` / `keychainAccount`）便于快速修正。
- 自刷新用的是 Antigravity/Gemini CLI 内置的**公开 OAuth 客户端凭据**（官方 CLI 开源仓库中即为公开值），
  同样可通过 `agy.quota.oauthClientId/oauthClientSecret` 覆盖；若官方轮换客户端，需同步更新。
- 非 macOS 平台无 `security` 命令，只能走 token 文件 + 自刷新。
