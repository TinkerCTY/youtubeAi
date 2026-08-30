import type { ResolvedSubtitle } from './resolver';

export type Fetcher = typeof fetch;

export interface FetchTimedTextOptions {
  /** 覆盖 fetch，测试用注入 mock */
  fetcher?: Fetcher;
  /** 按顺序尝试的语言，默认 zh-Hans → zh-CN → en */
  languages?: readonly string[];
  /** 可选：代理转发 URL 前缀（直连失败后降级，如 https://corsproxy.io/?url= ） */
  proxyUrl?: string;
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
 * 由 resolver 层降级到硬编码字幕或 R2 缓存。
 *
 * 策略：所有候选 URL（语言×手动/asr + 默认）并行发起，
 * 按优先级顺序检查结果，返回第一个命中。
 * 如果直连全部失败，且有 proxyUrl 配置，则通过代理转发重试一次。
 */
export async function fetchTimedText(
  videoId: string,
  opts: FetchTimedTextOptions = {},
): Promise<ResolvedSubtitle> {
  const languages = opts.languages ?? DEFAULT_LANGS;
  const fetcher: Fetcher = opts.fetcher ?? fetch;
  const errors: string[] = [];

  const result = await tryFetchCandidates(videoId, languages, fetcher, errors, '');
  if (result) return result;

  // 代理降级：直连全部失败，且配置了代理 URL
  if (opts.proxyUrl) {
    const proxyResult = await tryFetchCandidates(
      videoId,
      languages,
      fetcher,
      errors,
      opts.proxyUrl,
    );
    if (proxyResult) return { ...proxyResult, source: 'proxy' as const };
  }

  throw new Error(`fetchTimedText(${videoId}) failed: ${errors.join(' | ')}`);
}

/** 构建候选 URL 并并行 fetch，返回第一个成功结果 */
async function tryFetchCandidates(
  videoId: string,
  languages: readonly string[],
  fetcher: Fetcher,
  errors: string[],
  proxyUrl: string,
): Promise<ResolvedSubtitle | null> {
  // 构建所有候选 URL（按优先级排序）
  const candidates: { target: string; label: string }[] = [];
  for (const lang of languages) {
    const base = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(lang)}&fmt=json3`;
    candidates.push({ target: base, label: `${proxyUrl ? 'proxy/' : ''}${lang}` });
    candidates.push({ target: `${base}&kind=asr`, label: `${proxyUrl ? 'proxy/' : ''}${lang}(asr)` });
  }
  candidates.push({
    target: `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&fmt=json3`,
    label: `${proxyUrl ? 'proxy/' : ''}default`,
  });

  // 通过代理 URL 前缀或直连发起请求
  const buildUrl = (target: string) =>
    proxyUrl ? `${proxyUrl}${encodeURIComponent(target)}` : target;

  const results = await Promise.allSettled(
    candidates.map((c) => fetcher(buildUrl(c.target), { headers: FETCH_HEADERS })),
  );

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
      if (extracted) return { videoId, source: proxyUrl ? 'proxy' : 'live', text: extracted };
      errors.push(`${label}: empty`);
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`);
    }
  }

  return null;
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
