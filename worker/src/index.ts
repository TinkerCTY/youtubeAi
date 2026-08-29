import { Hono } from 'hono';
import type { Env } from './env';
import { generateRoutes } from './routes/generate';
import { summaryRoutes } from './routes/summary';

const app = new Hono<{ Bindings: Env }>();

app.route('/', generateRoutes);
app.route('/', summaryRoutes);
app.get('/api/health', (c) => c.json({ ok: true }));

export default app;
export { app };
