import { HARDCODED_SUBTITLES } from './hardcoded';
import { fetchTimedText, fetchViaCorsProxy, fetchThirdPartyTranscript } from './timedtext';

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
 * T6 字幕解析：best-effort 实时抓取 → 任何失败降级硬编码兜底。
 *
 * 降级链（按优先级）：
 * 1. YouTube timedtext API + watch page 解析（CF IP 可能被封）
 * 2. CORS 代理（allorigins.win 中转，非 YouTube 域名）
 * 3. 第三方 transcript API（youtube-transcript.ai）
 * 4. 硬编码兜底（演示视频白名单）
 *
 * 返回 null ⇔ 即无实时字幕，也未命中硬编码白名单视频。
 */
export async function resolveSubtitle(videoId: string): Promise<ResolvedSubtitle | null> {
  // 1) YouTube 直连 best-effort
  try {
    const live = await fetchTimedText(videoId);
    if (live) return live;
  } catch {
    // 降级 CORS 代理
  }

  // 2) CORS 代理 fallback
  try {
    const text = await fetchViaCorsProxy(videoId);
    if (text) return { videoId, source: 'live', text };
  } catch {
    // 降级第三方 API
  }

  // 3) 第三方 API fallback
  try {
    const text = await fetchThirdPartyTranscript(videoId);
    if (text) return { videoId, source: 'live', text };
  } catch {
    // 降级硬编码
  }

  // 4) 硬编码兜底
  const text = HARDCODED_SUBTITLES[videoId];
  if (text) return { videoId, source: 'hardcoded', text };

  return null;
}

/**
 * 调试：逐策略测试字幕抓取结果
 * 返回每个策略的 success/error 信息，帮助诊断 CF Worker 网络环境
 */
export async function debugSubtitle(videoId: string): Promise<{
  videoId: string;
  strategies: Array<{ name: string; success: boolean; detail: string; textLength?: number }>;
}> {
  const strategies: Array<{ name: string; success: boolean; detail: string; textLength?: number }> = [];

  // 1) YouTube 直连
  try {
    const live = await fetchTimedText(videoId);
    strategies.push({ name: 'youtube-direct', success: true, detail: 'OK', textLength: live.text.length });
  } catch (e) {
    strategies.push({ name: 'youtube-direct', success: false, detail: (e as Error).message.slice(0, 200) });
  }

  // 2) CORS 代理
  try {
    const text = await fetchViaCorsProxy(videoId);
    if (text) {
      strategies.push({ name: 'cors-proxy', success: true, detail: 'OK', textLength: text.length });
    } else {
      strategies.push({ name: 'cors-proxy', success: false, detail: 'returned null' });
    }
  } catch (e) {
    strategies.push({ name: 'cors-proxy', success: false, detail: (e as Error).message.slice(0, 200) });
  }

  // 3) 第三方 API
  try {
    const text = await fetchThirdPartyTranscript(videoId);
    if (text) {
      strategies.push({ name: 'third-party', success: true, detail: 'OK', textLength: text.length });
    } else {
      strategies.push({ name: 'third-party', success: false, detail: 'returned null' });
    }
  } catch (e) {
    strategies.push({ name: 'third-party', success: false, detail: (e as Error).message.slice(0, 200) });
  }

  // 4) 硬编码
  const hardcoded = HARDCODED_SUBTITLES[videoId];
  if (hardcoded) {
    strategies.push({ name: 'hardcoded', success: true, detail: 'found', textLength: hardcoded.length });
  } else {
    strategies.push({ name: 'hardcoded', success: false, detail: 'not in whitelist' });
  }

  return { videoId, strategies };
}
