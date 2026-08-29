import { Hono } from 'hono';
import type { Env } from '../env';
import type { Chapter, GenReqs, SessionContext, SseEvent } from 'shared';
import { parseVideoId, resolveSubtitle } from '../subtitle/resolver';
import { ARTICLE_SYSTEM, buildArticlePrompt } from '../gemini/prompts';
import { geminiStream } from '../gemini/stream';
import { MarkerParser } from '../parser/markers';
import { putSession } from '../session-store/r2';

export const generateRoutes = new Hono<{ Bindings: Env }>();

generateRoutes.post('/api/generate', async (c) => {
  const body = await c.req.json<{ videoUrl: string; genReqs?: GenReqs }>();
  const videoId = parseVideoId(body.videoUrl ?? '');
  if (!videoId) return c.json({ error: 'invalid video url' }, 400);

  const sub = await resolveSubtitle(videoId);
  if (!sub) return c.json({ error: 'subtitle not available for this video' }, 404);

  const prompt = buildArticlePrompt(sub.text, body.genReqs);
  const sessionId = crypto.randomUUID();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const emit = (evt: SseEvent) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));

      const parser = new MarkerParser();
      const chapters: Chapter[] = [];
      let current: Chapter | null = null;

      const onText = (text: string) => {
        if (current) current.text += text;
        emit({ type: 'text', text });
      };

      try {
        for await (const delta of geminiStream({
          apiKey: c.env.GEMINI_API_KEY,
          prompt,
          system: ARTICLE_SYSTEM,
        })) {
          for (const evt of parser.push(delta)) {
            if (evt.type === 'chapter') {
              if (current) chapters.push(current);
              current = { id: evt.id, title: evt.title, text: '' };
              emit({ type: 'chapter', id: evt.id, title: evt.title });
            } else {
              onText(evt.text);
            }
          }
        }
        for (const evt of parser.flush()) {
          if (evt.type === 'text') onText(evt.text);
        }
        if (current) chapters.push(current);

        await putSession(c.env.SESSION_BUCKET, {
          sessionId,
          createdAt: Date.now(),
          videoId,
          subtitleSource: sub.source,
          subtitleText: sub.text,
          genReqs: body.genReqs ?? null,
          chapters,
        } satisfies SessionContext);

        emit({
          type: 'manifest',
          sessionId,
          chapters: chapters.map(({ id, title }) => ({ id, title })),
        });
      } catch (e) {
        emit({ type: 'error', message: String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});
