import { HARDCODED_SUBTITLES } from './hardcoded';
import { fetchTimedText, fetchThirdPartyTranscript } from './timedtext';

export interface ResolvedSubtitle {
  videoId: string;
  source: 'hardcoded' | 'live';
  text: string;
}

/** 从 YouTube URL 解析 videoId（支持 watch?v= / youtu.be / /shorts/） */
export function parseVideoId(url: string): string | null {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
  return m ? m[1] : null;
}

/**
 * T6 字幕解析：best-effort 实时抓取 → 任何失败（403/解析空/网络异常等）降级硬编码兜底。
 * 生产环境 Cloudflare Worker 访问 YouTube timedtext 会被部分节点判定 bot（触发验证码/403），
 * 所以必须保证硬编码字幕可返回，不让整个 API 5xx。
 *
 * 降级链（按优先级）：
 * 1. YouTube timedtext API + watch page 解析（CF IP 可能被封）
 * 2. 第三方 transcript API（youtube-transcript.ai，非 YouTube 域名不会被封）
 * 3. 硬编码兜底（演示视频白名单）
 *
 * 返回 null ⇔ 即无实时字幕，也未命中硬编码白名单视频。
 */
export async function resolveSubtitle(videoId: string): Promise<ResolvedSubtitle | null> {
  // 1) YouTube 直连 best-effort：不抛，失败吞错误
  try {
    const live = await fetchTimedText(videoId);
    if (live) return live;
  } catch {
    // 吞掉：降级第三方 API
  }

  // 2) 第三方 API fallback（非 YouTube 域名，CF Worker 通常可访问）
  try {
    const text = await fetchThirdPartyTranscript(videoId);
    if (text) return { videoId, source: 'live', text };
  } catch {
    // 吞掉：降级硬编码
  }

  // 3) 硬编码兜底
  const text = HARDCODED_SUBTITLES[videoId];
  if (text) return { videoId, source: 'hardcoded', text };

  return null;
}
