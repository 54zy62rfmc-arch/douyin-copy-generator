'use strict';
/**
 * 抖音短视频带货爆款文案生成器 —— 服务端（零依赖 Node）
 * 能力：
 *  - 静态前端（PWA）
 *  - /api/generate 流式生成（含样本 few-shot、热词库注入、生成后合规校验）
 *  - /api/rewrite 段落级局部重写
 *  - /api/extract 商品链接解析 / /api/vision 主图识图
 *  - /api/history /api/hotwords /api/samples 服务端落库
 *  - 访问口令 + 限流；模型自动重试与回退
 *  - 可选 HTTPS（TLS_CERT / TLS_KEY）
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildMessages, buildRewriteMessages, buildExtractMessages, buildParseMessages, buildTrendingMessages, buildComplianceMessages, buildVisionMessages, buildVisionMetricsMessages, SCENE_LABEL, pickAngles } = require('./lib/prompts');
const { streamSmart, collect, extractJson } = require('./lib/llm');
const { buildDemo, rewriteSection, VARIANT_SCENES, DEMO_NOTE } = require('./lib/demo');
const { scan, groupByCategory, safeRewrite, RULES } = require('./lib/compliance');
const { selectSamples } = require('./lib/samples');
const { heuristicFromHtml, heuristicParseText, heuristicParseTrending, stripTags } = require('./lib/extract');
const ab = require('./lib/ab');
const store = require('./lib/store');
const auth = require('./lib/auth');
const { request: httpRequest } = require('./lib/net');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const BUILD_ID = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');

/* ---------- .env 加载 ---------- */
function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnvFile();

process.env.__BUILD = 'build-20261019-5';

// Railway Raw Editor 中带引号的值会把引号包含进 process.env，这里统一去除首尾引号
for (const key of Object.keys(process.env)) {
  const v = process.env[key];
  if (typeof v === 'string' && v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    process.env[key] = v.slice(1, -1);
  }
}

const PORT = Number(process.env.PORT || 8000);
const DEFAULT_BASE = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
const DEFAULT_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const DEFAULT_VISION_MODEL = process.env.LLM_VISION_MODEL || DEFAULT_MODEL;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大（主图请压缩后再上传，建议小于 1MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/* ---------- 静态资源 ---------- */
function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return void res.writeHead(403).end('Forbidden');

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    // 前端代码每次校验，避免改完刷新仍是旧版本
    const revalidate = ['.html', '.js', '.css', '.webmanifest'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': revalidate ? 'no-cache, must-revalidate' : 'public, max-age=86400',
    });
    // sw.js 注入构建时间戳作为缓存版本，服务每次重启即视为新版本，旧缓存自动清理
    if (rel === 'sw.js') {
      res.end(fs.readFileSync(filePath, 'utf8').replace(/__BUILD__/g, BUILD_ID));
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------- 大模型配置 ---------- */
function resolveConfig(req) {
  const apiKey = (req.headers['x-llm-key'] || process.env.LLM_API_KEY || process.env.LLM_API_KE || '').trim();
  const baseUrl = (req.headers['x-llm-base'] || DEFAULT_BASE).trim();
  const models = String(req.headers['x-llm-model'] || process.env.LLM_MODELS || DEFAULT_MODEL)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const visionModel = (req.headers['x-llm-vision-model'] || DEFAULT_VISION_MODEL).trim();
  const proxyUrl = (
    req.headers['x-llm-proxy'] ||
    process.env.LLM_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    ''
  ).trim();
  return { apiKey, baseUrl, models, visionModel, proxyUrl };
}

function llmOpts(cfg, messages, extra = {}) {
  return {
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    messages,
    models: cfg.models,
    retries: Number(process.env.LLM_RETRIES || 2),
    temperature: extra.temperature ?? process.env.LLM_TEMPERATURE,
    maxTokens: extra.maxTokens ?? process.env.LLM_MAX_TOKENS,
    proxyUrl: cfg.proxyUrl || undefined,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- SSE 辅助 ---------- */
function openSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const state = { closed: false };
  req.on('close', () => (state.closed = true));
  const send = (obj) => {
    if (state.closed) return;
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  // 心跳，避免长连接被中间网络/反代掐断
  const heartbeat = setInterval(() => {
    if (!state.closed) res.write(': ping\n\n');
  }, 15000);
  state.finish = () => {
    clearInterval(heartbeat);
    if (!state.closed) res.end();
  };
  return { send, state };
}

function compliancePayload(text, category) {
  const result = scan(text, { category });
  return {
    level: result.level,
    summary: result.summary,
    groups: groupByCategory(result.hits),
    hits: result.hits,
    count: result.hits.length,
  };
}

/* ---------- A/B 投放回流：合并本地与服务端历史，产出可反哺的洞察 ---------- */
function abInsight(clientItems) {
  const merged = ab.mergeItems(store.getHistory(), Array.isArray(clientItems) ? clientItems : []);
  const analysis = ab.analyze(merged);
  // 样本太少时不注入，避免误导
  return analysis.sampleCount >= 3 && analysis.winners.length
    ? { sampleCount: analysis.sampleCount, winners: analysis.winners }
    : null;
}

/* ---------- /api/generate ---------- */
async function handleGenerate(req, res) {
  let payload;
  try {
    payload = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }

  const scene = payload.scene;
  if (!SCENE_LABEL[scene]) return sendJson(res, 400, { error: '未知场景，仅支持 talk / title / storyboard' });

  const form = payload.form || {};
  let count = Math.min(10, Math.max(1, Number(payload.count) || 1));
  if (!VARIANT_SCENES.includes(scene)) count = 1;

  const cfg = resolveConfig(req);
  const insight = abInsight(payload.abItems);
  const { send, state } = openSse(req, res);

  try {
    let text = '';
    if (!cfg.apiKey) {
      send({ mode: 'demo', count });
      text = buildDemo(scene, form, { count });
      for (let i = 0; i < text.length; i += 6) {
        if (state.closed) return state.finish();
        send({ delta: text.slice(i, i + 6) });
        await sleep(10);
      }
    } else {
      // 样本库 few-shot 检索（词面匹配）
      const keywords = [
        form.productName,
        form.usageScene,
        form.audience,
        ...(Array.isArray(form.sellingPoints) ? form.sellingPoints : []),
      ].filter(Boolean);
      const samples = selectSamples(
        { scene, category: form.category, tone: form.tone, keywords },
        store.getSamples(),
        2
      );
      const hotwords = store.hotwordGroups(); // 全场景注入：手动词库 + 未过期热榜

      // 并行差异化变体：count>1 或指定单角度时，每个变体独立请求，角度互不重复、温度递增
      const parallelAngles = pickAngles(count, payload.excludeAngles, payload.angle);
      if (count > 1 || payload.variantSingle) {
        const angles = payload.variantSingle ? parallelAngles.slice(0, 1) : parallelAngles;
        send({ mode: 'llm', count: angles.length, parallel: true, samples: samples.length, models: cfg.models, angles });
        if (insight) send({ ab: insight });
        const results = new Array(angles.length).fill('');
        await Promise.all(
          angles.map(async (angle, i) => {
            const messages = buildMessages(scene, form, { samples, hotwords, count: 1, insight, variantMode: true, angle });
            try {
              send({ vstart: i, angle });
              const stream = streamSmart({
                ...llmOpts(cfg, messages, {
                  temperature: Math.min(1.05, 0.72 + i * 0.08),
                  maxTokens: Number(process.env.LLM_VARIANT_MAX_TOKENS || 1600),
                }),
                onAttempt: (model, attempt) => send({ model, attempt, v: i }),
              });
              for await (const delta of stream) {
                if (state.closed) return;
                results[i] += delta;
                send({ v: i, delta });
              }
            } catch (e) {
              if (!state.closed) send({ v: i, error: String(e.message || e) });
            }
            if (!state.closed) send({ vdone: i, angle, compliance: compliancePayload(results[i], form.category) });
          })
        );
        if (state.closed) return state.finish();
        text = angles.map((a, i) => `### 变体${i + 1} · ${a}\n${results[i].trim()}`).join('\n\n');
      } else {
        send({ mode: 'llm', count, samples: samples.length, models: cfg.models });
        if (insight) send({ ab: insight });
        const messages = buildMessages(scene, form, { samples, hotwords, count, insight });
        const stream = streamSmart({
          ...llmOpts(cfg, messages, { maxTokens: process.env.LLM_MAX_TOKENS }),
          onAttempt: (model, attempt) => send({ model, attempt }),
        });
        for await (const delta of stream) {
          if (state.closed) return state.finish();
          text += delta;
          send({ delta });
        }
      }
    }
    send({ compliance: compliancePayload(text, form.category) });
    send({ done: true });
    state.finish();
  } catch (err) {
    if (!state.closed) {
      send({ error: String(err.message || err) });
      state.finish();
    }
  }
}

/* ---------- /api/rewrite ---------- */
async function handleRewrite(req, res) {
  let payload;
  try {
    payload = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const { scene, sectionTitle, sectionText, form, instruction } = payload;
  if (!sectionText) return sendJson(res, 400, { error: '缺少需要重写的原文' });

  const cfg = resolveConfig(req);
  const { send, state } = openSse(req, res);

  try {
    let text = '';
    if (!cfg.apiKey) {
      send({ mode: 'demo' });
      text = rewriteSection({ sectionTitle, sectionText, form: form || {} });
      for (let i = 0; i < text.length; i += 6) {
        if (state.closed) return state.finish();
        send({ delta: text.slice(i, i + 6) });
        await sleep(10);
      }
    } else {
      send({ mode: 'llm' });
      const messages = buildRewriteMessages({ scene, sectionTitle, sectionText, form: form || {}, instruction });
      const stream = streamSmart({
        ...llmOpts(cfg, messages, { temperature: 1, maxTokens: 900 }),
        onAttempt: (model) => send({ model }),
      });
      for await (const delta of stream) {
        if (state.closed) return state.finish();
        text += delta;
        send({ delta });
      }
    }
    send({ compliance: compliancePayload(text, form.category) });
    send({ done: true });
    state.finish();
  } catch (err) {
    if (!state.closed) {
      send({ error: String(err.message || err) });
      state.finish();
    }
  }
}

/* ---------- /api/extract ---------- */
async function handleExtract(req, res) {
  let payload;
  try {
    payload = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const raw = String(payload.url || '').trim();
  if (!raw) return sendJson(res, 400, { error: '请填写商品链接' });

  const cfg = resolveConfig(req);

  // 粘贴的可能是抖音分享口令等纯文本（不含网址），此时直接按文本提炼而不是报错
  const urlMatch = raw.match(/https?:\/\/[^\s"'【】，,、（）()]+/i);
  if (!urlMatch) {
    if (raw.length < 8) {
      return sendJson(res, 200, { ok: false, message: '请粘贴商品链接，或在下方「粘贴提炼」中粘贴商品标题与卖点' });
    }
    return sendJson(res, 200, await parseTextStructured(raw, cfg));
  }
  const url = urlMatch[0];

  try {
    const res1 = await httpRequest({
      url,
      proxyUrl: cfg.proxyUrl || undefined,
      timeoutMs: 20000,
      maxBytes: 900 * 1024,
    });
    if (res1.statusCode >= 400) {
      return sendJson(res, 200, {
        ok: false,
        message: `页面返回 ${res1.statusCode}，无法解析。建议手动复制商品标题与卖点。`,
      });
    }
    const html = res1.body || '';
    if (html.length < 200) {
      return sendJson(res, 200, { ok: false, message: '页面内容过少（可能为动态渲染或需要登录），建议手动填写。' });
    }
    const info = heuristicFromHtml(html, res1.finalUrl || url);
    let mode = 'heuristic';

    if (cfg.apiKey) {
      try {
        const pageText = stripTags(html).slice(0, 5000);
        const out = await collect(
          streamSmart(llmOpts(cfg, buildExtractMessages(pageText, url), { temperature: 0.2, maxTokens: 700 }))
        );
        const json = extractJson(out);
        if (json) {
          info.productName = String(json.productName || info.productName || '').slice(0, 80);
          if (json.category) info.category = String(json.category);
          if (Array.isArray(json.sellingPoints) && json.sellingPoints.length) {
            info.sellingPoints = json.sellingPoints.map((s) => String(s).trim()).filter(Boolean).slice(0, 6);
          }
          if (json.price) info.price = String(json.price);
          if (json.audience) info.audience = String(json.audience);
          if (json.usageScene) info.usageScene = String(json.usageScene);
          mode = 'llm';
        }
      } catch (e) {
        info.llmError = String(e.message || e);
      }
    }

    return sendJson(res, 200, { ok: true, mode, info });
  } catch (err) {
    return sendJson(res, 200, { ok: false, message: String(err.message || err) });
  }
}

/* ---------- /api/vision ---------- */
/* 数字规整：兼容 "1.2万" / "45.6%" 等中文数据截图常见写法 */
function numCn(v) {
  if (typeof v === 'string') {
    const t = v.trim().replace(/[%元,\s]/g, '');
    const w = /^([\d.]+)万$/.exec(t);
    if (w) return Math.round(parseFloat(w[1]) * 10000 * 100) / 100;
    const n = parseFloat(t);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function handleVision(req, res) {
  let payload;
  try {
    payload = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const cfg = resolveConfig(req);
  const isMetrics = String(payload.mode || '') === 'metrics';
  if (!cfg.apiKey) {
    return sendJson(res, 200, { ok: false, message: '识图需要配置大模型 API Key（且模型需支持视觉输入）' });
  }
  let dataUrl = String(payload.image || '').trim();
  if (!dataUrl) return sendJson(res, 400, { error: '缺少图片数据' });
  if (!dataUrl.startsWith('data:')) dataUrl = 'data:image/jpeg;base64,' + dataUrl;
  if (dataUrl.length > 6 * 1024 * 1024) return sendJson(res, 400, { error: '图片过大，请压缩后再上传' });

  try {
    const out = await collect(
      streamSmart({
        ...llmOpts(cfg, isMetrics ? buildVisionMetricsMessages(dataUrl) : buildVisionMessages(dataUrl, payload.hint || ''), {
          temperature: isMetrics ? 0.1 : 0.3,
          maxTokens: 700,
        }),
        models: [cfg.visionModel],
      })
    );
    const json = extractJson(out);
    if (!json) return sendJson(res, 200, { ok: false, message: '模型没有返回可解析的结果，请确认所用模型支持图片输入' });
    if (isMetrics) {
      const metrics = {};
      for (const k of ['views', 'retention', 'cvr', 'gmv']) metrics[k] = numCn(json[k]);
      return sendJson(res, 200, { ok: true, mode: 'llm', metrics });
    }
    return sendJson(res, 200, {
      ok: true,
      mode: 'llm',
      info: {
        productName: String(json.productName || '').slice(0, 80),
        category: String(json.category || ''),
        sellingPoints: Array.isArray(json.sellingPoints) ? json.sellingPoints.map((s) => String(s).trim()).filter(Boolean).slice(0, 6) : [],
        price: String(json.price || ''),
        audience: String(json.audience || ''),
        usageScene: String(json.usageScene || ''),
      },
    });
  } catch (err) {
    return sendJson(res, 200, { ok: false, message: String(err.message || err) });
  }
}

/* ---------- /api/compliance ---------- */
async function handleCompliance(req, res) {
  let payload;
  try {
    payload = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const result = scan(payload.text || '', { category: payload.category });
  sendJson(res, 200, {
    level: result.level,
    summary: result.summary,
    hits: result.hits,
    groups: groupByCategory(result.hits),
  });
}

/* ---------- 合规词表可视化（只读） ---------- */
function handleComplianceRules(req, res) {
  const rules = RULES.map((r) => ({
    id: r.id,
    cat: r.cat,
    sev: r.sev,
    tip: r.tip,
    words: r.words || [],
    patterns: (r.patterns || []).map((p) => p.label),
    soft: r.soft || [],
    fix: r.fix || {},
  }));
  const totalWords = rules.reduce((n, r) => n + r.words.length, 0);
  const totalPatterns = rules.reduce((n, r) => n + r.patterns.length, 0);
  sendJson(res, 200, { ok: true, rules, totalWords, totalPatterns });
}

/* ---------- OrderPulse 选品代理（打通选品分析 → 文案表单） ---------- */
const OP_BASE = (process.env.ORDERPULSE_URL || 'http://127.0.0.1:8530').replace(/\/+$/, '');

async function opFetch(pathname) {
  const r = await httpRequest({ url: OP_BASE + pathname, timeoutMs: 6000 });
  if (r.statusCode !== 200) throw new Error(`选品服务返回 HTTP ${r.statusCode}`);
  return JSON.parse(r.body);
}

/** GET /api/op/products：选品概览列表 */
async function handleOpProducts(req, res) {
  try {
    const data = await opFetch('/api/overview');
    sendJson(res, 200, {
      ok: true,
      cards: (data.cards || []).map((c) => ({
        product_id: c.product_id,
        name: c.name || c.product_id,
        category: c.category || '',
        sales30d: c.sales_30d || 0,
        gmv: c.gmv || 0,
        cvr: c.conversion_rate || 0,
      })),
    });
  } catch (e) {
    sendJson(res, 502, { ok: false, error: `无法连接选品分析服务（${OP_BASE}）：${e.message}。请先启动 OrderPulse。` });
  }
}

/** GET /api/op/import?product_id=xx：商品详情 + 该商品视频标注卖点，供一键填表 */
async function handleOpImport(req, res, urlObj) {
  const pid = urlObj.searchParams.get('product_id');
  if (!pid) return sendJson(res, 400, { ok: false, error: '缺少 product_id' });
  try {
    const p = await opFetch(`/api/products/${encodeURIComponent(pid)}`);
    let sellingPoints = [];
    let hooks = [];
    try {
      const videos = await opFetch(`/api/videos?product_id=${encodeURIComponent(pid)}`);
      const anns = await opFetch('/api/table/annotations?limit=1000');
      const annMap = new Map((anns.rows || []).map((a) => [a.video_id, a]));
      const seen = new Set();
      for (const v of videos || []) {
        const a = annMap.get(v.video_id);
        if (!a) continue;
        for (const sp of String(a.selling_point || '').split(/[;；,，、\n]+/)) {
          const t = sp.trim();
          if (t && t.length >= 2 && t.length <= 40 && !seen.has(t)) {
            seen.add(t);
            sellingPoints.push(t);
          }
        }
        if (a.hook && !hooks.includes(a.hook)) hooks.push(a.hook);
        if (sellingPoints.length >= 8) break;
      }
    } catch {} // 标注缺失不影响基础导入
    sendJson(res, 200, {
      ok: true,
      info: {
        productName: p.name || pid,
        category: p.category || '',
        sellingPoints: sellingPoints.slice(0, 5),
        price: '',
        audience: '',
        usageScene: '',
      },
      metrics: { sales30d: p.sales_30d || 0, gmv: p.gmv || 0, cvr: p.conversion_rate || 0 },
      hooks,
    });
  } catch (e) {
    const msg = String(e.message || '');
    sendJson(res, 502, { ok: false, error: msg.includes('404') ? '选品库中没有这个商品' : `无法连接选品分析服务：${msg}。请先启动 OrderPulse。` });
  }
}

/* ---------- /api/compliance-fix：一键合规改写 + 复检 ---------- */
async function handleComplianceFix(req, res) {
  let payload;
  try {
    payload = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const text = String(payload.text || '');
  if (!text.trim()) return sendJson(res, 400, { error: '缺少需要改写的文案' });
  const category = payload.category || '';

  const before = scan(text, { category });
  if (!before.hits.some((h) => h.sev !== 'low')) {
    return sendJson(res, 200, { text, changed: false, compliance: compliancePayload(text), note: '没有需要处理的风险项' });
  }

  const cfg = resolveConfig(req);
  let fixed = '';
  let mode = 'rule';

  if (cfg.apiKey) {
    try {
      fixed = (
        await collect(
          streamSmart(llmOpts(cfg, buildComplianceMessages(text, before.hits, category), { temperature: 0.2 }))
        )
      ).trim();
      mode = 'llm';
    } catch {
      fixed = '';
    }
  }

  // 无模型 / 模型失败 / 改写结果异常（空或明显过短）→ 本地词表兜底
  let note = '';
  if (!fixed || fixed.length < Math.max(10, text.length * 0.3)) {
    const r = safeRewrite(text, before.hits);
    fixed = r.text;
    mode = 'rule';
    if (r.missed.length) note = `「${r.missed.join('」「')}」无自动改法，请手动处理`;
  }

  const after = scan(fixed, { category });
  const remaining = after.hits.filter((h) => h.sev !== 'low').length;
  const tail = remaining ? `仍有 ${remaining} 处风险表述，请人工确认` : '复检通过';
  sendJson(res, 200, {
    text: fixed,
    changed: fixed !== text,
    mode,
    before: { level: before.level, count: before.hits.filter((h) => h.sev !== 'low').length },
    compliance: compliancePayload(fixed, category),
    note: [note, tail].filter(Boolean).join('；'),
  });
}

/* ---------- /api/ab-analysis：A/B 投放打法分析 ---------- */
async function handleAbAnalysis(req, res) {
  let payload = {};
  if (req.method === 'POST') {
    try {
      payload = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }
  // 合并服务端历史与本地传入的投放数据（同 id 以本地为准，未开云同步也能分析）
  const items = ab.mergeItems(store.getHistory(), Array.isArray(payload.items) ? payload.items : []);
  // 时间切片：days>0 时只统计最近 N 天录入的数据
  const days = Math.max(0, Number(payload.days) || 0);
  const since = days ? Date.now() - days * 86400000 : 0;
  sendJson(res, 200, ab.analyze(items, { since }));
}

/* ---------- /api/parse-text：粘贴文本一键结构化 ---------- */
function normalizeExtractInfo(json) {
  return {
    productName: String(json.productName || '').slice(0, 80),
    category: String(json.category || ''),
    sellingPoints: Array.isArray(json.sellingPoints)
      ? json.sellingPoints.map((s) => String(s).trim()).filter(Boolean).slice(0, 6)
      : [],
    price: String(json.price || ''),
    audience: String(json.audience || ''),
    usageScene: String(json.usageScene || ''),
  };
}

/** 文本结构化提炼：优先大模型，失败退回规则解析 */
async function parseTextStructured(text, cfg) {
  const fallback = () => ({ ok: true, mode: 'rule', info: heuristicParseText(text), fallback: true });
  if (!cfg.apiKey) return fallback();
  try {
    const out = await collect(
      streamSmart(llmOpts(cfg, buildParseMessages(text), { temperature: 0.2, maxTokens: 700 }))
    );
    const json = extractJson(out);
    if (!json) return fallback();
    return { ok: true, mode: 'llm', info: normalizeExtractInfo(json) };
  } catch {
    // 模型失败时退回规则提炼，保证功能可用
    return fallback();
  }
}

async function handleParseText(req, res) {
  let payload;
  try {
    payload = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const text = String(payload.text || '').trim();
  if (!text) return sendJson(res, 400, { error: '请先粘贴商品标题与卖点原文' });
  if (text.length < 8) return sendJson(res, 200, { ok: false, message: '内容太短，请粘贴完整的商品标题与卖点' });

  return sendJson(res, 200, await parseTextStructured(text, resolveConfig(req)));
}

/* ---------- 热榜粘贴提炼入库 ---------- */
async function handleParseTrending(req, res) {
  let payload;
  try {
    payload = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const text = String(payload.text || '').trim();
  if (!text) return sendJson(res, 400, { error: '请先粘贴热榜原文' });
  if (text.length < 4) return sendJson(res, 200, { ok: false, message: '内容太短，请粘贴完整的热榜列表' });
  const ttlDays = Math.min(30, Math.max(1, Number(payload.ttlDays) || 7));

  const normalizeGroups = (json) => {
    const groups = (Array.isArray(json?.groups) ? json.groups : [])
      .map((g) => ({
        group: String(g?.group || '').trim().slice(0, 20),
        words: (Array.isArray(g?.words) ? g.words : [])
          .map((w) => String(w).replace(/^#/, '').trim())
          .filter((w) => w.length >= 2 && w.length <= 15),
      }))
      .filter((g) => g.group && g.words.length)
      .slice(0, 8);
    return groups;
  };
  const fallback = () => {
    const groups = heuristicParseTrending(text);
    if (!groups.length) return sendJson(res, 200, { ok: false, message: '未能从原文中提炼出有效词条，请检查粘贴内容' });
    store.addTrending(groups, ttlDays);
    return sendJson(res, 200, { ok: true, mode: 'rule', fallback: true, groups, hotwords: store.getHotwords() });
  };

  const cfg = resolveConfig(req);
  if (!cfg.apiKey) return fallback();
  try {
    const out = await collect(
      streamSmart(llmOpts(cfg, buildTrendingMessages(text), { temperature: 0.2, maxTokens: 1200 }))
    );
    const json = extractJson(out);
    const groups = normalizeGroups(json);
    if (!groups.length) return fallback();
    store.addTrending(groups, ttlDays);
    return sendJson(res, 200, { ok: true, mode: 'llm', groups, hotwords: store.getHotwords() });
  } catch {
    return fallback();
  }
}

/* ---------- 历史 / 热词 / 样本 ---------- */
async function handleHistory(req, res) {
  if (req.method === 'GET') return sendJson(res, 200, { items: store.getHistory() });
  let payload;
  try {
    payload = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const action = payload.action || 'upsert';
  if (action === 'delete') store.deleteHistory(payload.id);
  else if (action === 'clear') store.clearHistory();
  else if (action === 'merge' && Array.isArray(payload.items)) {
    // 客户端离线期间积累的投放数据/历史，启动时一次性合并进服务端，避免双轨分叉
    let n = 0;
    for (const it of payload.items) {
      if (it && it.id) {
        store.upsertHistory(it);
        n++;
      }
    }
    return sendJson(res, 200, { ok: true, merged: n, items: store.getHistory() });
  } else if (payload.item?.id) store.upsertHistory(payload.item);
  sendJson(res, 200, { ok: true, items: store.getHistory() });
}

async function handleHotwords(req, res) {
  if (req.method === 'GET') return sendJson(res, 200, store.getHotwords());
  let payload;
  try {
    payload = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  if (payload.action === 'clearTrending') return sendJson(res, 200, store.clearTrending());
  sendJson(res, 200, store.setHotwords(payload));
}

async function handleSamples(req, res) {
  if (req.method === 'GET') return sendJson(res, 200, { items: store.getSamples() });
  let payload;
  try {
    payload = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  if (payload.action === 'delete') store.deleteSample(payload.id);
  else if (payload.item?.text) store.addSample(payload.item);
  else if (Array.isArray(payload.items)) store.setSamples(payload.items);
  sendJson(res, 200, { ok: true, items: store.getSamples() });
}

/* ---------- 配置与鉴权 ---------- */
function getLan() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

function handleDebugEnv(req, res) {
  const keys = Object.keys(process.env).filter((k) =>
    /^(LLM_|API_KEY|ACCESS_TOKEN|PORT|DATA_DIR|__BUILD)/i.test(k)
  );
  const out = {};
  for (const k of keys) {
    const v = process.env[k] || '';
    if (k === 'ACCESS_TOKEN') {
      out[k] = { len: v.length, first: JSON.stringify(v.slice(0, 6)), last: JSON.stringify(v.slice(-6)) };
    } else if (k === '__BUILD') {
      out[k] = v;
    } else {
      out[k] = v.length > 8 ? v.slice(0, 4) + '***' + v.slice(-4) : '(empty)';
    }
  }
  sendJson(res, 200, out);
}

function handleConfig(req, res) {
  const cfg = resolveConfig(req);
  const configured = Boolean(cfg.apiKey);
  sendJson(res, 200, {
    configured,
    demo: !configured,
    baseUrl: configured ? cfg.baseUrl : '',
    model: configured ? cfg.models[0] : '',
    models: configured ? cfg.models : [],
    visionModel: configured ? cfg.visionModel : '',
    authRequired: auth.authRequired(),
    lan: getLan(),
    variantScenes: VARIANT_SCENES,
    demoNote: DEMO_NOTE.trim(),
    encrypt: false,
  });
}

async function handleAccess(req, res) {
  let payload;
  try {
    payload = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  if (String(process.env.ACCESS_TOKEN || '').trim()) {
    return sendJson(res, 400, { error: '服务端已通过 ACCESS_TOKEN 环境变量固定口令，无法在此修改' });
  }
  const token = String(payload.token || '').trim();
  if (token.length > 0 && token.length < 4) return sendJson(res, 400, { error: '口令太短，至少 4 位' });
  store.setToken(token);
  sendJson(res, 200, { ok: true, authRequired: auth.authRequired() });
}

function handleAuthCheck(req, res) {
  const blocked = auth.guard(req, { needAuth: true, rateLimit: 0 });
  sendJson(res, 200, { ok: !blocked, message: blocked ? blocked.message : '通过' });
}

/* ---------- /api/backup：POST 创建备份，GET 下载最新备份 ---------- */
function handleBackup(req, res) {
  if (req.method === 'POST') {
    try {
      const r = store.backupDb();
      return sendJson(res, 200, { ok: true, file: r.file });
    } catch (e) {
      return sendJson(res, 500, { error: '备份失败：' + e.message });
    }
  }
  const latest = store.latestBackup();
  if (!latest) return sendJson(res, 404, { error: '还没有备份，请先点「立即备份」' });
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${latest.file}"`,
  });
  fs.createReadStream(latest.path).pipe(res);
}

/* ---------- /api/test ---------- */
async function handleTest(req, res) {
  const cfg = resolveConfig(req);
  if (!cfg.apiKey) return sendJson(res, 200, { ok: false, message: '未配置 API Key，当前为演示模式' });
  try {
    const out = await collect(
      streamSmart(
        llmOpts(cfg, [{ role: 'user', content: '只回复两个字：可用' }], { temperature: 0, maxTokens: 16 })
      )
    );
    sendJson(res, 200, { ok: true, message: `连接成功（${cfg.models.join(' → ')}）`, sample: out.trim().slice(0, 40) });
  } catch (err) {
    sendJson(res, 200, { ok: false, message: String(err.message || err) });
  }
}

/* ---------- 路由 ---------- */
const server = (() => {
  const handler = (req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,X-Access-Token,X-LLM-Key,X-LLM-Base,X-LLM-Model,X-LLM-Proxy,X-LLM-Vision-Model',
      });
      return res.end();
    }
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!url.startsWith('/api/')) return serveStatic(req, res);
    if (url === '/api/debug-env' && req.method === 'GET') return handleDebugEnv(req, res);
    if (url === '/api/config' && req.method === 'GET') return handleConfig(req, res);
    if (url === '/api/auth-check') return handleAuthCheck(req, res);

    const blocked = auth.guard(req, { rateLimit: url === '/api/generate' ? 20 : 60 });
    if (blocked) return sendJson(res, blocked.code, { error: blocked.message });

    if (url === '/api/generate' && req.method === 'POST') return handleGenerate(req, res);
    if (url === '/api/rewrite' && req.method === 'POST') return handleRewrite(req, res);
    if (url === '/api/extract' && req.method === 'POST') return handleExtract(req, res);
    if (url === '/api/vision' && req.method === 'POST') return handleVision(req, res);
    if (url === '/api/compliance' && req.method === 'POST') return handleCompliance(req, res);
    if (url === '/api/compliance/rules' && req.method === 'GET') return handleComplianceRules(req, res);
    if (url === '/api/compliance-fix' && req.method === 'POST') return handleComplianceFix(req, res);
    if (url === '/api/ab-analysis' && (req.method === 'GET' || req.method === 'POST')) return handleAbAnalysis(req, res);
    if (url === '/api/parse-text' && req.method === 'POST') return handleParseText(req, res);
    if (url === '/api/parse-trending' && req.method === 'POST') return handleParseTrending(req, res);
    if (url === '/api/op/products' && req.method === 'GET') return handleOpProducts(req, res);
    if (url === '/api/op/import' && req.method === 'GET') return handleOpImport(req, res, new URL(req.url, 'http://x'));
    if (url === '/api/history' && (req.method === 'GET' || req.method === 'POST')) return handleHistory(req, res);
    if (url === '/api/hotwords' && (req.method === 'GET' || req.method === 'POST')) return handleHotwords(req, res);
    if (url === '/api/samples' && (req.method === 'GET' || req.method === 'POST')) return handleSamples(req, res);
    if (url === '/api/access' && req.method === 'POST') return handleAccess(req, res);
    if (url === '/api/backup' && (req.method === 'GET' || req.method === 'POST')) return handleBackup(req, res);
    if (url === '/api/test' && req.method === 'POST') return handleTest(req, res);

    return sendJson(res, 404, { error: '接口不存在' });
  };

  // 可选 HTTPS
  const tlsKey = process.env.TLS_KEY;
  const tlsCert = process.env.TLS_CERT;
  if (tlsKey && tlsCert && fs.existsSync(tlsKey) && fs.existsSync(tlsCert)) {
    return https.createServer({ key: fs.readFileSync(tlsKey), cert: fs.readFileSync(tlsCert) }, handler);
  }
  return http.createServer(handler);
})();

auth.startCleanup();

server.listen(PORT, () => {
  const lan = getLan();
  const cfg = resolveConfig({ headers: {} });
  console.log('\n  抖音带货爆款文案生成器已启动');
  console.log(`  本机访问:    http://localhost:${PORT}`);
  if (lan.length) console.log(`  手机同网访问: http://${lan[0]}:${PORT}  （手机连同一 WiFi 即可打开）`);
  console.log(`  模型状态:    ${cfg.apiKey ? cfg.models.join(' → ') : '未配置 Key —— 当前为演示模式'}`);
  console.log(`  访问口令:    ${auth.authRequired() ? '已启用' : '未启用'}`);
  console.log(`  协议:        ${process.env.TLS_CERT ? 'HTTPS' : 'HTTP（PWA 完整安装需 HTTPS）'}`);
  console.log(`  数据目录:    ${store.DATA_DIR}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.flushAll();
    process.exit(0);
  });
}
