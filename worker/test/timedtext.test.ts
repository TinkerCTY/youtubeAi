import { describe, it, expect, vi } from 'vitest';
import { fetchTimedText, type Fetcher, parseWatchPageCaptions, extractTextFromTtml } from '../src/subtitle/timedtext';

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

    // ⚠️  关键：parseWatchPageCaptions 不注入 fmt=json3（防止破坏 YouTube 签名校验）
    // 因为 watch-page 来的 signed baseUrl 带 signature=... 和 sparams=ip,ipbits,... 逗号原始编码
    // 一旦注入 fmt 或重编码逗号，签名校验失败 → YouTube 静默返回空 events
    for (const t of tracks!) {
      expect(t.baseUrl).not.toContain('fmt=json3');
      expect(t.baseUrl).not.toContain('%2C'); // 逗号保持原样
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

    // 最后一次请求必须是 finalCaptionsBase（注意：signed baseUrl 不允许注入 fmt，否则破坏签名 → 保持原样）
    // 注意：proxy 模式下 buildUrl 会对 target 做 encodeURIComponent，所以断言也要用编码后的值
    const lastCall = calls[calls.length - 1];
    expect(lastCall).toContain(encodeURIComponent(finalCaptionsBase));
    // 同时确认代理前缀正确
    expect(lastCall.startsWith('https://relay.example.com/?url=')).toBe(true);
  });
});

/* ───────────── T6-b+: 签名保护 & TTML 解析器 ───────────── */

describe('parseWatchPageCaptions: 签名保护（不注入fmt/不重编码sparams逗号）', () => {
  it('T6-b-6 带 sparams 逗号和 signature 的 baseUrl 必须保持原样，不注入 fmt=json3，不重编码逗号', () => {
    const SIGNED =
      'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ' +
      '&ei=abcXYZ&caps=asr&ip=0.0.0.0&ipbits=0&expire=9999999999' +
      '&sparams=ip,ipbits,expire,v,ei,caps' + // ← 里面的逗号绝对不能编码为 %2C
      '&signature=DEADBEEF.CAFEBABE';
    const player = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: SIGNED,
              languageCode: 'en',
              kind: 'asr',
              vssId: 'a.en',
              name: { simpleText: 'English (auto)' },
            },
          ],
        },
      },
    };
    const html = buildWatchHtml(player);
    const tracks = parseWatchPageCaptions(html);
    expect(tracks).toBeDefined();
    expect(tracks!.length).toBe(1);
    const got = tracks![0].baseUrl;

    // 🔥 关键断言 1：sparams=ip,ipbits,... 里的逗号保持原样（逗号=逗号，不是 %2C）
    expect(got).toContain('sparams=ip,ipbits,expire,v,ei,caps');
    expect(got).not.toContain('%2C');

    // 🔥 关键断言 2：不要注入 fmt=json3（破坏签名）
    expect(got).not.toContain('fmt=json3');
    expect(got).not.toContain('fmt=vtt');

    // 🔥 关键断言 3：signature 保持完整
    expect(got).toContain('&signature=DEADBEEF.CAFEBABE');
  });

  it('T6-b-7 无签名的 /relative/path 仍然补全前缀，但不注入 fmt', () => {
    const player = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: '/relative/path?lang=zh-Hans&v=abc',
              languageCode: 'zh-Hans',
              vssId: '.zh-Hans',
            },
          ],
        },
      },
    };
    const html = buildWatchHtml(player);
    const tracks = parseWatchPageCaptions(html);
    expect(tracks!.length).toBe(1);
    const got = tracks![0].baseUrl;
    expect(got.startsWith('https://www.youtube.com/relative/path')).toBe(true);
    expect(got).not.toContain('fmt=json3'); // 不注入
  });
});

/* ───────────── T6-c: extractTextFromTtml (TTML XML 解析) ───────────── */

describe('extractTextFromTtml', () => {
  it('T6-c-1 标准 TTML：<p begin="..." end="...">文本</p> → 每行一个，按文档顺序，<br/>转换行', () => {
    const ttml = `<?xml version="1.0" encoding="utf-8"?>
<tt xmlns="http://www.w3.org/ns/ttml">
  <body>
    <div>
      <p begin="00:00:01.000" end="00:00:04.000" region="pop1">第一行：<span style="s1">Marc</span>，你好吗？</p>
      <p begin="00:00:05.000" end="00:00:08.000">第二行<br/>我很好，谢谢！</p>
      <p begin="00:00:09.000" end="00:00:11.000">第三行 AI 第几局？</p>
    </div>
  </body>
</tt>`;
    const text = extractTextFromTtml(ttml);
    expect(text).not.toBeNull();
    expect(text).toContain('第一行：Marc，你好吗？');
    expect(text).toContain('第二行');
    expect(text).toContain('我很好，谢谢！');
    expect(text).toContain('第三行 AI 第几局？');
    // 不应该包含 XML 标签或属性
    expect(text).not.toMatch(/<\/?[a-z]/i);
  });

  it('T6-c-2 空段落 / 只有空白的段落 → 跳过，最终返回 null（和 json3 行为一致）', () => {
    const empty = `<?xml version="1.0"?>
<tt><body><div>
  <p>   </p>
  <p begin="0">  \n  </p>
</div></body></tt>`;
    expect(extractTextFromTtml(empty)).toBeNull();
    expect(extractTextFromTtml('')).toBeNull();
    expect(extractTextFromTtml('not xml at all')).toBeNull();
  });

  it('T6-c-3 HTML 实体 &amp;/&quot;/&apos;/&lt;/&gt; 正确解码', () => {
    const ttml = `<?xml version="1.0"?>
<tt><body><div>
  <p>A &amp; B "quote" &apos;x&apos; &lt;tag&gt;</p>
</div></body></tt>`;
    const text = extractTextFromTtml(ttml);
    expect(text).toContain(`A & B "quote" 'x' <tag>`);
  });

  it('T6-c-4 中文 TTML + 多个 div → 全部拼接，空字符串 trim 掉', () => {
    const ttml = `<?xml version="1.0"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="zh-CN">
  <body>
    <div>
      <p begin="0">   </p>
      <p begin="1s">你正在收看的是——一档全新的 AI 访谈节目 。</p>
      <p begin="3s">让我们欢迎今天的嘉宾：  Marc  </p>
    </div>
    <div>
      <p begin="5s">Marc：很高兴来到这里。</p>
    </div>
  </body>
</tt>`;
    const text = extractTextFromTtml(ttml);
    expect(text).not.toBeNull();
    const lines = text!.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(text).toContain('你正在收看的是——一档全新的 AI 访谈节目 。');
    expect(text).toContain('让我们欢迎今天的嘉宾：  Marc');
    expect(text).toContain('Marc：很高兴来到这里。');
  });
});

/* ───────────── T6-d: fetchTimedText watch-page 返回 TTML → 成功解析 ───────────── */

describe('fetchTimedText watch-page fallback with TTML response', () => {
  const VID3 = 'ttmltest1234';
  it('T6-d-1 枚举+枚举(proxy)全空 → watch page HTML → 解析轨道 → TTML 响应 → 返回 proxy 成功', async () => {
    // 构造 watch HTML：包含 en 官方字幕轨道（signed，无 fmt 注入）
    const signedBase =
      'https://www.youtube.com/api/timedtext?v=' + VID3 +
      '&ei=XYZ123&sparams=v,ei,expire&expire=99&signature=ABC.DEF';
    const player = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: signedBase, languageCode: 'en', name: { simpleText: 'English' }, vssId: '.en' },
          ],
        },
      },
    };
    const watchHtml = buildWatchHtml(player);

    // 标准 TTML 响应
    const ttmlResp = `<?xml version="1.0"?>
<tt><body><div>
  <p begin="0">Hello everyone</p>
  <p begin="1s">This is an TTML response</p>
  <p begin="2s">From the YouTube signed baseUrl</p>
</div></body></tt>`;

    const responses: Array<{ ok: boolean; status: number; body: string }> = [
      ...Array.from({ length: 11 }, () => ({ ok: true, status: 200, body: '{}' })), // direct 枚举=empty
      ...Array.from({ length: 11 }, () => ({ ok: true, status: 200, body: '{}' })), // proxy 枚举=empty
      { ok: true, status: 200, body: watchHtml }, // proxy watch page
      { ok: true, status: 200, body: ttmlResp }, // signed baseUrl → TTML 响应
    ];
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: any, init?: any) => {
      calls.push(String(url));
      const r = responses.shift()!;
      return { ok: r.ok, status: r.status, text: async () => r.body } as unknown as Response;
    }) as Fetcher;

    const sub = await fetchTimedText(VID3, {
      fetcher,
      proxyUrl: 'https://relay.example.com/?url=',
    });
    expect(sub.videoId).toBe(VID3);
    expect(sub.source).toBe('proxy');
    // TTML 内容必须被正确解析
    expect(sub.text).toContain('Hello everyone');
    expect(sub.text).toContain('This is an TTML response');
    expect(sub.text).toContain('From the YouTube signed baseUrl');

    // 最后一次请求必须保持签名原样：逗号不编码，不注入 fmt
    const lastCall = calls[calls.length - 1];
    expect(lastCall).toContain(encodeURIComponent('sparams=v,ei,expire'));
    expect(lastCall).toContain(encodeURIComponent('signature=ABC.DEF'));
    expect(lastCall).not.toContain(encodeURIComponent('fmt=json3'));
  });
});
