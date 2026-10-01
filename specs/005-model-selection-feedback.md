# 任务规格: 修复下拉选择（select_static）无反馈 + 卡片回调超时风险

> 状态: Implemented
> 创建时间: 2026-09-30
> 对应模块: agy-lark (lark/card-actions, core/models)
> 关联任务: 用户反馈「在模型面板里选完模型后界面没有任何提示，不知道成功还是失败；要么明确给出成功或失败的提示」

---

## 1. 现象与根因 (Root Cause)

### 现象
在「🧠 模型选择与额度」面板的下拉框里选中模型后，**界面毫无反应**：
下拉框显示已选中项，但「当前生效模型」不变、无 toast、`~/.agy-lark/sessions.json` 无任何写入。

### 根因（已用飞书官方回调示例核对）
飞书卡片不同交互组件的**回传位置不同**：

| 组件 | 自定义回传值位置 |
|---|---|
| `button` / `overflow` | `action.value` |
| `select_static` / `multi_select_static` | **`action.option`**（选中项的 `options[].value`） |

官方回调示例（下拉选择-单选）：

```json
"action": {
  "value": { "key_1": "value_1" },   // 仅当组件自身配置了 value / behaviors 时才有值
  "tag": "select_static",
  "option": "1"                       // 用户提交的选项的回传数据 = options[].value
}
```

`handleCardAction()` 只读 `data.action.value`，而模型/项目下拉组件没有配置组件级 `value`，
因此 `action.value` 为 `undefined`，直接命中开头的 `if (!actionValue)` 早退分支
（该分支在会话解析之前，所以 `sessions.json` 完全没有变化 —— 与现象完全吻合）。

**即：模型下拉、项目下拉两个入口此前都是坏的；只有按钮类入口能工作。**

### 次生风险
`switch_model` 分支内 `await fetchAvailableModels()` 会 spawn `agy models`。
飞书卡片回调**必须在 3 秒内响应，超时则整个响应（toast + card）被丢弃**。
一旦 `agy models` 慢于 3 秒，即使分支逻辑正确，用户也只会看到「毫无反馈」。

## 2. 要做 (Goals)

1. 回传值解析兼容 `action.value` 与 `action.option`（字符串 / 对象 / 空对象回退）。
2. 所有分支都给出**明确的成功 / 失败 / 提示**文案，不允许静默无响应。
3. `switch_model` / `switch_project` 增加参数缺失、会话缺失的显式失败提示。
4. 模型列表加 TTL 缓存，卡片回调热路径优先命中缓存，规避 3 秒超时。
5. 卡片回调全链路补日志（组件 tag、回传字段、action 名、耗时），便于线上定位。
6. 补自动化测试。

## 3. 不做 (Non-Goals)

- 不改卡片视觉结构与文案（`cards.ts` 仅上一轮加了 `update_multi`）。
- 不改 `card-actions` 的响应体结构（spec `003` 已对齐官方契约）。
- 不迁移卡片 JSON 1.0 → 2.0。
- 不引入「先回 `{}` + token 延时更新卡片」的异步方案（缓存已足够覆盖当前场景）。

## 4. 契约 (Contract)

### 4.1 回传值解析
```ts
pickActionPayload(action) → { payload, source: 'value' | 'option' } | undefined
```
- 依次尝试 `action.value` → `action.option`；
- 跳过 `undefined` / `null` / 空字符串 / 空对象；
- 仍取不到 → `{ toast: { type: 'error', content: '未收到可识别的卡片操作数据，请重试' } }`。

### 4.2 反馈文案（全部为 toast）
| action | toast |
|---|---|
| `help` | info「已展开指令帮助」 |
| `bind_card` | info「已展开项目工作区面板」 |
| `model_card` | info「已展开模型与额度面板」 |
| `switch_project` 成功 | success「已成功绑定并切换到项目: X」 |
| `switch_project` 缺别名 / 别名不存在 / 会话不存在 | error（各自明确文案） |
| `switch_model` 成功 | success「模型已切换为: X」 |
| `switch_model` 缺 modelId / 会话不存在 | error（各自明确文案） |
| 解析失败 / 无可识别数据 / 未预期异常 | error（各自明确文案） |
| 未识别 action | info「未识别的卡片操作: X」 |

### 4.3 模型缓存
```ts
MODEL_CACHE_TTL_MS = 5 * 60 * 1000
getCachedModels(): ModelInfo[] | undefined
clearModelCache(): void
fetchAvailableModels(binary?)  // 命中缓存直接返回，否则查询后写入缓存
```
`switch_model` 用 `getCachedModels() ?? await fetchAvailableModels(...)`。

## 5. 验收标准 (Acceptance Criteria)

- [x] 单测：`select_static`（回传值在 `action.option`）能正确切换模型并返回 success toast + 卡片。
- [x] 单测：`select_static` 能正确切换项目。
- [x] 单测：`action.value` 为空对象时回退到 `action.option`。
- [x] 单测：`switch_model` 缺 `modelId` 返回 error toast 且文案含「模型」。
- [x] 单测：`help` / `bind_card` / `model_card` 均同时返回 toast 与 card。
- [x] 单测：模型列表写入缓存并可同步读取。
- [x] `npm test` 全绿（27/27）。
- [x] `npm run build` 通过，`dist/` 与 `src/` 行为一致。

## 6. 变更清单 (Change List)

| 文件 | 变更 |
|---|---|
| `src/lark/card-actions.ts` | 新增 `pickActionPayload()`；拆分 `dispatchCardAction()`；全分支补 toast；参数/会话缺失显式失败；热路径用模型缓存；全链路日志 |
| `src/core/models.ts` | 新增 `MODEL_CACHE_TTL_MS` / `getCachedModels()` / `clearModelCache()`，`fetchAvailableModels()` 走 TTL 缓存 |
| `test/card-actions.test.ts` | 新增 5 条下拉/反馈用例 |
| `test/models.test.ts` | 新增缓存用例 |
| `dist/**` | `npm run build` 重新产出 |

## 7. 遗留 (Out of Scope)

- 卡片回调 3 秒上限下的极端场景（`agy models` 冷启动 > 3s）：本轮靠缓存规避；
  若未来仍偶发超时，再引入「先返回 `{}`，再用回调 `token` 延时更新卡片」方案。

---

## 8. 补充：第二轮根因 —— 按钮 `value` 传成了 JSON 字符串

### 现象
重启后再点击，提示「未识别的卡片操作（空）」，日志：

```
[agy-lark] 收到卡片操作 [(缺少 action 字段)] 组件=button 回传字段=value
```

### 根因
飞书官方「按钮」组件文档对 `value` 字段的说明：

> `value` | 否 | JSON | 该字段值**仅支持 key-value 形式的 JSON 结构**，且 key 为 String 类型。

而 `cards.ts` 里所有按钮写的是 `value: JSON.stringify({ action: 'help' })` —— **传的是字符串**。
飞书按「JSON 对象」约定规范化后，回调里拿不到 `action` 字段（字符串被再包一层或置空）。

**注意两种组件是相反的约定：**

| 组件 | 配置形式 | 回调位置 |
|---|---|---|
| `button` | **对象** `{ action: 'help' }` | `action.value` |
| `select_static` 的 `options[].value` | **字符串** `'{"action":"switch_model",...}'` | `action.option` |

### 修复
1. `cards.ts`：按钮 `value` 全部改为**对象**（启动卡 3 个 + 绑定卡新建/删除 2 个）；
   下拉 `options[].value` 保持字符串，并在文件头加约定注释。
2. `card-actions.ts` 回传解析加固：
   - 按组件 tag 选择优先字段（下拉优先 `option`，按钮优先 `value`）；
   - `normalizeActionPayload()` 最多解包 3 层（兼容双重编码的 JSON 字符串）；
   - `extractAction()` 支持 `{action:'x'}` / `{action:{action:'x'}}` / 纯字符串三种形态；
   - 日志打印**原始回传内容**（截断 200 字符），便于线上定字段。

### 追加验收
- [x] 单测：按钮 `value` 为对象可识别。
- [x] 单测：双重编码 JSON 字符串可自动解包。
- [x] 单测：回传对象缺 `action` 字段返回明确 error toast。
- [x] 单测：卡片构造层锁定约定 —— 按钮 `value` 必须是对象、下拉 `options[].value` 必须是字符串。
- [x] `npm test` 全绿（31/31）。
