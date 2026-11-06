'use strict';

/* ============================================================
 * brace-map selftest · 导出 SVG：克隆行内样式、链接降级、文件名、背景色
 * ============================================================ */

const { I, ok, eq, finite, clean, suite } = require('./framework');
const { FONT, fakeEl, fakeView } = require('./helpers');

/* ---------------------- v0.5.0 新增：导出 SVG / PNG ---------------------- */

function sampleSvg() {
  const view = fakeView();
  const svg = fakeEl('svg', {
    fill: 'rgb(1, 2, 3)',
    'font-family': 'Inter',
    'font-size': '19.95px',
  }, view);
  svg.setAttribute('width', '240');
  svg.setAttribute('height', '120');
  svg.setAttribute('viewBox', '0 0 240 120');

  const text = fakeEl('text', {
    fill: 'rgb(9, 9, 9)',
    'font-family': 'Inter, sans-serif',
    'font-size': '19.95px',
    'font-weight': '600',
  }, view);
  svg.appendChild(text);

  const pathEl = fakeEl('path', {
    fill: 'none',
    stroke: 'rgb(4, 5, 6)',
    'stroke-width': '1.5',
  }, view);
  svg.appendChild(pathEl);

  const bare = fakeEl('g', {}, view);   // 没有任何 computed 值，不应写入任何属性
  svg.appendChild(bare);
  return svg;
}

/** 导出路径上的 DOM 全局桩，只在一次调用内部有效 */
function withExportGlobals(fn) {
  const savedDoc = global.document;
  const savedBlob = global.Blob;
  const savedURL = global.URL;
  const box = { blobs: [], anchors: [] };
  try {
    global.document = {
      body: { appendChild() {} },
      createElement(tag) {
        const a = {
          tagName: tag, href: '', download: '', clicks: 0,
          click() { a.clicks++; },
          remove() {},
        };
        box.anchors.push(a);
        return a;
      },
    };
    global.Blob = class FakeBlob {
      constructor(parts, opts) {
        this.parts = (parts || []).map((p) => String(p));
        this.type = (opts && opts.type) || '';
        this.size = this.parts.join('').length;
      }
      textSync() { return this.parts.join(''); }
    };
    global.URL = {
      createObjectURL(b) { box.blobs.push(b); return 'blob:test-' + box.blobs.length; },
      revokeObjectURL() {},
    };
    fn(box);
  } finally {
    global.document = savedDoc;
    global.Blob = savedBlob;
    global.URL = savedURL;
  }
  return box;
}

function tInlineClone() {
  const svg = sampleSvg();
  const clone = I.cloneWithInlineStyles(svg);

  ok(clone !== svg, 'inline: 返回的是 clone，不是原元素');
  eq(clone.querySelectorAll('*').length, svg.querySelectorAll('*').length, 'inline: 元素数量一致');
  eq(clone.children.length, 3, 'inline: 子元素数量一致');

  eq(clone.style.getPropertyValue('fill'), 'rgb(1, 2, 3)', 'inline: 根元素 fill');
  eq(clone.style.getPropertyValue('font-family'), 'Inter', 'inline: 根元素 font-family');
  eq(clone.style.getPropertyValue('font-size'), '19.95px', 'inline: 根元素 font-size');

  const t = clone.children[0];
  eq(t.style.getPropertyValue('fill'), 'rgb(9, 9, 9)', 'inline: text fill');
  eq(t.style.getPropertyValue('font-family'), 'Inter, sans-serif', 'inline: text font-family');
  eq(t.style.getPropertyValue('font-size'), '19.95px', 'inline: text font-size');
  eq(t.style.getPropertyValue('font-weight'), '600', 'inline: text font-weight');

  const p = clone.children[1];
  eq(p.style.getPropertyValue('stroke'), 'rgb(4, 5, 6)', 'inline: path stroke');
  eq(p.style.getPropertyValue('stroke-width'), '1.5', 'inline: path stroke-width');

  // 索引对齐：每个位置的属性只能来自同一个位置
  eq(t.style.getPropertyValue('stroke'), '', 'inline: 索引不错位（text 不该拿到 path 的 stroke）');
  eq(p.style.getPropertyValue('fill'), 'none', 'inline: 索引不错位（path 拿到的是自己的 fill: none）');

  eq(clone.children[2].style.size, 0, 'inline: 没有 computed 值的元素不写行内样式');

  // 原元素不被污染，几何属性照旧
  eq(svg.style.getPropertyValue('fill'), '', 'inline: 不修改原元素');
  eq(svg.children[0].style.getPropertyValue('fill'), '', 'inline: 不修改原元素的子节点');
  eq(clone.getAttribute('width'), '240', 'inline: 几何属性随 clone 带过去');
  eq(clone.getAttribute('viewBox'), '0 0 240 120', 'inline: viewBox 随 clone 带过去');
  eq(clone.getAttribute('xmlns'), null, 'inline: 命名空间由导出方加，clone 本身不带');

  // 没有 computed style 来源时也不该炸
  const orphan = fakeEl('svg', { fill: 'rgb(7, 7, 7)' }, null);
  let threw = null;
  let orphanClone = null;
  try { orphanClone = I.cloneWithInlineStyles(orphan); } catch (err) { threw = err; }
  ok(!threw, 'inline: 取不到 computed style 不抛错', threw && threw.message);
  ok(orphanClone && orphanClone.style.size === 0, 'inline: 取不到 computed style 就不写样式');
}

function tExportSvgKeepsShape() {
  const svg = sampleSvg();
  const box = withExportGlobals(() => {
    I.exportSvg(svg, 'a/b:c');
  });

  eq(box.blobs.length, 1, 'svg: 只生成一个 blob');
  const blob = box.blobs[0];
  eq(blob.type, 'image/svg+xml;charset=utf-8', 'svg: blob MIME 不变');

  const text = blob.textSync();
  ok(text.indexOf('<?xml version="1.0" encoding="UTF-8"?>\n') === 0, 'svg: XML 声明仍是第一行', text.slice(0, 40));
  ok(text.indexOf('xmlns="http://www.w3.org/2000/svg"') >= 0, 'svg: 写到 xmlns');
  ok(text.indexOf('xmlns:xlink="http://www.w3.org/1999/xlink"') >= 0, 'svg: 写到 xmlns:xlink');
  ok(text.indexOf('style="') > 0, 'svg: 行内样式写进了序列化结果');

  eq((text.match(/<text/g) || []).length, 1, 'svg: 序列化后的 text 数与原图一致');
  eq((text.match(/<path/g) || []).length, 1, 'svg: 序列化后的 path 数与原图一致');
  eq((text.match(/<svg/g) || []).length, 1, 'svg: 只有一个根元素');

  eq(box.anchors.length, 1, 'svg: 只触发一次下载');
  eq(box.anchors[0].tagName, 'a', 'svg: 用 <a download> 触发');
  eq(box.anchors[0].download, 'a_b_c.svg', 'svg: 文件名仍按旧规则清洗并加 .svg');
  eq(box.anchors[0].clicks, 1, 'svg: 只点一次');
}

function tExportName() {
  const d = new Date(2026, 10, 5, 18, 30, 0);   // 月份从 0 起
  eq(I.exportFileName('括号图', 'png', d), '括号图-20261105-1830.png', 'name: 标题 + 时间戳');
  eq(I.exportFileName('', 'png', d), '括号图-20261105-1830.png', 'name: 空标题回落到 括号图');
  eq(I.exportFileName(null, 'png', d), '括号图-20261105-1830.png', 'name: null 标题回落');
  eq(I.exportFileName('  ', 'png', d), '括号图-20261105-1830.png', 'name: 纯空白标题回落');

  const got = I.exportFileName('a/b\\c:d*e?f"g<h>i|j', 'png', d);
  ok(!/[\\/:*?"<>|]/.test(got), 'name: 不含 Windows 禁用字符', got);
  eq(got, 'a_b_c_d_e_f_g_h_i_j-20261105-1830.png', 'name: 每个禁用字符换成下划线');

  const dotted = I.exportFileName('结论. ', 'png', d);
  eq(dotted, '结论-20261105-1830.png', 'name: 去掉结尾的点与空格', dotted);

  const long = I.exportFileName('字'.repeat(200), 'png', d);
  ok(long.length <= 80 + 1 + 13 + 4, 'name: 超长标题被截断', String(long.length));
  ok(/\.png$/.test(long), 'name: 扩展名始终是 .png', long.slice(-8));
}

function tExportBg() {
  eq(I.colorAlpha('rgba(0, 0, 0, 0)'), 0, 'alpha: rgba 全透明是 0');
  eq(I.colorAlpha('transparent'), 0, 'alpha: transparent 是 0');
  eq(I.colorAlpha(''), 0, 'alpha: 空串按透明');
  eq(I.colorAlpha(null), 0, 'alpha: null 按透明');
  eq(I.colorAlpha('rgb(255, 255, 255)'), 1, 'alpha: rgb 视为不透明');
  eq(I.colorAlpha('rgb(0, 0, 0)'), 1, 'alpha: 三通道无 alpha 视为 1');
  eq(I.colorAlpha('#fff'), 1, 'alpha: #rgb');
  eq(I.colorAlpha('#ffffff'), 1, 'alpha: #rrggbb');
  eq(I.colorAlpha('#ffffff00'), 0, 'alpha: #rrggbbaa 全透明');
  eq(I.colorAlpha('#fff0'), 0, 'alpha: #rgba 全透明');
  ok(Math.abs(I.colorAlpha('rgba(30, 30, 30, 0.6)') - 0.6) < 1e-9, 'alpha: rgba 小数', String(I.colorAlpha('rgba(30, 30, 30, 0.6)')));
  ok(Math.abs(I.colorAlpha('rgb(0 0 0 / 0.5)') - 0.5) < 1e-9, 'alpha: 斜杠语法');
  ok(Math.abs(I.colorAlpha('rgb(0 0 0 / 50%)') - 0.5) < 1e-9, 'alpha: 百分比 alpha');
  ok(I.colorAlpha('rgba(0, 0, 0, 0)') <= 0, 'alpha: 判定口径 —— alpha > 0 才算有背景');

  const view = fakeView();
  const grand = fakeEl('div', { 'background-color': 'rgb(250, 250, 250)' }, view);
  const mid = fakeEl('div', { 'background-color': 'rgba(0, 0, 0, 0)' }, view);
  const svg = fakeEl('svg', { 'background-color': 'rgba(0, 0, 0, 0)' }, view);
  grand.appendChild(mid);
  mid.appendChild(svg);
  eq(I.pickExportBg(svg), 'rgb(250, 250, 250)', 'bg: 跳过全透明的祖先，取第一个不透明色');

  const semi = fakeEl('div', { 'background-color': 'rgba(0, 0, 0, 0.4)' }, view);
  const svg2 = fakeEl('svg', { 'background-color': 'transparent' }, view);
  semi.appendChild(svg2);
  eq(I.pickExportBg(svg2), 'rgba(0, 0, 0, 0.4)', 'bg: alpha > 0 就算有背景');

  const allClear = fakeEl('svg', { 'background-color': 'transparent' }, view);
  eq(I.pickExportBg(allClear), '#ffffff', 'bg: 一路透明就回落到白色');
  eq(I.pickExportBg({}), '#ffffff', 'bg: 没有 computed style 也回落到白色');
}

function tExportInline() {
  tInlineClone();
  tExportSvgKeepsShape();
  tExportName();
  tExportBg();
}

suite('export-inline', tExportInline);
