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
});

/** R2 缓存 + 代理降级测试 */
function mockBucket(): R2Bucket & { store: Map<string, string> } {
  const store = new Map<string, string>();
  const bucket: any = {
    store,
    async put(key: string, value: string) {
      store.set(key, value);
      return { key };
    },
    async get(key: string) {
      const body = store.get(key);
      if (!body) return null;
      return { json: async () => JSON.parse(body), text: async () => body };
    },
  };
  return bucket;
}

describe('resolveSubtitle (R2 cache + proxy)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('R2 缓存命中 → source=cache，不调用 fetch', async () => {
    const bucket = mockBucket();
    await bucket.put('subtitles/cache001.json', JSON.stringify({ videoId: 'cache001', text: '缓存字幕' }));
    const fetcher = vi.fn(async () => {
      throw new Error('should not be called');
    }) as Fetcher;
    vi.stubGlobal('fetch', fetcher);
    const sub = await resolveSubtitle('cache001', { bucket, fetcher });
    expect(sub?.source).toBe('cache');
    expect(sub?.text).toBe('缓存字幕');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('R2 缓存未命中 → 直连成功 → 写入 R2 缓存', async () => {
    const bucket = mockBucket();
    const fetcher = mockFetcher({
      'zh-Hans': { ok: true, status: 200, body: json3('新视频字幕') },
    });
    vi.stubGlobal('fetch', fetcher);
    const sub = await resolveSubtitle('newvid0001', { bucket, fetcher });
    expect(sub?.source).toBe('live');
    expect(sub?.text).toContain('新视频字幕');
    // 验证缓存已写入
    const cached = bucket.store.get('subtitles/newvid0001.json');
    expect(cached).toBeDefined();
    expect(JSON.parse(cached!).text).toContain('新视频字幕');
  });

  it('直连全失败 → 代理降级成功 → source=proxy', async () => {
    const fetcher = vi.fn(async (url: any) => {
      const u = String(url);
      // 直连请求（不含 proxy 前缀）→ 全部 403
      if (!u.startsWith('https://proxy.example/')) {
        return { ok: false, status: 403, text: async () => '' } as unknown as Response;
      }
      // 代理请求 → 返回有效字幕
      return {
        ok: true,
        status: 200,
        text: async () => json3('代理抓到的字幕'),
      } as unknown as Response;
    }) as Fetcher;
    vi.stubGlobal('fetch', fetcher);
    const sub = await resolveSubtitle('proxy001', {
      fetcher,
      proxyUrl: 'https://proxy.example/?url=',
    });
    expect(sub?.source).toBe('proxy');
    expect(sub?.text).toContain('代理抓到的字幕');
  });

  it('直连 + 代理全失败 → 硬编码兜底', async () => {
    const fetcher = vi.fn(async () => {
      return { ok: false, status: 403, text: async () => '' } as unknown as Response;
    }) as Fetcher;
    vi.stubGlobal('fetch', fetcher);
    const sub = await resolveSubtitle(DEMO_VIDEO_ID, {
      fetcher,
      proxyUrl: 'https://proxy.example/?url=',
    });
    expect(sub?.source).toBe('hardcoded');
  });
});
