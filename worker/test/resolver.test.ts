import { describe, it, expect } from 'vitest';
import { parseVideoId, resolveSubtitle } from '../src/subtitle/resolver';
import { DEMO_VIDEO_ID } from '../src/subtitle/hardcoded';

describe('parseVideoId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
    ['https://youtu.be/xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
    ['https://www.youtube.com/shorts/xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
    ['https://www.youtube.com/watch?v=xRh2sVcNXQ8&t=42s', 'xRh2sVcNXQ8'],
  ])('%s → %s', (url, id) => expect(parseVideoId(url)).toBe(id));

  it('非 YouTube 链接返回 null', () => {
    expect(parseVideoId('https://example.com/foo')).toBeNull();
  });
});

describe('resolveSubtitle', () => {
  it('演示 videoId 命中硬编码字幕', () => {
    const sub = resolveSubtitle(DEMO_VIDEO_ID);
    expect(sub?.source).toBe('hardcoded');
    expect(sub?.videoId).toBe(DEMO_VIDEO_ID);
    expect(sub?.text.length).toBeGreaterThan(1000);
  });

  it('未知 videoId 返回 null', () => {
    expect(resolveSubtitle('unknown0001')).toBeNull();
  });
});
