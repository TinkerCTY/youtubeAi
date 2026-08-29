# Active Feature Specification — YouTube AI 对话文章生成器

> **Single Source of Truth.** Phase 6（`to-spec`）形式化版本，编译自 Phase 1-5 全部决策与研究。

---

## 1. Feature Title
YouTube AI 对话文章生成器（面试/评审交付件）

## 2. Problem Statement
基于一段有字幕的 YouTube 视频，在 Cloudflare Worker 上调用 Gemini，生成一篇中文对话体文章并**流式渲染**到网页；支持可选的自然语言生成要求约束输出；每章节可生成 **5W1H 结构化总结**（复用服务端会话上下文）。部署到 Worker 提供公开访问 URL。

## 3. Stakeholders / Users
- 评审者（面试官）：评估工程审美、产品品味、完成度。
- 作者本人：作 portfolio 演示件。

## 4. Functional Requirements
- **FR-1** 网页接受 YouTube 视频链接（含字幕）+ 可选自然语言生成要求。
- **FR-2** 服务端获取字幕：实时抓取 best-effort，失败/验证码降级到按 videoId 命中的硬编码兜底。
- **FR-3** 服务端调 Gemini `streamGenerateContent`，通过 SSE 把文章增量流式推给浏览器，前端逐段渲染。
- **FR-4** 文章为中文对话体（多角色），按章节组织。
- **FR-5** 生成要求（任务类型/输出风格/目标受众/约束条件）影响输出，不超出其范围。
- **FR-6** 每章节标题旁有 [5W1H] 按钮；点击后展示该章 Who/What/When/Where/Why/How。
- **FR-7** 5W1H 复用服务端保存的本次会话上下文（R2）；前端只发 `{sessionId, chapterId}`，不回传整篇。
- **FR-8** 5W1H 返回结构化数据，固定格式渲染。

## 5. Non-Functional Requirements
- **NFR-1** 部署 Cloudflare Worker，`*.workers.dev` 公开 URL。
- **NFR-2** 主文章流式输出（生成一段渲染一段）。
- **NFR-3** 代码模块清晰、简洁优雅、忌臃肿；体现工程判断与产品品味。
- **NFR-4** 全免费层（Workers / R2 / Gemini 免费额度）。
- **NFR-5** 安全：API Key 存 Worker secret；模型文本 `textContent` 渲染防 XSS；输入校验。

## 6. Architecture

### 6.1 Components / Modules（单 Worker + 静态前端，单仓 monorepo）
```
youtubeAi/
├─ web/                 # 前端：Vite + 原生 TS，无框架
│  ├─ src/
│  │  ├─ main.ts        # 入口
│  │  ├─ sse-client.ts  # SSE 解析 + 增量渲染
│  │  ├─ render.ts      # DOM 渲染（textContent，章节容器）
│  │  └─ api.ts         # fetch 封装
│  └─ index.html
├─ worker/              # Hono API
│  ├─ src/
│  │  ├─ index.ts       # Hono app + 路由
│  │  ├─ routes/
│  │  │  ├─ generate.ts # POST /api/generate (SSE)
│  │  │  └─ summary.ts  # POST /api/summary
│  │  ├─ subtitle/
│  │  │  ├─ resolver.ts # 实时抓 → 硬编码兜底
│  │  │  └─ hardcoded.ts# 演示字幕（数据自 .agents/data/demo-transcript.md）
│  │  ├─ gemini/
│  │  │  ├─ stream.ts   # streamGenerateContent + SSE 解析
│  │  │  ├─ structured.ts# generateContent + responseSchema (5W1H)
│  │  │  └─ prompts.ts  # 文章 prompt + 5W1H prompt 构造
│  │  ├─ session-store/
│  │  │  └─ r2.ts       # R2 put/get + TTL
│  │  └─ parser/
│  │     └─ markers.ts  # <<CH|标题>> 章节标记解析
│  └─ wrangler.jsonc
├─ shared/
│  └─ types.ts          # SSE event / 请求响应 / session 类型
└─ .github/workflows/deploy.yml
```

### 6.2 Data Flow
**生成流（POST /api/generate）：**
```
前端 POST {videoUrl, genReqs?} ──► Worker
  │ parse videoId
  ▼
subtitle.resolver: 实时抓 timedtext → 失败/验证码 → hardcoded[videoId]
  ▼
gemini.prompts: 构造文章 prompt（字幕 + genReqs + 章节标记指令 <<CH|标题>>）
  ▼
gemini.stream: fetch streamGenerateContent?alt=sse
  ▼ 边解析边输出
parser.markers: 识别 <<CH|标题>> → 发 SSE {type:"chapter", id, title}
                其余文本 → 发 SSE {type:"text", text}
                内存累积每章 text
  ▼ 流结束
session-store.r2: R2.put(sessions/{sessionId}.json, {videoId, subtitle, genReqs, chapters}, TTL 24h)
  ▼
发 SSE {type:"manifest", sessionId, chapters:[{id,title}]}
```
**5W1H 流（POST /api/summary）：**
```
前端 POST {sessionId, chapterId} ──► Worker
  ▼
session-store.r2.get → null 返 410
  ▼ 取上下文
gemini.prompts: 5W1H prompt（字幕摘要 + genReqs + 目标章 text）
  ▼
gemini.structured: generateContent + responseSchema(who/what/when/where/why/how)
  ▼
返 {who, what, when, where, why, how} JSON
```

### 6.3 Data Model
**R2 对象：** key `sessions/{sessionId}.json`，value：
```ts
interface SessionContext {
  sessionId: string;
  createdAt: number;
  videoId: string;
  subtitleSource: "hardcoded" | "live";
  subtitleText: string;
  genReqs: { taskType?: string; style?: string; audience?: string; constraints?: string } | null;
  chapters: { id: string; title: string; text: string }[];
}
// put 时设 customMetadata + httpExpiration = epoch秒 + 86400
```
**SSE 事件（Worker → 浏览器）：**
```ts
type SseEvent =
  | { type: "chapter"; id: string; title: string }
  | { type: "text"; text: string }
  | { type: "manifest"; sessionId: string; chapters: { id: string; title: string }[] }
  | { type: "error"; message: string };
```

### 6.4 API Contracts
**POST /api/generate**
- req: `{ videoUrl: string; genReqs?: {...} }`
- res: `text/event-stream`（SseEvent 序列化）
- 错误：4xx 输入不合法；5xx/503 Gemini 失败或限流

**POST /api/summary**
- req: `{ sessionId: string; chapterId: string }`
- res: `{ who, what, when, where, why, how }`（application/json）
- 错误：410 会话过期；422 无此章节；503 Gemini 失败

**GET /** 及静态：Workers Assets 托管 `web/dist`。

## 7. Tech Stack（锁定）
TS · Hono(Worker) · Vite+原生TS(前端) · Gemini REST `streamGenerateContent`/`generateContent` + SSE · R2 会话存储 · Vitest + `@cloudflare/vitest-pool-workers` · GitHub Actions → wrangler deploy。

## 8. Gemini 调用要点（研究落实）
- 端点：`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`
- 认证：`x-goog-api-key` 头（值来自 Worker secret `GEMINI_API_KEY`）
- 文本增量在 `candidates[0].content.parts[].text`（需拼接，无 `[DONE]`）
- `generationConfig.thinkingConfig.thinkingBudget = 0` 降延迟
- 5W1H：非流式 `:generateContent` + `responseMimeType:"application/json"` + `responseSchema`（type 大写如 `STRING`）
- 免费层：10 RPM / 250k TPM / 250 RPD

## 9. Testing Strategy
- **单元（Vitest + vitest-pool-workers）：** `parser.markers`（标记切分）、`subtitle.resolver`（降级路由）、`gemini.prompts`（prompt 拼装）、`session-store.r2`（put/get/TTL，本地 R2 模拟）、`gemini.structured`（响应 → 6 字段映射）。
- **集成：** `/api/generate` 全链路（mock Gemini SSE 流）验证事件序列 + R2 落盘；`/api/summary`（seed R2）验证 410/422/200。
- **手动：** `wrangler deploy` → 跑演示视频 → 点 [5W1H]。

## 10. Explicit Out of Scope
- 用户认证/账号体系。
- 持久历史（会话 TTL 24h 即弃）。
- Worker 内 webshare 代理 HTTPS（ADR-003，技术上不可行）。
- 实时字幕抓取保证（best-effort，失败降级硬编码）。
- 富文本 markdown 渲染（纯 textContent 对话文本）。
- 流式中断续传/重连。
- 多视频库（仅演示 videoId 有硬编码）。

## 11. Acceptance Criteria（Definition of Done）
- [ ] `wrangler deploy` 成功，`*.workers.dev` 公开 URL 可访问。
- [ ] 输入演示视频 URL → 流式渲染中文对话文章，含多章节。
- [ ] 可选生成要求影响输出（不超范围）。
- [ ] 每章节 [5W1H] → 返回结构化 6 字段卡片。
- [ ] GitHub 仓库 + README（取舍/亮点说明）+ CI 自动部署 Action。
- [ ] Vitest 测试通过。
- [ ] 代码模块清晰、简洁、无臃肿。

## 12. Risks & Mitigations
| 风险 | 缓解 |
|---|---|
| 字幕实时抓取不稳定 | 硬编码兜底（演示 videoId 命中） |
| Gemini 不严格输出 `<<CH|>>` 标记 | prompt 强约束 + 整篇降级单章仍可 5W1H |
| 免费层限流 10RPM | 演示足够；429 → 503 重试提示 |
| R2 读后写一致性 | R2 强一致 read-after-write，即时读 OK |
| XSS | 模型文本 textContent 渲染，无 innerHTML |

## 13. Active Tickets (Phase 7 `to-tickets` — 纵向切片)

> 每片端到端可验证、可独立部署、含测试。T2=MVP，T3-T7 递增优化直到全功能。

### T1 · 部署骨架 + 前端壳子（部署链路打通）
- **切片目标**：可部署 Worker 托管静态前端（URL 输入框 + 生成按钮占位），公开 URL 可访问 + CI 自动部署。
- **覆盖**：NFR-1、交付物 1/2 基础
- **验收**：`wrangler deploy` 成功；访问 `*.workers.dev` 见输入页；GitHub Actions green；`GEMINI_API_KEY` secret 已设；R2 binding 配置就绪。
- **测试**：前端壳子渲染；CI workflow 存在且触发。
- **依赖**：无（起点）

### T2 · 硬编码字幕 → 非流式文章（MVP 端到端）
- **切片目标**：输入演示视频 URL → 硬编码字幕 → Gemini **非流式** `generateContent` → 渲染中文对话文章到页面。最小可行方案，证明整条链能跑。
- **覆盖**：FR-1、FR-2(硬编码部分)、FR-4(对话体)、FR-3(非流式先行)
- **验收**：输入演示 URL 返回中文对话文章并渲染；硬编码兜底生效。
- **测试**：`subtitle.resolver`（演示 videoId 命中硬编码）；`gemini.prompts`（文章 prompt 拼装）；mock Gemini 返回 → 文章渲染。
- **依赖**：T1

### T3 · 流式输出 + 章节标记 + 会话落盘
- **切片目标**：把 T2 非流式升级为 `streamGenerateContent?alt=sse` + SSE 流式渲染；加 `<<CH|标题>>` 标记解析 → 章节容器；末尾 manifest + R2 一次性落盘。
- **覆盖**：FR-3(流式)、FR-4(章节)、FR-7 前置(会话上下文存储)
- **验收**：生成过程实时逐段渲染；文章分章节显示；末尾下发 manifest；R2 存入 SessionContext。
- **测试**：`parser.markers`（标记切分/容错降级单章）；SSE 事件序列；`session-store.r2` put/get/TTL（本地模拟）。
- **依赖**：T2

### T4 · 生成要求影响输出
- **切片目标**：前端加生成要求输入（任务类型/输出风格/目标受众/约束条件），传入 prompt 约束输出。
- **覆盖**：FR-5
- **验收**：填生成要求后输出体现约束、不超范围；不填则正常生成。
- **测试**：`gemini.prompts` 含 genReqs 拼装（有/无 genReqs 两分支）。
- **依赖**：T3

### T5 · 5W1H 章节总结（服务端上下文复用）
- **切片目标**：每章节 [5W1H] 按钮 → `POST /api/summary {sessionId,chapterId}` → R2 取上下文 → 非流式 `generateContent` + `responseSchema` → 6 字段卡片渲染。
- **覆盖**：FR-6、FR-7、FR-8
- **验收**：点按钮返回结构化 6 字段并固定格式渲染；前端只发 `{sessionId,chapterId}`；会话过期返 410；无此章节返 422。
- **测试**：`/api/summary` 集成（seed R2：410/422/200 三态）；`gemini.structured`（响应 → 6 字段映射）。
- **依赖**：T3

### T6 · 实时字幕抓取 best-effort + 降级
- **切片目标**：`subtitle.resolver` 先尝试实时抓 timedtext，失败/验证码降级硬编码；演示 videoId 直接命中硬编码。
- **覆盖**：FR-2(实时部分)
- **验收**：非演示 URL 尝试实时抓；失败降级硬编码不崩；演示 URL 直接命中。
- **测试**：`subtitle.resolver`（mock fetch 成功/失败/验证码降级路径）。
- **依赖**：T2（可与 T4/T5 并行）

### T7 · 打磨 + README + 交付收尾
- **切片目标**：README（字幕处理/Gemini 流式/genReqs 影响/5W1H 实现/取舍亮点）、错误态友好、UI 品味、测试补齐。
- **覆盖**：NFR-3、交付物 3
- **验收**：README 完整；错误态（429/410/网络）友好提示；Vitest 全绿；代码简洁无臃肿。
- **测试**：补齐边界用例；全量 `vitest` 通过。
- **依赖**：T5、T6

**执行顺序**：T1 → T2(MVP) → T3 → T4 → T5 → T6 → T7（T6 可与 T4/T5 并行）。
