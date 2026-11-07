'use strict';

/* ============================================================
 * valign.test.js · 浮动图的垂直基准（上 / 中 / 下）
 *
 * 参照物是「图片所在的那一行」，不是图后面那段可绕排文字：
 *   下 bottom（默认）：图片顶部对齐所在行 → offset = 0
 *   上 top：          图片底部对齐所在行 → offset = h - H
 *   中 middle：       一级标题中心对齐行中心 → offset = h / 2 - yTitle
 *
 * 真实排版靠浏览器，这里测的是纯计算 + 假 DOM 上的测量、分支与记账：
 *   - 解析与默认值（默认 bottom）
 *   - valignOffset(h, H, yTitle, valign) 的数值与三个退化口子
 *   - 行高取自 computed line-height，其次兄弟 .cm-line，最后 fontSize × lineHRatio
 *   - yTitle 来自根节点文字的 bbox，多个根取平均
 *   - 四个前置条件（float / .cm-editor / bm-floated / 已连进文档）
 *   - 偏移走 setInlineStyle，顺序排在 margin 简写之后，resetFloatLayout 能还原
 * 浏览器里那几条（行高、标题 bbox、绕排）见 headless 实测数据。
 * ============================================================ */

const { I, ok, eq, suite } = require('./framework');

/* 公式里的数值用容差比：48.29/2 - 75 在双精度里是 -50.855000000000004 */
function near(actual, expected, label) {
  ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-9, label,
    'got ' + actual + ', want ' + expected);
}

/* ------------------------------ 假 DOM ------------------------------ */

function fakeClassList(names) {
  const list = names ? names.slice() : [];
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

/** 一个带高度、带 class 的元素；top 用来摆「它在页面上哪一行」 */
function fakeEl(names, h, top) {
  const box = {
    width: 100,
    height: h == null ? 0 : h,
    left: 0,
    top: top == null ? 0 : top,
    bottom: (top == null ? 0 : top) + (h == null ? 0 : h),
  };
  return {
    classList: fakeClassList(names),
    nextElementSibling: null,
    previousElementSibling: null,
    getBoundingClientRect: () => box,
    _box: box,
  };
}

/** 按顺序把 [{cls, h, top, lh}] 串成双向兄弟链，返回第一个；lh 给了就当作 computed line-height */
function fakeChain(items) {
  const els = items.map((it) => {
    const el = fakeEl(it.cls, it.h, it.top);
    if (it.lh) withComputed(el, { lineHeight: it.lh, fontSize: it.fontSize || '30px' });
    return el;
  });
  for (let i = 0; i < els.length - 1; i++) {
    els[i].nextElementSibling = els[i + 1];
    els[i + 1].previousElementSibling = els[i];
  }
  return els.length ? els[0] : null;
}

/**
 * host → .cm-embed-block → .cm-content → .cm-scroller → .cm-editor
 * 和 CM6 的真实层级一致（climbTo 默认只爬 4 层，多一层就找不到编辑器）。
 *
 * content 是「图片所在那一行」的容器：正文行 .cm-line 是它的兄弟链。
 * host 的高度就是图高 H；root 文字用 rootTexts 摆进 querySelectorAll。
 */
function makeHost(opts) {
  const o = opts || {};
  const editor = { classList: fakeClassList(['cm-editor']), parentElement: null };
  const scroller = { classList: fakeClassList(['cm-scroller']), parentElement: editor };
  const content = {
    classList: fakeClassList(['cm-content']),
    parentElement: scroller,
    _computed: o.computed || null,
  };
  const embed = {
    classList: fakeClassList(['cm-embed-block']),
    parentElement: content,
    nextElementSibling: null,
    previousElementSibling: null,
  };
  const host = {
    style: {},
    classList: fakeClassList(['bm-floated', 'bm-float-right']),
    parentElement: embed,
    isConnected: true,
    getBoundingClientRect: () => ({
      width: 300,
      height: o.imgH == null ? 100 : o.imgH,
      left: 0,
      top: o.imgTop == null ? 0 : o.imgTop,
    }),
    querySelectorAll: () => (o.rootTexts || []),
  };
  return { host, embed, content, scroller, editor };
}

/* ------------------------------ 解析 ------------------------------ */

function tParseValign() {
  eq(I.parseSource('valign: top\n- 父').valign, 'top', 'valign-parse: top');
  eq(I.parseSource('valign: middle\n- 父').valign, 'middle', 'valign-parse: middle');
  eq(I.parseSource('valign: bottom\n- 父').valign, 'bottom', 'valign-parse: bottom');
  eq(I.parseSource('valign: MIDDLE\n- 父').valign, 'middle', 'valign-parse: 大小写不敏感');
  eq(I.parseSource('valign: Top\n- 父').valign, 'top', 'valign-parse: 首字母大写也认');
  eq(I.parseSource('valign: 居中\n- 父').valign, 'bottom', 'valign-parse: 非法值回落到 bottom');
  eq(I.parseSource('valign: center\n- 父').valign, 'bottom', 'valign-parse: center 不是合法值');
  eq(I.parseSource('- 父').valign, 'bottom', 'valign-parse: 不写默认 bottom（下）');

  // 与 float 一起写时的独立性
  const cfg = I.parseSource('float: right\nvalign: middle\n- 父\n  - 子');
  eq([cfg.float, cfg.valign], ['right', 'middle'], 'valign-parse: 与 float 各管各的');
  // 白名单里认它：缩进里的 valign 仍是指令，不会被续行吞掉
  const c2 = I.parseSource('- 父\n  - 子\n    valign: top');
  eq([c2.roots[0].children[0].text, c2.valign], ['子', 'top'],
    'valign-parse: 缩进写也算指令（不进正文）');
}

/* ------------------------------ 纯计算：三档公式 ------------------------------ */

function tOffsetFormula() {
  // h = 48.29（正文行高）、H = 151（图高）
  near(I.valignOffset(48.29, 151, 75, 'bottom'), 0, 'valign-offset: bottom 恒为 0');
  near(I.valignOffset(48.29, 151, 75, 'top'), -102.71, 'valign-offset: top = h - H');
  near(I.valignOffset(48.29, 151, 75, 'middle'), -50.855, 'valign-offset: middle = h/2 - yTitle');
  near(I.valignOffset(48.29, 151, 80, 'middle'), -55.855, 'valign-offset: middle 跟着 yTitle 走');
  near(I.valignOffset(48.29, 151, 24.145, 'middle'), 0, 'valign-offset: 标题正好在行中心时为 0');
  near(I.valignOffset(48.29, 151, 10, 'middle'), 14.145, 'valign-offset: 标题靠上时图往下推');

  // 图比行矮时三档的形状
  near(I.valignOffset(60, 40, 20, 'bottom'), 0, 'valign-offset: 矮图 bottom 为 0');
  near(I.valignOffset(60, 40, 20, 'top'), 20, 'valign-offset: 矮图 top = h - H 为正');
  near(I.valignOffset(60, 40, 20, 'middle'), 10, 'valign-offset: 矮图 middle = h/2 - yTitle');

  // 等高、图很高、任意小数
  near(I.valignOffset(100, 100, 50, 'top'), 0, 'valign-offset: 等高时 top 为 0');
  near(I.valignOffset(100, 100, 50, 'middle'), 0, 'valign-offset: 等高且标题居中时为 0');
  near(I.valignOffset(31.5, 202.78, 101.39, 'top'), -171.28, 'valign-offset: 小数照样算');
  near(I.valignOffset(31.5, 202.78, 15.75, 'middle'), 0, 'valign-offset: 标题在行中心时为 0');
  near(I.valignOffset(31.5, 202.78, 101.39, 'middle'), -85.64, 'valign-offset: 图很高时标题跟着往上挪');
  ok(I.valignOffset(48.29, 151, 75, 'top') < 0, 'valign-offset: 高图 top 是负值（整体上移）');
}

function tOffsetDegenerate() {
  // H = 0：图没渲染出来，三档一律 0
  for (const v of ['top', 'middle', 'bottom']) {
    eq(I.valignOffset(48.29, 0, 75, v), 0, 'valign-degenerate: H=0 时 ' + v + ' 为 0');
  }
  // h 拿不到 / 为 0：top 与 middle 都不做偏移（退化为 bottom）
  for (const v of ['top', 'middle']) {
    eq(I.valignOffset(0, 151, 75, v), 0, 'valign-degenerate: h=0 时 ' + v + ' 为 0');
    eq(I.valignOffset(NaN, 151, 75, v), 0, 'valign-degenerate: h 非数字时 ' + v + ' 为 0');
    eq(I.valignOffset(undefined, 151, 75, v), 0, 'valign-degenerate: h 缺失时 ' + v + ' 为 0');
  }
  // yTitle 拿不到：middle 退化为 0（即下）
  eq(I.valignOffset(48.29, 151, null, 'middle'), 0, 'valign-degenerate: yTitle=null 时 middle 为 0');
  eq(I.valignOffset(48.29, 151, NaN, 'middle'), 0, 'valign-degenerate: yTitle=NaN 时 middle 为 0');
  eq(I.valignOffset(48.29, 151, undefined, 'middle'), 0, 'valign-degenerate: yTitle 缺失时 middle 为 0');
  eq(I.valignOffset(48.29, 151, null, 'top'), -102.71000000000001, 'valign-degenerate: yTitle 缺失不影响 top');
  // 非法基准 / 空基准都归 bottom
  eq(I.valignOffset(48.29, 151, 75, 'bogus'), 0, 'valign-degenerate: 非法基准当 bottom');
  eq(I.valignOffset(48.29, 151, 75, ''), 0, 'valign-degenerate: 空基准当 bottom');
  eq(I.valignOffset(48.29, 151, 75, undefined), 0, 'valign-degenerate: 基准缺失当 bottom');
  // 图高非数字
  eq(I.valignOffset(48.29, NaN, 75, 'top'), 0, 'valign-degenerate: 图高非数字当 0');
}

/* ------------------------------ 行高 h 的来源 ------------------------------ */

/* 造一个带 computedStyle 的假元素：只认 lineHeight / fontSize 两个属性 */
function withComputed(el, values) {
  el.ownerDocument = {
    defaultView: {
      getComputedStyle: (target) => ({
        lineHeight: target === el && values.lineHeight ? values.lineHeight : 'normal',
        fontSize: target === el && values.fontSize ? values.fontSize : 'normal',
      }),
    },
  };
  return el;
}

/* makeHost 里的 content 由 measureLineHeight 的 climbTo 找到（host 不在 .cm-line 里） */
function tLineHeightSource() {
  // 1) 相邻 .cm-line 自己的 computed line-height 最可信
  const a = makeHost({ computed: { lineHeight: '48.29px', fontSize: '30px' } });
  const sibA = fakeEl(['cm-line'], 40, 0);
  withComputed(sibA, { lineHeight: '48.29px', fontSize: '30px' });
  a.embed.nextElementSibling = sibA;
  eq(I.measureLineHeight(a.host), 48.29, 'valign-line: 优先取相邻行的 computed line-height');

  // 2) 相邻行 computed 是 normal：退到它肚子里一个行盒的高
  const b = makeHost();
  withComputed(b.content, { lineHeight: 'normal', fontSize: '30px' });
  b.embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 48.29 }]);
  eq(I.measureLineHeight(b.host), 48.29, 'valign-line: normal 时取相邻行的行盒高');

  // 2b) normal 且那一行折了两行：行高 = 块高 / 行数，不是块高
  const b2 = makeHost();
  withComputed(b2.content, { lineHeight: 'normal', fontSize: 'normal' });
  const wrapped = fakeEl(['cm-line'], 63, 0);
  wrapped.ownerDocument = {
    createRange: () => ({
      selectNodeContents() {},
      getClientRects: () => [{ top: 0, height: 27 }, { top: 31.5, height: 27 }],
    }),
  };
  b2.embed.nextElementSibling = wrapped;
  eq(I.measureLineHeight(b2.host), 31.5, 'valign-line: 折行的段落按行数平分块高');

  // 3) 往后没有正文行（图在文末）：往前找
  const c = makeHost();
  withComputed(c.content, { lineHeight: 'normal', fontSize: '30px' });
  const prev = fakeChain([{ cls: ['cm-line'], h: 44 }]);
  c.embed.previousElementSibling = prev;
  prev.nextElementSibling = c.embed;
  eq(I.measureLineHeight(c.host), 44, 'valign-line: 后面没有行时往前找');

  // 3b) 连正文行都找不到：退到宿主所在层级的 computed line-height
  const c2 = makeHost();
  withComputed(c2.content, { lineHeight: '52px', fontSize: '30px' });
  eq(I.measureLineHeight(c2.host), 52, 'valign-line: 没有正文行时用容器的 computed line-height');

  // 4) 连几何都量不到：fontSize × lineHRatio
  const d = makeHost();
  withComputed(d.content, { lineHeight: 'normal', fontSize: '32px' });
  eq(I.measureLineHeight(d.host), 32 * I.OPT.lineHRatio,
    'valign-line: 都量不到时用 fontSize × lineHRatio');

  // 5) 什么都没有：0（调用方按 bottom 处理）
  const e = makeHost();
  eq(I.measureLineHeight(e.host), 0, 'valign-line: 假 DOM 没有 computed 也没有兄弟行时为 0');
}

/* ------------------------------ 一级标题 yTitle ------------------------------ */

/** 一个根节点文字：在页面上的 top / height，宿主的 top 由 makeHost 的 imgTop 决定 */
function rootText(top, h) {
  return fakeEl([], h, top);
}

function tTitleCenter() {
  // 宿主顶边在 100，根文字 130..160 → 中心 145，相对宿顶 45
  const a = makeHost({ imgH: 200, imgTop: 100, rootTexts: [rootText(130, 30)] });
  eq(I.measureTitleCenter(a.host), 45, 'valign-title: 单个根取文字中心相对图顶');

  // 两个根：中心分别 160 和 200（宿主顶 100）→ 相对 60 / 100 → 平均 80
  const b = makeHost({
    imgH: 300,
    imgTop: 100,
    rootTexts: [rootText(140, 40), rootText(180, 40)],
  });
  eq(I.measureTitleCenter(b.host), 80, 'valign-title: 多个根取平均');

  // 三个根，含一个小数的高度
  const c = makeHost({
    imgH: 300,
    imgTop: 50,
    rootTexts: [rootText(100, 30), rootText(160, 30), rootText(220, 31)],
  });
  near(I.measureTitleCenter(c.host), 125.16666666666667, 'valign-title: 三个根也平均');

  // 没有根标记（纯公式节点 / 老渲染）：NaN，调用方退化
  const d = makeHost({ imgH: 200, imgTop: 100, rootTexts: [] });
  ok(Number.isNaN(I.measureTitleCenter(d.host)), 'valign-title: 没有根节点时返回 NaN');

  // 根文字高度为 0（空文字框）：跳过，一个都量不到就 NaN
  const e = makeHost({ imgH: 200, imgTop: 100, rootTexts: [rootText(140, 0)] });
  ok(Number.isNaN(I.measureTitleCenter(e.host)), 'valign-title: 空文字框跳过');

  // 两个根，其中一个空：只平均能量到的那个
  const f = makeHost({
    imgH: 200,
    imgTop: 100,
    rootTexts: [rootText(140, 40), rootText(180, 0)],
  });
  eq(I.measureTitleCenter(f.host), 60, 'valign-title: 跳过量不到的根');

  // 没有 querySelectorAll（裸对象）：NaN，不抛
  ok(Number.isNaN(I.measureTitleCenter({ style: {} })), 'valign-title: 没有 querySelectorAll 时为 NaN');
}

/* ------------------------------ 写样式：三档实测 ------------------------------ */

/** 一次完整的「量 → 算 → 写」：h=48.29、H=151、标题中心 75 */
function applyCase(valign, opts) {
  const o = opts || {};
  const ctx = makeHost({
    imgH: o.imgH == null ? 151 : o.imgH,
    imgTop: 0,
    rootTexts: o.rootTexts || [rootText(60, 30)],   // 中心 75
  });
  withComputed(ctx.content, {
    lineHeight: o.lineHeight === undefined ? '48.29px' : o.lineHeight,
    fontSize: o.fontSize === undefined ? '30px' : o.fontSize,
  });
  if (!o.noLines) ctx.embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 40, lh: '48.29px' }]);
  const off = I.applyValignLayout(ctx.host, { float: 'right', valign });
  return { off, host: ctx.host, info: ctx.host.__bmValignInfo, ctx };
}

function tApplyThreeModes() {
  const top = applyCase('top');
  near(top.off, -102.71, 'valign-apply: top 写 -102.71');
  eq(top.host.style.marginTop, '-102.71px', 'valign-apply: top 写进 margin-top');
  eq(top.info.lineH, 48.29, 'valign-apply: top 诊断记行高');
  eq(top.info.imgH, 151, 'valign-apply: top 诊断记图高');
  eq(top.info.yTitle, 75, 'valign-apply: top 诊断记 yTitle');
  eq(top.info.applied, true, 'valign-apply: top 记已写样式');

  const mid = applyCase('middle');
  near(mid.off, -50.855, 'valign-apply: middle 写 -50.855');
  eq(mid.host.style.marginTop, '-50.85px', 'valign-apply: middle 落成两位小数');
  eq(mid.info.offset, -50.85, 'valign-apply: middle 诊断记四舍五入后的值');

  const bottom = applyCase('bottom');
  eq(bottom.off, 0, 'valign-apply: bottom 不偏移');
  eq(bottom.host.style.marginTop, undefined, 'valign-apply: bottom 不动 margin-top');
  eq(bottom.info.applied, false, 'valign-apply: bottom 记未写样式');
  eq(bottom.info.valign, 'bottom', 'valign-apply: 诊断记下基准');

  // 复位：margin-top 由 setInlineStyle 记过账，能还回去
  const n = I.resetFloatLayout(top.host);
  ok(n > 0, 'valign-apply: resetFloatLayout 复位了样式', String(n));
  eq(top.host.style.marginTop, '', 'valign-apply: 复位后不留写死的 margin-top');
}

function tApplyMultipleRoots() {
  // 两个根：中心分别 60 / 100 → yTitle 80，middle = 48.29/2 - 80
  const r = applyCase('middle', { rootTexts: [rootText(40, 40), rootText(80, 40)] });
  eq(r.info.yTitle, 80, 'valign-roots: 诊断记下平均后的 yTitle');
  near(r.off, -55.855, 'valign-roots: middle 用平均值算偏移');
  eq(r.host.style.marginTop, '-55.85px', 'valign-roots: 平均值写进 margin-top');
  // 同一张图换成 top：不该受 yTitle 影响
  const t = applyCase('top', { rootTexts: [rootText(40, 40), rootText(80, 40)] });
  near(t.off, -102.71, 'valign-roots: top 与 yTitle 无关');
}

function tApplyDegenerate() {
  // H = 0：三档都不写
  for (const v of ['top', 'middle', 'bottom']) {
    const r = applyCase(v, { imgH: 0 });
    eq(r.off, 0, 'valign-apply-degenerate: H=0 时 ' + v + ' 不写');
    eq(r.host.style.marginTop, undefined, 'valign-apply-degenerate: H=0 时 ' + v + ' 不动样式');
  }
  // h 拿不到：top / middle 退化为 bottom（没有兄弟行、也没有字号，量不到任何行高）
  for (const v of ['top', 'middle']) {
    const r = applyCase(v, { lineHeight: 'normal', fontSize: 'normal', noLines: true });
    eq(r.off, 0, 'valign-apply-degenerate: h=0 时 ' + v + ' 退化为 bottom');
    eq(r.info.lineH, 0, 'valign-apply-degenerate: h=0 时诊断记 0');
    eq(r.host.style.marginTop, undefined, 'valign-apply-degenerate: h=0 时 ' + v + ' 不动样式');
  }
  // yTitle 拿不到：middle 退化为 bottom，top 照旧
  const mid = applyCase('middle', { rootTexts: [] });
  eq(mid.off, 0, 'valign-apply-degenerate: yTitle 缺失时 middle 退化为 bottom');
  eq(mid.info.yTitle, null, 'valign-apply-degenerate: 诊断记 yTitle 为 null');
  const top = applyCase('top', { rootTexts: [] });
  near(top.off, -102.71, 'valign-apply-degenerate: yTitle 缺失不影响 top');
  eq(top.info.yTitle, null, 'valign-apply-degenerate: top 也记 yTitle 为 null');
}

/* ------------------------------ 前置条件 ------------------------------ */

function tSkipModes() {
  for (const mode of ['center', 'inline', '']) {
    const { host, embed } = makeHost({ imgH: 151, rootTexts: [rootText(60, 30)] });
    embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 48.29, lh: '48.29px' }]);
    eq(I.applyValignLayout(host, { float: mode, valign: 'top' }), 0,
      'valign-skip: float=' + (mode || '空') + ' 不做偏移');
    eq(Object.keys(host.style).length, 0, 'valign-skip: float=' + (mode || '空') + ' 不碰样式');
  }
}

function tSkipNoEditor() {
  const { host, embed, editor } = makeHost({ imgH: 151, rootTexts: [rootText(60, 30)] });
  editor.classList._list.length = 0;          // 不在 .cm-editor 里（阅读视图）
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 48.29, lh: '48.29px' }]);
  eq(I.applyValignLayout(host, { float: 'right', valign: 'top' }), 0,
    'valign-skip: 不在编辑模式不偏移');
  eq(host.style.marginTop, undefined, 'valign-skip: 阅读视图不碰 margin-top');
}

function tSkipNotFloated() {
  const { host, embed } = makeHost({ imgH: 151, rootTexts: [rootText(60, 30)] });
  host.classList.remove('bm-floated');        // float 没真的写上去
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 48.29, lh: '48.29px' }]);
  eq(I.applyValignLayout(host, { float: 'right', valign: 'top' }), 0,
    'valign-skip: 没有 bm-floated 不偏移');
  eq(host.style.marginTop, undefined, 'valign-skip: 没有 bm-floated 不写样式');
}

function tSkipDetached() {
  const { host, embed } = makeHost({ imgH: 151, rootTexts: [rootText(60, 30)] });
  host.isConnected = false;                   // 挂载那一刻还没连进文档
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 48.29, lh: '48.29px' }]);
  eq(I.applyValignLayout(host, { float: 'right', valign: 'top' }), 0,
    'valign-skip: 未连进文档当 bottom');
  eq(host.style.marginTop, undefined, 'valign-skip: 未连进文档不写样式');
  ok(!host.__bmValignInfo, 'valign-skip: 未连进文档不记诊断（还没量）');
}

function tSkipNoHost() {
  // 没给宿主 / 没给 cfg：静默返回，不抛
  let threw = false;
  try {
    I.applyValignLayout(null, { float: 'right', valign: 'top' });
    I.applyValignLayout({}, { float: 'right', valign: 'top' });
    I.applyValignLayout({ style: {} }, null);
  } catch (e) { threw = true; }
  ok(!threw, 'valign-skip: 宿主或 cfg 缺失也不抛错');
}

/* ------------------------------ 与 applyFloatLayout 的账 ------------------------------ */

function tOrderAfterShorthand() {
  const { host, embed } = makeHost({ imgH: 151, rootTexts: [rootText(60, 30)] });
  host.classList._list.length = 0;
  withComputed(host.parentElement.parentElement, { lineHeight: '48.29px', fontSize: '30px' });
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 48.29, lh: '48.29px' }]);

  const cfg = { float: 'right', width: 300, valign: 'top' };
  I.applyFloatLayout(host, cfg);
  I.applyValignLayout(host, cfg);

  const props = host.__bmFloatLayout.map((r) => r.prop);
  const atMargin = props.indexOf('margin');
  const atTop = props.lastIndexOf('marginTop');
  ok(atMargin >= 0 && atTop >= 0, 'valign-order: 两条记录都在账上', props.join(','));
  ok(atMargin < atTop, 'valign-order: margin 简写在前、margin-top 长属性在后', props.join(','));
  eq(host.style.margin, '0 0 0.5rem 1rem', 'valign-order: 简写没被改');
  eq(host.style.marginTop, '-102.71px', 'valign-order: 长属性生效');
}

function tRepeatNoDuplicate() {
  const { host, embed } = makeHost({ imgH: 151, rootTexts: [rootText(60, 30)] });
  host.classList._list.length = 0;
  withComputed(host.parentElement.parentElement, { lineHeight: '48.29px', fontSize: '30px' });
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 48.29, lh: '48.29px' }]);
  const cfg = { float: 'right', width: 300, valign: 'top' };

  I.applyFloatLayout(host, cfg);
  I.applyValignLayout(host, cfg);
  I.applyValignLayout(host, cfg);            // 同一宿主再调一次

  const tops = host.__bmFloatLayout.filter((r) => r.prop === 'marginTop');
  eq(tops.length, 1, 'valign-repeat: 重复调用只有一条 margin-top 记录');
  ok(host.__bmValignRec === tops[0], 'valign-repeat: 引用指向当前那条记录');
  eq(host.style.marginTop, '-102.71px', 'valign-repeat: 值没有叠加');
}

function tFloatRerunClearsValign() {
  const { host, embed } = makeHost({ imgH: 151, rootTexts: [rootText(60, 30)] });
  host.classList._list.length = 0;
  withComputed(host.parentElement.parentElement, { lineHeight: '48.29px', fontSize: '30px' });
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 48.29, lh: '48.29px' }]);
  const cfg = { float: 'right', width: 300, valign: 'top' };

  I.applyFloatLayout(host, cfg);
  I.applyValignLayout(host, cfg);
  // 重跑 applyFloatLayout：旧账全部还原（含 valign 那条），再重写简写
  I.applyFloatLayout(host, cfg);
  eq(host.style.marginTop, '', 'valign-rerun: 重跑 float 后旧偏移已还原（假 DOM 写回空串）');
  const props = host.__bmFloatLayout.map((r) => r.prop);
  eq(props.indexOf('marginTop'), -1, 'valign-rerun: 新账里没有残留的 margin-top');
}

/* ------------------------------ 重写 float 后补写 / 诊断字段 ------------------------------ */

function tReapplyKeepsValign() {
  const { host, embed } = makeHost({ imgH: 151, rootTexts: [rootText(60, 30)] });
  host.classList._list.length = 0;
  withComputed(host.parentElement.parentElement, { lineHeight: '48.29px', fontSize: '30px' });
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 48.29, lh: '48.29px' }]);
  const cfg = { float: 'right', width: 300, valign: 'top' };

  I.applyFloatLayout(host, cfg);
  I.applyValignLayout(host, cfg);
  eq(host.style.marginTop, '-102.71px', 'valign-reapply: 首轮写下了 -102.71px');

  /* 设置页开关关一次再开：重写 float 会把旧账全还原，valign 必须跟着补写 */
  const doc = { querySelectorAll: () => [host] };
  const n = I.reapplyLivePreviewFloatLayout(doc);
  eq(n, 1, 'valign-reapply: 走了一遍宿主');
  eq(host.style.marginTop, '-102.71px', 'valign-reapply: 重写 float 后 valign 又补回去了');
  ok(host.classList.contains('bm-floated'), 'valign-reapply: 类名还在');

  const tops = host.__bmFloatLayout.filter((r) => r.prop === 'marginTop');
  eq(tops.length, 1, 'valign-reapply: 不会叠出第二条 margin-top 记录');
}

function tInfoFields() {
  const r = applyCase('middle');
  const info = r.info;
  eq(info.valign, 'middle', 'valign-info: 记下基准');
  eq(info.lineH, 48.29, 'valign-info: lineH 是正文行高，不是图高也不是后面那段文字的总高');
  eq(info.imgH, 151, 'valign-info: imgH 取宿主 rect 高');
  eq(info.yTitle, 75, 'valign-info: yTitle 取根文字中心相对图顶');
  eq(info.offset, -50.85, 'valign-info: offset 是真正写下去的数');
  eq(r.host.style.marginTop, '-50.85px', 'valign-info: 与样式里的值一致');

  // 不写 valign 时诊断记默认的 bottom
  const b = makeHost({ imgH: 151, rootTexts: [rootText(60, 30)] });
  withComputed(b.content, { lineHeight: '48.29px', fontSize: '30px' });
  b.embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 48.29, lh: '48.29px' }]);
  I.applyValignLayout(b.host, { float: 'right' });
  eq(b.host.__bmValignInfo.valign, 'bottom', 'valign-info: 缺省记 bottom');
  eq(b.host.style.marginTop, undefined, 'valign-info: 缺省 bottom 不写样式');
}

/* ------------------------------ 渲染出来的根节点标记 ------------------------------ */

function tRootMarkup() {
  const built = I.buildSvg(I.parseSource('title: 图题\n- 父\n  - 子\n- 第二个根'), {
    measure: (t) => String(t).length * 10,
    measureBold: (t) => String(t).length * 10,
  });
  const all = (built.markup.match(/<text class="bm-text"/g) || []).length;
  const roots = (built.markup.match(/data-bm-root="1"/g) || []).length;
  eq(all, 3, 'valign-markup: 三个节点各一个 text');
  eq(roots, 2, 'valign-markup: 只有两个根节点带 data-bm-root');
  ok(/data-bm-root="1"[^>]*>/.test(built.markup), 'valign-markup: 标记落在 text 的标签里');
  ok(/<text class="bm-title"/.test(built.markup), 'valign-markup: 图题还是 bm-title');
  ok(!/class="bm-title"[^>]*data-bm-root/.test(built.markup),
    'valign-markup: 图题（title: 指令）不算一级标题');

  // 单根：只有一条标记
  const one = I.buildSvg(I.parseSource('- 父\n  - 子'), {
    measure: (t) => String(t).length * 10,
    measureBold: (t) => String(t).length * 10,
  });
  eq((one.markup.match(/data-bm-root="1"/g) || []).length, 1, 'valign-markup: 单根一条标记');
}

suite('valign-parse', tParseValign);
suite('valign-offset', tOffsetFormula);
suite('valign-offset-degenerate', tOffsetDegenerate);
suite('valign-line', tLineHeightSource);
suite('valign-title', tTitleCenter);
suite('valign-apply', () => { tApplyThreeModes(); tApplyMultipleRoots(); tApplyDegenerate(); });
suite('valign-skip', () => {
  tSkipModes(); tSkipNoEditor(); tSkipNotFloated(); tSkipDetached(); tSkipNoHost();
});
suite('valign-order', () => { tOrderAfterShorthand(); tRepeatNoDuplicate(); tFloatRerunClearsValign(); });
suite('valign-reapply', tReapplyKeepsValign);
suite('valign-info', tInfoFields);
suite('valign-markup', tRootMarkup);
