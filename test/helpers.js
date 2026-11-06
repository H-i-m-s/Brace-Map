'use strict';

/* ============================================================
 * brace-map selftest · 共享 mock 与提取工具
 *
 * 多个 suite 文件都要用的东西放这里：固定测量、布局参数、通用提取工具、
 * 导出用例的假 DOM（link 用例也用到 fakeEl / fakeView）。
 * ============================================================ */

const { I } = require('./framework');

/* ------------------------------ mock ------------------------------ */

// 每个字符固定 10px
const mockMeasure = (text) => String(text).length * 10;

const FONT = 14;
const LINE_H = Math.round(FONT * 1.85);   // 26
const ROW_GAP = Math.round(LINE_H * 0.4); // 10

// 单行节点的文字占位高（不等于行高）：节点高度现在按字高算，见 layout.js。
// 测试显式传 lineH，所以 LINE_H 保持 26；TEXT_H 单独从参数里取。
const TEXT_H = Math.round(FONT * I.OPT.nodeHRatio); // 17

const LAYOUT_OPTS = {
  measure: mockMeasure,
  measureBold: mockMeasure,
  fontSize: FONT,
  lineH: LINE_H,
  rowGap: ROW_GAP,
  // 显式给定间距与括号宽度：这些值默认会按「fontSize / baseFont」缩放，
  // 测试用固定值可以避免 mock 字号（14）与标定字号（19.95）不一致带来的干扰。
  // 缩放行为由 setFontScale 单独验证。
  colGap: I.OPT.colGap,
  braceWidth: I.OPT.braceWidth,
  boxPadX: I.OPT.boxPadX,
  boxPadY: I.OPT.boxPadY,
};

const SRC_FULL = [
  'dir: rl',
  'brace: square',
  'box: 1,2',
  'closing: true',
  'title: 钢的分类与编号',
  '- 按冶炼方法',
  '  - 平炉钢',
  '    - 甲',
  '    - 乙',
  '  - 转炉钢',
  '- 按金相组织',
  '  - 亚共析钢',
].join('\n');

/* ---------------------- v0.3.0 新增 ---------------------- */

/** 从标记里按出现顺序取出 bm-text 的锚点 */
function textEls(markup) {
  const parts = String(markup).split('<text class="bm-text"');
  const out = [];
  for (let i = 1; i < parts.length; i++) {
    const m = parts[i].match(/^\s+x="([^"]+)"\s+y="([^"]+)"\s+text-anchor="([^"]+)"/);
    if (m) out.push({ x: Number(m[1]), y: Number(m[2]), anchor: m[3] });
  }
  return out;
}

/** 把 d 解析回坐标点（含 Q 的控制点与终点） */
function pathPoints(d) {
  const out = [];
  const re = /([MLQCZ])([^MLQCZ]*)/g;
  let m;
  while ((m = re.exec(String(d)))) {
    const op = m[1];
    const nums = (m[2].match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    if (op === 'M' || op === 'L') {
      for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
    } else if (op === 'Q') {
      for (let i = 0; i + 3 < nums.length; i += 4) {
        out.push([nums[i], nums[i + 1]]);
        out.push([nums[i + 2], nums[i + 3]]);
      }
    }
  }
  return out;
}

/** 记录式假行内样式 */
function fakeStyle() {
  const map = new Map();
  return {
    setProperty(p, v) { map.set(String(p), String(v)); },
    getPropertyValue(p) { return map.has(String(p)) ? map.get(String(p)) : ''; },
    each(cb) { map.forEach((v, k) => cb(k, v)); },
    get size() { return map.size; },
  };
}

/** 假 getComputedStyle：从节点的 computed 表里读，支持 getPropertyValue 与 camelCase 属性访问 */
function fakeView() {
  return {
    getComputedStyle(node) {
      const read = (p) => (node.computed[String(p)] == null ? '' : String(node.computed[String(p)]));
      const cs = { getPropertyValue: read };
      for (const key of Object.keys(node.computed)) {
        Object.defineProperty(cs, key.replace(/-(.)/g, (m, c) => c.toUpperCase()), {
          get: () => read(key), configurable: true, enumerable: true,
        });
      }
      Object.defineProperty(cs, 'backgroundColor', {
        get: () => read('background-color'), configurable: true, enumerable: true,
      });
      return cs;
    },
  };
}

/**
 * 极简假元素：只实现导出路径用到的那几个口子。
 * computed = CSS 规则算出来的值；style = 元素自己的行内样式（导出时写进去的那些）。
 */
function fakeEl(tag, computed, view) {
  const el = {
    tagName: tag,
    attrs: Object.create(null),
    style: fakeStyle(),
    computed: Object.assign({}, computed || {}),
    children: [],
    parentElement: null,
    ownerDocument: view ? { defaultView: view } : null,
    setAttribute(k, v) { el.attrs[String(k)] = String(v); },
    getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
    hasAttribute(k) { return k in el.attrs; },
    removeAttribute(k) { delete el.attrs[String(k)]; },
    appendChild(child) { child.parentElement = el; el.children.push(child); return child; },
    cloneNode(deep) {
      const c = fakeEl(tag, el.computed, view);
      for (const k of Object.keys(el.attrs)) c.attrs[k] = el.attrs[k];
      el.style.each((k, v) => c.style.setProperty(k, v));
      if (deep) for (const ch of el.children) c.appendChild(ch.cloneNode(true));
      return c;
    },
    querySelectorAll() {
      const out = [];
      const walk = (n) => { for (const ch of n.children) { out.push(ch); walk(ch); } };
      walk(el);
      return out;
    },
    get styleText() {
      const parts = [];
      el.style.each((k, v) => parts.push(k + ':' + v));
      return parts.join(';');
    },
    get outerHTML() {
      const attrs = Object.keys(el.attrs).map((k) => ' ' + k + '="' + el.attrs[k] + '"').join('');
      const st = el.styleText;
      const head = '<' + tag + attrs + (st ? ' style="' + st + '"' : '');
      if (!el.children.length) return head + ' />';
      return head + '>' + el.children.map((c) => c.outerHTML).join('') + '</' + tag + '>';
    },
  };
  return el;
}

/* ------------------------- 自动折行（maxWidth） ------------------------- */

// 折行用例专用测量：CJK / 全角 14px，其余 8px（与 mockMeasure 的「每字 10px」区分开，
// 这样“中文按字断”和“英文按词断”的量能分开验）
const wrapMeasure = (text) => {
  let w = 0;
  for (const ch of String(text)) {
    w += /[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? 14 : 8;
  }
  return w;
};
// 粗体按 1.25 倍放大，模拟 600 字重更宽
const wrapBold = (text) => wrapMeasure(text) * 1.25;

const WRAP_OPTS = Object.assign({}, LAYOUT_OPTS, {
  measure: wrapMeasure,
  measureBold: wrapBold,
});

module.exports = {
  mockMeasure, FONT, LINE_H, ROW_GAP, TEXT_H, LAYOUT_OPTS, SRC_FULL,
  textEls, pathPoints,
  fakeStyle, fakeView, fakeEl,
  wrapMeasure, wrapBold, WRAP_OPTS,
};
