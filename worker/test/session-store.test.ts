import { describe, it, expect } from 'vitest';
import type { SessionContext } from 'shared';
import { putSession, getSession, putSubtitleCache, getSubtitleCache } from '../src/session-store/r2';

/** 极简 in-memory R2 模拟，记录最后一次 put 的 key/httpMetadata */
function mockBucket(): R2Bucket & { lastPut: { key: string; meta?: R2HTTPMetadata } | null } {
  const store = new Map<string, { body: string; meta: R2HTTPMetadata }>();
  const bucket: any = {
    lastPut: null,
    async put(key: string, value: string, options?: { httpMetadata?: R2HTTPMetadata }) {
      const meta = options?.httpMetadata ?? {};
      bucket.lastPut = { key, meta };
      store.set(key, { body: value, meta });
      return { key };
    },
    async get(key: string) {
      const obj = store.get(key);
      if (!obj) return null;
      return {
        key,
        httpMetadata: obj.meta,
        body: null,
        json: async () => JSON.parse(obj.body),
        text: async () => obj.body,
      };
    },
    head: async () => null,
    delete: async () => {},
    list: async () => ({ objects: [] }),
  };
  return bucket;
}

const sampleCtx = (): SessionContext => ({
  sessionId: 'abc123',
  createdAt: Date.now(),
  videoId: 'xRh2sVcNXQ8',
  subtitleSource: 'hardcoded',
  subtitleText: '你好世界',
  genReqs: null,
  chapters: [{ id: '1', title: '第一章', text: '内容' }],
});

describe('session-store/r2', () => {
  it('put 后 get 能取回完整 SessionContext', async () => {
    const bucket = mockBucket();
    await putSession(bucket, sampleCtx());
    const got = await getSession(bucket, 'abc123');
    expect(got).not.toBeNull();
    expect(got!.sessionId).toBe('abc123');
    expect(got!.videoId).toBe('xRh2sVcNXQ8');
    expect(got!.chapters).toHaveLength(1);
    expect(got!.chapters[0].title).toBe('第一章');
  });

  it('get 不存在的 session → null', async () => {
    const bucket = mockBucket();
    const got = await getSession(bucket, 'nope');
    expect(got).toBeNull();
  });

  it('put 写入 key 格式为 sessions/{sessionId}.json', async () => {
    const bucket = mockBucket();
    await putSession(bucket, sampleCtx());
    expect(bucket.lastPut!.key).toBe('sessions/abc123.json');
  });

  it('put 设 httpMetadata.expires（TTL 24h）', async () => {
    const bucket = mockBucket();
    const before = Date.now();
    await putSession(bucket, sampleCtx());
    const expires = bucket.lastPut!.meta?.cacheExpiry;
    expect(expires).toBeInstanceOf(Date);
    const expiryMs = (expires as Date).getTime();
    const dayMs = 86_400_000;
    expect(expiryMs).toBeGreaterThan(before + 23 * 3_600_000);
    expect(expiryMs).toBeLessThan(before + 25 * 3_600_000);
  });
});

describe('subtitle cache (r2)', () => {
  it('putSubtitleCache 后 getSubtitleCache 能取回字幕文本', async () => {
    const bucket = mockBucket();
    await putSubtitleCache(bucket, 'vid001', '这是缓存的字幕文本');
    const text = await getSubtitleCache(bucket, 'vid001');
    expect(text).toBe('这是缓存的字幕文本');
  });

  it('getSubtitleCache 不存在 → null', async () => {
    const bucket = mockBucket();
    const text = await getSubtitleCache(bucket, 'nope');
    expect(text).toBeNull();
  });

  it('putSubtitleCache 写入 key 格式为 subtitles/{videoId}.json', async () => {
    const bucket = mockBucket();
    await putSubtitleCache(bucket, 'vid002', '字幕');
    expect(bucket.lastPut!.key).toBe('subtitles/vid002.json');
  });

  it('putSubtitleCache 设 TTL 30 天', async () => {
    const bucket = mockBucket();
    const before = Date.now();
    await putSubtitleCache(bucket, 'vid003', '字幕');
    const expires = bucket.lastPut!.meta?.cacheExpiry;
    expect(expires).toBeInstanceOf(Date);
    const expiryMs = (expires as Date).getTime();
    expect(expiryMs).toBeGreaterThan(before + 29 * 86_400_000);
    expect(expiryMs).toBeLessThan(before + 31 * 86_400_000);
  });
});
