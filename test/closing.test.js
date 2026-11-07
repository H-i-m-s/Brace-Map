'use strict';

/* ============================================================
 * brace-map selftest · closing 的多组语义
 *
 * 覆盖：
 *   - closing: true 与改动前逐位一致（基准值来自改动前的构建，见 tBooleanCompat）
 *   - closing: 甲, 乙 只框点名的节点，cross 两端 = 这些节点的外接范围
 *   - 跨层长括号：选中节点跨过中间节点时，括号范围仍只由选中节点决定
 *   - 多条并存：按书写顺序从内往外排，列间距 = braceWidth + colGap，画布跟着扩
 *   - 名字匹配不上：不抛错、不画、留诊断，其它组照画
 *   - 中文逗号、重名、名字里带空格
 * ============================================================ */

const { I, ok, eq, finite, clean, suite } = require('./framework');
const { LAYOUT_OPTS, pathPoints } = require('./helpers');

function layout(src, extra) {
  const r = I.parseSource(src);
  const L = I.layoutTree(r.roots, Object.assign({}, LAYOUT_OPTS, {
    dir: 'lr',
    closing: r.closing,
    closingGroups: r.closingGroups,
  }, extra));
  return { r, L };
}

/** 直接拿 parse 结果布一次局（方向可换） */
function layoutOf(r, dir, extra) {
  return I.layoutTree(r.roots, Object.assign({}, LAYOUT_OPTS, {
    dir,
    closing: r.closing,
    closingGroups: r.closingGroups,
  }, extra));
}

function closings(L) {
  return L.braces.filter((b) => b.kind === 'closing');
}

function nodeByText(L, t) {
  return L.nodes.find((n) => n.text === t);
}

/** 节点自身在 cross 上的范围 */
function extent(n) {
  return [n.cross - n.selfCross / 2, n.cross + n.selfCross / 2];
}

/* ------------------------------ 解析 ------------------------------ */

function tParseGroups() {
  const base = ['- 父', '  - 甲', '  - 乙'];

  const plain = I.parseSource(['closing: true'].concat(base).join('\n'));
  eq(plain.closing, true, 'closing: closing 仍是布尔 true');
  eq(plain.closingGroups, [{ all: true }], 'closing: true → [{all:true}]');

  for (const v of ['yes', '1', 'on', 'TRUE', 'On']) {
    const r = I.parseSource(['closing: ' + v].concat(base).join('\n'));
    eq(r.closingGroups, [{ all: true }], 'closing: 布尔写法 ' + v);
  }

  const names = I.parseSource(['closing: 甲, 乙, 丙'].concat(base).join('\n'));
  eq(names.closing, true, 'closing: 名单 → closing 仍为 true');
  eq(names.closingGroups, [{ names: ['甲', '乙', '丙'] }], 'closing: 英文逗号切分');

  const cn = I.parseSource(['closing: 甲，乙'].concat(base).join('\n'));
  eq(cn.closingGroups, [{ names: ['甲', '乙'] }], 'closing: 中文逗号切分');

  const mixed = I.parseSource(['closing: 甲，乙, 丙'].concat(base).join('\n'));
  eq(mixed.closingGroups, [{ names: ['甲', '乙', '丙'] }], 'closing: 中英逗号混用');

  const pad = I.parseSource(['closing:   甲 ,  乙  '].concat(base).join('\n'));
  eq(pad.closingGroups, [{ names: ['甲', '乙'] }], 'closing: 名字两边空白被 trim');

  const multi = I.parseSource([
    'closing: 甲, 乙',
    'closing: 丙',
    'closing: true',
  ].concat(base).join('\n'));
  eq(multi.closingGroups, [
    { names: ['甲', '乙'] },
    { names: ['丙'] },
    { all: true },
  ], 'closing: 多次出现按顺序累积');

  // 空值：`closing:` 后面只有空白/逗号 → 当「全框」
  const empty = I.parseSource(['closing:   '].concat(base).join('\n'));
  eq(empty.closingGroups, [{ all: true }], 'closing: 空值 → all');

  const commas = I.parseSource(['closing: ,,'].concat(base).join('\n'));
  eq(commas.closingGroups, [{ all: true }], 'closing: 只有逗号 → all');

  const none = I.parseSource(base.join('\n'));
  eq(none.closing, false, 'closing: 不写 → closing=false');
  eq(none.closingGroups, [], 'closing: 不写 → closingGroups 为空');

  // 其它指令不受影响
  const other = I.parseSource([
    'dir: tb', 'brace: square', 'box: 2', 'title: 标题',
    'closing: 甲', '- 父', '  - 甲',
  ].join('\n'));
  eq(other.dir, 'tb', 'closing: dir 不受影响');
  eq(other.brace, 'square', 'closing: brace 不受影响');
  eq(other.box, [2], 'closing: box 不受影响');
  eq(other.title, '标题', 'closing: title 不受影响');
}

/* ------------------------ 布尔写法的逐位回归 ------------------------ */

/*
 * 下面这些数字是**改动前**的构建跑出来的（同一份 parse + layout + LAYOUT_OPTS，
 * 只在建 closing 那段写了 console.log）。行为不该动，所以按原值硬比。
 */
const BEFORE = {
  flat: {
    lr: { mainBody: 94, mainTip: 104, cross1: 16, cross2: 60, width: 120, height: 76 },
    rl: { mainBody: 94, mainTip: 104, cross1: 16, cross2: 60, width: 120, height: 76 },
    tb: { mainBody: 108, mainTip: 118, cross1: 16, cross2: 46, width: 62, height: 134 },
    bt: { mainBody: 108, mainTip: 118, cross1: 16, cross2: 46, width: 62, height: 134 },
  },
  deep: {
    lr: { mainBody: 156, mainTip: 166, cross1: 16, cross2: 87, width: 182, height: 103 },
    rl: { mainBody: 156, mainTip: 166, cross1: 16, cross2: 87, width: 182, height: 103 },
    tb: { mainBody: 167, mainTip: 177, cross1: 16, cross2: 86, width: 102, height: 193 },
    bt: { mainBody: 167, mainTip: 177, cross1: 16, cross2: 86, width: 102, height: 193 },
  },
};

const SRC_FLAT = ['closing: true', '- 父', '  - 甲', '  - 乙'].join('\n');
const SRC_DEEP = ['closing: true', '- 根', '  - 甲', '    - 甲一', '    - 甲二', '  - 乙'].join('\n');

function tBooleanCompat() {
  for (const [name, src] of [['flat', SRC_FLAT], ['deep', SRC_DEEP]]) {
    for (const dir of ['lr', 'rl', 'tb', 'bt']) {
      const want = BEFORE[name][dir];
      const r = I.parseSource(src);
      const L = layoutOf(r, dir);
      const cs = closings(L);
      const label = 'compat[' + name + '/' + dir + ']';

      eq(cs.length, 1, label + ': 只有一条 closing');
      const c = cs[0];
      eq(c.mainBody, want.mainBody, label + ': mainBody 与改动前一致');
      eq(c.mainTip, want.mainTip, label + ': mainTip 与改动前一致');
      eq(c.cross1, want.cross1, label + ': cross1 与改动前一致');
      eq(c.cross2, want.cross2, label + ': cross2 与改动前一致');
      eq(L.width, want.width, label + ': 画布宽与改动前一致');
      eq(L.height, want.height, label + ': 画布高与改动前一致');

      // 括的仍是「全部叶子」
      const leaves = L.nodes.filter((n) => !n.children.length);
      eq(c.targets.length, leaves.length, label + ': 目标数 = 叶子数');
      const lo = Math.min.apply(null, leaves.map((l) => extent(l)[0]));
      const hi = Math.max.apply(null, leaves.map((l) => extent(l)[1]));
      ok(c.cross1 === lo && c.cross2 === hi, label + ': 两端 = 叶子的外接范围');
      ok(c.mainTip > c.mainBody, label + ': 尖端在外侧');
      // 首点贴内容侧（lr 下 main 直接映射到 x；rl/tb/bt 会镜像，另处已覆盖）
      if (dir === 'lr') {
        ok(c.d.startsWith('M ' + c.mainBody + ' '), label + ': 首点贴内容侧', c.d);
      }
    }
  }

  // closing 关掉时一条都不画（老调用方只有这一个开关）
  const r = I.parseSource(SRC_FLAT);
  const off = layoutOf(r, 'lr', { closing: false, closingGroups: null });
  eq(closings(off).length, 0, 'compat: closing=false 一条都不画');
  const offCfg = I.buildSvg(Object.assign({}, r, { closing: false }), LAYOUT_OPTS);
  eq(closings(offCfg.layout).length, 0, 'compat: cfg.closing=false 时 groups 也不生效');
}

/* --------------------------- 点名单个/两个 --------------------------- */

function tNamed() {
  const src = [
    'closing: 甲, 乙',
    '- 父',
    '  - 甲',
    '  - 乙',
    '  - 丙',
  ].join('\n');
  const { r, L } = layout(src);
  eq(r.closingGroups, [{ names: ['甲', '乙'] }], 'named: 解析成一条声明');

  const cs = closings(L);
  eq(cs.length, 1, 'named: 只画一条 closing');
  const c = cs[0];
  const jia = nodeByText(L, '甲');
  const yi = nodeByText(L, '乙');
  const bing = nodeByText(L, '丙');

  eq(c.targets.length, 2, 'named: 只括点名的两个节点');
  ok(c.cross1 === extent(jia)[0], 'named: cross1 = 甲 的行顶', c.cross1 + ' vs ' + extent(jia)[0]);
  ok(c.cross2 === extent(yi)[1], 'named: cross2 = 乙 的行底', c.cross2 + ' vs ' + extent(yi)[1]);
  ok(c.cross2 < extent(bing)[0], 'named: 丙 在括号外', c.cross2 + ' vs ' + extent(bing)[0]);

  // 括号仍是「尖端在外、开口贴内容」那条主线，宽度 = braceWidth
  ok(c.mainTip > c.mainBody, 'named: 尖端在外侧');
  ok(Math.abs((c.mainBody - c.mainTip) + I.OPT.braceWidth) < 1e-9, 'named: 括号宽度 = braceWidth');

  // 内容侧留白：body 在全部内容之外（不能压字）
  const contentEnd = Math.max.apply(null, L.nodes.map((n) => n.main + n.mSize / 2));
  ok(c.mainBody > contentEnd, 'named: mainBody 在所有内容之外', c.mainBody + ' vs ' + contentEnd);

  // 只点一个名字
  const one = layout(['closing: 丙', '- 父', '  - 甲', '  - 乙', '  - 丙'].join('\n')).L;
  const c1 = closings(one)[0];
  eq(c1.targets.length, 1, 'named: 单个名字');
  ok(c1.cross1 === extent(nodeByText(one, '丙'))[0], 'named: 单个名字的两端');
  ok(c1.cross2 === extent(nodeByText(one, '丙'))[1], 'named: 单个名字的两端（下）');
}

/* ----------------------------- 跨层长括号 ----------------------------- */

function tCrossLayer() {
  const src = [
    'closing: 深甲, 深丙',
    '- 根',
    '  - 甲',
    '    - 甲一',
    '      - 深甲',
    '  - 乙',
    '  - 丙',
    '    - 丙一',
    '      - 深丙',
    '  - 丁',
  ].join('\n');
  const { L } = layout(src);
  const c = closings(L)[0];
  const a = nodeByText(L, '深甲');
  const b = nodeByText(L, '深丙');

  ok(!!a && !!b, 'cross-layer: 两个跨层节点都找得到');
  eq(a.depth, 3, 'cross-layer: 深甲 在第 4 层');
  eq(b.depth, 3, 'cross-layer: 深丙 在第 4 层');
  eq(c.targets.length, 2, 'cross-layer: 只括这两个');

  eq(c.cross1, extent(a)[0], 'cross-layer: cross1 = 深甲 行顶');
  eq(c.cross2, extent(b)[1], 'cross-layer: cross2 = 深丙 行底');

  // 中间的行（乙 / 丙 / 丙一）整段落在括号里，但它们不影响两端。
  // 丙、丙一 是深丙 的祖先，单行节点撑高相同、又居中在同一条 row 上，所以它们和深丙
  // 共一条 row（两端恰好相等）；乙 是另外一条 row，得真的落在括号里面。
  for (const mid of ['乙', '丙', '丙一']) {
    const n = nodeByText(L, mid);
    const [lo, hi] = extent(n);
    ok(lo >= c.cross1 && hi <= c.cross2, 'cross-layer: ' + mid + ' 在括号内',
      c.cross1 + ' ≤ ' + lo + ' … ' + hi + ' ≤ ' + c.cross2);
  }
  const yi = nodeByText(L, '乙');
  ok(extent(yi)[0] > c.cross1 && extent(yi)[1] < c.cross2, 'cross-layer: 无关的中间节点乙 严格在括号内',
    c.cross1 + ' < ' + extent(yi)[0] + ' … ' + extent(yi)[1] + ' < ' + c.cross2);
  ok(nodeByText(L, '丙').cross > extent(yi)[1], 'cross-layer: 丙 在乙 之下（构造有效）');
  // 括号跨度只由首末目标决定，中间节点再多也不会变
  const span = c.cross2 - c.cross1;
  const wantSpan = extent(b)[1] - extent(a)[0];
  eq(span, wantSpan, 'cross-layer: 跨度 = 首末目标外接之差');

  // main 方向是一条长括号：从内容最末端一直拉到目标所在层之外
  const contentEnd = Math.max.apply(null, L.nodes.map((n) => n.main + n.mSize / 2));
  ok(c.mainBody > contentEnd, 'cross-layer: 长括号起点在所有内容之外');
  ok(c.mainBody - (a.main + a.mSize / 2) > 0, 'cross-layer: 起点在目标节点之外');

  // 画布把这条长括号包住了
  ok(finite(L.width) && c.mainTip < L.width, 'cross-layer: 长括号在画布内', c.mainTip + ' / ' + L.width);
}

/* ------------------------------- 多组 ------------------------------- */

function tMultiple() {
  const src = [
    'closing: 甲, 乙',
    'closing: 丙, 丁',
    'closing: true',
    '- 父',
    '  - 甲',
    '  - 乙',
    '  - 丙',
    '  - 丁',
  ].join('\n');
  const { r, L } = layout(src);
  eq(r.closingGroups.length, 3, 'multi: 三条声明');

  const cs = closings(L);
  eq(cs.length, 3, 'multi: 三个 closing 括号');
  eq(cs.map((c) => c.group), [0, 1, 2], 'multi: 按声明顺序编号');

  /*
   * 列位按「垂直方向能不能并排」分配：甲/乙 与 丙/丁 上下不相交，
   * 同一列就够；第三条括全部叶子，把两段都覆盖了，必须往外一列。
   */
  const step = I.OPT.braceWidth + I.OPT.colGap;
  eq(cs[0].mainBody, cs[1].mainBody, 'multi: 前两组垂直不重叠，共用一列');
  eq(cs[2].mainBody - cs[1].mainBody, step, 'multi: 与它重叠的那一列错开一步');
  ok(cs[2].mainBody >= cs[0].mainBody + I.OPT.braceWidth + I.OPT.colGap,
    'multi: 两列不重叠');
  ok(cs[0].cross2 <= cs[1].cross1, 'multi: 前两组确实在垂直方向错开（前提成立）');

  // 第一条括 甲/乙，第二条括 丙/丁，第三条括全部叶子
  const jia = nodeByText(L, '甲');
  const yi = nodeByText(L, '乙');
  const bing = nodeByText(L, '丙');
  const ding = nodeByText(L, '丁');
  eq(cs[0].cross1, extent(jia)[0], 'multi: 第一条上沿 = 甲');
  eq(cs[0].cross2, extent(yi)[1], 'multi: 第一条下沿 = 乙');
  eq(cs[1].cross1, extent(bing)[0], 'multi: 第二条上沿 = 丙');
  eq(cs[1].cross2, extent(ding)[1], 'multi: 第二条下沿 = 丁');
  eq(cs[2].cross1, extent(jia)[0], 'multi: 第三条（all）上沿 = 第一个叶子');
  eq(cs[2].cross2, extent(ding)[1], 'multi: 第三条（all）下沿 = 最后一个叶子');
  eq(cs[2].targets.length, 4, 'multi: all 括全部四个叶子');

  // 画布宽度：最后一列的尖端 + pad 才是右边界，必须把三列都装进去
  const last = cs[cs.length - 1];
  ok(L.width >= last.mainTip, 'multi: 画布宽装得下最后一列', L.width + ' vs ' + last.mainTip);
  ok(L.width === last.mainTip + I.OPT.pad, 'multi: 右边界 = 末列尖端 + pad');

  // 单组画布宽 + 1 列 → 宽度按实际用到的列数增长（这次只用两列）
  const one = layout(['closing: true', '- 父', '  - 甲', '  - 乙', '  - 丙', '  - 丁'].join('\n')).L;
  eq(L.width - one.width, step, 'multi: 宽度随实际列数增长');

  // 每个节点、每条路径都还在 viewBox 里
  const built = I.buildSvg(r, Object.assign({}, LAYOUT_OPTS, { dir: 'lr' }));
  const W = built.width;
  const H = built.height;
  let bad = 0;
  for (const b of built.layout.braces) {
    for (const p of pathPoints(b.d)) {
      if (!(p[0] >= -0.001 && p[0] <= W + 0.001 && p[1] >= -0.001 && p[1] <= H + 0.001)) bad++;
    }
  }
  eq(bad, 0, 'multi: 所有括号路径都在 viewBox 内');
  eq((built.markup.match(/class="bm-brace"/g) || []).length, built.layout.braces.length,
    'multi: markup 里每条括号都出了 path');
  ok(clean(built.markup), 'multi: markup 无 NaN/undefined');
}

/* ---------------------------- 名字匹配不上 ---------------------------- */

function tMiss() {
  const src = [
    'closing: 不存在',
    'closing: 甲, 也不存在',
    'closing: 乙',
    '- 父',
    '  - 甲',
    '  - 乙',
  ].join('\n');
  const { L } = layout(src);
  const cs = closings(L);

  eq(cs.length, 2, 'miss: 只画匹配得上的两条');
  eq(cs.map((c) => c.group), [1, 2], 'miss: 跳过的那条不占列（记录原始序号）');
  eq(cs[0].targets.length, 1, 'miss: 部分命中时只括命中的那个');
  eq(cs[0].targets[0].text, '甲', 'miss: 命中的是 甲');
  eq(cs[1].targets[0].text, '乙', 'miss: 第二条命中 乙');

  // 跳过的组不留空列：第 1 条（甲）落在第 0 列
  const base = layout(['closing: 甲', '- 父', '  - 甲', '  - 乙'].join('\n')).L;
  eq(cs[0].mainBody, closings(base)[0].mainBody, 'miss: 空组不占列，第一条仍贴内容');

  // 诊断留痕，且不抛错
  ok(L.warnings.length > 0, 'miss: 记了诊断', JSON.stringify(L.warnings));
  ok(L.warnings.some((w) => w.indexOf('没找到对应的节点') >= 0), 'miss: 诊断说明没找到节点',
    JSON.stringify(L.warnings));
  ok(L.warnings.some((w) => w.indexOf('closing 第 1 条') >= 0), 'miss: 诊断带序号',
    JSON.stringify(L.warnings));
  ok(L.warnings.some((w) => w.indexOf('也不存在') >= 0), 'miss: 部分命中时也点名没找到的');

  // 全部落空：一个括号都不画，也不影响别的指令
  const all = layout(['closing: 无此节点', '- 父', '  - 甲'].join('\n')).L;
  eq(closings(all).length, 0, 'miss: 全落空时零个 closing');
  eq(all.warnings.length, 1, 'miss: 全落空时一条诊断');
  ok(clean(closings(all).map((b) => b.d).join('')), 'miss: 不产生坏路径');

  // buildSvg 也把诊断带出来
  const built = I.buildSvg(I.parseSource(src), Object.assign({}, LAYOUT_OPTS, { dir: 'lr' }));
  ok(Array.isArray(built.warnings) && built.warnings.length > 0, 'miss: buildSvg 透出 warnings');
}

/* ------------------------- 重名 / 空格 / 大小写 ------------------------- */

function tNameRules() {
  // 不同分支下的同名叶子：都要框
  const dup = [
    'closing: 甲',
    '- 根',
    '  - 左',
    '    - 甲',
    '  - 右',
    '    - 甲',
  ].join('\n');
  const { L } = layout(dup);
  const c = closings(L)[0];
  eq(c.targets.length, 2, 'names: 重名全中');
  const both = L.nodes.filter((n) => n.text === '甲');
  eq(both.length, 2, 'names: 确实有两个同名节点');
  const lo = Math.min.apply(null, both.map((n) => extent(n)[0]));
  const hi = Math.max.apply(null, both.map((n) => extent(n)[1]));
  ok(c.cross1 === lo && c.cross2 === hi, 'names: 两端罩住两个同名节点');

  // 名字里的空格算数：完全一致才中
  const spaced = layout([
    'closing: 开 环',
    '- 父',
    '  - 开环',
    '  - 开 环',
  ].join('\n')).L;
  const cs = closings(spaced)[0];
  eq(cs.targets.length, 1, 'names: 空格不同不匹配');
  eq(cs.targets[0].text, '开 环', 'names: 匹配到带空格的那个');

  // 名字两边的空白被忽略
  const padded = layout([
    'closing:    开环   ',
    '- 父',
    '  - 开环',
  ].join('\n')).L;
  eq(closings(padded)[0].targets.length, 1, 'names: 名字两侧空白不算数');

  // 大小写算数（不做大小写折叠）
  const abc = layout([
    'closing: ABC',
    '- 父',
    '  - abc',
    '  - ABC',
  ].join('\n')).L;
  eq(closings(abc)[0].targets.length, 1, 'names: 大小写敏感');
  eq(closings(abc)[0].targets[0].text, 'ABC', 'names: 命中大写那个');

  // 不是叶子的节点也能点名
  const mid = layout([
    'closing: 甲',
    '- 根',
    '  - 甲',
    '    - 甲一',
  ].join('\n')).L;
  const cm = closings(mid)[0];
  eq(cm.targets.length, 1, 'names: 中间层节点可点名');
  eq(cm.targets[0].depth, 1, 'names: 点中的是中间层');
}

/* ------------------------------ 竖方向 ------------------------------ */

function tVertical() {
  for (const dir of ['tb', 'bt']) {
    const src = [
      'closing: 甲, 丙',
      '- 父',
      '  - 甲',
      '  - 乙',
      '  - 丙',
    ].join('\n');
    const r = I.parseSource(src);
    const L = layoutOf(r, dir);
    const cs = closings(L);
    eq(cs.length, 1, 'vertical[' + dir + ']: 一条 closing');
    ok(clean(cs[0].d), 'vertical[' + dir + ']: 路径干净', cs[0].d);
    ok(finite(L.width) && finite(L.height), 'vertical[' + dir + ']: 画布有限');

    const built = I.buildSvg(Object.assign({}, r, { dir }), LAYOUT_OPTS);
    const W = built.width;
    const H = built.height;
    const bad = pathPoints(cs[0].d).filter((p) => p[0] < -0.001 || p[0] > W + 0.001
      || p[1] < -0.001 || p[1] > H + 0.001);
    eq(bad.length, 0, 'vertical[' + dir + ']: 括号在 viewBox 内');
  }
}

/* false / off 这类值不是「一条空声明」，是「没有这条声明」：
 * 不能当成名字去查找，也不该在诊断里留一条「没找到叫 false 的节点」。 */
function tFalseOff() {
  const base = ['- 父', '  - 甲', '  - 乙'];

  for (const v of ['false', 'off', 'no', '0', 'none', 'FALSE']) {
    const r = I.parseSource(['closing: ' + v].concat(base).join('\n'));
    eq(r.closingGroups.length, 0, 'closing-false: ' + v + ' 不产生声明组');
    eq(r.closing, false, 'closing-false: ' + v + ' 时 closing 布尔为假');
    eq(closings(layoutOf(r, 'lr')).length, 0, 'closing-false: ' + v + ' 不画括号');
  }

  /* 和 true 对照：true 仍然是一条 all 声明 */
  const t = I.parseSource(['closing: true'].concat(base).join('\n'));
  eq(t.closingGroups.length, 1, 'closing-false: true 产生一组');
  eq(t.closingGroups[0], { all: true }, 'closing-false: true 那组是 all');
}

suite('closing-parse-groups', tParseGroups);
suite('closing-false-off', tFalseOff);
suite('closing-bool-compat', tBooleanCompat);
suite('closing-named', tNamed);
suite('closing-cross-layer', tCrossLayer);
suite('closing-multi', tMultiple);
suite('closing-miss', tMiss);
suite('closing-name-rules', tNameRules);
suite('closing-vertical', tVertical);
