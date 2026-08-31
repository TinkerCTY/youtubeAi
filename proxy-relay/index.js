/**
 * webshare.io 代理转发服务
 *
 * 功能：接收 HTTP 请求 → 通过 webshare.io HTTP 代理 → 转发到目标 URL → 返回响应
 *
 * 部署：Render / Railway / Vercel / Fly.io / 任何 Node.js 18+ 平台
 *
 * 环境变量：
 *   PROXY_USERNAME  webshare.io 代理用户名（必填）
 *   PROXY_PASSWORD  webshare.io 代理密码（必填）
 *   PROXY_HOST      webshare.io 代理主机（默认 p.webshare.io）
 *   PROXY_PORT      webshare.io 代理端口（默认 80）
 *   PORT            服务监听端口（默认 3000，Render 自动注入）
 *
 * 用法：
 *   GET http://your-relay.example.com/?url=https%3A%2F%2Fwww.youtube.com%2F...
 *
 * 在主项目的 Cloudflare Worker 中配置：
 *   PROXY_URL=https://your-relay.example.com/?url=
 *
 * 获取 webshare.io 凭据：
 *   1. 注册 https://www.webshare.io/（免费 10 个代理 IP）
 *   2. Dashboard → Proxy → Stock Proxy → 找到 Username 和 Password
 *   3. 填入环境变量 PROXY_USERNAME / PROXY_PASSWORD
 */

import http from 'node:http';
import { ProxyAgent, fetch } from 'undici';

const PORT = process.env.PORT || 3000;

/**
 * ⚠️  Webshare Rotating Residential 官方配置
 *     Sticky Session 机制：在 username 后追加 `-session-<sessionId>`
 *       - 相同 sessionId → 分配同一个住宅 IP（最长 60 分钟，webshare 自动保证）
 *       - 不同 sessionId → 正常 rotate
 *     应用场景：
 *       YouTube watch-page 会返回带 signature= 的 signed baseUrl，
 *       signature 校验会**绑定请求来源 IP 上下文**。
 *       若 watch-page 抓取走 IP-A、timedtext 请求走 IP-B（rotate 导致），
 *       YouTube 会静默返回 events=[]（200 OK 但 body 空），字幕内容提取失败。
 *     因此：从 targetUrl 的查询字符串中解析 `v=` 作为 sessionId，
 *       让「同一个视频」的所有相关请求始终落在同一个住宅 IP。
 */
const FORCE_OFFICIAL_CONFIG = true;
const OFFICIAL = {
  username: 'jlkwejwd-rotate',  // 不含 sticky 后缀
  password: 'mkxz3lp0gblf',
  host: 'p.webshare.io',
  port: '80',
};

const PROXY_USERNAME_BASE = FORCE_OFFICIAL_CONFIG ? OFFICIAL.username : (process.env.PROXY_USERNAME || OFFICIAL.username);
const PROXY_PASSWORD = FORCE_OFFICIAL_CONFIG ? OFFICIAL.password : (process.env.PROXY_PASSWORD || OFFICIAL.password);
const PROXY_HOST = FORCE_OFFICIAL_CONFIG ? OFFICIAL.host : (process.env.PROXY_HOST || OFFICIAL.host);
const PROXY_PORT = FORCE_OFFICIAL_CONFIG ? OFFICIAL.port : (process.env.PROXY_PORT || OFFICIAL.port);

if (!PROXY_USERNAME_BASE || !PROXY_PASSWORD) {
  console.error('PROXY_USERNAME and PROXY_PASSWORD are required');
  console.error('Get them from https://www.webshare.io/ Dashboard');
  process.exit(1);
}

/** 从 target URL 解析 sticky session id：
 *  1) 优先取查询字符串里的 v=（YouTube video ID）
 *  2) 没有则取 path 最后一段（/watch、/api/timedtext 这些 path）
 *  3) 都没有 → 用 'default'
 */
function resolveSessionId(targetUrl) {
  try {
    const u = new URL(targetUrl);
    const v = u.searchParams.get('v');
    if (v && v.length <= 64) return v;
    const pathParts = u.pathname.split('/').filter(Boolean);
    if (pathParts.length) return pathParts[pathParts.length - 1].slice(0, 32);
    return 'default';
  } catch (_e) {
    return 'default';
  }
}

/** 按 session 创建 ProxyAgent（做个 LRU 缓存，避免每个请求都 new 一次） */
const AGENT_CACHE_MAX = 128;
const agentCache = new Map();
function getAgentForSession(sessionId) {
  const cached = agentCache.get(sessionId);
  if (cached) return cached;
  const username = `${PROXY_USERNAME_BASE}-session-${sessionId}`;
  const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(PROXY_PASSWORD)}@${PROXY_HOST}:${PROXY_PORT}`;
  const agent = new ProxyAgent(proxyUrl);
  agentCache.set(sessionId, agent);
  if (agentCache.size > AGENT_CACHE_MAX) {
    // 淘汰最老的一个
    const firstKey = agentCache.keys().next().value;
    agentCache.delete(firstKey);
  }
  return agent;
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 健康检查
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', proxy: `${PROXY_HOST}:${PROXY_PORT}` }));
    return;
  }

  // 代理端点：/?url=<encoded_target_url>
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing ?url= parameter' }));
    return;
  }

  try {
    const sessionId = resolveSessionId(targetUrl);
    const agent = getAgentForSession(sessionId);

    const response = await fetch(targetUrl, {
      dispatcher: agent,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });

    const text = await response.text();
    const contentType = response.headers.get('content-type') || 'application/json';
    res.writeHead(response.status, { 'Content-Type': contentType });
    res.end(text);
  } catch (e) {
    console.error(`Proxy fetch failed: ${e.message}`);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Proxy fetch failed: ${e.message}` }));
  }
});

server.listen(PORT, () => {
  console.log(`Proxy relay running on port ${PORT}`);
  console.log(`  Proxy: ${PROXY_HOST}:${PROXY_PORT}`);
  console.log(`  Usage: http://localhost:${PORT}/?url=<encoded_target_url>`);
});
