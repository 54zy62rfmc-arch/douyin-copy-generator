'use strict';
/**
 * 爆款样本库检索
 * 采用「词面匹配打分」的轻量检索（不依赖 embedding 服务，离线可用）。
 * 若后续接入向量服务，可把 score() 替换为余弦相似度，接口保持不变。
 */

function tokensOf(s) {
  return String(s || '')
    .split(/[\s,，、;；/|]+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);
}

function score(sample, query) {
  let s = 0;
  if (sample.scene === query.scene) s += 3;
  if (query.category && sample.category) {
    if (sample.category === query.category) s += 5;
    else if (sample.category.includes(query.category) || query.category.includes(sample.category)) s += 2;
  }
  if (query.tone && sample.tone && sample.tone === query.tone) s += 2;
  for (const kw of query.keywords || []) {
    if (kw.length >= 2 && sample.text.includes(kw)) s += 2;
    if (sample.category && sample.category.includes(kw)) s += 1;
  }
  return s;
}

/**
 * 选出最相关的样本
 * @param {object} query {scene, category, tone, keywords[]}
 * @param {Array} samples
 * @param {number} limit
 */
function selectSamples(query, samples, limit = 2) {
  if (!Array.isArray(samples) || !samples.length) return [];
  return samples
    .map((s) => ({ s, score: score(s, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
}

module.exports = { selectSamples, score, tokensOf };
