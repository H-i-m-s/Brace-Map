'use strict';

/* ============================================================
 * brace-map selftest · 自动折行（maxWidth）
 * ============================================================ */

const { I, ok, eq, finite, clean, suite } = require('./framework');
const {
  FONT, LINE_H, TEXT_H, LAYOUT_OPTS, wrapMeasure, wrapBold, WRAP_OPTS,
} = require('./helpers');

function lineTexts(node) {
  return node.textLines.map((l) => l.pieces.map((p) => p.text).join(''));
}

/** 一个节点的所有字符是否一字不差地散在折行结果里 */
function linesKeepText(node) {
  return lineTexts(node).join('') === node.text;
}

function tWrapOff() {
  const body = ['- 父节点文字真的很长很长', '  - 子节点', '  - 另一个子节点'].join('\n');

  const plain = I.parseSource(body);
  eq(plain.maxWidth, 0, 'wrap-off: 不写 maxWidth 时默认为 0');

  const zero = I.parseSource('maxWidth: 0\n' + body);
  eq(zero.maxWidth, 0, 'wrap-off: maxWidth: 0 等价于不折行');

  const bad = I.parseSource('maxWidth: abc\n' + body);
  eq(bad.maxWidth, 0, 'wrap-off: maxWidth 写错当不折行');

  const a = I.buildSvg(plain, LAYOUT_OPTS);
  const b = I.buildSvg(zero, LAYOUT_OPTS);
  eq(b.markup, a.markup, 'wrap-off: maxWidth=0 的标记与不写逐字符相同');
  eq(b.width, a.width, 'wrap-off: 画布宽一致');
  eq(b.height, a.height, 'wrap-off: 画布高一致');

  ok(a.layout.nodes.every((n) => n.lineCount === 1 && n.textLines === null),
    'wrap-off: 默认全部单行');
  ok(a.markup.indexOf('<tspan x="') < 0, 'wrap-off: 不产生折行 tspan');
  ok(a.layout.nodes.every((n) => n.bh === TEXT_H + (n.boxed ? 2 * I.OPT.boxPadY : 0)),
    'wrap-off: 节点高仍是单行高');

  // 开着 maxWidth 但宽到放得下：必须回到同一条单行路径，标记依然一致
  const wide = I.parseSource('maxWidth: 4000\n' + body);
  const c = I.buildSvg(wide, LAYOUT_OPTS);
  eq(c.markup, a.markup, 'wrap-off: 放得下的 maxWidth 产出与不折行逐字符相同');
}

function tWrapCJK() {
  const src = 'maxWidth: 140\n- 转炉钢：碱性、酸性、顶吹转炉钢';
  const cfg = I.parseSource(src);
  eq(cfg.maxWidth, 140, 'wrap-cjk: 指令解析出 140');

  const built = I.buildSvg(cfg, WRAP_OPTS);
  const n = built.layout.nodes[0];
  const text = n.text;
  ok(n.lineCount > 1, 'wrap-cjk: 长中文被切成多行', String(n.lineCount));
  ok(linesKeepText(n), 'wrap-cjk: 折行不丢字不重字');
  ok(n.textLines.every((l) => l.width <= 140 + 1e-9),
    'wrap-cjk: 每行宽度都不超过 maxWidth', JSON.stringify(n.textLines.map((l) => l.width)));
  ok(n.textLines.every((l) => l.pieces.length === 1 && l.pieces[0].text.length === Array.from(l.pieces[0].text).length),
    'wrap-cjk: 中文逐字切，一行一段');

  // 140 / 14px = 每行 10 个字
  eq(lineTexts(n)[0].length, 10, 'wrap-cjk: 首行满 10 字');
  eq(n.lineCount, Math.ceil(text.length / 10), 'wrap-cjk: 行数 = ceil(字数 / 每行字数)');
  eq(n.textWidth, Math.max.apply(null, n.textLines.map((l) => l.width)),
    'wrap-cjk: 节点文字宽 = 最宽一行');
  ok(n.textWidth <= 140, 'wrap-cjk: 节点文字宽不超过 maxWidth', String(n.textWidth));

  // 标记：多行用多个 tspan + dy 换行
  const spans = built.markup.match(/<tspan x="[^"]*" dy="[^"]*">/g) || [];
  eq(spans.length, n.lineCount, 'wrap-cjk: tspan 数 = 行数');
  ok(spans[0].indexOf('dy="0"') > 0, 'wrap-cjk: 首行 dy=0');
  ok(spans[1].indexOf('dy="' + LINE_H + '"') > 0, 'wrap-cjk: 次行 dy=lineH');

  // 首行基线相对节点中心上移 (行数-1)*lineH/2
  const m = built.markup.match(/<text class="bm-text" x="[^"]*" y="([^"]*)"/);
  ok(m, 'wrap-cjk: 能找到多行 text');
  const firstY = Number(m[1]);
  ok(Math.abs(firstY - (n.y - (n.lineCount - 1) * LINE_H / 2)) < 1e-6,
    'wrap-cjk: 首行基线上移 (行数-1)*lineH/2', firstY + ' vs ' + n.y);
}

function tWrapWord() {
  const src = 'maxWidth: 100\n- alpha beta gamma delta epsilon';
  const cfg = I.parseSource(src);
  const built = I.buildSvg(cfg, WRAP_OPTS);
  const n = built.layout.nodes[0];
  const words = n.text.split(' ');

  ok(n.lineCount > 1, 'wrap-word: 英文长句被折行', String(n.lineCount));
  // 断行处的空格现在留在上一行行末，拼接回来必须逐字符等于原文
  eq(lineTexts(n).join(''), n.text, 'wrap-word: 各行拼接逐字符等于原文');
  ok(n.textLines.every((l) => l.width <= 100 + 1e-9),
    'wrap-word: 每行宽度都不超过 maxWidth', JSON.stringify(n.textLines.map((l) => l.width)));

  // 按词断：每行拆出来的片段都是完整的单词
  const pieces = [];
  for (const t of lineTexts(n)) for (const w of t.split(' ')) if (w) pieces.push(w);
  eq(pieces, words, 'wrap-word: 每行都是完整单词，没有半个词');
  ok(lineTexts(n).every((t) => t === t.trimStart()), 'wrap-word: 行首没有空格（空格只补在行末）');
  eq(n.lineCount, 3, 'wrap-word: 100px 下分成 3 行');
}

function tWrapSpaceKept() {
  // 1) 工单里的混合中英用例：断行处的空格必须一个不少
  const mixed = '这是 deliberately mixed English words 的混合测试行';
  const cfg = I.parseSource('box: 1\nmaxWidth: 200\n- ' + mixed);
  const built = I.buildSvg(cfg, WRAP_OPTS);
  const n = built.layout.nodes[0];
  const joined = lineTexts(n).join('');

  ok(n.lineCount > 1, 'wrap-space: 混合中英行被折行', String(n.lineCount));
  // 完整字符串逐字符比对，不是包含关系
  eq(joined, n.text, 'wrap-space: 各行拼接逐字符等于原文');
  eq(joined, mixed, 'wrap-space: 拼接结果等于输入原文');
  ok(joined.indexOf('deliberately mixed') >= 0, 'wrap-space: 片段 deliberately mixed 完整', joined);
  ok(joined.indexOf('words 的') >= 0, 'wrap-space: 片段 words 的 完整', joined);
  ok(lineTexts(n).every((t) => t === t.trimStart()), 'wrap-space: 空格只出现在行末，行首无缩进');
  ok(lineTexts(n).slice(0, -1).some((t) => /\s$/.test(t)), 'wrap-space: 至少一行在末尾补了空格',
    JSON.stringify(lineTexts(n)));
  // 行末空格不可见：节点宽度仍是最宽行的「可测宽度」
  ok(n.textWidth === Math.max.apply(null, n.textLines.map((l) => l.width)),
    'wrap-space: 节点宽 = 最宽行的行宽');
  ok(n.textWidth <= 200 + 1e-9, 'wrap-space: 节点宽不超过 maxWidth', String(n.textWidth));

  // 2) 纯中文（无空格）：拼接结果与原文一致，不引入多余空格
  const cn = I.buildSvg(I.parseSource('maxWidth: 140\n- 转炉钢：碱性、酸性、顶吹转炉钢'), WRAP_OPTS);
  const cnNode = cn.layout.nodes[0];
  eq(lineTexts(cnNode).join(''), cnNode.text, 'wrap-space: 中文折行拼接逐字符等于原文');
  ok(lineTexts(cnNode).every((t) => !/\s/.test(t)), 'wrap-space: 中文折行不引入空格',
    JSON.stringify(lineTexts(cnNode)));

  // 3) 边界：一行刚好填满 maxWidth，补在行末的空格不能算进去，否则会提前断行
  const edge = I.buildSvg(I.parseSource('maxWidth: 40\n- abcde fghij'), WRAP_OPTS);
  const e = edge.layout.nodes[0];
  eq(e.lineCount, 2, 'wrap-space: 边界用例分两行');
  eq(lineTexts(e)[0], 'abcde ', 'wrap-space: 断行处的空格补在上一行末尾');
  eq(e.textLines[0].width, 40, 'wrap-space: 行宽不含补上的空格（正好等于 maxWidth）');
  eq(e.textLines[1].width, 40, 'wrap-space: 次行宽度也不受补空格影响');
  ok(e.textLines.every((l) => l.width <= 40 + 1e-9), 'wrap-space: 两行都不超过 maxWidth');
  eq(lineTexts(e).join(''), 'abcde fghij', 'wrap-space: 边界用例拼接复原原文');
  eq(e.textWidth, 40, 'wrap-space: 节点宽也不含行末空格');
}

function tWrapHardBreak() {
  const word = 'supercalifragilisticexpialidocious';
  const cfg = I.parseSource('maxWidth: 80\n- ' + word);
  const built = I.buildSvg(cfg, WRAP_OPTS);
  const n = built.layout.nodes[0];

  ok(n.lineCount > 1, 'wrap-hard: 超宽单词被硬断', String(n.lineCount));
  ok(linesKeepText(n), 'wrap-hard: 硬断不丢字');
  ok(n.textLines.every((l) => l.width <= 80 + 1e-9),
    'wrap-hard: 每行都不超过 maxWidth', JSON.stringify(n.textLines.map((l) => l.width)));
  eq(n.lineCount, 4, 'wrap-hard: 34 字 / 每行 10 字 = 4 行');
  eq(lineTexts(n)[0].length, 10, 'wrap-hard: 首行填满 10 字');
  eq(lineTexts(n)[n.lineCount - 1].length, 4, 'wrap-hard: 末行剩 4 字');
}

function tWrapStyled() {
  const body = '**转炉钢碱性酸性顶吹转炉钢**';
  const src = 'maxWidth: 80\n- <font color="#d99694">' + body + '</font>';
  const cfg = I.parseSource(src);
  ok(cfg.roots[0].runs[0] && cfg.roots[0].runs[0].bold && cfg.roots[0].runs[0].color === '#d99694',
    'wrap-style: 解析出粗体 + 颜色 run');

  const built = I.buildSvg(cfg, WRAP_OPTS);
  const n = built.layout.nodes[0];
  ok(n.lineCount > 1, 'wrap-style: 带样式的 run 也被折行', String(n.lineCount));
  ok(linesKeepText(n), 'wrap-style: 样式折行不丢字');

  // 一个 run 被切成多段，每段都要还在样式里
  let pieces = 0;
  for (const l of n.textLines) {
    for (const p of l.pieces) {
      pieces++;
      ok(p.bold === true && p.color === '#d99694',
        'wrap-style: 跨行片段保留粗体与颜色', JSON.stringify(p));
    }
  }
  ok(pieces >= n.lineCount, 'wrap-style: 每行至少一段带样式 run', String(pieces));

  // 标记里每行都有 font-weight=600 + fill
  const spans = built.markup.match(/<tspan font-weight="600" fill="#d99694">/g) || [];
  ok(spans.length >= 2, 'wrap-style: 两行以上都渲染出粗体彩色 tspan', String(spans.length));
  ok(n.textLines.every((l) => l.width <= 80 + 1e-9),
    'wrap-style: 粗体行宽也不超过 maxWidth', JSON.stringify(n.textLines.map((l) => l.width)));
}

function tWrapHeight() {
  const src = 'maxWidth: 80\nbox: 1\n- supercalifragilisticexpialidocious';
  const cfg = I.parseSource(src);
  const built = I.buildSvg(cfg, WRAP_OPTS);
  const n = built.layout.nodes[0];
  const lines = n.lineCount;

  ok(lines > 1, 'wrap-height: 先确认是多行', String(lines));
  eq(n.bh, TEXT_H + (lines - 1) * LINE_H + 2 * I.OPT.boxPadY,
    'wrap-height: 框高 = 字高 + (行数-1)*lineH + 2*boxPadY');
  eq(n.bw, n.textWidth + 2 * I.OPT.boxPadX, 'wrap-height: 框宽 = 最宽行 + 2*boxPadX');
  eq(n.selfMain, n.bw, 'wrap-height: lr 下 selfMain = 节点厚（框宽）');
  eq(n.selfCross, n.bh, 'wrap-height: lr 下 selfCross = 节点高（框高）');

  // 不带框：高度 = 字高 + (行数-1) × 行距
  const plain = I.buildSvg(I.parseSource('maxWidth: 80\n- supercalifragilisticexpialidocious'), WRAP_OPTS);
  const p = plain.layout.nodes[0];
  eq(p.bh, TEXT_H + (p.lineCount - 1) * LINE_H, 'wrap-height: 无框节点高 = 字高 + (行数-1)*lineH');

  // 竖排：尺寸语义随主轴对调，但数值仍是同一套
  const vert = I.buildSvg(Object.assign({}, cfg, { dir: 'tb' }), WRAP_OPTS);
  const v = vert.layout.nodes[0];
  eq(v.selfMain, v.bh, 'wrap-height: tb 下 selfMain = 节点高');
  eq(v.selfCross, v.bw, 'wrap-height: tb 下 selfCross = 节点宽');
  eq(v.bh, TEXT_H + (v.lineCount - 1) * LINE_H + 2 * I.OPT.boxPadY, 'wrap-height: tb 下框高不变');

  // 兄弟排布用 cSize，也要跟着长高
  const tree = I.buildSvg(I.parseSource(['maxWidth: 80', '- 父', '  - supercalifragilisticexpialidocious']
    .join('\n')), WRAP_OPTS);
  const multi = tree.layout.nodes.find((x) => x.textLines && x.textLines.length > 1);
  ok(multi && multi.cSize >= multi.selfCross, 'wrap-height: 多行节点 cSize 不小于自身高');
}

function tWrapCalib() {
  const src = ['maxWidth: 80', '- 长长长长长长长长长长长长', '  - 短'].join('\n');
  const cfg = I.parseSource(src);

  const est = [];
  const built = I.buildSvg(cfg, Object.assign({}, WRAP_OPTS, {
    onWidth: (w, seq) => { est[seq] = w; },
  }));
  const wrapped = built.layout.nodes.find((n) => n.lineCount > 1);
  const single = built.layout.nodes.find((n) => n.lineCount === 1 && n.text);
  ok(wrapped && single, 'wrap-calib: 树里同时有多行与单行节点');

  // 多行节点现在也记估算值（最宽行宽），不再写 NaN 哨兵。
  // readActualWidths 已改成「按行 tspan 取最大」，两边口径一致才能比。
  ok(Number.isFinite(est[wrapped.seq]) && est[wrapped.seq] > 0,
    'wrap-calib: 多行节点记录估算的最宽行宽', String(est[wrapped.seq]));
  ok(est[wrapped.seq] <= 80 + 0.5,
    'wrap-calib: 多行节点估算宽不超过 maxWidth', String(est[wrapped.seq]));
  ok(Number.isFinite(est[single.seq]), 'wrap-calib: 单行节点仍记真实宽度', String(est[single.seq]));
  eq(est[single.seq], wrapMeasure(single.text), 'wrap-calib: 单行宽度口径未变');

  // 多行节点实测远超估算（canvas 量不到主题字体的真字宽时就会这样）：
  // 必须重排，否则方框按偏小的估算走，渲染时文字会撑出框、字被裁掉。
  let rebuilds = 0;
  const settled = I.calibrateSvg({}, {
    estWidths: est,
    readActual: () => ({
      widths: new Map([[wrapped.seq, 9999], [single.seq, est[single.seq]]]),
      max: 9999,
      count: 2,
    }),
    waitFonts: () => true,
    rebuild: () => { rebuilds++; return { markup: '<svg></svg>' }; },
  });
  // 注意：测试环境没有 DOM，rebuild 返回的 markup 过不了 replaceSvgContent，
  // 所以 settled 会是 false。这里只断言「确实尝试了重排」这一次数。
  eq(rebuilds, 1, 'wrap-calib: 多行节点漂移触发重排一次');
  ok(settled === false || settled === true, 'wrap-calib: 重排不抛异常');

  // 实测与估算一致时不该白重排
  let rebuildsSame = 0;
  I.calibrateSvg({}, {
    estWidths: est,
    readActual: () => ({
      widths: new Map([[wrapped.seq, est[wrapped.seq]], [single.seq, est[single.seq]]]),
      max: Math.max(est[wrapped.seq], est[single.seq]),
      count: 2,
    }),
    waitFonts: () => true,
    rebuild: () => { rebuildsSame++; return { markup: '<svg></svg>' }; },
  });
  eq(rebuildsSame, 0, 'wrap-calib: 实测与估算一致时不重排');

  // 单行节点的校准语义必须原样保留：真 drift 照样重排
  let rebuilds2 = 0;
  I.calibrateSvg({}, {
    estWidths: est,
    readActual: () => ({
      widths: new Map([[wrapped.seq, 9999], [single.seq, est[single.seq] + 3]]),
      max: 9999,
      count: 2,
    }),
    waitFonts: () => true,
    rebuild: () => { rebuilds2++; return { markup: '<svg></svg>' }; },
  });
  eq(rebuilds2, 1, 'wrap-calib: 单行节点漂移仍会重排一次');
}

function tWrapEmpty() {
  const body = ['- 父', '  -', '  - 子'].join('\n');
  const off = I.buildSvg(I.parseSource(body), LAYOUT_OPTS);
  const on = I.buildSvg(I.parseSource('maxWidth: 20\n' + body), LAYOUT_OPTS);

  const empty = on.layout.nodes.find((n) => !n.text);
  ok(empty, 'wrap-empty: 空节点还在');
  eq(empty.lineCount, 1, 'wrap-empty: 空节点仍是单行');
  eq(empty.textLines, null, 'wrap-empty: 空节点不生成折行结构');
  eq(empty.textWidth, 0, 'wrap-empty: 空节点宽 0');
  eq(empty.bh, TEXT_H, 'wrap-empty: 空节点高 = 字高');
  eq(on.markup, off.markup, 'wrap-empty: 空节点不受 maxWidth 影响');

  // 整棵树都放不进 20px 时，中文节点会折，但空节点仍原样
  const tight = I.buildSvg(I.parseSource('maxWidth: 20\n- 长长长\n  -\n  - 子'), WRAP_OPTS);
  const e2 = tight.layout.nodes.find((n) => !n.text);
  ok(e2 && e2.lineCount === 1 && e2.textWidth === 0, 'wrap-empty: 紧宽度下空节点依旧原样');
}

function tWrapTree() {
  // 一棵多节点树：所有折行节点的每行都不超过 maxWidth，且兄弟沿副轴仍不重叠
  const src = [
    'maxWidth: 120',
    'box: 1,2',
    '- 转炉钢：碱性、酸性、顶吹转炉钢',
    '  - 电炉钢：碳素结构钢、合金钢',
    '  - supercalifragilisticexpialidocious',
    '  - 短',
  ].join('\n');
  const cfg = I.parseSource(src);
  const built = I.buildSvg(cfg, WRAP_OPTS);
  const L = built.layout;

  ok(L.nodes.length === 4, 'wrap-tree: 节点数不变', String(L.nodes.length));
  ok(L.nodes.every((n) => !n.textLines || n.textLines.length === n.lineCount), 'wrap-tree: 行数记账一致');

  const wide = [];
  for (const n of L.nodes) {
    if (!n.textLines) continue;
    for (const l of n.textLines) if (l.width > 120 + 1e-9) wide.push([n.text, l.width]);
  }
  ok(wide.length === 0, 'wrap-tree: 所有行宽都不超过 maxWidth', JSON.stringify(wide.slice(0, 3)));

  const kids = L.nodes.filter((n) => n.depth === 1);
  let overlap = 0;
  for (let i = 0; i < kids.length - 1; i++) {
    const a = kids[i];
    const b = kids[i + 1];
    if (a.cross + a.selfCross / 2 > b.cross - b.selfCross / 2 + 1e-9) overlap++;
  }
  eq(overlap, 0, 'wrap-tree: 多行节点沿副轴不重叠');

  ok(clean(built.markup), 'wrap-tree: 标记里没有 NaN/undefined');
  ok(built.height > 0 && built.width > 0, 'wrap-tree: 画布尺寸有效');
}

function tWrap() {
  // 入口本身也要能单独调：wrapRuns 直接切行
  const lines = I.wrapRuns(I.parseRuns('转炉钢碱性酸性'), 60, wrapMeasure, wrapBold);
  ok(Array.isArray(lines) && lines.length > 1, 'wrap: wrapRuns 可直接切行', String(lines && lines.length));
  ok(lines.every((l) => l.width <= 60 + 1e-9), 'wrap: 直接调用的行宽也受限');
  eq(I.wrapRuns([], 60, wrapMeasure, wrapBold), [], 'wrap: 空 run 返回空');
  eq(I.wrapRuns(I.parseRuns('短'), 0, wrapMeasure, wrapBold), [], 'wrap: maxWidth=0 返回空');

  tWrapOff();
  tWrapCJK();
  tWrapWord();
  tWrapSpaceKept();
  tWrapHardBreak();
  tWrapStyled();
  tWrapHeight();
  tWrapCalib();
  tWrapEmpty();
  tWrapTree();
}

suite('wrap', tWrap);
