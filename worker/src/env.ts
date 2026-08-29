// Worker 运行时绑定（secret + R2）
export interface Env {
  /** Gemini API Key（wrangler secret） */
  GEMINI_API_KEY: string;
  /** 会话上下文 R2 存储桶 */
  SESSION_BUCKET: R2Bucket;
}
