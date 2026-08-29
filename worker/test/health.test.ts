import { describe, it, expect } from 'vitest';
import app from '../src/index';

describe('health endpoint', () => {
  it('GET /api/health 返回 { ok: true }', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
