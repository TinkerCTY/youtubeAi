import { describe, it, expect, vi } from 'vitest';
import { geminiStream } from '../src/gemini/stream';

/** 构造 SSE 流响应（ReadbleStream + TextEncoder） */
function mockSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream, text: async () => '' } as unknown as Response;
}

function sseData(text: string): string {
  return `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`;
}

describe('geminiStream', () => {
  it('解析 SSE 流并 yield 文本增量', async () => {
    const fetcher = vi.fn(async () => mockSseResponse([sseData('你好'), sseData('，世界')]));
    const chunks: string[] = [];
    for await (const text of geminiStream({ apiKey: 'k', prompt: 'p', fetcher })) {
      chunks.push(text);
    }
    expect(chunks).toEqual(['你好', '，世界']);
  });

  it('跨 chunk 边界的 SSE 事件正确拼接', async () => {
    const full = sseData('hello');
    const mid = Math.floor(full.length / 2);
    const fetcher = vi.fn(async () => mockSseResponse([full.slice(0, mid), full.slice(mid)]));
    const chunks: string[] = [];
    for await (const text of geminiStream({ apiKey: 'k', prompt: 'p', fetcher })) {
      chunks.push(text);
    }
    expect(chunks).toEqual(['hello']);
  });

  it('多 parts 拼接为一条增量', async () => {
    const fetcher = vi.fn(async () =>
      mockSseResponse([
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'A' }, { text: 'B' }] } }] })}\n\n`,
      ]),
    );
    const chunks: string[] = [];
    for await (const text of geminiStream({ apiKey: 'k', prompt: 'p', fetcher })) {
      chunks.push(text);
    }
    expect(chunks).toEqual(['AB']);
  });

  it('带 system 时附 systemInstruction', async () => {
    let body: any;
    const fetcher = vi.fn(async (_url: any, init: any) => {
      body = JSON.parse(String(init.body));
      return mockSseResponse([sseData('ok')]);
    });
    for await (const _ of geminiStream({ apiKey: 'k', prompt: 'p', system: 'sys', fetcher })) { /* drain */ }
    expect(body.systemInstruction.parts[0].text).toBe('sys');
  });

  it('端点含 streamGenerateContent + alt=sse', async () => {
    let url = '';
    const fetcher = vi.fn(async (u: any) => {
      url = String(u);
      return mockSseResponse([sseData('x')]);
    });
    for await (const _ of geminiStream({ apiKey: 'k', prompt: 'p', fetcher })) { /* drain */ }
    expect(url).toContain('streamGenerateContent');
    expect(url).toContain('alt=sse');
  });

  it('鉴权头 x-goog-api-key + thinkingBudget=0', async () => {
    let headers: Headers;
    let body: any;
    const fetcher = vi.fn(async (_url: any, init: any) => {
      headers = new Headers(init.headers);
      body = JSON.parse(String(init.body));
      return mockSseResponse([sseData('x')]);
    });
    for await (const _ of geminiStream({ apiKey: 'mykey', prompt: 'p', fetcher })) { /* drain */ }
    expect(headers!.get('x-goog-api-key')).toBe('mykey');
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(0);
  });

  it('上游失败抛错含状态码', async () => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      status: 429,
      body: null,
      text: async () => 'rate limited',
    } as unknown as Response));
    await expect(async () => {
      for await (const _ of geminiStream({ apiKey: 'k', prompt: 'p', fetcher })) { /* drain */ }
    }).rejects.toThrow(/429/);
  });
});
