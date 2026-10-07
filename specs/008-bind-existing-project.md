# 任务规格: /bind 指令支持关联已有项目目录

> 状态: Implemented
> 创建时间: 2026-10-01
> 对应模块: agy-lark (core/workspace, lark/dispatcher, lark/cards, lark/card-actions)
> 关联任务: 用户反馈「使用 /bind 怎么去关联新项目？现在好像只能新建项目，也就是新建一个文件夹，如何关联那个已有的文件夹？」

---

## 1. 范围与边界 (Scope & Guardrails)

### 背景与问题
1. 当前 `WorkspaceManager` 内部虽然实现了 `registerProject(name, path)`，但仅在单测中被调用。
2. 飞书消息分发层 `dispatcher.ts` 的 `/bind` 命令仅支持 `create`（在默认根目录新建空目录）和 `delete`（删除映射），缺少将外部已有文件夹注册为别名的交互指令。
3. `buildBindCard` 卡片仅提供「➕ 新建项目」与「🗑️ 删除项目别名」按钮，缺少关联已有目录的指引。

### 要做 (Goals)
1. **指令扩展**:
   - 支持 `/bind add <别名> <路径>` 及别名 `/bind link <别名> <路径>`。
   - 支持路径中的 `~` 自动展开为用户目录，支持绝对路径与相对路径解析。
   - 参数缺失时返回格式使用提示（如缺少参数给出用法卡片）。
   - 校验项目别名格式合法性（字母、数字、下划线、中划线和点）。
   - 校验物理路径是否存在，不存在时返回结构化错误卡片（带有修复提示）。
   - 成功关联后：更新 `workspace.json`、将会话工作区 `projectName` 与 `cwd` 切换至该项目、重置会话上下文（`conversationId = undefined`），并回复最新的工作区绑定卡片。
2. **卡片与交互增强**:
   - `buildBindCard` 卡片操作按钮区新增「🔗 关联已有项目」按钮（action: `prompt_add_project`）。
   - `handleCardAction` 增加 `prompt_add_project` 分支，弹出 toast 提示：`请直接回复: /bind add <项目别名> <已有目录路径>`。
   - `buildBindCard` 底部提示注明 `/bind add` 用法。
   - `buildHelpCard` 的 `/bind` 说明补充关联已有项目。
3. **测试与文档**:
   - 编写单元测试覆盖：`WorkspaceManager.registerProject` 别名合法性校验、路径存在性校验、覆盖别名行为；`prompt_add_project` 卡片交互；`dispatcher` 中 `/bind add` / `/bind link` 分支逻辑。
   - 同步更新 README.md 与 AGENT_RUNBOOK.md。

### 不做 (Non-Goals)
- 不在卡片中做复杂的原生输入框表单（受限于飞书旧版交互卡片规范，采用统一的回复指令交互风格）。
- 不破坏现有 `/bind create` 与 `/bind delete` 的使用习惯。

---

## 2. 契约 (Contract)

### 2.1 命令行语法契约
```text
/bind add <别名> <路径>
/bind link <别名> <路径>
```
示例：
- `/bind add my-web ~/project/my-web`
- `/bind add backend ~/code/backend`

参数校验：
- 参数不足（少于 2 个参数）时，返回 status 为 error 的卡片，文本提示：
  `用法: /bind add <项目别名> <已有目录路径>\n例如: /bind add my-web ~/project/my-web`
- 别名非法或目录不存在时，捕获 `BridgeError`，返回对应错误卡片。

### 2.2 卡片 Action 契约
- 新增 Action: `prompt_add_project`
- 响应:
  ```json
  {
    "toast": {
      "type": "info",
      "content": "请直接回复: /bind add <项目别名> <已有目录路径> (例如: /bind add my-web ~/project/my-web)"
    }
  }
  ```

---

## 3. 验收标准 (Acceptance Criteria)

- [x] AC1: `WorkspaceManager.registerProject(name, path)` 对非法 `name`（空或含特殊字符）抛出 `E_INVALID_WORKSPACE` 错误。
- [x] AC2: 在 `dispatcher.ts` 中输入 `/bind add <name> <path>` 或 `/bind link <name> <path>`，成功注册项目、更新会话 `cwd`/`projectName` 并重置 `conversationId`，返回最新的绑定卡片。
- [x] AC3: 目标路径不存在或别名不合法时，返回结构化错误卡片，不抛未捕获异常。
- [x] AC4: 参数缺失时输出清晰的语法提示卡片。
- [x] AC5: `buildBindCard` 增加「🔗 关联已有项目」按钮，点击返回指导输入指令的 toast。
- [x] AC6: `buildHelpCard`、`README.md`、`AGENT_RUNBOOK.md` 包含 `/bind add` 说明。
- [x] AC7: 所有单元测试与构建门禁通过 (`npm test`, `npm run build`)。
