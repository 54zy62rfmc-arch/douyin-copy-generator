'use strict';
/**
 * OpenAI 兼容协议客户端
 * - 流式 SSE 输出
 * - 失败自动重试 + 模型回退（仅在尚未输出任何内容时才重试，避免重复内容）
 * - 支持 HTTP(S) 代理
 * - 支持多模态 messages（视觉）
 */

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const { proxyConnectionFactory, readAll } = require('./net');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function joinUrl(base, suffix) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (/\/(chat\/)?completions$/.test(b)) return b;
  return b + suffix;
}

function isRetriable(err) {
  const code = err.statusCode;
  if (code) return code === 408 || code === 409 || code === 429 || code >= 500;
  const msg = String(err.message || '');
  // AggregateError：Node 同时尝试 IPv4/IPv6 连接全部失败（跨国链路抖动常见），需要重试
  return /超时|timeout|AggregateError|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|socket hang up|代理 CONNECT 失败|fetch failed/i.test(msg);
}

function openRequest({ url, headers, body, proxyUrl, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const options = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers,
    };
    if (proxyUrl && isHttps) options.createConnection = proxyConnectionFactory(proxyUrl);

    const req = mod.request(options, resolve);
    // 连接级快速超时：跨国链路抖动时 TCP 可能长时间挂起，20 秒无响应即失败并交由上层重试
    const connectTimer = setTimeout(() => req.destroy(new Error(`大模型接口请求超时（连接 20s 无响应）`)), 20000);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`大模型接口请求超时（${timeoutMs}ms）`)));
    req.once('error', reject);
    req.once('response', () => clearTimeout(connectTimer));
    if (body) req.write(body);
    req.end();
  });
}

/** 单次流式调用 */
async function* streamCompletion({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature = 0.9,
  maxTokens = 2600,
  proxyUrl,
  timeoutMs = 120000,
}) {
  const url = joinUrl(baseUrl, '/chat/completions');
  const payload = JSON.stringify({
    model,
    messages,
    stream: true,
    temperature: Number(temperature) || 0.9,
    max_tokens: Number(maxTokens) || 2600,
  });

  const res = await openRequest({
    url,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${apiKey}`,
    },
    body: payload,
    proxyUrl,
    timeoutMs,
  });

  if (res.statusCode >= 400) {
    const raw = await readAll(res);
    let detail = raw.text?.slice(0, 400) || '';
    try {
      const j = JSON.parse(detail);
      detail = j.error?.message || j.message || detail;
    } catch {}
    const err = new Error(`大模型接口返回 ${res.statusCode}：${detail}`);
    err.statusCode = res.statusCode;
    throw err;
  }

  let buf = '';
  for await (const chunk of res) {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const delta =
          json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? '';
        if (delta) yield delta;
      } catch {
        /* 忽略心跳与非法分片 */
      }
    }
  }
}

/**
 * 带重试与模型回退的流式调用
 * @param {object} opts
 * @param {string[]} opts.models 模型列表，按顺序回退
 * @param {number} opts.retries 每个模型的重试次数
 * @param {(model:string, attempt:number)=>void} opts.onAttempt 每次尝试前回调
 */
async function* streamSmart({ models, retries = 2, onAttempt, ...opts }) {
  const list = (models || []).filter(Boolean);
  if (!list.length) throw new Error('未配置模型名');
  let lastErr = null;

  for (let mi = 0; mi < list.length; mi++) {
    const model = list[mi];
    for (let attempt = 0; attempt <= retries; attempt++) {
      let emitted = false;
      try {
        onAttempt?.(model, attempt);
        for await (const delta of streamCompletion({ ...opts, model })) {
          emitted = true;
          yield delta;
        }
        return;
      } catch (err) {
        lastErr = err;
        // 已经吐出过内容就不能重试，否则会出现重复片段
        if (emitted) throw err;
        if (!isRetriable(err)) throw err;
        const isLastAttempt = attempt === retries;
        const isLastModel = mi === list.length - 1;
        if (isLastAttempt && isLastModel) throw err;
        await sleep(Math.min(4000, 700 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr || new Error('生成失败');
}

/** 一次性取回完整文本（非流式场景：信息提取、合规改写等） */
async function collect(gen) {
  let out = '';
  for await (const d of gen) out += d;
  return out;
}

/** 从模型输出中容错地提取 JSON */
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const candidate = s.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    // 常见问题：尾随逗号
    try {
      return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

module.exports = { streamCompletion, streamSmart, collect, extractJson, isRetriable, joinUrl };
