import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import app from '../src/index';
import type { GenReqs, SessionContext } from 'shared';

// ── 工具：mock R2 bucket（记录 put + 暴露 lastPut.value.genReqs） ──
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
    list: async () => ({ objects: [], delimitedPrefixes: [], truncated: false } as unknown as R2Objects),
  };
  return bucket;
}

function sseLine(text: string): string {
  return `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`;
}

/** 记录 fetch 调用的 body，断言 genReqs 确实传给了 Gemini */
interface CapturedCall { url: string; body: any }
function stubGeminiCapture(deltas: string[]): { calls: CapturedCall[] } {
  const encoder = new TextEncoder();
  const calls: CapturedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      const stream = new ReadableStream({
        start(controller) {
          for (const d of deltas) controller.enqueue(encoder.encode(sseLine(d)));
          controller.close();
        },
      });
      return { ok: true, status: 200, body: stream, text: async () => '' } as unknown as Response;
    }),
  );
  return { calls };
}

const ENV = (bucket: R2Bucket) => ({ GEMINI_API_KEY: 'k', SESSION_BUCKET: bucket });
const DEMO_URL = 'https://www.youtube.com/watch?v=xRh2sVcNXQ8';
const REQS: GenReqs = {
  taskType: '会议纪要',
  style: '幽默段子体',
  audience: '初中生',
  constraints: '禁用人身攻击',
};

describe('T4: GenReqs 生成要求全链路加固', () => {
  let bucket: ReturnType<typeof mockBucket>;
  beforeEach(() => (bucket = mockBucket()));
  afterEach(() => vi.unstubAllGlobals());

  it('T4-a: POST /api/generate 带 genReqs → R2 SessionContext 正确保存 genReqs', async () => {
    stubGeminiCapture(['<<CH|A>>\nx']);
    const res = await app.request('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoUrl: DEMO_URL, genReqs: REQS }),
    }, ENV(bucket));
    await res.text();
    expect(bucket.lastPut).not.toBeNull();
    expect(bucket.lastPut!.value.genReqs).toEqual(REQS);
  });

  it('T4-a: Gemini 请求体中 contents[0].parts[0].text 含全部 4 项生成要求', async () => {
    const { calls } = stubGeminiCapture(['<<CH|A>>\nx']);
    const res = await app.request('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoUrl: DEMO_URL, genReqs: REQS }),
    }, ENV(bucket));
    await res.text();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const userText: string = calls[0].body.contents[0].parts[0].text;
    expect(userText).toContain('任务类型：会议纪要');
    expect(userText).toContain('输出风格：幽默段子体');
    expect(userText).toContain('目标受众：初中生');
    expect(userText).toContain('约束条件：禁用人身攻击');
  });

  it('T4-a: 不传 genReqs → R2 存 null，Gemini prompt 不含【生成要求】段', async () => {
    const { calls } = stubGeminiCapture(['<<CH|A>>\nx']);
    const res = await app.request('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoUrl: DEMO_URL }),
    }, ENV(bucket));
    await res.text();
    expect(bucket.lastPut!.value.genReqs).toBeNull();
    const userText: string = calls[0].body.contents[0].parts[0].text;
    expect(userText).not.toContain('【生成要求】');
  });

  it('T4-b: systemInstruction（ARTICLE_SYSTEM）显式声明"严格遵守生成要求、不越界"', async () => {
    const { calls } = stubGeminiCapture(['<<CH|A>>\nx']);
    const res = await app.request('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoUrl: DEMO_URL, genReqs: { style: '正式公文' } }),
    }, ENV(bucket));
    await res.text();
    const sys: string = calls[0].body.systemInstruction.parts[0].text;
    expect(sys).toMatch(/严格遵守[^\n]{0,80}生成要求/);
    expect(sys).toMatch(/不(得)?超出[^\n]{0,40}(要求|约束|范围)/);
    // 还必须提到 style/audience/taskType/constraints 这些维度的遵守
    expect(sys).toMatch(/风格|受众|任务类型|约束/);
  });

  it('T4-b: Gemini prompt 中生成要求段带强约束措辞（"必须遵守/违者视为不合格"）', async () => {
    const { calls } = stubGeminiCapture(['<<CH|A>>\nx']);
    const res = await app.request('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoUrl: DEMO_URL, genReqs: REQS }),
    }, ENV(bucket));
    await res.text();
    const userText: string = calls[0].body.contents[0].parts[0].text;
    expect(userText).toMatch(/必须(严格)?遵守/);
  });
});
