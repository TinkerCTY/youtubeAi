import type { GenReqs } from 'shared';

export const ARTICLE_SYSTEM =
  '你是一名资深中文编辑，擅长把视频字幕改写为生动、可读性强的中文对话体文章。';

export const SUMMARY_SYSTEM =
  '你是一名专业中文总结编辑。请忠实于给定的视频字幕上下文和章节内容，不编造任何未提及的信息。';

/** 5W1H responseSchema（大写 type） */
export const FIVE_W_ONE_H_SCHEMA: Record<string, any> = {
  type: 'OBJECT',
  properties: {
    who: { type: 'STRING', description: '本章节涉及的人物/主体' },
    what: { type: 'STRING', description: '事件或议题本身' },
    when: { type: 'STRING', description: '时间点、阶段或时期' },
    where: { type: 'STRING', description: '地域、行业领域或应用场景' },
    why: { type: 'STRING', description: '起因、动机或背后原因' },
    how: { type: 'STRING', description: '机制、方法或路径' },
  },
  required: ['who', 'what', 'when', 'where', 'why', 'how'],
};

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

  if (genReqs) p = appendGenReqs(p, genReqs);
  return p;
}

/**
 * 构造 5W1H 总结 prompt：结合整篇字幕 + 当前章节上下文
 * @param subtitle 完整字幕（提供全局背景）
 * @param chapterTitle 当前章节标题
 * @param chapterText 当前章节完整文本
 * @param genReqs 可选生成要求（与生成时一致，保持对齐）
 */
export function build5W1HPrompt(
  subtitle: string,
  chapterTitle: string,
  chapterText: string,
  genReqs: GenReqs | null,
): string {
  let p =
    '请根据【视频字幕全文（上下文）】和【当前章节】，对当前章节生成 5W1H 结构化总结。\n' +
    '要求：\n' +
    '- 每项用 1~2 句精炼中文表述；\n' +
    '- 忠实于字幕内容与章节文本，不编造任何未提及的信息；\n' +
    '- 结合整篇视频背景理解当前章节，不孤立看待；\n' +
    '- who/when/where 若章节未明确提及，则给出最合理的上下文推断并注明（例如“基于全片语境推断：…”）；\n' +
    '- what 聚焦章节的核心事件/议题，why 分析背后动因，how 说明实现方式或路径。\n\n' +
    `【视频字幕全文（上下文）】\n${subtitle}\n\n` +
    `【当前章节标题】\n${chapterTitle}\n\n` +
    `【当前章节内容】\n${chapterText}`;

  if (genReqs) p = appendGenReqs(p, genReqs);
  return p;
}

function appendGenReqs(base: string, genReqs: GenReqs): string {
  const items: string[] = [];
  if (genReqs.taskType) items.push(`任务类型：${genReqs.taskType}`);
  if (genReqs.style) items.push(`输出风格：${genReqs.style}`);
  if (genReqs.audience) items.push(`目标受众：${genReqs.audience}`);
  if (genReqs.constraints) items.push(`约束条件：${genReqs.constraints}`);
  if (!items.length) return base;
  return `${base}\n\n【生成要求】\n请在以下范围内影响输出，不超出其范围：\n${items.join('\n')}`;
}
