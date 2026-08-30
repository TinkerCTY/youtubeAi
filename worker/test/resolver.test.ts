import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseVideoId, resolveSubtitle } from '../src/subtitle/resolver';
import { DEMO_VIDEO_ID } from '../src/subtitle/hardcoded';
import type { Fetcher } from '../src/subtitle/timedtext';

function json3(text: string) {
  const lines = text.split('\n').map((l) => ({ segs: [{ utf8: l }] }));
  return JSON.stringify({ events: lines });
}

function mockFetcher(byLang: Record<string, { ok: boolean; status: number; body: string }>): Fetcher {
  return vi.fn(async (url: any) => {
    const u = String(url);
    const m = u.match(/lang=([^&]+)/);
    const lang = m ? decodeURIComponent(m[1]) : 'xx';
    const r = byLang[lang] ?? { ok: false, status: 404, body: '' };
    return { ok: r.ok, status: r.status, text: async () => r.body } as unknown as Response;
  }) as Fetcher;
}

describe('parseVideoId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
    ['https://youtu.be/xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
    ['https://www.youtube.com/shorts/xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
    ['https://www.youtube.com/watch?v=xRh2sVcNXQ8&t=42s', 'xRh2sVcNXQ8'],
  ])('%s → %s', (url, id) => expect(parseVideoId(url)).toBe(id));

  it('非 YouTube 链接返回 null', () => {
    expect(parseVideoId('https://example.com/foo')).toBeNull();
  });
});

describe('resolveSubtitle (async, T6 fallback)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('T6-b-1 演示 videoId，live 抓取成功 → 返回 source=live，文本来自 timedtext（不降级硬编码）', async () => {
    const fetcher = mockFetcher({
      'zh-Hans': { ok: true, status: 200, body: json3('LIVE抓到\n实时字幕') },
    });
    vi.stubGlobal('fetch', fetcher);
    const sub = await resolveSubtitle(DEMO_VIDEO_ID);
    expect(sub?.source).toBe('live');
    expect(sub?.text).toContain('LIVE抓到');
    expect(sub?.text.length).toBeLessThan(200);
  });

  it('T6-b-2 live 403 验证码 → 降级硬编码，source=hardcoded（兼容旧行为）', async () => {
    const fetcher = mockFetcher({
      'zh-Hans': { ok: false, status: 403, body: '' },
      'zh-CN': { ok: false, status: 403, body: '' },
      'en': { ok: false, status: 403, body: '' },
    });
    vi.stubGlobal('fetch', fetcher);
    const sub = await resolveSubtitle(DEMO_VIDEO_ID);
    expect(sub?.source).toBe('hardcoded');
    expect(sub?.videoId).toBe(DEMO_VIDEO_ID);
    expect(sub?.text.length).toBeGreaterThan(1000);
  });

  it('T6-b-3 live 解析空 + 有硬编码 → 降级硬编码', async () => {
    const fetcher = mockFetcher({
      'zh-Hans': { ok: true, status: 200, body: '{}' },
      'zh-CN': { ok: true, status: 200, body: JSON.stringify({ events: [] }) },
      'en': { ok: true, status: 200, body: '<captcha/>' },
    });
    vi.stubGlobal('fetch', fetcher);
    const sub = await resolveSubtitle(DEMO_VIDEO_ID);
    expect(sub?.source).toBe('hardcoded');
    expect(sub?.text.length).toBeGreaterThan(1000);
  });

  it('T6-b-4 未知 videoId，live 失败也无硬编码 → 返回 null（兼容旧行为）', async () => {
    const fetcher = mockFetcher({
      'zh-Hans': { ok: false, status: 404, body: '' },
      'zh-CN': { ok: false, status: 404, body: '' },
      'en': { ok: false, status: 404, body: '' },
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await resolveSubtitle('unknown00011')).toBeNull();
  });

  it('T6-b-5 未知 videoId 但 live 200 有内容 → source=live（新视频动态可用）', async () => {
    const fetcher = mockFetcher({
      'zh-Hans': { ok: true, status: 200, body: json3('新视频字幕') },
    });
    vi.stubGlobal('fetch', fetcher);
    const sub = await resolveSubtitle('new00000001');
    expect(sub?.source).toBe('live');
    expect(sub?.text).toContain('新视频字幕');
  });

  it('T6-b-6 演示 videoId live CF 层抛异常 → 降级硬编码（保证不炸）', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('Cloudflare Worker outbound failure');
    }) as Fetcher;
    vi.stubGlobal('fetch', fetcher);
    const sub = await resolveSubtitle(DEMO_VIDEO_ID);
    expect(sub?.source).toBe('hardcoded');
  });

  it('T6-b-7 YouTube 全失败 → 第三方 API 成功 → source=live', async () => {
    const fetcher = vi.fn(async (url: any) => {
      const u = String(url);
      // YouTube timedtext/watch page → 全失败
      if (u.includes('youtube.com')) {
        return { ok: false, status: 403, text: async () => '' } as unknown as Response;
      }
      // 第三方 API → 成功
      if (u.includes('youtube-transcript.ai')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            `Title: Test\nSource: https://www.youtube.com/watch?v=third00001\nLanguage: en\n\n[0:01] Third party subtitle text here.`,
        } as unknown as Response;
      }
      return { ok: false, status: 500, text: async () => '' } as unknown as Response;
    }) as Fetcher;
    vi.stubGlobal('fetch', fetcher);
    const sub = await resolveSubtitle('third00001');
    expect(sub?.source).toBe('live');
    expect(sub?.text).toContain('Third party subtitle text');
  });
});
