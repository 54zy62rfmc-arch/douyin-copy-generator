/**
 * Markdown 轻量渲染 + 结构切分
 * 同时供浏览器（window.DV）与 Node 单测（module.exports）使用。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DV = Object.assign(root.DV || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function inline(s) {
    return escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  }

  function splitRow(line) {
    return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  }

  /** 渲染 Markdown 为 HTML；streaming=true 时在末尾追加光标 */
  function mdToHtml(src, streaming) {
    const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let para = [];
    let i = 0;
    const flush = () => {
      if (para.length) {
        out.push('<p>' + para.join('<br>') + '</p>');
        para = [];
      }
    };

    while (i < lines.length) {
      const line = lines[i].trim();

      if (!line) { flush(); i++; continue; }

      // 代码块
      if (line.startsWith('```')) {
        flush();
        const code = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith('```')) { code.push(lines[i]); i++; }
        i++;
        out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
        continue;
      }

      // 表格
      if (/^\|.*\|$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
        flush();
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { rows.push(splitRow(lines[i])); i++; }
        out.push(
          '<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table>'
        );
        continue;
      }

      // 标题
      const h = line.match(/^(#{1,6})\s*(.+)$/);
      if (h) {
        flush();
        const lvl = h[1].length;
        const tag = lvl <= 2 ? 'h2' : 'h3';
        out.push(`<${tag}>${inline(h[2])}</${tag}>`);
        i++;
        continue;
      }

      // 分割线
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }

      // 引用
      if (/^>\s?/.test(line)) {
        flush();
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
          buf.push(inline(lines[i].trim().replace(/^>\s?/, '')));
          i++;
        }
        out.push('<blockquote>' + buf.join('<br>') + '</blockquote>');
        continue;
      }

      // 无序列表
      if (/^[-*+]\s+/.test(line)) {
        flush();
        const items = [];
        while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
          items.push(inline(lines[i].trim().replace(/^[-*+]\s+/, '')));
          i++;
        }
        out.push('<ul>' + items.map((t) => `<li>${t}</li>`).join('') + '</ul>');
        continue;
      }

      // 有序列表
      if (/^\d+[.)]\s+/.test(line)) {
        flush();
        const items = [];
        while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
          items.push(inline(lines[i].trim().replace(/^\d+[.)]\s+/, '')));
          i++;
        }
        out.push('<ol>' + items.map((t) => `<li>${t}</li>`).join('') + '</ol>');
        continue;
      }

      para.push(inline(line));
      i++;
    }
    flush();
    return out.join('') + (streaming ? '<span class="cursor"></span>' : '');
  }

  /**
   * 按二级标题切分为模块，用于"局部重写"
   * @returns {Array<{title:string, body:string, raw:string}>}
   */
  function splitSections(md) {
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    const sections = [];
    let cur = null;
    const pre = [];

    for (const line of lines) {
      const m = line.match(/^##\s+(.+)$/);
      if (m) {
        if (cur) sections.push(cur);
        cur = { title: m[1].trim(), body: [], raw: line };
      } else if (cur) {
        cur.body.push(line);
        cur.raw += '\n' + line;
      } else {
        pre.push(line);
      }
    }
    if (cur) sections.push(cur);

    const result = sections.map((s) => ({
      title: s.title,
      body: s.body.join('\n').trim(),
      raw: s.raw.trimEnd(),
    }));
    const preText = pre.join('\n').trim();
    if (preText) result.unshift({ title: '', body: preText, raw: preText, preamble: true });
    return result;
  }

  /** 按三级标题切分变体，用于批量变体卡片 */
  function splitVariants(md) {
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    const items = [];
    let cur = null;
    for (const line of lines) {
      const m = line.match(/^###\s+(.+)$/);
      if (m) {
        if (cur) items.push(cur);
        const title = m[1].trim();
        const angle = title.split(/[·・|]/).slice(1).join('·').trim();
        cur = { title, angle, body: [], raw: line };
      } else if (cur) {
        cur.body.push(line);
        cur.raw += '\n' + line;
      }
    }
    if (cur) items.push(cur);
    return items.map((it) => ({ title: it.title, angle: it.angle, body: it.body.join('\n').trim(), raw: it.raw.trimEnd() }));
  }

  return { mdToHtml, splitSections, splitVariants, escapeHtml };
});
