'use strict';

/* ============================================================
 * valign.test.js · 浮动图的垂直基准（上 / 中 / 下）
 *
 * 真实排版靠浏览器，这里测的是纯计算 + 假 DOM 上的分支与记账：
 *   - 解析与默认值
 *   - valignOffset 的数值
 *   - 四个前置条件（float / .cm-editor / bm-floated / 已连进文档）
 *   - 偏移走 setInlineStyle，顺序排在 margin 简写之后，resetFloatLayout 能还原
 * 浏览器里那几条（embed 高为 0、文字仍绕排、图不被裁）见 doc 里的实测数据。
 * ============================================================ */

const { I, ok, eq, suite } = require('./framework');

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

/** 一个带高度、带 class 的兄弟节点 */
function fakeLine(names, h, next) {
  return {
    classList: fakeClassList(names),
    nextElementSibling: next || null,
    getBoundingClientRect: () => ({ width: 100, height: h, left: 0, top: 0 }),
  };
}

/** 按顺序把 [{cls, h}] 串成 nextElementSibling 链，返回第一个 */
function fakeChain(items) {
  let next = null;
  for (let i = items.length - 1; i >= 0; i--) {
    next = fakeLine(items[i].cls, items[i].h, next);
  }
  return next;
}

/**
 * host → .cm-embed-block → .cm-content → .cm-scroller → .cm-editor
 * 和 CM6 的真实层级一致（climbTo 默认只爬 4 层，多一层就找不到编辑器）。
 */
function makeHost() {
  const editor = { classList: fakeClassList(['cm-editor']), parentElement: null };
  const scroller = { classList: fakeClassList(['cm-scroller']), parentElement: editor };
  const content = { classList: fakeClassList(['cm-content']), parentElement: scroller };
  const embed = {
    classList: fakeClassList(['cm-embed-block']),
    parentElement: content,
    nextElementSibling: null,
  };
  const host = {
    style: {},
    classList: fakeClassList(['bm-floated', 'bm-float-right']),
    parentElement: embed,
    isConnected: true,
    getBoundingClientRect: () => ({ width: 100, height: 100, left: 0, top: 0 }),
  };
  return { host, embed, content, scroller, editor };
}

/* ------------------------------ 解析 ------------------------------ */

function tParseValign() {
  eq(I.parseSource('valign: top\n- 父').valign, 'top', 'valign-parse: top');
  eq(I.parseSource('valign: middle\n- 父').valign, 'middle', 'valign-parse: middle');
  eq(I.parseSource('valign: bottom\n- 父').valign, 'bottom', 'valign-parse: bottom');
  eq(I.parseSource('valign: MIDDLE\n- 父').valign, 'middle', 'valign-parse: 大小写不敏感');
  eq(I.parseSource('valign: Bottom\n- 父').valign, 'bottom', 'valign-parse: 首字母大写也认');
  eq(I.parseSource('valign: 居中\n- 父').valign, 'top', 'valign-parse: 非法值回落到 top');
  eq(I.parseSource('valign: center\n- 父').valign, 'top', 'valign-parse: center 不是合法值');
  eq(I.parseSource('- 父').valign, 'top', 'valign-parse: 不写默认 top');

  // 与 float 一起写时的独立性
  const cfg = I.parseSource('float: right\nvalign: middle\n- 父\n  - 子');
  eq([cfg.float, cfg.valign], ['right', 'middle'], 'valign-parse: 与 float 各管各的');
  // 白名单里认它：缩进里的 valign 仍是指令，不会被续行吞掉
  const c2 = I.parseSource('- 父\n  - 子\n    valign: bottom');
  eq([c2.roots[0].children[0].text, c2.valign], ['子', 'bottom'],
    'valign-parse: 缩进写也算指令（不进正文）');
}

/* ------------------------------ 纯计算 ------------------------------ */

function tOffset() {
  eq(I.valignOffset(300, 100, 'top'), 0, 'valign-offset: top 永远是 0');
  eq(I.valignOffset(300, 100, 'middle'), 100, 'valign-offset: middle 往下推差值一半');
  eq(I.valignOffset(300, 100, 'bottom'), 200, 'valign-offset: bottom 往下推整个差值');
  eq(I.valignOffset(200, 100, 'middle'), 50, 'valign-offset: 差值 100 时 middle 为 50');
  eq(I.valignOffset(200, 100, 'bottom'), 100, 'valign-offset: 差值 100 时 bottom 为 100');
  eq(I.valignOffset(150, 100, 'middle'), 25, 'valign-offset: 奇数差也能对半');
  eq(I.valignOffset(408, 202.78, 'middle'), 102.61, 'valign-offset: 小数差值照样算');
  ok(I.valignOffset(300, 100, 'middle') > 0, 'valign-offset: middle 是正数（往下推）');
  ok(I.valignOffset(300, 100, 'bottom') > 0, 'valign-offset: bottom 是正数（往下推）');
}

function tOffsetNoRoom() {
  // textH <= imgH：一律 0，绝不把图往下推
  for (const v of ['top', 'middle', 'bottom']) {
    eq(I.valignOffset(100, 100, v), 0, 'valign-offset: 等高时 ' + v + ' 为 0');
    eq(I.valignOffset(80, 100, v), 0, 'valign-offset: 文字更矮时 ' + v + ' 为 0');
    eq(I.valignOffset(0, 100, v), 0, 'valign-offset: 量不到文字时 ' + v + ' 为 0');
  }
  eq(I.valignOffset(NaN, 100, 'middle'), 0, 'valign-offset: 非数字当 0');
  eq(I.valignOffset(300, NaN, 'middle'), 0, 'valign-offset: 图高非数字当 0');
  eq(I.valignOffset(300, 100, 'bogus'), 0, 'valign-offset: 非法基准当 top');
  eq(I.valignOffset(300, 100, ''), 0, 'valign-offset: 空基准当 top');
}

/* 反向对照：图比文字段高（或等高）时，三档一律不推 */
function tOffsetImageTaller() {
  for (const v of ['top', 'middle', 'bottom']) {
    eq(I.valignOffset(120, 300, v), 0, 'valign-tall: 图更高时 ' + v + ' 为 0');
    eq(I.valignOffset(300, 300, v), 0, 'valign-tall: 等高时 ' + v + ' 为 0');
  }

  // 应用层也要真的不写样式：图比文字高，推下去只会把图推到文字块外面
  for (const v of ['middle', 'bottom']) {
    const { host, embed } = makeHost();
    embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 40 }]);
    eq(I.applyValignLayout(host, { float: 'right', valign: v }), 0,
      'valign-tall: 应用时 ' + v + ' 不写偏移');
    eq(host.style.marginTop, undefined, 'valign-tall: ' + v + ' 不碰 margin-top');
    eq(host.__bmValignInfo.applied, false, 'valign-tall: ' + v + ' 诊断记未写样式');
  }
}

/* ------------------------------ 测量 ------------------------------ */

function tMeasureFollow() {
  const { embed } = makeHost();
  embed.nextElementSibling = fakeChain([
    { cls: ['cm-line'], h: 120 },
    { cls: ['cm-line', 'cm-activeLine'], h: 80 },
    { cls: ['cm-embed-block'], h: 500 },
    { cls: ['cm-line'], h: 1000 },
  ]);
  eq(I.measureFollowTextHeight(embed), 200, 'valign-measure: 只累加 cm-line，遇到别的就停');
  eq(I.measureFollowTextHeight(null), 0, 'valign-measure: 没有 embed 返回 0');
}

function tMeasureStopFirst() {
  // 第一个兄弟就不是 cm-line：立刻停，0
  const { embed } = makeHost();
  embed.nextElementSibling = fakeChain([{ cls: ['cm-embed-block'], h: 500 }]);
  eq(I.measureFollowTextHeight(embed), 0, 'valign-measure: 首个兄弟不是 cm-line 即为 0');

  // 后面没有兄弟
  const b = makeHost();
  eq(I.measureFollowTextHeight(b.embed), 0, 'valign-measure: 没有后续兄弟为 0');
}

/* ------------------------------ 写样式 ------------------------------ */

function tApplyMiddle() {
  const { host, embed } = makeHost();
  embed.nextElementSibling = fakeChain([
    { cls: ['cm-line'], h: 120 },
    { cls: ['cm-line'], h: 80 },
  ]);
  const off = I.applyValignLayout(host, { float: 'right', valign: 'middle' });
  eq(off, 50, 'valign-apply: middle 往下推差值一半');
  eq(host.style.marginTop, '50px', 'valign-apply: 写进 margin-top');
  eq(host.__bmValignInfo.textH, 200, 'valign-apply: 诊断记下 textH');
  eq(host.__bmValignInfo.imgH, 100, 'valign-apply: 诊断记下 imgH');
  eq(host.__bmValignInfo.offset, 50, 'valign-apply: 诊断记下实际偏移');
  eq(host.__bmValignInfo.applied, true, 'valign-apply: 诊断记下写了样式');

  // 复位：margin-top 由 setInlineStyle 记过账，能还回去
  const n = I.resetFloatLayout(host);
  ok(n > 0, 'valign-apply: resetFloatLayout 复位了样式', String(n));
  eq(host.style.marginTop, '', 'valign-apply: 复位后不留写死的 margin-top');
}

function tApplyBottom() {
  const { host, embed } = makeHost();
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 200 }]);
  eq(I.applyValignLayout(host, { float: 'left', valign: 'bottom' }), 100,
    'valign-apply: bottom 往下推整个差值');
  eq(host.style.marginTop, '100px', 'valign-apply: bottom 写进 margin-top');
}

function tApplyTop() {
  const { host, embed } = makeHost();
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 200 }]);
  eq(I.applyValignLayout(host, { float: 'right', valign: 'top' }), 0,
    'valign-apply: top 不偏移');
  eq(host.style.marginTop, undefined, 'valign-apply: top 不动 margin-top');
  eq(host.__bmValignInfo.applied, false, 'valign-apply: top 时诊断记未写样式');
}

function tApplyNoRoom() {
  const { host, embed } = makeHost();
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 60 }]);
  eq(I.applyValignLayout(host, { float: 'right', valign: 'bottom' }), 0,
    'valign-apply: 文字比图矮时不往下推');
  eq(host.style.marginTop, undefined, 'valign-apply: 没有可对齐空间时不写样式');

  // 完全没有后续文字
  const b = makeHost();
  eq(I.applyValignLayout(b.host, { float: 'right', valign: 'middle' }), 0,
    'valign-apply: 量不到文字高度当 top');
  eq(b.host.style.marginTop, undefined, 'valign-apply: 量不到文字时不写样式');
}

/* ------------------------------ 前置条件 ------------------------------ */

function tSkipModes() {
  for (const mode of ['center', 'inline', '']) {
    const { host, embed } = makeHost();
    embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 300 }]);
    eq(I.applyValignLayout(host, { float: mode, valign: 'middle' }), 0,
      'valign-skip: float=' + (mode || '空') + ' 不做偏移');
    eq(Object.keys(host.style).length, 0, 'valign-skip: float=' + (mode || '空') + ' 不碰样式');
  }
}

function tSkipNoEditor() {
  const { host, embed, editor } = makeHost();
  editor.classList._list.length = 0;          // 不在 .cm-editor 里（阅读视图）
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 300 }]);
  eq(I.applyValignLayout(host, { float: 'right', valign: 'middle' }), 0,
    'valign-skip: 不在编辑模式不偏移');
  eq(host.style.marginTop, undefined, 'valign-skip: 阅读视图不碰 margin-top');
}

function tSkipNotFloated() {
  const { host, embed } = makeHost();
  host.classList.remove('bm-floated');        // float 没真的写上去
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 300 }]);
  eq(I.applyValignLayout(host, { float: 'right', valign: 'middle' }), 0,
    'valign-skip: 没有 bm-floated 不偏移');
  eq(host.style.marginTop, undefined, 'valign-skip: 没有 bm-floated 不写样式');
}

function tSkipDetached() {
  const { host, embed } = makeHost();
  host.isConnected = false;                   // 挂载那一刻还没连进文档
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 300 }]);
  eq(I.applyValignLayout(host, { float: 'right', valign: 'middle' }), 0,
    'valign-skip: 未连进文档当 top');
  eq(host.style.marginTop, undefined, 'valign-skip: 未连进文档不写样式');
}

function tSkipNoHost() {
  // 没给宿主 / 没给 cfg：静默返回，不抛
  let threw = false;
  try {
    I.applyValignLayout(null, { float: 'right', valign: 'middle' });
    I.applyValignLayout({}, { float: 'right', valign: 'middle' });
    I.applyValignLayout({ style: {} }, null);
  } catch (e) { threw = true; }
  ok(!threw, 'valign-skip: 宿主或 cfg 缺失也不抛错');
}

/* ------------------------------ 与 applyFloatLayout 的账 ------------------------------ */

function tOrderAfterShorthand() {
  const { host, embed } = makeHost();
  host.classList._list.length = 0;
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 300 }]);

  const cfg = { float: 'right', width: 300, valign: 'middle' };
  I.applyFloatLayout(host, cfg);
  I.applyValignLayout(host, cfg);

  const props = host.__bmFloatLayout.map((r) => r.prop);
  const atMargin = props.indexOf('margin');
  const atTop = props.lastIndexOf('marginTop');
  ok(atMargin >= 0 && atTop >= 0, 'valign-order: 两条记录都在账上', props.join(','));
  ok(atMargin < atTop, 'valign-order: margin 简写在前、margin-top 长属性在后', props.join(','));
  eq(host.style.margin, '0 0 0.5rem 1rem', 'valign-order: 简写没被改');
  eq(host.style.marginTop, '100px', 'valign-order: 长属性生效');
}

function tRepeatNoDuplicate() {
  const { host, embed } = makeHost();
  host.classList._list.length = 0;
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 300 }]);
  const cfg = { float: 'right', width: 300, valign: 'middle' };

  I.applyFloatLayout(host, cfg);
  I.applyValignLayout(host, cfg);
  I.applyValignLayout(host, cfg);            // 同一宿主再调一次

  const tops = host.__bmFloatLayout.filter((r) => r.prop === 'marginTop');
  eq(tops.length, 1, 'valign-repeat: 重复调用只有一条 margin-top 记录');
  ok(host.__bmValignRec === tops[0], 'valign-repeat: 引用指向当前那条记录');
  eq(host.style.marginTop, '100px', 'valign-repeat: 值没有叠加');
}

function tFloatRerunClearsValign() {
  const { host, embed } = makeHost();
  host.classList._list.length = 0;
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 300 }]);
  const cfg = { float: 'right', width: 300, valign: 'middle' };

  I.applyFloatLayout(host, cfg);
  I.applyValignLayout(host, cfg);
  // 重跑 applyFloatLayout：旧账全部还原（含 valign 那条），再重写简写
  I.applyFloatLayout(host, cfg);
  eq(host.style.marginTop, '', 'valign-rerun: 重跑 float 后旧偏移已还原（假 DOM 写回空串）');
  const props = host.__bmFloatLayout.map((r) => r.prop);
  eq(props.indexOf('marginTop'), -1, 'valign-rerun: 新账里没有残留的 margin-top');
}

/* ------------------------------ 诊断字段 ------------------------------ */

function tReapplyKeepsValign() {
  const { host, embed } = makeHost();
  host.classList._list.length = 0;
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 300 }]);
  const cfg = { float: 'right', width: 300, valign: 'bottom' };

  I.applyFloatLayout(host, cfg);
  I.applyValignLayout(host, cfg);
  eq(host.style.marginTop, '200px', 'valign-reapply: 首轮写下了 200px');

  /* 设置页开关关一次再开：重写 float 会把旧账全还原，valign 必须跟着补写 */
  const doc = { querySelectorAll: () => [host] };
  const n = I.reapplyLivePreviewFloatLayout(doc);
  eq(n, 1, 'valign-reapply: 走了一遍宿主');
  eq(host.style.marginTop, '200px', 'valign-reapply: 重写 float 后 valign 又补回去了');
  ok(host.classList.contains('bm-floated'), 'valign-reapply: 类名还在');

  const tops = host.__bmFloatLayout.filter((r) => r.prop === 'marginTop');
  eq(tops.length, 1, 'valign-reapply: 不会叠出第二条 margin-top 记录');
}

function tInfoFields() {
  const { host, embed } = makeHost();
  embed.nextElementSibling = fakeChain([
    { cls: ['cm-line'], h: 300 },
    { cls: ['cm-line'], h: 108 },
  ]);
  I.applyValignLayout(host, { float: 'right', valign: 'bottom' });
  const info = host.__bmValignInfo;
  eq(info.valign, 'bottom', 'valign-info: 记下基准');
  eq(info.textH, 408, 'valign-info: textH 是连续 cm-line 之和');
  eq(info.imgH, 100, 'valign-info: imgH 取宿主 rect 高');
  eq(info.offset, 308, 'valign-info: offset 是真正写下去的数');
  eq(host.style.marginTop, '308px', 'valign-info: 与样式里的值一致');

  // 不写 valign 时诊断记 top
  const b = makeHost();
  b.embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 300 }]);
  I.applyValignLayout(b.host, { float: 'right' });
  eq(b.host.__bmValignInfo.valign, 'top', 'valign-info: 缺省记 top');
}

suite('valign-parse', tParseValign);
suite('valign-offset', () => { tOffset(); tOffsetNoRoom(); tOffsetImageTaller(); });
suite('valign-measure', () => { tMeasureFollow(); tMeasureStopFirst(); });
suite('valign-apply', () => { tApplyMiddle(); tApplyBottom(); tApplyTop(); tApplyNoRoom(); });
suite('valign-skip', () => {
  tSkipModes(); tSkipNoEditor(); tSkipNotFloated(); tSkipDetached(); tSkipNoHost();
});
suite('valign-order', () => { tOrderAfterShorthand(); tRepeatNoDuplicate(); tFloatRerunClearsValign(); });
suite('valign-reapply', tReapplyKeepsValign);
suite('valign-info', tInfoFields);
