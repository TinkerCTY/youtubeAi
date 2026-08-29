/**
 * DOM 渲染器：章节容器 + 流式 textContent（XSS 安全）
 * T5 将在章节标题旁加 [5W1H] 按钮
 */
interface ChapterEl {
  id: string;
  body: HTMLElement;
}

export class ArticleRenderer {
  private root: HTMLElement;
  private chapters = new Map<string, ChapterEl>();
  private current: ChapterEl | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  clear(): void {
    this.root.textContent = '';
    this.chapters.clear();
    this.current = null;
  }

  startChapter(id: string, title: string): void {
    const section = document.createElement('section');
    section.className = 'chapter';

    const h2 = document.createElement('h2');
    h2.className = 'chapter-title';
    h2.textContent = title;
    section.appendChild(h2);

    const body = document.createElement('div');
    body.className = 'chapter-body';
    section.appendChild(body);

    this.root.appendChild(section);
    const el = { id, body };
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
}
