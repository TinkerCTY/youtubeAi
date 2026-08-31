import { describe, it, expect, vi } from 'vitest';
import { fetchTimedText, type Fetcher, parseWatchPageCaptions } from '../src/subtitle/timedtext';

/** 伪造 json3 响应体 */
function json3Payload(events: Array<{ segs: Array<{ utf8: string }> }>): string {
  return JSON.stringify({ events });
}

/** 简化 mock：按顺序返回响应，不检查 URL 匹配 */
function mockFetcher(responses: Array<{ ok: boolean; status: number; body: string }>): Fetcher {
  let i = 0;
  return vi.fn(async (_url: any, _init?: any) => {
    const r = responses[i++];
    if (!r) return { ok: false, status: 500, text: async () => 'no more mocks' } as unknown as Response;
    return {
      ok: r.ok,
      status: r.status,
      text: async () => r.body,
    } as unknown as Response;
  }) as Fetcher;
}

describe('fetchTimedText', () => {
  const VID = 'abc00000001';

  it('T6-a-1 zh-Hans json3 命中 → 拼接 seg.utf8 用换行并标记 source=live', async () => {
    const fetcher = mockFetcher([
      {
        ok: true,
        status: 200,
        body: json3Payload([
          { segs: [{ utf8: '第一句：' }, { utf8: '我们聊聊 AI。' }] },
          { segs: [{ utf8: '第二句，成本暴跌。' }] },
        ]),
      },
    ]);
    const sub = await fetchTimedText(VID, { fetcher, languages: ['zh-Hans'] });
    expect(sub.videoId).toBe(VID);
    expect(sub.source).toBe('live');
    // 每个 event 一行；同 event 内 seg 直接拼接
    expect(sub.text).toContain('第一句：我们聊聊 AI。');
    expect(sub.text).toContain('第二句，成本暴跌。');
    expect(sub.text).toMatch(/\n/);
  });

  it('T6-a-2 YouTube 403（验证码/机器人）→ 抛错，触发上层降级', async () => {
    // 默认 5 语言 × 2 kind + 1 default = 11 次请求，全返回 403
    const responses = Array.from({ length: 11 }, () => ({
      ok: false,
      status: 403,
      body: '',
    }));
    const fetcher = mockFetcher(responses);
    await expect(fetchTimedText(VID, { fetcher })).rejects.toThrow(/403|timedtext/);
  });

  it('T6-a-3 返回非预期 JSON（{} 缺 events）→ 抛错并降级', async () => {
    const responses = Array.from({ length: 11 }, (_, i) => ({
      ok: true,
      status: 200,
      body: i === 0 ? '{}' : i === 1 ? '{"events":null}' : '<html>captcha</html>',
    }));
    const fetcher = mockFetcher(responses);
    await expect(fetchTimedText(VID, { fetcher })).rejects.toThrow(/parse|empty|timedtext/);
  });

  it('T6-a-4 返回 events 但所有 segs 空/全是纯空白 → 抛错 empty', async () => {
    const emptyPayload = json3Payload([{ segs: [{ utf8: ' ' }] }, { segs: [{ utf8: '\n' }] }]);
    const responses = Array.from({ length: 11 }, () => ({
      ok: true,
      status: 200,
      body: emptyPayload,
    }));
    const fetcher = mockFetcher(responses);
    await expect(fetchTimedText(VID, { fetcher })).rejects.toThrow(/empty|timedtext/);
  });

  it('T6-a-5 zh-Hans 手动+asr 均失败 → 回退 zh-CN 成功', async () => {
    const fetcher = mockFetcher([
      { ok: false, status: 404, body: '' }, // zh-Hans manual
      { ok: false, status: 404, body: '' }, // zh-Hans asr
      {
        ok: true,
        status: 200,
        body: json3Payload([{ segs: [{ utf8: '中文简体字幕' }] }]),
      }, // zh-CN manual → 成功
    ]);
    const sub = await fetchTimedText(VID, { fetcher });
    expect(sub.source).toBe('live');
    expect(sub.text).toContain('中文简体字幕');
  });

  it('T6-a-6 fetch 抛异常（CF 网络层）→ 抛错并降级', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('CF FetchFailed');
    }) as Fetcher;
    await expect(fetchTimedText(VID, { fetcher })).rejects.toThrow(/CF FetchFailed/);
  });

  it('T6-a-7 kind=asr 自动字幕命中（手动字幕不存在时）', async () => {
    const fetcher = mockFetcher([
      { ok: true, status: 200, body: '{}' }, // zh-Hans manual → 空
      {
        ok: true,
        status: 200,
        body: json3Payload([{ segs: [{ utf8: '自动生成的字幕' }] }]),
      }, // zh-Hans asr → 成功
    ]);
    const sub = await fetchTimedText(VID, { fetcher, languages: ['zh-Hans'] });
    expect(sub.source).toBe('live');
    expect(sub.text).toContain('自动生成的字幕');
  });

  it('T6-a-8 所有语言均失败 → default 无语言参数兜底成功', async () => {
    const fetcher = mockFetcher([
      { ok: false, status: 404, body: '' }, // zh-Hans manual
      { ok: false, status: 404, body: '' }, // zh-Hans asr
      { ok: false, status: 404, body: '' }, // zh-CN manual
      { ok: false, status: 404, body: '' }, // zh-CN asr
      {
        ok: true,
        status: 200,
        body: json3Payload([{ segs: [{ utf8: '默认字幕' }] }]),
      }, // default → 成功
    ]);
    const sub = await fetchTimedText(VID, { fetcher, languages: ['zh-Hans', 'zh-CN'] });
    expect(sub.source).toBe('live');
    expect(sub.text).toContain('默认字幕');
  });
});

/* ───────────── T6-b: ytInitialPlayerResponse watch page parser ───────────── */

/** 构造一段包含 ytInitialPlayerResponse 的「伪 YouTube watch HTML」，内含 2 条 captionTracks */
function buildWatchHtml(playerResponse: unknown, injectError = false): string {
  const json = JSON.stringify(playerResponse);
  const before = `<!DOCTYPE html><html><head><title>demo</title></head><body>
    <script>var ytInitialPlayerResponse = ${json};</script>
    <script>other stuff</script>
  `;
  const after = '</body></html>';
  if (injectError) return before.replace('var ytInitialPlayerResponse', 'var ytInitial = 123; var ytInitialPlayerResponse');
  return before + after;
}

describe('parseWatchPageCaptions (from ytInitialPlayerResponse)', () => {
  it('T6-b-1 正常解析，返回 captionTracks + 自动给 baseUrl 补 &fmt=json3，优先 zh 系列', () => {
    const player = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: 'https://www.youtube.com/api/timedtext?lang=en&v=abc&x=1',
              name: { simpleText: 'English' },
              languageCode: 'en',
              kind: 'asr',
              vssId: 'a.en',
            },
            {
              baseUrl: 'https://www.youtube.com/api/timedtext?lang=zh-CN&v=abc&x=2',
              name: { simpleText: '中文 (简体)' },
              languageCode: 'zh-CN',
              vssId: '.zh-CN',
            },
            {
              baseUrl: 'https://www.youtube.com/api/timedtext?lang=zh-Hant&v=abc&x=3',
              name: { simpleText: '中文 (繁體)' },
              languageCode: 'zh-Hant',
              vssId: '.zh-Hant',
            },
            {
              baseUrl: '/relative/path?lang=zh-Hans',
              name: { simpleText: '简体（相对路径）' },
              languageCode: 'zh-Hans',
              vssId: '.zh-Hans',
            },
          ],
        },
      },
    };
    const html = buildWatchHtml(player);
    const tracks = parseWatchPageCaptions(html);
    expect(tracks).toBeDefined();
    expect(tracks!.length).toBeGreaterThanOrEqual(4);

    // 第一个应该是 zh 语言（不是 en）
    expect(tracks![0].languageCode).toMatch(/^zh/);

    // 每个 baseUrl 都必须带 fmt=json3
    for (const t of tracks!) {
      expect(t.baseUrl).toContain('fmt=json3');
    }

    // 相对路径以 https://www.youtube.com 开头（补齐）
    const rel = tracks!.find((t) => t.languageCode === 'zh-Hans')!;
    expect(rel.baseUrl.startsWith('https://www.youtube.com')).toBe(true);

    // en 仍然在列表里（排序靠后也 OK）
    const en = tracks!.find((t) => t.languageCode === 'en');
    expect(en).toBeDefined();
  });

  it('T6-b-2 无 captions 对象 → 返回 undefined/null', () => {
    const html = buildWatchHtml({ videoDetails: { title: 'no captions' } });
    expect(parseWatchPageCaptions(html)).toBeNull();
  });

  it('T6-b-3 无法解析 ytInitialPlayerResponse（JSON 损坏）→ 返回 null 不抛错', () => {
    const html = `<html><head></head><body><script>var ytInitialPlayerResponse = {broken json;;</script></body></html>`;
    expect(parseWatchPageCaptions(html)).toBeNull();
  });

  it('T6-b-4 captionTracks 是空数组 → 返回空数组，caller 自己判断 empty', () => {
    const html = buildWatchHtml({
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
    });
    expect(parseWatchPageCaptions(html)).toEqual([]);
  });
});

describe('fetchTimedText with watch-page fallback (captions parser)', () => {
  const VID2 = 'demowatch123';

  it('T6-b-5 手工枚举 11 条候选全失败 → 自动拉 watch page → 解析 captionTracks → 返回 proxy 成功', async () => {
    // watch HTML（zh-CN 1 条字幕）
    const finalCaptionsBase = 'https://www.youtube.com/api/timedtext?lang=zh-CN&v=' + VID2 + '&sparams=SIGN';
    const watchPlayer = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: finalCaptionsBase,
              languageCode: 'zh-CN',
              name: { simpleText: '中文' },
              vssId: '.zh-CN',
            },
          ],
        },
      },
    };
    const watchHtml = buildWatchHtml(watchPlayer);

    // Mock fetcher:
    // Phase 1 (candidate URLs, direct): 前 11 次 = 全 empty（和真实世界一样）
    // Phase 2 (candidate URLs through proxy): 接下来 11 次 = 还是全 empty（证明旧方法失败）
    // Phase 3 (watch page): 1 次 = 返回 watchHtml
    // Phase 4 (final json3 fetch): 1 次 = 返回真实 json3
    const responses: Array<{ ok: boolean; status: number; body: string }> = [
      ...Array.from({ length: 11 }, () => ({ ok: true, status: 200, body: '{}' })), // Phase1 direct = empty (11)
      ...Array.from({ length: 11 }, () => ({ ok: true, status: 200, body: '{}' })), // Phase2 proxy/enum = empty (11)
      { ok: true, status: 200, body: watchHtml }, // Phase3 = watch page HTML
      {
        ok: true,
        status: 200,
        body: json3Payload([
          { segs: [{ utf8: '第一部分 Marc，我们到底处于 AI 第几局？' }] },
          { segs: [{ utf8: '第二部分 字幕抓取自 watch page parser，成功。' }] },
        ]),
      }, // Phase4 = final captions json3
    ];
    const calls: Array<string> = [];
    const fetcher = vi.fn(async (url: any, init?: any) => {
      calls.push(String(url));
      const r = responses.shift();
      if (!r) return { ok: false, status: 500, text: async () => 'out of mocks' } as unknown as Response;
      return { ok: r.ok, status: r.status, text: async () => r.body } as unknown as Response;
    }) as Fetcher;

    const sub = await fetchTimedText(VID2, { fetcher, proxyUrl: 'https://relay.example.com/?url=' });
    expect(sub.videoId).toBe(VID2);
    expect(sub.source).toBe('proxy');
    expect(sub.text).toContain('AI 第几局');
    expect(sub.text).toContain('watch page parser');

    // 最后一次请求必须是 finalCaptionsBase（加上 fmt=json3 参数）
    // 注意：proxy 模式下 buildUrl 会对 target 做 encodeURIComponent，所以断言也要用编码后的值
    const lastCall = calls[calls.length - 1];
    expect(lastCall).toContain(encodeURIComponent(finalCaptionsBase));
    expect(lastCall).toContain(encodeURIComponent('fmt=json3'));
    // 同时确认代理前缀正确
    expect(lastCall.startsWith('https://relay.example.com/?url=')).toBe(true);
  });
});
