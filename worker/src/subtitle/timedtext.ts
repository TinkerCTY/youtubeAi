import type { ResolvedSubtitle } from './resolver';

export type Fetcher = typeof fetch;

export interface FetchTimedTextOptions {
  /** 覆盖 fetch，测试用注入 mock */
  fetcher?: Fetcher;
  /** 按顺序尝试的语言，默认 zh-Hans → zh-CN → en */
  languages?: readonly string[];
  /** 单语言请求超时 ms（默认 4s，Cloudflare Worker SLA 容忍即可） */
  timeoutMs?: number;
}

const DEFAULT_LANGS = ['zh-Hans', 'zh-CN', 'en'] as const;

/**
 * 拉取 YouTube timedtext（json3 格式）→ 拼接成纯文本
 * 最佳努力 best-effort：网络 4xx/5xx / 验证码 / 解析失败 / 内容为空 都会抛错，
 * 由 resolver 层降级到硬编码字幕。
 */
export async function fetchTimedText(
  videoId: string,
  opts: FetchTimedTextOptions = {},
): Promise<ResolvedSubtitle> {
  const languages = opts.languages ?? DEFAULT_LANGS;
  const fetcher: Fetcher = opts.fetcher ?? fetch;
  const errors: string[] = [];

  for (const lang of languages) {
    const url = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(
      videoId,
    )}&lang=${encodeURIComponent(lang)}&fmt=json3`;
    try {
      const res = await fetcher(url);
      if (!res.ok) {
        errors.push(`${lang}: HTTP ${res.status}`);
        continue;
      }
      const text = await res.text();
      const extracted = extractTextFromJson3(text);
      if (extracted) {
        return { videoId, source: 'live', text: extracted };
      }
      errors.push(`${lang}: empty`);
    } catch (e) {
      errors.push(`${lang}: ${(e as Error).message}`);
    }
  }

  throw new Error(`fetchTimedText(${videoId}) failed: ${errors.join(' | ')}`);
}

/* ───────────────────────── internal ───────────────────────── */

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
