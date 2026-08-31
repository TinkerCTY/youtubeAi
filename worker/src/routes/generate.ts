import { Hono } from 'hono';
import type { Env } from '../env';
import type { Chapter, GenReqs, SessionContext, SseEvent } from 'shared';
import { fetchTimedText } from '../subtitle/timedtext';
import { HARDCODED_SUBTITLES } from '../subtitle/hardcoded';
import {
  parseVideoId,
  resolveSubtitle,
  type ResolvedSubtitle,
} from '../subtitle/resolver';
import { ARTICLE_SYSTEM, buildArticlePrompt } from '../gemini/prompts';
import { geminiStream } from '../gemini/stream';
import { MarkerParser } from '../parser/markers';
import { getSubtitleCache, putSession } from '../session-store/r2';

export const generateRoutes = new Hono<{ Bindings: Env }>();

/**
 * 字幕策略调试端点（public，匿名可访问）
 * 返回：Env 状态 + 4 层策略每一层的结果
 */
generateRoutes.get('/api/debug/subtitle-strategy', async (c) => {
  const videoId = c.req.query('v') ?? 'dQw4w9WgXcQ';
  const envState = {
    PROXY_URL_set: !!c.env.PROXY_URL,
    PROXY_URL_preview: c.env.PROXY_URL
      ? c.env.PROXY_URL.replace(/^(https?:\/\/[^/]+).*$/, '$1/?url=<masked>')
      : null,
    GEMINI_API_KEY_set: !!c.env.GEMINI_API_KEY,
    SESSION_BUCKET_set: !!c.env.SESSION_BUCKET,
  };

  const diagnostics: Record<string, unknown> = { env: envState, videoId };

  // Level 1: R2 cache
  try {
    const cached = c.env.SESSION_BUCKET
      ? await getSubtitleCache(c.env.SESSION_BUCKET, videoId)
      : null;
    diagnostics.cache = cached
      ? { hit: true, length: cached.length }
      : { hit: false };
  } catch (e) {
    diagnostics.cache = { error: String(e) };
  }

  // Level 2: direct live
  let directResult: ResolvedSubtitle | null = null;
  const directErrors: string[] = [];
  try {
    directResult = await fetchTimedText(videoId, {});
  } catch (e) {
    directErrors.push((e as Error).message);
  }
  diagnostics.direct = directResult
    ? { source: directResult.source, length: directResult.text.length, preview: directResult.text.slice(0, 120) }
    : { failed: true, errors: directErrors.join(' | ').slice(0, 600) };

  // Level 3: proxy
  let proxyResult: ResolvedSubtitle | null = null;
  const proxyErrors: string[] = [];
  if (c.env.PROXY_URL) {
    try {
      proxyResult = await fetchTimedText(videoId, { proxyUrl: c.env.PROXY_URL });
    } catch (e) {
      proxyErrors.push((e as Error).message);
    }
    diagnostics.proxy = proxyResult
      ? { source: proxyResult.source, length: proxyResult.text.length, preview: proxyResult.text.slice(0, 120) }
      : { failed: true, errors: proxyErrors.join(' | ').slice(0, 600) };
  } else {
    diagnostics.proxy = { skipped: true, reason: 'PROXY_URL not set' };
  }

  // Level 4: hardcoded
  diagnostics.hardcoded = {
    availableForThisVideo: !!HARDCODED_SUBTITLES[videoId],
    totalKnown: Object.keys(HARDCODED_SUBTITLES).length,
    ids: Object.keys(HARDCODED_SUBTITLES),
  };

  return c.json(diagnostics, 200);
});

generateRoutes.post('/api/generate', async (c) => {
  const body = await c.req.json<{ videoUrl: string; genReqs?: GenReqs }>();
  const videoId = parseVideoId(body.videoUrl ?? '');
  if (!videoId) return c.json({ error: 'invalid video url' }, 400);

  const sub = await resolveSubtitle(videoId, {
    bucket: c.env.SESSION_BUCKET,
    proxyUrl: c.env.PROXY_URL,
  });
  if (!sub)
    return c.json(
      {
        error:
          '该视频无可用字幕（实时抓取失败且非演示视频）。建议使用演示视频：https://www.youtube.com/watch?v=xRh2sVcNXQ8',
      },
      404,
    );

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
