import { HARDCODED_SUBTITLES } from './hardcoded';
import { fetchTimedText } from './timedtext';

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
 * 返回 null ⇔ 即无实时字幕，也未命中硬编码白名单视频。
 */
export async function resolveSubtitle(videoId: string): Promise<ResolvedSubtitle | null> {
  // 1) Live best-effort：不抛，失败吞错误转 null
  try {
    const live = await fetchTimedText(videoId);
    if (live) return live;
  } catch (_e) {
    // 吞掉：降级硬编码；生产可加日志
  }

  // 2) 硬编码兜底
  const text = HARDCODED_SUBTITLES[videoId];
  if (text) return { videoId, source: 'hardcoded', text };

  return null;
}
