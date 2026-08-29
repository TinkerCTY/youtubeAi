import type { GenReqs } from 'shared';
import { postGenerate } from './api';
import { consumeSse } from './sse-client';
import { ArticleRenderer } from './render';

const form = document.getElementById('gen-form') as HTMLFormElement | null;
const article = document.getElementById('article');
const btn = document.getElementById('gen-btn') as HTMLButtonElement | null;

if (form && article && btn) {
  const renderer = new ArticleRenderer(article);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    renderer.clear();
    article.textContent = '生成中…';

    try {
      const data = new FormData(form);
      const payload: { videoUrl: string; genReqs?: GenReqs } = {
        videoUrl: String(data.get('videoUrl') ?? ''),
      };
      const genReqs: GenReqs = {};
      for (const k of ['taskType', 'style', 'audience', 'constraints'] as const) {
        const v = String(data.get(k) ?? '').trim();
        if (v) genReqs[k] = v;
      }
      if (Object.keys(genReqs).length) payload.genReqs = genReqs;

      article.textContent = '';
      const stream = await postGenerate(payload);
      await consumeSse(stream, {
        onChapter: (id, title) => renderer.startChapter(id, title),
        onText: (text) => renderer.appendText(text),
        onError: (msg) => renderer.showError(msg),
      });
    } catch (err) {
      renderer.showError((err as Error).message);
    } finally {
      btn.disabled = false;
    }
  });
}
