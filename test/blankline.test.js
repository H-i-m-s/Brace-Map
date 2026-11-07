'use strict';

/* ============================================================
 * brace-map selftest · 空行（代码块里空一行 = 图上空出一行的距离）
 *
 * 语义：空行隔开两个节点时，它归属两者「较浅的共同层级」，也就是上一个节点
 * 和下一个节点作为兄弟的那一层，记在下一个节点的 gapBefore 上；布局把
 * gapBefore 个空行换成 gapBefore × lineH 的额外纵向间距（lineH = 文字行高）。
 * 一个空行 = 一行，两个就是两行；开头/结尾/指令区的空行不产生间距；
 * 节点内部（续行之间）的空行不产生空行，也不产生间距。
 * ============================================================ */

const { I, ok, eq, suite } = require('./framework');
const { LAYOUT_OPTS, LINE_H, ROW_GAP, TEXT_H } = require('./helpers');

/* ------------------------------ 工具 ------------------------------ */

function lay(src, extra) {
  const cfg = I.parseSource(src);
  const L = I.layoutTree(cfg.roots, Object.assign({}, LAYOUT_OPTS, { dir: 'lr' }, extra || {}));
  return { cfg, L };
}

/** 同层相邻两个节点之间的实际间距（cross 槽位差） */
function gapOf(a, b) {
  return b.crossStart - a.crossEnd;
}

/** 所有节点的 gapBefore（前序），便于整体断言 */
function gaps(cfg) {
  const out = [];
  const walk = (list) => {
    for (const n of list) { out.push(n.gapBefore); walk(n.children); }
  };
  walk(cfg.roots);
  return out;
}

/* ------------------------------ 用例 ------------------------------ */

function tRootOneBlank() {
  const plain = lay(['- A', '- B'].join('\n'));
  const gap = lay(['- A', '', '- B'].join('\n'));

  eq(gap.cfg.roots.length, 2, 'blank-root: 空行不制造节点');
  eq(gap.cfg.roots[0].gapBefore, 0, 'blank-root: 第一个节点前面没有空行');
  eq(gap.cfg.roots[1].gapBefore, 1, 'blank-root: 第二个节点记 1 个空行');
  eq(gaps(gap.cfg), [0, 1], 'blank-root: 只有一处空行');

  eq(gapOf(plain.cfg.roots[0], plain.cfg.roots[1]), ROW_GAP, 'blank-root: 无空行时 = rowGap');
  eq(gapOf(gap.cfg.roots[0], gap.cfg.roots[1]), ROW_GAP + LINE_H, 'blank-root: 一个空行 = 多加一行');

  eq(gap.L.height - plain.L.height, LINE_H, 'blank-root: 画布正好高出一行');
  eq(gap.cfg.roots[1].text, 'B', 'blank-root: 文字不受影响');
}

function tRootTwoBlanks() {
  const plain = lay(['- A', '- B'].join('\n'));
  const two = lay(['- A', '', '', '- B'].join('\n'));

  eq(two.cfg.roots[1].gapBefore, 2, 'blank-2root: 连续两个空行记 2');
  eq(gapOf(two.cfg.roots[0], two.cfg.roots[1]), ROW_GAP + 2 * LINE_H,
    'blank-2root: 两个空行 = 两行');
  eq(two.L.height - plain.L.height, 2 * LINE_H, 'blank-2root: 画布高出两行');

  // 三个空行就是三行：不是「有空行就意思一下」
  const three = lay(['- A', '', '', '', '- B'].join('\n'));
  eq(gapOf(three.cfg.roots[0], three.cfg.roots[1]), ROW_GAP + 3 * LINE_H,
    'blank-3root: 三个空行 = 三行');
}

function tChildOneBlank() {
  const plain = lay(['- 父', '  - 甲', '  - 乙', '  - 丙'].join('\n'));
  const gap = lay(['- 父', '  - 甲', '  - 乙', '', '  - 丙'].join('\n'));

  const p = gap.cfg.roots[0];
  eq(p.children.length, 3, 'blank-child: 子节点数不变');
  eq(gaps(gap.cfg), [0, 0, 0, 1], 'blank-child: 空行记在第三个子节点上');
  eq(gapOf(p.children[1], p.children[2]), ROW_GAP + LINE_H, 'blank-child: 二级节点间空出一行');
  eq(gapOf(p.children[0], p.children[1]), ROW_GAP, 'blank-child: 相邻的另一对不受影响');

  eq(p.cSize - plain.cfg.roots[0].cSize, LINE_H, 'blank-child: 父节点占位跟着长一行');
  eq(gap.L.height - plain.L.height, LINE_H, 'blank-child: 画布高出正好一行');

  // 括号跨度 = 3 行文字 + 2 个 rowGap + 1 个空行
  const br = gap.L.braces.find((b) => b.kind === 'branch');
  ok(Math.abs((br.cross2 - br.cross1) - (3 * TEXT_H + 2 * ROW_GAP + LINE_H)) < 1e-9,
    'blank-child: 括号跨度含空行', (br.cross2 - br.cross1) + '');
}

function tRootNotChildLevel() {
  // 空行落在 A 的末尾与 B 的开头之间：归根层级，不牵扯两个子项
  const src = ['- A', '  - A1', '', '- B', '  - B1'].join('\n');
  const { cfg, L } = lay(src);

  eq(cfg.roots[1].gapBefore, 1, 'blank-root-level: 记在根层级（B 上）');
  eq(cfg.roots[0].children[0].gapBefore, 0, 'blank-root-level: A1 不带间距');
  eq(cfg.roots[1].children[0].gapBefore, 0, 'blank-root-level: B1 不带间距');
  eq(gaps(cfg), [0, 0, 1, 0], 'blank-root-level: 只有根这一层有空行');
  eq(gapOf(cfg.roots[0], cfg.roots[1]), ROW_GAP + LINE_H, 'blank-root-level: 一级节点间空出一行');
  ok(L.height > 0, 'blank-root-level: 布局正常');
}

function tEdgeBlanks() {
  const plain = lay(['- A', '- B'].join('\n'));
  const lead = lay(['', '', '- A', '- B', '', ''].join('\n'));
  const multi = lay(['', '', '', '', '- A', '- B', '', '', ''].join('\n'));

  eq(gaps(lead.cfg), [0, 0], 'blank-edge: 开头/结尾空行不产生间距');
  eq(gaps(multi.cfg), [0, 0], 'blank-edge: 多个开头空行也不产生间距');
  eq(lead.L.height, plain.L.height, 'blank-edge: 画布高度与无空行一致');
  eq(multi.L.height, plain.L.height, 'blank-edge: 多个开头空行不改变高度');
  eq(lead.cfg.roots.map((n) => n.text), ['A', 'B'], 'blank-edge: 节点照常解析');

  // 只有开头空行的单节点
  const solo = lay(['', '', '- 甲'].join('\n'));
  eq(gaps(solo.cfg), [0], 'blank-edge: 单节点 + 开头空行仍无间距');
}

function tDirectiveBlanks() {
  const plain = lay(['dir: lr', 'float: left', 'width: 200', '- A', '- B'].join('\n'));
  const gap = lay(['dir: lr', '', 'float: left', '', '', 'width: 200', '', '- A', '- B', '',
    'brace: curly'].join('\n'));

  eq(gaps(gap.cfg), [0, 0], 'blank-dir: 指令区空行不产生间距');
  eq(gap.L.height, plain.L.height, 'blank-dir: 高度不变');
  eq(gap.cfg.float, 'left', 'blank-dir: 指令照常生效');
  eq(gap.cfg.width, 200, 'blank-dir: width 照常生效');
  eq(gap.cfg.dir, 'lr', 'blank-dir: dir 照常生效');
}

function tContinuationMixed() {
  // 空行夹在同一个节点的续行之间：不留空行、不产生间距
  const inNode = lay(['- 普通平键', '  按端部形状分', '', '  这是第三行'].join('\n'));
  const n = inNode.cfg.roots[0];
  eq(inNode.cfg.roots.length, 1, 'blank-cont: 节点内部空行不制造节点');
  eq(n.text, '普通平键按端部形状分这是第三行', 'blank-cont: 文字照常拼起来');
  eq(n.segRuns.length, 3, 'blank-cont: 空行不留空段');
  eq(n.gapBefore, 0, 'blank-cont: 节点内部空行不记间距');
  const drawn = I.buildSvg(inNode.cfg, LAYOUT_OPTS).layout.nodes[0];
  eq(drawn.lineCount, 3, 'blank-cont: 出图是三行，没有空白行');

  // 续行之后跟兄弟节点：空行归到兄弟那一层
  const afterCont = lay(['- 甲', '  续行', '', '- 乙'].join('\n'));
  eq(afterCont.cfg.roots[1].gapBefore, 1, 'blank-cont: 续行后的空行隔开兄弟');
  eq(gapOf(afterCont.cfg.roots[0], afterCont.cfg.roots[1]), ROW_GAP + LINE_H,
    'blank-cont: 续行节点与兄弟之间空出一行');

  // 空行之后紧跟续行，再紧跟兄弟：空行只归最近的那个节点
  const mixed = lay(['- 甲', '', '  续行', '- 乙'].join('\n'));
  eq(mixed.cfg.roots[0].segRuns.length, 2, 'blank-cont: 空行后的续行仍接进上一个节点');
  eq(mixed.cfg.roots[1].gapBefore, 0, 'blank-cont: 续行吃掉了空行计数');
}

function tFirstChildDropped() {
  // 空行后面是本层的第一个子项：没有前一个兄弟可隔，空行丢掉
  const first = lay(['- A', '', '  - A1'].join('\n'));
  eq(first.cfg.roots[0].children[0].gapBefore, 0, 'blank-first: 第一个子项前空行无效');
  eq(gaps(first.cfg), [0, 0], 'blank-first: 整棵树没有间距');

  const deep = lay(['- A', '  - A1', '', '    - A1a'].join('\n'));
  eq(deep.cfg.roots[0].children[0].children[0].gapBefore, 0,
    'blank-first: 更深一层的第一个子项同样无效');
}

function tDeepThenShallow() {
  // 空行跨两层：上一个节点在最深处，下一个节点回到浅一层 → 归共同父层级
  const { cfg } = lay(['- A', '  - A1', '    - A1a', '', '  - A2'].join('\n'));
  eq(gaps(cfg), [0, 0, 0, 1], 'blank-multilevel: 记在 A 的子项间距上');
  eq(cfg.roots[0].children[1].gapBefore, 1, 'blank-multilevel: A2 带间距');

  // 三处空行各归各层
  const multi = lay(['- A', '  - A1', '  - A2', '', '  - A3', '', '- B',
    '  - B1', '', '  - B2'].join('\n'));
  eq(gaps(multi.cfg), [0, 0, 0, 1, 1, 0, 1], 'blank-multilevel: 各层分别记数');
}

function tNoBlankRegression() {
  const src = ['- 父', '  - 甲', '  - 乙', '    - 乙一', '    - 乙二', '  - 丙'].join('\n');
  const plain = lay(src);
  eq(gaps(plain.cfg), [0, 0, 0, 0, 0, 0], 'blank-regress: 无空行时全部 gapBefore = 0');

  const p = plain.cfg.roots[0];
  eq(gapOf(p.children[0], p.children[1]), ROW_GAP, 'blank-regress: 兄弟间距仍是 rowGap');
  eq(gapOf(p.children[1], p.children[2]), ROW_GAP, 'blank-regress: 各对兄弟间距都是 rowGap');
  eq(gapOf(p.children[1].children[0], p.children[1].children[1]), ROW_GAP,
    'blank-regress: 孙辈间距也仍是 rowGap');

  // 同一棵树插入空行后：几何只多出空行那段距离，其余量一律不变
  const gap = lay(['- 父', '  - 甲', '  - 乙', '    - 乙一', '    - 乙二', '', '  - 丙'].join('\n'));
  const a = plain.L.nodes;
  const b = gap.L.nodes;
  eq(b.length, a.length, 'blank-regress: 节点数不变');
  eq(b.map((n) => n.seq), a.map((n) => n.seq), 'blank-regress: data-seq 不变');
  eq(b.map((n) => n.textWidth), a.map((n) => n.textWidth), 'blank-regress: 文字宽度不变');
  eq(b.map((n) => n.lineCount), a.map((n) => n.lineCount), 'blank-regress: 行数不变');
  eq(b.map((n) => n.w), a.map((n) => n.w), 'blank-regress: 框宽不变');
  eq(b.map((n) => n.h), a.map((n) => n.h), 'blank-regress: 框高不变');
  eq(b.map((n) => n.main), a.map((n) => n.main), 'blank-regress: 生长轴坐标不变');
  eq(gap.L.height - plain.L.height, LINE_H, 'blank-regress: 只高出一行');
  eq(gap.L.width, plain.L.width, 'blank-regress: 宽度不变');
}

function tBoxUnaffected() {
  const plain = lay(['- A', '- B'].join('\n'), { box: [1] });
  const gap = lay(['- A', '', '- B'].join('\n'), { box: [1] });
  eq(gap.cfg.roots.map((n) => n.bh), plain.cfg.roots.map((n) => n.bh), 'blank-box: 框高不变');
  eq(gap.cfg.roots.map((n) => n.bw), plain.cfg.roots.map((n) => n.bw), 'blank-box: 框宽不变');
  eq(gapOf(gap.cfg.roots[0], gap.cfg.roots[1]), ROW_GAP + LINE_H, 'blank-box: 间距照常加一行');
}

function tVerticalDirs() {
  // 竖排时「空一行」作用在 x 上，间距口径不变
  for (const dir of ['tb', 'bt']) {
    const plain = lay(['- A', '- B'].join('\n'), { dir });
    const gap = lay(['- A', '', '- B'].join('\n'), { dir });
    const dx = Math.abs(gap.cfg.roots[1].x - gap.cfg.roots[0].x);
    const px = Math.abs(plain.cfg.roots[1].x - plain.cfg.roots[0].x);
    ok(Math.abs(dx - px - LINE_H) < 1e-9, 'blank-dir[' + dir + ']: 竖向画布也空出一行',
      dx + ' vs ' + px);
    eq(gap.L.width - plain.L.width, LINE_H, 'blank-dir[' + dir + ']: 画布宽出一行');
  }
}

suite('blank-root-one', tRootOneBlank);
suite('blank-root-two', tRootTwoBlanks);
suite('blank-child-one', tChildOneBlank);
suite('blank-level-root', tRootNotChildLevel);
suite('blank-edges', tEdgeBlanks);
suite('blank-directives', tDirectiveBlanks);
suite('blank-continuation', tContinuationMixed);
suite('blank-first-child', tFirstChildDropped);
suite('blank-multilevel', tDeepThenShallow);
suite('blank-regression', tNoBlankRegression);
suite('blank-box', tBoxUnaffected);
suite('blank-vertical', tVerticalDirs);
