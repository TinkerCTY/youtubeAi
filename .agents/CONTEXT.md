# Universal Engineering Context & Behavioral Guide

## 1. System Guardrails & Execution Philosophy
- **Persistent SkilledAgent Policy:** SkilledAgent is ALWAYS ACTIVE. Every user prompt requesting code modifications must be evaluated via prompt-level grilling (`grill-me`), checking for ambiguities, spec conflicts in `.agents/ACTIVE_SPEC.md`, implementation logic choices, and skill matches in `.agents/SKILLS_INDEX.md`.
- **Token Reduction & Lazy Loading Protocol:** 
  1. *Lazy Skill Loading:* Match skills via `.agents/SKILLS_INDEX.md` first; load full `SKILL.md` files only on active trigger.
  2. *Summary Caching:* Consult `.agents/SUMMARY_INDEX.md` instead of re-scanning entire directories on every prompt.
  3. *Scoped Line Viewing:* Read files in narrow line slices (20-100 lines max).
  4. *Concise Outputs:* Produce direct, token-dense answers without repeating context history.
- **Strict 12k Limit:** Observe a 12,000 line / ~120k token ceiling per markdown file to protect context reasoning.
- **Strict TDD:** Never write production application implementations without an accompanying failing test (Strict Red-Green-Refactor loop).
- **Pedagogical Requirement:** Explain architectural patterns (schema normalization, concurrency locks, interface depth) when presenting solutions. Elevate the developer's understanding.
- **Workflow Obedience:** Follow the sequential orchestration defined in the `kickoff` workflow (Scan → Vision Intake → Big Decisions → Wayfinder → Deep Grilling → Spec → Tickets → Incremental TDD Implementation → Review).

## 2. Architectural Discipline & Alignment
- **ADR Mandate:** Any major deviation from the initial spec requires a new Architecture Decision Record (ADR) before implementation.
- **Alignment Protocol:** Prioritize data isolation, interface depth, and concurrency safety.
- **Dynamic Stack Injection:** Project specifications populate during the `kickoff` alignment phase and persist in `.agents/ACTIVE_SPEC.md`.

## 3. Technical Standards (Project: YouTube → 中文对话文章生成器)
- **语言:** TypeScript（strict）
- **运行时:** Cloudflare Workers（边缘，无状态单实例）
- **后端框架:** Hono（Workers 事实标准路由，极轻量）
- **前端:** Vite + 原生 TypeScript（无 React/Vue 框架），产物由 Workers Assets 托管
- **LLM 调用:** Gemini AI Studio REST `streamGenerateContent`，直连 fetch + SSE 解析（不用 `@google/genai` SDK）
- **会话存储:** Cloudflare R2（按 `sessionId` 存 JSON 上下文，强一致 read-after-write，TTL 24h）
- **静态资源:** Workers Assets binding
- **测试:** Vitest + `@cloudflare/vitest-pool-workers`（单/集成）；e2e 可选 Playwright
- **部署:** `wrangler deploy` → GitHub Actions 自动部署到 `*.workers.dev`
- **代码审美:** 模块清晰、简洁优雅、忌臃肿；单一职责、小接口
- **TDD:** 严格红绿重构，应用逻辑先有失败测试

## 4. Ubiquitous Language (Domain Dictionary)
- **对话体文章 (Conversational Article):** 基于字幕生成的中文多角色对话稿件，按章节组织。
- **字幕 (Subtitle/Transcript):** YouTube 视频字幕文本；来源优先级：实时抓取 → 验证码降级 → 硬编码兜底。
- **生成要求 (Generation Requirements):** 用户可选输入的自然语言约束，含任务类型/输出风格/目标受众/约束条件四类。
- **流式输出 (Streaming Output):** SSE 增量推送，生成一段渲染一段。
- **会话 (Session):** 一次文章生成的上下文单元，由 `sessionId` 索引存于 R2；5W1H 复用此上下文。
- **章节 (Chapter):** 文章的结构分段；每章可触发 5W1H。
- **5W1H 总结:** 针对某章节，结合全篇与本章上下文，返回结构化 Who/What/When/Where/Why/How。
- **上下文 (Context):** 服务端保存的本次生成材料：原始字幕 + 生成要求 + 已生成章节文本 + 结构清单。

## 5. Architecture Decision Records (ADRs)
- **ADR-001 会话存储选 R2（非 D1/Durable Object）:** 免费层 + 强一致 read-after-write；会话上下文是单 JSON 文档，put/get 即可，无需 SQL。Durable Object 最优雅但需 Workers Paid($5/月)，演示不引入。
- **ADR-002 字幕策略=硬编码为主 + 实时抓取增强:** YouTube timedtext 不稳定（验证码/签名），演示主路径用硬编码保证可复现；实时抓取作 best-effort，遇验证码降级硬编码。
- **ADR-003 放弃"Worker 内 webshare 代理 HTTPS":** Workers `connect()` 裸 TCP 无法在已建明文 socket 上叠加 TLS 握手，代理 HTTPS 目标不可行；改为 `fetch` 直连 timedtext，失败降级。
- **ADR-004 Gemini 直连 REST + SSE，不用 SDK:** `@google/genai` 不保证 Workers 运行时兼容；直连 `streamGenerateContent` 端点 + SSE 解析，更轻、流式更可控、依赖更少。
- **ADR-005 前端原生 TS 无框架:** 流式渲染与按钮交互用原生 TS 足够；避免框架重量级，契合"忌臃肿"与面试审美；Vite 仅作 dev/build。
- **ADR-006 5W1H 不回传整篇文章:** 前端只发 `{sessionId, chapterId}`，服务端从 R2 取上下文生成；符合"服务端保存本次生成上下文"硬要求。