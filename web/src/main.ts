import type { GenReqs } from 'shared';
import { postGenerate, postSummary } from './api';
import { consumeSse } from './sse-client';
import { ArticleRenderer } from './render';
import { parseVideoId, fetchSubtitleClientSide } from './subtitle-client';

const form = document.getElementById('gen-form') as HTMLFormElement | null;
const article = document.getElementById('article');
const btn = document.getElementById('gen-btn') as HTMLButtonElement | null;

if (form && article && btn) {
  const renderer = new ArticleRenderer(article);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    renderer.clear();

    try {
      const data = new FormData(form);
      const videoUrl = String(data.get('videoUrl') ?? '');
      const payload: { videoUrl: string; genReqs?: GenReqs; subtitleText?: string } = { videoUrl };

      const genReqs: GenReqs = {};
      for (const k of ['taskType', 'style', 'audience', 'constraints'] as const) {
        const v = String(data.get(k) ?? '').trim();
        if (v) genReqs[k] = v;
      }
      if (Object.keys(genReqs).length) payload.genReqs = genReqs;

      // 客户端字幕抓取：浏览器 IP 不被 YouTube 封锁
      const videoId = parseVideoId(videoUrl);
      if (videoId) {
        article.textContent = '正在抓取字幕…';
        const subtitleText = await fetchSubtitleClientSide(videoId);
        if (subtitleText) {
          payload.subtitleText = subtitleText;
          article.textContent = '字幕抓取成功，正在生成文章…';
        } else {
          article.textContent = '浏览器端字幕抓取失败，尝试服务端降级…';
        }
      }

      article.textContent = '';
      const stream = await postGenerate(payload);
      await consumeSse(stream, {
        onChapter: (id, title) => renderer.startChapter(id, title),
        onText: (text) => renderer.appendText(text),
        onManifest: (sessionId, _chapters) => {
          renderer.setSessionId(sessionId);
          renderer.setSummarizer(async (chapterId) => postSummary(sessionId, chapterId));
        },
        onError: (msg) => renderer.showError(msg),
      });
    } catch (err) {
      renderer.showError((err as Error).message);
    } finally {
      btn.disabled = false;
    }
  });
}
