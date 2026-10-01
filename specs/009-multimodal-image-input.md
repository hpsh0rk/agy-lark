# 任务规格: 飞书多模态图片与图文混排输入支持

> 状态: Implemented
> 创建时间: 2026-10-01
> 对应模块: agy-lark (lark/dispatcher, lark/downloader, core/types)
> 关联任务: 用户反馈「agy-lark 是不支持图像么，我发了图像和文字，但是没有返回结果」

---

## 1. 范围与边界 (Scope & Guardrails)

### 背景与根本原因
1. 当前 `MessageDispatcher.handleMessage` 强假设 `message.content` 仅为纯文本格式 `{"text": "..."}`。
2. 当用户在飞书中发送图片时：
   - 图文混排消息被飞书客户端封装为 `post` 富文本类型，`message.content` 结构为 `{"content": [[{"tag": "text", "text": "xxx"}, {"tag": "img", "image_key": "yyy"}]]}`；
   - 纯图片消息被封装为 `image` 类型，`message.content` 为 `{"image_key": "yyy"}`。
3. `JSON.parse(message.content).text` 在上述两种场景下均为 `undefined`，导致 `cleanText` 为空，被 `[agy-lark] 忽略无文本消息` 分支直接 return 丢弃，机器人完全不产生任何响应。
4. `agy` 底层具备多模态文件查看能力（通过 `view_file` 读取本地图片并由大模型分析），但网关层未实现图片下载与 Prompt 注入。

### 要做 (Goals)
1. **消息解析扩展 (`parseLarkMessage`)**:
   - 支持 `text` 类型：提取 `text`；
   - 支持 `post`（富文本图文混排）类型：遍历段落提取所有文本拼接，并收集所有 `img` 的 `image_key`；
   - 支持 `image`（纯图片）类型：提取 `image_key`，若无用户文字输入，默认引导文本为 `“请分析并描述这张图片的内容”`。
2. **飞书资源下载 (`downloadImageFromLark`)**:
   - 调用 `client.im.messageResource.get`，拉取指定 `message_id` 与 `file_key` 的图片流；
   - 将图片保存至当前会话工作区或专用目录（如 `${cwd}/.agy-images/`），返回绝对文件路径；
   - 具备异常容错：下载失败时降级提示，不阻塞主流程。
3. **多模态 Prompt 组装**:
   - 当检测到随附图片并成功下载时，在 Prompt 前追加结构化说明：
     ```text
     【用户随附图片已保存至本地】:
     - /path/to/image_1.png
     请调用 view_file 工具查看并结合图片内容回答。

     用户提问: <用户文本>
     ```
4. **自动化测试与门禁**:
   - 覆盖 `parseLarkMessage` 各种消息类型（text, post 单段/多段图文, image 纯图）；
   - 覆盖 `downloadImageFromLark` 与 `MessageDispatcher` 接收图文消息的端到端调用链；
   - 全量编译与门禁测试通过。

### 不做 (Non-Goals)
- 暂不扩展语音 (`audio`) 与视频 (`video`) 下载。
- 不修改 `agy` CLI 核心二进制交互协议。

---

## 2. 契约 (Contract)

### 2.1 消息解析结果契约
```ts
export interface ParsedLarkMessage {
  text: string;
  imageKeys: string[];
}
```

### 2.2 下载接口契约
```ts
export async function downloadImageFromLark(
  client: lark.Client,
  messageId: string,
  imageKey: string,
  destDir: string
): Promise<string>;
```

---

## 3. 验收标准 (Acceptance Criteria)

- [x] AC1: `parseLarkMessage` 能正确解析 `text`、`post`（图文混排提取文本与 image_key）、`image`（提取 image_key 并赋默认提示词）。
- [x] AC2: `downloadImageFromLark` 能成功将指定消息中的图片下载到本地磁盘并返回有效绝对路径。
- [x] AC3: `MessageDispatcher` 收到 `post` 图文消息时，不再报错丢弃，而是自动下载图片、组装提示词并交给 `agy` 执行流式卡片回复。
- [x] AC4: `MessageDispatcher` 收到纯 `image` 消息时，自动下载并以图像分析默认提示词触发回复。
- [x] AC5: 图片下载失败时不导致程序崩溃，降级为普通文本或错误提示。
- [x] AC6: 补充单元测试且全量门禁 (`npm test`, `npm run build`) 100% 通过。
