# 任务规格: 飞书机器人配置改为「仅配置文件」加载

> 状态: Implemented
> 创建时间: 2026-09-30
> 对应模块: agy-core (config)
> 关联任务: 用户要求「飞书机器人的配置只能从配置里面读取，移除从环境变量读取的逻辑」

---

## 1. 范围与边界 (Scope & Guardrails)

### 要做 (Goals)
1. `src/core/config.ts` 的 `loadBridgeConfig()` **不再读取任何环境变量**。
2. 删除以下环境变量的读取逻辑（全部）：
   - 飞书凭据：`LARK_APP_ID`、`LARK_APP_SECRET`、`LARK_VERIFICATION_TOKEN`、`LARK_ENCRYPT_KEY`、`LARK_NOTIFY_RECEIVE_ID`、`LARK_NOTIFY_RECEIVE_ID_TYPE`
   - 工作区：`AGY_DEFAULT_ROOT`
   - agy：`AGY_BIN`、`AGY_MODEL`、`AGY_EFFORT`
   - 配置路径：`AGY_LARK_CONFIG`
3. 新增 `resolveConfigPath()`，用于在缺配置时报出「查了哪些路径」的可诊断信息。
4. 同步 `bin/agy-lark.js`、`bin/verify.js` 的提示文案与 env 读取。
5. 同步 `AGENT_RUNBOOK.md`、`README.md` 中关于环境变量的文档描述。

### 不做 (Non-Goals)
- 不引入多机器人 / profiles 结构，保持现有单 `lark` 配置块。
- 不改变 `BridgeConfig` 的字段与类型定义。
- 不改变配置文件查找优先级语义（仍为「命中即止」）。
- 不通过 API 创建飞书自建应用（飞书未开放该接口，见第 5 节）。

### 约束 (Guardrails)
- 分层：只改 `core` 层的配置加载，不触碰 `lark/` 适配层。
- 向后兼容：已有 `config.json` 无需任何改动即可继续工作。
- 不新增依赖。

---

## 2. 契约 (Contract)

### 2.1 配置文件查找顺序（命中即止）
1. `loadBridgeConfig(customPath)` 显式传入路径
2. `process.cwd()/config.json`
3. `~/.agy-lark/config.json`

（原先第 2 位的 `AGY_LARK_CONFIG` 已移除，环境变量不再参与路径解析。）

### 2.2 新增导出
```ts
export function resolveConfigPath(customPath?: string): string | undefined;
```
返回第一个**存在**的候选路径；全部不存在时返回 `undefined`。

### 2.3 `loadBridgeConfig()` 返回值
签名不变：`(customPath?: string) => BridgeConfig`。字段取值来源与默认值：

| 字段 | 来源 | 默认值 |
|---|---|---|
| `lark.appId` | `config.lark.appId` | `''` |
| `lark.appSecret` | `config.lark.appSecret` | `''` |
| `lark.verificationToken` | `config.lark.verificationToken` | `''` |
| `lark.encryptKey` | `config.lark.encryptKey` | `''` |
| `lark.notifyReceiveId` | `config.lark.notifyReceiveId` | `''` |
| `lark.notifyReceiveIdType` | `config.lark.notifyReceiveIdType` | `'open_id'` |
| `workspace.defaultRoot` | `config.workspace.defaultRoot` | `~/project` |
| `workspace.projects` | `config.workspace.projects` | `{}` |
| `agy.binary` | `config.agy.binary` | `'agy'` |
| `agy.defaultModel` | `config.agy.defaultModel` | `''` |
| `agy.effort` | `config.agy.effort` | `'high'` |
| `agy.timeoutMs` | `config.agy.timeoutMs` | `600000` |

### 2.4 错误处理
- 候选路径中某个文件存在但 JSON 解析失败 → 跳过该文件，继续尝试下一个候选路径（保持原行为）。
- 全部候选路径都不可用时 → 返回全默认值的 `BridgeConfig`，由调用方（`bin/agy-lark.js`）判定并报错退出。

---

## 3. 验收标准 (Acceptance Criteria)

- [x] `grep -rn "process.env" src/` 在 `config.ts` 中零命中。
- [x] 设置 `LARK_APP_ID` / `LARK_APP_SECRET` / `AGY_BIN` 等环境变量后调用 `loadBridgeConfig()`，返回值**完全不受影响**。
- [x] 仅靠 `config.json` 中的 `lark.appId` / `lark.appSecret` 能正常加载凭据。
- [x] `npm run build` 通过，`npm test` 全绿（15/15）。
- [x] `npm run verify` 能读到 `config.json` 的凭据并完成飞书 token / bot info 自检。
- [x] 删除 `config.json` 后启动 `npm run lark`，报错文案只提示「写 config.json」，不再提示 `export LARK_APP_ID`。
- [x] `AGENT_RUNBOOK.md` 第 3.1 节的加载优先级描述与实际代码一致。

---

## 4. 变更清单 (Change List)

| 文件 | 变更 |
|---|---|
| `src/core/config.ts` | 移除全部 `process.env` 读取；新增 `resolveConfigPath()` |
| `bin/agy-lark.js` | 缺凭据时的报错文案去掉「设置环境变量」分支，改为提示 `resolveConfigPath()` 查找路径 |
| `bin/verify.js` | `ANTIGRAVITY_AGENTAPI_EXE` 改为读取 `config.agy.binary`；文案去掉环境变量提示 |
| `AGENT_RUNBOOK.md` | §3.1 加载优先级改为 3 条（无 env） |
| `README.md` | 同步配置说明 |

---

## 5. 遗留阻塞项 (Blocked / Out of Scope)

**「创建一个新的飞书机器人」无法通过 API 完成，本规格不覆盖。**

调研结论：
1. 飞书开放平台「应用」模块公开接口只有：获取应用信息、获取应用版本列表/信息、查看待审核的应用列表、更新应用审核状态、更新应用分组信息 —— **没有「创建应用」接口**。
2. `POST /open-apis/application/v6/applications` 路径确实存在（实测返回 `field validation failed` 而非 404），但官方文档返回 `403 This document is not public`，属开发者后台内部接口。
3. 官方文档明确要求：「在[开发者后台](https://open.feishu.cn/app)，创建自建应用」。
4. lark-cli 无 `bot` / `application` 域；`lark-cli apps +create` 创建的是**妙搭（Miaoda）应用**，产出妙搭 `app_id`，不是飞书开放平台的 `cli_xxx` + `app_secret`，且需要 user 身份（当前 user token 已过期）。

**待办**：由用户在开发者后台创建自建应用并开启机器人能力后，把 `App ID` / `App Secret` 填入 `config.json` 的 `lark` 块。
