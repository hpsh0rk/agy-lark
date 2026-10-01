export interface ParsedLarkMessage {
  text: string;
  imageKeys: string[];
}

/**
 * 解析飞书多种消息类型 (text, post, image)，提取文本与随附图片 Key
 */
export function parseLarkMessage(message: {
  message_type?: string;
  msg_type?: string;
  content?: string;
}): ParsedLarkMessage {
  const type = (message.message_type || message.msg_type || 'text').toLowerCase();
  let parsedContent: any = {};
  try {
    parsedContent = JSON.parse(message.content || '{}');
  } catch {
    // 非 JSON 格式直接作为纯文本
    return {
      text: typeof message.content === 'string' ? message.content.trim() : '',
      imageKeys: [],
    };
  }

  if (type === 'text') {
    return {
      text: typeof parsedContent.text === 'string' ? parsedContent.text.trim() : '',
      imageKeys: [],
    };
  }

  if (type === 'image') {
    const key = parsedContent.image_key || parsedContent.file_key;
    return {
      text: '请分析并总结这张图片的内容。',
      imageKeys: key ? [key] : [],
    };
  }

  if (type === 'post') {
    let postData = parsedContent;
    if (!postData.content) {
      // 常见语言分组如 zh_cn, en_us
      for (const lang of ['zh_cn', 'en_us', 'ja_jp']) {
        if (postData[lang]?.content) {
          postData = postData[lang];
          break;
        }
      }
      if (!postData.content) {
        const firstLang = Object.values(postData).find(
          (v: any) => v && typeof v === 'object' && Array.isArray(v.content)
        );
        if (firstLang) {
          postData = firstLang;
        }
      }
    }

    const title = typeof postData.title === 'string' ? postData.title.trim() : '';
    const textSegments: string[] = [];
    if (title) {
      textSegments.push(title);
    }
    const imageKeys: string[] = [];

    const paragraphs = Array.isArray(postData.content) ? postData.content : [];
    for (const paragraph of paragraphs) {
      if (!Array.isArray(paragraph)) continue;
      const lineSegments: string[] = [];
      for (const element of paragraph) {
        if (!element || typeof element !== 'object') continue;
        const tag = element.tag;
        if (tag === 'text' || tag === 'a') {
          if (element.text) lineSegments.push(element.text);
        } else if (tag === 'img' || tag === 'image') {
          const key = element.image_key || element.file_key;
          if (key && !imageKeys.includes(key)) {
            imageKeys.push(key);
          }
        }
      }
      const lineText = lineSegments.join('');
      if (lineText) {
        textSegments.push(lineText);
      }
    }

    let fullText = textSegments.join('\n').trim();
    if (!fullText && imageKeys.length > 0) {
      fullText = '请分析并总结这张图片的内容。';
    }

    return {
      text: fullText,
      imageKeys,
    };
  }

  // 兜底降级
  return {
    text: typeof parsedContent.text === 'string' ? parsedContent.text.trim() : '',
    imageKeys: [],
  };
}
