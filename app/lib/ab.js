'use strict';
/**
 * A/B 投放回流分析（纯函数，便于单测）
 * 数据来源：历史记录中带 metrics（投放数据）的条目
 *   metrics: { views 播放量, retention 完播率%, cvr 转化率%, gmv 成交额 }
 * 维度：钩子策略 hookType × 情绪基调 tone × 人设 persona × 时长 duration
 * 输出：各维度加权表现排名 + 最优打法（winners，用于反哺生成提示词）
 */

const DIMENSIONS = [
  { key: 'hookType', label: '钩子策略' },
  { key: 'tone', label: '情绪基调' },
  { key: 'persona', label: '人设' },
  { key: 'duration', label: '时长' },
  { key: 'rating', label: '人工评分' }, // 人工质量打分回流：对照人工判断与真实数据表现
];

/** 从口播脚本中提取主选钩子的策略标注，如 "主选：……（反常识）" → 反常识 */
function extractHookType(text) {
  const m = /主选[：:][^\n]*?[（(]([^（()）]{2,6})[）)]/.exec(String(text || ''));
  return m ? m[1].trim() : '';
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** 校验并规范化投放数据；全空返回 null（视为未录入）。at 为录入时间戳（可选，用于时间切片） */
function validMetrics(m) {
  if (!m || typeof m !== 'object') return null;
  const views = num(m.views);
  const retention = num(m.retention);
  const cvr = num(m.cvr);
  const gmv = num(m.gmv);
  if (!views && !retention && !cvr && !gmv) return null;
  const at = num(m.at);
  return { views, retention, cvr, gmv, ...(at ? { at } : {}) };
}

/** 合并服务端与本地历史（同 id 时以本地为准，保证未开云同步也能分析） */
function mergeItems(serverItems, clientItems) {
  const map = new Map();
  for (const it of Array.isArray(serverItems) ? serverItems : []) {
    if (it && it.id) map.set(it.id, it);
  }
  for (const it of Array.isArray(clientItems) ? clientItems : []) {
    if (it && it.id) map.set(it.id, it);
  }
  return Array.from(map.values());
}

/** 过滤出带投放数据、可参与分析的记录 */
function collectRecords(items) {
  const out = [];
  for (const it of items || []) {
    const m = validMetrics(it.metrics);
    if (!m) continue;
    out.push({
      id: it.id,
      name: String(it.name || ''),
      views: m.views,
      retention: m.retention,
      cvr: m.cvr,
      gmv: m.gmv,
      at: m.at || num(it.ts), // 录入时间优先，旧数据回退生成时间
      hookType: String(it.hookType || extractHookType(it.results?.talk) || '').trim(),
      tone: String(it.form?.tone || '').trim(),
      persona: String(it.form?.persona || '').trim(),
      duration: String(it.form?.duration || '').trim(),
      rating: String(it.rating || '').trim(),
    });
  }
  return out;
}

/** 加权平均：优先按播放量加权，播放量合计为 0 时退化为简单平均 */
function weightedAvg(records, field) {
  const rs = records.filter((r) => r[field] > 0 || (field !== 'views' && r[field] != null && r[field] > 0));
  if (!rs.length) return null;
  const wsum = rs.reduce((s, r) => s + r.views, 0);
  if (wsum <= 0) {
    const avg = rs.reduce((s, r) => s + r[field], 0) / rs.length;
    return Math.round(avg * 100) / 100;
  }
  const avg = rs.reduce((s, r) => s + r[field] * r.views, 0) / wsum;
  return Math.round(avg * 100) / 100;
}

/** 单维度分组统计 + 综合评分 */
function groupStats(records, key) {
  const groups = new Map();
  for (const r of records) {
    const v = r[key];
    if (!v) continue;
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(r);
  }
  const arr = [];
  for (const [value, rs] of groups) {
    const views = rs.reduce((s, r) => s + r.views, 0);
    const gmv = rs.reduce((s, r) => s + r.gmv, 0);
    arr.push({
      value,
      count: rs.length,
      views,
      avgRetention: weightedAvg(rs, 'retention'),
      avgCvr: weightedAvg(rs, 'cvr'),
      gmv: Math.round(gmv * 100) / 100,
      gpm: views > 0 ? Math.round((gmv / views) * 1000 * 10) / 10 : null, // 千次播放成交额
    });
  }

  // 综合分：完播率 40% + 转化率 40% + 千次播放 GMV 20%，按维度内最大值归一化
  const maxOf = (f) => arr.reduce((m, g) => Math.max(m, g[f] || 0), 0);
  const maxRet = maxOf('avgRetention');
  const maxCvr = maxOf('avgCvr');
  const maxGpm = maxOf('gpm');
  for (const g of arr) {
    const sRet = maxRet > 0 ? (g.avgRetention || 0) / maxRet : 0;
    const sCvr = maxCvr > 0 ? (g.avgCvr || 0) / maxCvr : 0;
    const sGpm = maxGpm > 0 ? (g.gpm || 0) / maxGpm : 0;
    g.score = Math.round((sRet * 0.4 + sCvr * 0.4 + sGpm * 0.2) * 100);
  }

  // 综合分相同（如只有播放量数据时全为 0）→ 按播放量排序兜底
  arr.sort((a, b) => b.score - a.score || b.views - a.views);
  return arr;
}

/** 主分析入口：返回 { sampleCount, dimensions, winners }；opts.since 只统计录入时间不早于该时间戳的记录 */
function analyze(items, opts = {}) {
  let records = collectRecords(items);
  const since = Number(opts.since) || 0;
  if (since > 0) records = records.filter((r) => (r.at || 0) >= since);
  const dimensions = DIMENSIONS.map(({ key, label }) => ({
    key,
    label,
    groups: groupStats(records, key),
  })).filter((d) => d.groups.length);

  const winners = dimensions.map((d) => ({
    dimension: d.key,
    label: d.label,
    ...d.groups[0],
  }));

  return { sampleCount: records.length, dimensions, winners };
}

module.exports = {
  DIMENSIONS,
  extractHookType,
  validMetrics,
  mergeItems,
  collectRecords,
  groupStats,
  analyze,
};
