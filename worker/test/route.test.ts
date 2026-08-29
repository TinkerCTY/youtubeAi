import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import app from '../src/index';
import type { SessionContext } from 'shared';

// ── 工具：mock R2 bucket（记录 put） ──
function mockBucket(): R2Bucket & { lastPut: { key: string; value: SessionContext } | null } {
  const store = new Map<string, string>();
  const bucket: any = {
    lastPut: null,
    async put(key: string, value: string, opts?: any) {
      bucket.lastPut = { key, value: JSON.parse(value) };
      store.set(key, value);
      return { key };
    },
    async get(key: string) {
      const v = store.get(key);
      return v ? { key, json: async () => JSON.parse(v), text: async () => v } : null;
    },
    head: async () => null,
    delete: async () => {},
    list: async () => ({ objects: [] }),
  };
  return bucket;
}

// ── 工具：mock Gemini SSE 流 ──
function sseLine(text: string): string {
  return `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`;
}

function stubGeminiSse(deltas: string[], ok = true, status = 200): void {
  const encoder = new TextEncoder();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (!ok) return { ok: false, status, body: null, text: async () => 'err' } as unknown as Response;
      const stream = new ReadableStream({
        start(controller) {
          for (const d of deltas) controller.enqueue(encoder.encode(sseLine(d)));
          controller.close();
        },
      });
      return { ok: true, status: 200, body: stream, text: async () => '' } as unknown as Response;
    }),
  );
}

// ── 工具：解析 SSE 文本 → 事件数组 ──
function parseSse(text: string): any[] {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const line = block.trim();
      return line.startsWith('data: ') ? JSON.parse(line.slice(6)) : null;
    })
    .filter(Boolean);
}

const ENV = (bucket: R2Bucket) => ({ GEMINI_API_KEY: 'k', SESSION_BUCKET: bucket });
const DEMO_URL = 'https://www.youtube.com/watch?v=xRh2sVcNXQ8';

describe('POST /api/generate SSE', () => {
  let bucket: R2Bucket & { lastPut: { key: string; value: SessionContext } | null };
  beforeEach(() => (bucket = mockBucket()));
  afterEach(() => vi.unstubAllGlobals());

  it('演示视频 → SSE 事件序列 chapter/text/manifest', async () => {
    stubGeminiSse(['<<CH|第一章>>\n你好', '世界']);
    const res = await app.request(
      '/api/generate',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoUrl: DEMO_URL }) },
      ENV(bucket),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const events = parseSse(await res.text());
    expect(events[0]).toMatchObject({ type: 'chapter', id: '1', title: '第一章' });
    expect(events[1]).toMatchObject({ type: 'text', text: '\n你好' });
    expect(events[2]).toMatchObject({ type: 'text', text: '世界' });
    const manifest = events.find((e) => e.type === 'manifest');
    expect(manifest.sessionId).toBeTruthy();
    expect(manifest.chapters).toEqual([{ id: '1', title: '第一章' }]);
  });

  it('多章节 → manifest 含全部章节', async () => {
    stubGeminiSse(['<<CH|A>>\nt1\n<<CH|B>>\nt2']);
    const res = await app.request(
      '/api/generate',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoUrl: DEMO_URL }) },
      ENV(bucket),
    );
    const events = parseSse(await res.text());
    const manifest = events.find((e) => e.type === 'manifest');
    expect(manifest.chapters).toEqual([
      { id: '1', title: 'A' },
      { id: '2', title: 'B' },
    ]);
  });

  it('R2 落盘 SessionContext（含章节文本）', async () => {
    stubGeminiSse(['<<CH|A>>\ntext']);
    const res = await app.request(
      '/api/generate',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoUrl: DEMO_URL }) },
      ENV(bucket),
    );
    await res.text();

    expect(bucket.lastPut).not.toBeNull();
    expect(bucket.lastPut!.key).toMatch(/^sessions\/.+\.json$/);
    const ctx = bucket.lastPut!.value;
    expect(ctx.videoId).toBe('xRh2sVcNXQ8');
    expect(ctx.subtitleSource).toBe('hardcoded');
    expect(ctx.chapters).toHaveLength(1);
    expect(ctx.chapters[0].title).toBe('A');
    expect(ctx.chapters[0].text).toBe('\ntext');
  });

  it('非法 URL → 400', async () => {
    stubGeminiSse(['x']);
    const res = await app.request(
      '/api/generate',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoUrl: 'bad' }) },
      ENV(bucket),
    );
    expect(res.status).toBe(400);
  });

  it('无字幕 videoId → 404', async () => {
    stubGeminiSse(['x']);
    const res = await app.request(
      '/api/generate',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoUrl: 'https://youtu.be/aaaaaaaaaaa' }) },
      ENV(bucket),
    );
    expect(res.status).toBe(404);
  });

  it('Gemini 失败 → SSE error 事件', async () => {
    stubGeminiSse([], false, 429);
    const res = await app.request(
      '/api/generate',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoUrl: DEMO_URL }) },
      ENV(bucket),
    );
    const events = parseSse(await res.text());
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect(err.message).toContain('429');
  });
});
