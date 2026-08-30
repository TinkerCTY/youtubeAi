/**
 * Gemini streamGenerateContent + SSE 解析
 *
 * 端点：POST .../gemini-3.6-flash:streamGenerateContent?alt=sse
 * 认证：x-goog-api-key 头
 * SSE 事件 data 行含 JSON：candidates[0].content.parts[].text
 */

const STREAM_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse';

export interface StreamOptions {
  apiKey: string;
  prompt: string;
  system?: string;
  /** 注入式 fetch，便于测试 mock */
  fetcher?: typeof fetch;
}

/** 流式生成文本增量（async generator） */
export async function* geminiStream(opts: StreamOptions): AsyncGenerator<string> {
  const fetcher = opts.fetcher ?? fetch;
  const res = await fetcher(STREAM_ENDPOINT, {
    method: 'POST',
    headers: { 'x-goog-api-key': opts.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
      ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

    // 按双换行分割完整 SSE 事件
    const events = sseBuffer.split('\n\n');
    sseBuffer = events.pop() ?? '';

    for (const raw of events) {
      const text = extractText(raw);
      if (text) yield text;
    }
  }

  // 残余 buffer
  const text = extractText(sseBuffer);
  if (text) yield text;
}

/** 从单个 SSE 事件块提取文本增量 */
function extractText(raw: string): string | null {
  const line = raw.trim();
  if (!line.startsWith('data: ')) return null;
  const jsonStr = line.slice(6).trim();
  if (!jsonStr) return null;
  try {
    const data = JSON.parse(jsonStr) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    return parts.map((p) => p.text ?? '').join('') || null;
  } catch {
    return null;
  }
}
