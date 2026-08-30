import { describe, it, expect, vi } from 'vitest';
import { geminiGenerate } from '../src/gemini/generate';

function mockResponse(parts: { text?: string }[], ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => ({ candidates: [{ content: { parts } }] }),
    text: async () => 'err body',
  } as unknown as Response;
}

describe('geminiGenerate', () => {
  it('拼接 parts 文本并带正确鉴权与请求体', async () => {
    const calls: Array<{ url: string; headers: Headers; body: any }> = [];
    const fetcher = vi.fn(async (url: any, init: any) => {
      calls.push({
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body)),
      });
      return mockResponse([{ text: '你好' }, { text: '，世界' }]);
    });
    const out = await geminiGenerate({ apiKey: 'k', prompt: 'p', fetcher });
    expect(out).toBe('你好，世界');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(calls[0].url).toContain(':generateContent');
    expect(calls[0].headers.get('x-goog-api-key')).toBe('k');
    expect(calls[0].body.contents[0].parts[0].text).toBe('p');
    // thinkingConfig removed for gemini-3.6-flash compatibility
  });

  it('含 system 时附 systemInstruction', async () => {
    let body: any;
    const fetcher = vi.fn(async (_url: any, init: any) => {
      body = JSON.parse(String(init.body));
      return mockResponse([{ text: 'ok' }]);
    });
    await geminiGenerate({ apiKey: 'k', prompt: 'p', system: 'sys', fetcher });
    expect(body.systemInstruction.parts[0].text).toBe('sys');
  });

  it('上游失败抛错含状态码', async () => {
    const fetcher = vi.fn(async () => mockResponse([], false, 429));
    await expect(geminiGenerate({ apiKey: 'k', prompt: 'p', fetcher })).rejects.toThrow(/429/);
  });
});
