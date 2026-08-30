import { describe, it, expect, vi } from 'vitest';
import { fetchTimedText, type Fetcher } from '../src/subtitle/timedtext';

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
