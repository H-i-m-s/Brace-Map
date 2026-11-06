'use strict';

/* ============================================================
 * brace-map selftest · LaTeX 公式（MathJax → 内嵌矢量 SVG）
 *
 * 这里一律用假的转换器（Node 环境没有 MathJax），验的是我们自己的那几段：
 *   解析 → 批量准备 → 宽度进布局 → 折行原子 → 出图 → 降级 → 导出路径
 * ============================================================ */

const { I, ok, eq, finite, clean, suite } = require('./framework');
const { LAYOUT_OPTS, mockMeasure, fakeEl, fakeView } = require('./helpers');

const FONT = 20;

/* ------------------------------ 假 MathJax ------------------------------ */

/**
 * 造一份 MathJax 3 形态的输出：mjx-container 里套 <svg>，
 * viewBox 用 1em = 1000 单位，width 写成 em（1.2em）。
 * 于是 widthEm = 1.2、units = 1200/1.2 = 1000、heightEm = 1.6、depthEm = 0.8。
 */
function fakeSvgMarkup(tex, extra) {
  const inner = (extra && extra.inner) || '<path d="M0 0L10 10" data-tex="' + tex + '"/>';
  const tag = (extra && extra.container) || 'mjx-container';
  const cls = tag === 'mjx-container' ? ' class="MathJax" jax="SVG"' : '';
  return '<' + tag + cls + '><svg style="vertical-align: -0.25ex;"'
    + ' xmlns="http://www.w3.org/2000/svg" width="1.2em" height="1.6em"'
    + ' role="img" focusable="false" viewBox="0 -800 1200 1600">'
    + '<g stroke="currentColor" fill="currentColor" stroke-width="0" transform="scale(1,-1)">'
    + inner + '</g></svg>'
    + (tag === 'mjx-container' ? '</mjx-container>' : '');
}

/** 假的 MathJax 对象：convert 返回 Promise（模拟 tex2svgPromise） */
function fakeJax(opts) {
  const o = opts || {};
  return {
    kind: 'tex2svgPromise',
    where: 'window.MathJax',
    convert(tex, display) {
      if (typeof o.convert === 'function') return o.convert(tex, display);
      return Promise.resolve(fakeSvgMarkup(tex));
    },
  };
}

/** 准备一张图：parseSource + prepareMath */
async function prep(src, opts) {
  const cfg = I.parseSource(src);
  const status = await I.prepareMath(cfg, opts || {});
  return { cfg, status };
}

/** 降级路径会 console.warn 一行（正常行为）；用例里捂住它，免得扰乱输出 */
async function quietWarn(fn) {
  const saved = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = saved;
  }
}

const MATH_OPTS = Object.assign({}, LAYOUT_OPTS, {
  fontSize: FONT,
  lineH: Math.round(FONT * 1.85),
});

/* ------------------------------ 解析 ------------------------------ */

function tMathParse() {
  // 1) 行内公式成为独立的 math run
  const runs = I.parseRuns('- 应力 $\\sigma = F/A$ 单位 MPa');
  eq(runs.length, 3, 'math-parse: 行内公式切成三段');
  eq(runs[1].math, '\\sigma = F/A', 'math-parse: 取出 tex');
  eq(runs[1].display, false, 'math-parse: 行内公式 display=false');
  eq(runs[1].text, '$\\sigma = F/A$', 'math-parse: text 留着 $...$ 原文（降级时就是它）');
  eq(I.runsText(runs), '- 应力$\\sigma = F/A$单位 MPa', 'math-parse: 拼回纯文本');

  // 2) 一个节点里可以出现在任意位置
  const mid = I.parseSource(['- 甲$x^2$乙'].join('\n'));
  eq(mid.roots[0].runs.length, 3, 'math-parse: 公式在文字中间');
  eq(mid.roots[0].runs[1].math, 'x^2', 'math-parse: 中间那段的 tex');
  eq(mid.roots[0].text, '甲$x^2$乙', 'math-parse: 节点 text 带围栏');

  const only = I.parseSource(['- $x^2$'].join('\n'));
  eq(only.roots[0].runs.length, 1, 'math-parse: 整行只有一个公式');
  eq(only.roots[0].runs[0].math, 'x^2', 'math-parse: 整行公式的 tex');

  // 3) 逃逸：\$ 是字面美元符
  const esc1 = I.parseRuns('\\$5');
  eq(esc1.length, 1, 'math-parse: \\$5 只有一段');
  eq(esc1[0].text, '$5', 'math-parse: \\$ 变成字面 $');
  eq(esc1[0].math, undefined, 'math-parse: \\$5 不是公式');

  // 4) 未闭合的 $x 原样保留文字
  const open = I.parseRuns('$x');
  eq(open.length, 1, 'math-parse: 未闭合只有一段');
  eq(open[0].text, '$x', 'math-parse: 未闭合 $x 原样保留');
  eq(open[0].math, undefined, 'math-parse: 未闭合不算公式');

  // 5) $$...$$ 的 display
  const disp = I.parseRuns('$$x^2$$');
  eq(disp.length, 1, 'math-parse: display 公式只有一段');
  eq(disp[0].math, 'x^2', 'math-parse: display 里层的 tex');
  eq(disp[0].display, true, 'math-parse: $$...$$ 标记 display');
  eq(disp[0].text, '$$x^2$$', 'math-parse: display 的 text 也带围栏');

  // 6) 公式里的 * 不被当成斜体标记
  const star = I.parseRuns('$a*b*c$');
  eq(star.length, 1, 'math-parse: $a*b*c$ 不被拆成斜体');
  eq(star[0].math, 'a*b*c', 'math-parse: 星号留在 tex 里');

  // 7) 货币写法不误判
  eq(I.parseRuns('价格 $5 和 $10')[0].math, undefined, 'math-parse: $5 和 $10 不当公式');
  eq(I.parseRuns('$5 和 $10')[0].text, '$5 和 $10', 'math-parse: 货币原样保留');

  // 8) 行首/行内公式与 <font color> 共存
  const colored = I.parseRuns('<font color="red">$x$</font>');
  eq(colored.length, 1, 'math-parse: 带色公式只有一段');
  eq(colored[0].math, 'x', 'math-parse: 带色公式的 tex');
  eq(colored[0].color, 'red', 'math-parse: 公式继承所在段的颜色');

  // 9) renderRuns 遇到 math run 出占位（真正填充由 svg.js 做）
  const ph = I.renderRuns([{ text: '$x^2$', color: null, math: 'x^2' }], '');
  ok(ph.indexOf('<g class="bm-math" data-tex="x^2">') === 0, 'math-parse: renderRuns 输出占位 <g>', ph);
}

/* ------------------------------ 探测 ------------------------------ */

function tFindMathJax() {
  const tex2svg = () => fakeSvgMarkup('x');
  const tex2svgPromise = () => Promise.resolve(fakeSvgMarkup('x'));

  eq(I.findMathJax({}), null, 'probe: 没有 MathJax 返回 null');
  eq(I.findMathJax({ MathJax: {} }), null, 'probe: MathJax 空壳返回 null');

  const a = I.findMathJax({ MathJax: { tex2svgPromise } });
  ok(!!a, 'probe: window.MathJax 上的 tex2svgPromise 认出来');
  eq(a.kind, 'tex2svgPromise', 'probe: 优先认 tex2svgPromise');
  eq(a.where, 'window.MathJax', 'probe: 记录来源路径');

  const b = I.findMathJax({ MathJax: { mathjax: { tex2svg } } });
  ok(!!b, 'probe: window.MathJax.mathjax 上的 tex2svg 认出来');
  eq(b.kind, 'tex2svg', 'probe: tex2svg 记为同步入口');
  eq(b.where, 'window.MathJax.mathjax', 'probe: 子命名空间的来源路径');

  const c = I.findMathJax({ MathJax: { startup: { tex2svg } } });
  ok(!!c, 'probe: window.MathJax.startup 上的 tex2svg 认出来');
  eq(c.where, 'window.MathJax.startup', 'probe: startup 的来源路径');

  const d = I.findMathJax({ MathJax: { Hub: { tex2svg } } });
  ok(!!d, 'probe: window.MathJax.Hub 上的 tex2svg 认出来（v2 形态）');

  // v3 的 tex2svg 要等 startup.promise 解析后才挂上
  const win = { MathJax: { startup: { promise: Promise.resolve() } } };
  return I.findMathJaxReady(win).then((jax) => {
    eq(jax, null, 'probe: startup 就位后仍然没有转换函数就是 null');
  });
}

function tFindMathJaxAfterStartup() {
  const win = { MathJax: { startup: { promise: null } } };
  win.MathJax.startup.promise = new Promise((resolve) => {
    setTimeout(() => {
      win.MathJax.tex2svgPromise = () => Promise.resolve(fakeSvgMarkup('x'));
      resolve();
    }, 0);
  });
  return I.findMathJaxReady(win).then((jax) => {
    ok(!!jax, 'probe: 等 startup.promise 之后再探一次');
    eq(jax && jax.kind, 'tex2svgPromise', 'probe: 迟到挂上的 tex2svgPromise 也认');
  });
}

/* ------------------------------ 几何提取 ------------------------------ */

function tExtractMath() {
  const geo = I.extractMath(fakeSvgMarkup('x'));
  eq(Math.round(geo.widthEm * 1000) / 1000, 1.2, 'extract: width 1.2em → widthEm');
  eq(geo.units, 1000, 'extract: viewBox/em 反推出 1000 单位每 em');
  eq(geo.minX, 0, 'extract: minX');
  eq(geo.minY, -800, 'extract: minY');
  eq(Math.round(geo.heightEm * 1000) / 1000, 1.6, 'extract: heightEm');
  eq(Math.round(geo.depthEm * 1000) / 1000, 0.8, 'extract: 基线以下的深度 = (minY + h) / units');
  ok(geo.inner.indexOf('scale(1,-1)') >= 0, 'extract: 内层 g 原样取出');

  // ex 写法的宽度也能换算（MathJax 的 x-height 0.442em）
  const ex = '<svg width="3ex" height="2ex" viewBox="0 -800 1200 1600"><g/></svg>';
  const g2 = I.extractMath(ex);
  ok(Math.abs(g2.widthEm - 3 * I.EX_PER_EM) < 1e-9, 'extract: ex → em 用 0.442', String(g2.widthEm));
  ok(Math.abs(g2.units - 1200 / (3 * I.EX_PER_EM)) < 1e-6, 'extract: 单位/em 跟着 width 走');

  // 没有 <svg>（CHTML）必须抛，由调用方降级
  let err = null;
  try {
    I.extractMath('<mjx-container class="MathJax" jax="CHTML"><mjx-math></mjx-math></mjx-container>');
  } catch (e) { err = e; }
  ok(!!err, 'extract: CHTML 输出抛错（没有矢量就没法导出）');
  ok(/CHTML/.test(String(err && err.message)), 'extract: 报错点明是 CHTML', err && err.message);

  // 没有 viewBox 也算不出几何
  let err2 = null;
  try { I.extractMath('<svg width="1em" height="1em"><g/></svg>'); } catch (e) { err2 = e; }
  ok(!!err2, 'extract: 缺 viewBox 抛错');
}

function tNamespaceIds() {
  const markup = '<defs><path id="MJX-1-TEX-I-1D70E" d="M0 0"/></defs>'
    + '<g><use xlink:href="#MJX-1-TEX-I-1D70E"/></g>';
  const out = I.namespaceIds(markup, 'bm1');
  ok(out.indexOf('id="MJX-1-TEX-I-1D70E"') < 0, 'ids: 原 id 被换掉');
  ok(out.indexOf('href="#bm1-0"') >= 0, 'ids: 引用跟着改成同一前缀', out);
  ok(out.indexOf('id="bm1-0"') >= 0, 'ids: 定义也改成同一前缀');

  eq(I.namespaceIds('<g><path d="M0 0"/></g>', 'bm1'), '<g><path d="M0 0"/></g>',
    'ids: 没有 id 的标记原样返回');

  // 没有 DOM 时 <use> 原样保留（引用目标在同一棵子树里，克隆能带走）
  const keep = I.inlineUses('<g><use xlink:href="#a"/></g>');
  eq(keep.info.uses, 1, 'uses: 数出 <use> 数量');
  ok(keep.info.kept >= 1, 'uses: 无 DOM 时保留引用');
  eq(I.inlineUses('<g/>').info.uses, 0, 'uses: 没有 use 时不计数');
}

/* ------------------------------ 宽度进布局 ------------------------------ */

function tMathWidth() {
  return prep('- 应力 $\\sigma$ 单位 MPa', { jax: fakeJax(), fontSize: FONT }).then(({ cfg, status }) => {
    eq(status.converted, 1, 'width: 一个公式转换成功');
    const run = cfg.roots[0].runs[1];
    eq(Math.round(run.mathWidthEm * 1000) / 1000, 1.2, 'width: run 上记着 em 宽度');
    eq(Math.round(run.mathWidth * 1000) / 1000, 1.2 * FONT, 'width: 像素宽 = widthEm × fontSize');

    const built = I.buildSvg(cfg, Object.assign({}, MATH_OPTS));
    const n = built.layout.nodes[0];
    const expect = mockMeasure('应力') + 1.2 * FONT + mockMeasure('单位 MPa');
    eq(n.textWidth, expect, 'width: 公式宽度计进 textWidth');

    // 方框要盖得住
    const boxed = I.parseSource(['box: 1', '- 应力 $\\sigma$ 单位 MPa'].join('\n'));
    return I.prepareMath(boxed, { jax: fakeJax(), fontSize: FONT }).then(() => {
      const b2 = I.buildSvg(boxed, Object.assign({}, MATH_OPTS));
      eq(b2.layout.nodes[0].bw, expect + 2 * I.OPT.boxPadX, 'width: 方框宽含公式宽度');
      ok(b2.layout.nodes[0].textWidth !== mockMeasure('应力$\\sigma$单位 MPa'),
        'width: 不等于按字面量（$\\sigma$）量的宽度',
        String(b2.layout.nodes[0].textWidth));
    });
  });
}

function tMathFontRescale() {
  const cfg = I.parseSource('- $x$');
  return I.prepareMath(cfg, { jax: fakeJax(), fontSize: 20 }).then(() => {
    eq(Math.round(cfg.roots[0].runs[0].mathWidth * 100) / 100, 24, 'rescale: 20px 下宽 24');
    I.resolveMathWidths(cfg, 20 * 1.5);
    eq(Math.round(cfg.roots[0].runs[0].mathWidth * 100) / 100, 36, 'rescale: 字号变了宽度跟着重算');
  });
}

/* ------------------------------ 出图 ------------------------------ */

function tMathMarkup() {
  return prep('- 甲$x^2$乙', { jax: fakeJax(), fontSize: FONT }).then(({ cfg }) => {
    const built = I.buildSvg(cfg, Object.assign({}, MATH_OPTS));
    const html = built.markup;
    ok(clean(html), 'markup: 没有 NaN/undefined', html.slice(0, 120));
    ok(html.indexOf('<g class="bm-math" data-tex="x^2"') >= 0, 'markup: 公式内嵌为 <g class="bm-math">');
    ok(html.indexOf('scale(0.02)') >= 0, 'markup: 按 fontSize/units 缩放（20/1000=0.02）');
    ok(html.indexOf('translate(') >= 0, 'markup: 有平移定位');
    ok(html.indexOf('data-math="1"') >= 0, 'markup: 节点标了 data-math（校准要跳过它）');
    ok(html.indexOf('dominant-baseline="alphabetic"') >= 0, 'markup: 含公式的节点换成 alphabetic 基线');
    ok(html.indexOf('M0 0L10 10') >= 0, 'markup: 矢量路径原样带上');

    // 文字部分仍然是 tspan，锚在算好的 x 上
    ok(/<text class="bm-text"[^>]*><tspan x="[^"]+" dy="0">甲<\/tspan>/.test(html),
      'markup: 公式前的文字按绝对 x 落位', html.slice(html.indexOf('<text'), html.indexOf('<text') + 200));
    ok(html.indexOf('乙</tspan>') >= 0, 'markup: 公式后的文字也留着');

    // 纯文字节点完全不受影响（用的还是原来那条渲染路径）
    const plain = I.buildSvg(I.parseSource('- 甲乙'), Object.assign({}, MATH_OPTS));
    eq(plain.markup.indexOf('data-math'), -1, 'markup: 没有公式的节点不进入公式路径');
  });
}

/* ------------------------------ 折行原子性 ------------------------------ */

function tMathAtom() {
  const runs = I.parseRuns('甲$\\sigma$乙');
  const atoms = I.wrapAtoms(runs);
  eq(atoms.length, 3, 'atom: 三段文字 → 三个原子');
  eq(atoms[1].kind, 'math', 'atom: 公式是 math 原子');
  eq(atoms[1].text, '$\\sigma$', 'atom: math 原子的 text 就是围栏原文');

  // 超过上限时也不能从公式中间断开
  const src = ['maxWidth: 60', '- 甲甲甲甲甲$\\sigma$乙乙乙乙乙'].join('\n');
  const cfg = I.parseSource(src);
  return I.prepareMath(cfg, { jax: fakeJax(), fontSize: FONT }).then(() => {
    const built = I.buildSvg(cfg, Object.assign({}, MATH_OPTS));
    const n = built.layout.nodes[0];
    ok(n.lineCount > 1, 'atom: 这张图确实折成多行', String(n.lineCount));

    let mathPieces = 0;
    for (const line of n.textLines) {
      ok(line.width <= 60 + 1e-6, 'atom: 每行不超 maxWidth', String(line.width));
      for (const p of line.pieces) {
        if (!p.math) continue;
        mathPieces++;
        eq(p.math, '\\sigma', 'atom: 公式没有被拆成两段');
        eq(Math.round(p.mathWidth * 100) / 100, 1.2 * FONT, 'atom: 折行后公式宽度不丢');
        ok(finite(p.mathWidth), 'atom: 折行后公式宽度是有限数');
      }
    }
    eq(mathPieces, 1, 'atom: 整张图里公式只出现一次（没被切断）');
  });
}

/* ------------------------------ 降级 ------------------------------ */

function tDegradeNoMathJax() {
  const src = ['box: 1', '- 应力 $x^2$ 单位 MPa', '  - 子 $\\alpha$'].join('\n');
  return quietWarn(() => {
    const cfg = I.parseSource(src);
    return I.prepareMath(cfg, { win: {}, fontSize: FONT }).then((status) => {
    eq(status.reason, 'notfound', 'degrade: 没有 MathJax 时 reason=notfound');
    eq(status.failed, 2, 'degrade: 两个公式都降级');
    eq(status.line, 'MathJax: 未找到，公式已降级为纯文本', 'degrade: 诊断那一行的口径');

    const r0 = cfg.roots[0].runs.find((r) => r.text.indexOf('$') >= 0);
    ok(!!r0, 'degrade: 公式 run 还在');
    eq(r0.math, undefined, 'degrade: math 标记被摘掉，它变回普通文字');
    eq(r0.text, '$x^2$', 'degrade: 文字就是 $...$ 原文');
    eq(r0.mathFail, true, 'degrade: 留下降级标记供诊断');

    // 整图仍然能正常出 SVG
    const built = I.buildSvg(cfg, Object.assign({}, MATH_OPTS));
    ok(clean(built.markup), 'degrade: 图能出，标记里没有 NaN/undefined');
    ok(built.markup.indexOf('$x^2$') >= 0, 'degrade: 图里能看到 $x^2$ 这几个字');
    ok(built.markup.indexOf('bm-math') < 0, 'degrade: 没有残留的公式占位');
    ok(built.layout.width > 0 && built.layout.height > 0, 'degrade: 画布尺寸正常');

    // 宽度按字面量算：方框不会被撑破，也不会留空
    const n = built.layout.nodes[0];
    ok(n.textWidth > 0, 'degrade: 节点有宽度', String(n.textWidth));
    });
  });
}

function tDegradePartial() {
  const src = ['- 好 $a$ 和坏 $b$'].join('\n');
  const cfg = I.parseSource(src);
  const jax = fakeJax({
    convert(tex) {
      if (tex === 'b') return Promise.reject(new Error('故意失败'));
      return Promise.resolve(fakeSvgMarkup(tex));
    },
  });
  return quietWarn(() => I.prepareMath(cfg, { jax, fontSize: FONT })).then((status) => {
    eq(status.converted, 1, 'partial: 好的那个转换成功');
    eq(status.failed, 1, 'partial: 坏的那个降级');
    eq(status.reason, 'partial', 'partial: reason=partial');

    const runs = cfg.roots[0].runs;
    const good = runs.find((r) => r.math);
    const bad = runs.find((r) => r.mathFail);
    ok(!!good && good.math === 'a', 'partial: 好公式保留 math');
    ok(!!bad && bad.text === '$b$', 'partial: 坏公式降级成 $b$');

    const built = I.buildSvg(cfg, Object.assign({}, MATH_OPTS));
    ok(built.markup.indexOf('class="bm-math"') >= 0, 'partial: 图里仍有一个矢量公式');
    ok(built.markup.indexOf('$b$') >= 0, 'partial: 坏的那个显示成纯文本');
    ok(clean(built.markup), 'partial: 标记干净');
  });
}

function tDegradeChtml() {
  const cfg = I.parseSource('- $x$');
  const jax = fakeJax({
    convert() {
      return Promise.resolve('<mjx-container class="MathJax" jax="CHTML"><mjx-math><mi>x</mi></mjx-math></mjx-container>');
    },
  });
  return quietWarn(() => I.prepareMath(cfg, { jax, fontSize: FONT })).then((status) => {
    eq(status.reason, 'allfailed', 'chtml: 全部失败');
    eq(status.converted, 0, 'chtml: 没有一个走矢量');
    eq(cfg.roots[0].runs[0].math, undefined, 'chtml: 降级成纯文本');
    ok(/CHTML|全部失败/.test(status.line), 'chtml: 诊断说明原因', status.line);
  });
}

/* ------------------------------ 导出路径 ------------------------------ */

function tMathExportPath() {
  // 先造一棵含公式占位的假树（结构与 svgMarkup 的产物一致）
  const view = fakeView();
  const svg = fakeEl('svg', { fill: 'rgb(1,2,3)', 'font-size': '20px' }, view);
  const text = fakeEl('text', { fill: 'rgb(9,9,9)' }, view);
  text.setAttribute('data-href', 'note');
  svg.appendChild(text);

  const g = fakeEl('g', {}, view);
  g.setAttribute('class', 'bm-math');
  g.setAttribute('data-tex', 'x^2');
  const path = fakeEl('path', { fill: 'rgb(200,200,200)' }, view);
  g.appendChild(path);
  svg.appendChild(g);

  let threw = null;
  let clone = null;
  try {
    clone = I.cloneWithInlineStyles(svg);
    I.stripLinkMarkers(clone, 'rgb(1,2,3)');
  } catch (err) { threw = err; }

  ok(!threw, 'export: 含公式占位时克隆与链接降级都不抛错', threw && threw.message);
  ok(!!clone, 'export: 克隆成功');
  eq(clone.children.length, 2, 'export: 公式 <g> 跟着克隆过去');
  eq(clone.children[1].getAttribute('data-tex'), 'x^2', 'export: data-tex 保留（便于排查）');
  eq(clone.children[1].children.length, 1, 'export: <g> 里的路径没丢');
  eq(clone.children[1].children[0].style.getPropertyValue('fill'), 'rgb(200,200,200)',
    'export: 公式路径的 fill 写成了行内样式');

  // stripLinkMarkers 对普通元素的行为不变
  eq(clone.children[0].hasAttribute('data-href'), false, 'export: 链接标记照旧被抹掉');

  // 空 <g>（转换失败但占位还在）也不能炸
  const empty = fakeEl('g', {}, view);
  empty.setAttribute('class', 'bm-math');
  svg.appendChild(empty);
  let threw2 = null;
  try { I.cloneWithInlineStyles(svg); } catch (err) { threw2 = err; }
  ok(!threw2, 'export: 空公式占位也不炸');
}

/* ------------------------------ 诊断 ------------------------------ */

function tMathDiagnosis() {
  const out = I.formatWrapDiagnosis(
    [{ seq: 0, text: '甲$x$', lineLens: [40], rectWidth: 60, est: 40, isTitle: false }],
    { fontSize: 20, maxWidth: 0, rebuilds: 0, settled: true },
    { mathStatus: 'MathJax: 可用（tex2svgPromise）' }
  );
  ok(out.indexOf('MathJax: 可用（tex2svgPromise）') >= 0, 'diag: 诊断里带公式通道那一行');
  ok(clean(out), 'diag: 报告仍然干净');
}

/* ------------------------------ 登记 ------------------------------ */

suite('math/parse', tMathParse);
suite('math/probe', tFindMathJax);
suite('math/probe-startup', tFindMathJaxAfterStartup);
suite('math/extract', tExtractMath);
suite('math/ids', tNamespaceIds);
suite('math/width', tMathWidth);
suite('math/rescale', tMathFontRescale);
suite('math/markup', tMathMarkup);
suite('math/atom', tMathAtom);
suite('math/degrade-missing', tDegradeNoMathJax);
suite('math/degrade-partial', tDegradePartial);
suite('math/degrade-chtml', tDegradeChtml);
suite('math/export-path', tMathExportPath);
suite('math/diagnosis', tMathDiagnosis);
