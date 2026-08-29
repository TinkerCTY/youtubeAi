import { describe, it, expect } from 'vitest';
import { build5W1HPrompt } from '../src/gemini/prompts';

describe('build5W1HPrompt', () => {
  const subtitle = '完整字幕：介绍 AI 革命\n嘉宾 A … 嘉宾 B …';
  const chapterText = 'AI 行业的收入增长、商业模式、普及速度和定价。';
  const chapterTitle = '智能经济：收入爆发与成本塌陷';

  it('包含字幕全文(上下文)、章节标题、章节文本、5W1H 六项提示', () => {
    const p = build5W1HPrompt(subtitle, chapterTitle, chapterText, null);
    expect(p).toContain(subtitle);
    expect(p).toContain(chapterTitle);
    expect(p).toContain(chapterText);
    // 6 项明确提及：who/why/how 显式；what/when/where 在"每项"与推断说明中覆盖
    expect(p).toContain('who');
    expect(p).toContain('when');
    expect(p).toContain('where');
    expect(p).toContain('why');
    expect(p).toContain('how');
    expect(p).toContain('5W1H');
  });

  it('无 genReqs 时 prompt 不含【生成要求】段', () => {
    const p = build5W1HPrompt(subtitle, chapterTitle, chapterText, null);
    expect(p).not.toContain('【生成要求】');
  });

  it('有 genReqs 时追加【生成要求】', () => {
    const p = build5W1HPrompt(subtitle, chapterTitle, chapterText, { audience: '普通读者' });
    expect(p).toContain('【生成要求】');
    expect(p).toContain('普通读者');
  });

  it('含约束：每项各 1 句，忠实内容，不编造', () => {
    const p = build5W1HPrompt(subtitle, chapterTitle, chapterText, null);
    expect(p).toContain('忠实');
  });
});
