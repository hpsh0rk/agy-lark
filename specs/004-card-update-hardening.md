# 任务规格: 卡片共享更新加固 + 启动防「陈旧 dist」护栏

> 状态: Implemented
> 创建时间: 2026-09-30
> 对应模块: agy-lark (lark/cards, package.json)
> 关联任务: 「点击【查看指令帮助】【工作区项目绑定】【模型选择与额度】只弹提示、卡片不更新」复盘后的加固项

---

## 1. 背景 (Context)

spec `003` 已修复 `handleCardAction()` 的分支缺失与响应体结构。复盘线上现象后确认：
当时**真正生效的是内存里的旧代码**（服务进程 18:58 启动，修复 19:52 写入、dist 20:06 重建，
但重建不影响已运行的 Node 进程），因此现象与修复前一致。除「重启」这一操作项外，
本次补两项加固。

## 2. 要做 (Goals)

1. 所有卡片 `config` 补 `update_multi: true`，使卡片成为**共享卡片**：
   回调响应体里回传的卡片更新对所有收到该卡片的人可见，避免多端/多人看到不一致的面板。
   （飞书文档：`update_multi` 默认 `false`，即非共享卡片。）
2. `npm start` / `npm run lark` 增加 `pre` 钩子自动 `npm run build`，
   杜绝「改了 `src` 但 `dist` 陈旧、进程却仍在跑旧代码」这一类问题。

## 3. 不做 (Non-Goals)

- 不改动任何卡片的文案、结构与组件。
- 不迁移卡片 JSON 1.0 → 2.0（1.0 结构在新版回调的 `card.data` 中官方仍支持）。
- 不改动 `card-actions.ts` 的响应体结构（spec `003` 已与官方契约对齐，无需再动）。
- 不做进程守护 / 单实例锁（本轮只做人工重启 + 文档说明）。

## 4. 契约 (Contract)

### 4.1 卡片 config
```ts
config: { wide_screen_mode: true, update_multi: true }
```
覆盖 `buildHelpCard` / `buildBindCard` / `buildModelCard` / `buildStreamingCard` /
`buildStartupCard` / `buildShutdownCard` 共 6 处。

### 4.2 npm 脚本
```json
"prelark": "npm run build",
"prestart": "npm run build",
```
`npm start` 与 `npm run lark` 均先构建再启动，启动时间必晚于 `dist` 构建时间。

## 5. 验收标准 (Acceptance Criteria)

- [x] `src/lark/cards.ts` 中 6 处 `config` 均含 `update_multi: true`，`dist/lark/cards.js` 同步产出 6 处。
- [x] `npm run build` 通过（`tsc` 无错误）。
- [x] `npm test` 全绿（21/21）。
- [x] `package.json` 含 `prestart` / `prelark` 钩子。

## 6. 运维配套动作 (Operational Notes)

- 运行中的进程必须重启才会加载新代码：`pkill -f "bin/agy-lark.js"` 后重新 `npm start`。
- 必须保证**只有一个**实例持有飞书长连接；多实例会被飞书把回调事件随机分发到其中之一。
- `~/.agy-lark/sessions.json` 中形如 `feishu:dm:<chatId>:om_*` 的「影子会话」
  （由修复前的卡片回调写入）必须清理，否则 `findLatestByChatId()` 会优先命中影子会话，
  导致卡片切模型/项目写不到真实对话会话上。
