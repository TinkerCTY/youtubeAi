import { describe, it, expect } from 'vitest';
import { MarkerParser } from '../src/parser/markers';

describe('MarkerParser', () => {
  it('无标记纯文本 → push 即输出，flush 为空', () => {
    const p = new MarkerParser();
    expect(p.push('你好世界')).toEqual([{ type: 'text', text: '你好世界' }]);
    expect(p.flush()).toEqual([]);
  });

  it('单个标记 → chapter + 后续 text', () => {
    const p = new MarkerParser();
    expect(p.push('<<CH|第一章>>\n正文内容')).toEqual([
      { type: 'chapter', id: '1', title: '第一章' },
      { type: 'text', text: '\n正文内容' },
    ]);
  });

  it('多个标记 → chapter 交替 text', () => {
    const p = new MarkerParser();
    expect(p.push('<<CH|A>>\nt1\n<<CH|B>>\nt2')).toEqual([
      { type: 'chapter', id: '1', title: 'A' },
      { type: 'text', text: '\nt1\n' },
      { type: 'chapter', id: '2', title: 'B' },
      { type: 'text', text: '\nt2' },
    ]);
  });

  it('标记跨 chunk → 正确拼接', () => {
    const p = new MarkerParser();
    expect(p.push('正文<<CH|第一')).toEqual([{ type: 'text', text: '正文' }]);
    expect(p.push('章>>\n内容')).toEqual([
      { type: 'chapter', id: '1', title: '第一章' },
      { type: 'text', text: '\n内容' },
    ]);
  });

  it('标记前缀 << 跨 chunk → 保留不误输出', () => {
    const p = new MarkerParser();
    expect(p.push('正文<<')).toEqual([{ type: 'text', text: '正文' }]);
    expect(p.push('CH|标题>>\n内容')).toEqual([
      { type: 'chapter', id: '1', title: '标题' },
      { type: 'text', text: '\n内容' },
    ]);
  });

  it('残余不完整标记前缀 → flush 时作为 text 输出', () => {
    const p = new MarkerParser();
    p.push('正文<<');
    expect(p.flush()).toEqual([{ type: 'text', text: '<<' }]);
  });

  it('残余不完整标记(无后缀) → flush 降级为 text', () => {
    const p = new MarkerParser();
    p.push('正文<<CH|未完成');
    // push 输出 '正文'，保留 '<<CH|未完成'
    expect(p.flush()).toEqual([{ type: 'text', text: '<<CH|未完成' }]);
  });

  it('连续两个标记无间隔文本', () => {
    const p = new MarkerParser();
    expect(p.push('<<CH|A>><<CH|B>>\n内容')).toEqual([
      { type: 'chapter', id: '1', title: 'A' },
      { type: 'chapter', id: '2', title: 'B' },
      { type: 'text', text: '\n内容' },
    ]);
  });

  it('章节 id 自增递增', () => {
    const p = new MarkerParser();
    const events = p.push('<<CH|A>>x<<CH|B>>y<<CH|C>>z');
    const ids = events.filter((e) => e.type === 'chapter').map((e) => (e as any).id);
    expect(ids).toEqual(['1', '2', '3']);
  });
});
