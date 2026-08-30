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
const PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';
const PROXY_HOST = process.env.PROXY_HOST || 'p.webshare.io';
const PROXY_PORT = process.env.PROXY_PORT || '80';

if (!PROXY_USERNAME || !PROXY_PASSWORD) {
  console.error('PROXY_USERNAME and PROXY_PASSWORD are required');
  console.error('Get them from https://www.webshare.io/ Dashboard');
  process.exit(1);
}

const proxyUrl = `http://${PROXY_USERNAME}:${PROXY_PASSWORD}@${PROXY_HOST}:${PROXY_PORT}`;
const agent = new ProxyAgent(proxyUrl);

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
