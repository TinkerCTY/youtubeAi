import type { GenReqs } from 'shared';

export const ARTICLE_SYSTEM =
  '你是一名资深中文编辑，擅长把视频字幕改写为生动、可读性强的中文对话体文章。';

/**
 * 构造文章生成 prompt（T2 非流式 MVP；T3 起追加章节标记指令）
 * genReqs 为可选约束，存在时影响输出但模型不超出其范围。
 */
export function buildArticlePrompt(subtitle: string, genReqs?: GenReqs): string {
  let p =
    '请把以下视频字幕改写为一篇中文对话体文章。\n' +
    '要求：\n' +
    '- 以多角色对话形式呈现（主持人/嘉宾等）；\n' +
    '- 语言自然流畅、可读性强；\n' +
    '- 忠实于字幕内容，不编造事实；\n' +
    '- 按主题分 3~6 个章节，每章以 <<CH|章节标题>> 标记开头（标记独占一行，格式严格）。\n\n' +
    `【字幕】\n${subtitle}`;

  if (genReqs) {
    const items: string[] = [];
    if (genReqs.taskType) items.push(`任务类型：${genReqs.taskType}`);
    if (genReqs.style) items.push(`输出风格：${genReqs.style}`);
    if (genReqs.audience) items.push(`目标受众：${genReqs.audience}`);
    if (genReqs.constraints) items.push(`约束条件：${genReqs.constraints}`);
    if (items.length) {
      p += `\n\n【生成要求】\n请在以下范围内影响输出，不超出其范围：\n${items.join('\n')}`;
    }
  }
  return p;
}
