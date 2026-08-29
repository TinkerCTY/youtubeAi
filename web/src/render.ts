import type { SummaryResponse } from 'shared';

/**
 * DOM 渲染器：章节容器 + 流式 textContent（XSS 安全）
 * T5：章节标题旁 [5W1H] 按钮 → 固定格式卡片渲染
 */
interface ChapterEl {
  id: string;
  body: HTMLElement;
  section: HTMLElement;
  card: HTMLElement | null; // 5W1H 卡片容器
}

type Summarizer = (chapterId: string) => Promise<SummaryResponse>;

export class ArticleRenderer {
  private root: HTMLElement;
  private chapters = new Map<string, ChapterEl>();
  private current: ChapterEl | null = null;
  private sessionId: string | null = null;
  private summarizer: Summarizer | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  /** 注入 [5W1H] 点击处理器（main.ts 在收到 manifest 时绑定） */
  setSummarizer(fn: Summarizer): void {
    this.summarizer = fn;
  }

  clear(): void {
    this.root.textContent = '';
    this.chapters.clear();
    this.current = null;
    this.sessionId = null;
    this.summarizer = null;
  }

  startChapter(id: string, title: string): void {
    const section = document.createElement('section');
    section.className = 'chapter';
    section.dataset.chapterId = id;

    // 标题行：h2 + [5W1H] 按钮
    const header = document.createElement('div');
    header.className = 'chapter-header';
    const h2 = document.createElement('h2');
    h2.className = 'chapter-title';
    h2.textContent = title;
    header.appendChild(h2);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'summary-btn';
    btn.textContent = '[5W1H]';
    btn.title = '生成本章节 5W1H 总结';
    btn.addEventListener('click', () => this.onClickSummary(id, btn));
    header.appendChild(btn);
    section.appendChild(header);

    const body = document.createElement('div');
    body.className = 'chapter-body';
    section.appendChild(body);

    this.root.appendChild(section);
    const el: ChapterEl = { id, body, section, card: null };
    this.chapters.set(id, el);
    this.current = el;
  }

  appendText(text: string): void {
    if (!this.current) this.startChapter('0', '正文');
    this.current!.body.textContent += text;
  }

  showError(message: string): void {
    const p = document.createElement('p');
    p.className = 'error-msg';
    p.textContent = `生成失败：${message}`;
    this.root.appendChild(p);
  }

  private async onClickSummary(chapterId: string, btn: HTMLButtonElement): Promise<void> {
    if (!this.summarizer) {
      this.flashError(btn, '会话未就绪（等待 manifest）');
      return;
    }
    const ch = this.chapters.get(chapterId);
    if (!ch) return;

    btn.disabled = true;
    const prevText = btn.textContent;
    btn.textContent = '生成中…';

    try {
      const resp = await this.summarizer(chapterId);
      this.renderCard(ch, resp);
    } catch (err) {
      this.flashError(btn, (err as Error).message);
    } finally {
      btn.disabled = false;
      btn.textContent = prevText;
    }
  }

  private renderCard(ch: ChapterEl, resp: SummaryResponse): void {
    if (!ch.card) {
      const card = document.createElement('div');
      card.className = 'summary-card';
      ch.card = card;
      ch.section.appendChild(card);
    } else {
      ch.card.textContent = '';
    }
    const entries: [keyof SummaryResponse, string][] = [
      ['who', 'Who'],
      ['what', 'What'],
      ['when', 'When'],
      ['where', 'Where'],
      ['why', 'Why'],
      ['how', 'How'],
    ];
    for (const [key, label] of entries) {
      const row = document.createElement('div');
      row.className = 'summary-row';
      const k = document.createElement('div');
      k.className = 'summary-key';
      k.textContent = label;
      const v = document.createElement('div');
      v.className = 'summary-value';
      v.textContent = resp[key];
      row.appendChild(k);
      row.appendChild(v);
      ch.card.appendChild(row);
    }
  }

  private flashError(btn: HTMLButtonElement, msg: string): void {
    const orig = btn.nextSibling as Element | null;
    const tip = document.createElement('span');
    tip.className = 'summary-error-tip';
    tip.textContent = `失败：${msg}`;
    btn.parentElement?.appendChild(tip);
    setTimeout(() => tip.remove(), 4000);
    void orig;
  }
}
