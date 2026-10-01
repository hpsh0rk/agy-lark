# 任务规格: 修复启动卡按钮「只弹 toast、无卡片更新」的卡片回调缺陷

> 状态: Implemented
> 创建时间: 2026-09-30
> 对应模块: agy-lark (lark/card-actions, lark/client, core/sessions)
> 关联任务: 用户反馈「点击【查看指令帮助】【工作区项目绑定】【模型选择与额度】后只弹一个提示框，没有任何其他交互」

---

## 1. 范围与边界 (Scope & Guardrails)

### 现象 (Bug Report)
`buildStartupCard()` 底部的三个按钮回传的 action 值为 `help` / `bind_card` / `model_card`，
但 `handleCardAction()` 只实现了 `switch_project` / `prompt_create_project` /
`prompt_delete_project` / `switch_model`。三个按钮全部落到函数末尾的兜底分支：

```ts
return { toast: { type: 'info', content: '操作完成' } };
```

该兜底分支只返回 `toast`、不返回 `card`，所以飞书侧只弹一个提示框，卡片本身不更新、
也不会展开帮助/绑定/模型面板 —— 与用户描述完全一致。

### 要做 (Goals)
1. 在 `handleCardAction()` 中补齐 `help` / `bind_card` / `model_card` 三个分支，
   分别返回 `buildHelpCard()` / `buildBindCard()` / `buildModelCard()`。
2. 修正 `card.action.trigger` 回调的响应体结构：`card` 必须为
   `{ type: 'raw', data: <卡片 JSON> }`，而不是直接塞卡片对象。
3. 修正卡片回调的会话解析：卡片回调不携带 `thread_id`，不得拿 `open_message_id`
   当 `threadId` 去新建「影子会话」，否则切换的模型/项目落不到真正的对话会话上。
4. 为上述行为补自动化测试，并重新 `npm run build`（运行时加载的是 `dist/`）。

### 不做 (Non-Goals)
- 不改动任何卡片的视觉结构与文案（`cards.ts` 保持原样）。
- 不引入「卡片消息 ID → sessionKey」的显式映射表（用「按 chatId 复用最近活跃会话」即可覆盖当前场景）。
- 不改造 `/bind create`、`/bind delete` 需要用户手打命令的交互方式。
- 不升级卡片 JSON 1.0 → 2.0 结构。

### 约束 (Guardrails)
- 分层：只改 `lark/` 适配层与 `core/sessions.ts` 的只读查询方法，不反向依赖。
- 向后兼容：`switch_project` / `switch_model` 的行为与文案不变（仅响应体外壳与卡片结构对齐）。
- 不新增依赖。

---

## 2. 契约 (Contract)

### 2.1 回调事件字段来源
新版 `card.action.trigger`（长连接）经 SDK `RequestHandle.parse()` 解包后，处理器拿到的是
`{ ...header, ...event, [eventType] }`，即：

| 需要的字段 | 取值路径 | 备注 |
|---|---|---|
| 按钮回传值 | `data.action.value` | 字符串 JSON 或对象，两者都需兼容 |
| 会话 ID | `data.context.open_chat_id` | 新版；旧版平铺为 `data.open_chat_id` |
| 卡片消息 ID | `data.context.open_message_id` | 不参与 sessionKey 计算 |
| 会话类型 | 新版回调**不返回** | 只能通过已有会话反查，默认 `p2p` |

### 2.2 响应体结构（新版回调）
```ts
interface CardActionResponse {
  toast?: { type: 'info' | 'success' | 'error' | 'warning'; content: string };
  card?: { type: 'raw'; data: Record<string, unknown> };
}
```
- 只更新卡片时可不带 `toast`；只弹提示时不带 `card`。
- `card` 省略 `type/data` 包裹层会被飞书判定为非法卡片（错误码 200673），卡片更新被静默丢弃。

### 2.3 会话解析
```ts
session = sessions.findLatestByChatId(chatId)
        ?? sessions.getOrCreate({ chatId, chatType, defaultCwd })
```
- 新增 `SessionStore.findLatestByChatId(chatId: string): SessionEntry | undefined`，
  返回该 chat 下 `lastActive` 最大的会话。
- 兜底创建时**不传** `threadId`，使其 key 与消息路径一致（p2p: `feishu:dm:<chatId>`）。

### 2.4 `CardActionContext` 新增字段
```ts
defaultModel?: string; // 来自 config.agy.defaultModel，用于 /model 卡片的兜底当前模型
```

---

## 3. 验收标准 (Acceptance Criteria)

- [x] 单测：`help` / `bind_card` / `model_card` 三个 action 均返回非空 `card`，且 `card.type === 'raw'`、`card.data.elements` 为数组。
- [x] 单测：`card.data` 中的 `select_static` / `switch_model` 等交互组件仍存在（面板确实展开）。
- [x] 单测：卡片操作复用消息会话 —— 先经消息路径建会话，再触发 `switch_model`，断言模型写在**同一个** `sessionKey` 上，且 `sessions.listAll().length` 不增加。
- [x] 单测：`switch_project` 返回成功 toast + 更新后的绑定卡片；不存在的别名返回 error toast 且无 `card`。
- [x] 未知 action 仍返回兜底 toast，不抛异常。
- [x] `npm test` 全绿（21/21，含原有 15 条用例）。
- [x] `npm run build` 通过，`dist/lark/card-actions.js` 与 `src/` 行为一致。

---

## 4. 变更清单 (Change List)

| 文件 | 变更 |
|---|---|
| `src/lark/card-actions.ts` | 新增 `respond()` 响应体构造器；补齐 `help`/`bind_card`/`model_card` 分支；会话改为按 chatId 复用；返回类型改为 `CardActionResponse` |
| `src/core/sessions.ts` | 新增 `findLatestByChatId()` |
| `src/lark/client.ts` | 传入 `defaultModel` 到 `CardActionContext` |
| `test/card-actions.test.ts` | 新增卡片回调行为测试 |
| `dist/**` | `npm run build` 重新产出 |

---

## 5. 遗留阻塞项 (Blocked / Out of Scope)

- **群聊内的卡片回调无法可靠判定 chatType**：新版回调不返回 `open_chat_type`，
  只能靠 `findLatestByChatId()` 反查已有会话。若群内尚无任何会话记录（例如机器人刚被拉群
  且用户直接点启动卡），会退化为 `p2p` 语义建一个 `feishu:group:<chatId>:main` 会话。
  彻底修复需要显式维护「卡片消息 ID → sessionKey」映射，或在回调里调 `im.chat.get` 换取 chatType。
- **卡片 JSON 仍是 1.0 结构**（`config`/`elements`），而 `specs/001` 的 Case 5 写的是
  「符合 CardKit 2.0 规范」。飞书对 1.0 结构仍兼容，本次不迁移。
