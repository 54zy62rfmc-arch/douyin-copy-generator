'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 隔离数据目录，避免污染真实 .data
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bwc-trend-'));
process.env.DATA_DIR = TMP;

const store = require('../lib/store');
const { heuristicParseTrending } = require('../lib/extract');
const { buildUserPrompt } = require('../lib/prompts');

test('addTrending：写入分组并带过期时间，hotwordGroups 注入未过期热榜', () => {
  store.clearTrending();
  store.addTrending([{ group: '社会热点', words: ['#秋天的第一杯奶茶', '宿舍收纳挑战'] }], 7);
  const hw = store.getHotwords();
  assert.strictEqual(hw.trending.length, 1);
  assert.strictEqual(hw.trending[0].group, '社会热点');
  assert.deepStrictEqual(hw.trending[0].words, ['秋天的第一杯奶茶', '宿舍收纳挑战']); // # 号被清理
  assert.ok(hw.trending[0].expiresAt > Date.now());

  const groups = store.hotwordGroups();
  const trendGroup = groups.find((g) => g.group === '热榜·社会热点');
  assert.ok(trendGroup, '注入分组应包含热榜前缀组');
  assert.ok(trendGroup.words.includes('#宿舍收纳挑战'));
});

test('addTrending：同组名覆盖，词量截断', () => {
  store.clearTrending();
  store.addTrending([{ group: '节日', words: ['万圣节'] }], 3);
  store.addTrending([{ group: '节日', words: ['圣诞节', '平安夜'] }], 7);
  const hw = store.getHotwords();
  const g = hw.trending.find((x) => x.group === '节日');
  assert.deepStrictEqual(g.words, ['圣诞节', '平安夜']);
});

test('hotwordGroups：过期热榜不注入，clearTrending 清空', () => {
  store.flushAll(); // 先落盘并清掉防抖计时器，避免与下面手动写文件竞争
  const file = path.join(TMP, 'hotwords.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      note: '',
      updatedAt: Date.now(),
      tags: { 泛流量: ['好物推荐'] },
      trending: [
        { group: '旧热点', words: ['过期词'], updatedAt: Date.now() - 10 * 86400000, expiresAt: Date.now() - 1000 },
      ],
    }),
    'utf8'
  );
  delete require.cache[require.resolve('../lib/store')];
  const store2 = require('../lib/store');
  const groups = store2.hotwordGroups();
  assert.ok(!groups.some((g) => g.group.includes('旧热点')), '过期组不应注入');
  assert.ok(groups.some((g) => g.group === '泛流量'), '手动词库仍注入');

  store2.clearTrending();
  assert.strictEqual(store2.getHotwords().trending.length, 0);
});

test('setHotwords：保存手动词库时保留热榜区', () => {
  store.clearTrending();
  store.addTrending([{ group: '保留组', words: ['测试词'] }], 7);
  store.setHotwords({ tags: { 泛流量: ['好物推荐'] } });
  const hw = store.getHotwords();
  assert.strictEqual(hw.trending.length, 1);
  assert.strictEqual(hw.trending[0].group, '保留组');
  assert.ok(hw.tags['泛流量'].includes('好物推荐'));
});

test('heuristicParseTrending：清理排名/角标/#号/热度数值', () => {
  const raw = `1. 秋天的第一杯奶茶 热
2、宿舍收纳挑战 沸
③ 万圣节cosplay 新
4. 某明星官宣恋情 1234万热度
#好物分享 #开箱测评
5. 太短
6. 1234万`;
  const groups = heuristicParseTrending(raw);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].group, '今日热榜');
  const words = groups[0].words;
  assert.ok(words.includes('秋天的第一杯奶茶'));
  assert.ok(words.includes('宿舍收纳挑战'));
  assert.ok(words.includes('万圣节cosplay'));
  assert.ok(words.includes('某明星官宣恋情'), '热度数值应被清理');
  assert.ok(words.includes('好物分享') && words.includes('开箱测评'), '#话题应被提取');
  assert.ok(!words.some((w) => /^\d+万$/.test(w)), '纯数值应被丢弃');
});

test('heuristicParseTrending：空输入返回空数组', () => {
  assert.deepStrictEqual(heuristicParseTrending(''), []);
  assert.deepStrictEqual(heuristicParseTrending(null), []);
  assert.deepStrictEqual(heuristicParseTrending('a\nb'), []); // 词条长度不足
});

test('buildUserPrompt：热词注入扩展到口播场景与多变体', () => {
  const hotwords = [
    { group: '泛流量', words: ['#好物推荐'] },
    { group: '热榜·社会热点', words: ['#宿舍收纳挑战'] },
  ];
  const form = { productName: '收纳盒', category: '家居日用', sellingPoints: ['可折叠'], duration: '30' };

  const talkPrompt = buildUserPrompt('talk', form, { hotwords, count: 1 });
  assert.ok(talkPrompt.includes('近期热点词池'), '口播场景应注入热点词池');
  assert.ok(talkPrompt.includes('#宿舍收纳挑战'));
  assert.ok(talkPrompt.includes('不要硬蹭'));

  const variantPrompt = buildUserPrompt('talk', form, { hotwords, count: 3 });
  assert.ok(variantPrompt.includes('近期热点词池'), '多变体也应注入热点词池');

  const titlePrompt = buildUserPrompt('title', form, { hotwords, count: 1 });
  assert.ok(titlePrompt.includes('可用话题标签池'), '标题场景保持标签池文案');
  assert.ok(titlePrompt.includes('热榜·社会热点'));
});
