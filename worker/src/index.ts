import { Hono } from 'hono';
import type { Env } from './env';
import { generateRoutes } from './routes/generate';
import { summaryRoutes } from './routes/summary';
import { parseVideoId, debugSubtitle } from './subtitle/resolver';

const app = new Hono<{ Bindings: Env }>();

app.route('/', generateRoutes);
app.route('/', summaryRoutes);
app.get('/api/health', (c) => c.json({ ok: true }));

// 调试端点：测试字幕抓取各策略可用性
app.get('/api/debug/subtitle', async (c) => {
  const videoUrl = c.req.query('v') ?? '';
  const videoId = parseVideoId(videoUrl) ?? videoUrl;
  if (!videoId || videoId.length < 8) {
    return c.json({ error: 'provide ?v=VIDEO_URL or ?v=VIDEO_ID' }, 400);
  }
  const result = await debugSubtitle(videoId);
  return c.json(result, 200);
});

export default app;
export { app };
