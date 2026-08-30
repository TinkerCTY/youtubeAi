// Worker 运行时绑定（secret + R2）
export interface Env {
  /** Gemini API Key（wrangler secret） */
  GEMINI_API_KEY: string;
  /** 会话上下文 + 字幕缓存 R2 存储桶 */
  SESSION_BUCKET: R2Bucket;
  /** 可选：代理转发 URL（直连 YouTube 失败时降级，如 https://corsproxy.io/?url= ） */
  PROXY_URL?: string;
}
