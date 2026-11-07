'use strict';

/* ============================================================
 * valignread.test.js · 阅读视图里的垂直基准（上 / 中 / 下）
 *
 * 阅读视图的浮动是另一套：floatify 把块改成 position: absolute，用 top 定位。
 * 所以 valign 在这里只是「top 上加一个偏移」，语义与编辑模式一字不差：
 *   下 bottom（默认）：offset = 0
 *   上 top：           offset = h - H
 *   中 middle：        offset = h / 2 - yTitle
 *
 * 三个量的来源（都在阅读视图里重新取）：
 *   h      紧邻段落的行高（computed line-height，读不到按块高 ÷ Range 行数）
 *   H      被绝对定位那个块的 rect 高
 *   yTitle 根节点文字 bbox 中心相对块顶边
 *
 * 假 DOM 只摆几何，不做排版；这里验的是「量到 → 算 → 写进 top → 记进账 → 复位」
 * 这一条链，以及「量不到就退化为 0」。真机排版另看 headless 数据。
 * ============================================================ */

const { I, ok, eq, suite } = require('./framework');

/* 小数比较：340.75 这种值在双精度里可能有尾数 */
function near(actual, expected, label) {
  ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-9, label,
    'got ' + actual + ', want ' + expected);
}

/* ------------------------------ 假 DOM ------------------------------ */

function toCamel(p) {
  return String(p).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
}

function fakeClassList(names) {
  const list = (names || []).slice();
  return {
    contains: (c) => list.indexOf(c) >= 0,
    add: (c) => { if (list.indexOf(c) < 0) list.push(c); },
    remove: (...cs) => {
      for (const c of cs) {
        const i = list.indexOf(c);
        if (i >= 0) list.splice(i, 1);
      }
    },
    _list: list,
  };
}

/** 记录式行内样式：普通对象 + removeProperty（复位时会用它删属性） */
function styleObj(init) {
  const s = Object.assign({}, init || {});
  s.__removed = [];
  s.removeProperty = (p) => {
    s.__removed.push(p);
    delete s[toCamel(p)];
  };
  return s;
}

/** 假 getComputedStyle：只认节点自己的 computed 表（camelCase 键） */
function csOf(node) {
  const c = (node && node.computed) || {};
  const read = (p) => {
    const k = toCamel(p);
    return c[k] == null ? '' : String(c[k]);
  };
  const cs = { getPropertyValue: read };
  for (const k of Object.keys(c)) cs[k] = String(c[k]);
  return cs;
}

const VIEW = { getComputedStyle: csOf };

/** 带几何、带 class 的元素；rect 默认按 top/left/w/h 摆 */
function el(opts) {
  const o = opts || {};
  const node = {
    tagName: o.tag || 'DIV',
    className: o.cls || '',
    classList: fakeClassList(o.cls ? String(o.cls).split(/\s+/) : []),
    style: o.style || styleObj(),
    computed: o.computed || {},
    parentElement: null,
    nextElementSibling: null,
    previousElementSibling: null,
    childElementCount: o.childElementCount == null ? 0 : o.childElementCount,
    isConnected: true,
    // 假 DOM 默认有 getComputedStyle（没有 createRange：数不出行数那一条另外造）
    ownerDocument: o.doc || { defaultView: VIEW },
    // 阅读视图：不在 .cm-editor / .cm-content 里
    closest: () => null,
    querySelectorAll: () => o.roots || [],
    querySelector: () => o.child || null,
    offsetHeight: o.h == null ? 0 : o.h,
  };
  const left = o.left == null ? 0 : o.left;
  const top = o.top == null ? 0 : o.top;
  const w = o.w == null ? 0 : o.w;
  const h = o.h == null ? 0 : o.h;
  node.getBoundingClientRect = o.rect || (() => ({
    left, top, width: w, height: h, right: left + w, bottom: top + h,
  }));
  return node;
}

/** 只给了一条 computed 的元素（行高用） */
function withLineHeight(node, lh, fs) {
  node.computed = Object.assign({}, node.computed, {
    lineHeight: lh == null ? 'normal' : lh,
    fontSize: fs == null ? '16px' : fs,
  });
  return node;
}

/**
 * 阅读视图现场：
 *
 *   .markdown-preview-sizer（定位祖先，flex 列）
 *     .el-pre（被绝对定位的壳，图高）
 *       .block-language-brace（宿主，根节点文字挂在这里）
 *     .el-p（图原来那一行对应的正文段落）
 *
 * 壳的 rect 跟着自己写下的 top 走 —— 这样「垂直挪了，横向量法会不会串味」
 * 能被真实检验：clearance / margin 只该看 left / right。
 */
function readerScene(opts) {
  const o = opts || {};
  const imgH = o.imgH == null ? 151 : o.imgH;
  const imgTop = o.imgTop == null ? 500 : o.imgTop;
  const imgLeft = o.imgLeft == null ? 600 : o.imgLeft;
  const sizerTop = o.sizerTop == null ? 100 : o.sizerTop;
  const sizerLeft = 16;
  const sizerW = 820;

  const doc = { defaultView: VIEW };

  const sizer = el({
    tag: 'DIV', cls: 'markdown-preview-sizer', left: sizerLeft, top: sizerTop, w: sizerW, h: 4000,
    computed: { position: 'relative', paddingLeft: '0px', paddingRight: '0px' },
  });
  sizer.clientLeft = 0;
  sizer.clientTop = 0;
  sizer.clientWidth = sizerW;
  sizer.ownerDocument = doc;

  const fig = el({ tag: 'DIV', cls: 'el-pre', childElementCount: 1, left: imgLeft, w: sizerW, h: imgH });
  fig.ownerDocument = doc;
  fig.getBoundingClientRect = () => {
    const written = fig.style.top == null ? '' : String(fig.style.top);
    const base = written ? sizerTop + parseFloat(written) : imgTop;
    return {
      left: imgLeft, top: base, width: sizerW, height: imgH,
      right: imgLeft + sizerW, bottom: base + imgH,
    };
  };

  const host = el({
    tag: 'DIV', cls: 'block-language-brace', left: imgLeft, top: imgTop, w: 300, h: imgH,
    roots: o.roots || [],
  });
  host.ownerDocument = doc;
  host.parentElement = fig;
  fig.parentElement = sizer;

  const para = el({
    tag: 'DIV', cls: 'el-p', left: sizerLeft, top: imgTop + imgH + 24, w: sizerW,
    h: o.paraH == null ? 94.5 : o.paraH,
    computed: o.paraComputed || { lineHeight: '31.5px', fontSize: '16px' },
    child: o.paraChild || null,
  });
  para.ownerDocument = o.paraDoc || doc;
  fig.nextElementSibling = para;
  para.previousElementSibling = fig;

  return { doc, sizer, fig, host, para };
}

/** 一个根节点文字（bbox 用） */
function rootText(top, h) {
  return el({ top, h });
}

/* ------------------------------ 行高 h 的来源 ------------------------------ */

function tReaderLineHeight() {
  // 1) 段落自己的 computed line-height 最可信
  const a = readerScene();
  eq(I.measureReaderLineHeight(a.fig), 31.5, 'valign-reader-line: 取紧邻段落的 computed line-height');

  // 2) 段落壳是 normal（Obsidian 的 .el-p），行高落在里面的 <p>
  const inner = el({ tag: 'P', h: 84, doc: { defaultView: VIEW } });
  withLineHeight(inner, '28px');
  const b = readerScene({ paraComputed: { lineHeight: 'normal', fontSize: '16px' }, paraChild: inner });
  eq(I.measureReaderLineHeight(b.fig), 28, 'valign-reader-line: 壳是 normal 时读里面的 <p>');

  // 3) 都读不到：按块高 ÷ Range 数出的行数
  const inner2 = el({ tag: 'P', h: 84 });
  withLineHeight(inner2, 'normal');
  const rangeDoc = {
    defaultView: VIEW,
    createRange: () => ({
      selectNodeContents() {},
      getClientRects: () => [
        { top: 0, height: 27 }, { top: 28, height: 27 }, { top: 56, height: 27 },
      ],
    }),
  };
  inner2.ownerDocument = rangeDoc;
  const c = readerScene({ paraComputed: { lineHeight: 'normal', fontSize: '16px' }, paraChild: inner2 });
  c.para.ownerDocument = rangeDoc;
  eq(I.measureReaderLineHeight(c.fig), 28, 'valign-reader-line: 折行段落按 Range 行数平分块高');

  // 4) 连 Range 都没有（假 DOM / 老环境）：量不到就是 0，不拿段落总高冒充行高
  const d = readerScene({ paraComputed: {}, paraH: 94.5 });
  eq(I.measureReaderLineHeight(d.fig), 0, 'valign-reader-line: 两个都量不到时为 0');

  // 5) 图后面没有段落（文末）：往前找
  const e = readerScene();
  const before = el({
    tag: 'P', left: 16, top: 100, w: 820, h: 40,
    computed: { lineHeight: '40px', fontSize: '16px' },
  });
  e.fig.nextElementSibling = null;
  e.fig.previousElementSibling = before;
  before.nextElementSibling = e.fig;
  eq(I.measureReaderLineHeight(e.fig), 40, 'valign-reader-line: 后面没有段落时往前找');

  // 6) 前后都没有段落：0，不抛
  const f = readerScene();
  f.fig.nextElementSibling = null;
  eq(I.measureReaderLineHeight(f.fig), 0, 'valign-reader-line: 没有段落时为 0');
  eq(I.measureReaderLineHeight(null), 0, 'valign-reader-line: 没有块时为 0');
}

/* ------------------------------ 写进 top：三档 ------------------------------ */

/**
 * 跑一次完整的 floatify。
 * 期望值：sizer top 100、图顶 500 → 基准 top = 400（imgH 151、段落行高 31.5）。
 */
function runReader(valign, opts) {
  const o = opts || {};
  const sc = readerScene({ roots: o.roots, paraComputed: o.paraComputed, imgH: o.imgH });
  const cfg = { float: 'right', width: 300 };
  if (valign !== undefined) cfg.valign = valign;
  const rec = I.floatify(sc.host, cfg, {});
  return { sc, rec, top: sc.fig.style.top };
}

function tReaderTopBottom() {
  // 不写 valign：与改动前完全一致（基准 top = 图顶 − 定位祖先顶 = 400）
  const a = runReader(undefined);
  ok(a.rec, 'valign-reader-top: 不写 valign 也要真的浮动起来');
  eq(a.top, '400px', 'valign-reader-top: 不写 valign → top 与改动前逐位相同');
  eq(a.rec.valign.valign, 'bottom', 'valign-reader-top: 不写 valign 记成 bottom');
  eq(a.rec.valign.offset, 0, 'valign-reader-top: bottom 偏移 0');
  near(a.rec.valign.baseTop, 400, 'valign-reader-top: 基准 top 记进账');

  // 明写 bottom：同一个数
  const b = runReader('bottom');
  eq(b.top, '400px', 'valign-reader-top: 明写 bottom 也是 400px');
  eq(b.top, a.top, 'valign-reader-top: bottom 与不写 valign 完全一致');

  // 非法值当 bottom
  const c = runReader('居中');
  eq(c.top, '400px', 'valign-reader-top: 非法值退化为 bottom');
}

function tReaderTopShift() {
  // top：offset = h − H = 31.5 − 151 = −119.5 → 400 − 119.5 = 280.5
  const a = runReader('top');
  eq(a.top, '280.5px', 'valign-reader-top: top 档把图整体上推 H − h');
  near(a.rec.valign.offset, -119.5, 'valign-reader-top: 偏移 = h − H');
  near(a.rec.valign.lineH, 31.5, 'valign-reader-top: 记下量到的 lineH');
  near(a.rec.valign.imgH, 151, 'valign-reader-top: 记下 imgH');
  near(a.rec.valign.top, 280.5, 'valign-reader-top: 记下写下的 top');
  // 与编辑模式共用同一个纯函数：数值必须一模一样
  near(a.rec.valign.offset, I.valignOffset(31.5, 151, a.rec.valign.yTitle, 'top'),
    'valign-reader-top: 复用 valignOffset 算出来的值');

  // 图比行矮时上推变成下推（h − H 为正）
  const b = readerScene({ imgH: 20, roots: [] });
  const rec = I.floatify(b.host, { float: 'right', width: 300, valign: 'top' }, {});
  ok(rec, 'valign-reader-top: 矮图也能浮动');
  // 基准 top 仍是 500 − 100 = 400，再加 h − H = 31.5 − 20 = 11.5
  eq(b.fig.style.top, '411.5px', 'valign-reader-top: 矮图 top 档往下推');
}

function tReaderTopMiddle() {
  // 根文字 560..590 → 中心 575；块顶 500 → yTitle = 75
  // middle：offset = 31.5/2 − 75 = −59.25 → 400 − 59.25 = 340.75
  const a = runReader('middle', { roots: [rootText(560, 30)] });
  eq(a.top, '340.75px', 'valign-reader-top: middle 把标题中心挪到行中心');
  near(a.rec.valign.yTitle, 75, 'valign-reader-top: yTitle 相对块顶边量');
  near(a.rec.valign.offset, -59.25, 'valign-reader-top: 偏移 = h/2 − yTitle');

  // 多个根取平均：中心 575 / 635 → 相对 75 / 135 → 平均 105
  // offset = 15.75 − 105 = −89.25 → 310.75
  const b = runReader('middle', { roots: [rootText(560, 30), rootText(620, 30)] });
  eq(b.top, '310.75px', 'valign-reader-top: 多个根取平均');

  // 标题正好在行中心：偏移 0，top 回到基准
  // yTitle = 31.5/2 = 15.75 → 根文字中心应在 515.75 → top = 500.75、高 30
  const c = runReader('middle', { roots: [rootText(500.75, 30)] });
  eq(c.top, '400px', 'valign-reader-top: 标题在行中心时偏移为 0');
}

function tReaderDegenerate() {
  // h 量不到（段落上什么都没有、也没有 Range）：top 档退化为 0
  const a = runReader('top', { paraComputed: {} });
  eq(a.top, '400px', 'valign-reader-top: h 量不到时退化为 0');
  eq(a.rec.valign.offset, 0, 'valign-reader-top: h 量不到时偏移 0');
  eq(a.rec.valign.lineH, 0, 'valign-reader-top: h 量不到时记为 0');

  // yTitle 量不到（没有根节点）：middle 退化为 0
  const b = runReader('middle', { roots: [] });
  eq(b.top, '400px', 'valign-reader-top: yTitle 量不到时 middle 退化为 0');
  eq(b.rec.valign.yTitle, null, 'valign-reader-top: yTitle 量不到时记为 null');

  // yTitle 缺失不影响 top 档（只跟 h、H 有关）
  const c = runReader('top', { roots: [] });
  eq(c.top, '280.5px', 'valign-reader-top: yTitle 缺失不影响 top 档');
}

/* ------------------------------ 记账与复位 ------------------------------ */

function tReaderBookkeeping() {
  // 写 diff 只多一个数：bottom 与 top 两档的样式记录条数必须一样
  const b = runReader('bottom');
  const t = runReader('top');
  eq(t.rec.styles.length, b.rec.styles.length, 'valign-reader-book: 偏移不新增样式记录，只改 top 的值');

  // top 那条记录确实记在 record.styles 里（复位靠它）
  let topRec = null;
  for (const e of t.rec.styles) if (e && e.el === t.sc.fig && e.prop === 'top') topRec = e;
  ok(topRec, 'valign-reader-book: top 走 setInlineStyle 并记进 record.styles');
  eq(topRec.prev, '', 'valign-reader-book: 记下写之前的空值');

  // 复位：top 回到「没有这条行内样式」
  eq(I.resetFloat(t.rec), true, 'valign-reader-book: resetFloat 成功');
  eq(t.sc.fig.style.top, undefined, 'valign-reader-book: 复位后 top 消失（回落到 CSS）');
  ok(t.sc.fig.style.__removed.indexOf('top') >= 0, 'valign-reader-book: 复位走 removeProperty');

  // 复位幂等：再调一次不抛
  eq(I.resetFloat(t.rec), true, 'valign-reader-book: 复位可重复调用');
  eq(t.sc.fig.style.top, undefined, 'valign-reader-book: 复位两次仍干净');
}

/* ------------------------------ 横向量法不受影响 ------------------------------ */

function tReaderClearance() {
  const b = runReader('bottom');
  const t = runReader('top');
  const m = runReader('middle', { roots: [rootText(560, 30)] });

  eq(t.rec.clearance, b.rec.clearance, 'valign-reader-clear: 垂直偏移不改 clearance');
  eq(t.rec.margin, b.rec.margin, 'valign-reader-clear: 垂直偏移不改 margin');
  eq(m.rec.margin, b.rec.margin, 'valign-reader-clear: middle 档同样不影响留白');
  eq(t.rec.wrap.length, b.rec.wrap.length, 'valign-reader-clear: 留白目标数量不变');
  eq(t.rec.height, b.rec.height, 'valign-reader-clear: 图高不变');

  // 壳的 rect 在假 DOM 里跟着 top 走：证明确实挪了位置，而横向量法没变
  ok(t.sc.fig.getBoundingClientRect().top < b.sc.fig.getBoundingClientRect().top,
    'valign-reader-clear: 假 DOM 里壳真的上移了（横向量法却没变）');
}

/* ------------------------------ 不碰编辑模式 ------------------------------ */

function tEditModeUntouched() {
  // floatify 对实时预览一律不动手（阅读视图这条路的入口守卫）
  const cm = el({ cls: 'block-language-brace' });
  cm.closest = (sel) => (sel === '.cm-editor' ? cm : null);
  eq(I.floatify(cm, { float: 'right', valign: 'top' }), null,
    'valign-reader-guard: 实时预览不走进阅读视图这条路');

  // 编辑模式的 valignOffset 语义没变（共用同一个纯函数）
  near(I.valignOffset(31.5, 151, 75, 'middle'), -59.25, 'valign-reader-guard: valignOffset 语义不变');
}

suite('valign-reader-line', tReaderLineHeight);
suite('valign-reader-top', () => {
  tReaderTopBottom();
  tReaderTopShift();
  tReaderTopMiddle();
  tReaderDegenerate();
});
suite('valign-reader-book', tReaderBookkeeping);
suite('valign-reader-clear', tReaderClearance);
suite('valign-reader-guard', tEditModeUntouched);
