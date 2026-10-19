'use strict';
/**
 * 轻量文件持久化（JSON，零依赖）
 * 存储：历史记录 / 热词库 / 爆款样本库 / 访问口令
 * 单租户设计，适合个人或小团队自托管。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '.data');
const cache = new Map();
const writeTimers = new Map();

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function fileOf(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function read(name, fallback) {
  if (cache.has(name)) return cache.get(name);
  ensureDir();
  try {
    const raw = fs.readFileSync(fileOf(name), 'utf8');
    const val = JSON.parse(raw);
    cache.set(name, val);
    return val;
  } catch {
    cache.set(name, fallback);
    return fallback;
  }
}

function write(name, val) {
  cache.set(name, val);
  clearTimeout(writeTimers.get(name));
  writeTimers.set(
    name,
    setTimeout(() => {
      ensureDir();
      const tmp = fileOf(name) + '.tmp';
      try {
        fs.writeFileSync(tmp, JSON.stringify(val, null, 2), 'utf8');
        fs.renameSync(tmp, fileOf(name));
      } catch (e) {
        console.error('[store] 写入失败', name, e.message);
      }
    }, 60)
  );
  return val;
}

function flushAll() {
  for (const [name, val] of cache) {
    clearTimeout(writeTimers.get(name));
    try {
      ensureDir();
      fs.writeFileSync(fileOf(name), JSON.stringify(val, null, 2), 'utf8');
    } catch {}
  }
}

/* ---------------- 历史记录 ---------------- */
function getHistory() {
  return read('history', []);
}

function upsertHistory(item) {
  const list = getHistory().slice();
  const idx = list.findIndex((x) => x.id === item.id);
  const record = Object.assign({}, idx >= 0 ? list[idx] : {}, item, { updatedAt: Date.now() });
  if (idx >= 0) list[idx] = record;
  else list.unshift(record);
  return write('history', list.slice(0, 200));
}

function deleteHistory(id) {
  return write('history', getHistory().filter((x) => x.id !== id));
}

function clearHistory() {
  return write('history', []);
}

/* ---------------- 热词库 ---------------- */
const DEFAULT_HOTWORDS = {
  note: '初始词库为通用参考词，请按自己的赛道定期维护替换；平台实时热词需自行补充。',
  updatedAt: 0,
  tags: {
    泛流量: ['好物推荐', '抖音好物', '涨知识', '生活小妙招', '实用好物', '生活记录'],
    精准人群: ['上班族', '宝妈必备', '学生党', '懒人必备', '租房党', '精致女生', '健身人群'],
    品类场景: ['居家好物', '平价好物', '宿舍好物', '厨房神器', '通勤必备', '送礼推荐'],
  },
};

function getHotwords() {
  const v = read('hotwords', null);
  if (v && v.tags) return { note: v.note || DEFAULT_HOTWORDS.note, updatedAt: v.updatedAt || 0, tags: v.tags, trending: sanitizeTrending(v.trending) };
  return Object.assign({}, DEFAULT_HOTWORDS, { trending: [] });
}

/** 清理热榜分组：过滤结构非法项；过期项保留在存储里（便于前端显示"已过期"），注入时由 hotwordGroups 排除 */
function sanitizeTrending(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((g) => ({
      group: String(g?.group || '').trim().slice(0, 20),
      words: (Array.isArray(g?.words) ? g.words : []).map((w) => String(w).replace(/^#/, '').trim()).filter(Boolean).slice(0, 30),
      updatedAt: Number(g?.updatedAt) || 0,
      expiresAt: Number(g?.expiresAt) || 0,
    }))
    .filter((g) => g.group && g.words.length)
    .slice(0, 20);
}

function setHotwords(payload) {
  const tags = {};
  for (const [k, arr] of Object.entries(payload?.tags || {})) {
    tags[k] = (Array.isArray(arr) ? arr : [])
      .map((s) => String(s).replace(/^#/, '').trim())
      .filter(Boolean)
      .slice(0, 60);
  }
  const prev = getHotwords();
  return write('hotwords', {
    note: payload?.note || DEFAULT_HOTWORDS.note,
    updatedAt: Date.now(),
    tags: Object.keys(tags).length ? tags : DEFAULT_HOTWORDS.tags,
    trending: prev.trending || [], // 手动词库保存时保留热榜区
  });
}

/**
 * 写入/合并热榜分组（同组名覆盖），默认 7 天过期
 * @param {Array<{group:string, words:string[]}>} groups
 * @param {number} ttlDays 有效天数
 */
function addTrending(groups, ttlDays = 7) {
  const now = Date.now();
  const ttlMs = Math.min(30, Math.max(1, Number(ttlDays) || 7)) * 86400000;
  const hw = getHotwords();
  const list = (hw.trending || []).slice();
  for (const g of Array.isArray(groups) ? groups : []) {
    const name = String(g?.group || '').trim().slice(0, 20);
    const words = (Array.isArray(g?.words) ? g.words : []).map((w) => String(w).replace(/^#/, '').trim()).filter(Boolean).slice(0, 30);
    if (!name || !words.length) continue;
    const idx = list.findIndex((x) => x.group === name);
    const item = { group: name, words, updatedAt: now, expiresAt: now + ttlMs };
    if (idx >= 0) list[idx] = item;
    else list.unshift(item);
  }
  return write('hotwords', { note: hw.note, updatedAt: hw.updatedAt, tags: hw.tags, trending: list.slice(0, 20) });
}

function clearTrending() {
  const hw = getHotwords();
  return write('hotwords', { note: hw.note, updatedAt: hw.updatedAt, tags: hw.tags, trending: [] });
}

/** 注入 prompt 用的分组：手动词库 + 未过期热榜 */
function hotwordGroups() {
  const hw = getHotwords();
  const now = Date.now();
  const groups = Object.entries(hw.tags || {}).map(([group, words]) => ({ group, words: words.map((w) => `#${w}`) }));
  for (const g of hw.trending || []) {
    if (g.expiresAt && g.expiresAt < now) continue; // 已过期不注入
    groups.push({ group: `热榜·${g.group}`, words: g.words.map((w) => `#${w}`) });
  }
  return groups;
}

/* ---------------- 爆款样本库 ---------------- */
// 结构样例由本项目自行撰写，用于示范"爆款结构"，不是抓取的他人文案。
const DEFAULT_SAMPLES = [
  {
    id: 's1',
    scene: 'talk',
    category: '家居日用',
    tone: '接地气',
    note: '结构样例（自建）：反常识钩子 + 具体痛点 + 单一卖点凿穿 + 售后兜底',
    text: `## 黄金3秒钩子
主选：我家这个位置空了三年，直到我换了它。（悬念）
备选1：别再买带花洒的那种了，它才是真省事。（反常识）

## 痛点共鸣
每次收拾完厨房，台面还是一层水，抹布越擦越脏。
不是你懒，是工具本身就在给你添活。

## 产品亮相 + 核心卖点
卖点：一擦即干不留水痕 ｜ 怎么说：擦完直接能放碗筷，不用再拿干布过一遍。
卖点：可拆洗不发臭 ｜ 怎么说：用了一周也不会有一股抹布味，拆开冲一冲就行。

## 信任背书
我自己用了两个多月，中间洗过十几次，还是原来那个手感。

## 逼单 CTA
链接放左下角了，先加购，不合适随时退，售后有人管。

## 拍摄提示
1. 机位：台面俯拍 + 手部特写
2. 痛点镜头拍"擦完还有水印"的真实对比
3. 卖点镜头给慢动作特写`,
  },
  {
    id: 's2',
    scene: 'title',
    category: '食品生鲜',
    tone: '幽默',
    note: '结构样例（自建）：标题覆盖多种角度，标签分三层',
    text: `## 视频标题
1. 我妈尝了一口，直接把链接要走了（结果型）
2. 这玩意儿我一口气吃了三个（反差型）

## 封面大字
・一口就停不下来
・我妈要链接了

## 话题标签
### 泛流量标签
#好物推荐 #抖音好物 #美食推荐
### 精准人群标签
#追剧零食 #办公室零食
### 品类场景标签
#零食分享 #健康零食 #送礼推荐`,
  },
];

function getSamples() {
  const v = read('samples', null);
  return Array.isArray(v) ? v : DEFAULT_SAMPLES;
}

function setSamples(list) {
  const cleaned = (Array.isArray(list) ? list : [])
    .slice(0, 200)
    .map((s, i) => ({
      id: s.id || 's' + Date.now().toString(36) + i,
      scene: ['talk', 'title', 'storyboard'].includes(s.scene) ? s.scene : 'talk',
      category: String(s.category || '').trim(),
      tone: String(s.tone || '').trim(),
      note: String(s.note || '').trim(),
      text: String(s.text || '').trim().slice(0, 4000),
    }))
    .filter((s) => s.text);
  return write('samples', cleaned);
}

function addSample(s) {
  const list = getSamples().slice();
  list.unshift({
    id: 's' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
    scene: s.scene,
    category: s.category,
    tone: s.tone,
    note: s.note,
    text: s.text,
  });
  return write('samples', list.slice(0, 200));
}

function deleteSample(id) {
  return write('samples', getSamples().filter((s) => s.id !== id));
}

/* ---------------- 访问口令 ---------------- */
function hashToken(token) {
  return crypto.createHash('sha256').update('dv::' + String(token)).digest('hex');
}

function getAuth() {
  return read('auth', { tokenHash: '' });
}

function setToken(token) {
  if (!token) return write('auth', { tokenHash: '' });
  return write('auth', { tokenHash: hashToken(token), updatedAt: Date.now() });
}

function verifyToken(token) {
  const { tokenHash } = getAuth();
  if (!tokenHash) return true; // 未设置口令 → 不鉴权
  if (!token) return false;
  return hashToken(token) === tokenHash;
}

module.exports = {
  getHistory,
  upsertHistory,
  deleteHistory,
  clearHistory,
  getHotwords,
  setHotwords,
  addTrending,
  clearTrending,
  hotwordGroups,
  getSamples,
  setSamples,
  addSample,
  deleteSample,
  getAuth,
  setToken,
  verifyToken,
  flushAll,
  DATA_DIR,
};
