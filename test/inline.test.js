'use strict';

/* ============================================================
 * brace-map selftest · 行内：颜色与粗体/斜体/删除线的解析、渲染、宽度
 * ============================================================ */

const { I, ok, eq, finite, clean, suite } = require('./framework');
const { FONT, LAYOUT_OPTS, mockMeasure } = require('./helpers');

function tColorRuns() {
  const raw = '转炉钢：碱性、酸性、<font color="#d99694">顶吹转炉钢</font>';
  const runs = I.parseRuns(raw);
  eq(runs.length, 2, 'color: 切成两段');
  eq(runs[0].text, '转炉钢：碱性、酸性、', 'color: 前段文字');
  eq(runs[0].color, null, 'color: 前段无颜色');
  eq(runs[1].text, '顶吹转炉钢', 'color: 后段文字');
  eq(runs[1].color, '#d99694', 'color: 后段颜色');
  eq(I.runsText(runs), '转炉钢：碱性、酸性、顶吹转炉钢', 'color: 拼回纯文本');

  // 非法颜色丢弃，但文字仍保留（标签被剥掉）
  const bad = I.parseRuns('甲<font color="javascript:x">乙</font>丙');
  eq(I.runsText(bad), '甲乙丙', 'color: 非法颜色仍保留文字');
  eq(bad.every((r) => !r.color), true, 'color: 非法颜色被忽略');

  // 渲染成 tspan，无色段保持裸文本
  const markup = I.renderRuns(runs, '');
  ok(markup.indexOf('<tspan fill="#d99694">顶吹转炉钢</tspan>') >= 0, 'color: 生成 tspan');
  ok(markup.indexOf('转炉钢：碱性、酸性、') === 0, 'color: 无色段保持裸文本');
  ok(clean(markup), 'color: 标记干净');

  // 全无色时不套 tspan
  const plain = I.renderRuns([{ text: '甲', color: null }, { text: '乙', color: null }], '');
  eq(plain.indexOf('tspan'), -1, 'color: 无色时不生成 tspan');

  // 整条链路：parseSource 保留 runs，text 是去标签的纯文本
  const cfg = I.parseSource(['- <font color="red">甲</font>乙'].join('\n'));
  eq(cfg.roots[0].text, '甲乙', 'color: 节点 text 去标签');
  eq(cfg.roots[0].runs.length, 2, 'color: 节点 runs 分段');

  // 未写成 <font> 的 HTML 仍被剥掉，不残留在图上
  eq(I.cleanInline('甲<b>乙</b>丙'), '甲乙丙', 'color: 其他 HTML 标签仍剥掉');
}

/* ---------------------- 行内样式：粗体 / 斜体 / 删除线 ---------------------- */

// 400 字重 10px/字，600 字重 13px/字：用来验证粗体必须单独测量
const mockBoldMeasure = (text) => String(text).length * 13;

function tInlineStyleParse() {
  // 1) 三种样式各自成 run，其余位保持 false
  const bold = I.parseRuns('**粗体**');
  eq(bold.length, 1, 'style: **粗体** 只有一段');
  eq(bold[0], { text: '粗体', color: null, bold: true, italic: false, strike: false, href: null },
    'style: **粗体** 得到 bold run');

  const italic = I.parseRuns('*斜体*');
  eq(italic.length, 1, 'style: *斜体* 只有一段');
  eq(italic[0], { text: '斜体', color: null, bold: false, italic: true, strike: false, href: null },
    'style: *斜体* 得到 italic run');

  const strike = I.parseRuns('~~删~~');
  eq(strike.length, 1, 'style: ~~删~~ 只有一段（不被拆成斜体）');
  eq(strike[0], { text: '删', color: null, bold: false, italic: false, strike: true, href: null },
    'style: ~~删~~ 得到 strike run');

  // 2) 与颜色叠加：先切 <font>，再拆样式
  const colored = I.parseRuns('<font color="red">**加粗**</font>');
  eq(colored.length, 1, 'style: 颜色+粗体仍是一段');
  eq(colored[0].color, 'red', 'style: 颜色保留');
  eq(colored[0].bold, true, 'style: 颜色段里的粗体生效');

  // 3) 样式混合的一行
  const mixed = I.parseRuns('普通**粗**普通*斜*');
  eq(mixed.length, 4, 'style: 混合行切成四段');
  eq(mixed.map((r) => r.text), ['普通', '粗', '普通', '斜'], 'style: 混合行文字顺序');
  eq(mixed.map((r) => r.bold), [false, true, false, false], 'style: 混合行 bold 标记');
  eq(mixed.map((r) => r.italic), [false, false, false, true], 'style: 混合行 italic 标记');
  eq(I.runsText(mixed), '普通粗普通斜', 'style: 混合行拼回纯文本');

  // 4) 叠加：粗体里套斜体 / 删除线
  eq(I.parseRuns('**粗*斜*粗**').map((r) => [r.text, r.bold, r.italic]),
    [['粗', true, false], ['斜', true, true], ['粗', true, false]],
    'style: 粗体内嵌斜体');
  eq(I.parseRuns('~~**甲**乙~~').map((r) => [r.text, r.bold, r.strike]),
    [['甲', true, true], ['乙', false, true]],
    'style: 删除线内嵌粗体');

  // 5) 未闭合标记：原样保留，不吃字符（与 markdown 自身一致）
  eq(I.parseRuns('**没闭合'),
    [{ text: '**没闭合', color: null, bold: false, italic: false, strike: false, href: null }],
    'style: 未闭合 ** 原样保留');
  eq(I.runsText(I.parseRuns('~~没闭合')), '~~没闭合', 'style: 未闭合 ~~ 原样保留');
  eq(I.runsText(I.parseRuns('*没闭合')), '*没闭合', 'style: 未闭合 * 原样保留');

  // 6) 空串与空片段
  eq(I.parseRuns(''), [], 'style: 空行返回空数组');
  eq(I.parseRuns('<font color="red"></font>甲').length, 1, 'style: 解析完仍空串的片段丢弃');

  // 7) 整条链路：解析器给节点的 runs 带样式，text 仍是纯文本
  const cfg = I.parseSource(['- <font color="red">**甲**</font>乙'].join('\n'));
  eq(cfg.roots[0].text, '甲乙', 'style: 节点 text 去标记');
  eq(cfg.roots[0].runs.length, 2, 'style: 节点 runs 两段');
  eq(cfg.roots[0].runs[0].bold, true, 'style: 节点首段是粗体');

  // 8) 纯样式的行不再被当成无效行跳过
  eq(I.parseSource(['- **只有粗体**'].join('\n')).roots[0].text, '只有粗体',
    'style: 只有样式的行保留文字');
}

function tInlineStyleRender() {
  eq(I.renderRuns(I.parseRuns('**粗**'), ''), '<tspan font-weight="600">粗</tspan>',
    'style: 粗体 tspan');
  eq(I.renderRuns(I.parseRuns('*斜*'), ''), '<tspan font-style="italic">斜</tspan>',
    'style: 斜体 tspan');
  eq(I.renderRuns(I.parseRuns('~~删~~'), ''), '<tspan text-decoration="line-through">删</tspan>',
    'style: 删除线 tspan');

  // 属性叠加在同一个 tspan 上（顺序：字重 → 斜体 → 删除线 → 颜色）
  eq(I.renderRuns(I.parseRuns('<font color="red">**粗**</font>'), ''),
    '<tspan font-weight="600" fill="red">粗</tspan>', 'style: 粗体+颜色同一 tspan');
  eq(I.renderRuns(I.parseRuns('**粗*斜*~~删~~**'), ''),
    '<tspan font-weight="600">粗</tspan>'
    + '<tspan font-weight="600" font-style="italic">斜</tspan>'
    + '<tspan font-weight="600" text-decoration="line-through">删</tspan>',
    'style: 三种属性可叠加');

  // 全无样式 → 裸文本，不套 tspan
  const plain = I.renderRuns([{ text: '甲', color: null, bold: false, italic: false, strike: false },
    { text: '乙', color: null, bold: false, italic: false, strike: false }], '');
  eq(plain, '甲乙', 'style: 全无样式时不套 tspan');
  eq(plain.indexOf('tspan'), -1, 'style: 全无样式的输出不含 tspan');

  // 空节点：只有括号没有字
  eq(I.renderRuns([], ''), '', 'style: 空 run 渲染成空串');
  eq(I.renderRuns([], '').length, 0, 'style: 空 run 长度为 0');

  // 样式文字照旧过 esc
  const dn = I.renderRuns(I.parseRuns('**甲<乙**'), '');
  ok(dn.indexOf('<tspan font-weight="600">甲&lt;乙</tspan>') === 0, 'style: 样式文字仍然转义', dn);
  ok(clean(dn), 'style: 标记干净');

  // 端到端：SVG 里出现带样式的 tspan，且方框节点不漏字
  const built = I.buildSvg(I.parseSource(['box: 1', '- 父**粗**'].join('\n')),
    Object.assign({}, LAYOUT_OPTS, { measure: mockMeasure, measureBold: mockBoldMeasure }));
  ok(built.markup.indexOf('<tspan font-weight="600">粗</tspan>') >= 0, 'style: SVG 内含粗体 tspan');
  ok(built.markup.indexOf('父') >= 0, 'style: SVG 内粗体前的裸文本仍在');
}

function tInlineStyleWidth() {
  // 桩本身的对照：600 字重比 400 字重重
  ok(mockBoldMeasure('甲乙') > mockMeasure('甲乙'), 'style: 600 字重桩比 400 宽',
    mockBoldMeasure('甲乙') + ' vs ' + mockMeasure('甲乙'));

  const build = (line) => I.buildSvg(I.parseSource(line),
    Object.assign({}, LAYOUT_OPTS, { measure: mockMeasure, measureBold: mockBoldMeasure }));

  const plain = build('- 甲乙');
  const bold = build('- **甲乙**');
  const mixed = build('- 甲**乙**');

  // 同一个字符串：600 字重测出来严格更宽
  eq(plain.layout.nodes[0].textWidth, 20, 'style: 普通文字按 400 字重量（2×10）');
  eq(bold.layout.nodes[0].textWidth, 26, 'style: 粗体按 600 字重量（2×13）');
  ok(bold.layout.nodes[0].textWidth > plain.layout.nodes[0].textWidth,
    'style: 同字符串 600 字重宽度严格大于 400 字重宽度');

  // 混排：普通 run 用 400、粗体 run 用 600，累加
  eq(mixed.layout.nodes[0].textWidth, 10 + 13, 'style: 混排按 run 累加（10+13）');
  eq(mixed.layout.nodes[0].runs.length, 2, 'style: 混排节点两段 run');

  // 方框宽度跟着粗体宽度走，不会被撑破
  const boxed = build(['box: 1', '- **甲乙**'].join('\n'));
  eq(boxed.layout.nodes[0].bw, 26 + 2 * I.OPT.boxPadX, 'style: 方框宽度按粗体宽计算');

  // 自校准记账的是整行总宽，不是单个 run 的宽
  const seen = [];
  const L = I.layoutTree(I.parseSource('- 甲**乙**').roots,
    Object.assign({}, LAYOUT_OPTS, {
      measure: mockMeasure,
      measureBold: mockBoldMeasure,
      onWidth: (w, seq) => { seen[seq] = w; },
    }));
  eq(seen[0], 23, 'style: onWidth 记的是整行总宽');
  eq(seen[0], L.nodes[0].textWidth, 'style: 记账宽度 = 节点 textWidth');

  // 实测宽度路径：直接用整行值，不再拆 run 累加
  const flat = I.layoutTree(I.parseSource('- **甲乙**').roots,
    Object.assign({}, LAYOUT_OPTS, {
      measure: mockMeasure,
      measureBold: mockBoldMeasure,
      splitRuns: false,
    }));
  eq(flat.nodes[0].textWidth, 20, 'style: splitRuns=false 时整行量一次');

  const calib = I.buildSvg(I.parseSource('- **甲乙**'),
    Object.assign({}, LAYOUT_OPTS, {
      measure: I.calibratedMeasure(new Map([[0, 40]]), mockMeasure),
      measureBold: mockBoldMeasure,
    }));
  eq(calib.layout.nodes[0].textWidth, 40, 'style: 校准路径直接用实测整行宽 40');

  // 估算与实测一致时不该触发重排（estWidths 写的是整行宽）
  const est = [];
  I.layoutTree(I.parseSource('- **甲乙**').roots,
    Object.assign({}, LAYOUT_OPTS, {
      measure: mockMeasure,
      measureBold: mockBoldMeasure,
      onWidth: (w, seq) => { est[seq] = w; },
    }));
  ok(Math.abs(est[0] - 26) < I.CALIB_TOLERANCE, 'style: 粗体行的估算宽与渲染宽一致（不触发反复重排）',
    String(est[0]));
}

suite('color-runs', tColorRuns);
suite('inline-style', tInlineStyleParse);
suite('inline-style-render', tInlineStyleRender);
suite('inline-style-width', tInlineStyleWidth);
