/**
 * 客户端字幕抓取（浏览器端）
 * CF Worker IP 被 YouTube 封锁，但用户浏览器 IP 不会
 * 抓到字幕后发送给 /api/generate，服务端直接使用
 */

const LANGS = ['zh-Hans', 'zh-CN', 'zh', 'zh-Hant', 'en'];

/** 从 YouTube URL 解析 videoId */
export function parseVideoId(url: string): string | null {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
  return m ? m[1] : null;
}

/**
 * 尝试从浏览器端抓取字幕
 * 策略：CORS 代理 → 第三方 API
 * 返回纯文本字幕，失败返回 null
 */
export async function fetchSubtitleClientSide(videoId: string): Promise<string | null> {
  // 1) CORS 代理：通过 allorigins.win 中转 YouTube timedtext API
  for (const lang of LANGS) {
    for (const kind of ['', '&kind=asr']) {
      const ytUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=json3${kind}`;
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(ytUrl)}`;
      try {
        const res = await fetch(proxyUrl);
        if (!res.ok) continue;
        const text = await res.text();
        const extracted = extractTextFromJson3(text);
        if (extracted) return extracted;
      } catch {
        continue;
      }
    }
  }

  // 2) CORS 代理：不指定语言
  const defaultYtUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&fmt=json3`;
  const defaultProxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(defaultYtUrl)}`;
  try {
    const res = await fetch(defaultProxyUrl);
    if (res.ok) {
      const text = await res.text();
      const extracted = extractTextFromJson3(text);
      if (extracted) return extracted;
    }
  } catch {
    // 继续
  }

  // 3) 第三方 API（从浏览器端调用）
  const thirdPartyUrl = `https://youtube-transcript.ai/transcript/${videoId}.txt`;
  try {
    const res = await fetch(thirdPartyUrl);
    if (res.ok) {
      const raw = await res.text();
      return cleanThirdPartyTranscript(raw);
    }
  } catch {
    // 继续
  }

  return null;
}

/** 解析 json3 格式字幕为纯文本 */
function extractTextFromJson3(raw: string): string | null {
  try {
    const data = JSON.parse(raw) as { events?: Array<{ segs?: Array<{ utf8?: string }> }> | null };
    if (!data || !Array.isArray(data.events)) return null;
    const lines: string[] = [];
    for (const ev of data.events) {
      if (!ev || !Array.isArray(ev.segs)) continue;
      const line = ev.segs
        .map((s) => (s && typeof s.utf8 === 'string' ? s.utf8 : ''))
        .join('')
        .replace(/\r/g, '')
        .replace(/\n+/g, ' ')
        .trim();
      if (line) lines.push(line);
    }
    if (!lines.length) return null;
    return lines.join('\n');
  } catch {
    return null;
  }
}

/** 清理第三方 API 返回的字幕文本 */
function cleanThirdPartyTranscript(raw: string): string | null {
  const lines = raw.split('\n');
  const contentLines: string[] = [];
  let pastHeader = false;

  for (const line of lines) {
    if (!pastHeader) {
      if (/^\[\d+:\d+\]/.test(line.trim())) {
        pastHeader = true;
      } else {
        continue;
      }
    }
    const cleaned = line
      .replace(/^\[\d+:\d+\]\s*/, '')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
    if (cleaned) contentLines.push(cleaned);
  }

  if (!contentLines.length) return null;
  return contentLines.join(' ');
}
