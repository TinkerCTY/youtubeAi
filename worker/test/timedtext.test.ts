import { describe, it, expect, vi } from 'vitest';
import { fetchTimedText, fetchThirdPartyTranscript, type Fetcher } from '../src/subtitle/timedtext';

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

/** 构造模拟 watch page HTML（含 ytInitialPlayerResponse + caption tracks） */
function watchPageHtml(tracks: Array<{ languageCode: string; baseUrl: string }>): string {
  const playerResponse = JSON.stringify({
    captions: { playerCaptionsTrackRendererTracklist: tracks },
  });
  return `<html><body><script>var ytInitialPlayerResponse = ${playerResponse};</script></body></html>`;
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
    expect(sub.text).toContain('第一句：我们聊聊 AI。');
    expect(sub.text).toContain('第二句，成本暴跌。');
    expect(sub.text).toMatch(/\n/);
  });

  it('T6-a-2 YouTube 403（验证码/机器人）→ 抛错，触发上层降级', async () => {
    // 默认 5 语言 × 2 kind + 1 default = 11 次 API 请求 + 1 watch page = 12 次全失败
    const responses = Array.from({ length: 12 }, () => ({ ok: false, status: 403, body: '' }));
    const fetcher = mockFetcher(responses);
    await expect(fetchTimedText(VID, { fetcher })).rejects.toThrow(/403|timedtext/);
  });

  it('T6-a-3 返回非预期 JSON（{} 缺 events）→ 抛错并降级', async () => {
    const responses = Array.from({ length: 12 }, (_, i) => ({
      ok: true,
      status: 200,
      body: i < 11 ? '{}' : '<html>no player response</html>',
    }));
    const fetcher = mockFetcher(responses);
    await expect(fetchTimedText(VID, { fetcher })).rejects.toThrow(/parse|empty|timedtext|not found/);
  });

  it('T6-a-4 返回 events 但所有 segs 空/全是纯空白 → 抛错 empty', async () => {
    const emptyPayload = json3Payload([{ segs: [{ utf8: ' ' }] }, { segs: [{ utf8: '\n' }] }]);
    const responses = Array.from({ length: 12 }, () => ({
      ok: true,
      status: 200,
      body: emptyPayload,
    }));
    const fetcher = mockFetcher(responses);
    await expect(fetchTimedText(VID, { fetcher })).rejects.toThrow(/empty|timedtext|not found/);
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

  it('T6-a-9 timedtext API 全失败 → watch page 解析成功提取字幕', async () => {
    const html = watchPageHtml([
      { languageCode: 'zh-CN', baseUrl: 'https://caption.example.com/zh' },
      { languageCode: 'en', baseUrl: 'https://caption.example.com/en' },
    ]);
    const fetcher = mockFetcher([
      // timedtext API（单语言 × 2 kind + default = 3 次全失败）
      { ok: false, status: 403, body: '' },
      { ok: false, status: 403, body: '' },
      { ok: false, status: 403, body: '' },
      // watch page HTML
      { ok: true, status: 200, body: html },
      // caption track URL → json3 字幕
      {
        ok: true,
        status: 200,
        body: json3Payload([{ segs: [{ utf8: '从 watch page 提取的字幕内容' }] }]),
      },
    ]);
    const sub = await fetchTimedText(VID, { fetcher, languages: ['zh-Hans'] });
    expect(sub.source).toBe('live');
    expect(sub.text).toContain('从 watch page 提取的字幕内容');
  });

  it('T6-a-10 watch page 返回 HTML 但无 caption tracks → 抛错', async () => {
    const html = `<html><script>var ytInitialPlayerResponse = ${JSON.stringify({
      captions: { playerCaptionsTrackRendererTracklist: [] },
    })};</script></html>`;
    const fetcher = mockFetcher([
      // timedtext API 全失败
      { ok: false, status: 403, body: '' },
      { ok: false, status: 403, body: '' },
      { ok: false, status: 403, body: '' },
      // watch page HTML → 无 caption tracks
      { ok: true, status: 200, body: html },
    ]);
    await expect(
      fetchTimedText(VID, { fetcher, languages: ['zh-Hans'] }),
    ).rejects.toThrow(/no caption tracks|timedtext/);
  });

  it('T6-a-11 watch page 优先选择中文字幕（排序验证）', async () => {
    const html = watchPageHtml([
      { languageCode: 'en', baseUrl: 'https://caption.example.com/en' },
      { languageCode: 'zh-CN', baseUrl: 'https://caption.example.com/zh' },
    ]);
    const fetcher = mockFetcher([
      // timedtext API 全失败
      { ok: false, status: 403, body: '' },
      { ok: false, status: 403, body: '' },
      { ok: false, status: 403, body: '' },
      // watch page HTML
      { ok: true, status: 200, body: html },
      // 第一个 caption track URL（zh-CN 排序在前）
      {
        ok: true,
        status: 200,
        body: json3Payload([{ segs: [{ utf8: '中文字幕优先' }] }]),
      },
    ]);
    const sub = await fetchTimedText(VID, { fetcher, languages: ['zh-Hans'] });
    expect(sub.text).toContain('中文字幕优先');
  });
});

/* ───────────────────────── 第三方 API 测试 ───────────────────────── */

describe('fetchThirdPartyTranscript', () => {
  const VID = 'testvid0011';

  /** 模拟 youtube-transcript.ai 的响应格式 */
  const THIRD_PARTY_RESPONSE = `Title: Some Video
Source: https://www.youtube.com/watch?v=testvid0011
Language: en
Generated: true
Duration: 10:30
Words: 1500

[0:01] Hello everyone, welcome to this video.
[0:15] Today we're going to talk about &gt;&gt; something important.
[0:32] This is a &amp; test of HTML entities like &lt;tags&gt; and &quot;quotes&quot;.`;

  it('成功抓取并清理第三方字幕文本', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => THIRD_PARTY_RESPONSE,
    })) as unknown as Fetcher;

    const result = await fetchThirdPartyTranscript(VID, { fetcher });
    expect(result).not.toBeNull();
    expect(result).toContain('Hello everyone');
    expect(result).toContain('>> something important');
    expect(result).toContain('a & test');
    expect(result).toContain('<tags>');
    expect(result).toContain('"quotes"');
    // 不应包含 header 行
    expect(result).not.toContain('Title:');
    expect(result).not.toContain('Source:');
    // 不应包含时间戳
    expect(result).not.toContain('[0:01]');
  });

  it('HTTP 404 返回 null', async () => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => 'Not found',
    })) as unknown as Fetcher;

    const result = await fetchThirdPartyTranscript(VID, { fetcher });
    expect(result).toBeNull();
  });

  it('空响应返回 null', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
    })) as unknown as Fetcher;

    const result = await fetchThirdPartyTranscript(VID, { fetcher });
    expect(result).toBeNull();
  });

  it('无时间戳的响应返回 null', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => 'Just some text\nwithout timestamps\nno header either',
    })) as unknown as Fetcher;

    const result = await fetchThirdPartyTranscript(VID, { fetcher });
    expect(result).toBeNull();
  });

  it('网络异常返回 null', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('network error');
    }) as unknown as Fetcher;

    const result = await fetchThirdPartyTranscript(VID, { fetcher });
    expect(result).toBeNull();
  });
});
