import type { SessionContext } from 'shared';

const TTL_SECONDS = 86_400; // 24h
const KEY_PREFIX = 'sessions/';

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
