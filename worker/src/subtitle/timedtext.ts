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

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  name?: { simpleText?: string };
  kind?: string;
  vssId?: string;
}

const DEFAULT_LANGS = ['zh-Hans', 'zh-CN', 'zh', 'zh-Hant', 'en'] as const;

const FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/**
 * 从 YouTube watch 页面 HTML 中提取 ytInitialPlayerResponse 的字幕轨道列表。
 *
 * 说明：2024 年后 YouTube timedtext 直接请求需要页面级签名（x_yt_sig / sparams 等），
 * 直接手工拼 URL 会返回空 body。因此改为：先拉 watch 页面 HTML → 解析 var ytInitialPlayerResponse
 * → captions.playerCaptionsTracklistRenderer.captionTracks 里每条 baseUrl 已经带全所有签名，
 * 直接请求 baseUrl 即可拿到真实字幕。
 *
 * @returns 排序后的字幕轨道（中文优先 → 其他语言），解析失败 / 没有 captions 时返回 null，
 *          有 captionTracks 但为空数组返回空数组 []
 */
export function parseWatchPageCaptions(html: string): CaptionTrack[] | null {
  if (!html || typeof html !== 'string') return null;

  // 匹配 var ytInitialPlayerResponse = {...};</script>
  // 支持多语句，用正则找到 `ytInitialPlayerResponse = ` 之后的 JS 对象文本（非贪婪匹配最后一个 `};` 之前）
  const marker = 'ytInitialPlayerResponse';
  const idx = html.indexOf(marker);
  if (idx < 0) return null;

  const eqIdx = html.indexOf('=', idx + marker.length);
  if (eqIdx < 0) return null;

  const startIdx = html.indexOf('{', eqIdx);
  if (startIdx < 0) return null;

  // 计算一对花括号深度匹配，找到对应的结束 }
  let depth = 0;
  let endIdx = -1;
  for (let i = startIdx; i < html.length; i++) {
    const c = html[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    } else if (c === '<' && depth === 0) {
      // 提前遇到 </script>（比如 JSON 没结束时被截断），放弃
      break;
    }
  }
  if (endIdx < 0) return null;

  const raw = html.slice(startIdx, endIdx + 1);
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  const tracks: any[] | undefined =
    data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks)) {
    // 没有 captionTracks = 没有字幕（返回 null 区分「空数组」和「无 caption 节点」）
    const hasCaptionsNode = !!(data?.captions?.playerCaptionsTracklistRenderer);
    return hasCaptionsNode ? [] : null;
  }

  const normalized: CaptionTrack[] = [];
  for (const t of tracks) {
    if (!t || typeof t.baseUrl !== 'string') continue;
    const languageCode = String(t.languageCode || '').trim();
    if (!languageCode) continue;

    // baseUrl: 仅用纯字符串处理 → 不破坏签名校验：
    //   1) 相对路径 → 前缀补 https://www.youtube.com
    //   2) ⚠️  绝对不要：注入 fmt=json3（会破坏签名）、不要用 new URL() 类重编码（逗号会变成 %2C）
    let base: string = t.baseUrl;
    if (base.startsWith('/')) {
      base = 'https://www.youtube.com' + base;
    }

    normalized.push({
      baseUrl: base,
      languageCode,
      name: t.name,
      kind: typeof t.kind === 'string' ? t.kind : undefined,
      vssId: typeof t.vssId === 'string' ? t.vssId : undefined,
    });
  }

  // 排序：优先 中文 开头 → 非 asr（人工字幕）→ 其他
  normalized.sort((a, b) => {
    const zhA = a.languageCode.startsWith('zh') ? 0 : 1;
    const zhB = b.languageCode.startsWith('zh') ? 0 : 1;
    if (zhA !== zhB) return zhA - zhB;
    const asrA = a.kind === 'asr' ? 1 : 0;
    const asrB = b.kind === 'asr' ? 1 : 0;
    if (asrA !== asrB) return asrA - asrB;
    return 0;
  });

  return normalized;
}

/**
 * 拉取 YouTube timedtext（json3 格式）→ 拼接成纯文本
 * 最佳努力 best-effort：网络 4xx/5xx / 验证码 / 解析失败 / 内容为空 都会抛错，
 * 由 resolver 层降级到硬编码字幕或 R2 缓存。
 *
 * 策略：
 *   1) 所有候选 URL（语言×手动/asr + 默认）并行发起，直连 first
 *   2) 如果配置了 proxyUrl → 同样的枚举再用 proxy 重试
 *   3) 若仍失败，且有 proxyUrl → 降级：通过 proxy 拉 YouTube watch 页面 HTML
 *        → 解析 ytInitialPlayerResponse.captionTracks → 按语言优先级取第一条带签名的
 *          baseUrl → 请求 json3（同样先直连，再 proxy）
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

  // 代理降级：直连全部失败，且配置了代理 URL → 再跑一遍枚举
  if (opts.proxyUrl) {
    const proxyResult = await tryFetchCandidates(
      videoId,
      languages,
      fetcher,
      errors,
      opts.proxyUrl,
    );
    if (proxyResult) return { ...proxyResult, source: 'proxy' as const };

    // ✨ New in T6-b: 再降级到 watch-page HTML 解析字幕轨道（已带签名的 baseUrl）
    const watchPageResult = await tryFetchFromWatchPage(
      videoId,
      fetcher,
      errors,
      opts.proxyUrl,
    );
    if (watchPageResult) return watchPageResult;
  } else {
    // 没配 proxy 的话也尝试一次直连 watch page（Cloudflare Worker IP 通常被挡，先不抱希望）
    const watchPageResult = await tryFetchFromWatchPage(videoId, fetcher, errors, '');
    if (watchPageResult) return watchPageResult;
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

  return runFetches(videoId, candidates, fetcher, errors, proxyUrl);
}

/** watch-page fallback：先取 HTML → 解析轨道 → 按优先级抓取 json3 */
async function tryFetchFromWatchPage(
  videoId: string,
  fetcher: Fetcher,
  errors: string[],
  proxyUrl: string,
): Promise<ResolvedSubtitle | null> {
  const watchTarget = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  try {
    const htmlRes = await fetcher(
      proxyUrl ? `${proxyUrl}${encodeURIComponent(watchTarget)}` : watchTarget,
      { headers: FETCH_HEADERS },
    );
    if (!htmlRes.ok) {
      errors.push(`watchpage${proxyUrl ? '(proxy)' : ''}: HTTP ${htmlRes.status}`);
      return null;
    }
    const html = await htmlRes.text();
    if (!html) {
      errors.push(`watchpage${proxyUrl ? '(proxy)' : ''}: empty HTML`);
      return null;
    }
    const tracks = parseWatchPageCaptions(html);
    if (!tracks) {
      errors.push(`watchpage${proxyUrl ? '(proxy)' : ''}: no ytInitialPlayerResponse captions`);
      return null;
    }
    if (!tracks.length) {
      errors.push(`watchpage${proxyUrl ? '(proxy)' : ''}: captionTracks=[]`);
      return null;
    }

    const source = proxyUrl ? 'proxy' : 'live';
    const candidates: { target: string; label: string }[] = tracks.map((t) => ({
      target: t.baseUrl,
      label: `${source}/watch[${t.languageCode}${t.kind === 'asr' ? '(asr)' : ''}]`,
    }));

    return runFetches(videoId, candidates, fetcher, errors, proxyUrl, source as any);
  } catch (e) {
    errors.push(`watchpage${proxyUrl ? '(proxy)' : ''}: ${(e as Error).message}`);
    return null;
  }
}

/** 统一执行候选请求并解析 json3，可覆盖返回 source（proxy/live） */
async function runFetches(
  videoId: string,
  candidates: Array<{ target: string; label: string }>,
  fetcher: Fetcher,
  errors: string[],
  proxyUrl: string,
  overrideSource?: 'live' | 'proxy',
): Promise<ResolvedSubtitle | null> {
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
      // 双 fallback 解析：
      //   1) json3（手工枚举候选 URL 注入了 fmt=json3 → 走这个分支）
      //   2) TTML XML（watch-page 来的 signed baseUrl，不允许改 fmt，默认返回 TTML）
      const extracted = extractTextFromJson3(text) ?? extractTextFromTtml(text);
      if (extracted) {
        return {
          videoId,
          source: (overrideSource ?? (label.startsWith('proxy/') ? 'proxy' : 'live')) as any,
          text: extracted,
        } as any;
      }
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

/**
 * 从 TTML/XML 字幕格式中提取纯文本（YouTube signed baseUrl 默认返回 TTML XML）。
 * 纯字符串/正则实现，不依赖 DOMParser，在 Cloudflare Worker 中可用。
 *
 * 规则：
 *   - 找所有 <p ...>...</p> 段落，按出现顺序排列
 *   - 每个段落内部：剥离 XML 标签（<span>, <metadata> 等），<br/> / <br /> / <br> 换成换行
 *   - 处理 XML 实体：&amp; &lt; &gt; &quot; &apos; &#NNN; &#xHHH;
 *   - 去除首尾空白和空段落
 */
export function extractTextFromTtml(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;

  // 快速检查：至少要有 <p 标签，否则可能根本不是 TTML
  if (!/<p\b/i.test(raw)) return null;

  // 1) 提取所有 <p ...> 段落（包含嵌套标签）
  // 使用迭代式匹配：找 <p 的起始位置 → 找对应 </p> 结束位置
  const paragraphs: string[] = [];
  const lower = raw;
  let searchFrom = 0;
  while (true) {
    const openStart = lower.indexOf('<p', searchFrom);
    if (openStart < 0) break;
    // 跳过 p 标签的属性到 >
    const openEnd = lower.indexOf('>', openStart);
    if (openEnd < 0) break;

    // 找最近的 </p>（处理嵌套：简单正则足够，TTML 段落不嵌套 p）
    const closeTag = lower.indexOf('</p>', openEnd);
    if (closeTag < 0) break;

    const inner = lower.slice(openEnd + 1, closeTag);
    paragraphs.push(inner);
    searchFrom = closeTag + 4;
  }

  if (!paragraphs.length) return null;

  // 2) 对每个段落：<br/> → 换行；剥去所有 XML 标签；解码实体
  const lines: string[] = [];
  for (const para of paragraphs) {
    let text = para;
    // <br/>, <br />, <br> → \n（保持段落内部换行）
    text = text.replace(/<br\s*\/?>\s*/gi, '\n');
    // 去掉其他所有 <...> 标签（包括 <span>, <style>, <meta> 等，非贪婪）
    text = text.replace(/<\/?[a-zA-Z][^>]*>/g, '');
    // 解码 XML 实体
    text = decodeXmlEntities(text);
    // 段落内部按换行拆分，每行 trim（因为 XML 里可能有 CDATA 换行/缩进）
    const subLines = text.split('\n');
    for (const sl of subLines) {
      const trimmed = sl.trim();
      if (trimmed) lines.push(trimmed);
    }
  }

  if (!lines.length) return null;
  return lines.join('\n');
}

/** 解码 XML 实体：&amp; &lt; &gt; &quot; &apos; + &#NNN; + &#xHHH; */
function decodeXmlEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&') // 必须在最后一步，避免再触发上面的 &xx;
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}
