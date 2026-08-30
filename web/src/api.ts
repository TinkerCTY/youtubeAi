import type { GenReqs, SummaryResponse } from 'shared';

export interface GeneratePayload {
  videoUrl: string;
  genReqs?: GenReqs;
  subtitleText?: string;
}

/** POST /api/generate → 返回 SSE ReadableStream */
export async function postGenerate(payload: GeneratePayload): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.body;
}

/** POST /api/summary → 5W1H 结构化 JSON */
export async function postSummary(sessionId: string, chapterId: string): Promise<SummaryResponse> {
  const res = await fetch('/api/summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, chapterId }),
  });
  const payload = (await res.json().catch(() => ({}))) as SummaryResponse & { error?: string };
  if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`);
  return payload;
}
