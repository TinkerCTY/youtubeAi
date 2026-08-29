/**
 * <<CH|标题>> 章节标记流式解析器
 *
 * 设计要点：
 * - push(chunk) 增量输入，返回已解析的事件（chapter / text）
 * - 标记可能跨 chunk 边界被拆分 → 用 buffer 暂存，只发出安全文本
 * - findSafeEnd 仅在 buffer 末尾可能是 <<CH| 前缀时保留，避免误拆标记
 * - flush() 把残余 buffer（含不完整标记）降级为 text 输出
 */

export type MarkerEvent =
  | { type: 'chapter'; id: string; title: string }
  | { type: 'text'; text: string };

const MARKER_PREFIX = '<<CH|';
const MARKER_SUFFIX = '>>';

export class MarkerParser {
  private buffer = '';
  private chapterCount = 0;

  push(chunk: string): MarkerEvent[] {
    this.buffer += chunk;
    return this.drain();
  }

  flush(): MarkerEvent[] {
    const events = this.drain();
    if (this.buffer) {
      events.push({ type: 'text', text: this.buffer });
      this.buffer = '';
    }
    return events;
  }

  private drain(): MarkerEvent[] {
    const events: MarkerEvent[] = [];
    for (;;) {
      const markerStart = this.buffer.indexOf(MARKER_PREFIX);

      if (markerStart === -1) {
        // 无标记 → 发出安全文本，保留可能是 <<CH| 前缀的尾部
        const safeEnd = this.findSafeEnd();
        if (safeEnd > 0) {
          events.push({ type: 'text', text: this.buffer.slice(0, safeEnd) });
          this.buffer = this.buffer.slice(safeEnd);
        }
        break;
      }

      // 发出标记前的文本
      if (markerStart > 0) {
        events.push({ type: 'text', text: this.buffer.slice(0, markerStart) });
        this.buffer = this.buffer.slice(markerStart);
      }

      // 查找后缀 >>（标记可能不完整 → 等待更多数据）
      const markerEnd = this.buffer.indexOf(MARKER_SUFFIX, MARKER_PREFIX.length);
      if (markerEnd === -1) break;

      const title = this.buffer.slice(MARKER_PREFIX.length, markerEnd);
      this.chapterCount++;
      events.push({ type: 'chapter', id: String(this.chapterCount), title });
      this.buffer = this.buffer.slice(markerEnd + MARKER_SUFFIX.length);
    }
    return events;
  }

  /** 返回可安全输出的末尾位置；保留可能是 <<CH| 前缀的残余 */
  private findSafeEnd(): number {
    for (let i = Math.min(this.buffer.length, MARKER_PREFIX.length); i >= 1; i--) {
      if (this.buffer.endsWith(MARKER_PREFIX.slice(0, i))) {
        return this.buffer.length - i;
      }
    }
    return this.buffer.length;
  }
}
