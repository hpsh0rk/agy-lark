# agy-lark 飞书与 Antigravity CLI (agy) 桥接网关

将 Google 官方 AI 编程智能体 **Antigravity CLI (`agy`)** 无缝接入 **飞书 / Lark**。

支持 **WebSocket 长连接（零公网暴露/免域名）**、**Thread 级话题多轮会话强隔离**、**飞书交互式卡片流式打字机**、**多项目工作区快速绑定切换**、**多模型动态切换与 Token 额度统计**，以及 **生成图片自动收割与高清嵌入**。

```
┌─────────────────────────────────────────────────────────────┐
│                       飞书客户端 (Lark)                      │
└──────────────────────────────┬──────────────────────────────┘
                               │  WebSocket 长连接 (免公网 IP)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    agy-lark 飞书适配服务                     │
│                                                             │
│   • 飞书 WebSocket 长连接与事件调度                         │
│   • Thread 级会话强隔离 (群聊自动回复在话题中)              │
│   • 飞书交互式卡片流式打字机更新 (Card Streaming)           │
│   • 卡片交互回调处理 (/bind 下拉/新建/删除, /model 切换)   │
│   • 图片自动上传飞书 OpenAPI 并渲染 img 卡片                │
└──────────────────────────────┬──────────────────────────────┘
                               │ Programmatic API
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                  agy-core 核心与 CLI 管理器                  │
│                                                             │
│   • AgyProcessRunner: 驱动 agy 进程、stream-json 流式解析   │
│   • WorkspaceManager: 项目别名注册表、目录绑定、新建/删除    │
│   • SessionStore: Thread ↔ agy conversation_id 持久化映射   │
│   • ImageHarvester: 监控脑区/临时目录，自动收割生成图片产物 │
│   • Models & Quota: 动态获取可用模型列表与 Token 统计       │
│   • PiRunner & AgyRunner: 统一驱动 agy 与 pi 双智能体执行   │
│   • TaskManager: 后台异步长任务生命周期与精准调度控制       │
└──────────────────────────────┬──────────────────────────────┘
                               │ spawn (stream-json / ndjson)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│             执行引擎：Antigravity CLI (agy) / Pi            │
└─────────────────────────────────────────────────────────────┘
```

---

## 核心特性

1. **双执行引擎驱动 (Dual-Engine Execution)**:
   - **`agy` (Antigravity CLI)**: 深度集成 Google DeepMind CLI，支持 Gemini 3.8 / Claude 4.6 / GPT 模型体系与 Google Cloud 额度监控，具备自主工具闭环与多轮续聊能力。
   - **`pi` (Pi Coding Agent)**: 轻量高速编程智能体，原生支持第三方 OpenAI 兼容 API、本地模型网关（如 `localhost:7863`）与多模型推理。
   - **`/engine` 交互式卡片一键切换**: 飞书 Card 2.0 按钮切换当前会话引擎，自动执行跨引擎模型纠偏与隔离机制（`resolveModelForEngine`，见 `src/core/models.ts`），彻底杜绝跨引擎模型配置污染。
2. **多轮对话与 Thread 强隔离**:
   - **私聊**: 单聊 `chat_id` 维护主会话上下文。
   - **群聊**: 机器人一律在话题（Thread）中流式回复（`reply_in_thread: true`），同一个 Thread 内所有成员的追问共享同一会话上下文，不同 Thread 绝不串台，大群主屏永不刷屏。
3. **后台异步长任务管理 (`/tasks`)**:
   - **不限时执行保障**: 支持运行数小时的超长研发任务（`timeoutMs: 0`），后台稳定承载，彻底告别超时强杀。
   - **可视化任务看板**: 发送 `/tasks` 即可查看所有正在运行的后台长任务、耗时统计与关联项目。
   - **精准任务熔断**: 支持在卡片中一键中止特定任务，或在聊天中发送 `/stop [taskId]` 中止执行。
4. **多模态图文混排与产物收割**:
   - **多模态输入支持**: 飞书发送纯图片或富文本图文混排（`post` 类型）时，自动下载至沙箱环境，`agy` 结合工具查看，`pi` 原生通过 `@image` 多模态输入无缝解析。
   - **产物自动收割**: 自动监控收割智能体在脑区或工作区生成的图片产物，上传飞书素材库并以高清原生 `img` 组件渲染展示。
5. **交互式飞书 Card 2.0 指令**:
   - `/engine`: 弹出引擎管理面板，按钮一键在 `agy` 与 `pi` 之间秒级切换。
   - `/bind`: 弹出交互卡片，支持下拉切换已有项目、回复 `/bind add <别名> <路径>` 关联已有物理目录、一键新建项目（`/bind create`）、安全删除映射（`/bind delete`）。
   - `/model`: 动态展示当前引擎适配的所有大模型，支持下拉一键切换并展示当前会话 Token 消耗。`agy` 引擎下还会实时展示 Google Cloud 每周与 5 小时双配额进度条。
   - `/tasks`: 展开后台异步长任务控制看板。
   - `/new` / `/reset`: 清空当前 Thread 的上下文记忆，开启新轮次。
   - `/pwd` / `/cd`: 查看和临时切换物理工作目录。
   - `/config`: 查看与修改全局配置（例如默认新建项目目录、默认引擎）。
   - `/status`: 实时查看当前任务活跃状态、耗时与累计用量。
   - `/stop`: 紧急中止当前会话正在执行的任务。
   - `/help`: 弹出图文并茂的使用指引卡片。
6. **YOLO 模式执行**:
   - 默认启用 `--dangerously-skip-permissions`，工具调用全程自主闭环，避免非交互终端挂死。
   - ⚠️ **风险提示**: YOLO 模式意味着智能体可以在你的机器上**无确认执行任意命令**。机器人一旦被添加到群聊或被陌生人私聊，等同于把本机 shell 交给了对方。请务必启用 **访问控制白名单**（见下方 `accessControl` 配置）将可用范围收敛到自己的 open_id / 指定群聊。
7. **访问控制白名单 (`accessControl`)**:
   - 在 `config.json` 中配置允许的用户 `open_id` 与群聊 `chat_id` 白名单，白名单外的消息与卡片交互一律**静默忽略**（fail-closed）。
   - 白名单外的 open_id 会被记录到服务日志，方便管理员按需加白。

---

## 快速开始

> 💡 **针对 AI Agent / 自动化运维**：请查阅专门的 [AGENT_RUNBOOK.md](./AGENT_RUNBOOK.md) 获取零歧义调通与验收操作规程。

### 1. 安装依赖、构建与环境自检

```bash
cd agy-lark
npm install
npm run build

# 一键运行运行环境与飞书凭据自检 (Pre-flight Check)
npm run verify

# 启用 pre-commit 密钥扫描防线（防止真实凭据误入 git 历史）
npm run hooks
```

### 2. 飞书开放平台配置（3 分钟完成）

1. 登录 [飞书开放平台](https://open.feishu.cn/)，创建“企业自建应用”；
2. 进入 **凭证与基础信息**，获取 `App ID` 和 `App Secret`；
3. 进入 **添加应用能力** -> 开启 **机器人** 能力；
4. 进入 **权限管理**，开通以下权限：
   - `im:message`（获取与发送单聊/群聊消息）
   - `im:resource`（上传与下载图片资源）
5. 进入 **事件与回调**：
   - 订阅方式选择：**使用长连接接收事件 (WebSocket)**（无需配置公网域名和内网穿透！）
   - 添加事件：`im.message.receive_v1`（接收消息）
   - 添加回调：`card.action.trigger`（卡片交互回调）
6. 进入 **版本管理与发布**，发布一个可用版本。

### 3. 配置与启动

复制配置模板：
```bash
cp config.example.json config.json
```
修改 `config.json`（已做好敏感信息隔离，`config.json` 默认被 `.gitignore` 忽略）：
```json
{
  "lark": {
    "appId": "cli_xxxxxxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  },
  "workspace": {
    "defaultRoot": "~/project",
    "projects": {
      "agy-lark": "~/project/agy-lark"
    }
  },
  "engine": "agy",
  "pi": {
    "binary": "pi",
    "provider": "",
    "defaultModel": "",
    "thinking": "high",
    "timeoutMs": 0
  },
  "agy": {
    "binary": "agy",
    "defaultModel": "",
    "effort": "high",
    "timeoutMs": 0,
    "quota": {
      "enabled": true
    }
  },
  "accessControl": {
    "enabled": true,
    "allowUsers": ["ou_your_open_id"],
    "allowChats": [],
    "notifyDenied": false
  }
}
```

> 🛡 **强烈建议启用 `accessControl`**：把 `allowUsers` 设为你自己的 open_id（首次启动后向机器人发条消息，服务日志会打印访客的 open_id），避免机器人被拉群后任何人都能驱动你的本机执行引擎。

启动飞书桥接服务：
```bash
npm start
```
服务成功输出 `[agy-lark] 飞书服务启动成功！已监听消息与卡片交互事件。` 后，即可直接在飞书向机器人发消息或在群里 @机器人！

### 4. 出网代理（可选；launchd / 开机自启必需）

`agy` 是 Go 二进制，只认 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 环境变量，不读
macOS 系统代理设置；额度取数用的 `curl` 同理。从交互式 shell 启动时这些变量通常已由
代理客户端注入，但 **launchd 拉起的进程没有它们**（知识库面板的启动指令页就是这种情形），
表现为 `agy` 卡在连 Google 的 `SYN_SENT` 上直到超时。

把代理写进 `config.json` 即可，服务启动时只在变量缺失时填补、不覆盖 shell 里已有的值：

```json
  "proxy": {
    "http": "http://127.0.0.1:7890",
    "https": "http://127.0.0.1:7890",
    "no": "127.0.0.1,localhost,::1"
  }
```

启动横幅会打印实际写入的变量名（`• 出网代理: HTTP_PROXY, HTTPS_PROXY, NO_PROXY`）；
没有这行就说明 shell 里已经设过、这次没有覆盖。

---

## 本地 CLI 管理器 (`agy-core`)

你也可以脱离飞书，在本地终端直接使用 `agy-core` 命令测试与管理工作区：

```bash
# 查看支持的模型列表
npm run core models

# 查看当前实时配额与剩余比例进度条
npm run core quota

# 以标准 JSON 输出配额（供 Python、外部脚本或 webui 调用）
npm run core quota -- --json

# 查看已注册项目与默认根目录
npm run core projects list

# 注册已有项目别名
npm run core projects add my-web ~/project/my-web

# 一键新建项目 (自动在 defaultRoot 下创建目录)
npm run core projects create demo-api

# 在本地直接运行一次 agy 并流式输出
npm run core run "帮我分析一下当前目录的 package.json"
```

---

## 运行测试

本工程内置完整的单元测试与端到端实测验证套件：

```bash
npm test
```
覆盖项包括：
- `WorkspaceManager` 别名映射与新建/删除生命周期测试
- `models` 动态抓取与解析本地真实 `agy models` 输出测试
- `sessions` 会话路由隔离与 Thread 映射测试
- `cards` 飞书 CardKit 2.0 规范兼容测试
- `runner` 本地真实 `agy` 单轮与多轮续聊端到端集成测试
