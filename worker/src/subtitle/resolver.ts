import { HARDCODED_SUBTITLES } from './hardcoded';
import { fetchTimedText } from './timedtext';
import { getSubtitleCache, putSubtitleCache } from '../session-store/r2';

export interface ResolvedSubtitle {
  videoId: string;
  source: 'hardcoded' | 'live' | 'cache' | 'proxy';
  text: string;
}

export interface ResolveOptions {
  /** R2 存储桶，用于字幕缓存 */
  bucket?: R2Bucket;
  /** 代理转发 URL 前缀（直连失败后降级） */
  proxyUrl?: string;
  /** 测试用 fetch 注入 */
  fetcher?: typeof fetch;
}

/** 从 YouTube URL 解析 videoId（支持 watch?v= / youtu.be / /shorts/） */
export function parseVideoId(url: string): string | null {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
  return m ? m[1] : null;
}

/**
 * 字幕解析策略（4 层降级）：
 * 1. R2 缓存（命中 → 秒返回，7 天 TTL）
 * 2. 直连 YouTube timedtext（并行 11 请求）
 * 3. 代理转发（直连全失败且配置了 proxyUrl 时）
 * 4. 硬编码兜底（仅演示视频）
 *
 * 返回 null ⇔ 以上 4 层全部未命中。
 */
export async function resolveSubtitle(
  videoId: string,
  opts: ResolveOptions = {},
): Promise<ResolvedSubtitle | null> {
  // 1) R2 缓存：避免重复抓取
  if (opts.bucket) {
    try {
      const cached = await getSubtitleCache(opts.bucket, videoId);
      if (cached) return { videoId, source: 'cache', text: cached };
    } catch (_e) {
      // R2 读取失败不影响后续流程
    }
  }

  // 2) + 3) 直连 YouTube → 代理降级
  try {
    const live = await fetchTimedText(videoId, {
      fetcher: opts.fetcher,
      proxyUrl: opts.proxyUrl,
    });
    if (live) {
      // 抓取成功 → 写入 R2 缓存
      if (opts.bucket) {
        try {
          await putSubtitleCache(opts.bucket, videoId, live.text);
        } catch (_e) {
          // 缓存写入失败不影响主流程
        }
      }
      return live;
    }
  } catch (_e) {
    // 吞掉：降级硬编码
  }

  // 4) 硬编码兜底
  const text = HARDCODED_SUBTITLES[videoId];
  if (text) return { videoId, source: 'hardcoded', text };

  return null;
}
