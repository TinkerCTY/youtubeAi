import type { GenReqs } from 'shared';

export interface GeneratePayload {
  videoUrl: string;
  genReqs?: GenReqs;
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
