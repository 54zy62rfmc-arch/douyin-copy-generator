'use strict';
/**
 * 统一 HTTP 客户端：支持超时、重定向、HTTP(S) 代理 CONNECT 隧道
 * 供大模型调用与商品页抓取复用。
 */

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { URL } = require('node:url');

/** 通过代理 CONNECT 隧道建立到目标主机的连接 */
function proxyConnectionFactory(proxyUrl) {
  const proxy = new URL(proxyUrl);
  const proxyPort = proxy.port || (proxy.protocol === 'https:' ? 443 : 80);
  const auth = proxy.username
    ? 'Basic ' +
      Buffer.from(
        `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`
      ).toString('base64')
    : null;

  return function createConnection(opts, cb) {
    const target = `${opts.host}:${opts.port}`;
    const connectReq = http.request({
      host: proxy.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: target,
      agent: false,
      headers: Object.assign({ Host: target }, auth ? { 'Proxy-Authorization': auth } : {}),
    });
    connectReq.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        cb(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`));
        return;
      }
      cb(null, tls.connect({ socket, servername: opts.servername || opts.host }));
    });
    connectReq.once('error', cb);
    connectReq.end();
  };
}

function readAll(stream, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve) => {
    let out = Buffer.alloc(0);
    let truncated = false;
    stream.on('data', (c) => {
      if (out.length >= maxBytes) {
        truncated = true;
        return;
      }
      out = Buffer.concat([out, c]);
    });
    stream.on('end', () => resolve({ text: out.toString('utf8'), truncated }));
    stream.on('error', () => resolve({ text: out.toString('utf8'), truncated }));
  });
}

/**
 * 发起一次请求（自动跟随重定向）
 * @returns {Promise<{statusCode:number, headers:object, body:string, finalUrl:string}>}
 */
async function request({
  url,
  method = 'GET',
  headers = {},
  body,
  proxyUrl,
  timeoutMs = 30000,
  redirects = 0,
  maxRedirects = 5,
  maxBytes = 2 * 1024 * 1024,
}) {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const mod = isHttps ? https : http;

  const options = {
    method,
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + u.search,
    headers: Object.assign(
      { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1', Accept: '*/*' },
      headers
    ),
  };
  if (proxyUrl && isHttps) options.createConnection = proxyConnectionFactory(proxyUrl);

  const res = await new Promise((resolve, reject) => {
    const req = mod.request(options, resolve);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
    req.once('error', reject);
    if (body) req.write(body);
    req.end();
  });

  const status = res.statusCode || 0;
  if (status >= 300 && status < 400 && res.headers.location && redirects < maxRedirects) {
    res.resume();
    const next = new URL(res.headers.location, url).toString();
    return request({ url: next, method, headers, body, proxyUrl, timeoutMs, redirects: redirects + 1, maxRedirects, maxBytes });
  }

  const { text, truncated } = await readAll(res, maxBytes);
  return { statusCode: status, headers: res.headers, body: text, finalUrl: url, truncated };
}

module.exports = { request, proxyConnectionFactory, readAll };
