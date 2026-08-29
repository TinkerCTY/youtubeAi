import { Hono } from 'hono';
import type { Env } from '../env';
import type { SummaryRequest, SummaryResponse } from 'shared';
import { getSession } from '../session-store/r2';
import { FIVE_W_ONE_H_SCHEMA, SUMMARY_SYSTEM, build5W1HPrompt } from '../gemini/prompts';
import { geminiStructured } from '../gemini/structured';

export const summaryRoutes = new Hono<{ Bindings: Env }>();

summaryRoutes.post('/api/summary', async (c) => {
  const body = await c.req.json<Partial<SummaryRequest>>();
  const sessionId = body.sessionId?.trim();
  const chapterId = body.chapterId?.trim();
  if (!sessionId || !chapterId) {
    return c.json({ error: 'sessionId and chapterId are required' }, 400);
  }

  const ctx = await getSession(c.env.SESSION_BUCKET, sessionId);
  if (!ctx) return c.json({ error: 'session expired or not found (410 Gone)' }, 410);

  const chapter = ctx.chapters.find((ch) => ch.id === chapterId);
  if (!chapter) return c.json({ error: 'chapter not found (422)' }, 422);

  const prompt = build5W1HPrompt(ctx.subtitleText, chapter.title, chapter.text, ctx.genReqs);

  try {
    const out = await geminiStructured<SummaryResponse>({
      apiKey: c.env.GEMINI_API_KEY,
      prompt,
      system: SUMMARY_SYSTEM,
      schema: FIVE_W_ONE_H_SCHEMA,
    });
    return c.json(out as SummaryResponse, 200);
  } catch (e) {
    return c.json({ error: `gemini generation failed: ${String(e)}` }, 503);
  }
});
