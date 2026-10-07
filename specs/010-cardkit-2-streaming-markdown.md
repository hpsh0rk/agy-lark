# 任务规格: 升级 buildStreamingCard 至飞书卡片 2.0 (支持完整 Markdown 解析)

> 状态: Implemented
> 创建时间: 2026-10-02
> 对应模块: agy-lark (lark/cards, test/cards)
> 关联反馈: 用户反馈「返回的卡片没有解析 markdown（如 ### 标题、--- 分割线等显示为纯文本），飞书卡片支持解析吗？支持的话改造一下」

---

## 1. 范围与边界 (Scope & Guardrails)

### 背景与根本原因
1. 当前 `buildStreamingCard` 生成的是飞书卡片规范 1.0 (Card JSON 1.0) 结构：顶层没有声明 `schema: "2.0"`，且组件数组平铺在顶层 `elements` 中。
2. 飞书卡片 1.0 的 Markdown 引擎为早期精简子集，**不支持** 标题（`#` 至 `######`）、水平分割线（`---`）、引用块等语法，导致大模型返回的标准 Markdown 格式在飞书客户端中退化为原始符号纯文本展示。
3. 飞书卡片规范 2.0 (Card JSON 2.0) 完整支持标准 GitHub Flavored Markdown (GFM)，包括各级标题、分割线、代码块及富文本着色。

### 要做 (Goals)
1. **升级卡片结构至 Card JSON 2.0**:
   - `buildStreamingCard` 顶层增加 `"schema": "2.0"` 声明。
   - 内容组件由顶层 `elements` 迁移至标准 `"body": { "elements": [...] }` 结构。
   - 保留 `"config": { "update_multi": true }`。
   - 保留头部色彩模板和标题结构 (`"header": { "template": templateColor, "title": { "tag": "plain_text", "content": titleText } }`)。
2. **替换 2.0 废弃组件**:
   - 移除卡片底部已废弃的 `"tag": "note"` 组件（2.0 中使用会触发 200861 unsupported tag 错误）。
   - 底部元信息（项目、模型、耗时）转为合规的富文本展示：`{ "tag": "markdown", "content": "<font color=\"grey\">...</font>" }`。
3. **测试验证**:
   - 在 `test/cards.test.ts` 中增加对 `buildStreamingCard` 输出 `schema: "2.0"`、`body.elements` 结构及无 `note` 标签的断言。
   - 确保全套测试 `npm test` 与编译 `npm run build` 全部绿灯。

### 不做 (Non-Goals)
- 不改动其他带交互（select_static / button）的配置面板卡片（如 `buildBindCard`、`buildModelCard`），避免影响回调解析。
- 不引入重型第三方 Markdown AST 解析器或额外依赖，仅规范化飞书原生卡片 JSON 结构。

---

## 2. 契约 (Contract)

### 2.1 卡片输出契约
`buildStreamingCard` 返回的对象格式：
```json
{
  "schema": "2.0",
  "config": {
    "update_multi": true
  },
  "header": {
    "template": "blue" | "green" | "red",
    "title": {
      "tag": "plain_text",
      "content": "..."
    }
  },
  "body": {
    "elements": [
      {
        "tag": "markdown",
        "content": "<Markdown文本，支持 ### 标题、--- 等>"
      },
      ...
    ]
  }
}
```

---

## 3. 验收标准 (Acceptance Criteria)

- [x] AC1: `buildStreamingCard` 生成的卡片包含 `"schema": "2.0"`，且包含 `"body": { "elements": [...] }`。
- [x] AC2: `buildStreamingCard` 的 `body.elements` 中不包含已被 2.0 废弃的 `"tag": "note"` 组件，元信息通过 `<font color="grey">` 渲染。
- [x] AC3: 状态（running / done / error）、图片嵌入（img_key）、错误详情提示均保持原有逻辑并在 2.0 容器内正常输出。
- [x] AC4: 单元测试覆盖率达标，`npm test` 与 `npm run build` 通过。
