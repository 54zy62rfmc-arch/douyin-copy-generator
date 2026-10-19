'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { scan, groupByCategory, safeRewrite } = require('../lib/compliance');

test('scan：高危词命中为 high', () => {
  const r = scan('这款是全网第一的神话，用了绝对有效');
  assert.strictEqual(r.level, 'high');
  assert.ok(r.hits.some((h) => h.word === '全网第一'));
});

test('scan：soft 词降级为 mid', () => {
  const r = scan('医用级材质，用着安心');
  const hit = r.hits.find((h) => h.word === '医用');
  assert.ok(hit);
  assert.strictEqual(hit.sev, 'mid');
});

test('scan：否定语境豁免（不含美白成分）降为 low', () => {
  const r = scan('本品不含美白成分，仅做日常清洁');
  const hit = r.hits.find((h) => h.word === '美白');
  assert.ok(hit, '应命中美白');
  assert.strictEqual(hit.sev, 'low');
  assert.strictEqual(r.level, 'low');
});

test('scan：疑问语境豁免降为 low', () => {
  const r = scan('这真的能美白吗？');
  const hit = r.hits.find((h) => h.word === '美白');
  assert.ok(hit);
  assert.strictEqual(hit.sev, 'low');
});

test('scan：食品品类命中功效词时提示品类规则', () => {
  const r = scan('喝了能瘦身', { category: '食品生鲜' });
  const hit = r.hits.find((h) => h.word === '瘦身');
  assert.ok(hit);
  assert.ok(hit.tip.includes('食品类'));
});

test('scan：美妆品类对特证功效词给备案提示', () => {
  const r = scan('美白提亮看得见', { category: '美妆护肤' });
  const hit = r.hits.find((h) => h.word === '美白');
  assert.ok(hit);
  assert.ok(hit.tip.includes('特殊化妆品'));
});

test('scan：level 为 low 时 summary 含提示级字样', () => {
  const r = scan('不含美白成分');
  assert.strictEqual(r.level, 'low');
  assert.ok(r.summary.includes('提示级'));
});

test('scan：suggestion 返回建议改法', () => {
  const r = scan('用了之后瞬间美白');
  const hit = r.hits.find((h) => h.word === '美白');
  assert.strictEqual(hit.suggestion, '提亮肤色');
});

test('groupByCategory：聚合词与建议', () => {
  const r = scan('全网第一，用了美白还瘦身');
  const g = groupByCategory(r.hits);
  assert.ok(g.length >= 1);
  const med = g.find((x) => x.cat.includes('医疗'));
  assert.ok(med.suggestions['美白']);
});

test('safeRewrite：按建议替换并减少命中', () => {
  const text = '全网第一的选择，用了立刻美白';
  const before = scan(text);
  const r = safeRewrite(text, before.hits);
  assert.ok(r.replaced.some((s) => s.startsWith('美白→')));
  const after = scan(r.text);
  assert.ok(after.hits.filter((h) => h.sev !== 'low').length < before.hits.filter((h) => h.sev !== 'low').length);
});

test('safeRewrite：空建议词归入 missed 且保留原文', () => {
  const text = '加微信免费领福利';
  const before = scan(text);
  const r = safeRewrite(text, before.hits);
  assert.ok(r.missed.includes('加微信'), '无建议词应计入 missed');
  assert.ok(r.text.includes('加微信'), '无建议词应保留原文，避免句子破碎');
  assert.ok(r.replaced.some((s) => s.startsWith('免费领→')), '有建议词应被替换');
});
