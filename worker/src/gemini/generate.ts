const ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

export interface GenerateOptions {
  apiKey: string;
  prompt: string;
  system?: string;
  /** 注入式 fetch，便于测试 mock */
  fetcher?: typeof fetch;
}

/** 非流式生成文本（T2 MVP 用；T3 流式改走 streamGenerateContent） */
export async function geminiGenerate(opts: GenerateOptions): Promise<string> {
  const fetcher = opts.fetcher ?? fetch;
  const res = await fetcher(ENDPOINT, {
    method: 'POST',
    headers: {
      'x-goog-api-key': opts.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
      ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as GeminiResponse;
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? '').join('');
}
