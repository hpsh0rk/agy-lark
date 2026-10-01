import fs from 'node:fs';
import path from 'node:path';
import type * as lark from '@larksuiteoapi/node-sdk';

/**
 * 从飞书下载指定消息内的图片资源并保存至本地工作区
 *
 * @param client 飞书 Client 实例
 * @param messageId 飞书消息 ID
 * @param imageKey 资源 Key
 * @param targetDir 本地保存的基础目录（如 session.cwd）
 * @returns 下载成功后的绝对路径
 */
export async function downloadImageFromLark(
  client: lark.Client,
  messageId: string,
  imageKey: string,
  targetDir: string
): Promise<string> {
  const imagesDir = path.join(targetDir, '.agy-images');
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  const safeKey = imageKey.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const filePath = path.join(imagesDir, `${messageId}_${safeKey}.png`);

  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
    return filePath;
  }

  const res = await client.im.messageResource.get({
    path: {
      message_id: messageId,
      file_key: imageKey,
    },
    params: {
      type: 'image',
    },
  });

  await res.writeFile(filePath);
  return filePath;
}
