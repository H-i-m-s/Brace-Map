'use strict';

/* ============================================================
 * boxnode.test.js · 行尾 {box} 按节点画框
 *
 * box: N 是按层框：同一深度的全部节点一起框住。
 * 「只想框住其中一两个」用行尾标记 {box} 点名，不受层级限制，
 * 而且能和 box: N 叠加使用。
 * ============================================================ */

const { I, ok, eq, suite } = require('./framework');
const { LAYOUT_OPTS, TEXT_H } = require('./helpers');

const SRC = [
  '- 系统',
  '  - 硬件',
  '    - 传感器 {box}',
  '    - 执行器',
  '  - 软件',
  '    - 固件 {box}',
].join('\n');

function boxedTexts(src, opts) {
  const cfg = I.parseSource(src);
  const L = I.layoutTree(cfg.roots, Object.assign({}, LAYOUT_OPTS,
    { dir: 'lr', box: cfg.box }, opts || {}));
  return {
    cfg,
    layout: L,
    boxed: L.nodes.filter((n) => n.boxed).map((n) => n.text),
  };
}

function tParse() {
  const cfg = I.parseSource(SRC);
  const flat = [];
  const walk = (list) => {
    for (const n of list) { flat.push(n); walk(n.children); }
  };
  walk(cfg.roots);

  const byText = (t) => flat.find((n) => n.text === t);
  eq(byText('传感器').forceBox, true, 'boxnode-parse: 传感器 带 {box}');
  eq(byText('固件').forceBox, true, 'boxnode-parse: 固件 带 {box}');
  eq(byText('执行器').forceBox, false, 'boxnode-parse: 执行器 没带');
  eq(byText('硬件').forceBox, false, 'boxnode-parse: 硬件 没带');

  // 标记必须从正文里剥掉，不能渲染成文字
  eq(byText('传感器').text, '传感器', 'boxnode-parse: {box} 已从文字里剥掉');
  ok(!/\{box\}/.test(byText('传感器').text), 'boxnode-parse: 文字里不留痕迹');

  // 只在行尾匹配：正文中间出现的 {box} 字样不是标记
  const inline = I.parseSource('- 这里提到 {box} 标记的写法');
  const n = inline.roots[0];
  eq(n.forceBox, false, 'boxnode-parse: 正文中间的 {box} 不算标记');
  eq(n.text, '这里提到 {box} 标记的写法', 'boxnode-parse: 正文保持原样');
}

function tLayout() {
  const r = boxedTexts(SRC);
  eq(r.boxed.length, 2, 'boxnode-layout: 恰好两个节点有框');
  eq(r.boxed[0], '传感器', 'boxnode-layout: 第一个是传感器');
  eq(r.boxed[1], '固件', 'boxnode-layout: 第二个是固件');

  // 有框的节点多出上下留白，所以更高
  const withBox = r.layout.nodes.find((n) => n.text === '传感器');
  const noBox = r.layout.nodes.find((n) => n.text === '执行器');
  eq(withBox.bh - noBox.bh, 2 * I.OPT.boxPadY, 'boxnode-layout: 框比同层无框节点高 2*boxPadY');
  eq(withBox.bw - noBox.bw, 2 * I.OPT.boxPadX, 'boxnode-layout: 框只多出左右留白');

  // 祖先不受影响
  const hw = r.layout.nodes.find((n) => n.text === '硬件');
  eq(hw.boxed, false, 'boxnode-layout: 祖先节点不跟着框');
}

function tWithoutDirective() {
  // 没写 box: N 时，只有带 {box} 的节点有框
  const r = boxedTexts(SRC, { box: [] });
  eq(r.boxed.length, 2, 'boxnode-only: 不写 box 指令时仍按 {box} 框');
  eq(r.boxed.join(','), '传感器,固件', 'boxnode-only: 框的还是那两个');
}

function tCoexist() {
  // box: N 与 {box} 叠加：按层的那些 + 点名的那些，取并集
  const src = SRC.replace('- 执行器', '- 执行器 {box}');
  const r = boxedTexts(src);
  eq(r.boxed.length, 3, 'boxnode-coexist: 三个节点有框');

  const withLayer = boxedTexts(src, { box: [2] });
  ok(withLayer.boxed.length >= 3, 'boxnode-coexist: 叠加按层框后只多不少',
    withLayer.boxed.join(','));
}

function tEmpty() {
  // 只有 {box} 没有文字的节点：仍是空节点，但要能框
  const cfg = I.parseSource(['- 父', '  - {box}', '  - 子'].join('\n'));
  const L = I.layoutTree(cfg.roots, Object.assign({}, LAYOUT_OPTS, { dir: 'lr', box: cfg.box }));
  const empty = L.nodes.find((n) => !n.text);
  ok(empty, 'boxnode-empty: 空节点还在');
  eq(empty.boxed, true, 'boxnode-empty: 空节点也能被框');
  eq(empty.bh, TEXT_H + 2 * I.OPT.boxPadY, 'boxnode-empty: 空节点高度正常');
}

suite('boxnode-parse', tParse);
suite('boxnode-layout', tLayout);
suite('boxnode-only', tWithoutDirective);
suite('boxnode-coexist', tCoexist);
suite('boxnode-empty', tEmpty);
