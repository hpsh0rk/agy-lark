# 任务规格: agy-lark 飞书与 Antigravity CLI (agy) 双向桥接服务

> 状态: Approved
> 创建时间: 2026-09-30 14:40
> 对应模块: agy-core & agy-lark

---

## 1. 范围与边界 (Scope & Guardrails)

### 要做 (Goals)
1. **分层架构设计**:
   - `agy-core`: 统一的 agy 进程驱动器、`stream-json` NDJSON 事件解析、项目工作区管理器、会话存储器（`SessionStore`）、图片产物收割器（`ImageHarvester`）。
   - `agy-lark`: 飞书 WebSocket 长连接接入层、Thread 级会话隔离与路由、流式卡片渲染（Card Streaming）、交互式卡片回调（`/bind`、`/model`、`/help` 等）、飞书图片上传。
2. **多轮对话与 Thread 强隔离**:
   - 私聊模式：按单聊 `chat_id` 维护主会话上下文。
   - 群聊模式：Bot 一律在话题（Thread）中回复（`reply_in_thread: true`），同一个 Thread 内所有成员的追问共享同一个 `agy` 会话（`--conversation <id>`）。不同 Thread 强隔离。
3. **YOLO 权限执行**:
   - 默认挂载 `--dangerously-skip-permissions`，让 `agy` 自动执行工具调用，避免非交互终端挂死。
4. **图片生成（Vision/Image）原生适配**:
   - 监听并收割 `~/.gemini/antigravity-cli/brain/<conv_id>` 与 `scratch` 下生成的图片文件。
   - 通过飞书 OpenAPI (`im/v1/images`) 上传获得 `image_key`，在卡片中以 `img` 原生组件高清预览展示。
5. **飞书交互式卡片指令系统**:
   - `/bind`: 弹出交互卡片，支持 `select_static` 切换项目、新建项目（默认在 `~/project`）、删除项目别名（带原生 confirm 二次确认）。
   - `/model`: 自动读取 `agy models` 支持的全部模型列表，以卡片下拉/单选方式供用户切换，并展示 Token 消耗与额度统计。
   - `/help`: 展示结构化使用指南卡片。
   - `/new` / `/reset` / `/pwd` / `/cd` / `/config` / `/status` / `/stop` 完整运维闭环。

### 不做 (Non-Goals)
- 不做任何独立 Web 前端 UI（一切交互以飞书原生 CardKit 与 CLI 为唯一界面）。
- 不引入外部云中转（纯本地回环与飞书长连接通信）。

### 架构红线 (Constraints)
- 遵循 DDD 四层分层与单向依赖：飞书接入逻辑（Interface）依赖编排层，编排层依赖核心领域实体与驱动（Domain/Infra），禁止反向耦合。
- 零静默失败：所有错误必须携带结构化 code 与用户友好提示（hint）。
- 进程安全清理：任务超时或被 `/stop` 时，必须使用 `killProcessTree` 彻底清理进程组，禁止留存僵尸进程。

---

## 2. 接口与数据契约 (Contract)

### 2.1 核心配置契约 (`config.json` / `config.yaml`)
```json
{
  "lark": {
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "verificationToken": "xxx",
    "encryptKey": ""
  },
  "workspace": {
    "defaultRoot": "~/project",
    "projects": {
      "agy-lark": "~/project/agy-lark",
      "my-project": "~/project/my-project"
    }
  },
  "agy": {
    "binary": "agy",
    "defaultModel": "",
    "effort": "high",
    "timeoutMs": 600000
  }
}
```

### 2.2 会话路由键契约 (`session_key`)
- 私聊：`feishu:dm:<chat_id>`
- 群聊 Thread：`feishu:group:<chat_id>:<thread_id>`
- 每个会话实体保存：
  - `sessionKey`: 路由唯一标识
  - `conversationId`: agy 的 UUID（用于 `--conversation <id>` 续聊）
  - `cwd`: 当前绑定的本地物理目录
  - `model`: 当前指定的模型覆盖（可选）
  - `lastActive`: 最后活动时间戳

### 2.3 `AgyRunner` 流式回调接口契约
```ts
interface AgyRunOptions {
  prompt: string;
  cwd: string;
  conversationId?: string;
  model?: string;
  effort?: string;
  signal?: AbortSignal;
  onInit?: (info: { conversationId: string; tools: string[] }) => void;
  onDelta?: (text: string) => void;
  onStep?: (step: { index: number; type: string; state: string }) => void;
  onImage?: (imagePaths: string[]) => void;
  onResult?: (result: { response: string; usage: AgyUsage; durationSeconds: number }) => void;
}
```

---

## 3. 验收标准与测试用例 (Acceptance Criteria)

- [ ] **Case 1 (agy-core 进程与事件流验证)**:
  - 启动 `agy --output-format stream-json -p "..."`，准确捕获 `init` 的 `conversation_id`，正确触发 `onDelta` 增量，最终返回结构化 usage。
- [ ] **Case 2 (项目工作区管理验证)**:
  - 项目别名增加、查询、删除、新建目录及路径校验，单元测试全部通过。
- [ ] **Case 3 (多轮会话恢复验证)**:
  - 第二轮对话带上 `--conversation <id>`，确认上下文被保留，KV cache 命中。
- [ ] **Case 4 (模型列表与 `/model` 提取验证)**:
  - 动态解析 `agy models` 输出，提取所有模型 ID 与 Display Name，生成合法飞书卡片。
- [ ] **Case 5 (飞书卡片结构契约校验)**:
  - `/bind`、`/model`、`/help` 卡片 JSON 符合飞书 CardKit 2.0 规范，按钮与 action value 正确序列化。
- [ ] **Case 6 (图片收割与上传模拟)**:
  - 模拟出图场景，`ImageHarvester` 成功在指定脑区/临时目录捕获新增文件并上报。
