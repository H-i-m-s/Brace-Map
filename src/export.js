'use strict';

/* 导出：SVG / PNG，以及导出时的链接降级 */

// 不要 require('obsidian')：src/ 下的文件是被标准 Node require 加载的，
// 那个上下文解析不到 Obsidian 临时注入的模块名（只对 main.js 那一层有效）。
// Notice 在 Obsidian 里挂在 window 上，直接取全局的；拿不到就不弹。
const { NS } = require('./opt');

function getNotice() {
  try {
    if (typeof window !== 'undefined' && typeof window.Notice === 'function') return window.Notice;
  } catch (e) { /* 继续 */ }
  try {
    if (typeof Notice === 'function') return Notice;
  } catch (e) { /* 继续 */ }
  return null;
}

/* ============================================================
 * 导出：SVG / PNG
 *
 * 页面上的样式来自 styles.css 的 CSS 规则（.brace-map-svg text { fill: var(--bm-fg) }），
 * 序列化后脱离文档就全丢了，所以两个导出都得先把 computed style 写成属性。
 * ============================================================ */

/** 逐元素抄下来的属性。几何、class 已经在标记里，不用抄 */
const EXPORT_STYLE_PROPS = [
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'font-family', 'font-size', 'font-weight', 'font-style', 'opacity',
  // color：公式的矢量里用 currentColor，导出后脱离样式表就靠这层 color 继承
  'color',
];

/** 取 computed style；没有全局 getComputedStyle 时退到元素所属文档的视图 */
function computedStyleOf(el) {
  if (!el) return null;
  if (typeof getComputedStyle === 'function') return getComputedStyle(el);
  const view = el.ownerDocument && el.ownerDocument.defaultView;
  if (view && typeof view.getComputedStyle === 'function') return view.getComputedStyle(el);
  return null;
}

/**
 * clone + 逐元素写 computed style，返回自包含的 clone。
 * live / copy 靠 querySelectorAll('*') 的索引一一对应，所以这里只做深拷贝、
 * 不增删节点，clone 必须与 svg 完全同形。
 */
function cloneWithInlineStyles(svg) {
  const clone = svg.cloneNode(true);
  const live = [svg, ...svg.querySelectorAll('*')];
  const copy = [clone, ...clone.querySelectorAll('*')];

  live.forEach((a, i) => {
    const b = copy[i];
    if (!b) return;
    const cs = computedStyleOf(a);
    if (!cs) return;
    for (const p of EXPORT_STYLE_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v) b.style.setProperty(p, v);
    }
  });

  return clone;
}

/** 触发一次浏览器下载 */
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 取正文色：图里第一个 <text> 的 computed fill（CSS 里是 var(--bm-fg)），拿不到返回空串 */
function bodyFillOf(svg) {
  if (!svg || typeof svg.querySelectorAll !== 'function') return '';
  const texts = svg.querySelectorAll('text');
  const cs = computedStyleOf((texts && texts[0]) || svg);
  const v = cs && cs.getPropertyValue ? cs.getPropertyValue('fill') : '';
  return v ? String(v) : '';
}

/** 从 class 属性里摘掉一个类名（不依赖 classList，假 DOM 也能跑） */
function dropClass(el, name) {
  if (!el || typeof el.getAttribute !== 'function') return;
  const cur = el.getAttribute('class');
  if (!cur) return;
  const rest = String(cur).split(/\s+/).filter((c) => c && c !== name);
  if (rest.length) el.setAttribute('class', rest.join(' '));
  else if (typeof el.removeAttribute === 'function') el.removeAttribute('class');
}

/**
 * 导出降级：导出的文件里链接不可点，一律当纯文字。
 * 抹掉 data-href 与 bm-link 类，清掉 CSS 给的下划线与 accent 色，
 * 填充色恢复成正文色（--bm-fg 的计算值），否则导出的图里会留一堆
 * 有色带下划线却点不动的字。
 */
function stripLinkMarkers(root, fgColor) {
  if (!root || typeof root.querySelectorAll !== 'function') return root;
  const fill = fgColor || '';
  const hits = root.querySelectorAll('[data-href]');
  for (let i = 0; i < (hits ? hits.length : 0); i++) {
    const el = hits[i];
    // 真实 DOM 里选择器已经筛过一遍；假 DOM 的选择器是空的，这里再确认一次
    if (!el || typeof el.hasAttribute !== 'function' || !el.hasAttribute('data-href')) continue;
    if (typeof el.removeAttribute === 'function') el.removeAttribute('data-href');
    dropClass(el, 'bm-link');
    if (!el.style || typeof el.style.setProperty !== 'function') continue;
    if (fill) el.style.setProperty('fill', fill);
    // 下划线来自 CSS 的 text-decoration，导出后脱离样式表就没人清了
    if (typeof el.style.removeProperty === 'function') {
      el.style.removeProperty('text-decoration');
      el.style.removeProperty('text-decoration-color');
    }
    el.style.setProperty('text-decoration', 'none');
  }
  return root;
}

function exportSvg(svg, fileName) {
  const clone = cloneWithInlineStyles(svg);
  stripLinkMarkers(clone, bodyFillOf(svg));
  clone.setAttribute('xmlns', NS);
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

  const text = '<?xml version="1.0" encoding="UTF-8"?>\n' + clone.outerHTML;
  const blob = new Blob([text], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (String(fileName || 'brace-map').replace(/[\\/:*?"<>|]+/g, '_') || 'brace-map') + '.svg';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ------------------------------------------------------------
 * PNG：自包含 SVG → Image → canvas → toBlob
 * 纯前端、不联网、不加依赖。
 * ------------------------------------------------------------ */

/** 固定 2 倍（不看 devicePixelRatio），保证任何机器导出的分辨率一致 */
const PNG_SCALE = 2;

/** 导出失败只喊一声：控制台 warn 一行，Obsidian 里有 Notice 再补一句 */
function warnExport(message, err) {
  const detail = err ? '：' + (err && err.message ? err.message : String(err)) : '';
  console.warn('[brace-map] ' + message + detail);
  try {
    const N = getNotice();
    if (N) new N('括号图导出失败：' + message);
  } catch (e) {
    /* 没有 Notice 就只留控制台那一行 */
  }
}

/** 百分比 / 小数两种 alpha 写法都认，认不出来返回 null */
function parseAlphaText(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return null;
  const v = t.charAt(t.length - 1) === '%' ? n / 100 : n;
  return Math.max(0, Math.min(1, v));
}

/**
 * 颜色透明度，0~1。认得 rgba/rgb 的两种写法、transparent、#rgb/#rgba/#rrggbb/#rrggbbaa；
 * 认不出来的颜色函数返回 null（调用方按不透明处理）。
 */
function colorAlpha(color) {
  const s = String(color == null ? '' : color).trim().toLowerCase();
  if (!s) return 0;
  if (s === 'transparent') return 0;

  if (s.charAt(0) === '#') {
    const hex = s.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    if (hex.length === 3 || hex.length === 6) return 1;
    if (hex.length === 4) {
      const a = parseInt(hex.charAt(3), 16);
      return Number.isFinite(a) ? a / 15 : null;
    }
    if (hex.length === 8) {
      const a = parseInt(hex.slice(6, 8), 16);
      return Number.isFinite(a) ? a / 255 : null;
    }
    return null;
  }

  const m = s.match(/^rgba?\(([^)]*)\)$/);
  if (!m) return null;
  const body = m[1];
  let alphaText = '';
  const slash = body.indexOf('/');
  if (slash >= 0) {
    alphaText = body.slice(slash + 1);          // rgb(0 0 0 / 0.5)
  } else {
    const parts = body.split(',');
    if (parts.length > 3) alphaText = parts[3]; // rgba(0, 0, 0, 0.5)
  }
  const a = parseAlphaText(alphaText);
  return a == null ? 1 : a;
}

/**
 * PNG 背景色：从 svg 往上找第一个 alpha > 0 的背景色，找到 body 也没有就用白色。
 * 页面上的图是透明底、字色跟主题走，透明 PNG 贴进白底文档里会整片看不见。
 */
function pickExportBg(svg) {
  const body = typeof document !== 'undefined' ? document.body : null;
  let el = svg;
  let guard = 0;
  while (el && guard++ < 64) {
    const cs = computedStyleOf(el);
    const bg = cs && cs.backgroundColor ? String(cs.backgroundColor) : '';
    const a = colorAlpha(bg);
    if (a != null && a > 0) return bg;
    if (el === body) break;
    el = el.parentElement || null;
  }
  return '#ffffff';
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/** 导出文件名：标题清洗 + 时间戳，例 括号图-20261105-1830.png */
function exportFileName(title, ext, date) {
  const d = date instanceof Date ? date : new Date();
  const safe = String(title == null ? '' : title)
    .replace(/[\\/:*?"<>|]+/g, '_')     // Windows 禁用字符
    .replace(/[\r\n\t]+/g, ' ')          // 换行会把下载名搞乱
    .replace(/^[\s.]+|[\s.]+$/g, '')     // Windows 不允许结尾的空格和点
    .slice(0, 80);
  const stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate())
    + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
  return (safe || '括号图') + '-' + stamp + '.' + (ext || 'png');
}

/** svg 的 width / height 属性（画布尺寸的基准，取不到返回 0） */
function svgPixelSize(svg) {
  const w = parseFloat(svg.getAttribute('width'));
  const h = parseFloat(svg.getAttribute('height'));
  return {
    w: Number.isFinite(w) && w > 0 ? w : 0,
    h: Number.isFinite(h) && h > 0 ? h : 0,
  };
}

function exportPng(svg, fileName) {
  let clone;
  try {
    clone = cloneWithInlineStyles(svg);
    stripLinkMarkers(clone, bodyFillOf(svg));
    clone.setAttribute('xmlns', NS);          // 序列化后要能独立解析，命名空间不能少
  } catch (err) {
    warnExport('克隆 SVG 失败', err);
    return;
  }

  const size = svgPixelSize(svg);
  if (!(size.w > 0) || !(size.h > 0)) {
    warnExport('拿不到 SVG 的宽高属性');
    return;
  }

  const w = Math.round(size.w * PNG_SCALE);
  const h = Math.round(size.h * PNG_SCALE);
  const bg = pickExportBg(svg);
  const name = exportFileName(fileName || '括号图', 'png');

  let url = '';
  const release = () => {
    if (!url) return;
    try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
    url = '';
  };

  const img = new Image();
  img.onload = () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas 2d 上下文不可用');
      // 背景铺在画布上，不进 clone：加 rect 会改变导出 SVG 的结果
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((out) => {
        if (!out) {
          warnExport('canvas 转 PNG 返回空');
          return;
        }
        downloadBlob(out, name);
      }, 'image/png');
    } catch (err) {
      warnExport('绘制 PNG 失败', err);
    } finally {
      release();
    }
  };
  img.onerror = () => {
    warnExport('SVG 转 Image 失败');
    release();
  };

  try {
    const text = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([text], { type: 'image/svg+xml;charset=utf-8' });
    url = URL.createObjectURL(blob);
  } catch (err) {
    warnExport('序列化 SVG 失败', err);
    return;
  }
  img.src = url;
}

module.exports = {
  EXPORT_STYLE_PROPS,
  PNG_SCALE,
  computedStyleOf,
  cloneWithInlineStyles,
  downloadBlob,
  exportSvg,
  exportPng,
  parseAlphaText,
  colorAlpha,
  pickExportBg,
  exportFileName,
  svgPixelSize,
  bodyFillOf,
  dropClass,
  stripLinkMarkers,
};
