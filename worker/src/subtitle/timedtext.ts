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

const DEFAULT_LANGS = ['zh-Hans', 'zh-CN', 'zh', 'zh-Hant', 'en'] as const;

const FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/**
 * 拉取 YouTube timedtext（json3 格式）→ 拼接成纯文本
 * 最佳努力 best-effort：网络 4xx/5xx / 验证码 / 解析失败 / 内容为空 都会抛错，
 * 由 resolver 层降级到硬编码字幕。
 *
 * 策略：所有候选 URL（语言×手动/asr + 默认）并行发起，
 * 按优先级顺序检查结果，返回第一个命中。
 */
export async function fetchTimedText(
  videoId: string,
  opts: FetchTimedTextOptions = {},
): Promise<ResolvedSubtitle> {
  const languages = opts.languages ?? DEFAULT_LANGS;
  const fetcher: Fetcher = opts.fetcher ?? fetch;
  const errors: string[] = [];

  // 1) 构建所有候选 URL（按优先级排序）
  const candidates: { url: string; label: string }[] = [];
  for (const lang of languages) {
    candidates.push({
      url: `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(lang)}&fmt=json3`,
      label: lang,
    });
    candidates.push({
      url: `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(lang)}&fmt=json3&kind=asr`,
      label: `${lang}(asr)`,
    });
  }
  candidates.push({
    url: `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&fmt=json3`,
    label: 'default',
  });

  // 2) 全部并行发起（总耗时 = 最慢单请求，而非累加）
  const results = await Promise.allSettled(
    candidates.map((c) => fetcher(c.url, { headers: FETCH_HEADERS })),
  );

  // 3) 按优先级顺序检查结果，返回第一个命中
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const label = candidates[i].label;
    if (result.status === 'rejected') {
      errors.push(`${label}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      continue;
    }
    const res = result.value;
    if (!res.ok) {
      errors.push(`${label}: HTTP ${res.status}`);
      continue;
    }
    try {
      const text = await res.text();
      const extracted = extractTextFromJson3(text);
      if (extracted) {
        return { videoId, source: 'live', text: extracted };
      }
      errors.push(`${label}: empty`);
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`);
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
