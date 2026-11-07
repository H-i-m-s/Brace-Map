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
 *   - 四个前置条件（float / .cm-content / bm-floated / 已连进文档）
 *   - 偏移走 setInlineStyle，顺序排在 margin 简写之后，resetFloatLayout 能还原
 *   - 尺寸观察器：算出偏移后只挂一个；尺寸变了才重算（防抖）；
 *     宿主被移除 / 复位后断开；偏移没变不重写；未连接时按 120/480/1200 补拍
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
  // yTitle 量不到（根节点在，但文字框高 0）：middle 退化为 bottom，top 照旧
  const mid = applyCase('middle', { rootTexts: [rootText(140, 0)] });
  eq(mid.off, 0, 'valign-apply-degenerate: yTitle 缺失时 middle 退化为 bottom');
  eq(mid.info.yTitle, null, 'valign-apply-degenerate: 诊断记 yTitle 为 null');
  const top = applyCase('top', { rootTexts: [rootText(140, 0)] });
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
  const { host, embed, editor, content } = makeHost({ imgH: 151, rootTexts: [rootText(60, 30)] });
  /* 阅读视图里既没有 .cm-editor 也没有 .cm-content。
     两者都得抹掉：判定看的是 .cm-content（climbTo 只爬 4 层，
     .cm-editor 在真实链路里够不着），只清 .cm-editor 测不出这个场景。 */
  editor.classList._list.length = 0;
  content.classList._list.length = 0;
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
  I.clearValignRetries(host);                 // 别让补拍在后面的用例里乱跑
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

/* ------------------------------ 尺寸观察器 ------------------------------ */

/** 假 ResizeObserver：只记账，手动 fire()，验「挂 / 断 / 防抖 / 不重算」 */
function installFakeRO() {
  const made = [];
  class FakeRO {
    constructor(cb) { this.cb = cb; this.targets = []; this.disconnected = 0; made.push(this); }
    observe(t) { if (this.targets.indexOf(t) < 0) this.targets.push(t); }
    unobserve(t) { const i = this.targets.indexOf(t); if (i >= 0) this.targets.splice(i, 1); }
    disconnect() { this.disconnected++; this.targets.length = 0; }
    fire() {
      if (!this.targets.length) return 0;
      const list = this.targets.map((t) => ({ target: t, contentRect: t.getBoundingClientRect() }));
      this.cb(list, this);
      return 1;
    }
  }
  const prev = global.ResizeObserver;
  global.ResizeObserver = FakeRO;
  return {
    made,
    restore() {
      if (prev === undefined) delete global.ResizeObserver;
      else global.ResizeObserver = prev;
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 能数「写了几次 margin-top」的 style：直接数赋值次数，不靠最终值猜 */
function styleCounter() {
  const counts = { set: 0 };
  const style = {};
  Object.defineProperty(style, 'marginTop', {
    configurable: true,
    get() { return this.__mt == null ? '' : this.__mt; },
    set(v) { counts.set++; this.__mt = v; },
  });
  return { style, counts };
}

/** 造一个能跑 valign 的案例：h=48.29、H=imgH、标题中心 75（imgH=151 时 top 写 -102.71） */
function observerCase(imgH) {
  const opts = { imgH: imgH == null ? 151 : imgH, rootTexts: [rootText(60, 30)] };
  const ctx = makeHost(opts);
  withComputed(ctx.content, { lineHeight: '48.29px', fontSize: '30px' });
  ctx.embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 40, lh: '48.29px' }]);
  const c = styleCounter();
  ctx.host.style = c.style;
  return { ctx, opts, counts: c.counts };
}

function tObserverAttachOnce() {
  const ro = installFakeRO();
  try {
    const k = observerCase();
    const cfg = { float: 'right', valign: 'top' };
    I.applyValignLayout(k.ctx.host, cfg);
    eq(k.counts.set, 1, 'valign-observer: 首次写一次 margin-top');
    eq(ro.made.length, 1, 'valign-observer: 算出偏移后挂一个观察器');
    eq(ro.made[0].targets.length, 1, 'valign-observer: 观察的是宿主自己');
    ok(ro.made[0].targets[0] === k.ctx.host, 'valign-observer: 目标就是 host');
    eq(k.ctx.host.__bmValignObs.fired, 0, 'valign-observer: 触发计数从 0 开始');

    // 同一份几何再算：不重写样式、不叠加观察器
    const before = k.counts.set;
    I.applyValignLayout(k.ctx.host, cfg);
    I.applyValignLayout(k.ctx.host, cfg);
    eq(k.counts.set, before, 'valign-observer: 偏移相同就不重复写样式');
    eq(ro.made.length, 1, 'valign-observer: 同一宿主只挂一个观察器');
  } finally { ro.restore(); }
}

async function tObserverRecompute() {
  const ro = installFakeRO();
  try {
    const k = observerCase(151);
    const cfg = { float: 'right', valign: 'top' };
    I.applyValignLayout(k.ctx.host, cfg);
    eq(k.ctx.host.style.marginTop, '-102.71px', 'valign-observer: 初始偏移 48.29 − 151');

    /* 图的自校准把图改高了：尺寸回调 → 16ms 防抖 → 重算 */
    k.opts.imgH = 200;
    const inst = ro.made[0];
    inst.fire();
    eq(k.ctx.host.__bmValignObs.fired, 1, 'valign-observer: 尺寸变化记一次触发');
    await sleep(60);
    eq(k.ctx.host.style.marginTop, '-151.71px', 'valign-observer: 图变高后偏移重算（48.29 − 200）');
    eq(k.ctx.host.__bmValignInfo.imgH, 200, 'valign-observer: 诊断记下新图高');
    eq(k.counts.set, 3, 'valign-observer: 值变了才重写（先还原旧值再写新值）');

    /* 再变一次、而且连着来：防抖只算一拍 */
    k.opts.imgH = 151;
    inst.fire();
    inst.fire();
    inst.fire();
    await sleep(60);
    eq(k.ctx.host.style.marginTop, '-102.71px', 'valign-observer: 连续回调只算一拍');
    eq(k.ctx.host.__bmValignObs.fired, 4, 'valign-observer: 三次回调都记了账');
  } finally { ro.restore(); }
}

async function tObserverDetached() {
  const ro = installFakeRO();
  try {
    const k = observerCase(151);
    I.applyValignLayout(k.ctx.host, { float: 'right', valign: 'top' });
    const before = k.counts.set;
    const inst = ro.made[0];

    k.ctx.host.isConnected = false;          // widget 重建，宿主被丢弃
    inst.fire();
    await sleep(60);
    eq(k.counts.set, before, 'valign-observer: 宿主被移除后不再写样式');
    eq(k.ctx.host.__bmValignObs ? 1 : 0, 0, 'valign-observer: 宿主被移除后观察器自己断开');
    eq(inst.disconnected, 1, 'valign-observer: disconnect 只叫一次');
    eq(inst.fire(), 0, 'valign-observer: 断开后不再投递回调（不报错）');
  } finally { ro.restore(); }
}

function tResetDisconnects() {
  const ro = installFakeRO();
  try {
    const k = observerCase(151);
    I.applyValignLayout(k.ctx.host, { float: 'right', valign: 'top' });
    eq(ro.made.length, 1, 'valign-reset: 观察器已挂');
    I.resetFloatLayout(k.ctx.host);
    eq(k.ctx.host.__bmValignObs ? 1 : 0, 0, 'valign-reset: resetFloatLayout 断开观察器');
    eq(ro.made[0].disconnected, 1, 'valign-reset: ResizeObserver.disconnect 已调用');
    eq(k.ctx.host.style.marginTop, '', 'valign-reset: margin-top 也复位了');
    eq(k.ctx.host.__bmValignInfo ? 1 : 0, 0, 'valign-reset: 诊断记录一起作废');
    eq(ro.made[0].fire(), 0, 'valign-reset: 断开后没有幽灵重算');
  } finally { ro.restore(); }
}

async function tDelayedMount() {
  const ro = installFakeRO();
  let host = null;
  try {
    const k = observerCase(151);
    host = k.ctx.host;
    host.isConnected = false;                // 渲染那一刻还没插进 .cm-content
    const cfg = { float: 'right', valign: 'top' };
    eq(I.applyValignLayout(host, cfg), 0, 'valign-mount: 未连接时算不出偏移');
    ok(host.__bmValignRetry, 'valign-mount: 排上首次补拍（120/480/1200）');
    eq(ro.made.length, 0, 'valign-mount: 没量到就不挂观察器');
    ok(!host.__bmValignInfo, 'valign-mount: 没量到就不写诊断');

    host.isConnected = true;                 // 插进文档
    await sleep(170);                        // 等第一拍（120ms）
    eq(host.style.marginTop, '-102.71px', 'valign-mount: 插入后补拍写下偏移');
    ok(!host.__bmValignRetry, 'valign-mount: 连上后撤掉剩下的补拍');
    eq(ro.made.length, 1, 'valign-mount: 插入后挂上尺寸观察器');
    eq(host.__bmValignInfo.lineH, 48.29, 'valign-mount: 补拍量到了行高');
    eq(k.counts.set, 1, 'valign-mount: 只写一次');
  } finally {
    if (host) I.clearValignRetries(host);
    ro.restore();
  }
}

function tObserverNoApi() {
  // 没有 ResizeObserver 的环境（老浏览器 / 假 DOM）：不挂、不报错，其余照旧
  const prev = global.ResizeObserver;
  delete global.ResizeObserver;
  try {
    const k = observerCase(151);
    near(I.applyValignLayout(k.ctx.host, { float: 'right', valign: 'top' }), -102.71,
      'valign-noapi: 没有 ResizeObserver 也照样写偏移');
    ok(!k.ctx.host.__bmValignObs, 'valign-noapi: 没挂观察器');
    eq(k.counts.set, 1, 'valign-noapi: 样式只写一次');
  } finally {
    if (prev !== undefined) global.ResizeObserver = prev;
  }
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

/* ------------------------------ 没准备好时保留上一次的结果 ------------------------------ */

/**
 * 真机上「生效过又被撤回」的那条路：观察器回调里量到图高 0 / 无根节点，
 * 以前会把已经写好的 margin-top 还原掉、并用一条全 0 的记录盖掉 __bmValignInfo。
 * 现在这种时刻直接返回（not-ready）：不记账、不还原、不写样式。
 */
function tNotReadyKeepsPrevious() {
  I.vtReset();
  const k = observerCase(150.89);      // 图高 150.89，根文字中心 60+15=75
  const host = k.ctx.host;
  const cfg = { float: 'right', valign: 'top' };
  I.applyFloatLayout(host, cfg);

  /* 1) 准备好了：正常写 */
  const off1 = I.applyValignLayout(host, cfg, false, 'render');
  near(off1, 48.29 - 150.89, 'valign-ready: 第一次算出 h − H');
  eq(host.style.marginTop, '-102.6px', 'valign-ready: 第一次写下 -102.6px');
  eq(k.counts.set, 1, 'valign-ready: 只写了一次');
  const info1 = host.__bmValignInfo;
  ok(info1 && info1.imgH === 150.89, 'valign-ready: 记下了真实的图高');
  eq(info1.offset, -102.6, 'valign-ready: 记录里的偏移也对');

  /* 2) 图那一刻不在文档里 / 还没重建好：图高 0、无根节点 */
  k.opts.imgH = 0;
  k.opts.rootTexts = [];
  eq(I.applyValignLayout(host, cfg, true, 'observer'), 0, 'valign-not-ready: 返回 0');
  eq(host.style.marginTop, '-102.6px', 'valign-not-ready: 已写好的 margin-top 被保住');
  eq(k.counts.set, 1, 'valign-not-ready: 一个字节都没重写（没有先还原再写）');
  ok(host.__bmValignInfo === info1, 'valign-not-ready: __bmValignInfo 仍是上一次那份（同一个对象）');
  eq(host.__bmValignInfo.imgH, 150.89, 'valign-not-ready: 记录里的图高没被 0 盖掉');
  eq(host.__bmValignInfo.yTitle, 75, 'valign-not-ready: 记录里的 yTitle 也没被 NaN 盖掉');
  ok(host.__bmValignRec, 'valign-not-ready: margin-top 的账还挂着，没被摘掉');

  /* 3) 图回来了，几何和上次一模一样：值没变就不重写 */
  k.opts.imgH = 150.89;
  k.opts.rootTexts = [rootText(60, 30)];
  const off3 = I.applyValignLayout(host, cfg, true, 'observer');
  near(off3, -102.6, 'valign-restored: 恢复后的偏移与上次相同');
  eq(host.style.marginTop, '-102.6px', 'valign-restored: 仍然是 -102.6px');
  eq(k.counts.set, 1, 'valign-restored: 值没变，没有重写');

  /* 4) 图真的变高了：重新算，写入新值 */
  k.opts.imgH = 300;
  const off4 = I.applyValignLayout(host, cfg, true, 'observer');
  near(off4, 48.29 - 300, 'valign-grow: 图高 300 后重新算');
  eq(host.style.marginTop, '-251.71px', 'valign-grow: 写入新值 -251.71px');
  eq(k.counts.set, 3, 'valign-grow: 先还原旧值再写新值（两次赋值）');
  eq(host.__bmValignInfo.imgH, 300, 'valign-grow: 记录跟着更新');

  const exits = I.vtRows().map((r) => r.exit);
  eq(exits, ['write', 'not-ready', 'same', 'write'], 'valign-not-ready: 轨迹里四个分支依次出现');
  const nr = I.vtRows()[1];
  eq(nr.probe.imgH, 0, 'valign-not-ready: 轨迹里 not-ready 那条 imgH 记 0');
  eq(nr.probe.roots, 0, 'valign-not-ready: 轨迹里 not-ready 那条 roots 记 0');
  eq(nr.src, 'observer', 'valign-not-ready: 入口是 observer');
  eq(nr.wrote, false, 'valign-not-ready: 它没有写样式');
}

/**
 * middle 档的同一条路：用真机轨迹里的那组数（图高 150.89、yTitle 73 → -57.25）。
 * middle 不看图高，所以保留的是标题中心那个量，被 not-ready 刮掉的后果一样明显。
 */
function tNotReadyMiddle() {
  I.vtReset();
  const opts = { imgH: 150.89, rootTexts: [rootText(58, 30)] };   // 文字中心 73
  const b = makeHost(opts);
  withComputed(b.content, { lineHeight: '31.5px', fontSize: '30px' });
  b.embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 31.5, lh: '31.5px' }]);
  const cfg = { float: 'right', valign: 'middle' };
  I.applyFloatLayout(b.host, cfg);

  near(I.applyValignLayout(b.host, cfg, false, 'render'), 15.75 - 73, 'valign-middle: 三档里 middle 写 −57.25');
  eq(b.host.style.marginTop, '-57.25px', 'valign-middle: 写进 margin-top 的就是 -57.25px');
  const info1 = b.host.__bmValignInfo;

  opts.imgH = 0;
  opts.rootTexts = [];
  eq(I.applyValignLayout(b.host, cfg, true, 'observer'), 0, 'valign-middle: not-ready 时返回 0');
  eq(b.host.style.marginTop, '-57.25px', 'valign-middle: -57.25px 被保住');
  ok(b.host.__bmValignInfo === info1, 'valign-middle: 记录没被覆盖');
  eq(I.vtRows()[1].exit, 'not-ready', 'valign-middle: 轨迹记 not-ready');
}

/** bottom 档在新判据下行为不变：准备好了照样不写样式，没准备好也不动任何东西 */
function tNotReadyBottom() {
  I.vtReset();
  const k = observerCase(150);
  const host = k.ctx.host;
  const cfg = { float: 'right', valign: 'bottom' };
  I.applyFloatLayout(host, cfg);

  eq(I.applyValignLayout(host, cfg, false, 'render'), 0, 'valign-bottom: bottom 档偏移恒为 0');
  eq(k.counts.set, 0, 'valign-bottom: 一个样式都不写');
  eq(host.__bmValignInfo.imgH, 150, 'valign-bottom: 照样记账（图高量到了）');
  eq(host.__bmValignInfo.offset, 0, 'valign-bottom: 偏移记 0');
  eq(I.vtRows()[0].exit, 'offset=0', 'valign-bottom: 准备好了记 offset=0');
  const info1 = host.__bmValignInfo;

  k.opts.imgH = 0;
  k.opts.rootTexts = [];
  eq(I.applyValignLayout(host, cfg, true, 'observer'), 0, 'valign-bottom: not-ready 也返回 0');
  eq(k.counts.set, 0, 'valign-bottom: not-ready 时也没写样式');
  ok(host.__bmValignInfo === info1, 'valign-bottom: not-ready 不覆盖记录');
  eq(I.vtRows()[1].exit, 'not-ready', 'valign-bottom: 轨迹记 not-ready');
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
suite('valign-observer', () => {
  tObserverAttachOnce();
  return tObserverRecompute().then(() => tObserverDetached());
});
suite('valign-observer-reset', tResetDisconnects);
suite('valign-mount', tDelayedMount);
suite('valign-noapi', tObserverNoApi);
suite('valign-markup', tRootMarkup);
suite('valign-not-ready', tNotReadyKeepsPrevious);
suite('valign-not-ready-middle', tNotReadyMiddle);
suite('valign-not-ready-bottom', tNotReadyBottom);
