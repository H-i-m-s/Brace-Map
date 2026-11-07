'use strict';

/* ============================================================
 * valign.test.js · 浮动图的垂直基准（上 / 中 / 下）
 *
 * 测量依赖真实 DOM，这里只测纯计算 + 假 DOM 上的分支与记账：
 *   - 解析与默认值
 *   - valignOffset 的数值
 *   - center / inline / 非编辑模式不写偏移
 *   - 偏移走 setInlineStyle，resetFloatLayout 能还原
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

function makeHost() {
  const editor = { classList: fakeClassList(['cm-editor']), parentElement: null };
  const embed = {
    classList: fakeClassList(['cm-embed-block']),
    parentElement: editor,
    nextElementSibling: null,
  };
  const host = {
    style: {},
    classList: fakeClassList(['bm-floated', 'bm-float-right']),
    parentElement: embed,
    isConnected: true,
    getBoundingClientRect: () => ({ width: 100, height: 100, left: 0, top: 0 }),
  };
  return { host, embed, editor };
}

/* ------------------------------ 解析 ------------------------------ */

function tParseValign() {
  eq(I.parseSource('valign: top\n- 父').valign, 'top', 'valign-parse: top');
  eq(I.parseSource('valign: middle\n- 父').valign, 'middle', 'valign-parse: middle');
  eq(I.parseSource('valign: bottom\n- 父').valign, 'bottom', 'valign-parse: bottom');
  eq(I.parseSource('valign: MIDDLE\n- 父').valign, 'middle', 'valign-parse: 大小写不敏感');
  eq(I.parseSource('valign: 居中\n- 父').valign, 'top', 'valign-parse: 非法值回落到 top');
  eq(I.parseSource('valign: center\n- 父').valign, 'top', 'valign-parse: center 不是合法值');
  eq(I.parseSource('- 父').valign, 'top', 'valign-parse: 不写默认 top');
}

/* ------------------------------ 纯计算 ------------------------------ */

function tOffset() {
  eq(I.valignOffset(300, 100, 'top'), 0, 'valign-offset: top 永远是 0');
  eq(I.valignOffset(300, 100, 'middle'), -100, 'valign-offset: middle 取差值一半');
  eq(I.valignOffset(300, 100, 'bottom'), -200, 'valign-offset: bottom 取整个差值');
  eq(I.valignOffset(200, 100, 'middle'), -50, 'valign-offset: 差值 100 时 middle 为 -50');
  eq(I.valignOffset(200, 100, 'bottom'), -100, 'valign-offset: 差值 100 时 bottom 为 -100');
  eq(I.valignOffset(150, 100, 'middle'), -25, 'valign-offset: 奇数差也能对半');
}

function tOffsetNoRoom() {
  // textH <= imgH：一律 0，绝不把图往下推
  for (const v of ['top', 'middle', 'bottom']) {
    eq(I.valignOffset(100, 100, v), 0, 'valign-offset: 等高时 ' + v + ' 为 0');
    eq(I.valignOffset(80, 100, v), 0, 'valign-offset: 文字更矮时 ' + v + ' 为 0');
    eq(I.valignOffset(0, 100, v), 0, 'valign-offset: 量不到文字时 ' + v + ' 为 0');
  }
  eq(I.valignOffset(NaN, 100, 'middle'), 0, 'valign-offset: 非数字当 0');
  eq(I.valignOffset(300, 100, 'bogus'), 0, 'valign-offset: 非法基准当 top');
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

/* ------------------------------ 写样式 ------------------------------ */

function tApplyMiddle() {
  const { host, embed } = makeHost();
  embed.nextElementSibling = fakeChain([
    { cls: ['cm-line'], h: 120 },
    { cls: ['cm-line'], h: 80 },
  ]);
  const off = I.applyValignLayout(host, { float: 'right', valign: 'middle' });
  eq(off, -50, 'valign-apply: middle 往回提差值一半');
  eq(host.style.marginTop, '-50px', 'valign-apply: 写进 margin-top');
  eq(host.__bmValignInfo.textH, 200, 'valign-apply: 诊断记下 textH');
  eq(host.__bmValignInfo.imgH, 100, 'valign-apply: 诊断记下 imgH');

  // 复位：margin-top 由 setInlineStyle 记过账，能还回去
  const n = I.resetFloatLayout(host);
  ok(n > 0, 'valign-apply: resetFloatLayout 复位了样式', String(n));
  eq(host.style.marginTop, '', 'valign-apply: 复位后不留写死的 margin-top');
}

function tApplyBottom() {
  const { host, embed } = makeHost();
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 200 }]);
  eq(I.applyValignLayout(host, { float: 'left', valign: 'bottom' }), -100,
    'valign-apply: bottom 往回提整个差值');
  eq(host.style.marginTop, '-100px', 'valign-apply: bottom 写进 margin-top');
}

function tApplyTop() {
  const { host, embed } = makeHost();
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 200 }]);
  eq(I.applyValignLayout(host, { float: 'right', valign: 'top' }), 0,
    'valign-apply: top 不偏移');
  eq(host.style.marginTop, undefined, 'valign-apply: top 不动 margin-top');
}

function tApplyNoRoom() {
  const { host, embed } = makeHost();
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 60 }]);
  eq(I.applyValignLayout(host, { float: 'right', valign: 'bottom' }), 0,
    'valign-apply: 文字比图矮时不往下推');
  eq(host.style.marginTop, undefined, 'valign-apply: 没有可对齐空间时不写样式');
}

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
}

function tSkipDetached() {
  const { host, embed } = makeHost();
  host.isConnected = false;                   // 挂载那一刻还没连进文档
  embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 300 }]);
  eq(I.applyValignLayout(host, { float: 'right', valign: 'middle' }), 0,
    'valign-skip: 未连进文档当 top');
  eq(host.style.marginTop, undefined, 'valign-skip: 未连进文档不写样式');
}

suite('valign-parse', tParseValign);
suite('valign-offset', () => { tOffset(); tOffsetNoRoom(); });
suite('valign-measure', tMeasureFollow);
suite('valign-apply', () => { tApplyMiddle(); tApplyBottom(); tApplyTop(); tApplyNoRoom(); });
suite('valign-skip', () => {
  tSkipModes(); tSkipNoEditor(); tSkipNotFloated(); tSkipDetached();
});
