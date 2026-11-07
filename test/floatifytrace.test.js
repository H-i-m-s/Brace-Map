'use strict';

/* ============================================================
 * floatifytrace.test.js · 阅读视图那条路的轨迹与「初值 / 现值」对照
 *
 * 要回答的问题：阅读视图里 valign 把偏移加进绝对定位的 top，而那个 top 是
 * floatify 那一刻算的。如果那一刻图还没渲染（rect 高 0），偏移就按 0 算，
 * 之后没人回头重算——轨迹里「初值 imgH 0.00、现值 imgH 169.79」就是铁证。
 *
 * 这里在假 DOM 上把这个序列走一遍：
 *   1. 块高 0 → floatify 直接返回（!plan.length），但轨迹记下 bH=0
 *   2. 块变成 169.79、后面有正文段 → floatify 正常完成，top 含偏移
 *   3. 两者并列，对照节直接给出「初值 → 现值」
 * ============================================================ */

const { I, Plugin, ok, eq, suite } = require('./framework');

/* ------------------------------ 假 DOM ------------------------------ */

/** 所有元素共用的一套 computed：只给 floatify / 量行高 / 读外边距会用到的键 */
function computed(el) {
  const o = el && el.__cs ? el.__cs : {};
  return {
    lineHeight: o.lineHeight || 'normal',
    fontSize: o.fontSize || '30px',
    paddingLeft: '0px',
    paddingRight: '0px',
    marginLeft: o.marginLeft || '0px',
    marginRight: o.marginRight || '0px',
    position: o.position || 'static',
    height: o.height || 'auto',
    display: 'block',
    contain: 'none',
    overflow: 'visible',
    float: 'none',
  };
}

const DOC = { defaultView: { getComputedStyle: (el) => computed(el) } };

/**
 * 一个假元素。几何放在 __box 里，测试中途改它就等于改页面。
 */
function makeEl(o) {
  const opt = o || {};
  const el = {
    style: {},
    tagName: opt.tag || 'DIV',
    classList: { contains: (c) => (opt.cls || []).indexOf(c) >= 0 },
    parentElement: null,
    nextElementSibling: null,
    previousElementSibling: null,
    childElementCount: opt.kids == null ? 0 : opt.kids,
    clientWidth: opt.clientW == null ? 800 : opt.clientW,
    clientLeft: 0,
    clientTop: 0,
    ownerDocument: DOC,
    __box: {
      left: opt.left == null ? 0 : opt.left,
      top: opt.top == null ? 0 : opt.top,
      width: opt.w == null ? 800 : opt.w,
      height: opt.h == null ? 0 : opt.h,
    },
    __cs: opt.cs || null,
    __roots: opt.roots || [],
    getBoundingClientRect() {
      const b = el.__box;
      return {
        left: b.left, top: b.top, width: b.width, height: b.height,
        right: b.left + b.width, bottom: b.top + b.height,
      };
    },
    querySelectorAll() { return el.__roots; },
    closest: () => null,          // 阅读视图：不在 .cm-editor 里
  };
  Object.defineProperty(el, 'offsetHeight', { get: () => el.__box.height });
  return el;
}

/**
 * 一个能跑通 floatify 的阅读视图场景：
 *   sizer（正文列）→ host（图块，会被脱离流）→ para（后面的正文段）
 * host 里还有一条根节点文字（valign: middle 要用它）。
 */
function buildReader() {
  const sizer = makeEl({ h: 2000, clientW: 800, kids: 2, cls: ['markdown-preview-sizer'] });
  const host = makeEl({ h: 0, top: 100, w: 800 });
  const para = makeEl({ tag: 'P', h: 100, top: 200, cs: { lineHeight: '31.5px' } });
  const rootText = makeEl({ h: 24, top: 179.9 });     // 中心 191.9 → 相对块顶 91.9

  sizer.parentElement = null;
  host.parentElement = sizer;
  host.nextElementSibling = para;
  para.previousElementSibling = host;
  host.__roots = [rootText];

  return { sizer, host, para, rootText };
}

/* ------------------------------ 轨迹 ------------------------------ */

function tZeroThenGrow() {
  I.vtReset();
  const { host, para } = buildReader();
  const cfg = { float: 'right', valign: 'middle' };

  /* 1) 图还没渲染：块高 0。后面没有可绕排的块 → 直接返回 */
  eq(I.floatify(host, cfg), null, 'floatify-trace: 块高 0 时不动手');
  let rows = I.vtFloatRows();
  eq(rows.length, 1, 'floatify-trace: 第一次调用就留了一条');
  eq(rows[0].exit, '!plan.length', 'floatify-trace: 出口是「后面没有可绕排的块」');
  eq(rows[0].bH, 0, 'floatify-trace: 记下调用那一刻的块高 0（关键字段）');
  eq(rows[0].vin.imgH, 0, 'floatify-trace: readerValignInfo 量到的图高也是 0');
  eq(rows[0].vin.offset, 0, 'floatify-trace: 偏移因此是 0');
  eq(rows[0].wrote, false, 'floatify-trace: 没写 top');
  eq(host.style.top, undefined, 'floatify-trace: 宿主样式确实没被碰');

  /* 2) 图渲染完了：块高 169.79，后面那段正文也要真排出来 */
  host.__box.height = 169.79;
  para.__box.height = 100;
  const rec = I.floatify(host, cfg);
  ok(rec && rec.side === 'right', 'floatify-trace: 这一次真的浮动了');
  rows = I.vtFloatRows();
  eq(rows.length, 2, 'floatify-trace: 第二次又留一条');
  eq(rows[1].exit, 'ok', 'floatify-trace: 第二次正常完成');
  eq(rows[1].bH, 169.79, 'floatify-trace: 记下这一拍的真实块高');
  eq(rows[1].vin.imgH, 169.79, 'floatify-trace: 图高 169.79');
  eq(rows[1].vin.lineH, 31.5, 'floatify-trace: 行高 31.5');
  eq(rows[1].vin.yTitle, 91.9, 'floatify-trace: 标题中心 91.9');
  eq(rows[1].vin.offset, -76.15, 'floatify-trace: middle 偏移 = 31.5/2 − 91.9');
  eq(rows[1].baseTop, 100, 'floatify-trace: 流内位置 100');
  eq(rows[1].top, 23.85, 'floatify-trace: 最终 top = 100 − 76.15');
  eq(rows[1].wrote, true, 'floatify-trace: 写了 top');
  eq(host.style.top, '23.85px', 'floatify-trace: 样式里就是 23.85px');
  eq(rows[1].recH, 169.79, 'floatify-trace: 改宽之后重量到的块高也在');

  /* 两次调用归到同一个宿主 */
  eq(rows[0].tag, rows[1].tag, 'floatify-trace: 两条记录同一个宿主标识');
  ok(rows[0].dt <= rows[1].dt, 'floatify-trace: 时间戳单调');
}

function tTraceText() {
  const text = I.formatFloatTrace();
  ok(text.indexOf('## 五、floatify 调用轨迹（阅读视图）') >= 0,
    'floatify-text: 单独一节，标题写清是阅读视图');
  ok(text.indexOf('`!plan.length`') >= 0, 'floatify-text: 第一个出口在表里');
  ok(text.indexOf('`ok`') >= 0, 'floatify-text: 正常完成也在');
  ok(text.indexOf('| 0.00 |') >= 0, 'floatify-text: 0 那一拍能看见');
  ok(text.indexOf('169.79') >= 0, 'floatify-text: 变高那一拍也能看见');
  ok(text.indexOf('**调用那一刻') >= 0, 'floatify-text: 字段表点明 bH 是关键');
  ok(text.indexOf('与上面的编辑模式轨迹完全分开') >= 0, 'floatify-text: 明说与编辑模式那条分开');
  ok(text.indexOf('| → 出口 |') >= 0 && text.indexOf('| 字段 | 含义 |') >= 0,
    'floatify-text: 自带字段表和出口表');
}

/* ------------------------------ 出口代号 ------------------------------ */

function tExitCodes() {
  I.vtReset();
  const { host } = buildReader();

  I.floatify(host, { float: 'center' });                  // !side
  I.floatify(null, { float: 'right' });                   // !el
  const live = makeEl({ h: 100 });
  live.closest = (sel) => (sel === '.cm-editor' ? live : null);
  I.floatify(live, { float: 'right' });                   // isLivePreview
  const orphan = makeEl({ h: 100 });                      // 没有父元素 → !ctx
  I.floatify(orphan, { float: 'right' });
  const noRect = makeEl({ h: 100 });
  const parent = makeEl({ h: 2000, kids: 2 });
  noRect.parentElement = parent;
  noRect.getBoundingClientRect = () => null;              // !bRect
  I.floatify(noRect, { float: 'right' });

  const exits = I.vtFloatRows().map((r) => r.exit);
  eq(exits, ['!side', '!el', 'isLivePreview', '!ctx', '!bRect'],
    'floatify-exit: 五个出口各有代号');
}

/* ------------------------------ 对照节（走真实命令链） ------------------------------ */

async function tCompareSection() {
  I.vtReset();
  const { host, para } = buildReader();
  host.__bmCfg = { float: 'right', valign: 'middle' };

  /* 初值那一拍：块高 0 */
  I.floatify(host, host.__bmCfg);
  /* 之后图变高，但故意不再调 floatify —— 复刻「没人回头重算 top」 */
  host.__box.height = 169.79;
  para.__box.height = 100;

  const prevDoc = global.document;
  global.document = { querySelectorAll: () => [host] };
  const plugin = new Plugin();
  let written = null;
  plugin.app = {
    vault: { adapter: { write: (path, text) => { written = { path, text }; return Promise.resolve(); } } },
  };
  let text = '';
  try {
    text = await plugin.writeValignTrace();
  } finally {
    if (prevDoc === undefined) delete global.document;
    else global.document = prevDoc;
  }

  ok(!!written, 'floatify-compare: 真的调了 adapter.write');
  eq(written.path, 'brace-map-valign-trace.md', 'floatify-compare: 写进已有的那个轨迹文件');
  ok(text.indexOf('## 六、floatify 的初值与现值对照') >= 0, 'floatify-compare: 有此一节');
  ok(text.indexOf('调用时的块高 0.00（图还没渲染） → 现在 169.79') >= 0,
    'floatify-compare: 判读指出初值是空图、现在是真值');
  ok(text.indexOf('这一拍没写 top（出口 `!plan.length`）') >= 0,
    'floatify-compare: 点明这一拍连 top 都没写');
  ok(text.indexOf('只有一次调用，之后没有重算') >= 0, 'floatify-compare: 点出没有回头重算');
  ok(text.indexOf('| imgH | 0.00 | 0.00 | 169.79 |') >= 0,
    'floatify-compare: 三列并排（初值 / 末值 / 现值）');
}

/* ------------------------------ 对照：写过一个偏的 top ------------------------------ */

async function tCompareWithWrongTop() {
  I.vtReset();
  const { host, para } = buildReader();
  host.__bmCfg = { float: 'right', valign: 'middle' };

  /* 图刚排到一半（100px）就跑了 floatify：会写下一个按 100 算的 top */
  host.__box.height = 100;
  para.__box.height = 100;
  const rec = I.floatify(host, host.__bmCfg);
  ok(rec, 'floatify-compare2: 100px 已经能算出留白范围，会真的浮动');
  eq(host.style.top, '23.85px', 'floatify-compare2: 写下了 top');

  /* 之后图完整渲染成 169.79，但没人回头重算 */
  host.__box.height = 169.79;

  const prevDoc = global.document;
  global.document = { querySelectorAll: () => [host] };
  const plugin = new Plugin();
  plugin.app = { vault: { adapter: { write: () => Promise.resolve() } } };
  let text = '';
  try {
    text = await plugin.writeValignTrace();
  } finally {
    if (prevDoc === undefined) delete global.document;
    else global.document = prevDoc;
  }

  ok(text.indexOf('| imgH | 100.00 | 100.00 | 169.79 |') >= 0,
    'floatify-compare2: 初值 100.00 与现值 169.79 并排');
  ok(text.indexOf('写下的 top 是按 100.00 算的') >= 0, 'floatify-compare2: 指出 top 是按初值算的');
}

/* ------------------------------ 登记 ------------------------------ */

suite('floatify-trace/zero-then-grow', tZeroThenGrow);
suite('floatify-trace/text', tTraceText);
suite('floatify-trace/exits', tExitCodes);
suite('floatify-trace/compare', tCompareSection);
suite('floatify-trace/compare-wrong-top', tCompareWithWrongTop);
