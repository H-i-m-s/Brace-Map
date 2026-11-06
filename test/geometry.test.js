'use strict';

/* ============================================================
 * brace-map selftest · 几何复核：居中、等距、比例、包围盒、末端总括号、16 组合
 * ============================================================ */

const { I, ok, eq, finite, clean, suite } = require('./framework');
const { FONT, LAYOUT_OPTS, SRC_FULL, textEls, pathPoints } = require('./helpers');

function tTextCentered() {
  const r = I.parseSource(['box: 1,2', '- 父节点', '  - 子甲', '  - 子乙'].join('\n'));

  for (const dir of ['lr', 'rl', 'tb', 'bt']) {
    const built = I.buildSvg(Object.assign({}, r, { dir }), LAYOUT_OPTS);
    const els = textEls(built.markup);
    eq(els.length, built.layout.nodes.length, 'text[' + dir + ']: text 元素数 = 节点数');

    const boxed = built.layout.nodes.filter((n) => n.boxed);
    ok(boxed.length === built.layout.nodes.length, 'text[' + dir + ']: 都是带框节点', String(boxed.length));

    built.layout.nodes.forEach((n, i) => {
      const el = els[i];
      if (!el || !n.boxed) return;
      ok(Math.abs(el.x - n.x) < 1e-3, 'text[' + dir + ']: 带框 text.x = 节点中心',
        el.x + ' vs ' + n.x);
      eq(el.anchor, 'middle', 'text[' + dir + ']: 带框 text-anchor = middle');
    });

    for (const n of boxed) {
      const p = I.textPlace(n, dir);
      ok(Math.abs(p.x - n.x) < 1e-9 && p.anchor === 'middle',
        'textPlace[' + dir + ']: 带框居中');
    }
  }

  // 不带框的横生长节点保持边缘对齐锚点
  const plain = I.parseSource(['- 父', '  - 子'].join('\n'));
  const L = I.layoutTree(plain.roots, Object.assign({}, LAYOUT_OPTS, { dir: 'lr' }));
  const leaf = L.nodes.find((n) => n.depth === 1);
  ok(leaf && !leaf.boxed, 'textPlace: 找到不带框节点');
  if (leaf) {
    eq(I.textPlace(leaf, 'lr').anchor, 'start', 'textPlace: lr 不带框用 start');
    eq(I.textPlace(leaf, 'rl').anchor, 'end', 'textPlace: rl 不带框用 end');
    ok(Math.abs(I.textPlace(leaf, 'lr').x - (leaf.x - leaf.w / 2)) < 1e-9, 'textPlace: lr 锚点在左边缘');
    ok(Math.abs(I.textPlace(leaf, 'rl').x - (leaf.x + leaf.w / 2)) < 1e-9, 'textPlace: rl 锚点在右边缘');
  }
}

function tBraceGaps() {
  const roots = I.parseSource([
    '- 父节点',
    '  - 甲',
    '  - 乙丙丁戊',
    '    - 孙一',
    '    - 孙二',
    '- 另一个根',
    '  - 子',
  ].join('\n')).roots;

  for (const dir of ['lr', 'rl', 'tb', 'bt']) {
    const L = I.layoutTree(roots, Object.assign({}, LAYOUT_OPTS, { dir }));
    const branches = L.braces.filter((b) => b.kind === 'branch');
    ok(branches.length >= 2, 'gap[' + dir + ']: 有分支括号', String(branches.length));

    for (const b of branches) {
      const n = b.owner;
      ok(!!n, 'gap[' + dir + ']: 括号带着父节点引用');
      if (!n) continue;
      const parentEnd = n.main + n.mSize / 2;
      let childStart = Infinity;
      for (const k of n.children) childStart = Math.min(childStart, k.main - k.mSize / 2);
      const left = b.mainTip - parentEnd;      // 父末端 → 尖端
      const right = childStart - b.mainBody;   // body → 子列起点
      ok(Math.abs(left - right) < 0.01, 'gap[' + dir + ']: 两侧留白相等',
        left.toFixed(4) + ' vs ' + right.toFixed(4));
      ok(left > 0, 'gap[' + dir + ']: 尖端没贴父节点', String(left));
      ok(Math.abs((b.mainBody - b.mainTip) - I.OPT.braceWidth) < 1e-9,
        'gap[' + dir + ']: 括号宽度 = braceWidth');
    }
  }

  // closing：内容末端 → body 与 tip → 画布内边距线等距
  const L2 = I.layoutTree(roots, Object.assign({}, LAYOUT_OPTS, { dir: 'lr', closing: true }));
  const c = L2.braces.find((b) => b.kind === 'closing');
  ok(!!c, 'gap: 找得到 closing 括号');
  if (c) {
    const leaves = L2.nodes.filter((n) => !n.children.length);
    const mEnd = Math.max.apply(null, leaves.map((l) => l.main + l.mSize / 2));
    const avail = I.OPT.braceWidth + I.OPT.colGap + I.OPT.pad;
    const gapIn = c.mainBody - mEnd;
    const gapOut = (mEnd + avail) - c.mainTip;
    ok(Math.abs(gapIn - gapOut) < 0.01, 'gap: closing 居中在内容与内边距之间',
      gapIn.toFixed(4) + ' vs ' + gapOut.toFixed(4));
  }
}

function tBraceRatio() {
  const w = I.OPT.braceWidth;
  eq(w, 10, 'ratio: braceWidth = 10');
  eq(I.OPT.colGap, 16, 'ratio: colGap = 16');

  for (const H of [30, 60, 120, 240]) {
    const k = I.braceK(w, H);
    const r = k.kHook;
    const t = k.kTip;
    const label = 'ratio[' + H + ']';
    ok(finite(r) && finite(t), label + ': r/t finite');
    ok(r > 0 && t > 0, label + ': r/t 为正', r + '/' + t);
    ok(r / H <= I.OPT.hookRatio + 1e-9, label + ': r/H <= 0.15', (r / H).toFixed(4));
    ok(t / H <= I.OPT.tipRatio + 1e-9, label + ': t/H <= 0.11', (t / H).toFixed(4));
    ok(2 * (r + t) < H, label + ': 2*(r+t) < H', (2 * (r + t)).toFixed(2) + ' vs ' + H);
    ok(H - 2 * (r + t) >= I.OPT.minStraight - 1e-9, label + ': 中间直线 >= 4',
      (H - 2 * (r + t)).toFixed(2));
  }

  // 小 span：比例直接生效（4.5 / 3.3）
  const k30 = I.braceK(w, 30);
  ok(Math.abs(k30.kHook - 4.5) < 1e-9 && Math.abs(k30.kTip - 3.3) < 1e-9,
    'ratio: span30 正好是 0.15 / 0.11', JSON.stringify(k30));

  // 大 span：撞 w 的上限（6 / 5）
  const k240 = I.braceK(w, 240);
  ok(Math.abs(k240.kHook - w * I.OPT.hookMaxRatio) < 1e-9, 'ratio: span240 r 封顶 6', String(k240.kHook));
  ok(Math.abs(k240.kTip - w * I.OPT.tipMaxRatio) < 1e-9, 'ratio: span240 t 封顶 5', String(k240.kTip));

  // 随 span 单调不减（不会忽大忽小）
  const seq = [6, 8, 12, 20, 40, 80, 160, 320].map((H) => I.braceK(w, H));
  for (let i = 0; i + 1 < seq.length; i++) {
    ok(seq[i].kHook <= seq[i + 1].kHook + 1e-9, 'ratio: r 随 span 单调不减 #' + i);
    ok(seq[i].kTip <= seq[i + 1].kTip + 1e-9, 'ratio: t 随 span 单调不减 #' + i);
  }
}

function tBBox() {
  const r = I.parseSource(SRC_FULL);
  let checked = 0;

  for (const dir of ['lr', 'rl', 'tb', 'bt']) {
    for (const brace of ['curly', 'square']) {
      for (const closing of [false, true]) {
        const built = I.buildSvg(Object.assign({}, r, { dir, brace, closing }), LAYOUT_OPTS);
        const L = built.layout;
        const W = built.width;
        const H = built.height;
        const dy = built.titleH || 0;
        const label = 'bbox[' + dir + '/' + brace + '/closing=' + closing + ']';
        const bad = [];

        for (const b of L.braces) {
          for (const p of pathPoints(b.d)) {
            const x = p[0];
            const y = p[1] + dy;
            if (!(x >= -0.001 && x <= W + 0.001 && y >= -0.001 && y <= H + 0.001)) {
              bad.push([b.kind, x, y]);
            }
          }
        }

        for (const n of L.nodes) {
          const y = n.y + dy;
          if (n.boxed) {
            const x0 = n.x - n.bw / 2;
            const x1 = n.x + n.bw / 2;
            const y0 = y - n.bh / 2;
            const y1 = y + n.bh / 2;
            if (x0 < -0.001 || x1 > W + 0.001 || y0 < -0.001 || y1 > H + 0.001) {
              bad.push(['rect', n.text]);
            }
          }
          const tp = I.textPlace(n, dir);
          if (tp.x < -0.001 || tp.x > W + 0.001 || y < -0.001 || y > H + 0.001) {
            bad.push(['text', n.text]);
          }
        }

        ok(bad.length === 0, label + ': 所有元素在 viewBox 内', JSON.stringify(bad.slice(0, 3)));
        checked++;
      }
    }
  }
  eq(checked, 16, 'bbox: 16 组都查了');
}

function tSvg() {
  const r = I.parseSource(SRC_FULL);
  const combos = [];
  for (const dir of ['lr', 'rl', 'tb', 'bt']) {
    for (const brace of ['curly', 'square']) {
      combos.push({ dir, brace, closing: false });
      combos.push({ dir, brace, closing: true });
    }
  }
  ok(combos.length === 16, 'svg: 4 dirs x 2 styles x closing on/off');

  for (const c of combos) {
    const built = I.buildSvg(Object.assign({}, r, { dir: c.dir, brace: c.brace, closing: c.closing }), LAYOUT_OPTS);
    const label = 'svg[' + c.dir + '/' + c.brace + '/closing=' + c.closing + ']';
    ok(typeof built.markup === 'string' && built.markup.length > 0, label + ': non-empty');
    ok(built.markup.indexOf('<svg') >= 0, label + ': has <svg');
    ok(clean(built.markup), label + ': no NaN/undefined');
    ok(built.width > 0 && built.height > 0, label + ': size > 0');
    ok(built.layout.braces.length >= 3, label + ': has braces', String(built.layout.braces.length));
    ok(built.markup.indexOf('平炉钢') >= 0, label + ': text rendered');
  }

  // closing: true 时多一个总括号
  const withClosing = I.buildSvg(Object.assign({}, r, { closing: true }), LAYOUT_OPTS);
  const withoutClosing = I.buildSvg(Object.assign({}, r, { closing: false }), LAYOUT_OPTS);
  eq(withClosing.layout.braces.length - withoutClosing.layout.braces.length, 1, 'closing: adds exactly one brace');
  ok(withClosing.markup.indexOf('NaN') < 0, 'closing: markup clean');
}

function tClosing() {
  const r = I.parseSource(['- 父', '  - 甲', '  - 乙'].join('\n'));
  const off = I.layoutTree(r.roots, Object.assign({}, LAYOUT_OPTS, { dir: 'lr', closing: false }));
  const on = I.layoutTree(r.roots, Object.assign({}, LAYOUT_OPTS, { dir: 'lr', closing: true }));
  eq(on.braces.length - off.braces.length, 1, 'closing: 只多一个括号');

  const c = on.braces.find((b) => b.kind === 'closing');
  ok(!!c, 'closing: 找得到总括号');
  ok(c.mainTip > c.mainBody, 'closing: 尖端在外侧（main 方向）');
  ok(c.d.startsWith('M ' + c.mainBody + ' '), 'closing: 首点贴内容侧', c.d);
  ok(clean(c.d), 'closing: no NaN/undefined', c.d);

  // 普通分支括号：尖端靠父、开口靠子
  const branch = on.braces.find((b) => b.kind === 'branch');
  ok(branch.mainTip < branch.mainBody, 'branch: 尖端靠父节点侧');

  // 总括号只覆盖叶子自身（selfCross），不按子树尺寸
  const leaves = on.nodes.filter((n) => !n.children.length);
  const want1 = Math.min.apply(null, leaves.map((l) => l.cross - l.selfCross / 2));
  const want2 = Math.max.apply(null, leaves.map((l) => l.cross + l.selfCross / 2));
  ok(Math.abs(c.cross1 - want1) < 1e-9, 'closing: 上沿 = 叶子行顶', c.cross1 + ' vs ' + want1);
  ok(Math.abs(c.cross2 - want2) < 1e-9, 'closing: 下沿 = 叶子行底', c.cross2 + ' vs ' + want2);
}

suite('closing-brace', tClosing);
suite('text-centered', tTextCentered);
suite('brace-gap-equal', tBraceGaps);
suite('brace-ratio', tBraceRatio);
suite('bbox-in-viewbox', tBBox);
suite('svg-16combos', tSvg);
