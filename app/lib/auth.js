'use strict';
/**
 * 访问控制：可选访问口令 + 简单令牌桶限流
 * 未设置 ACCESS_TOKEN / store 口令时不做鉴权（本地自用）。
 */

const store = require('./store');

const WINDOW_MS = 60 * 1000;
const buckets = new Map();

/** 去除首尾可能的引号（Railway Raw Editor 会把引号包含进值） */
function stripQuotes(s) {
  if (typeof s !== 'string') return s;
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1);
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1);
  return s;
}

function clientIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || 'unknown';
}

/** 返回 null 表示放行，否则返回 {code, message} */
function guard(req, { rateLimit = 60, needAuth = true } = {}) {
  // 1. 鉴权
  if (needAuth) {
    const envToken = stripQuotes((process.env.ACCESS_TOKEN || '').trim());
    const tokenFromHeader = String(req.headers['x-access-token'] || '').trim();
    const tokenFromQuery = String(new URL(req.url, 'http://x').searchParams.get('token') || '').trim();
    const token = tokenFromHeader || tokenFromQuery;

    if (envToken) {
      if (token !== envToken) return { code: 401, message: '访问口令不正确' };
    } else if (!store.verifyToken(token)) {
      return { code: 401, message: '需要访问口令，请在「设置」中填写' };
    }
  }

  // 2. 限流
  const limit = Number(process.env.RATE_LIMIT || rateLimit) || rateLimit;
  if (limit > 0) {
    const ip = clientIp(req);
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b || now > b.resetAt) {
      b = { count: 0, resetAt: now + WINDOW_MS };
      buckets.set(ip, b);
    }
    b.count++;
    if (b.count > limit) {
      const wait = Math.ceil((b.resetAt - now) / 1000);
      return { code: 429, message: `请求过于频繁，请 ${wait} 秒后再试` };
    }
  }
  return null;
}

function authRequired() {
  const envToken = (process.env.ACCESS_TOKEN || '').trim();
  if (envToken) return true;
  return Boolean(store.getAuth().tokenHash);
}

/** 定期清理过期的限流桶，避免内存增长 */
function startCleanup() {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets) if (now > b.resetAt) buckets.delete(ip);
  }, WINDOW_MS);
  timer.unref?.();
}

module.exports = { guard, authRequired, clientIp, startCleanup };
