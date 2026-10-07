# AGENT_RUNBOOK: agy-lark 接入与全流程调通指南

> **面向对象**：AI 研发 Agent / 自动化运维流水线 / 接入开发者  
> **目标**：以零歧义、自验证、端到端闭环的方式，指导 Agent 或开发者完成飞书自建应用对接 Antigravity CLI (`agy`) 的配置、调通与生产验证。

---

## 1. 核心架构与设计契约 (Mental Model)

```
┌────────────────────────────────────────────────────────┐
│                      飞书客户端 (Lark)                  │
│       [单聊私聊]           [群聊话题 Thread]            │
│  - 纯文本 / 斜杠指令        - reply_in_thread: true    │
│  - 动态卡片交互             - 话题上下文独立隔离        │
└────────────────────────▲───────────────────────────────┘
                         │ WebSocket 长连接 (无需公网IP/内网穿透)
┌────────────────────────▼───────────────────────────────┐
│                  agy-lark 桥接网关服务                  │
│  - Dispatcher: 消息事件路由 (im.message.receive_v1)     │
│  - CardActions: 卡片交互回调 (card.action.trigger)      │
│  - ImageHarvester: 产物图片侦测 & 飞书素材库上传         │
│  - Throttled Card Streaming: 打字机流式更新             │
└────────────────────────▲───────────────────────────────┘
                         │ 本地 IPC / 状态共享
┌────────────────────────▼───────────────────────────────┐
│                   agy-core 调度引擎                     │
│  - SessionStore: 路由键会话隔离 (Thread / Chat)        │
│  - WorkspaceManager: 项目路径映射 (~/project)           │
│  - Runner: agy --output-format stream-json (YOLO 模式) │
└────────────────────────▲───────────────────────────────┘
                         │ 子进程调用 (流式 JSON 解析)
┌────────────────────────▼───────────────────────────────┐
│               Antigravity CLI (agy 本地程序)           │
│  - --dangerously-skip-permissions (免交互确认)         │
│  - --conversation <id> (多轮会话恢复)                  │
│  - brain/<conv_id>/ (图片产物持久化目录)               │
└────────────────────────────────────────────────────────┘
```

### 关键设计契约
1. **Thread 级别隔离 (群聊模式)**：
   - 群聊中机器人的回复一律携带 `reply_in_thread: true`；
   - 话题内所有追问共享同一个 `conversation_id` 与绑定工作区；
   - 不同 Thread 互不干扰，禁止在群主时间线刷屏。
2. **YOLO 模式执行**：
   - 调度 `agy` 时始终携带 `--dangerously-skip-permissions`，工具执行全程自主闭环，无需人工在终端按回车确认。
3. **产物图片主动捕获**：
   - 监听 `~/.gemini/antigravity-cli/brain/<conv_id>/` 与工作区 `scratch/`；
   - 文件写入稳定后自动上传飞书素材库 (`im/v1/images`)，并在卡片尾部动态渲染原生 `img` 标签。

---

## 2. 飞书开放平台配置手册 (Developer Console Checklist)

在接入前，必须在[飞书开放平台 (open.feishu.cn)](https://open.feishu.cn)完成以下设置：

### 2.1 创建企业自建应用
- 访问：`开发者后台` -> `创建企业自建应用`
- 填写应用名称（如 `Antigravity Assistant`）和图标。

### 2.2 开启机器人能力
- 路径：`添加应用能力` -> 选择 `机器人` -> 点击 `添加`。

### 2.3 配置权限范围 (Scopes)
在 `开发配置` -> `权限管理` 中申请并开通以下权限：
| 权限代码 | 权限名称 | 用途 |
|---|---|---|
| `im:message` | 获取与发送单聊/群聊消息 | 接收用户提问，发送回复卡片 |
| `im:message:send_as_bot` | 以应用身份发送消息 | 发送流式打字机卡片 |
| `im:resource` | 获取与上传图片或文件资源 | 将 agy 生成的图片上传至飞书预览 |

> ⚠️ **注意**：开通权限后，若属于企业敏感权限，需在后台进行发布或管理员审核通过。

### 2.4 配置事件订阅 (采用长连接 WebSocket 模式)
- 路径：`开发配置` -> `事件与回调` -> `订阅方式`
- **选择模式**：**「使用长连接接收事件/回调 (Persistent Connection)」**  
  *(无需公网域名，无需配置回调 URL，无需任何内网穿透工具)*
- **添加事件**：
  - 点击 `添加事件` -> 搜索并添加 `im.message.receive_v1`（接收消息 v2.0）
- **添加卡片回调**：
  - 点击 `添加回调` -> 搜索并添加 `card.action.trigger`（卡片回传交互）

### 2.5 版本发布与可用范围设置
- 路径：`版本管理与发布` -> `创建版本`
- 填写版本号（如 `1.0.0`）；
- **设置可用人员**：选择测试人员、特定部门或「全员可用」；
- 点击 `申请发布`（自建应用通常企业管理员一键审批或自动审批）。

---

## 3. 本地环境与配置文件

### 3.1 配置文件定位与加载优先级

> ⚠️ **配置只从配置文件读取，不读取任何环境变量。**
> 飞书机器人凭据与 `workspace` / `agy` 配置项都必须写在 `config.json` 中，`LARK_APP_ID` / `AGY_BIN` / `AGY_LARK_CONFIG` 等环境变量已全部废弃。

配置加载器会按以下顺序依次查找，一旦找到即刻生效：
1. 自定义显式传入路径（`loadBridgeConfig(customPath)`）
2. 当前工作目录下的 `./config.json`
3. 用户主目录下的 `~/.agy-lark/config.json`

若某个候选文件存在但 JSON 解析失败，会跳过它继续尝试下一个；全部候选路径都不可用时，返回内置默认值（此时 `lark.appId` / `lark.appSecret` 为空字符串，启动时会被拦截并报错退出）。

### 3.2 配置文件规范 (`config.json`)
```json
{
  "lark": {
    "appId": "cli_xxxxxxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "verificationToken": "",
    "encryptKey": "",
    "notifyReceiveId": "",
    "notifyReceiveIdType": "open_id"
  },
  "workspace": {
    "defaultRoot": "~/project",
    "projects": {}
  },
  "agy": {
    "binary": "agy",
    "defaultModel": "",
    "effort": "high",
    "timeoutMs": 600000
  },
  "proxy": {
    "http": "http://127.0.0.1:7890",
    "https": "http://127.0.0.1:7890",
    "all": "",
    "no": "127.0.0.1,localhost,::1"
  },
  "accessControl": {
    "enabled": false,
    "allowUsers": [],
    "allowChats": [],
    "notifyDenied": false
  }
}
```

> 💡 **访问控制（`accessControl`，可选但强烈建议）**：机器人以 YOLO 模式驱动本机 `agy` / `pi`
> 执行引擎，任何能向机器人发消息的用户都可以触发本机命令执行。`enabled: true` 后仅
> `allowUsers`（用户 `open_id`）或 `allowChats`（会话 `chat_id`）命中白名单的请求会被处理，
> 其余一律**静默忽略**（fail-closed，两个白名单均为空同样全拒）。被拒的 open_id 会记录在
> 服务日志中，按需加白即可；`notifyDenied: true` 会向被拒者回复提示卡片（默认关闭避免刷屏）。

> 💡 **出网代理（`proxy`，可选）**：`agy` 是 Go 二进制、额度取数走 `curl`，两者都只认
> `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 环境变量，不读 macOS 系统代理设置。交互式
> shell 里通常已由代理客户端注入，但 launchd（开机自启 / 知识库面板的启动指令页）拉起的
> 进程一个都没有，表现为 `agy` 卡在连 Google 的 `SYN_SENT` 直到超时。服务启动时只填补
> **缺失**的变量，横幅会打印实际写入的名字（没打印说明 shell 里已经有，没被覆盖）。

> 💡 **主动通知与自动记忆机制**：
> - `notifyReceiveId`：可选。配置指定用户的 `open_id`、`chat_id`、`user_id` 或 `email`。配置后，服务启动和停止时会第一时间主动向该用户/群推送卡片通知。
> - **自动记忆模式**：如果暂未配置 `notifyReceiveId`，只要任意用户在飞书中向机器人发送过任意一次消息，系统会自动在本地会话库中持久化记忆该用户的 ID。下次启动或服务停止/崩溃时，将自动向该用户推送！
> - **飞书直达链接 (AppLink)**：
>   如果客户端搜索不到机器人，直接点击直达链接打开单聊窗口：  
>   `https://applink.feishu.cn/client/bot/open?appId=cli_xxxxxxxxxxxxxxxx`

---

## 4. AGENT 自动化调通与验证标准操作规程 (SOP)

为确保整个链路 100% 健壮可用，Agent 执行以下五个标准化阶段：

### 阶段一：前置环境与凭据自检 (Pre-flight)
执行项目内置的自动自检脚本：
```bash
npm run verify
```
**自检判定准则 (Pass Criteria)**：
- [x] Node.js 版本 >= 18
- [x] `agy` 可执行路径有效，且 `agy --version` 返回正常
- [x] `agy models` 成功解析可用大模型列表
- [x] `config.json` 文件存在且 JSON 语法有效
- [x] 成功调用飞书 `auth/v3/tenant_access_token/internal` 换取 Token
- [x] 成功调用飞书 `bot/v3/info` 确认机器人处于激活态 (`activate_status: 2`)

### 阶段二：自动化单元与真实端到端测试
运行全量门禁套件：
```bash
npm test
```
**验证项包含**：
1. `cards.test.ts`：验证 `/help`、`/bind`、`/model`、流式卡片 JSON 结构符合飞书规范。
2. `models.test.ts`：验证 `agy models` 动态输出解析器。
3. `sessions.test.ts`：验证 Thread 与 P2P 路由键单例生命周期隔离。
4. `workspace.test.ts`：验证项目别名绑定与自动目录创建。
5. `runner.test.ts`：**真实拉起本地 `agy` 进行两轮对话测试**，验证首轮生成 `conversation_id`、流式文本接收、以及次轮续聊保持上下文。

### 阶段三：启动飞书长连接服务
```bash
npm run lark
```
**正常输出特征**：
```
----------------------------------------------------
🤖 启动 agy-lark 桥接网关服务
• 飞书 App ID: cli_xxxxxxxxxxxxxxxx
• 默认项目根目录: ~/project
• 默认大模型: 系统默认
• 思考强度: high
----------------------------------------------------
[agy-lark] 正在建立飞书 WebSocket 长连接...
[agy-lark] 飞书服务启动成功！已监听消息与卡片交互事件。
[info]: [ '[ws]', 'ws client ready' ]
```

### 阶段四：飞书客户端功能全量冒烟验收 (Checklist)

| 测试用例 | 操作步骤 | 预期效果 |
|---|---|---|
| **1. 基础单聊问答** | 在飞书私聊窗口向机器人发送："你好，测试一条消息" | 机器人立刻返回流式卡片，展示「思考中」并逐步渲染最终回答，底部展示 Token 消耗 |
| **2. 指令 `/help`** | 在私聊或群聊发送 `/help` | 机器人就地返回帮助卡片，完整列举 `/bind`, `/model`, `/pwd`, `/cd`, `/new`, `/status`, `/stop` |
| **3. 指令 `/model`** | 发送 `/model` | 机器人返回模型选择卡片，展示当前支持的 Gemini/Claude/GPT 模型列表及思考强度，点击可直接切换 |
| **4. 指令 `/bind`** | 发送 `/bind` | 机器人返回工作区绑定卡片，可下拉选择已有项目、回复 `/bind add <别名> <路径>` 关联已有文件夹，或点击「新建项目」新建目录绑定 |
| **5. 群聊 Thread 隔离** | 将机器人拉入飞书群聊，@机器人发起讨论；然后在同一个 Thread 中回复，并在群主界面发起另一个 Thread | 两个话题内的回复均留在各自 Thread 内，互不串话，互不干扰 |
| **6. 图片生成与卡片渲染** | 对机器人发送："帮我写一个 Python 脚本生成一张渐变色图片" 或直接调用绘图能力 | agy 在工作区或 brain 中生成图片后，服务自动捕获并上传至飞书，流式卡片底部动态展示原生大图预览 |
| **7. 紧急停止 `/stop`** | 在耗时推理过程中发送 `/stop` | 服务端发送 SIGTERM 终止底层 `agy` 进程树，卡片状态更新为已中断 |

---

## 5. 故障排查手册 (Troubleshooting Runbook)

| 错误现象 / 错误码 | 根本原因 | 根治修复步骤 |
|---|---|---|
| `code: 99991672 Access denied` | 飞书应用尚未开通对应的权限范围（如 `im:message`, `im:resource`） | 打开终端打印出的飞书授权链接，在开发者后台一键开通权限并发布新版本 |
| `code: 99991663` 或 `99991664` | 机器人应用未发布，或未在可用范围内 | 在 `版本管理与发布` 创建版本并发布，将可用范围设为包含当前测试人员 |
| `ws connection failed` | 网络受限或 App ID/Secret 填错 | 运行 `npm run verify` 检查凭据，确保当前机器能直接访问 `open.feishu.cn:443` |
| `agy` 长时间无响应、卡片停在「思考中」；`agy` 日志里 `dial tcp [2001:4860…]:443: i/o timeout` 或连接长期 `SYN_SENT` | 进程没有代理环境变量，Google 直连不可达（`agy` 是 Go 二进制，只认 `HTTP_PROXY`/`HTTPS_PROXY`，不读系统代理） | 在 `config.json` 写 `proxy.http` / `proxy.https`（见 §3.2）。launchd 常驻时这是唯一来源，因为 launchd 不会继承 shell 注入的代理变量 |
| `SyntaxError` / 运行时编译错误 | TypeScript 文件未编译或环境不一致 | 执行 `npm run build` 重新编译出 `dist/`，使用 `npm run start` 启动 |
| 底层 `agy` 提示确认工具权限 | 未携带 YOLO 参数 | 确保使用统一的 `runAgy` 封装函数，该函数已默认追加 `--dangerously-skip-permissions` |
