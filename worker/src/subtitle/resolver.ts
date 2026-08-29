import { HARDCODED_SUBTITLES } from './hardcoded';

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

/** 取字幕：T2 仅硬编码兜底；T6 接入实时抓取与降级 */
export function resolveSubtitle(videoId: string): ResolvedSubtitle | null {
  const text = HARDCODED_SUBTITLES[videoId];
  return text ? { videoId, source: 'hardcoded', text } : null;
}
