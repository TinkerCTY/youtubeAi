// 跨 web / worker 共享的类型契约

/** 用户可选的自然语言生成要求 */
export interface GenReqs {
  taskType?: string; // 任务类型
  style?: string; // 输出风格
  audience?: string; // 目标受众
  constraints?: string; // 约束条件
}

/** POST /api/generate 请求体 */
export interface GenerateRequest {
  videoUrl: string;
  genReqs?: GenReqs;
}

/** 文章章节 */
export interface Chapter {
  id: string;
  title: string;
  text: string;
}

/** 服务端会话上下文（R2 存储，TTL 24h） */
export interface SessionContext {
  sessionId: string;
  createdAt: number;
  videoId: string;
  subtitleSource: 'hardcoded' | 'live' | 'cache' | 'proxy';
  subtitleText: string;
  genReqs: GenReqs | null;
  chapters: Chapter[];
}

/** SSE 事件（Worker → 浏览器） */
export type SseEvent =
  | { type: 'chapter'; id: string; title: string }
  | { type: 'text'; text: string }
  | { type: 'manifest'; sessionId: string; chapters: { id: string; title: string }[] }
  | { type: 'error'; message: string };

/** POST /api/summary 请求体 */
export interface SummaryRequest {
  sessionId: string;
  chapterId: string;
}

/** POST /api/summary 响应体（5W1H 结构化） */
export interface SummaryResponse {
  who: string;
  what: string;
  when: string;
  where: string;
  why: string;
  how: string;
}
