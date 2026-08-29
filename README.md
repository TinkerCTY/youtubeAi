# YouTube AI · 中文文章生成器

> 基于 YouTube 视频字幕，用 Gemini AI Studio 生成中文对话体文章，支持 SSE 流式章节渲染、5W1H 章节总结、生成要求（风格/受众/约束）注入、实时字幕抓取 best-effort + 硬编码降级。
>
> 📦 部署目标：**Cloudflare Worker + R2**（边缘运行 + 免费配额 + 24h 会话存储）

---

## ✨ 功能总览

| # | 能力 | 说明 |
|---|---|---|
| T2 | 硬编码字幕 MVP | 演示用白名单视频，无抓取也能生成（**不炸兜底**） |
| T3 | SSE 流式章节渲染 | `streamGenerateContent?alt=sse` 边生成边推送；文章按 `<<CH|章节标题>>` 切分章节 |
| T4 | 生成要求全链路加固 | `taskType/style/audience/constraints` 四维硬约束，system + user 双重 prompt 强制遵守 |
| T5 | 5W1H 章节总结 | `responseSchema` 强制返回结构化 JSON，**前端只发 `{sessionId, chapterId}`** → 服务端从 R2 取上下文（不重传整篇） |
| T6 | 实时字幕 fallback | `https://www.youtube.com/api/timedtext` zh-Hans → zh-CN → en 三级回退；403/空/解析失败/网络异常一律降级硬编码 |
| 存储 | R2 Session Store | 会话 24h TTL：字幕 + 章节 + 生成要求，供 5W1H 复用 |

---

## 🏗️ 架构图

```
┌──────────────┐   POST /api/generate   ┌─────────────────────────────────────────┐
│   浏览器前端  │ ─────────────────────▶ │  Cloudflare Worker (Hono + TS)          │
│  (Vite + TS) │ ◀─────── SSE ───────── │                                         │
└──────┬───────┘   event:chapter/text/  │  resolveSubtitle ─┬─▶ timedtext (live)  │
       │           manifest/error       │                   └─▶ hardcoded (fall)   │
       │                                │                                         │
       │  POST /api/summary             │  streamGemini (SSE)  ←  Gemini REST API │
       │  {sessionId, chapterId}        │  geminiStructured  ←  responseSchema    │
       └───────────────────────────────▶│                                         │
                                        │ put/getSession ────▶ R2 (youtube-ai-ses)│
                                        └─────────────────────────────────────────┘
```

---

## 📁 项目结构（Monorepo · npm workspaces）

```
.
├── .github/workflows/deploy.yml   # GitHub Actions：测试+构建+wrangler deploy
├── package.json                   # workspaces: web | worker | shared
│
├── shared/
│   └── types.ts                   # GenReqs / Chapter / SessionContext / SseEvent / SummaryRequest / SummaryResponse
│
├── worker/                        # Cloudflare Worker (Hono + TS + Vitest)
│   ├── wrangler.jsonc             # name=youtube-ai, assets=../web/dist, r2=SESSION_BUCKET
│   ├── src/
│   │   ├── index.ts               # Hono app 挂载 /api/generate /api/summary /api/health
│   │   ├── routes/
│   │   │   ├── generate.ts        # /api/generate → SSE + R2 落盘 SessionContext
│   │   │   └── summary.ts         # /api/summary  → Gemini responseSchema 5W1H JSON
│   │   ├── subtitle/
│   │   │   ├── resolver.ts        # 异步：live 优先→失败降级硬编码
│   │   │   ├── timedtext.ts       # YouTube timedtext json3 多语言解析
│   │   │   └── hardcoded.ts       # 演示视频白名单 + 字幕正文
│   │   ├── gemini/
│   │   │   ├── stream.ts          # SSE 解析（streamGenerateContent?alt=sse）
│   │   │   ├── structured.ts      # generateContent + responseSchema → typed JSON
│   │   │   ├── generate.ts        # 非流式 generateContent（兜底）
│   │   │   └── prompts.ts         # ARTICLE_SYSTEM / SUMMARY_SYSTEM / buildArticlePrompt / build5W1HPrompt / appendGenReqs
│   │   ├── parser/markers.ts      # <<CH|标题>> 流式切章（跨 delta 合并）
│   │   └── session-store/r2.ts    # putSession 24h TTL + getSession (R2)
│   └── test/                      # 13 文件 68 TDD 测试（覆盖率：所有核心模块）
│
└── web/                           # 前端：原生 TypeScript + Vite，无框架
    ├── index.html                 # 样式：章节卡片 / [5W1H] 按钮 / 固定六字段卡片
    └── src/
        ├── main.ts                # DOMContentLoaded：表单提交 → SSE → renderer
        ├── api.ts                 # postGenerate (ReadableStream) / postSummary (typed)
        ├── sse-client.ts          # consumeSse 解析 → onChapter onText onManifest onError
        └── render.ts              # ArticleRenderer：章节 + [5W1H] 按钮 + 六字段卡片
```

---

## 🚀 快速开始

### 环境要求

- **Node.js ≥ 20** （GitHub Actions 使用 Node 20 LTS）
- **npm ≥ 10**
- 本地测试不需要 Cloudflare / Gemini 凭证（Gemini / fetch 都由 Vitest mock 覆盖）

### 本地安装

```bash
cd youtubeAi
npm install
```

### 运行所有测试（68 个 TDD cases）

```bash
npm test
# ✓ test/13 files 68 tests PASSED
```

### 本地类型检查

```bash
cd worker && npx tsc --noEmit
cd ../web   && npx tsc --noEmit
```

### 本地开发

**方式 A：前端 Vite dev server + 独立 Worker dev（最快）**

```bash
# 终端 1：前端（端口 5173）
cd web && npm run dev

# 终端 2：Worker（需要 Cloudflare 登录一次；或本地只跑测试不 dev）
cd worker && npx wrangler login
npm run dev
```

**方式 B：构建前端 → Worker dev 直接托管**
> wrangler.jsonc 中 `assets.directory = "../web/dist"`，所以先 build 前端再 `wrangler dev`，访问 Worker URL 即可看到完整页面。

```bash
npm run build    # web/dist 产出
cd worker && npm run dev
# → 打开 http://localhost:8787
```

### 一键部署（本地 wrangler）

```bash
# 需要已 wrangler login；GEMINI_API_KEY 用 wrangler secret 写入
cd worker
npx wrangler secret put GEMINI_API_KEY   # 粘贴 Gemini API Key
cd ..
npm run deploy
```

---

## 🔐 部署所需 Secrets（GitHub → Settings → Secrets and variables → Actions）

| Secret 名称 | 获取方式 | 作用 |
|---|---|---|
| **`CLOUDFLARE_API_TOKEN`** | Cloudflare Dashboard → My Profile → API Tokens → **Create Token** → 选「Edit Cloudflare Workers」模板 → Zone: 选对应账号/域（或 Include All）；**R2**: Edit（Bucket 读写）；**Workers AI**: 可选 | GitHub Actions 用 wrangler-action 部署 Worker/R2 |
| **`CLOUDFLARE_ACCOUNT_ID`** | Cloudflare Dashboard → 左侧「Workers & Pages」→ 右侧「Account ID」（32 位 hex） | 指定部署目标账号 |
| **`GEMINI_API_KEY`** | https://aistudio.google.com/apikey → **Create API Key** | Worker 环境变量：调用 Gemini REST API |

### Cloudflare 前置准备（只需一次）

1. **创建 R2 Bucket**：Cloudflare Dashboard → R2 → Create bucket → 名称 **`youtube-ai-sessions`**（需与 [wrangler.jsonc](worker/wrangler.jsonc) 中 `r2_buckets[].bucket_name` 完全一致）。
2. （可选）绑定自定义域名：Worker 部署后 Settings → Triggers → Routes → 添加你自己的域名。

---

## 🧪 API 接口

### `POST /api/generate` → `text/event-stream`（SSE）

**Request Body**

```json
{
  "videoUrl": "https://www.youtube.com/watch?v=xRh2sVcNXQ8",
  "genReqs": {
    "taskType":     "会议纪要",
    "style":        "幽默段子体",
    "audience":     "普通读者",
    "constraints":  "800字内，禁用人身攻击"
  }
}
```

`genReqs` 全部字段可选。传任一非空字段即触发 **T4 双重强约束（system + user）**。

**SSE Events**（每条独立 JSON，用 `data: {...}\n\n` 分隔）

| type | 字段 | 说明 |
|---|---|---|
| `chapter` | `{ id, title }` | 新章节开始，章节卡片插入 DOM |
| `text`    | `{ text }`        | 流式增量正文片段 → 追加到当前章节（`textContent` 防 XSS） |
| `manifest`| `{ sessionId, chapters: [{id,title}] }` | **一次性**：会话结束前推送。前端保存 `sessionId` → 每个章节 `[5W1H]` 按钮绑定 |
| `error`   | `{ message }`     | Gemini 失败/429 等，前端显示错误条，不抛到顶层 |

### `POST /api/summary` → `application/json`（5W1H 结构化）

**Request Body**

```json
{ "sessionId": "uuid-from-manifest", "chapterId": "1" }
```

**Response（Gemini responseSchema 强约束 6 字段）**

```json
{
  "who":   "本章节涉及的人物/主体",
  "what":  "核心事件或议题",
  "when":  "时间/阶段，未明述则注明推断",
  "where": "地域/行业/应用场景，未明述则注明推断",
  "why":   "起因与背后动因",
  "how":   "机制/方法/路径"
}
```

**错误码**
- `400` 缺 `sessionId`/`chapterId`
- `410` Session 过期或不存在（R2 24h TTL，或从未生成）
- `422` 章节 ID 不存在
- `503` Gemini 调用失败（限流/超时/配额）

### `GET /api/health`

```json
{ "ok": true }
```

---

## 🧭 字幕策略（T6）

```
resolveSubtitle(videoId)
   │
   ├─ ① fetchTimedText
   │     顺序尝试：lang=zh-Hans fmt=json3 → zh-CN → en
   │     任一成功且 extractText 非空 ⇒ return { source: 'live' }
   │
   └─ 任何失败（HTTP 4xx/5xx / 解析空 / JSON parse 错 / 网络抛错）
         │
         ├─ 命中 HARDCODED_SUBTITLES[videoId] ⇒ return { source: 'hardcoded' }
         └─ 都没有 ⇒ return null  → /api/generate 404
```

### 增加一个新的硬编码字幕视频

编辑 [worker/src/subtitle/hardcoded.ts](worker/src/subtitle/hardcoded.ts)：

```typescript
export const HARDCODED_SUBTITLES: Record<string, string> = {
  'xRh2sVcNXQ8': '......',     // 已有演示视频（Marc Andreessen AI 访谈）
  'YOUR_VIDEO_ID': '把完整字幕贴这里，保持段落换行……',
};
```

> 注：硬编码字幕只用作演示/降级兜底。正常情况下 `youtube.com/api/timedtext` 不需要 API Key 即可匿名访问，只要视频作者开启了字幕轨道。

---

## 🛡️ 安全与合规

- **XSS**：所有 SSE delta、5W1H 六字段、错误消息都通过 `Node.textContent` 写入 DOM，**不使用 `innerHTML`**。
- **密钥**：`GEMINI_API_KEY` 只存储为 Cloudflare Worker Secret / GitHub Actions Secret，代码中**零硬编码**。
- **会话 TTL**：R2 写入时设置 `httpMetadata.cacheExpiry = createdAt + 24h`，过期后 `/api/summary` 返回 `410 Gone`（不会无限增长费用）。
- **Gemini 输入**：字幕最长会被 truncate（如需限制在 prompt 长度内，可在 `buildArticlePrompt` 里加 `subtitle.slice(0, 80_000)` 兜底）。
- **生成要求边界**：`appendGenReqs` 明确了「事实忠实性 > 约束措辞」，避免模型为贴合风格编造。

---

## 🧩 常见问题 FAQ

**Q: 为什么要用 SSE 而不是 WebSocket？**
A: Worker + Hono 用 SSE 更轻量（纯 HTTP 1.1，兼容所有 CDN/代理），并且 Gemini 原生支持 `?alt=sse` 流式输出，整条链路「串流」不需要在 Worker 中聚合完整响应再下发。

**Q: 5W1H 为什么不直接从前端把章节正文一起发给 `/api/summary`？**
A: R2 上下文复用两大好处：① 前端只发 2 个 UUID（payload < 100 字节），节省带宽且移动端体验好；② `/api/summary` 能同时拿到 **完整字幕（全局背景）+ 章节内容 + 生成要求**，让 5W1H 的 when/where 推断更准确，且风格/约束与文章正文保持一致。

**Q: 实时抓取被 YouTube 判定验证码/403 怎么办？**
A: T6 保证 403 自动降级到硬编码字幕（白名单视频始终可用）。想扩大「实时抓取成功率」可以：（1）在 Cloudflare 侧把 Worker 绑定付费静态 IP 出站（Workers Paid Plan）；（2）自建一个 timedtext 代理（推荐规避）。当前 MVP 满足面试交付件要求。

**Q: 修改 Gemini 模型？**
A: 修改 [worker/src/gemini/stream.ts](worker/src/gemini/stream.ts) URL：默认 `models/gemini-2.0-flash`（性价比最优）；需要 pro 模型改成 `gemini-2.0-pro`。同理 `structured.ts`。

---

## 📋 交付验收清单（Checklist）

- [x] T1: Cloudflare Worker/Hono + Vite + npm workspaces 骨架
- [x] T2: 硬编码字幕文章生成 MVP（无外部依赖也能演示）
- [x] T3: SSE 流式章节渲染 + R2 SessionContext 24h 落盘
- [x] T4: GenReqs 四维（taskType/style/audience/constraints）端到端 + 双重 prompt 强化
- [x] T5: Gemini responseSchema 5W1H 结构化输出；前端 `{sessionId, chapterId}` 上下文复用
- [x] T6: timedtext 多语言 best-effort 抓取；403/解析空/网络异常 → 自动降级硬编码
- [x] 测试：Worker 13 test files / **68 TDD cases**，`tsc --noEmit` 无错
- [x] 前端：原生 TS + Vite，`vite build` 成功，`tsc --noEmit` 无错
- [x] CI/CD：`.github/workflows/deploy.yml`（测试→构建→wrangler deploy + Secret 注入）
- [x] 文档：本 README 含架构 / 目录 / 接口 / Secrets / 本地运行 / FAQ

---

## 📝 License & Credits

- 演示用硬编码字幕的视频：**Marc Andreessen's 2026 Outlook on AI**（公开 YouTube 访谈），仅作演示素材。
- Cloudflare Worker / R2：Cloudflare Inc.
- Gemini AI：Google AI Studio。
