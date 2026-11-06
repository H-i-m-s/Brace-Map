'use strict';

/* ============================================================
 * brace-map selftest · 布局：四方向、父节点居中、只包下一层、方框、字号缩放
 * ============================================================ */

const { I, ok, eq, finite, clean, suite } = require('./framework');
const { FONT, LINE_H, ROW_GAP, TEXT_H, LAYOUT_OPTS, mockMeasure } = require('./helpers');

function tLayout() {
  const r = I.parseSource(['- 父节点', '  - 甲', '  - 乙', '  - 丙'].join('\n'));

  for (const dir of ['lr', 'rl', 'tb', 'bt']) {
    const L = I.layoutTree(r.roots, Object.assign({}, LAYOUT_OPTS, { dir }));
    ok(L.width > 0 && L.height > 0, 'layout[' + dir + ']: bbox > 0', L.width + 'x' + L.height);
    ok(finite(L.width) && finite(L.height), 'layout[' + dir + ']: bbox finite');

    const bad = L.nodes.filter((n) => !finite(n.x) || !finite(n.y) || !finite(n.w) || !finite(n.h));
    ok(bad.length === 0, 'layout[' + dir + ']: all coords finite', bad.length + ' bad');

    const root = L.nodes.find((n) => n.depth === 0);
    ok(!!root, 'layout[' + dir + ']: root found');
    eq(root.children.length, 3, 'layout[' + dir + ']: root has 3 children');

    const kids = root.children;

    // 副轴（cross）槽位不重叠（槽位 = cSize，只用于排布）
    for (let i = 0; i + 1 < kids.length; i++) {
      const a = kids[i];
      const b = kids[i + 1];
      ok(a.crossEnd <= b.crossStart + 0.01, 'layout[' + dir + ']: cross slots no overlap #' + i,
        a.crossEnd.toFixed(2) + ' > ' + b.crossStart.toFixed(2));
    }

    // 自身占位不能超过槽位
    const over = L.nodes.filter((n) => n.selfCross > n.cSize + 1e-9);
    ok(over.length === 0, 'layout[' + dir + ']: selfCross <= cSize', over.length + ' bad');

    // 映射后兄弟沿副轴严格递增（lr/rl 看 y，tb/bt 看 x）
    const vertical = dir === 'tb' || dir === 'bt';
    for (let i = 0; i + 1 < kids.length; i++) {
      const a = kids[i];
      const b = kids[i + 1];
      const av = vertical ? a.x : a.y;
      const bv = vertical ? b.x : b.y;
      ok(av < bv, 'layout[' + dir + ']: mapped cross increasing #' + i, av + ' !< ' + bv);
    }

    // 兄弟沿生长方向等深
    const mains = kids.map((k) => k.main);
    ok(mains.every((m) => Math.abs(m - mains[0]) < 1e-9), 'layout[' + dir + ']: siblings same depth');
    ok(layoutDirSign(L, root) , 'layout[' + dir + ']: growth direction correct');
  }
}

function layoutDirSign(L, root) {
  const kid = root.children[0];
  if (L.dir === 'lr') return kid.x > root.x;
  if (L.dir === 'rl') return kid.x < root.x;
  if (L.dir === 'tb') return kid.y > root.y;
  if (L.dir === 'bt') return kid.y < root.y;
  return false;
}

function tParentCentered() {
  // 子树高度极不均：甲带两个孙节点，乙是孤叶
  const src = ['- 父', '  - 甲', '    - 甲一', '    - 甲二', '  - 乙'].join('\n');
  const r = I.parseSource(src);
  const L = I.layoutTree(r.roots, Object.assign({}, LAYOUT_OPTS, { dir: 'lr' }));
  const root = L.nodes.find((n) => n.depth === 0);
  const kids = root.children;
  const mid = (kids[0].cross + kids[kids.length - 1].cross) / 2;

  ok(Math.abs(root.cross - mid) < 0.01, 'parent: cross = 首末子节点中点',
    root.cross.toFixed(3) + ' vs ' + mid.toFixed(3));

  // 与「子树包围盒中点」确实不同，说明这棵树能真正区分两种算法
  const boxMid = root.crossStart + root.cSize / 2;
  ok(Math.abs(boxMid - mid) > 0.5, 'parent: 与槽位中点确实不同（构造有效）',
    boxMid.toFixed(2) + ' vs ' + mid.toFixed(2));
}

function tBraceNextLayer() {
  const src = ['- 父', '  - 甲', '    - 甲一', '    - 甲二', '  - 乙'].join('\n');
  const r = I.parseSource(src);
  const L = I.layoutTree(r.roots, Object.assign({}, LAYOUT_OPTS, { dir: 'lr' }));
  const root = L.nodes.find((n) => n.depth === 0);
  const kids = root.children;
  const b = L.braces.find((x) => x.kind === 'branch');
  const span = b.cross2 - b.cross1;

  ok(span < root.cSize - 0.5, 'branch: 没包整棵子树（span < cSize）',
    span.toFixed(2) + ' vs ' + root.cSize.toFixed(2));

  const want = (kids[kids.length - 1].cross + kids[kids.length - 1].selfCross / 2)
    - (kids[0].cross - kids[0].selfCross / 2);
  ok(Math.abs(span - want) < 1e-9, 'branch: 恰好等于下一层各行自身占位',
    span + ' vs ' + want);

  ok(Math.abs(b.cross1 - (kids[0].cross - kids[0].selfCross / 2)) < 1e-9,
    'branch: 上沿 = 首个子节点行顶');
  ok(Math.abs(b.cross2 - (kids[kids.length - 1].cross + kids[kids.length - 1].selfCross / 2)) < 1e-9,
    'branch: 下沿 = 末个子节点行底');

  // 扁平三子节点：括号跨度 = 3 行 + 2 个间隙
  const flat = I.parseSource(['- 父', '  - 甲', '  - 乙', '  - 丙'].join('\n'));
  const LF = I.layoutTree(flat.roots, Object.assign({}, LAYOUT_OPTS, { dir: 'lr' }));
  const bf = LF.braces.find((x) => x.kind === 'branch');
  ok(Math.abs((bf.cross2 - bf.cross1) - (3 * TEXT_H + 2 * ROW_GAP)) < 1e-9,
    'branch: 三行跨度 = 3*节点高 + 2*rowGap', (bf.cross2 - bf.cross1) + '');
}

function tFontScale() {
  const roots = I.parseSource(['- 父节点', '  - 甲', '  - 乙'].join('\n')).roots;
  const base = I.OPT.baseFont;

  const optsAt = (fs) => ({
    measure: mockMeasure,
    fontSize: fs,
    lineH: Math.round(fs * 1.85),
    rowGap: Math.round(Math.round(fs * 1.85) * 0.4),
    dir: 'lr',
  });

  const wAt = (fs) => {
    const L = I.layoutTree(roots, optsAt(fs));
    const b = L.braces.find((x) => x.kind === 'branch');
    return b ? b.mainBody - b.mainTip : NaN;
  };

  // 基准字号：必须精确等于标定值，否则说明默认观感被改了
  eq(Math.round(wAt(base)), I.OPT.braceWidth, 'scale: 基准字号下括号宽度 = 标定值');

  // 字号翻倍：括号宽度跟着翻倍（允许 1px 取整误差）
  ok(Math.abs(wAt(base * 2) - I.OPT.braceWidth * 2) <= 1.01,
    'scale: 双倍字号下括号宽度翻倍', String(wAt(base * 2).toFixed(2)));

  // 字号减半：括号宽度跟着减半
  ok(Math.abs(wAt(base / 2) - I.OPT.braceWidth / 2) <= 1.01,
    'scale: 半倍字号下括号宽度减半', String(wAt(base / 2).toFixed(2)));
}

function tBox() {
  const r = I.parseSource(['box: 2', '- 父', '  - 子'].join('\n'));
  const L = I.layoutTree(r.roots, Object.assign({}, LAYOUT_OPTS, { dir: 'lr', box: r.box }));
  const p = L.nodes.find((n) => n.depth === 0);
  const c = L.nodes.find((n) => n.depth === 1);
  eq(p.boxed, false, 'box: depth 1 (root) not boxed');
  eq(c.boxed, true, 'box: depth 2 boxed');
  ok(c.bw === c.textWidth + 2 * I.OPT.boxPadX, 'box: width includes boxPadX');
  ok(c.bh === TEXT_H + 2 * I.OPT.boxPadY, 'box: height = 字高 + boxPadY');
}

suite('layout-4dir', tLayout);
suite('layout-parent-centered', tParentCentered);
suite('layout-brace-next-layer', tBraceNextLayer);
suite('box-layers', tBox);
suite('scale-by-font', tFontScale);
