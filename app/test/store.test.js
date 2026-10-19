'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bwc-store-'));
process.env.DATA_DIR = TMP;

const store = require('../lib/store');

test('history：upsert 合并、按创建时间倒序、删除、清空', () => {
  store.clearHistory();
  store.upsertHistory({ id: 't1', form: { productName: 'A' }, results: { talk: 'x' }, createdAt: 100 });
  store.upsertHistory({ id: 't2', form: { productName: 'B' }, createdAt: 200 });
  let h = store.getHistory();
  assert.strictEqual(h.length, 2);
  assert.strictEqual(h[0].id, 't2', '应按 createdAt 倒序');

  store.upsertHistory({ id: 't1', results: { talk: 'y' }, hookType: '悬念' });
  h = store.getHistory();
  const t1 = h.find((x) => x.id === 't1');
  assert.strictEqual(t1.results.talk, 'y');
  assert.strictEqual(t1.hookType, '悬念');
  assert.strictEqual(t1.form.productName, 'A', 'upsert 应合并保留旧字段');
  assert.ok(t1.updatedAt > 0);

  store.deleteHistory('t2');
  assert.strictEqual(store.getHistory().length, 1);
  store.clearHistory();
  assert.strictEqual(store.getHistory().length, 0);
});

test('history：封顶 200 条', () => {
  store.clearHistory();
  for (let i = 0; i < 205; i++) {
    store.upsertHistory({ id: 'cap' + i, createdAt: i, form: { productName: 'p' + i } });
  }
  const h = store.getHistory();
  assert.strictEqual(h.length, 200);
  assert.strictEqual(h[0].id, 'cap204', '最新一条保留');
  assert.ok(!h.some((x) => x.id === 'cap0'), '最旧一条被淘汰');
  store.clearHistory();
});

test('迁移：旧 JSON 文件导入 SQLite 并改名备份', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bwc-migrate-'));
  fs.writeFileSync(
    path.join(dir, 'history.json'),
    JSON.stringify([
      { id: 'h1', createdAt: 1, form: { productName: '旧品A' }, results: {} },
      { id: 'h2', createdAt: 2, form: { productName: '旧品B' }, results: {} },
    ]),
    'utf8'
  );
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ tokenHash: 'abc' }), 'utf8');

  const script = `
    const store = require(${JSON.stringify(path.resolve(__dirname, '../lib/store.js'))});
    const h = store.getHistory();
    console.log(JSON.stringify({ count: h.length, first: h[0].id, firstName: h[0].form.productName, token: store.getAuth().tokenHash }));
  `;
  const out = execFileSync(process.execPath, ['--experimental-sqlite', '-e', script], {
    env: Object.assign({}, process.env, { DATA_DIR: dir }),
    encoding: 'utf8',
  });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.strictEqual(r.count, 2, '历史应迁移 2 条');
  assert.strictEqual(r.first, 'h2', '倒序排列');
  assert.strictEqual(r.firstName, '旧品B');
  assert.strictEqual(r.token, 'abc', 'kv 表也应迁移');
  assert.ok(fs.existsSync(path.join(dir, 'copygen.db')), '应生成 SQLite 库');
  assert.ok(fs.existsSync(path.join(dir, 'history.json.migrated')), '原 JSON 应改名备份');
  assert.ok(!fs.existsSync(path.join(dir, 'history.json')), '原 JSON 不应保留原名');
});
