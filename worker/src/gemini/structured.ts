/**
 * Gemini 非流式 generateContent + 结构化 JSON 输出
 *
 * 要点：
 * - generationConfig.responseMimeType = "application/json"
 * - generationConfig.responseSchema = OBJECT 类型 schema（字段 type 大写如 STRING）
 * - 模型在 candidates[0].content.parts[0].text 返回 JSON 字符串 → 客户端 parse 成目标类型
 */

const ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent';

export interface StructuredOptions<T> {
  apiKey: string;
  prompt: string;
  schema: Record<string, any>;
  system?: string;
  /** 注入式 fetch，便于测试 mock */
  fetcher?: typeof fetch;
}

export async function geminiStructured<T = any>(opts: StructuredOptions<T>): Promise<T> {
  const fetcher = opts.fetcher ?? fetch;
  const res = await fetcher(ENDPOINT, {
    method: 'POST',
    headers: { 'x-goog-api-key': opts.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
      ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
      generationConfig: {
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json',
        responseSchema: opts.schema,
      },
    }),
  });

  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(`Gemini structured JSON parse failed: ${raw.slice(0, 80)}`);
  }
}
