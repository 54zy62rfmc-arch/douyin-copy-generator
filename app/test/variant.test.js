'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { pickAngles, buildUserPrompt, ANGLE_POOL } = require('../lib/prompts');

test('pickAngles：正常抽取 n 个互不重复角度', () => {
  const angles = pickAngles(3);
  assert.strictEqual(angles.length, 3);
  assert.ok(angles.every((a) => ANGLE_POOL.includes(a) || /^.+·\d+$/.test(a)), '每个角度应来自池或带后缀');
  assert.strictEqual(new Set(angles).size, 3, '不重复');
});

test('pickAngles：排除已有角度', () => {
  const ex = ANGLE_POOL.slice(0, 8);
  const angles = pickAngles(2, ex);
  assert.strictEqual(angles.length, 2);
  assert.ok(angles.every((a) => !ex.includes(a)), '排除的应不再出现');
});

test('pickAngles：排除后不足时带后缀补齐', () => {
  const ex = ANGLE_POOL.slice();
  const angles = pickAngles(3, ex);
  assert.strictEqual(angles.length, 3);
  assert.ok(angles.every((a) => /^.+·\d+$/.test(a)), '全部应为带后缀的扩展角度');
});

test('pickAngles：强制角度优先', () => {
  assert.deepStrictEqual(pickAngles(3, [], '自定义角度'), ['自定义角度']);
});

test('buildUserPrompt：variantMode 时输出紧凑加粗标签格式', () => {
  const form = { productName: '收纳盒', category: '家居日用', sellingPoints: ['可折叠'], duration: '30', tone: '接地气' };
  const prompt = buildUserPrompt('talk', form, { variantMode: true, angle: '痛点型' });
  assert.ok(prompt.includes('切入角度指定为「痛点型」'), '应包含角度指令');
  assert.ok(prompt.includes('**钩子**：'), '应使用加粗标签格式');
  assert.ok(prompt.includes('不要使用 ## 二级标题'), '应明确禁止 ## 标题');
});

test('buildUserPrompt：variantMode + title 场景也使用紧凑格式', () => {
  const form = { productName: '收纳盒', category: '家居日用', sellingPoints: ['可折叠'], duration: '30' };
  const prompt = buildUserPrompt('title', form, { variantMode: true, angle: '反常识' });
  assert.ok(prompt.includes('切入角度指定为「反常识」'));
  assert.ok(prompt.includes('**标题**：'));
});
