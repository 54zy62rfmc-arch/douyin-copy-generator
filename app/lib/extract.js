'use strict';
/**
 * 商品信息提取
 * 1) 抓取商品链接页面 → 解析 og/meta/标题/价格，用启发式规则填出表单
 * 2) 若配置了大模型，可再把页面文本交给模型提炼（由 server 调用）
 */

const { request } = require('./net');

const BLOCKED_HINT = {
  'douyin.com': '抖音商品页需要登录态才能访问，抓取通常会被拦截。建议直接在商品详情页复制标题与卖点粘贴过来。',
  'taobao.com': '淘宝/天猫商品页有反爬与登录校验，抓取常失败。建议手动复制标题和卖点。',
  'tmall.com': '淘宝/天猫商品页有反爬与登录校验，抓取常失败。建议手动复制标题和卖点。',
  'jd.com': '京东页面存在风控校验，若抓取失败请手动复制商品信息。',
  'pinduoduo.com': '拼多多页面为动态渲染，抓取常失败，建议手动复制。',
  'yangkeduo.com': '拼多多页面为动态渲染，抓取常失败，建议手动复制。',
};

const CATEGORY_KEYWORDS = [
  ['美妆护肤', ['护肤', '精华', '面膜', '口红', '粉底', '防晒', '洁面', '眼霜', '爽肤水', '彩妆']],
  ['食品生鲜', ['零食', '坚果', '水果', '生鲜', '肉', '茶', '咖啡', '饮料', '速食', '糕点', '饼干']],
  ['服饰鞋包', ['连衣裙', '上衣', '裤', '外套', '毛衣', '鞋', '包', '内衣', '袜', '卫衣', 'T恤']],
  ['家居日用', ['家居', '收纳', '清洁', '抹布', '餐具', '床品', '被', '枕', '水杯', '杯子', '拖把', '纸巾']],
  ['数码家电', ['手机', '耳机', '充电', '蓝牙', '键盘', '鼠标', '相机', '小家电', '风扇', '加湿器', '音箱']],
  ['母婴亲子', ['婴儿', '宝宝', '儿童', '奶粉', '尿裤', '绘本', '玩具', '孕']],
  ['个护健康', ['牙刷', '洗发', '沐浴', '剃须', '按摩', '护腰', '护颈', '筋膜', '牙膏', '护发']],
];

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function metaContent(html, prop) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`,
    'i'
  );
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`,
    'i'
  );
  const m = html.match(re) || html.match(re2);
  return m ? decodeEntities(m[1]).trim() : '';
}

function pickCategory(text) {
  const lower = text || '';
  for (const [cat, kws] of CATEGORY_KEYWORDS) {
    if (kws.some((k) => lower.includes(k))) return cat;
  }
  return '';
}

function stripTags(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从 HTML 中用启发式规则提取商品信息 */
function heuristicFromHtml(html, url) {
  const title =
    metaContent(html, 'og:title') ||
    metaContent(html, 'title') ||
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] ||
    '';
  let productName = decodeEntities(title).trim();
  // 去掉站点后缀
  productName = productName.split(/\s*[-_|·]\s*(?=[^-_|·]{2,20}$)/)[0].trim().slice(0, 60);

  const description =
    metaContent(html, 'og:description') || metaContent(html, 'description') || '';
  const keywords = metaContent(html, 'keywords');

  const visible = stripTags(html).slice(0, 20000);
  const priceMatch =
    (description + ' ' + visible).match(/[¥￥]\s*(\d+(?:\.\d+)?)/) ||
    (description + ' ' + visible).match(/(\d+(?:\.\d+)?)\s*元/);
  const price = priceMatch ? `${priceMatch[1]}元` : '';

  const clauses = description
    .split(/[，。,.;；!！?？、\n|]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && s.length <= 40 && !/^https?:/.test(s));
  const sellingPoints = Array.from(new Set(clauses)).slice(0, 6);

  const blob = [productName, description, keywords, visible.slice(0, 3000)].join(' ');

  return {
    productName,
    category: pickCategory(blob),
    sellingPoints,
    price,
    audience: '',
    usageScene: '',
    extra: '',
    source: { url, pageTitle: decodeEntities(title).trim(), keywords },
  };
}

function blockedHint(url) {
  try {
    const host = new URL(url).hostname;
    for (const [k, v] of Object.entries(BLOCKED_HINT)) {
      if (host.includes(k)) return v;
    }
  } catch {}
  return '该页面可能需要登录或被反爬拦截，请手动复制商品标题与卖点。';
}

/* ---------- 粘贴文本规则提炼（无模型时的兜底） ---------- */
const PROMO_WORDS =
  /(【[^】]*】|\[[^\]]*\]|官方旗舰|旗舰店|专卖店|旗舰|官方|正品|包邮|顺丰|限时|秒杀|抢购|热卖|爆款|新品上市|直降|特惠|特价|促销|免运费|买一送一|送礼推荐|亏本|冲量)/g;

/** 从用户粘贴的商品文字中按规则提炼表单信息（演示模式 / 模型失败兜底） */
function heuristicParseText(raw) {
  let lines = String(raw || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  // 单行长文本（粘贴时换行丢失）：在价格符号处断开，名称/卖点分区处理
  if (lines.length === 1) {
    const line = lines[0];
    const m = /[¥￥]\s*\d+(?:\.\d{1,2})?元?(?:起|以下)?/.exec(line);
    if (m) {
      const head = line.slice(0, m.index).trim();
      const tail = line.slice(m.index).trim();
      lines = [head, tail].filter(Boolean);
    }
  }

  if (!lines.length) return { productName: '', category: '', sellingPoints: [], price: '', audience: '', usageScene: '' };

  // 名称：取第一行，去掉促销词、店铺名与分隔符后缀
  let productName = lines[0]
    .replace(PROMO_WORDS, '')
    .split(/[|｜/]/)[0]
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 60);

  const blob = lines.join(' ');
  const priceMatch =
    blob.match(/[¥￥]\s*(\d+(?:\.\d{1,2})?)/) ||
    blob.match(/(?:到手价|现价|秒杀价|拼单价|价格)[:：]?\s*(\d+(?:\.\d{1,2})?)\s*元?/) ||
    blob.match(/(\d+(?:\.\d{1,2})?)\s*元/);
  const price = priceMatch ? `${priceMatch[1]}元` : '';

  // 卖点：后续行按标点切分，保留 3-30 字的短语（去掉纯价格/纯数字片段）
  const sellingPoints = [];
  const pointLines = lines.length > 1 ? lines.slice(1) : (lines[0] ? [lines[0]] : []);
  for (const line of pointLines) {
    const parts = line
      .split(/[，,。;；、|｜!！?？\s]+/)
      .map((s) => s.replace(PROMO_WORDS, '').trim())
      .filter(Boolean);
    for (const p of parts) {
      if (p.length < 3 || p.length > 30) continue;
      if (/^\d+(\.\d+)?(元|块|万)?$/.test(p)) continue;
      if (/[¥￥]/.test(p) || /^\d+(\.\d+)?元?(起|以下)?$/.test(p)) continue; // 纯价格信息不算卖点
      if (productName && productName.includes(p)) continue; // 单行模式下避免卖点与名称重复
      if (sellingPoints.includes(p)) continue;
      sellingPoints.push(p);
      if (sellingPoints.length >= 5) break;
    }
    if (sellingPoints.length >= 5) break;
  }

  return {
    productName,
    category: pickCategory([productName, sellingPoints.join(' ')].join(' ')),
    sellingPoints,
    price,
    audience: '',
    usageScene: '',
  };
}

/* ---------- 热榜粘贴规则提炼（无模型时的兜底） ---------- */
/**
 * 从热榜原文（抖音热榜/巨量算数等截图文字或复制文本）按规则提炼词条
 * 清理：排名序号、# 号、热度数值、角标（热/沸/新/爆/推荐）
 * @returns {Array<{group:string, words:string[]}>}
 */
function heuristicParseTrending(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const words = [];
  for (let line of lines) {
    // 拆出 #话题 标签
    const tags = line.match(/#([^#\s]{1,20})/g);
    if (tags) {
      for (const t of tags) {
        const w = t.replace(/^#/, '').trim();
        if (w.length >= 2 && !words.includes(w)) words.push(w);
      }
      line = line.replace(/#[^#\s]{1,20}/g, ' ');
    }
    // 清排名前缀（1. / 1、/ ①）、热度数值（1234万）、尾部角标
    let w = line
      .replace(/^\s*(?:top\s*)?\d{1,2}\s*[.、:：)]?\s*/i, '')
      .replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '')
      .replace(/\d+(?:\.\d+)?\s*(万|亿)?\s*(热度|播放|在看|讨论|搜索)\s*$/i, '')
      .replace(/\s*(热|沸|新|爆|荐|首发|上升热点)\s*$/, '')
      .replace(/[「」『』""'']/g, '')
      .trim();
    if (w.length < 2 || w.length > 15) continue;
    if (/^\d+(\.\d+)?(万|亿)?$/.test(w)) continue;
    if (!words.includes(w)) words.push(w);
    if (words.length >= 30) break;
  }
  return words.length ? [{ group: '今日热榜', words: words.slice(0, 30) }] : [];
}

/** 抓取并解析商品链接 */
async function extractFromUrl(url, { proxyUrl, timeoutMs = 20000 } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('链接格式不正确，请粘贴完整网址（以 http:// 或 https:// 开头）');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('仅支持 http/https 链接');

  const res = await request({ url, proxyUrl, timeoutMs, maxBytes: 800 * 1024 });
  if (res.statusCode >= 400) {
    const e = new Error(`页面返回 ${res.statusCode}，无法解析。${blockedHint(url)}`);
    e.code = 'FETCH_STATUS';
    throw e;
  }
  const html = res.body || '';
  if (html.length < 200) {
    const e = new Error(`页面内容过少（可能是动态渲染或需要登录）。${blockedHint(url)}`);
    e.code = 'FETCH_THIN';
    throw e;
  }
  const info = heuristicFromHtml(html, res.finalUrl || url);
  info.pageText = stripTags(html).slice(0, 6000);
  return info;
}

module.exports = { extractFromUrl, heuristicFromHtml, heuristicParseText, heuristicParseTrending, stripTags, decodeEntities };
