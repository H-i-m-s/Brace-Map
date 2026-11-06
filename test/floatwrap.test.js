'use strict';

/* ============================================================
 * floatwrap.test.js · 图文混排的纯逻辑
 *
 * 阅读视图里代码块宿主是 flex 容器的直接子项，CSS 的 float 在它身上不生效
 * （计算值仍是 right，布局上被当成 none），所以浮动改由 JS 模拟：
 * 宿主绝对定位 + 给后续兄弟加外边距。
 *
 * 真实布局只能靠浏览器验，这里测两件能用假 DOM 判定的事：
 *   1. collectWrapTargets：该给哪些后续块留白
 *   2. applyWrapMargins / restoreStyles：改了能不能复位干净
 * 另加 pickContext（定位祖先怎么挑）与几个「不该动手」的守卫。
 * ============================================================ */

const { I, ok, eq, suite } = require('./framework');

/* ------------------------------ 假元素 ------------------------------ */

/** 只有 offsetHeight 的块（没有 getBoundingClientRect） */
function block(h) {
  return { style: {}, offsetHeight: h, nextElementSibling: null };
}

/** 带 getBoundingClientRect 的块，用来验证「真实渲染高度」优先级 */
function rectBlock(renderH, offsetH) {
  const el = block(offsetH == null ? 0 : offsetH);
  el.getBoundingClientRect = () => ({
    height: renderH, width: 800, top: 0, left: 0, right: 800, bottom: renderH,
  });
  return el;
}

function chain(heights) {
  const els = heights.map((h) => block(h));
  for (let i = 0; i + 1 < els.length; i++) els[i].nextElementSibling = els[i + 1];
  return els;
}

/** 极简 style：普通对象 + removeProperty（删掉属性，模拟 CSSStyleDeclaration） */
function styleObj(init) {
  const s = Object.assign({}, init || {});
  s.__removed = [];
  s.removeProperty = (p) => {
    s.__removed.push(p);
    delete s[p.replace(/-([a-z])/g, (m, c) => c.toUpperCase())];
  };
  return s;
}

function marginBlock(h, init) {
  const el = block(h);
  el.style = styleObj(init);
  return el;
}

/* ------------------------------ 留白范围 ------------------------------ */

function tCollectGuard() {
  // 图高为 0 / 负数 / 非数：没有要绕的文字
  eq(I.collectWrapTargets(block(100), 0), [], 'wrap-target: 图高 0 → 空');
  eq(I.collectWrapTargets(block(100), -20), [], 'wrap-target: 图高负数 → 空');
  eq(I.collectWrapTargets(block(100), NaN), [], 'wrap-target: 图高 NaN → 空');
  eq(I.collectWrapTargets(block(100), undefined), [], 'wrap-target: 图高 undefined → 空');

  // 没有兄弟：空
  eq(I.collectWrapTargets(null, 100), [], 'wrap-target: 没有起点 → 空');
}

function tCollectBasic() {
  // 只有一个兄弟，且比图矮：带上它，然后自然结束（兄弟链到 null）
  const one = chain([100]);
  eq(I.collectWrapTargets(one[0], 500), [one[0]], 'wrap-target: 唯一兄弟也带上');

  // 三块 100，图 250 → 两块只累到 200，还得要第三块
  const three = chain([100, 100, 100]);
  const got = I.collectWrapTargets(three[0], 250);
  eq(got.length, 3, 'wrap-target: 高度不够就继续数');

  // 图 200 → 前两块刚好够，第三块不该被算
  const two = I.collectWrapTargets(three[0], 200);
  eq(two.length, 2, 'wrap-target: 累加到位就停');
  ok(two[0] === three[0] && two[1] === three[1], 'wrap-target: 返回的是原元素');

  // 图 260 → 三块全要
  eq(I.collectWrapTargets(three[0], 260).length, 3, 'wrap-target: 兄弟总高不足时全带上');

  // 图比所有兄弟都高（图高超过后续总和）：循环自然结束，不死循环
  eq(I.collectWrapTargets(three[0], 10000).length, 3, 'wrap-target: 图高超过总和 → 全部并结束');

  // 第一块就够高：只处理它
  const tall = chain([900, 100, 100]);
  eq(I.collectWrapTargets(tall[0], 100).length, 1, 'wrap-target: 第一块就盖住 → 只要一块');
}

function tCollectEdge() {
  // offsetHeight 为 0 的块不贡献高度，但也会被带上（宁可多留白，不压字）
  const zero = chain([0, 0, 300]);
  const got = I.collectWrapTargets(zero[0], 100);
  eq(got.length, 3, 'wrap-target: 零高块跳过累加但不清空');

  // 真实渲染高度优先于 offsetHeight（SVG 被 CSS 缩放时两者不等）
  const a = rectBlock(40, 100);
  const b = rectBlock(40, 100);
  a.nextElementSibling = b;
  eq(I.collectWrapTargets(a, 80).length, 2, 'wrap-target: 按 getBoundingClientRect 的高度累加');

  // 兄弟链成环（假 DOM 里可能造出来）：必须能停
  const x = block(10);
  const y = block(10);
  x.nextElementSibling = y;
  y.nextElementSibling = x;
  const cyc = I.collectWrapTargets(x, 1e9);
  eq(cyc.length, 2, 'wrap-target: 成环也能停');

  // limit 兜底
  const many = chain([1, 1, 1, 1, 1, 1, 1, 1]);
  eq(I.collectWrapTargets(many[0], 1e9, { limit: 3 }).length, 3, 'wrap-target: limit 生效');
}

/* ------------------------------ 外边距与复位 ------------------------------ */

function tMarginsApply() {
  const el = marginBlock(100);
  const entries = I.applyWrapMargins([el], 'right', 416);
  eq(entries.length, 1, 'wrap-margin: 一条记录');
  eq(el.style.marginRight, '416px', 'wrap-margin: 右浮动加 marginRight');
  eq(el.style.marginLeft, undefined, 'wrap-margin: 左浮动属性不动');

  const cleared = I.restoreWrapMargins(entries);
  eq(cleared, 1, 'wrap-margin: 复位一条');
  eq(el.style.marginRight, undefined, 'wrap-margin: 复位后行内值消失');
  ok(el.style.__removed.indexOf('margin-right') >= 0, 'wrap-margin: 走 removeProperty 复位');

  // 左浮动同理
  const left = marginBlock(100);
  const le = I.applyWrapMargins([left], 'left', 316);
  eq(left.style.marginLeft, '316px', 'wrap-margin: 左浮动加 marginLeft');
  I.restoreWrapMargins(le);
  eq(left.style.marginLeft, undefined, 'wrap-margin: 左边也能复位干净');
}

function tMarginsBase() {
  // 元素本来就有行内外边距：加在它上面，复位回原值（不是删掉）
  const el = marginBlock(100, { marginRight: '8px' });
  const e = I.applyWrapMargins([el], 'right', 416);
  eq(el.style.marginRight, '424px', 'wrap-margin: 叠加在原有行内值上');
  I.restoreWrapMargins(e);
  eq(el.style.marginRight, '8px', 'wrap-margin: 复位回原值');

  // 主题给的 rem / auto：行内读不出来，用 reader 拿 computed 值兜底
  const el2 = marginBlock(100);
  const e2 = I.applyWrapMargins([el2], 'right', 416, { reader: () => ({ left: 0, right: 20 }) });
  eq(el2.style.marginRight, '436px', 'wrap-margin: reader 覆盖基准值');
  I.restoreWrapMargins(e2);
  eq(el2.style.marginRight, undefined, 'wrap-margin: 复位仍干净');
}

function tMarginsMaxWidth() {
  // 主题把正文块写死 width: 820px 时，光加 margin 行盒不会变窄，
  // 必须同时把 max-width 收到剩余可用宽度
  const el = marginBlock(100);
  const entries = I.applyWrapMargins([el], 'right', 416, { limit: 820 });
  eq(el.style.marginRight, '416px', 'wrap-maxw: 外边距照加');
  eq(el.style.maxWidth, '404px', 'wrap-maxw: max-width = 正文宽 - 留白');
  eq(entries.length, 2, 'wrap-maxw: 两条记录（margin + max-width）');
  I.restoreWrapMargins(entries);
  ok(el.style.marginRight === undefined && el.style.maxWidth === undefined,
    'wrap-maxw: 两条都能复位');

  // 自身有左边距时要把它扣掉，否则总宽会超
  const el2 = marginBlock(100);
  I.applyWrapMargins([el2], 'left', 416, { limit: 820, reader: () => ({ left: 10, right: 0 }) });
  eq(el2.style.marginLeft, '426px', 'wrap-maxw: 左浮动叠在自身左边距上');
  eq(el2.style.maxWidth, '394px', 'wrap-maxw: 可用宽扣掉自身左边距');

  // 图比正文还宽：不给负的 max-width
  const el3 = marginBlock(100);
  I.applyWrapMargins([el3], 'right', 900, { limit: 820 });
  eq(el3.style.maxWidth, undefined, 'wrap-maxw: 算不出正值就不写 max-width');
}

function tMarginsGuard() {
  // 不需要留白（间距 <= 0）：一条样式都不碰
  const el = marginBlock(100, { marginRight: '8px' });
  eq(I.applyWrapMargins([el], 'right', 0), [], 'wrap-margin: 间距 0 → 不动');
  eq(I.applyWrapMargins([el], 'right', -5), [], 'wrap-margin: 负间距 → 不动');
  eq(el.style.marginRight, '8px', 'wrap-margin: 不动时原样式完好');

  // 目标为空 / 含 null：跳过，不抛
  eq(I.applyWrapMargins(null, 'right', 100), [], 'wrap-margin: 目标不是数组 → 空');
  const els = [null, marginBlock(10), undefined];
  const e = I.applyWrapMargins(els, 'right', 100);
  eq(e.length, 1, 'wrap-margin: null 元素跳过');

  // 复位幂等：复位两次不会把别的东西删掉
  I.restoreWrapMargins(e);
  const again = I.restoreWrapMargins(e);
  eq(again, 1, 'wrap-margin: 复位可重复调用');
}

function tMarginsMultiple() {
  const a = marginBlock(100);
  const b = marginBlock(100, { marginRight: '4px' });
  const entries = I.applyWrapMargins([a, b], 'right', 400);
  eq(entries.length, 2, 'wrap-margin: 多目标各一条记录');
  eq(a.style.marginRight, '400px', 'wrap-margin: 第一块');
  eq(b.style.marginRight, '404px', 'wrap-margin: 第二块带自己的底');
  I.restoreWrapMargins(entries);
  ok(a.style.marginRight === undefined && b.style.marginRight === '4px', 'wrap-margin: 多目标各自复位');
}

/* ------------------------------ 定位上下文 ------------------------------ */

function byClass(cls) {
  return { classList: { contains: (c) => c === cls } };
}

function tPickContext() {
  // 只有一层壳：父盒高度 = 图高 → 继续往上，落在 sizer 上
  const sizer = rectBlock(2000);
  sizer.classList = byClass('markdown-preview-sizer').classList;
  const figure = rectBlock(180);
  const host = rectBlock(180);
  figure.parentElement = sizer;
  host.parentElement = figure;
  const ctx = I.pickContext(host);
  ok(ctx && ctx.ancestor === sizer, 'pick-context: 爬到 sizer 才有定位意义');
  ok(ctx && ctx.block === figure, 'pick-context: 脱离流的是外层壳');

  // 父盒里还有别的内容：就地止步，父盒就是定位祖先
  const p = rectBlock(1800);
  const c = rectBlock(180);
  c.parentElement = p;
  const ctx2 = I.pickContext(c);
  ok(ctx2 && ctx2.ancestor === p && ctx2.block === c, 'pick-context: 父盒有别的正文就停在这一层');

  // 没有任何父元素：不硬来
  eq(I.pickContext(rectBlock(100)), null, 'pick-context: 没有父元素 → null');

  // 爬的上限：CLIMB_LIMIT 层壳之后收手，不会一路爬到 body
  const top = rectBlock(5000);
  const w4 = rectBlock(100); const w3 = rectBlock(100);
  const w2 = rectBlock(100); const w1 = rectBlock(100);
  const leaf = rectBlock(100);
  leaf.parentElement = w1; w1.parentElement = w2; w2.parentElement = w3;
  w3.parentElement = w4; w4.parentElement = top;
  const ctx3 = I.pickContext(leaf);
  ok(ctx3 && ctx3.ancestor === top, 'pick-context: 爬到上限后收手');
  ok(I.CLIMB_LIMIT === 4, 'pick-context: 上限是 4 层');
}

/* ------------------------------ 守卫 ------------------------------ */

function tGuards() {
  const el = rectBlock(100);
  el.closest = (sel) => (sel === '.cm-editor' ? el : null);
  ok(I.isLivePreview(el), 'guard: 识别实时预览（CM6）');
  const plain = rectBlock(100);
  plain.closest = () => null;
  ok(!I.isLivePreview(plain), 'guard: 阅读视图不误判');
  eq(I.isLivePreview(null), false, 'guard: 没有元素也不抛');

  // inline 预览 / 非 left-right：不做 JS 浮动（交给原样式）
  eq(I.floatify(plain, { float: 'center' }), null, 'guard: center 不走 JS 浮动');
  eq(I.floatify(plain, { float: 'inline' }), null, 'guard: inline 不走 JS 浮动');
  eq(I.floatify(plain, {}), null, 'guard: 不浮动 → null');
  eq(I.floatify(null, { float: 'right' }), null, 'guard: 没有宿主 → null');
  eq(I.floatify(el, { float: 'right' }), null, 'guard: 实时预览 → 不动手');
}

suite('float-wrap-target', () => { tCollectGuard(); tCollectBasic(); tCollectEdge(); });
suite('float-wrap-margin', () => { tMarginsApply(); tMarginsBase(); tMarginsMaxWidth(); tMarginsGuard(); tMarginsMultiple(); });
suite('float-context', () => { tPickContext(); tGuards(); });
