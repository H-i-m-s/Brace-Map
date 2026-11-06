'use strict';

/* ============================================================
 * float.test.js · 图文混排（浮动 / 居中 / 行内 / 定宽）
 *
 * 指令词对齐 Blue Topaz 主题的图片浮动（L / R / C / inl），
 * 这样写图片和写括号图只需要记一套。
 * ============================================================ */

const { I, ok, eq, suite } = require('./framework');

function fakeHost() {
  const cls = [];
  const style = {};
  return {
    style,
    classList: {
      add: (c) => { if (cls.indexOf(c) < 0) cls.push(c); },
      has: (c) => cls.indexOf(c) >= 0,
    },
    _cls: cls,
  };
}

function tParseFloat() {
  const cases = [
    ['R', 'right'], ['r', 'right'], ['right', 'right'], ['Right', 'right'], ['RIGHT', 'right'],
    ['L', 'left'], ['l', 'left'], ['left', 'left'], ['LEFT', 'left'],
    ['C', 'center'], ['center', 'center'], ['centre', 'center'], ['Center', 'center'],
    ['inl', 'inline'], ['inline', 'inline'], ['INL', 'inline'],
  ];
  for (const [raw, want] of cases) {
    const cfg = I.parseSource('float: ' + raw + '\n- 父\n  - 子');
    eq(cfg.float, want, 'float-parse: ' + raw + ' → ' + want);
  }

  // 不认识的值当没写，不报错
  eq(I.parseSource('float: 左上\n- 父').float, '', 'float-parse: 非法值忽略');

  // 不写就是空串
  eq(I.parseSource('- 父').float, '', 'float-parse: 不写时不浮动');
}

function tParseWidth() {
  eq(I.parseSource('width: 400\n- 父').width, 400, 'float-parse: width 取数值');
  eq(I.parseSource('width: 400px\n- 父').width, 400, 'float-parse: width 带 px 也认');
  eq(I.parseSource('width: 0\n- 父').width, 0, 'float-parse: 0 当没写');
  eq(I.parseSource('width: -5\n- 父').width, 0, 'float-parse: 负数忽略');
  eq(I.parseSource('width: abc\n- 父').width, 0, 'float-parse: 非数字忽略');
  eq(I.parseSource('- 父').width, 0, 'float-parse: 不写宽度为 0');
}

function tApplyRight() {
  const host = fakeHost();
  I.applyFloatLayout(host, { float: 'right', width: 400 });
  eq(host.style.float, 'right', 'float-apply: 右浮动');
  eq(host.style.width, '400px', 'float-apply: 宽度带上 px');
  eq(host.style.clear, 'both', 'float-apply: 清掉前面的浮动');
  ok(/0\.5rem 0 0\.5rem 1rem/.test(host.style.margin),
    'float-apply: 左边留出文字间距（与主题一致）', host.style.margin);
  ok(host.classList.has('bm-float-right'), 'float-apply: 打上方向类名');
}

function tApplyLeft() {
  const host = fakeHost();
  I.applyFloatLayout(host, { float: 'left', width: 300 });
  eq(host.style.float, 'left', 'float-apply: 左浮动');
  ok(/0\.5rem 1rem 0\.5rem 0/.test(host.style.margin),
    'float-apply: 右边留出文字间距', host.style.margin);
}

function tApplyCenter() {
  const host = fakeHost();
  I.applyFloatLayout(host, { float: 'center', width: 500 });
  eq(host.style.float, 'none', 'float-apply: 居中不走 float');
  eq(host.style.display, 'block', 'float-apply: 居中独占一行');
  ok(/auto/.test(host.style.margin), 'float-apply: 水平 auto 居中', host.style.margin);
}

function tApplyInline() {
  const host = fakeHost();
  I.applyFloatLayout(host, { float: 'inline', width: 0 });
  eq(host.style.float, 'none', 'float-apply: 行内不浮动');
  eq(host.style.display, 'inline-block', 'float-apply: 行内块，跟着文字走');
  ok(host.classList.has('bm-float-inline'), 'float-apply: 打上行内类名');
}

function tApplyNone() {
  // 不写 float：一个样式都不该碰，避免污染代码块原有的排版
  const host = fakeHost();
  I.applyFloatLayout(host, { float: '', width: 0 });
  eq(Object.keys(host.style).length, 0, 'float-apply: 不浮动时不动样式');
  eq(host._cls.length, 0, 'float-apply: 不浮动时不加类名');
}

function tWidthCap() {
  // 定宽不能把图撑出正文区
  const host = fakeHost();
  I.applyFloatLayout(host, { float: 'right', width: 2000 });
  eq(host.style.maxWidth, '100%', 'float-apply: 宽度上限锁在 100%');
}

function tOnlyHost() {
  // 没给 host 时静默返回，不能抛
  let threw = false;
  try {
    I.applyFloatLayout(null, { float: 'right', width: 100 });
    I.applyFloatLayout({}, { float: 'right', width: 100 });
  } catch (e) { threw = true; }
  ok(!threw, 'float-apply: 没有宿主也不抛错');
}

suite('float-parse', () => { tParseFloat(); tParseWidth(); });
suite('float-apply', () => {
  tApplyRight(); tApplyLeft(); tApplyCenter(); tApplyInline(); tApplyNone(); tWidthCap(); tOnlyHost();
});
