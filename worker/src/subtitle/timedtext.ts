import type { ResolvedSubtitle } from './resolver';

export type Fetcher = typeof fetch;

export interface FetchTimedTextOptions {
  /** 覆盖 fetch，测试用注入 mock */
  fetcher?: Fetcher;
  /** 按顺序尝试的语言，默认 zh-Hans → zh-CN → zh → zh-Hant → en */
  languages?: readonly string[];
  /** 单语言请求超时 ms（默认 4s，Cloudflare Worker SLA 容忍即可） */
  timeoutMs?: number;
}

const DEFAULT_LANGS = ['zh-Hans', 'zh-CN', 'zh', 'zh-Hant', 'en'] as const;

const FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/**
 * 拉取 YouTube 字幕 → 拼接成纯文本
 * best-effort：失败由 resolver 层降级到硬编码字幕。
 *
 * 策略（按优先级）：
 * 1. timedtext API：逐语言手动 → asr → 不指定语言（快速但常被 CF IP 封）
 * 2. watch page 解析：抓视频页 HTML → 从 ytInitialPlayerResponse 提取带 token 的字幕 URL → 下载字幕
 */
export async function fetchTimedText(
  videoId: string,
  opts: FetchTimedTextOptions = {},
): Promise<ResolvedSubtitle> {
  const languages = opts.languages ?? DEFAULT_LANGS;
  const fetcher: Fetcher = opts.fetcher ?? fetch;
  const errors: string[] = [];

  // 1) timedtext API：逐语言尝试手动 → asr
  for (const lang of languages) {
    for (const kind of ['', '&kind=asr']) {
      const url = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(
        videoId,
      )}&lang=${encodeURIComponent(lang)}&fmt=json3${kind}`;
      try {
        const res = await fetcher(url, { headers: FETCH_HEADERS });
        if (!res.ok) {
          errors.push(`${lang}${kind}: HTTP ${res.status}`);
          continue;
        }
        const text = await res.text();
        const extracted = extractTextFromJson3(text);
        if (extracted) {
          return { videoId, source: 'live', text: extracted };
        }
        errors.push(`${lang}${kind}: empty`);
      } catch (e) {
        errors.push(`${lang}${kind}: ${(e as Error).message}`);
      }
    }
  }

  // 2) timedtext API：不指定语言兜底
  const defaultUrl = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(
    videoId,
  )}&fmt=json3`;
  try {
    const res = await fetcher(defaultUrl, { headers: FETCH_HEADERS });
    if (res.ok) {
      const text = await res.text();
      const extracted = extractTextFromJson3(text);
      if (extracted) return { videoId, source: 'live', text: extracted };
    }
    errors.push(`default: HTTP ${res.status}`);
  } catch (e) {
    errors.push(`default: ${(e as Error).message}`);
  }

  // 3) Watch page 解析：从视频页提取带 token 的字幕 URL
  try {
    const watchText = await fetchFromWatchPage(videoId, fetcher);
    if (watchText) return { videoId, source: 'live', text: watchText };
    errors.push('watchpage: no captions found');
  } catch (e) {
    errors.push(`watchpage: ${(e as Error).message}`);
  }

  throw new Error(`fetchTimedText(${videoId}) failed: ${errors.join(' | ')}`);
}

/* ───────────────────────── watch page 解析 ───────────────────────── */

/**
 * 从 YouTube 视频页 HTML 提取字幕：
 * 1. 抓 watch page HTML
 * 2. 从 ytInitialPlayerResponse 解析 caption tracks
 * 3. 按语言优先级逐个下载字幕内容
 */
async function fetchFromWatchPage(
  videoId: string,
  fetcher: Fetcher,
): Promise<string | null> {
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&gl=US&hl=en`;
  const res = await fetcher(url, {
    headers: {
      ...FETCH_HEADERS,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`watch page HTTP ${res.status}`);
  const html = await res.text();

  const playerResponse = extractPlayerResponse(html);
  if (!playerResponse) throw new Error('ytInitialPlayerResponse not found in HTML');

  const tracks =
    playerResponse?.captions?.playerCaptionsTrackRendererTracklist;
  if (!Array.isArray(tracks) || !tracks.length) throw new Error('no caption tracks in player response');

  // 按语言优先级排序：中文简体 > 中文 > 英文 > 其他
  const langScore = (lang: string): number => {
    if (lang.startsWith('zh-Hans') || lang.startsWith('zh-CN')) return 0;
    if (lang.startsWith('zh')) return 1;
    if (lang.startsWith('en')) return 2;
    return 3;
  };
  const sortedTracks = [...tracks].sort(
    (a, b) => langScore(a?.languageCode ?? '') - langScore(b?.languageCode ?? ''),
  );

  // 逐个下载字幕
  for (const track of sortedTracks) {
    const baseUrl = track?.baseUrl;
    if (!baseUrl || typeof baseUrl !== 'string') continue;

    // 附加 fmt=json3（如果 URL 里还没有）
    const captionUrl = baseUrl + (baseUrl.includes('fmt=') ? '' : '&fmt=json3');
    try {
      const captionRes = await fetcher(captionUrl, { headers: FETCH_HEADERS });
      if (!captionRes.ok) continue;
      const captionText = await captionRes.text();
      const extracted = extractTextFromJson3(captionText);
      if (extracted) return extracted;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * 从 YouTube watch page HTML 中安全提取 ytInitialPlayerResponse JSON
 * 使用大括号深度计数 + 字符串/转义感知，避免正则匹配大 JSON 的陷阱
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractPlayerResponse(html: string): any | null {
  const marker = 'ytInitialPlayerResponse';
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) return null;

  const jsonStart = html.indexOf('{', startIdx);
  if (jsonStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = jsonStart; i < html.length; i++) {
    const c = html[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(jsonStart, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

/* ───────────────────────── CORS 代理策略 ───────────────────────── */

/**
 * 通过 CORS 代理拉取 YouTube 字幕
 * CF Worker 直连 YouTube 被封，但 CORS 代理（非 YouTube 域名）通常可访问
 */
export async function fetchViaCorsProxy(
  videoId: string,
  opts: FetchTimedTextOptions = {},
): Promise<string | null> {
  const languages = opts.languages ?? DEFAULT_LANGS;
  const fetcher: Fetcher = opts.fetcher ?? fetch;

  for (const lang of languages) {
    for (const kind of ['', '&kind=asr']) {
      const ytUrl = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(
        videoId,
      )}&lang=${encodeURIComponent(lang)}&fmt=json3${kind}`;
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(ytUrl)}`;
      try {
        const res = await fetcher(proxyUrl, {
          headers: { Accept: 'application/json,text/plain,*/*' },
        });
        if (!res.ok) continue;
        const text = await res.text();
        const extracted = extractTextFromJson3(text);
        if (extracted) return extracted;
      } catch {
        continue;
      }
    }
  }

  // 不指定语言兜底
  const defaultYtUrl = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(
    videoId,
  )}&fmt=json3`;
  const defaultProxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(defaultYtUrl)}`;
  try {
    const res = await fetcher(defaultProxyUrl, {
      headers: { Accept: 'application/json,text/plain,*/*' },
    });
    if (res.ok) {
      const text = await res.text();
      const extracted = extractTextFromJson3(text);
      if (extracted) return extracted;
    }
  } catch {
    // 吞掉
  }

  return null;
}

/* ───────────────────────── 第三方字幕 API ───────────────────────── */

/**
 * 从第三方 API (youtube-transcript.ai) 抓取字幕
 * CF Worker 访问 YouTube 直连会被封，但第三方服务通常不受影响
 */
export async function fetchThirdPartyTranscript(
  videoId: string,
  opts: { fetcher?: Fetcher; timeoutMs?: number } = {},
): Promise<string | null> {
  const fetcher: Fetcher = opts.fetcher ?? fetch;
  const url = `https://youtube-transcript.ai/transcript/${encodeURIComponent(videoId)}.txt`;

  try {
    const res = await fetcher(url, {
      headers: FETCH_HEADERS,
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    });
    if (!res.ok) return null;
    const raw = await res.text();
    return cleanThirdPartyTranscript(raw);
  } catch {
    return null;
  }
}

/**
 * 清理第三方 API 返回的字幕文本：
 * 1. 去掉 header 行（Title/Source/Language/Generated/Duration/Words）
 * 2. 去掉时间戳 [0:01] [0:32] 等
 * 3. 转换 HTML 实体 &gt; → > 等
 * 4. 合并为纯文本
 */
function cleanThirdPartyTranscript(raw: string): string | null {
  const lines = raw.split('\n');
  const contentLines: string[] = [];
  let pastHeader = false;

  for (const line of lines) {
    // 检测 header 结束（第一个 [timestamp] 行）
    if (!pastHeader) {
      if (/^\[\d+:\d+\]/.test(line.trim())) {
        pastHeader = true;
      } else {
        continue;
      }
    }
    // 去掉时间戳 + HTML 实体转换
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

/* ───────────────────────── json3 解析 ───────────────────────── */

interface Json3Event {
  segs?: Array<{ utf8?: string }>;
}

function extractTextFromJson3(raw: string): string | null {
  try {
    const data = JSON.parse(raw) as { events?: Json3Event[] | null };
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
  } catch (_e) {
    return null;
  }
}
