'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const ab = require('../lib/ab');
const { heuristicParseText } = require('../lib/extract');
const { insightBlock, buildUserPrompt } = require('../lib/prompts');

test('extractHookType：提取主选钩子的策略标注', () => {
  const text = '## 黄金3秒钩子\n主选：别再乱买了。（反常识）\n备选1：xxx（悬念）';
  assert.strictEqual(ab.extractHookType(text), '反常识');
  assert.strictEqual(ab.extractHookType('没有标注'), '');
  assert.strictEqual(ab.extractHookType(null), '');
});

test('validMetrics：空数据返回 null，数字正常转换', () => {
  assert.strictEqual(ab.validMetrics(null), null);
  assert.strictEqual(ab.validMetrics({}), null);
  assert.deepStrictEqual(ab.validMetrics({ views: '12000', retention: 42 }), {
    views: 12000,
    retention: 42,
    cvr: 0,
    gmv: 0,
  });
  assert.strictEqual(ab.validMetrics({ views: -5 }), null);
});

test('mergeItems：同 id 以本地为准', () => {
  const server = [{ id: 'a', name: '旧' }, { id: 'b', name: '服务端' }];
  const client = [{ id: 'a', name: '新' }];
  const merged = ab.mergeItems(server, client);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged.find((x) => x.id === 'a').name, '新');
  assert.strictEqual(merged.find((x) => x.id === 'b').name, '服务端');
});

test('collectRecords：过滤无投放数据记录，维度取值正确', () => {
  const items = [
    { id: '1', form: { tone: '幽默', persona: '工厂老板娘', duration: '30' }, metrics: { views: 1000, retention: 40, cvr: 2, gmv: 500 }, hookType: '反常识' },
    { id: '2', form: { tone: '幽默' }, metrics: null }, // 无投放数据
    { id: '3', form: { tone: '专业测评', duration: '60' }, metrics: { views: 2000 }, results: { talk: '主选：xxx。（痛点）' } },
  ];
  const rs = ab.collectRecords(items);
  assert.strictEqual(rs.length, 2);
  assert.strictEqual(rs[0].tone, '幽默');
  assert.strictEqual(rs[0].persona, '工厂老板娘');
  assert.strictEqual(rs[1].hookType, '痛点');
});

test('analyze：按播放量加权 + 综合分排序 + winners 生成', () => {
  const items = [
    { id: '1', form: { tone: '幽默', duration: '30' }, hookType: '反常识', metrics: { views: 10000, retention: 45, cvr: 2, gmv: 800 } },
    { id: '2', form: { tone: '幽默', duration: '30' }, hookType: '痛点', metrics: { views: 20000, retention: 30, cvr: 1, gmv: 300 } },
    { id: '3', form: { tone: '专业测评', duration: '60' }, hookType: '反常识', metrics: { views: 5000, retention: 50, cvr: 3, gmv: 1200 } },
  ];
  const out = ab.analyze(items);
  assert.strictEqual(out.sampleCount, 3);

  const hookDim = out.dimensions.find((d) => d.key === 'hookType');
  // 反常识：加权完播 = (45*10000+50*5000)/15000 ≈ 46.7；痛点 = 30
  const fangan = hookDim.groups.find((g) => g.value === '反常识');
  assert.strictEqual(fangan.avgRetention, 46.67);
  // 反常识综合分应高于痛点 → winner 是反常识
  assert.strictEqual(hookDim.groups[0].value, '反常识');
  assert.ok(hookDim.groups[0].score >= hookDim.groups[1].score);

  const toneWinner = out.winners.find((w) => w.dimension === 'tone');
  // 幽默：加权完播35/转化1.33/千次GMV36.7；专业测评：50/3/240 → 各项都更优
  assert.strictEqual(toneWinner.value, '专业测评');
  assert.strictEqual(toneWinner.avgRetention, 50);
});

test('analyze：只有播放量时按播放量兜底排序', () => {
  const items = [
    { id: '1', form: { tone: '幽默' }, metrics: { views: 5000 } },
    { id: '2', form: { tone: '专业测评' }, metrics: { views: 50000 } },
    { id: '3', form: { tone: '幽默' }, metrics: { views: 1000 } },
  ];
  const out = ab.analyze(items);
  const tone = out.dimensions.find((d) => d.key === 'tone');
  assert.strictEqual(tone.groups[0].value, '专业测评'); // 播放最多
});

test('analyze：since 时间切片只统计新记录，at 缺失回退 item.ts', () => {
  const now = Date.now();
  const items = [
    { id: '1', form: { tone: '幽默' }, metrics: { views: 5000, at: now - 2 * 86400000 } }, // 2 天前录入
    { id: '2', form: { tone: '专业测评' }, metrics: { views: 50000, at: now - 20 * 86400000 } }, // 20 天前录入
    { id: '3', form: { tone: '反差' }, ts: now - 10 * 86400000, metrics: { views: 9000 } }, // 无 at，回退 ts
  ];
  const all = ab.analyze(items);
  assert.strictEqual(all.sampleCount, 3);
  const week = ab.analyze(items, { since: now - 7 * 86400000 });
  assert.strictEqual(week.sampleCount, 1); // 只剩 2 天前录入的那条
  assert.strictEqual(week.dimensions.find((d) => d.key === 'tone').groups[0].value, '幽默');
});

test('validMetrics：保留录入时间戳 at', () => {
  const m = ab.validMetrics({ views: 100, at: 1729000000000 });
  assert.strictEqual(m.at, 1729000000000);
  assert.strictEqual(ab.validMetrics({ views: 100 }).at, undefined);
});

test('insightBlock：生成反哺提示词块', () => {
  const out = ab.analyze([
    { id: '1', form: { tone: '幽默' }, hookType: '反常识', metrics: { views: 10000, retention: 45, cvr: 2, gmv: 800 } },
    { id: '2', form: { tone: '幽默' }, hookType: '痛点', metrics: { views: 10000, retention: 30, cvr: 1, gmv: 300 } },
    { id: '3', form: { tone: '幽默' }, hookType: '反常识', metrics: { views: 10000, retention: 40, cvr: 2.5, gmv: 900 } },
  ]);
  const block = insightBlock({ sampleCount: out.sampleCount, winners: out.winners });
  assert.ok(block.includes('【你自己的历史投放数据洞察】'));
  assert.ok(block.includes('「反常识」'));
  assert.strictEqual(insightBlock(null), '');
  assert.strictEqual(insightBlock({ winners: [] }), '');
});

test('buildUserPrompt：注入洞察块', () => {
  const prompt = buildUserPrompt('talk', { productName: '测试' }, { insight: { sampleCount: 3, winners: [{ label: '钩子策略', value: '反常识', count: 2, avgRetention: 45 }] } });
  assert.ok(prompt.includes('历史投放数据洞察'));
  const plain = buildUserPrompt('talk', { productName: '测试' }, {});
  assert.ok(!plain.includes('历史投放数据洞察'));
});

test('heuristicParseText：规则提炼粘贴文本', () => {
  const raw = '【XX旗舰店】便携榨汁杯 300ml 无线充电 官方正品包邮\n¥39.9元起\n一键清洗不脏手\n6叶锋利刀头\ntype-c充电接口\n宿舍办公室都能用';
  const info = heuristicParseText(raw);
  assert.ok(info.productName.includes('榨汁杯'));
  assert.ok(!info.productName.includes('旗舰店'));
  assert.strictEqual(info.price, '39.9元');
  assert.ok(info.sellingPoints.includes('一键清洗不脏手'));
  assert.ok(info.sellingPoints.length >= 2);
});

test('heuristicParseText：空文本返回空结构', () => {
  const info = heuristicParseText('');
  assert.strictEqual(info.productName, '');
  assert.deepStrictEqual(info.sellingPoints, []);
});

test('heuristicParseText：单行长文本（换行丢失）兜底', () => {
  const raw = '便携榨汁杯 300ml 无线充电 官方正品包邮 ¥39.9元起 一键清洗不脏手 6叶锋利刀头 type-c充电接口 宿舍办公室都能用';
  const info = heuristicParseText(raw);
  assert.strictEqual(info.productName, '便携榨汁杯 300ml 无线充电');
  assert.strictEqual(info.price, '39.9元');
  assert.ok(info.sellingPoints.includes('一键清洗不脏手'));
  assert.ok(info.sellingPoints.includes('6叶锋利刀头'));
});
