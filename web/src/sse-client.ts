import type { SseEvent } from 'shared';

export interface SseHandlers {
  onChapter?: (id: string, title: string) => void;
  onText?: (text: string) => void;
  onManifest?: (sessionId: string, chapters: { id: string; title: string }[]) => void;
  onError?: (message: string) => void;
}

/** 从 ReadableStream 解析 SSE 事件并分发到 handlers */
export async function consumeSse(stream: ReadableStream<Uint8Array>, h: SseHandlers): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const raw of events) {
      const line = raw.trim();
      if (!line.startsWith('data: ')) continue;
      try {
        dispatch(JSON.parse(line.slice(6)) as SseEvent, h);
      } catch { /* ignore incomplete JSON */ }
    }
  }

  // 残余
  const line = buffer.trim();
  if (line.startsWith('data: ')) {
    try {
      dispatch(JSON.parse(line.slice(6)) as SseEvent, h);
    } catch { /* ignore */ }
  }
}

function dispatch(evt: SseEvent, h: SseHandlers): void {
  switch (evt.type) {
    case 'chapter':
      h.onChapter?.(evt.id, evt.title);
      break;
    case 'text':
      h.onText?.(evt.text);
      break;
    case 'manifest':
      h.onManifest?.(evt.sessionId, evt.chapters);
      break;
    case 'error':
      h.onError?.(evt.message);
      break;
  }
}
