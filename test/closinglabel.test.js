'use strict';

/* ============================================================
 * brace-map selftest · closing 的分组标签
 *
 * 覆盖：
 *   - 解析：`标签 = 名字列表` / `标签 = true` / 左边空 / 标签自己含 `=` / 名字自己含 `=`
 *   - 无标签逐位不变（基准值来自加标签之前的构建，见 BEFORE）
 *   - 标签位置：尖端外侧 mainTip + colGap、cross 方向居中，四个方向各自一套锚点
 *   - 画布：标签右边缘 + pad 成为右边界，多组各扩各的
 *   - 出图：每组一条 bm-closing-label，无标签时一条都不多
 * ============================================================ */

const { I, ok, eq, finite, clean, suite } = require('./framework');
const { LAYOUT_OPTS, pathPoints } = require('./helpers');

const COL_GAP = I.OPT.colGap;        // 16
const PAD = I.OPT.pad;               // 16
const FONT = LAYOUT_OPTS.fontSize;   // 14

function layout(src, extra, dir) {
  const r = I.parseSource(src);
  const L = I.layoutTree(r.roots, Object.assign({}, LAYOUT_OPTS, {
    dir: dir || 'lr',
    closing: r.closing,
    closingGroups: r.closingGroups,
  }, extra));
  return { r, L };
}

function closings(L) {
  return L.braces.filter((b) => b.kind === 'closing');
}

function nodeByText(L, t) {
  return L.nodes.find((n) => n.text === t);
}

/* ------------------------------ 解析 ------------------------------ */

function tParseLabel() {
  const base = ['- 父', '  - 甲', '  - 乙'];
  const parse = (v) => I.parseSource(['closing: ' + v].concat(base).join('\n'));

  // 名字列表 + 标签
  eq(parse('动力组 = 电动机, 内燃机').closingGroups,
    [{ names: ['电动机', '内燃机'], label: '动力组' }], 'label-parse: 名单 + 标签');
  eq(parse('传动组 = 带传动，液压传动').closingGroups,
    [{ names: ['带传动', '液压传动'], label: '传动组' }], 'label-parse: 中文逗号 + 标签');

  // all + 标签
  eq(parse('全部 = true').closingGroups, [{ all: true, label: '全部' }],
    'label-parse: all + 标签');
  const yes = parse('全 = yes').closingGroups[0];
  eq(yes.all, true, 'label-parse: 标签 = yes 仍是 all');
  eq(yes.label, '全', 'label-parse: 标签 = yes 带上标签');

  // 不写标签：形状与改动前逐字一致（label 字段根本不出现）
  eq(parse('甲, 乙').closingGroups, [{ names: ['甲', '乙'] }], 'label-parse: 无标签形状不变');
  eq('label' in parse('甲, 乙').closingGroups[0], false, 'label-parse: 无标签时不写 label 字段');
  eq(parse('true').closingGroups, [{ all: true }], 'label-parse: 无标签 bare true 形状不变');

  // 左边空 = 没标签，按右边解析，不抛错
  let threw = null;
  let left;
  try { left = parse('= 甲, 乙'); } catch (e) { threw = e; }
  eq(threw, null, 'label-parse: `= 甲, 乙` 不抛错');
  eq(left.closingGroups, [{ names: ['甲', '乙'] }], 'label-parse: `= 甲, 乙` 按右边解析');
  eq(parse('=').closingGroups, [{ all: true }], 'label-parse: 只有一个 = → 标签空、右边空 → all');

  // 标签自己含 `=`：分隔符取「两边带空白的那个 =」
  eq(parse('A=B = 甲').closingGroups, [{ names: ['甲'], label: 'A=B' }],
    'label-parse: 标签自己含 =');
  eq(parse('K = V = 甲').closingGroups, [{ names: ['V = 甲'], label: 'K' }],
    'label-parse: 第一个带空白的 = 就是分隔符，后面的归名字');

  // 名字自己含 `=`：第一个（带空白的）分隔符之后的 = 归名字，不二次切分
  eq(parse('组合 = 甲 = 乙').closingGroups, [{ names: ['甲 = 乙'], label: '组合' }],
    'label-parse: 名字自己含 =（不二次切分）');
  eq(parse('组 = E=mc2').closingGroups, [{ names: ['E=mc2'], label: '组' }],
    'label-parse: 名字里的 = 贴着字符时也算名字');

  // 一个带空白的 = 都没有：退回第一个 =
  eq(parse('组=甲,乙').closingGroups, [{ names: ['甲', '乙'], label: '组' }],
    'label-parse: 无空白的 = 也认（退回第一个）');

  // 标签两边空白 trim 掉
  eq(parse('   动力组   = 甲  ').closingGroups, [{ names: ['甲'], label: '动力组' }],
    'label-parse: 标签 trim');

  // 右边空 → all（标签留着）
  eq(parse('全组 = ').closingGroups, [{ all: true, label: '全组' }],
    'label-parse: 右边空 → all');

  // false/off 仍然不产生声明，标签一起丢掉
  const off = parse('全组 = false');
  eq(off.closingGroups, [], 'label-parse: 标签 = false 不产生声明');
  eq(off.closing, false, 'label-parse: 标签 = false 时 closing 布尔为假');

  // 多条累积
  const multi = I.parseSource([
    'closing: 动力组 = 甲',
    'closing: 全部 = true',
    'closing: 乙',
  ].concat(base).join('\n'));
  eq(multi.closingGroups, [
    { names: ['甲'], label: '动力组' },
    { all: true, label: '全部' },
    { names: ['乙'] },
  ], 'label-parse: 多条按顺序累积');
}

/* --------------------- 无标签：逐位不变（老基准） --------------------- */

/*
 * 下面这组数字是**加标签之前**的构建跑出来的（git HEAD 的 main.js，
 * 同一份 parse + layout + LAYOUT_OPTS）。无标签路径不该动一个像素。
 */
const BEFORE = {
  bool: { b: 94, t: 104, c1: 16, c2: 60, W: 120, H: 76 },
  named: { b: 94, t: 104, c1: 16, c2: 33, W: 120, H: 76 },
  pair: { b: 94, t: 104, c1: 16, c2: 60, W: 120, H: 76 },
};

const SRC_BOOL = ['closing: true', '- 父', '  - 甲', '  - 乙'].join('\n');
const SRC_NAMED = ['closing: 甲', '- 父', '  - 甲', '  - 乙'].join('\n');
const SRC_PAIR = ['closing: 甲, 乙', '- 父', '  - 甲', '  - 乙'].join('\n');

function tNoLabelCompat() {
  for (const [name, src] of [['bool', SRC_BOOL], ['named', SRC_NAMED], ['pair', SRC_PAIR]]) {
    const want = BEFORE[name];
    for (const dir of ['lr', 'rl', 'tb', 'bt']) {
      const { L } = layout(src, null, dir);
      const cs = closings(L);
      const tag = 'label-compat[' + name + '/' + dir + ']';
      eq(cs.length, 1, tag + ': 一条 closing');
      const c = cs[0];
      if (dir === 'lr') {
        eq(c.mainBody, want.b, tag + ': mainBody 不变');
        eq(c.mainTip, want.t, tag + ': mainTip 不变');
        eq(c.cross1, want.c1, tag + ': cross1 不变');
        eq(c.cross2, want.c2, tag + ': cross2 不变');
        eq(L.width, want.W, tag + ': 画布宽不变');
        eq(L.height, want.H, tag + ': 画布高不变');
      }
      // 没有标签 → 标签字段全空，绘制层直接跳过
      eq(c.label, '', tag + ': 没有标签文字');
      eq(c.labelMainEnd, 0, tag + ': 标签不占 main');
      eq(c.labelCrossSpan, 0, tag + ': 标签不占 cross');
      eq(c.labelX, undefined, tag + ': 不产出标签坐标');
    }
  }

  // 出图里一条标签都没有
  const built = I.buildSvg(I.parseSource(SRC_BOOL), LAYOUT_OPTS);
  eq((built.markup.match(/bm-closing-label/g) || []).length, 0, 'label-compat: 无标签不出标签元素');
}

/* ------------------------------ 标签位置 ------------------------------ */

function tPlaceLr() {
  const plain = layout(SRC_PAIR).L;
  const { r, L } = layout(['closing: 动力组 = 甲, 乙', '- 父', '  - 甲', '  - 乙'].join('\n'));
  eq(r.closingGroups, [{ names: ['甲', '乙'], label: '动力组' }], 'label-lr: 解析');

  const c = closings(L)[0];
  const p = closings(plain)[0];
  eq(c.label, '动力组', 'label-lr: 标签文字');
  eq(c.labelW, 30, 'label-lr: 宽度由测量函数给出（3 字 × 10px）');

  // 括号本体不动，只有画布被标签撑宽
  eq(c.mainBody, p.mainBody, 'label-lr: mainBody 与无标签一致');
  eq(c.mainTip, p.mainTip, 'label-lr: mainTip 与无标签一致');
  eq(c.cross1, p.cross1, 'label-lr: cross1 与无标签一致');
  eq(c.cross2, p.cross2, 'label-lr: cross2 与无标签一致');
  eq(L.height, plain.height, 'label-lr: 画布高不变');

  // 位置：x = 尖端 + colGap，y = cross 中点
  eq(c.labelX, c.mainTip + COL_GAP, 'label-lr: x = mainTip + colGap');
  eq(c.labelY, (c.cross1 + c.cross2) / 2, 'label-lr: y = (cross1+cross2)/2');
  eq(c.labelAnchor, 'start', 'label-lr: lr 用 start 锚点');
  ok(c.labelX > c.mainTip, 'label-lr: 标签在尖端外侧');

  // 出图里的坐标与布局一致
  const built = I.buildSvg(r, LAYOUT_OPTS);
  const m = built.markup.match(/<text class="bm-closing-label" x="([^"]+)" y="([^"]+)" text-anchor="([^"]+)"/);
  ok(!!m, 'label-lr: markup 里有标签元素', built.markup.slice(0, 120));
  eq(Number(m[1]), c.labelX, 'label-lr: markup 的 x');
  eq(Number(m[2]), c.labelY, 'label-lr: markup 的 y');
  eq(m[3], 'start', 'label-lr: markup 的锚点');
  ok(/text-anchor="start" dominant-baseline="central"/.test(built.markup),
    'label-lr: 基线 central 与节点文字同口径');
  ok(built.markup.indexOf('>动力组</text>') > 0, 'label-lr: 标签文字进了 markup');
}

function tPlaceMirrored() {
  const src = ['closing: 动力组 = 甲, 乙', '- 父', '  - 甲', '  - 乙'].join('\n');

  // rl：沿 main 镜像，标签跑到左侧，锚点换成 end，左边缘恰好落在 pad 上
  const rl = layout(src, null, 'rl').L;
  const c = closings(rl)[0];
  eq(c.labelAnchor, 'end', 'label-rl: 锚点 end');
  eq(c.labelX, rl.width - (c.mainTip + COL_GAP), 'label-rl: x 沿 main 镜像');
  eq(c.labelX - c.labelW, PAD, 'label-rl: 标签左边缘 = pad');
  ok(c.labelX < c.mainTip, 'label-rl: 标签在尖端外侧（左边）');
  eq(c.labelY, (c.cross1 + c.cross2) / 2, 'label-rl: y 仍是 cross 中点');

  // tb / bt：标签横着写在尖端外侧，x = cross 中点、y 沿 main 越过尖端
  for (const dir of ['tb', 'bt']) {
    const L = layout(src, null, dir).L;
    const t = closings(L)[0];
    const cMid = (t.cross1 + t.cross2) / 2;
    eq(t.labelX, cMid, 'label-' + dir + ': x = cross 中点');
    eq(t.labelAnchor, 'middle', 'label-' + dir + ': 锚点 middle（文字不转 90°）');
    const out = t.mainTip + COL_GAP + FONT / 2;   // 沿 main，标签中心
    eq(t.labelY, dir === 'tb' ? out : L.height - out, 'label-' + dir + ': y 沿 main 越过尖端');
    ok(dir === 'tb' ? t.labelY > (t.mainTip) : t.labelY < L.height - t.mainTip,
      'label-' + dir + ': 标签在尖端外侧');
  }
}

/* ------------------------------ 画布宽度 ------------------------------ */

function tCanvasWidth() {
  const plain = layout(SRC_PAIR).L;
  const { r, L } = layout(['closing: 动力组 = 甲, 乙', '- 父', '  - 甲', '  - 乙'].join('\n'));
  const c = closings(L)[0];
  const p = closings(plain)[0];

  // 右边界 = 标签右边缘 + pad
  eq(L.width, c.labelX + c.labelW + PAD, 'label-width: 右边界 = 标签右边缘 + pad');
  // 扩出去的量 = colGap + 标签宽
  eq(L.width - plain.width, COL_GAP + c.labelW, 'label-width: 画布多出来的 = colGap + 标签宽');
  eq((L.width - plain.width) - COL_GAP, c.labelW, 'label-width: 多出来的部分 ≈ 标签宽（差一个 colGap 的缝）');
  ok(c.labelMainEnd === c.mainTip + COL_GAP + c.labelW, 'label-width: labelMainEnd = 尖端 + colGap + 标签宽');
  eq(c.mainTip, p.mainTip, 'label-width: 括号位置没被标签带着走');

  // 出图（Math.ceil）装得下标签
  const built = I.buildSvg(r, LAYOUT_OPTS);
  ok(built.width >= c.labelX + c.labelW + PAD - 1e-9, 'label-width: 出图宽装得下标签',
    built.width + ' vs ' + (c.labelX + c.labelW + PAD));
  ok(built.width === Math.ceil(L.width), 'label-width: 出图宽 = ceil(布局宽)');

  // 标签宽随测量函数走，不硬编
  const thin = layout(['closing: 动力组 = 甲, 乙', '- 父', '  - 甲', '  - 乙'].join('\n'),
    { measure: (t) => String(t).length * 7, measureBold: (t) => String(t).length * 7 }).L;
  const ct = closings(thin)[0];
  eq(ct.labelW, 21, 'label-width: 换测量函数后标签宽跟着变');
  eq(thin.width, ct.mainTip + COL_GAP + 21 + PAD, 'label-width: 画布跟着换尺子');

  // 靠 cross 方向也别裁：只括一个矮节点 + 长标签时，labelCrossSpan 会撑开出图高
  const one = layout(['closing: 一个很长很长的组名 = 甲', '- 父', '  - 甲', '  - 乙'].join('\n')).L;
  const c1 = closings(one)[0];
  eq(c1.labelCrossSpan, FONT, 'label-width: lr 下标签在 cross 上占一个字高');
  ok(one.height >= (c1.cross2 - c1.cross1) + 2 * PAD - 1e-9, 'label-width: 出图高至少装得下标签');
}

/* ------------------------------ 多组标签 ------------------------------ */

function tMultipleLabels() {
  const src = [
    'closing: 组甲 = 甲, 乙',
    'closing: 组乙 = 丙, 丁',
    'closing: 全部 = true',
    '- 父',
    '  - 甲',
    '  - 乙',
    '  - 丙',
    '  - 丁',
  ].join('\n');
  const r = I.parseSource(src);
  const L = I.layoutTree(r.roots, Object.assign({}, LAYOUT_OPTS, {
    dir: 'lr', closing: r.closing, closingGroups: r.closingGroups,
  }));
  const cs = closings(L);
  eq(cs.length, 3, 'label-multi: 三条 closing');
  eq(cs.map((c) => c.label), ['组甲', '组乙', '全部'], 'label-multi: 标签按声明顺序对上');

  // 每组标签都在自己括号的尖端外侧、自己那段的 cross 中点
  for (const c of cs) {
    eq(c.labelX, c.mainTip + COL_GAP, 'label-multi: 每组 x = 自己尖端 + colGap');
    eq(c.labelY, (c.cross1 + c.cross2) / 2, 'label-multi: 每组 y = 自己的 cross 中点');
    ok(c.labelX > c.mainTip, 'label-multi: 每组标签都在尖端外侧');
  }

  // 同列的两组（上下不重叠）标签不打架：x 相同、y 分开
  eq(cs[0].labelX, cs[1].labelX, 'label-multi: 同列两组标签同 x');
  ok(cs[1].labelY - cs[0].labelY > FONT, 'label-multi: 同列两组标签的 y 错开', cs[0].labelY + ' / ' + cs[1].labelY);
  ok(cs[2].labelX > cs[1].labelX, 'label-multi: 外层那列的标签更靠外');
  ok(cs[2].labelX === cs[2].mainTip + COL_GAP, 'label-multi: 外层标签仍贴自己的尖端');

  // 画布 = 最外面那个标签的右边缘 + pad
  let right = -Infinity;
  for (const c of cs) right = Math.max(right, c.labelX + c.labelW);
  eq(L.width, right + PAD, 'label-multi: 画布右边界 = 最外标签 + pad');

  // 出图：三条标签各一个元素，坐标各不相同
  const built = I.buildSvg(r, LAYOUT_OPTS);
  const tags = built.markup.match(/<text class="bm-closing-label"[^>]*>[^<]*<\/text>/g) || [];
  eq(tags.length, 3, 'label-multi: 三条标签都出了');
  eq(tags.map((t) => t.match(/>([^<]*)<\/text>/)[1]), ['组甲', '组乙', '全部'], 'label-multi: 标签文字顺序');
  ok(new Set(tags).size === 3, 'label-multi: 三条标签坐标互不相同');
  ok(clean(built.markup), 'label-multi: markup 无 NaN/undefined');

  // 每条路径、每个标签都在 viewBox 里
  const W = built.width;
  const H = built.height;
  const bad = [];
  for (const b of built.layout.braces) {
    for (const pt of pathPoints(b.d)) {
      if (!(pt[0] >= -0.001 && pt[0] <= W + 0.001 && pt[1] >= -0.001 && pt[1] <= H + 0.001)) bad.push(pt);
    }
  }
  eq(bad.length, 0, 'label-multi: 括号都在 viewBox 内');
  for (const c of built.layout.braces.filter((b) => b.label)) {
    const [x, y] = [c.labelX, c.labelY];
    ok(x >= 0 && x <= W && y >= 0 && y <= H, 'label-multi: 标签锚点在 viewBox 内', x + ',' + y);
    ok(x + c.labelW <= W + 0.001, 'label-multi: 标签右边缘没超出画布', (x + c.labelW) + ' / ' + W);
  }
}

/* --------------------- 列间距：标签只推右边的列 --------------------- */

/*
 * 四种组合。列间距（= 相邻两列 mainBody 之差）：
 *   内列无标签 → braceWidth + colGap = 26（与改动前一致）
 *   内列有标签 → braceWidth + colGap + labelMainSpan + colGap
 *                标签「组甲」两字 20px → 10 + 16 + 20 + 16 = 62
 */
const STEP_PLAIN = I.OPT.braceWidth + I.OPT.colGap;   // 26

const COMBOS = {
  'both-plain': {
    src: ['closing: 甲, 乙', 'closing: true'],
    cols: [{ body: 94, tip: 104 }, { body: 120, tip: 130 }],
    W: 146,
  },
  'inner-label': {
    src: ['closing: 组甲 = 甲, 乙', 'closing: true'],
    cols: [{ body: 94, tip: 104 }, { body: 156, tip: 166 }],
    W: 182,
  },
  'outer-label': {
    src: ['closing: 甲, 乙', 'closing: 全部 = true'],
    cols: [{ body: 94, tip: 104 }, { body: 120, tip: 130 }],
    W: 182,
  },
  'both-label': {
    src: ['closing: 组甲 = 甲, 乙', 'closing: 全部 = true'],
    cols: [{ body: 94, tip: 104 }, { body: 156, tip: 166 }],
    W: 218,
  },
};

function combo(name) {
  const lines = COMBOS[name].src.concat(['- 父', '  - 甲', '  - 乙']);
  const r = I.parseSource(lines.join('\n'));
  const L = I.layoutTree(r.roots, Object.assign({}, LAYOUT_OPTS, {
    dir: 'lr', closing: r.closing, closingGroups: r.closingGroups,
  }));
  return { r, L, cs: closings(L) };
}

function tColumnPush() {
  // 1) 都没标签：列间距 = braceWidth + colGap，全图像素与加标签之前一致
  {
    const { L, cs } = combo('both-plain');
    eq(cs.length, 2, 'col-push[both-plain]: 两条括号');
    eq(cs[0].mainBody, COMBOS['both-plain'].cols[0].body, 'col-push[both-plain]: 内列 body 不变');
    eq(cs[1].mainBody, COMBOS['both-plain'].cols[1].body, 'col-push[both-plain]: 外列 body 不变');
    eq(cs[1].mainBody - cs[0].mainBody, STEP_PLAIN, 'col-push[both-plain]: 列间距 = braceWidth + colGap');
    eq(L.width, COMBOS['both-plain'].W, 'col-push[both-plain]: 画布宽与加标签之前一致');
  }

  // 2) 内列有标签、外列没有：多退标签宽 + 一道 colGap
  {
    const { L, cs } = combo('inner-label');
    const inner = cs[0];
    const outer = cs[1];
    eq(inner.mainBody, 94, 'col-push[inner-label]: 内列 body 不变（只有 canvas 该变）');
    eq(inner.mainTip, 104, 'col-push[inner-label]: 内列 tip 不变');
    eq(inner.labelW, 20, 'col-push[inner-label]: 内列标签宽');
    eq(outer.mainBody - inner.mainBody,
      I.OPT.braceWidth + I.OPT.colGap + inner.labelW + I.OPT.colGap,
      'col-push[inner-label]: 列间距 = braceWidth + colGap + labelW + colGap');
    eq(outer.mainBody - inner.mainBody, 62, 'col-push[inner-label]: 具体值 62');
    // 两条括号在 main 上不重叠，且标签右缘与下一个 body 之间还剩一道 colGap
    ok(outer.mainBody >= inner.mainTip, 'col-push[inner-label]: 括号不重叠');
    ok(inner.labelX + inner.labelW <= outer.mainBody, 'col-push[inner-label]: 标签右缘在下一个 body 之前',
      (inner.labelX + inner.labelW) + ' vs ' + outer.mainBody);
    eq(outer.mainBody - (inner.labelX + inner.labelW), I.OPT.colGap,
      'col-push[inner-label]: 标签右缘到外列 body 恰好一道 colGap');
    eq(outer.labelW, 0, 'col-push[inner-label]: 外列确实没标签');
    eq(L.width, 182, 'col-push[inner-label]: 画布 = 外列 tip + pad');
  }

  // 3) 内列没标签、外列有：列间距一点都不变，只有画布因外列标签而扩
  {
    const { L, cs } = combo('outer-label');
    const plain = combo('both-plain');
    eq(cs[1].mainBody - cs[0].mainBody, STEP_PLAIN, 'col-push[outer-label]: 列间距不变');
    eq(cs[1].mainBody, plain.cs[1].mainBody, 'col-push[outer-label]: 外列 body 与无标签时相同');
    eq(cs[1].labelW, 20, 'col-push[outer-label]: 外列标签宽');
    eq(L.width - plain.L.width, cs[1].labelW + I.OPT.colGap,
      'col-push[outer-label]: 画布多出来的 = 外列标签宽 + colGap');
    eq(cs[1].labelX + cs[1].labelW + PAD, L.width, 'col-push[outer-label]: 右边界 = 外列标签右缘 + pad');
  }

  // 4) 两条都有标签
  {
    const { L, cs } = combo('both-label');
    eq(cs[1].mainBody - cs[0].mainBody, 62, 'col-push[both-label]: 列间距 = 62');
    ok(cs[0].labelX + cs[0].labelW < cs[1].mainBody, 'col-push[both-label]: 内列标签没压到外列括号');
    eq(cs[1].mainBody - (cs[0].labelX + cs[0].labelW), I.OPT.colGap, 'col-push[both-label]: 中间一道 colGap');
    eq(cs[1].labelX + cs[1].labelW + PAD, L.width, 'col-push[both-label]: 画布装下最外列标签');
    eq(L.width, 218, 'col-push[both-label]: 具体值 218');
  }
}

function tColumnPushSharedColumn() {
  /*
   * 同一列里可以住好几条括号（上下不重叠就复用）。列的标签占宽取这列的最大值，
   * 且与声明顺序无关：先写不带标签的、后写带标签的，这一列同样要把右边推开。
   */
  const linesFor = (first, second) => [first, second, 'closing: 全部 = true']
    .concat(['- 父', '  - 甲', '  - 乙']);

  for (const [name, first, second] of [
    ['label-first', 'closing: 组甲 = 甲', 'closing: 乙'],
    ['label-second', 'closing: 乙', 'closing: 组甲 = 甲'],
  ]) {
    const r = I.parseSource(linesFor(first, second).join('\n'));
    const L = I.layoutTree(r.roots, Object.assign({}, LAYOUT_OPTS, {
      dir: 'lr', closing: r.closing, closingGroups: r.closingGroups,
    }));
    const cs = closings(L);
    eq(cs.length, 3, 'col-share[' + name + ']: 三条括号');
    // 前两条（甲 / 乙 上下不撞）共住第 0 列
    eq(cs[0].mainBody, cs[1].mainBody, 'col-share[' + name + ']: 前两条共住一列');
    eq(cs[0].mainBody, 94, 'col-share[' + name + ']: 第 0 列还是老基线');
    // 第 0 列里有标签（不管它是第几条声明），第 1 列就得后退 labelW + colGap
    eq(cs[2].mainBody - cs[0].mainBody, 62, 'col-share[' + name + ']: 标签那一列把右边推开了');
    const lab = cs.find((c) => c.label === '组甲');
    ok(lab.labelX + lab.labelW <= cs[2].mainBody, 'col-share[' + name + ']: 标签不压外列括号');
    ok(cs[2].labelX + cs[2].labelW + PAD === L.width, 'col-share[' + name + ']: 画布装下最外标签');
  }
}

function tColumnPushVertical() {
  // 竖方向：标签横写，沿 main 占一个「字高」，推开的量是 colGap + fontSize + colGap
  for (const dir of ['tb', 'bt']) {
    const r = I.parseSource(['closing: 组甲 = 甲, 乙', 'closing: true']
      .concat(['- 父', '  - 甲', '  - 乙']).join('\n'));
    const L = I.layoutTree(r.roots, Object.assign({}, LAYOUT_OPTS, {
      dir, closing: r.closing, closingGroups: r.closingGroups,
    }));
    const cs = closings(L);
    eq(cs[1].mainBody - cs[0].mainBody,
      I.OPT.braceWidth + I.OPT.colGap + FONT + I.OPT.colGap,
      'col-push[' + dir + ']: 竖方向推开的量按字高算');
    ok(cs[0].labelY + FONT / 2 <= cs[1].mainBody, 'col-push[' + dir + ']: 标签沿 main 也没压到外列');
  }
}

function tFalseBothWays() {
  const base = ['- 父', '  - 甲', '  - 乙'];

  // 不带 `=`
  const plain = I.parseSource(['closing: false'].concat(base).join('\n'));
  eq(plain.closingGroups, [], 'label-false: `closing: false` 没有任何声明');
  eq('label' in (plain.closingGroups[0] || {}), false, 'label-false: 也不产生 label 字段');
  eq(plain.closing, false, 'label-false: closing 布尔为假');
  eq((I.buildSvg(plain, LAYOUT_OPTS).markup.match(/bm-closing-label/g) || []).length, 0,
    'label-false: 不出标签元素');

  // 带 `=` 与标签
  const tagged = I.parseSource(['closing: 全组 = false'].concat(base).join('\n'));
  eq(tagged.closingGroups, [], 'label-false: `全组 = false` 也没有任何声明');
  eq(tagged.closing, false, 'label-false: `全组 = false` 时 closing 布尔为假');
  eq((I.buildSvg(tagged, LAYOUT_OPTS).markup.match(/bm-closing-label/g) || []).length, 0,
    'label-false: 带标签的 false 也不出标签');
  const lay = I.layoutTree(tagged.roots, Object.assign({}, LAYOUT_OPTS, {
    dir: 'lr', closing: tagged.closing, closingGroups: tagged.closingGroups,
  }));
  eq(closings(lay).length, 0, 'label-false: 一条括号都不画');
}

function tLabelMarkupSafe() {
  // 标签不解析行内标记：`**` / `<font>` 原样当字画，宽度也把它们算进去
  const bold = layout(['closing: **动力组** = 甲, 乙', '- 父', '  - 甲', '  - 乙'].join('\n'));
  const cb = closings(bold.L)[0];
  eq(cb.label, '**动力组**', 'label-markup: 星号原样保留');
  eq(cb.labelW, 70, 'label-markup: 宽度把星号也量进去（7 字 × 10px）');
  const mb = I.buildSvg(bold.r, LAYOUT_OPTS).markup;
  ok(mb.indexOf('>**动力组**</text>') > 0, 'label-markup: 星号没被当成粗体语法');
  eq((mb.match(/<tspan/g) || []).length, 0, 'label-markup: 标签不吃 run，不产生 tspan');

  // 尖括号/引号/& 一律转义，标签里写标签也不会真长出一个元素
  const inj = layout(['closing: <font color="red">x</font> = 甲', '- 父', '  - 甲'].join('\n'));
  const ci = closings(inj.L)[0];
  eq(ci.label, '<font color="red">x</font>', 'label-markup: 标签原文留着');
  const mi = I.buildSvg(inj.r, LAYOUT_OPTS).markup;
  eq((mi.match(/<font /g) || []).length, 0, 'label-markup: 没长出真的 <font> 元素');
  ok(mi.indexOf('&lt;font color=&quot;red&quot;&gt;x&lt;/font&gt;') > 0, 'label-markup: 整段被转义');
  ok(clean(mi), 'label-markup: markup 干净');
  // 标签元素本身仍然只有一个、且属性完整
  const tags = mi.match(/<text class="bm-closing-label"[^>]*>[^<]*<\/text>/g) || [];
  eq(tags.length, 1, 'label-markup: 只出一个标签元素');
}

/* ------------------------------ 边界情况 ------------------------------ */

function tEdge() {
  // 名字没命中：这条不画，也就不出标签
  const miss = layout(['closing: 组 = 不存在', '- 父', '  - 甲'].join('\n'));
  eq(closings(miss.L).length, 0, 'label-edge: 落空的一条不画');
  eq((miss.L.warnings || []).length, 1, 'label-edge: 仍留一条诊断');
  const builtMiss = I.buildSvg(miss.r, LAYOUT_OPTS);
  eq((builtMiss.markup.match(/bm-closing-label/g) || []).length, 0, 'label-edge: 落空的不出标签');

  // 标签里的尖括号被转义，不会破坏标记
  const esc = layout(['closing: a<b&c = 甲', '- 父', '  - 甲'].join('\n'));
  const c = closings(esc.L)[0];
  eq(c.label, 'a<b&c', 'label-edge: 标签原样保留');
  const builtEsc = I.buildSvg(esc.r, LAYOUT_OPTS);
  ok(builtEsc.markup.indexOf('>a&lt;b&amp;c</text>') > 0, 'label-edge: 标签被转义');
  ok(clean(builtEsc.markup), 'label-edge: 转义后 markup 干净');

  // 只有一个节点的 closing：标签照样居中
  const one = layout(['closing: 单 = 甲', '- 父', '  - 甲'].join('\n')).L;
  const c1 = closings(one)[0];
  eq(c1.labelY, (c1.cross1 + c1.cross2) / 2, 'label-edge: 单节点也居中');
  ok(finite(c1.labelX) && finite(c1.labelY), 'label-edge: 单节点坐标有限');
}

suite('closing-label-parse', tParseLabel);
suite('closing-label-compat', tNoLabelCompat);
suite('closing-label-place-lr', tPlaceLr);
suite('closing-label-place-mirror', tPlaceMirrored);
suite('closing-label-width', tCanvasWidth);
suite('closing-label-multi', tMultipleLabels);
suite('closing-label-edge', tEdge);
suite('closing-label-column-push', tColumnPush);
suite('closing-label-column-share', tColumnPushSharedColumn);
suite('closing-label-column-vertical', tColumnPushVertical);
suite('closing-label-false', tFalseBothWays);
suite('closing-label-markup-safe', tLabelMarkupSafe);
