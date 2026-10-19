'use strict';
/* 抖音带货爆款文案生成器 —— 前端逻辑 */

/* ========== 基础工具 ========== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const DV = window.DV;
const escapeHtml = (s) => DV.escapeHtml(s);

const LS = {
  form: 'dv_form',
  history: 'dv_history',
  llm: 'dv_llm',
  token: 'dv_token',
  cloudsync: 'dv_cloudsync',
};

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1900);
}

function copyText(text, okMsg = '已复制到剪贴板') {
  const done = () => toast(okMsg);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch {
    toast('复制失败，请长按手动选择');
  }
  document.body.removeChild(ta);
}

/* ========== 合规高亮 ========== */
const MARK_OPEN = '\uE000';
const MARK_SEP = '\uE001';
const MARK_CLOSE = '\uE002';

/** 依据命中位置把风险词包上哨兵标记（哨兵不会被 Markdown 转义处理影响） */
function annotateRisk(text, hits) {
  if (!hits || !hits.length) return text;
  const sorted = hits.slice().sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let cursor = 0;
  for (const h of sorted) {
    if (h.start < cursor || h.start >= text.length) continue;
    const end = Math.min(h.end, text.length);
    out += text.slice(cursor, h.start);
    out += MARK_OPEN + (h.sev || 'mid') + MARK_SEP + text.slice(h.start, end) + MARK_CLOSE;
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}

function applyRiskMarks(root) {
  root.innerHTML = root.innerHTML
    .replace(/\uE000(high|mid|low)\uE001/g, '<mark class="risk risk-$1">')
    .replace(/\uE002/g, '</mark>');
}

/* ========== 全局状态 ========== */
const SCENES = ['talk', 'title', 'storyboard'];
const SCENE_LABEL = { talk: '口播脚本', title: '标题与话题', storyboard: '分镜脚本' };
const SCENE_HINT = {
  talk: '产出可直接照念的口播话术：黄金3秒钩子 + 痛点共鸣 + 卖点翻译 + 信任背书 + 逼单 CTA。',
  title: '产出 10 条视频标题 + 5 条封面大字 + 三组话题标签 + 评论区引导话术。',
  storyboard: '按时间轴切分镜头，每个镜头给画面运镜、口播台词、字幕和音效提示。',
};

const state = {
  scene: 'talk',
  activeScene: 'talk',
  controllers: {},
  busy: {},
  busyInfo: {},
  results: {},
  compliance: {},
  scanning: {},
  session: null,
  sheetForm: null,
  cloudSync: false,
  editing: false,
  historyList: null,
  rw: null,
  rwCtrl: null,
  abInfo: {},
  metricsOpen: null,
  fixing: {},
};

/* ========== 表单读写 ========== */
function collectForm() {
  const points = ($('#sellingPoints').value || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const chip = (f) => ($(`.chips[data-field="${f}"] .chip.on`) || {}).textContent || '';
  const seg = (f) => ($(`.seg[data-field="${f}"] button.on`) || {}).dataset?.val || '';
  return {
    productName: $('#productName').value.trim(),
    category: chip('category'),
    sellingPoints: points,
    audience: $('#audience').value.trim(),
    price: $('#price').value.trim(),
    usageScene: $('#usageScene').value.trim(),
    duration: seg('duration') || '30',
    tone: chip('tone'),
    persona: $('#persona').value.trim(),
    count: Number(seg('count')) || 1,
    extra: $('#extra').value.trim(),
  };
}

function applyForm(f) {
  if (!f) return;
  $('#productName').value = f.productName || '';
  $('#sellingPoints').value = (f.sellingPoints || []).join('\n');
  $('#audience').value = f.audience || '';
  $('#price').value = f.price || '';
  $('#usageScene').value = f.usageScene || '';
  $('#extra').value = f.extra || '';
  $('#persona').value = f.persona || '';
  setChip('category', f.category);
  setChip('tone', f.tone);
  setSeg('duration', f.duration || '30');
  setSeg('count', f.count || 1);
  syncCountField();
}

function setChip(field, val) {
  $$(`.chips[data-field="${field}"] .chip`).forEach((c) => c.classList.toggle('on', c.textContent === val));
}
function setSeg(field, val) {
  $$(`.seg[data-field="${field}"] button`).forEach((b) => b.classList.toggle('on', b.dataset.val === String(val)));
}
function syncCountField() {
  const box = $('#countField');
  if (box) box.classList.toggle('hidden', state.scene === 'storyboard');
}
function setScene(val) {
  state.scene = val;
  syncSheetSeg();
  syncCountField();
  $('#sceneHint').textContent = SCENE_HINT[val] || '';
  $('#btnGenerateCurrent').textContent = '生成' + SCENE_LABEL[val];
  refreshButtons();
}
function pushSeg(field, val) {
  $$(`.seg[data-field="${field}"] button`).forEach((b) => b.classList.toggle('on', b.dataset.val === String(val)));
  setScene(val);
}

/* ========== 请求头 ========== */
function llmHeaders() {
  const cfg = load(LS.llm, {});
  const h = { 'Content-Type': 'application/json' };
  if (cfg.key) h['x-llm-key'] = cfg.key;
  if (cfg.base) h['x-llm-base'] = cfg.base;
  if (cfg.model) h['x-llm-model'] = cfg.model;
  const token = load(LS.token, '');
  if (token) h['X-Access-Token'] = token;
  return h;
}

function handleUnauthorized(res) {
  if (res.status === 401) {
    toast('需要访问口令，请到「设置」填写');
    goTab('settings');
    $('#tokenInput')?.focus();
    return true;
  }
  return false;
}

/* ========== SSE 读取 ========== */
async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const rawLine of chunk.split('\n')) {
        if (!rawLine.startsWith('data:')) continue;
        let evt;
        try {
          evt = JSON.parse(rawLine.slice(5).trim());
        } catch {
          continue;
        }
        onEvent(evt);
      }
    }
  }
}

/* ========== 生成 ========== */
function newSession(form) {
  return {
    id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    name: form.productName || (form.category ? form.category + '好物' : '未命名商品'),
    form,
    results: {},
    done: {},
  };
}

function formKey(f) {
  return JSON.stringify([f.productName, f.category, f.sellingPoints, f.audience, f.price, f.usageScene, f.duration, f.tone, f.persona, f.extra]);
}

function ensureSession(form) {
  if (!state.session || !state.session.formKey || state.session.formKey !== formKey(form)) {
    state.session = newSession(form);
    state.session.formKey = formKey(form);
  }
  state.session.form = form;
  return state.session;
}

async function generate(scene, formOverride) {
  if (state.busy[scene]) return;

  const form = formOverride || collectForm();
  if (!state.sheetForm) state.sheetForm = form;
  const session = ensureSession(form);
  const count = scene === 'storyboard' ? 1 : Math.max(1, Number(form.count) || 1);

  // 重新生成时先清空该场景的旧内容与旧合规结果
  state.results[scene] = '';
  state.compliance[scene] = null;
  session.results[scene] = '';

  state.busy[scene] = true;
  state.busyInfo[scene] = '';
  state.editing = false;
  refreshButtons();
  openSheet();
  state.activeScene = scene;
  syncSheetSeg();
  renderResult();

  const ctrl = new AbortController();
  state.controllers[scene] = ctrl;

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: llmHeaders(),
      body: JSON.stringify({ scene, form, count, abItems: slimHistory() }),
      signal: ctrl.signal,
    });

    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('event-stream')) {
      let msg = `请求失败（${res.status}）`;
      try {
        const j = await res.json();
        msg = j.error || msg;
      } catch {}
      handleUnauthorized(res);
      throw new Error(msg);
    }

    let mode = '';
    let parallel = null; // 并行变体：{ angles: [], texts: [] }
    const rebuildParallel = () => {
      if (!parallel) return;
      state.results[scene] = parallel.angles
        .map((a, i) => `### 变体${i + 1} · ${a}\n${(parallel.texts[i] || '').trim()}`)
        .join('\n\n');
      session.results[scene] = state.results[scene];
      if (state.activeScene === scene) renderResult();
    };
    await readSse(res, (evt) => {
      if (evt.mode) mode = evt.mode;
      if (evt.mode === 'demo') state.busyInfo[scene] = '演示模式';
      if (evt.parallel && Array.isArray(evt.angles)) {
        parallel = { angles: evt.angles, texts: evt.angles.map(() => '') };
        rebuildParallel();
      }
      if (evt.model) state.busyInfo[scene] = `模型 ${evt.model}${evt.attempt ? `（第 ${evt.attempt + 1} 次）` : ''}${parallel && typeof evt.v === 'number' ? ` · 变体${evt.v + 1}` : ''}`;
      if (evt.ab) state.abInfo[scene] = `已按 ${evt.ab.sampleCount} 条投放数据注入历史打法`;
      if (typeof evt.v === 'number' && parallel) {
        if (evt.delta) {
          parallel.texts[evt.v] = (parallel.texts[evt.v] || '') + evt.delta;
          rebuildParallel();
        }
        if (evt.error) {
          parallel.texts[evt.v] = (parallel.texts[evt.v] || '') + `\n\n> 该变体生成失败：${evt.error}`;
          rebuildParallel();
        }
        return; // 变体事件已处理
      }
      if (evt.delta) {
        state.results[scene] = (state.results[scene] || '') + evt.delta;
        session.results[scene] = state.results[scene];
        if (state.activeScene === scene) renderResult();
      }
      if (evt.compliance) state.compliance[scene] = evt.compliance;
      if (evt.error) throw new Error(evt.error);
    });

    session.done[scene] = true;
    if (mode === 'demo') state.busyInfo[scene] = '演示模式';
    saveHistory(session);
    renderHistory();
  } catch (err) {
    if (err.name === 'AbortError') return;
    const msg = '生成失败：' + (err.message || '未知错误');
    const cur = state.results[scene] || '';
    if (!cur.trim()) {
      state.results[scene] = `> ${msg}\n\n请到「设置」检查 API Key、Base URL 与模型名，或直接留空使用演示模式。`;
    } else {
      state.results[scene] = cur + `\n\n> ${msg}`;
    }
    session.results[scene] = state.results[scene];
    if (state.activeScene === scene) renderResult();
    toast(msg.slice(0, 40));
  } finally {
    state.busy[scene] = false;
    delete state.controllers[scene];
    refreshButtons();
    updateStreamState();
    if (state.activeScene === scene) renderResult();
  }
}

function updateStreamState() {
  const el = $('#streamState');
  const scene = state.activeScene;
  const ab = state.abInfo[scene] ? ` · ${state.abInfo[scene]}` : '';
  if (state.busy[scene]) {
    const info = state.busyInfo[scene] ? ` · ${state.busyInfo[scene]}` : '';
    el.innerHTML = `<span class="pulse"></span>正在生成${escapeHtml(info)}…`;
  } else if (state.results[scene]?.trim()) {
    el.innerHTML = `<span style="font-size:12.5px;color:#3ddc84">✓ 生成完成</span>${escapeHtml(ab)}`;
  } else {
    el.innerHTML = '';
  }
}

/* ========== 再来一版（追加新角度变体） ========== */
async function addVariant() {
  const scene = state.activeScene;
  const base = state.results[scene] || '';
  if (state.busy[scene] || !isVariant(base)) return;
  const form = state.sheetForm || collectForm();
  const session = ensureSession(form);
  const variants = DV.splitVariants(base);
  const existing = variants.map((it) => it.angle).filter(Boolean);

  state.busy[scene] = true;
  state.busyInfo[scene] = '追加新角度';
  refreshButtons();

  const ctrl = new AbortController();
  state.controllers[scene] = ctrl;
  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: llmHeaders(),
      body: JSON.stringify({ scene, form, count: 1, variantSingle: true, excludeAngles: existing, abItems: slimHistory() }),
      signal: ctrl.signal,
    });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('event-stream')) {
      let msg = `请求失败（${res.status}）`;
      try {
        const j = await res.json();
        msg = j.error || msg;
      } catch {}
      handleUnauthorized(res);
      throw new Error(msg);
    }

    let angle = '新角度';
    let buf = '';
    let useParallel = false;
    const rebuild = () => {
      state.results[scene] = base.trimEnd() + `\n\n### 变体${variants.length + 1} · ${angle}\n${buf.trim()}`;
      session.results[scene] = state.results[scene];
      if (state.activeScene === scene) renderResult();
    };
    await readSse(res, (evt) => {
      if (evt.parallel && Array.isArray(evt.angles) && evt.angles[0]) {
        useParallel = true;
        angle = evt.angles[0];
        rebuild();
      }
      if (evt.model) state.busyInfo[scene] = `模型 ${evt.model} · 新变体`;
      if (typeof evt.v === 'number') {
        if (evt.delta) {
          buf += evt.delta;
          rebuild();
        }
        if (evt.error) {
          buf += `\n\n> 生成失败：${evt.error}`;
          rebuild();
        }
        return;
      }
      if (evt.delta && !useParallel) {
        buf += evt.delta; // 演示模式兜底
        rebuild();
      }
      if (evt.compliance) state.compliance[scene] = evt.compliance;
      if (evt.error) throw new Error(evt.error);
    });

    session.done[scene] = true;
    saveHistory(session);
    renderHistory();
    toast(`已追加新角度「${angle}」`);
  } catch (err) {
    if (err.name !== 'AbortError') toast(('追加失败：' + (err.message || '未知错误')).slice(0, 40));
  } finally {
    state.busy[scene] = false;
    delete state.controllers[scene];
    refreshButtons();
    updateStreamState();
    if (state.activeScene === scene) renderResult();
  }
}

/* ========== 结果渲染 ========== */
function isVariant(text) {
  const items = DV.splitVariants(text || '');
  return items.length > 1 && items.every((it) => /^变体/.test(it.title));
}

function cleanBlocks(text) {
  return isVariant(text) ? DV.splitVariants(text) : DV.splitSections(text);
}

function variantCard(it, i) {
  const angle = it.angle || '';
  return `<div class="var-card">
    <div class="var-head">
      <span class="var-title">${escapeHtml(it.title)}</span>
      ${angle ? `<span class="var-angle">${escapeHtml(angle)}</span>` : ''}
    </div>
    <div class="var-body md">${DV.mdToHtml(it.body, false)}</div>
    <div class="var-acts">
      <button class="tool-btn" data-copy="${i}" type="button">复制</button>
      <button class="tool-btn" data-rw="${i}" type="button">重写</button>
    </div>
  </div>`;
}

function sectionBlock(s, i) {
  return `<div class="section">
    ${DV.mdToHtml(s.raw, false)}
    ${s.preamble ? '' : `<button class="sec-rw" data-rw="${i}" type="button">重写本段</button>`}
  </div>`;
}

function renderCompliance(scene) {
  const bar = $('#complianceBar');
  const comp = state.compliance[scene];
  if (!comp) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  bar.classList.remove('hidden');
  const lvl = comp.level || 'ok';
  const cls = lvl === 'ok' ? 'ok' : lvl === 'high' ? 'high' : lvl === 'low' ? 'low' : 'mid';
  const groups = comp.groups || [];
  const fixable = groups.length && !state.fixing[scene];
  bar.className = 'compliance ' + cls;
  bar.innerHTML = `
    <div class="cmp-head">
      <span class="cmp-dot"></span>
      <span class="cmp-sum">${escapeHtml(comp.summary || '')}</span>
      ${lvl !== 'ok' && lvl !== 'low' ? `<button class="btn btn-ghost btn-sm cmp-fix" id="btnCmpFix" type="button">${state.fixing[scene] ? '改写中…' : '一键合规改写'}</button>` : ''}
      ${groups.length ? '<span class="cmp-toggle">明细</span>' : ''}
    </div>
    ${
      groups.length
        ? `<div class="cmp-list hidden">${groups.map(cmpGroup).join('')}</div>`
        : ''
    }`;
  $('.cmp-head', bar)?.addEventListener('click', (e) => {
    if (e.target.closest('.cmp-fix')) return;
    $('.cmp-list', bar)?.classList.toggle('hidden');
  });
  $('#btnCmpFix', bar)?.addEventListener('click', () => doComplianceFix(scene));
}

/* 一键合规改写：调服务端改写（LLM 优先/词表兜底）+ 复检，直接替换当前结果 */
async function doComplianceFix(scene) {
  const text = state.results[scene];
  if (!text?.trim()) return;
  if (state.fixing[scene]) return;
  state.fixing[scene] = true;
  renderCompliance(scene);
  try {
    const res = await fetch('/api/compliance-fix', {
      method: 'POST',
      headers: llmHeaders(),
      body: JSON.stringify({ text, category: state.session.form?.category || '' }),
    });
    if (handleUnauthorized(res)) return;
    const j = await res.json();
    if (j.error) {
      toast(j.error);
      return;
    }
    if (j.changed) {
      state.results[scene] = j.text;
      state.session.results[scene] = j.text;
      saveHistory(state.session);
    }
    if (j.compliance) state.compliance[scene] = j.compliance;
    toast(j.note || (j.changed ? '已改写并复检' : '内容未变化'));
    renderResult();
  } catch (err) {
    toast('改写失败：' + (err.message || '网络错误'));
  } finally {
    state.fixing[scene] = false;
    if (state.activeScene === scene && $('#complianceBar') && !$('#complianceBar').classList.contains('hidden')) {
      renderCompliance(scene);
    }
  }
}

function cmpGroup(g) {
  const sev = g.sev === 'high' ? '高' : g.sev === 'low' ? '提示' : '中';
  const sugg = Object.entries(g.suggestions || {})
    .map(([w, s]) => `${w}→${s || '（删除）'}`)
    .slice(0, 6)
    .join('  ');
  return `<div class="cmp-group sev-${escapeHtml(g.sev)}">
    <div class="cmp-g-title">${escapeHtml(g.cat)} <span class="cmp-sev">${sev}${g.sev === 'low' ? '级' : '风险'}</span></div>
    <div class="cmp-words">${g.words.map((w) => `<span class="cmp-word">${escapeHtml(w)}</span>`).join('')}</div>
    ${sugg ? `<div class="cmp-sugg">参考改法：${escapeHtml(sugg)}</div>` : ''}
    <div class="cmp-tip">${escapeHtml(g.tip || '')}</div>
  </div>`;
}

async function scanRemote(text) {
  try {
    const res = await fetch('/api/compliance', {
      method: 'POST',
      headers: llmHeaders(),
      body: JSON.stringify({ text, category: state.session?.form?.category || '' }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function renderResult() {
  const scene = state.activeScene;
  const text = state.results[scene] || '';
  const busy = Boolean(state.busy[scene]);
  const body = $('#resultBody');
  const editWrap = $('#editWrap');

  if (state.editing) {
    body.classList.add('hidden');
    editWrap.classList.remove('hidden');
    updateStreamState();
    renderCompliance(scene);
    return;
  }
  body.classList.remove('hidden');
  editWrap.classList.add('hidden');

  renderCompliance(scene);

  if (!text.trim()) {
    body.innerHTML = busy ? '<span class="cursor"></span>' : '<div class="empty">该场景还没有内容<br>点下方「重新生成」或返回生成页</div>';
    updateStreamState();
    return;
  }

  if (busy) {
    body.innerHTML = DV.mdToHtml(text, true);
    updateStreamState();
    refreshButtons();
    return;
  }

  // 完成后：未拿到合规结果则异步补扫一次
  if (!state.compliance[scene] && !state.scanning[scene]) {
    state.scanning[scene] = true;
    scanRemote(text).then((r) => {
      state.scanning[scene] = false;
      if (r) {
        state.compliance[scene] = r;
        if (state.activeScene === scene) renderResult();
      }
    });
  }

  const hits = state.compliance[scene]?.hits || [];
  const annotated = annotateRisk(text, hits);

  if (isVariant(text)) {
    body.innerHTML = DV.splitVariants(annotated).map(variantCard).join('');
  } else {
    const sections = DV.splitSections(annotated);
    body.innerHTML = sections.length > 1 ? sections.map(sectionBlock).join('') : DV.mdToHtml(annotated, false);
  }
  applyRiskMarks(body);
  updateStreamState();
  refreshButtons();
}

function refreshButtons() {
  $('#btnGenerateCurrent').disabled = state.busy[state.scene];
  $('#btnGenerateAll').disabled = SCENES.some((s) => state.busy[s]);
  $('#btnRegen').disabled = state.busy[state.activeScene];
  $('#btnEdit').disabled = state.busy[state.activeScene];
  const showAdd = isVariant(state.results[state.activeScene] || '') && !state.busy[state.activeScene] && state.activeScene !== 'storyboard';
  $('#btnAddVariant').classList.toggle('hidden', !showAdd);
}

/* ========== 结果面板 ========== */
function openSheet() {
  $('#resultSheet').classList.add('open');
  $('#resultSheet').setAttribute('aria-hidden', 'false');
}
function closeSheet() {
  $('#resultSheet').classList.remove('open');
  $('#resultSheet').setAttribute('aria-hidden', 'true');
  SCENES.forEach((s) => state.controllers[s]?.abort());
}
function syncSheetSeg() {
  $$('#sheetSeg button').forEach((b) => b.classList.toggle('on', b.dataset.val === state.activeScene));
}

/* ========== 局部重写 ========== */
function openRewrite(index) {
  const scene = state.activeScene;
  const text = state.results[scene] || '';
  const mode = isVariant(text) ? 'variant' : 'section';
  const blocks = cleanBlocks(text);
  const b = blocks[index];
  if (!b) return;
  state.rw = {
    scene,
    mode,
    index,
    title: b.title || b.angle || '',
    text: b.body || b.raw,
    form: state.sheetForm || collectForm(),
    result: '',
    blocks,
  };
  $('#rwTitle').textContent = mode === 'variant' ? '重写该版本' : '局部重写';
  $('#rwSection').textContent = b.title || (mode === 'variant' ? '该版本' : '开头段落');
  $('#rwInstruction').value = '';
  $('#rwStream').innerHTML = '';
  $('#rwError').textContent = '';
  $('#btnRwApply').disabled = true;
  $('#rwMask').classList.remove('hidden');
}

function closeRewrite() {
  state.rwCtrl?.abort();
  state.rwCtrl = null;
  $('#rwMask').classList.add('hidden');
  state.rw = null;
}

async function startRewrite() {
  if (!state.rw) return;
  const rw = state.rw;
  state.rwCtrl?.abort();
  const ctrl = new AbortController();
  state.rwCtrl = ctrl;
  rw.result = '';
  $('#rwStream').innerHTML = '<span class="cursor"></span>';
  $('#rwError').textContent = '';
  $('#btnRwApply').disabled = true;
  $('#btnRwStart').disabled = true;

  try {
    const res = await fetch('/api/rewrite', {
      method: 'POST',
      headers: llmHeaders(),
      body: JSON.stringify({
        scene: rw.scene,
        sectionTitle: rw.title,
        sectionText: rw.text,
        form: rw.form,
        instruction: $('#rwInstruction').value.trim(),
      }),
      signal: ctrl.signal,
    });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('event-stream')) {
      let msg = `请求失败（${res.status}）`;
      try {
        msg = (await res.json()).error || msg;
      } catch {}
      handleUnauthorized(res);
      throw new Error(msg);
    }
    await readSse(res, (evt) => {
      if (evt.delta) {
        rw.result += evt.delta;
        $('#rwStream').innerHTML = DV.mdToHtml(rw.result, true);
      }
      if (evt.error) throw new Error(evt.error);
    });
    $('#rwStream').innerHTML = DV.mdToHtml(rw.result, false);
    $('#btnRwApply').disabled = !rw.result.trim();
  } catch (err) {
    if (err.name === 'AbortError') return;
    $('#rwError').textContent = '重写失败：' + (err.message || '未知错误');
    $('#rwStream').innerHTML = '';
  } finally {
    $('#btnRwStart').disabled = false;
  }
}

function applyRewrite() {
  const rw = state.rw;
  if (!rw || !rw.result.trim()) return;
  const blocks = rw.blocks.slice();
  const b = blocks[rw.index];
  const body = rw.result.trim();
  const raw = rw.mode === 'variant' ? `### ${b.title}\n${body}` : b.title ? `## ${b.title}\n${body}` : body;
  blocks[rw.index] = { ...b, body, raw };
  const text = blocks.map((x) => x.raw).join('\n\n');
  state.results[rw.scene] = text;
  const scene = rw.scene;
  closeRewrite();
  state.compliance[scene] = null;
  renderResult();
  toast('已替换该段内容');
}

/* ========== 编辑 / 导出 ========== */
function toggleEdit() {
  const scene = state.activeScene;
  if (state.editing) {
    const val = $('#editArea').value;
    state.results[scene] = val;
    state.editing = false;
    state.compliance[scene] = null;
    state.scanning[scene] = false;
    $('#btnEdit').textContent = '编辑';
    renderResult();
    scanRemote(val).then((r) => {
      if (r) {
        state.compliance[scene] = r;
        if (state.activeScene === scene) renderResult();
      }
    });
    toast('已保存修改');
  } else {
    if (!state.results[scene]?.trim()) return toast('还没有内容可编辑');
    $('#editArea').value = state.results[scene];
    state.editing = true;
    $('#btnEdit').textContent = '完成';
    renderResult();
  }
}

function exportMarkdown() {
  const scene = state.activeScene;
  const text = state.results[scene];
  if (!text?.trim()) return toast('还没有内容可导出');
  const name = String(state.sheetForm?.productName || state.session?.name || '文案').replace(/[\\/:*?"<>|]/g, '_');
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}-${SCENE_LABEL[scene]}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('已导出 Markdown');
}

/* ========== 历史 ========== */
function isCloud() {
  return state.cloudSync;
}

async function fetchHistory() {
  try {
    const res = await fetch('/api/history', { headers: llmHeaders() });
    if (!res.ok) {
      handleUnauthorized(res);
      return null;
    }
    const j = await res.json();
    return Array.isArray(j.items) ? j.items : null;
  } catch {
    return null;
  }
}

function localHistory() {
  return load(LS.history, []);
}

/* 从口播脚本中提取主选钩子的策略标注（与服务端 lib/ab.js 规则一致） */
function extractHookTypeLocal(text) {
  const m = /主选[：:][^\n]*?[（(]([^（()）]{2,6})[）)]/.exec(String(text || ''));
  return m ? m[1].trim() : '';
}

function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(Math.round(n * 100) / 100);
}

function metricsSummary(m) {
  if (!m) return '';
  const parts = [];
  if (m.views) parts.push(`播放 ${fmtNum(m.views)}`);
  if (m.retention != null && m.retention !== '') parts.push(`完播 ${m.retention}%`);
  if (m.cvr != null && m.cvr !== '') parts.push(`转化 ${m.cvr}%`);
  if (m.gmv) parts.push(`GMV ${fmtNum(m.gmv)}`);
  return parts.join(' · ');
}

function metricsPanelHtml(id, m) {
  const v = (k) => (m && m[k] != null ? m[k] : '');
  return `<div class="m-panel" data-mpanel="${id}">
    <div class="m-grid">
      <label class="field"><span class="label">播放量</span><input type="number" min="0" data-mp="views" value="${v('views')}" placeholder="如 12000" /></label>
      <label class="field"><span class="label">完播率 %</span><input type="number" min="0" max="100" step="0.1" data-mp="retention" value="${v('retention')}" placeholder="如 42" /></label>
      <label class="field"><span class="label">转化率 %</span><input type="number" min="0" max="100" step="0.01" data-mp="cvr" value="${v('cvr')}" placeholder="如 1.8" /></label>
      <label class="field"><span class="label">成交额 GMV</span><input type="number" min="0" step="0.01" data-mp="gmv" value="${v('gmv')}" placeholder="如 850" /></label>
    </div>
    <p class="hint">数据只存在本机（开云同步则存服务端）。累计 3 条后，生成时会自动反哺最优打法。</p>
    <div class="btn-row" style="margin-top:8px"><button class="btn btn-primary" data-msave="${id}" type="button">保存投放数据</button></div>
  </div>`;
}

function saveHistory(session) {
  const list = localHistory();
  const idx = list.findIndex((x) => x.id === session.id);
  const prev = idx >= 0 ? list[idx] : null;
  const item = {
    id: session.id,
    ts: session.ts,
    name: session.name,
    form: session.form,
    results: session.results,
    formKey: session.formKey,
    hookType: extractHookTypeLocal(session.results?.talk),
    metrics: prev?.metrics || null,
  };
  if (idx >= 0) list[idx] = item;
  else list.unshift(item);
  const trimmed = list.slice(0, 60);
  save(LS.history, trimmed);

  if (isCloud()) {
    fetch('/api/history', {
      method: 'POST',
      headers: llmHeaders(),
      body: JSON.stringify({ item }),
    }).catch(() => {});
  }
}

async function renderHistory() {
  const box = $('#historyList');
  let list;
  if (isCloud()) {
    const server = await fetchHistory();
    if (server) {
      list = server;
      save(LS.history, server.slice(0, 60));
    } else {
      list = localHistory();
    }
  } else {
    list = localHistory();
  }
  state.historyList = list;

  if (!list.length) {
    box.innerHTML = `<div class="empty">还没有生成记录<br>去「生成」页写一条爆款文案吧</div>`;
    return;
  }
  box.innerHTML = list
    .map((it) => {
      const tags = SCENES.filter((s) => it.results?.[s]?.trim())
        .map((s) => `<span class="hist-tag">${SCENE_LABEL[s]}</span>`)
        .join('');
      const hookTag = it.hookType ? `<span class="hist-tag hist-tag-hook">钩子·${escapeHtml(it.hookType)}</span>` : '';
      const d = new Date(it.ts || it.updatedAt || Date.now());
      const time = `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const mline = it.metrics ? `<div class="hist-metrics">已录投放：${escapeHtml(metricsSummary(it.metrics))}</div>` : '';
      const panel = state.metricsOpen === it.id ? metricsPanelHtml(it.id, it.metrics) : '';
      return `<div class="hist-item" data-id="${it.id}">
        <div class="hist-main">
          <p class="hist-name">${escapeHtml(it.name)}</p>
          <div class="hist-meta">${time} · ${it.form?.duration || '30'}秒 · ${escapeHtml(it.form?.tone || '')}${it.form?.persona ? ' · ' + escapeHtml(it.form.persona) : ''}</div>
          <div class="hist-tags">${tags + hookTag || '<span class="hist-tag">空</span>'}</div>
          ${mline}
          <button class="tool-btn m-btn" data-metrics="${it.id}" type="button">${it.metrics ? '改投放数据' : '录投放数据'}</button>
          ${panel}
        </div>
        <button class="hist-del" data-del="${it.id}" type="button">×</button>
      </div>`;
    })
    .join('');
}

function openHistoryItem(id) {
  const it = (state.historyList || localHistory()).find((x) => x.id === id);
  if (!it) return;
  state.session = { id: it.id, ts: it.ts, name: it.name, form: it.form, results: it.results || {}, done: {}, formKey: it.formKey };
  state.sheetForm = it.form;
  state.results = { talk: '', title: '', storyboard: '', ...(it.results || {}) };
  state.compliance = {};
  state.editing = false;
  $('#btnEdit').textContent = '编辑';
  const first = SCENES.find((s) => state.results[s]?.trim()) || 'talk';
  state.activeScene = first;
  renderResult();
  syncSheetSeg();
  refreshButtons();
  openSheet();
}

/* ========== 投放数据录入（A/B 回流） ========== */
async function saveMetrics(id) {
  const panel = $(`.m-panel[data-mpanel="${id}"]`);
  if (!panel) return;
  const metrics = {};
  const labels = { views: '播放量', retention: '完播率', cvr: '转化率', gmv: 'GMV' };
  for (const k of Object.keys(labels)) {
    const raw = (panel.querySelector(`[data-mp="${k}"]`)?.value || '').trim();
    if (raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return toast(`${labels[k]}需为非负数字`);
    metrics[k] = n;
  }
  if (!Object.keys(metrics).length) return toast('请至少填写一项投放数据');

  const list = localHistory();
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) return toast('记录不存在');
  list[idx] = { ...list[idx], metrics };
  save(LS.history, list);
  state.historyList = list;
  state.metricsOpen = null;

  if (isCloud()) {
    try {
      await fetch('/api/history', {
        method: 'POST',
        headers: llmHeaders(),
        body: JSON.stringify({ item: list[idx] }),
      });
    } catch {}
  }
  renderHistory();
  toast('已保存，可在「分析」页查看打法');
}

/* ========== 打法分析（A/B 回流分析视图） ========== */
function slimHistory() {
  return localHistory()
    .filter((x) => x.metrics)
    .map(({ id, name, form, metrics, hookType }) => ({ id, name, form, metrics, hookType }));
}

/* 启动时把本机积累的投放数据一次性合并到服务端，避免本地/服务端双轨分叉 */
async function syncMetricsToCloud() {
  if (!isCloud()) return;
  const items = slimHistory();
  if (!items.length) return;
  try {
    const res = await fetch('/api/history', {
      method: 'POST',
      headers: llmHeaders(),
      body: JSON.stringify({ action: 'merge', items }),
    });
    if (handleUnauthorized(res)) return;
    const j = await res.json();
    if (j && Array.isArray(j.items)) save(LS.history, j.items.slice(0, 60));
  } catch {}
}

async function loadAnalysis() {
  const box = $('#abBody');
  box.innerHTML = '<div class="empty">正在分析…</div>';
  try {
    const res = await fetch('/api/ab-analysis', {
      method: 'POST',
      headers: llmHeaders(),
      body: JSON.stringify({ items: slimHistory() }),
    });
    if (handleUnauthorized(res)) return;
    const data = await res.json();
    renderAnalysis(data);
  } catch (err) {
    box.innerHTML = `<div class="empty">分析失败：${escapeHtml(err.message || '网络错误')}</div>`;
  }
}

function renderAnalysis(data) {
  const box = $('#abBody');
  if (!data.sampleCount) {
    box.innerHTML = `<section class="card"><div class="empty">还没有带投放数据的记录<br><br>先去「生成」页产出文案，投放后在「历史」里点「录投放数据」<br>填播放量 / 完播率 / 转化率 / GMV，累计 3 条即可生成打法分析</div></section>`;
    return;
  }

  const winnersHtml = (data.winners || [])
    .map(
      (w) => `<div class="ab-win">
      <div class="ab-win-dim">${escapeHtml(w.label)}</div>
      <div class="ab-win-val">${escapeHtml(w.value)}</div>
      <div class="ab-win-m">${[
        w.avgRetention != null ? `完播 ${w.avgRetention}%` : '',
        w.avgCvr != null ? `转化 ${w.avgCvr}%` : '',
        w.gpm ? `千次播放 ${fmtNum(w.gpm)} 元` : '',
      ].filter(Boolean).join(' · ') || '综合表现最好'}（${w.count} 条）</div>
    </div>`
    )
    .join('');

  const dimsHtml = (data.dimensions || [])
    .map(
      (d) => `<section class="card ab-dim">
      <h2 class="card-title"><span class="dot"></span>按${escapeHtml(d.label)}</h2>
      <table class="ab-table">
        <thead><tr><th>${escapeHtml(d.label)}</th><th>样本</th><th>播放</th><th>完播率</th><th>转化率</th><th>千次GMV</th><th>综合分</th></tr></thead>
        <tbody>
          ${d.groups
            .map(
              (g, i) => `<tr class="${i === 0 ? 'ab-best' : ''}"><td>${escapeHtml(g.value)}</td><td>${g.count}</td><td>${fmtNum(g.views)}</td><td>${
                g.avgRetention != null ? g.avgRetention + '%' : '—'
              }</td><td>${g.avgCvr != null ? g.avgCvr + '%' : '—'}</td><td>${g.gpm ? fmtNum(g.gpm) : '—'}</td><td>${g.score}</td></tr>`
            )
            .join('')}
        </tbody>
      </table>
    </section>`
    )
    .join('');

  box.innerHTML = `
    <section class="card ab-advice">
      <h2 class="card-title"><span class="dot"></span>最优打法 <em class="ct-opt">${data.sampleCount} 条投放数据</em></h2>
      ${winnersHtml}
      <p class="hint">下次生成时，这些已验证的打法会自动注入提示词（累计 3 条数据生效）。</p>
    </section>
    ${dimsHtml}`;
}

/* ========== 快速填充：链接解析 / 主图识图 ========== */
function fillHint(text, cls = 'hint') {
  const el = $('#fillHint');
  el.className = cls;
  el.textContent = text;
}

function fillFromInfo(info) {
  let n = 0;
  if (info.productName) {
    $('#productName').value = info.productName;
    n++;
  }
  if (info.category) {
    setChip('category', info.category);
    n++;
  }
  if (Array.isArray(info.sellingPoints) && info.sellingPoints.length) {
    $('#sellingPoints').value = info.sellingPoints.join('\n');
    n++;
  }
  if (info.price) {
    $('#price').value = info.price;
    n++;
  }
  if (info.audience) {
    $('#audience').value = info.audience;
    n++;
  }
  if (info.usageScene) {
    $('#usageScene').value = info.usageScene;
    n++;
  }
  persistFormDebounced();
  return n;
}

async function doExtract() {
  const url = $('#productUrl').value.trim();
  if (!url) return fillHint('请先粘贴商品链接', 'hint err');
  const btn = $('#btnExtract');
  btn.disabled = true;
  fillHint('正在抓取并解析页面…');
  try {
    const res = await fetch('/api/extract', {
      method: 'POST',
      headers: llmHeaders(),
      body: JSON.stringify({ url }),
    });
    if (handleUnauthorized(res)) return;
    const j = await res.json();
    if (!j.ok) {
      fillHint(j.message || '解析失败，请手动填写', 'hint err');
      return;
    }
    const n = fillFromInfo(j.info || {});
    fillHint(`${j.mode === 'llm' ? '模型已解析页面' : '页面解析完成'}，已填充 ${n} 项，请核对后再生成`, 'hint ok');
  } catch (err) {
    fillHint('解析失败：' + (err.message || '网络错误'), 'hint err');
  } finally {
    btn.disabled = false;
  }
}

function fileToDataUrl(file, maxSide = 1280, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

async function doVision() {
  const file = $('#productImage').files?.[0];
  if (!file) return fillHint('请先选择一张商品主图', 'hint err');
  const btn = $('#btnVision');
  btn.disabled = true;
  fillHint('正在压缩图片并识别…');
  try {
    const dataUrl = await fileToDataUrl(file);
    const preview = $('#imgPreview');
    preview.src = dataUrl;
    preview.classList.remove('hidden');
    const res = await fetch('/api/vision', {
      method: 'POST',
      headers: llmHeaders(),
      body: JSON.stringify({ image: dataUrl, hint: $('#productName').value.trim() }),
    });
    if (handleUnauthorized(res)) return;
    const j = await res.json();
    if (!j.ok) {
      fillHint(j.message || '识图失败，请手动填写', 'hint err');
      return;
    }
    const n = fillFromInfo(j.info || {});
    fillHint(`模型识别完成，已填充 ${n} 项，请核对后再生成`, 'hint ok');
  } catch (err) {
    fillHint('识图失败：' + (err.message || '未知错误'), 'hint err');
  } finally {
    btn.disabled = false;
  }
}

/* ========== 粘贴提炼（粘贴文本一键结构化） ========== */
async function doParseText() {
  const text = $('#pasteText').value.trim();
  if (!text) return fillHint('请先粘贴商品标题与卖点原文', 'hint err');
  const btn = $('#btnParseText');
  btn.disabled = true;
  fillHint('正在提炼…');
  try {
    const res = await fetch('/api/parse-text', {
      method: 'POST',
      headers: llmHeaders(),
      body: JSON.stringify({ text }),
    });
    if (handleUnauthorized(res)) return;
    const j = await res.json();
    if (!j.ok) {
      fillHint(j.message || j.error || '提炼失败，请手动填写', 'hint err');
      return;
    }
    const n = fillFromInfo(j.info || {});
    fillHint(`${j.mode === 'llm' ? '模型提炼完成' : '规则提炼完成'}，已填充 ${n} 项，请核对后再生成`, 'hint ok');
  } catch (err) {
    fillHint('提炼失败：' + (err.message || '网络错误'), 'hint err');
  } finally {
    btn.disabled = false;
  }
}

/* ========== 从选品分析导入（OrderPulse 打通） ========== */
async function openOpImport() {
  const mask = $('#opMask');
  const list = $('#opList');
  mask.classList.remove('hidden');
  list.innerHTML = '<div class="op-empty">正在读取选品库…</div>';
  let data;
  try {
    const res = await fetch('/api/op/products');
    data = await res.json();
  } catch {
    data = { ok: false, error: '网络错误' };
  }
  if (!data.ok) {
    list.innerHTML = `<div class="op-empty">${escapeHtml(data.error || '读取失败')}</div>`;
    return;
  }
  const cards = data.cards || [];
  if (!cards.length) {
    list.innerHTML = '<div class="op-empty">选品库还没有商品，先去 OrderPulse 导入数据</div>';
    return;
  }
  list.innerHTML = cards
    .map(
      (c) => `<div class="op-item" data-pid="${escapeHtml(c.product_id)}" data-name="${escapeHtml(c.name)}">
      <div class="op-item-name">${escapeHtml(c.name)}</div>
      <div class="op-item-meta">${escapeHtml(c.category || '未分类')} · 近30天销量 ${fmtNum(c.sales30d)} · GMV ${fmtNum(c.gmv)} · 转化率 ${c.cvr}%</div>
    </div>`
    )
    .join('');
}

async function opImportOne(pid) {
  $('#opMask').classList.add('hidden');
  fillHint('正在导入…');
  try {
    const res = await fetch(`/api/op/import?product_id=${encodeURIComponent(pid)}`);
    const j = await res.json();
    if (!j.ok) {
      fillHint(j.error || '导入失败', 'hint err');
      return;
    }
    const n = fillFromInfo(j.info || {});
    if (j.metrics) {
      const m = j.metrics;
      const ref = `（选品参考）近30天销量 ${fmtNum(m.sales30d)} · GMV ${fmtNum(m.gmv)} · 转化率 ${m.cvr}%`;
      const extra = $('#extra');
      extra.value = extra.value.trim() ? `${extra.value.trim()}\n${ref}` : ref;
      persistFormDebounced();
    }
    fillHint(`已导入选品「${j.info.productName}」，填充 ${n} 项${j.info.sellingPoints.length ? '，含视频标注卖点' : '（该商品暂无视频标注卖点）'}，请核对`, 'hint ok');
  } catch (err) {
    fillHint('导入失败：' + (err.message || '网络错误'), 'hint err');
  }
}

/* ========== 服务端素材库 ========== */
function hotwordsToText(hw) {
  const tags = hw?.tags || {};
  return Object.entries(tags)
    .map(([g, words]) => `${g}: ${(words || []).join(' ')}`)
    .join('\n');
}

function textToHotwords(text) {
  const tags = {};
  for (const line of String(text || '').split('\n')) {
    const idx = line.indexOf(':');
    const idx2 = line.indexOf('：');
    const cut = idx >= 0 ? idx : idx2;
    if (cut < 0) continue;
    const group = line.slice(0, cut).trim();
    const words = line
      .slice(cut + 1)
      .split(/[\s,，、]+/)
      .map((w) => w.replace(/^#/, '').trim())
      .filter(Boolean);
    if (group && words.length) tags[group] = words;
  }
  return { tags };
}

async function loadHotwords() {
  try {
    const res = await fetch('/api/hotwords', { headers: llmHeaders() });
    if (handleUnauthorized(res)) return;
    const hw = await res.json();
    $('#hotwordsBox').value = hotwordsToText(hw);
    $('#hotwordsHint').textContent = hw.note || '';
    renderTrending(hw);
  } catch {
    $('#hotwordsHint').textContent = '读取失败，检查服务是否运行';
  }
}

function renderTrending(hw) {
  const box = $('#trendingList');
  if (!box) return;
  const list = Array.isArray(hw?.trending) ? hw.trending : [];
  if (!list.length) {
    box.innerHTML = '';
    return;
  }
  const now = Date.now();
  box.innerHTML = list
    .map((g) => {
      const expired = g.expiresAt && g.expiresAt < now;
      const d = g.expiresAt ? new Date(g.expiresAt) : null;
      const exp = d ? `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}` : '';
      return `<div class="trend-group${expired ? ' is-expired' : ''}">
        <div class="trend-head">
          <span class="trend-name">热榜 · ${escapeHtml(g.group)}</span>
          <span class="trend-expire${expired ? ' expired' : ''}">${expired ? '已过期，不再注入' : `有效至 ${exp}`}</span>
        </div>
        <div class="trend-words">${g.words.map((w) => `<span class="trend-word">#${escapeHtml(w)}</span>`).join('')}</div>
      </div>`;
    })
    .join('');
}

async function doParseTrending() {
  const text = $('#trendingText').value.trim();
  const hint = $('#trendingHint');
  if (!text) return (hint.textContent = '请先粘贴热榜原文');
  const btn = $('#btnParseTrending');
  btn.disabled = true;
  btn.textContent = '提炼中…';
  hint.textContent = '';
  try {
    const res = await fetch('/api/parse-trending', {
      method: 'POST',
      headers: llmHeaders(),
      body: JSON.stringify({ text, ttlDays: Number($('#trendingTtl').value) || 7 }),
    });
    if (handleUnauthorized(res)) return;
    const j = await res.json();
    if (!j.ok) return (hint.textContent = j.message || j.error || '提炼失败');
    if (j.hotwords) {
      $('#hotwordsBox').value = hotwordsToText(j.hotwords);
      renderTrending(j.hotwords);
    }
    const n = (j.groups || []).reduce((s, g) => s + g.words.length, 0);
    hint.textContent = `已入库 ${j.groups.length} 组 ${n} 个热词（${j.mode === 'llm' ? '模型提炼' : '规则提炼'}）`;
    $('#trendingText').value = '';
    toast(`热榜已入库，${$('#trendingTtl').value} 天内自动注入生成`);
  } catch (err) {
    hint.textContent = '提炼失败：' + (err.message || '网络错误');
  } finally {
    btn.disabled = false;
    btn.textContent = '提炼热榜入库';
  }
}

async function clearTrending() {
  if (!confirm('确定清空全部热榜词？手动维护的热词库不受影响。')) return;
  try {
    const res = await fetch('/api/hotwords', {
      method: 'POST',
      headers: llmHeaders(),
      body: JSON.stringify({ action: 'clearTrending' }),
    });
    if (handleUnauthorized(res)) return;
    const hw = await res.json();
    renderTrending(hw);
    $('#trendingHint').textContent = '热榜已清空';
    toast('热榜已清空');
  } catch (err) {
    $('#trendingHint').textContent = '清空失败：' + err.message;
  }
}

async function saveHotwords(reset) {
  const hint = $('#hotwordsHint');
  const payload = reset ? { tags: null } : textToHotwords($('#hotwordsBox').value);
  if (!reset && !Object.keys(payload.tags).length) return (hint.textContent = '格式不正确，请按「组名: 词1 词2」填写');
  hint.textContent = '保存中…';
  try {
    const res = await fetch('/api/hotwords', {
      method: 'POST',
      headers: llmHeaders(),
      body: JSON.stringify(payload),
    });
    if (handleUnauthorized(res)) return;
    const hw = await res.json();
    $('#hotwordsBox').value = hotwordsToText(hw);
    renderTrending(hw);
    hint.textContent = '已保存 · ' + (hw.note || '');
    toast(reset ? '已恢复默认热词' : '热词库已保存');
  } catch (err) {
    hint.textContent = '保存失败：' + err.message;
  }
}

function renderSamples(items) {
  const box = $('#sampleList');
  if (!items.length) {
    box.innerHTML = '<div class="hint">样本库为空，添加后会用于结构参考。</div>';
    return;
  }
  box.innerHTML = items
    .map(
      (s) => `<div class="sample-item">
        <div class="sample-head">
          <span class="hist-tag">${SCENE_LABEL[s.scene] || s.scene}</span>
          ${s.category ? `<span class="hist-tag">${escapeHtml(s.category)}</span>` : ''}
          <button class="hist-del" data-del-sample="${s.id}" type="button">×</button>
        </div>
        ${s.note ? `<p class="sample-note">${escapeHtml(s.note)}</p>` : ''}
        <p class="sample-body">${escapeHtml(String(s.text || '').replace(/\s+/g, ' ').slice(0, 80))}…</p>
      </div>`
    )
    .join('');
}

async function loadSamples() {
  try {
    const res = await fetch('/api/samples', { headers: llmHeaders() });
    if (handleUnauthorized(res)) return;
    const j = await res.json();
    renderSamples(j.items || []);
  } catch {
    $('#samplesHint').textContent = '读取失败，检查服务是否运行';
  }
}

async function addSample() {
  const text = $('#sampleText').value.trim();
  const hint = $('#samplesHint');
  if (!text) return (hint.textContent = '请填写样本正文');
  const item = {
    scene: ($('.seg[data-field="sampleScene"] button.on') || {}).dataset?.val || 'talk',
    category: $('#sampleCategory').value.trim(),
    tone: '',
    note: $('#sampleNote').value.trim(),
    text,
  };
  hint.textContent = '添加中…';
  try {
    const res = await fetch('/api/samples', {
      method: 'POST',
      headers: llmHeaders(),
      body: JSON.stringify({ item }),
    });
    if (handleUnauthorized(res)) return;
    const j = await res.json();
    renderSamples(j.items || []);
    $('#sampleText').value = '';
    $('#sampleNote').value = '';
    hint.textContent = '已添加';
    toast('样本已添加');
  } catch (err) {
    hint.textContent = '添加失败：' + err.message;
  }
}

async function deleteSample(id) {
  try {
    const res = await fetch('/api/samples', {
      method: 'POST',
      headers: llmHeaders(),
      body: JSON.stringify({ action: 'delete', id }),
    });
    if (handleUnauthorized(res)) return;
    const j = await res.json();
    renderSamples(j.items || []);
    toast('已删除');
  } catch {}
}

/* ========== 访问口令 ========== */
async function saveToken() {
  const token = $('#tokenInput').value.trim();
  if (token && token.length < 4) return toast('口令至少 4 位');
  try {
    const res = await fetch('/api/access', {
      method: 'POST',
      headers: llmHeaders(),
      body: JSON.stringify({ token }),
    });
    const j = await res.json();
    if (!res.ok || j.error) return toast(j.error || '保存失败');
    save(LS.token, token);
    $('#tokenHint').textContent = j.authRequired ? '已启用：接口需带口令访问。' : '未启用：接口无需口令。';
    toast(token ? '口令已启用' : '已关闭口令');
    refreshModeBadge();
  } catch (err) {
    toast('保存失败：' + err.message);
  }
}

async function checkToken() {
  save(LS.token, $('#tokenInput').value.trim());
  try {
    const res = await fetch('/api/auth-check', { method: 'POST', headers: llmHeaders(), body: '{}' });
    const j = await res.json();
    $('#tokenHint').textContent = j.ok ? '校验通过：当前口令可用。' : '校验未通过：' + (j.message || '口令不正确');
    toast(j.ok ? '口令有效' : '口令无效');
  } catch (err) {
    $('#tokenHint').textContent = '校验失败：' + err.message;
  }
}

async function doBackup() {
  const el = $('#backupResult');
  el.className = 'hint';
  el.textContent = '备份中…';
  try {
    const res = await fetch('/api/backup', { method: 'POST', headers: llmHeaders(), body: '{}' });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
    el.className = 'hint ok';
    el.textContent = `备份成功：${j.file}（自动保留最近 10 份）`;
  } catch (err) {
    el.className = 'hint err';
    el.textContent = '备份失败：' + err.message;
  }
}

function downloadBackup() {
  // 携带口令（如果启用）以通过鉴权
  const token = load(LS.token, '');
  const url = token ? `/api/backup?token=${encodeURIComponent(token)}` : '/api/backup';
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('开始下载备份');
}

/* ========== 配置 ========== */
function loadCfgFields() {
  const cfg = load(LS.llm, {});
  $('#cfgKey').value = cfg.key || '';
  $('#cfgBase').value = cfg.base || '';
  $('#cfgModel').value = cfg.model || '';
  $('#tokenInput').value = load(LS.token, '');
}

async function refreshModeBadge() {
  try {
    const res = await fetch('/api/config', { headers: llmHeaders() });
    const cfg = await res.json();
    const badge = $('#modeBadge');
    if (cfg.configured) {
      badge.textContent = '大模型已接入';
      badge.classList.add('live');
      $('#brandStatus').textContent = `在线生成 · ${cfg.model || ''}`;
    } else {
      badge.textContent = '演示模式';
      badge.classList.remove('live');
      $('#brandStatus').textContent = '未配置 Key · 模板体验模式';
    }
    $('#tokenHint').textContent = cfg.authRequired
      ? '已启用：接口需带口令访问。'
      : '未启用：接口无需口令。可在下方设置。';
    if (cfg.demo && !$('#cfgResult').textContent) $('#cfgResult').textContent = cfg.demoNote || '';
  } catch {
    $('#brandStatus').textContent = '服务未连接';
  }
}

/* ========== Tab 切换 ========== */
function goTab(view) {
  $$('.tab').forEach((t) => t.classList.toggle('on', t.dataset.view === view));
  $$('.scroll').forEach((v) => v.classList.add('hidden'));
  $('#view-' + view).classList.remove('hidden');
  if (view === 'history') renderHistory();
  if (view === 'analysis') loadAnalysis();
  if (view === 'settings') {
    loadHotwords();
    loadSamples();
  }
}

/* ========== 初始化 ========== */
function bindSegments() {
  $$('.chips[data-field]').forEach((box) => {
    box.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const wasOn = chip.classList.contains('on');
      $$('.chip', box).forEach((c) => c.classList.remove('on'));
      if (!wasOn) chip.classList.add('on');
      persistFormDebounced();
    });
  });

  $$('.seg[data-field]').forEach((box) => {
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const field = box.dataset.field;
      $$('button', box).forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      if (field === 'scene') setScene(btn.dataset.val);
      persistFormDebounced();
    });
  });

  $$('#sheetSeg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.editing = false;
      $('#btnEdit').textContent = '编辑';
      state.activeScene = btn.dataset.val;
      syncSheetSeg();
      renderResult();
      refreshButtons();
    });
  });
}

let persistTimer = null;
function persistFormDebounced() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => save(LS.form, collectForm()), 400);
}

function bindTabs() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => goTab(tab.dataset.view)));
}

/* ========== SW 更新提示 ========== */
let swReloading = false;
function setupSwUpdate() {
  navigator.serviceWorker
    .register('/sw.js')
    .then((reg) => {
      // 已有等待中的新 SW（上次更新后未刷新）直接提示
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateBar(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar(nw);
        });
      });
      reg.update().catch(() => {});
    })
    .catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!swReloading) return; // 仅本页面点击刷新后才跟随重载
    location.reload();
  });
}

function showUpdateBar(worker) {
  const bar = $('#updateBar');
  if (!bar || !bar.classList.contains('hidden')) return;
  bar.classList.remove('hidden');
  bar.addEventListener('click', () => {
    bar.textContent = '正在更新…';
    swReloading = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
    // 兜底：若新 SW 已是激活态（不会触发 controllerchange），1.5s 后直接刷新
    setTimeout(() => location.reload(), 1500);
  });
}

function init() {
  state.cloudSync = Boolean(load(LS.cloudsync, false));
  $('#cloudSync').checked = state.cloudSync;

  const saved = load(LS.form, null);
  if (saved) applyForm(saved);
  loadCfgFields();

  setSeg('duration', collectForm().duration || '30');
  setSeg('count', collectForm().count || 1);
  state.scene = ($('.seg[data-field="scene"] button.on') || {}).dataset?.val || 'talk';
  syncSheetSeg();
  syncCountField();
  $('#btnGenerateCurrent').textContent = '生成' + SCENE_LABEL[state.scene];
  $('#sceneHint').textContent = SCENE_HINT[state.scene] || '';

  bindSegments();
  bindTabs();

  ['#productName', '#audience', '#price', '#usageScene', '#sellingPoints', '#extra', '#persona'].forEach((sel) =>
    $(sel).addEventListener('input', persistFormDebounced)
  );

  $('#btnGenerateCurrent').addEventListener('click', () => generate(state.scene));
  $('#btnGenerateAll').addEventListener('click', () => {
    const form = collectForm();
    state.sheetForm = form;
    state.results = {};
    state.compliance = {};
    state.session = null;
    SCENES.forEach((s) => generate(s, form));
    state.activeScene = 'talk';
    syncSheetSeg();
    renderResult();
  });

  $('#btnSheetClose').addEventListener('click', closeSheet);
  $('#btnRegen').addEventListener('click', () => {
    const form = state.sheetForm || collectForm();
    state.results[state.activeScene] = '';
    state.busy[state.activeScene] = false;
    generate(state.activeScene, form);
  });
  $('#btnAddVariant').addEventListener('click', addVariant);
  $('#btnSheetCopy').addEventListener('click', () => {
    const t = state.results[state.activeScene] || '';
    if (!t.trim()) return toast('还没有内容可复制');
    copyText(t, `已复制${SCENE_LABEL[state.activeScene]}`);
  });
  $('#btnCopyAll').addEventListener('click', () => {
    const parts = SCENES.filter((s) => state.results[s]?.trim()).map(
      (s) => `【${SCENE_LABEL[s]}】\n${state.results[s].trim()}`
    );
    if (!parts.length) return toast('还没有内容可复制');
    copyText(parts.join('\n\n' + '─'.repeat(20) + '\n\n'), '已复制全部文案');
  });

  // 结果区交互（重写 / 复制单版本）
  $('#resultBody').addEventListener('click', (e) => {
    const rwBtn = e.target.closest('[data-rw]');
    if (rwBtn) return openRewrite(Number(rwBtn.dataset.rw));
    const cpBtn = e.target.closest('[data-copy]');
    if (cpBtn) {
      const blocks = cleanBlocks(state.results[state.activeScene] || '');
      const item = blocks[Number(cpBtn.dataset.copy)];
      if (item) copyText(item.raw, '已复制该版本');
    }
  });

  $('#btnEdit').addEventListener('click', toggleEdit);
  $('#btnExport').addEventListener('click', exportMarkdown);
  $('#btnCheck').addEventListener('click', async () => {
    const text = state.results[state.activeScene] || '';
    if (!text.trim()) return toast('还没有内容可检查');
    toast('正在检查…');
    const r = await scanRemote(text);
    if (r) {
      state.compliance[state.activeScene] = r;
      renderResult();
      $('.cmp-list', $('#complianceBar'))?.classList.remove('hidden');
    } else toast('检查失败');
  });

  // 重写浮层
  $('#btnRwClose').addEventListener('click', closeRewrite);
  $('#btnRwCancel').addEventListener('click', closeRewrite);
  $('#btnRwStart').addEventListener('click', startRewrite);
  $('#btnRwApply').addEventListener('click', applyRewrite);
  $('#rwMask').addEventListener('click', (e) => {
    if (e.target === $('#rwMask')) closeRewrite();
  });

  // 快速填充
  $('#btnExtract').addEventListener('click', doExtract);
  $('#btnVision').addEventListener('click', doVision);
  $('#btnParseText').addEventListener('click', doParseText);
  $('#btnOpImport').addEventListener('click', openOpImport);
  $('#btnOpClose').addEventListener('click', () => $('#opMask').classList.add('hidden'));
  $('#opMask').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) $('#opMask').classList.add('hidden');
    const item = e.target.closest('.op-item');
    if (item) opImportOne(item.dataset.pid);
  });
  $('#pasteText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      doParseText();
    }
  });
  $('#productImage').addEventListener('change', () => {
    const f = $('#productImage').files?.[0];
    if (f) fillHint(`已选择：${f.name}（${Math.round(f.size / 1024)}KB），点「识图」开始识别`);
  });

  // 历史
  $('#historyList').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      const id = del.dataset.del;
      const list = localHistory().filter((x) => x.id !== id);
      save(LS.history, list);
      if (isCloud()) {
        fetch('/api/history', { method: 'POST', headers: llmHeaders(), body: JSON.stringify({ action: 'delete', id }) }).catch(() => {});
      }
      renderHistory();
      toast('已删除');
      return;
    }
    const msave = e.target.closest('[data-msave]');
    if (msave) {
      saveMetrics(msave.dataset.msave);
      return;
    }
    const mbtn = e.target.closest('[data-metrics]');
    if (mbtn) {
      state.metricsOpen = state.metricsOpen === mbtn.dataset.metrics ? null : mbtn.dataset.metrics;
      renderHistory();
      return;
    }
    if (e.target.closest('.m-panel')) return; // 面板内的输入点击不打开记录
    const item = e.target.closest('.hist-item');
    if (item) openHistoryItem(item.dataset.id);
  });
  $('#btnClearHistory').addEventListener('click', async () => {
    if (!localHistory().length && !isCloud()) return toast('暂无记录');
    save(LS.history, []);
    if (isCloud()) {
      await fetch('/api/history', { method: 'POST', headers: llmHeaders(), body: JSON.stringify({ action: 'clear' }) }).catch(() => {});
    }
    renderHistory();
    toast('已清空历史');
  });
  $('#btnHistoryRefresh').addEventListener('click', () => renderHistory());
  $('#btnAbRefresh').addEventListener('click', () => loadAnalysis());
  $('#cloudSync').addEventListener('change', (e) => {
    state.cloudSync = e.target.checked;
    save(LS.cloudsync, state.cloudSync);
    toast(state.cloudSync ? '已开启云同步' : '已关闭云同步（仅本机）');
    renderHistory();
  });

  // 设置
  $('#modeBadge').addEventListener('click', () => goTab('settings'));
  $('#btnSaveCfg').addEventListener('click', () => {
    save(LS.llm, { key: $('#cfgKey').value.trim(), base: $('#cfgBase').value.trim(), model: $('#cfgModel').value.trim() });
    refreshModeBadge();
    toast('配置已保存');
  });
  $('#btnTestCfg').addEventListener('click', async () => {
    const el = $('#cfgResult');
    el.className = 'hint';
    el.textContent = '测试中…';
    save(LS.llm, { key: $('#cfgKey').value.trim(), base: $('#cfgBase').value.trim(), model: $('#cfgModel').value.trim() });
    try {
      const res = await fetch('/api/test', { method: 'POST', headers: llmHeaders(), body: '{}' });
      const j = await res.json();
      el.className = 'hint ' + (j.ok ? 'ok' : 'err');
      el.textContent = j.message + (j.sample ? `（返回：${j.sample}）` : '');
      refreshModeBadge();
    } catch (err) {
      el.className = 'hint err';
      el.textContent = '测试失败：' + err.message;
    }
  });

  $('#btnSaveToken').addEventListener('click', saveToken);
  $('#btnCheckToken').addEventListener('click', checkToken);
  $('#btnBackup').addEventListener('click', doBackup);
  $('#btnDownloadBackup').addEventListener('click', downloadBackup);
  $('#btnSaveHotwords').addEventListener('click', () => saveHotwords(false));
  $('#btnResetHotwords').addEventListener('click', () => saveHotwords(true));
  $('#btnParseTrending').addEventListener('click', doParseTrending);
  $('#btnClearTrending').addEventListener('click', clearTrending);
  $('#sampleList').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del-sample]');
    if (del) deleteSample(del.dataset.delSample);
  });
  $('#btnAddSample').addEventListener('click', addSample);

  renderHistory();
  syncMetricsToCloud().then(() => renderHistory());
  refreshModeBadge();

  if ('serviceWorker' in navigator) setupSwUpdate();
}

document.addEventListener('DOMContentLoaded', init);
