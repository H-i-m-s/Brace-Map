'use strict';

/* ============================================================
 * brace-map selftest · 续行（软换行）与 <br> 硬换行
 *
 * 两件事各占一半：
 *   续行  缩进比上一个节点深的一行 = 它的续行，拼进同一节点后重新走行内解析
 *   硬换行 节点文字里的 <br> / <br/> / <br />，渲染成独立行（不占字符、不留空行）
 * 两者可以叠加：先按 <br> 分段，每段内部再按 maxWidth 折行。
 * ============================================================ */

const { I, ok, eq, suite } = require('./framework');
const { LAYOUT_OPTS, WRAP_OPTS, TEXT_H, LINE_H } = require('./helpers');

/* ------------------------------ 工具 ------------------------------ */

function lineTexts(node) {
  return node.textLines.map((l) => l.pieces.map((p) => p.text).join(''));
}

/** 前序遍历所有节点 */
function flatNodes(cfg) {
  const out = [];
  const walk = (list) => {
    for (const n of list) { out.push(n); walk(n.children); }
  };
  walk(cfg.roots);
  return out;
}

function tspanCount(markup) {
  // 行 tspan 都带 x；样式 tspan（fill / font-weight）由 renderRuns 生成，不带 x
  return (String(markup).match(/<tspan x="/g) || []).length;
}

/* ------------------------------ 续行 ------------------------------ */

function tSoftChinese() {
  const cfg = I.parseSource(['- 普通平键', '  按端部形状分'].join('\n'));
  eq(cfg.roots.length, 1, 'soft-cn: 续行不产生新节点');
  eq(cfg.roots[0].children.length, 0, 'soft-cn: 续行不是子节点');
  eq(cfg.roots[0].text, '普通平键按端部形状分', 'soft-cn: 中文之间不加空格');
  eq(cfg.roots[0].segRuns.length, 1, 'soft-cn: 续行不是硬换行，仍是一段');
  eq(cfg.roots[0].runs.length, 1, 'soft-cn: 拼完还是一段 run');
  eq(cfg.roots[0].raw, '普通平键按端部形状分', 'soft-cn: raw 里记着拼好的原文');
}

function tSoftEnglish() {
  const cfg = I.parseSource(['- Type A', '  and B'].join('\n'));
  eq(cfg.roots[0].text, 'Type A and B', 'soft-en: 英文之间补空格');

  // 接缝两侧只要有一侧是 ASCII 字母数字就补空格，否则不补
  const tail = I.parseSource(['- 甲A', '  乙'].join('\n'));
  eq(tail.roots[0].text, '甲A 乙', 'soft-en: 上行末尾是 ASCII → 补空格');
  const head = I.parseSource(['- 甲', '  B型'].join('\n'));
  eq(head.roots[0].text, '甲 B型', 'soft-en: 本行开头是 ASCII → 补空格');
}

function tSoftStyle() {
  const cfg = I.parseSource(['- 普通平键', '  按 **端部形状** 分'].join('\n'));
  eq(cfg.roots[0].text, '普通平键按 端部形状 分', 'soft-style: 续行里的粗体标记照常剥掉');
  const bold = cfg.roots[0].runs.filter((r) => r.bold).map((r) => r.text);
  eq(bold, ['端部形状'], 'soft-style: 续行里的 **粗体** 仍解析成粗体 run');
  ok(cfg.roots[0].runs.length >= 3, 'soft-style: 粗体前后各有一段普通文字');

  const built = I.buildSvg(cfg, LAYOUT_OPTS);
  const n = built.layout.nodes[0];
  eq(n.lineCount, 1, 'soft-style: 续行不带来额外行');
  ok(built.markup.indexOf('font-weight="600"') > 0, 'soft-style: 出图里带粗体 tspan');
  ok(built.markup.indexOf('**') < 0, 'soft-style: 标记不进图');
}

function tSoftMath() {
  const cfg = I.parseSource(['- 面积', '  为 $x^2$ 平方厘米'].join('\n'));
  eq(cfg.roots[0].text, '面积为$x^2$平方厘米', 'soft-math: 拼好后公式围栏还在原文里');
  const maths = cfg.roots[0].runs.filter((r) => r.math).map((r) => r.math);
  eq(maths, ['x^2'], 'soft-math: 续行里的公式解析成 math run');

  const cfg2 = I.parseSource(['- 见', '  [[笔记]]'].join('\n'));
  eq(cfg2.roots[0].text, '见笔记', 'soft-link: 续行里的双链照常解析');
  eq(cfg2.roots[0].runs.filter((r) => r.href).map((r) => r.href), ['笔记'],
    'soft-link: 续行里的双链带 href');
}

function tSoftColon() {
  // 中文键：DIR_RE 的 \w 只认 ASCII，本来就不是指令，现在按续行并进去
  const zh = I.parseSource(['- 普通平键', '  注意: 这个很重要'].join('\n'));
  eq(zh.roots.length, 1, 'soft-colon: 中文冒号行没被当成指令吃掉');
  eq(zh.roots[0].text, '普通平键注意: 这个很重要', 'soft-colon: 中文冒号行并进上一个节点');

  // ASCII 未知键：长得像指令，但键不在白名单 → 仍是续行
  const en = I.parseSource(['- 普通平键', '  note: 这个很重要'].join('\n'));
  eq(en.roots[0].text, '普通平键 note: 这个很重要', 'soft-colon: 未知键的冒号行当续行');
  eq(en.roots[0].segRuns.length, 1, 'soft-colon: 未知键没有制造新节点或新行');
}

function tSoftDirWins() {
  const cfg = I.parseSource(['- 普通平键', '  float: left', '  maxWidth: 100', '- 甲'].join('\n'));
  eq(cfg.float, 'left', 'soft-dir: 白名单键仍是指令（float）');
  eq(cfg.maxWidth, 100, 'soft-dir: 白名单键仍是指令（maxWidth，大小写不敏感）');
  eq(cfg.roots.length, 2, 'soft-dir: 指令行没有变成文字，也没吃掉节点');
  eq(cfg.roots[0].text, '普通平键', 'soft-dir: 上一个节点的文字没被指令污染');
  eq(cfg.roots[0].children.length, 0, 'soft-dir: 指令行不制造子节点');
  eq(cfg.roots[1].text, '甲', 'soft-dir: 后面的节点照常');
}

function tSoftMulti() {
  const cfg = I.parseSource([
    '- 普通平键',
    '  按端部形状分',
    '  有 A 型和 B 型',
    '  常用 45 钢',
  ].join('\n'));
  eq(cfg.roots.length, 1, 'soft-multi: 三条续行还是同一个节点');
  eq(cfg.roots[0].text, '普通平键按端部形状分有 A 型和 B 型常用 45 钢',
    'soft-multi: 连续续行按顺序拼接');
  eq(cfg.roots[0].segRuns.length, 1, 'soft-multi: 连续续行不产生硬换行');
}

function tSoftGuard() {
  // 缩进不深于上一个节点 → 不是续行，保持原来的「忽略」
  const same = I.parseSource(['- 甲', '  - 乙', '  丙'].join('\n'));
  eq(same.roots[0].children[0].text, '乙', 'soft-guard: 同缩进的行没并进乙');
  eq(flatNodes(same).length, 2, 'soft-guard: 节点数不变');

  const top = I.parseSource(['- 甲', '某某'].join('\n'));
  eq(top.roots[0].text, '甲', 'soft-guard: 顶格的散文字仍然忽略');

  // 续行之后紧跟子节点：层次不乱
  const mix = I.parseSource(['- 普通平键', '  按端部形状分', '  - A 型', '    - 双圆头'].join('\n'));
  eq(mix.roots[0].text, '普通平键按端部形状分', 'soft-guard: 续行并进父节点');
  eq(mix.roots[0].children.length, 1, 'soft-guard: 后面的列表项仍是子节点');
  eq(mix.roots[0].children[0].text, 'A 型', 'soft-guard: 子节点文字正确');
  eq(mix.roots[0].children[0].children.length, 1, 'soft-guard: 更深一层没受影响');

  // 续行参与折行：合并后的文字一起按 maxWidth 切
  const wrap = I.buildSvg(I.parseSource(['maxWidth: 80', '- 普通平键', '  按端部形状分'].join('\n')),
    WRAP_OPTS);
  const n = wrap.layout.nodes[0];
  ok(n.lineCount > 1, 'soft-guard: 续行拼完的长文字仍会被 maxWidth 折开', String(n.lineCount));
  eq(lineTexts(n).join(''), n.text, 'soft-guard: 折行不丢字');
}

/* ------------------------------ 硬换行 ------------------------------ */

function tBrParse() {
  const cfg = I.parseSource('- 第一行<br>第二行');
  eq(cfg.roots[0].segRuns.length, 2, 'br-parse: <br> 切成两段');
  eq(cfg.roots[0].text, '第一行第二行', 'br-parse: <br> 本身不占字符');
  eq(cfg.roots[0].runs.length, 2, 'br-parse: 拍平后是两段 run');

  const lines = I.parseRunsLines('甲<br>乙');
  eq(lines.length, 2, 'br-parse: parseRunsLines 返回两行');
  eq(lines.map((l) => I.runsText(l)), ['甲', '乙'], 'br-parse: 每行文字各归各位');
  eq(I.runsText(I.parseRuns('甲<br>乙')), '甲乙', 'br-parse: parseRuns 按行拍平、不补空格');
}

function tBrRender() {
  const built = I.buildSvg(I.parseSource('- 甲<br>乙'), LAYOUT_OPTS);
  const n = built.layout.nodes[0];
  eq(n.lineCount, 2, 'br-render: 硬换行是两行');
  eq(lineTexts(n), ['甲', '乙'], 'br-render: 两行文字');
  ok(built.markup.indexOf('<br') < 0, 'br-render: 标记里不留 <br>');

  const spans = built.markup.match(/<tspan x="[^"]*" dy="[^"]*">/g) || [];
  eq(spans.length, 2, 'br-render: 两行各一个行 tspan');
  ok(spans[0].indexOf('dy="0"') > 0, 'br-render: 首行 dy=0');
  ok(spans[1].indexOf('dy="' + LINE_H + '"') > 0, 'br-render: 次行 dy=lineH');
  eq(n.bh, TEXT_H + LINE_H, 'br-render: 节点高 = 字高 + 一个行距');
  eq(n.selfCross, n.bh, 'br-render: lr 下副轴占位就是节点高');
}

function tBrVariants() {
  const base = I.buildSvg(I.parseSource('- 甲<br>乙'), LAYOUT_OPTS).markup;
  for (const tag of ['<br/>', '<br />', '<BR>', '<Br/>']) {
    const other = I.buildSvg(I.parseSource('- 甲' + tag + '乙'), LAYOUT_OPTS).markup;
    eq(other, base, 'br-variant: ' + tag + ' 与 <br> 出图逐字符相同');
  }
}

function tBrEdges() {
  const lead = I.buildSvg(I.parseSource('- <br>甲'), LAYOUT_OPTS);
  eq(lead.layout.nodes[0].lineCount, 1, 'br-edge: 行首的 <br> 不产生空行');
  eq(lead.layout.nodes[0].text, '甲', 'br-edge: 行首的 <br> 不留字');
  eq(lead.markup, I.buildSvg(I.parseSource('- 甲'), LAYOUT_OPTS).markup,
    'br-edge: 行首 <br> 的出图与没有它逐字符相同');

  const tail = I.buildSvg(I.parseSource('- 甲<br>'), LAYOUT_OPTS);
  eq(tail.layout.nodes[0].lineCount, 1, 'br-edge: 行尾的 <br> 不产生空行');
  eq(tail.markup, lead.markup, 'br-edge: 行尾 <br> 与行首 <br> 出图一致');

  const both = I.buildSvg(I.parseSource('- <br>甲<br>'), LAYOUT_OPTS);
  eq(both.layout.nodes[0].lineCount, 1, 'br-edge: 两头都有 <br> 也只有一行');

  const twice = I.buildSvg(I.parseSource('- 甲<br><br>乙'), LAYOUT_OPTS);
  eq(twice.layout.nodes[0].lineCount, 2, 'br-edge: 连写两个 <br> 只断一次');
  eq(lineTexts(twice.layout.nodes[0]), ['甲', '乙'], 'br-edge: 连写 <br> 不产生空行');

  const space = I.buildSvg(I.parseSource('- 甲 <br> 乙'), LAYOUT_OPTS);
  eq(lineTexts(space.layout.nodes[0]), ['甲', '乙'], 'br-edge: 两侧空格不留到行首行尾');
}

function tBrMaxWidth() {
  const cfg = I.parseSource(['maxWidth: 80', '- 长长长长长长长长长长长<br>短短'].join('\n'));
  const built = I.buildSvg(cfg, WRAP_OPTS);
  const n = built.layout.nodes[0];

  // 80 / 14px = 每行 5 个字：11 字先折成 3 行，再换硬换行到「短短」
  eq(n.lineCount, 4, 'br-wrap: 段内折行 + 硬换行叠加');
  eq(lineTexts(n)[n.lineCount - 1], '短短', 'br-wrap: 硬换行后的段独立成行');
  ok(n.textLines.every((l) => l.width <= 80 + 1e-9), 'br-wrap: 每行都不超过 maxWidth',
    JSON.stringify(n.textLines.map((l) => l.width)));
  eq(lineTexts(n).join(''), n.text, 'br-wrap: 拼接等于节点原文');
  eq(n.textWidth, Math.max.apply(null, n.textLines.map((l) => l.width)),
    'br-wrap: 节点宽取最宽行');
  eq(n.bh, TEXT_H + (n.lineCount - 1) * LINE_H, 'br-wrap: 高度按总行数算');
}

function tBrMath() {
  const cfg = I.parseSource('- $a<br>b$');
  eq(cfg.roots[0].segRuns.length, 1, 'br-math: 公式是原子，<br> 不拆公式');
  eq(cfg.roots[0].runs.length, 1, 'br-math: 整行还是一个 math run');
  eq(cfg.roots[0].runs[0].math, 'a<br>b', 'br-math: tex 原样保留');

  const cfg2 = I.parseSource('- 甲$x^2$<br>乙');
  eq(cfg2.roots[0].segRuns.length, 2, 'br-math: 公式旁边的 <br> 照常断行');
  eq(cfg2.roots[0].segRuns[0].filter((r) => r.math).map((r) => r.math), ['x^2'],
    'br-math: 公式留在第一段');
  eq(cfg2.roots[0].segRuns[1].filter((r) => r.math).length, 0, 'br-math: 第二段没有公式');
  eq(cfg2.roots[0].text, '甲$x^2$乙', 'br-math: 拍平文字带围栏');
}

function tBrStyle() {
  const cfg = I.parseSource('- **粗**<br>*斜*');
  const built = I.buildSvg(cfg, LAYOUT_OPTS);
  const n = built.layout.nodes[0];
  eq(lineTexts(n), ['粗', '斜'], 'br-style: 两行各保留自己的文字');
  eq(n.textLines[0].pieces[0].bold, true, 'br-style: 第一行还是粗体');
  eq(n.textLines[1].pieces[0].italic, true, 'br-style: 第二行还是斜体');
  ok(built.markup.indexOf('font-weight="600"') > 0, 'br-style: 粗体落到 tspan 上');
  ok(built.markup.indexOf('font-style="italic"') > 0, 'br-style: 斜体落到 tspan 上');
  eq(tspanCount(built.markup), 2, 'br-style: 两行两个行 tspan');

  // 颜色标签可以横跨 <br>
  const color = I.buildSvg(I.parseSource('- <font color="#d99694">甲<br>乙</font>'), LAYOUT_OPTS);
  const cn = color.layout.nodes[0];
  eq(cn.textLines[0].pieces[0].color, '#d99694', 'br-style: <br> 前的半段仍是彩色');
  eq(cn.textLines[1].pieces[0].color, '#d99694', 'br-style: <br> 后的半段仍是彩色');
  eq((color.markup.match(/fill="#d99694"/g) || []).length, 2,
    'br-style: 两行都渲染出彩色 tspan');
}

function tBrBox() {
  const built = I.buildSvg(I.parseSource(['box: 1', '- 甲<br>乙'].join('\n')), LAYOUT_OPTS);
  const n = built.layout.nodes[0];
  eq(n.boxed, true, 'br-box: 节点有框');
  eq(n.bh, TEXT_H + LINE_H + 2 * I.OPT.boxPadY,
    'br-box: 框高 = 字高 + 一个行距 + 2*boxPadY');
  eq(n.bw, n.textWidth + 2 * I.OPT.boxPadX, 'br-box: 框宽 = 最宽行 + 2*boxPadX');
  ok(built.markup.indexOf('<rect class="bm-box"') > 0, 'br-box: 框画出来了');

  // 兄弟不重叠：硬换行节点长高了，副轴占位要跟着长
  const tree = I.buildSvg(I.parseSource(['- 甲<br>乙<br>丙', '  - 子'].join('\n')), LAYOUT_OPTS);
  const root = tree.layout.nodes.find((x) => x.text === '甲乙丙');
  ok(root && root.cSize >= root.selfCross, 'br-box: 多行节点的副轴占位不小于自身高');
}

function tSoftBrCombo() {
  const cfg = I.parseSource(['- 普通平键', '  按端部形状分<br>再一行'].join('\n'));
  eq(cfg.roots[0].segRuns.length, 2, 'soft-br: 续行里写 <br> 就是两段');
  eq(cfg.roots[0].text, '普通平键按端部形状分再一行', 'soft-br: 段间不补空格');
  const built = I.buildSvg(cfg, LAYOUT_OPTS);
  const n = built.layout.nodes[0];
  eq(n.lineCount, 2, 'soft-br: 出图两行');
  eq(lineTexts(n), ['普通平键按端部形状分', '再一行'], 'soft-br: 第一行含续行内容');
  eq(n.bh, TEXT_H + LINE_H, 'soft-br: 行高按多行节点算');
}

function tSoftBr() {
  tSoftChinese();
  tSoftEnglish();
  tSoftStyle();
  tSoftMath();
  tSoftColon();
  tSoftDirWins();
  tSoftMulti();
  tSoftGuard();
  tBrParse();
  tBrRender();
  tBrVariants();
  tBrEdges();
  tBrMaxWidth();
  tBrMath();
  tBrStyle();
  tBrBox();
  tSoftBrCombo();
}

suite('softbreak', tSoftBr);
