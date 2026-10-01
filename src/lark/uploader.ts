import fs from 'node:fs';
import * as lark from '@larksuiteoapi/node-sdk';
import { BridgeError } from '../core/errors.js';

export async function uploadImageToLark(client: lark.Client, filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new BridgeError('E_LARK_API_ERROR', `图片文件不存在: ${filePath}`, '无法读取要上传的文件');
  }

  let imageKey: string | undefined;
  try {
    const fileStream = fs.createReadStream(filePath);
    const resp = await client.im.image.create({
      data: {
        image_type: 'message',
        image: fileStream,
      },
    });
    imageKey = resp?.image_key;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BridgeError('E_LARK_API_ERROR', `上传图片至飞书失败: ${msg}`, '请检查飞书机器人的图片上传权限');
  }

  if (!imageKey) {
    throw new BridgeError(
      'E_LARK_API_ERROR',
      '飞书图片上传接口未返回 image_key',
      '请确认应用已开通 im:resource 权限，且已发布版本并生效'
    );
  }

  return imageKey;
}
