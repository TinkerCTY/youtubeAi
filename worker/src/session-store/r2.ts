import type { SessionContext } from 'shared';

const TTL_SECONDS = 86_400; // 24h
const KEY_PREFIX = 'sessions/';
const SUBTTL = 2_592_000; // 30 天
const SUB_PREFIX = 'subtitles/';

/** 写入会话上下文到 R2，设 24h TTL */
export async function putSession(bucket: R2Bucket, ctx: SessionContext): Promise<void> {
  const expires = new Date(Date.now() + TTL_SECONDS * 1000);
  await bucket.put(`${KEY_PREFIX}${ctx.sessionId}.json`, JSON.stringify(ctx), {
    httpMetadata: { cacheExpiry: expires },
  });
}

/** 读取会话上下文；不存在或已过期返回 null */
export async function getSession(bucket: R2Bucket, sessionId: string): Promise<SessionContext | null> {
  const obj = await bucket.get(`${KEY_PREFIX}${sessionId}.json`);
  if (!obj) return null;
  return (await obj.json()) as SessionContext;
}

/** 缓存字幕到 R2（7 天 TTL），避免重复抓取 YouTube */
export async function putSubtitleCache(
  bucket: R2Bucket,
  videoId: string,
  text: string,
): Promise<void> {
  const expires = new Date(Date.now() + SUBTTL * 1000);
  await bucket.put(
    `${SUB_PREFIX}${videoId}.json`,
    JSON.stringify({ videoId, text, cachedAt: Date.now() }),
    { httpMetadata: { cacheExpiry: expires } },
  );
}

/** 读取缓存的字幕；不存在或已过期返回 null */
export async function getSubtitleCache(
  bucket: R2Bucket,
  videoId: string,
): Promise<string | null> {
  const obj = await bucket.get(`${SUB_PREFIX}${videoId}.json`);
  if (!obj) return null;
  const data = (await obj.json()) as { text?: string };
  return data.text ?? null;
}
