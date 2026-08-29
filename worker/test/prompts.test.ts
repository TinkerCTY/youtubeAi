import { describe, it, expect } from 'vitest';
import { buildArticlePrompt } from '../src/gemini/prompts';

describe('buildArticlePrompt', () => {
  const subtitle = '主持人：你好。\n嘉宾：你好。';

  it('无 genReqs 时含字幕、含章节标记指令、不含生成要求段', () => {
    const p = buildArticlePrompt(subtitle);
    expect(p).toContain('【字幕】');
    expect(p).toContain(subtitle);
    expect(p).toContain('<<CH|');
    expect(p).not.toContain('【生成要求】');
  });

  it('四类 genReqs 全填时全部体现且声明不超范围', () => {
    const p = buildArticlePrompt(subtitle, {
      taskType: '总结',
      style: '口语化',
      audience: '普通读者',
      constraints: '800字内',
    });
    expect(p).toContain('任务类型：总结');
    expect(p).toContain('输出风格：口语化');
    expect(p).toContain('目标受众：普通读者');
    expect(p).toContain('约束条件：800字内');
    // 新版「硬性约束」话术：必须有"必须严格遵守/不得违反/在...约束范围内"任一不越界语义
    expect(p).toMatch(/必须(严格)?遵守|不得违反|约束范围内/);
  });

  it('部分 genReqs 只出现已填项', () => {
    const p = buildArticlePrompt(subtitle, { style: '专业' });
    expect(p).toContain('输出风格：专业');
    expect(p).not.toContain('任务类型');
  });
});
