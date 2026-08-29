import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import app from '../src/index';
import type { SessionContext, SummaryResponse } from 'shared';

function stubGeminiStructured(out: SummaryResponse, ok = true, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      ({
        ok,
        status,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }],
        }),
        text: async () => '',
      }) as unknown as Response,
    ),
  );
}

function mockBucket(seed?: Record<string, SessionContext>): R2Bucket {
  const store = new Map<string, string>();
  if (seed) for (const [k, v] of Object.entries(seed)) store.set(k, JSON.stringify(v));
  return {
    async get(k: string) {
      const v = store.get(k);
      return v ? { key: k, json: async () => JSON.parse(v) } as unknown as R2ObjectBody : null;
    },
    async put() { return { key: '' } as R2Object; },
    async head() { return null; },
    async delete() {},
    async list() { return { objects: [], delimitedPrefixes: [], truncated: false } as unknown as R2Objects; },
  } as unknown as R2Bucket;
}

const SESSION_ID = 'sess-1';
const CHAPTER = { id: '1', title: '第一章', text: '章节内容正文' };
const VALID_CTX: SessionContext = {
  sessionId: SESSION_ID,
  createdAt: Date.now(),
  videoId: 'xRh2sVcNXQ8',
  subtitleSource: 'hardcoded',
  subtitleText: '字幕全部内容…',
  genReqs: null,
  chapters: [CHAPTER],
};

const ENV = (bucket: R2Bucket) => ({ GEMINI_API_KEY: 'k', SESSION_BUCKET: bucket });

describe('POST /api/summary', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('seeded session + chapter → 200 返回 5W1H 结构化', async () => {
    stubGeminiStructured({
      who: 'W', what: 'X', when: 'Y', where: 'Z', why: 'A', how: 'B',
    });
    const bucket = mockBucket({ [`sessions/${SESSION_ID}.json`]: VALID_CTX });
    const res = await app.request(
      '/api/summary',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSION_ID, chapterId: '1' }),
      },
      ENV(bucket),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const out = (await res.json()) as SummaryResponse;
    expect(out).toMatchObject({ who: 'W', what: 'X', when: 'Y', where: 'Z', why: 'A', how: 'B' });
  });

  it('session 不存在 → 410', async () => {
    stubGeminiStructured({ who: 'W', what: 'X', when: 'Y', where: 'Z', why: 'A', how: 'B' });
    const bucket = mockBucket();
    const res = await app.request(
      '/api/summary',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'nope', chapterId: '1' }),
      },
      ENV(bucket),
    );
    expect(res.status).toBe(410);
    const err = (await res.json()) as { error?: string };
    expect(err.error).toMatch(/session.*expired|gone|410/i);
  });

  it('session 存在但 chapterId 无效 → 422', async () => {
    stubGeminiStructured({ who: 'W', what: 'X', when: 'Y', where: 'Z', why: 'A', how: 'B' });
    const bucket = mockBucket({ [`sessions/${SESSION_ID}.json`]: VALID_CTX });
    const res = await app.request(
      '/api/summary',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSION_ID, chapterId: '999' }),
      },
      ENV(bucket),
    );
    expect(res.status).toBe(422);
    const err = (await res.json()) as { error?: string };
    expect(err.error).toMatch(/chapter|422/i);
  });

  it('缺失 sessionId 或 chapterId → 400', async () => {
    stubGeminiStructured({ who: 'W', what: 'X', when: 'Y', where: 'Z', why: 'A', how: 'B' });
    const bucket = mockBucket();
    const res = await app.request(
      '/api/summary',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      ENV(bucket),
    );
    expect(res.status).toBe(400);
  });

  it('Gemini 失败 → 503', async () => {
    stubGeminiStructured({} as SummaryResponse, false, 429);
    const bucket = mockBucket({ [`sessions/${SESSION_ID}.json`]: VALID_CTX });
    const res = await app.request(
      '/api/summary',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSION_ID, chapterId: '1' }),
      },
      ENV(bucket),
    );
    expect(res.status).toBe(503);
    const err = (await res.json()) as { error?: string };
    expect(err.error).toContain('gemini');
  });
});
