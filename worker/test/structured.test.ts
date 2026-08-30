import { describe, it, expect, vi } from 'vitest';
import { geminiStructured } from '../src/gemini/structured';

interface Output {
  who: string;
  what: string;
  when: string;
  where: string;
  why: string;
  how: string;
}

const SCHEMA: Record<string, any> = {
  type: 'OBJECT',
  properties: {
    who: { type: 'STRING' },
    what: { type: 'STRING' },
    when: { type: 'STRING' },
    where: { type: 'STRING' },
    why: { type: 'STRING' },
    how: { type: 'STRING' },
  },
  required: ['who', 'what', 'when', 'where', 'why', 'how'],
};

function mockResponse(obj: Output, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => ({
      candidates: [
        {
          content: { parts: [{ text: JSON.stringify(obj) }] },
        },
      ],
    }),
    text: async () => 'err body',
  } as unknown as Response;
}

describe('geminiStructured', () => {
  it('返回映射到 6 字段对象，含正确鉴权与请求体 schema', async () => {
    const calls: Array<{ url: string; headers: Headers; body: any }> = [];
    const fetcher = vi.fn(async (url: any, init: any) => {
      calls.push({
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body)),
      });
      return mockResponse({
        who: 'Mark',
        what: 'AI 行业增长',
        when: '现在',
        where: '全球',
        why: '提效',
        how: '订阅',
      });
    });
    const out = await geminiStructured<Output>({
      apiKey: 'k',
      prompt: 'p',
      schema: SCHEMA,
      fetcher,
    });
    expect(out).toMatchObject({ who: 'Mark', what: 'AI 行业增长', how: '订阅' });
    expect(calls[0].url).toContain(':generateContent');
    expect(calls[0].headers.get('x-goog-api-key')).toBe('k');
    expect(calls[0].body.generationConfig.responseMimeType).toBe('application/json');
    expect(calls[0].body.generationConfig.responseSchema).toEqual(SCHEMA);
    // thinkingConfig removed for gemini-3.6-flash compatibility
  });

  it('带 system 时附 systemInstruction', async () => {
    let body: any;
    const fetcher = vi.fn(async (_u: any, init: any) => {
      body = JSON.parse(String(init.body));
      return mockResponse({ who: 'W', what: 'X', when: 'Y', where: 'Z', why: 'A', how: 'B' });
    });
    await geminiStructured<Output>({
      apiKey: 'k', prompt: 'p', schema: SCHEMA, system: 'sys', fetcher,
    });
    expect(body.systemInstruction.parts[0].text).toBe('sys');
  });

  it('上游失败抛错含状态码', async () => {
    const fetcher = vi.fn(async () => mockResponse({} as Output, false, 429));
    await expect(
      geminiStructured<Output>({ apiKey: 'k', prompt: 'p', schema: SCHEMA, fetcher }),
    ).rejects.toThrow(/429/);
  });

  it('非 JSON 文本抛错', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '不是 json' }] } }],
      }),
      text: async () => '',
    } as unknown as Response));
    await expect(
      geminiStructured<Output>({ apiKey: 'k', prompt: 'p', schema: SCHEMA, fetcher }),
    ).rejects.toThrow(/JSON|parse/i);
  });
});
