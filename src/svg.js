'use strict';

/* 出图：纯字符串，便于无 DOM 调用 */

const { OPT, NS } = require('./opt');
const { num } = require('./util');
const { esc, renderRuns } = require('./text');
const { createDomMeasure } = require('./measure');
const { layoutTree } = require('./layout');
const { nodeHasMath, mathGroupMarkup } = require('./math');

/* ============================================================
 * 出图（纯字符串，便于 selftest 无 DOM 调用）
 * ============================================================ */

/**
 * 根节点（cfg.roots 的第一层）在文字上加一个 data-bm-root 标记。
 *
 * valign: middle 要靠它把「一级标题在图内的垂直中心」量出来：直接读这个元素的
 * bbox 即可，缩放、题图 <g transform> 的偏移、方向映射全含在 bbox 里。
 * 用 data 属性而不是 class：test/helpers.js 与几个用例是按 `class="bm-text"`
 * 这个前缀切标记的，多一个 class 会把它们的解析打断。
 */
function rootAttr(n) {
  return n && n.depth === 0 ? ' data-bm-root="1"' : '';
}

/**
 * 文字锚点。
 * 带框节点统一用 middle + 节点中心：框宽 = 文字宽 + 2*boxPadX，只要文字宽度
 * 有一点测量误差，start/end 锚点就会把误差全堆到一侧（一边贴框线、一边宽留白）；
 * 居中对齐即使有一两像素误差也看不出来。
 * 不带框的节点保持 start/end，因为兄弟之间要靠边缘对齐。
 */
function textPlace(n, dir) {
  const vertical = dir === 'tb' || dir === 'bt';
  if (n.boxed || vertical) return { x: n.x, anchor: 'middle' };
  if (dir === 'rl') return { x: n.x + n.w / 2, anchor: 'end' };
  return { x: n.x - n.w / 2, anchor: 'start' };
}

/**
 * 一段 run 的宽度（公式取转换阶段算好的 px）。
 * 只给含公式的节点用：那些节点的文字要按段绝对定位。
 */
function pieceW(piece, measure, measureBold) {
  if (piece && piece.math && Number.isFinite(piece.mathWidth)) return Math.max(0, piece.mathWidth);
  const t = piece && piece.text ? String(piece.text) : '';
  if (!t) return 0;
  const w = piece && piece.bold ? measureBold(t) : measure(t);
  return Number.isFinite(w) && w > 0 ? w : 0;
}

/**
 * 含公式的节点：文字与公式都按绝对坐标摆。
 *
 * 公式不能当 tspan 里的文字排（MathJax 的矢量是 <g>，塞不进 <text>），所以文字用
 * tspan 逐段钉在算好的 x 上，公式另开一个 <g> 摆在同一个位置。
 * 两者共用一条基线：dominant-baseline 从 central 换成 alphabetic，
 * 基线的 y 取「行中心 + mathBaselineRatio × 字号」——这样公式里的分式、
 * 上下标才能和前后文字对齐（MathJax 的矢量坐标本来就把基线定在 y=0）。
 */
function mathNodeMarkup(n, p, m) {
  const fontSize = m.fontSize;
  const lineH = m.lineH || Math.round(fontSize * OPT.lineHRatio);
  const lines = (n.textLines && n.textLines.length)
    ? n.textLines
    : [{ pieces: n.runs || [] }];
  const count = lines.length;
  const firstCenter = n.y - (count - 1) * lineH / 2;
  const shift = fontSize * OPT.mathBaselineRatio;

  const spans = [];
  const groups = [];
  let lastLine = 0;

  for (let i = 0; i < count; i++) {
    const pieces = (lines[i] && lines[i].pieces) || [];
    let total = 0;
    for (const pc of pieces) total += pieceW(pc, m.measure, m.measureBold);

    let startX = p.x;
    if (p.anchor === 'middle') startX = p.x - total / 2;
    else if (p.anchor === 'end') startX = p.x - total;

    const baseY = firstCenter + i * lineH + shift;
    let cursor = startX;

    for (const pc of pieces) {
      const w = pieceW(pc, m.measure, m.measureBold);
      if (pc.math && Number.isFinite(pc.mathWidth)) {
        groups.push(mathGroupMarkup(pc, cursor, baseY, fontSize));
      } else if (pc.text) {
        // 换行靠 dy：同一行的后续 tspan 用 0，换行时用行距
        const dy = i > lastLine ? (i - lastLine) * lineH : 0;
        lastLine = i;
        spans.push('<tspan x="' + num(cursor) + '" dy="' + num(dy) + '">'
          + renderRuns([pc], '') + '</tspan>');
      }
      cursor += w;
    }
  }

  const text = '<text class="bm-text" x="' + num(p.x) + '" y="' + num(firstCenter + shift) + '"'
    + ' text-anchor="start" data-seq="' + num(n.seq) + '" data-math="1"'
    + ' dominant-baseline="alphabetic"' + rootAttr(n) + '>' + spans.join('') + '</text>';

  return text + groups.join('');
}

function svgMarkup(m) {
  const W = Math.ceil(m.width);
  const H = Math.ceil(m.height);
  const dir = m.layout.dir;
  const lineH = m.layout.lineH || 0;   // 多行 tspan 的 dy 用它
  const out = [];
  out.push(
    `<svg xmlns="${NS}" class="brace-map-svg" width="${W}" height="${H}" `
    + `viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet" role="img">`
  );

  if (m.title) {
    out.push(
      `<text class="bm-title" x="${num(OPT.pad)}" y="${num(OPT.pad + m.titleSize)}"`
      + ` font-size="${num(m.titleSize)}">${esc(m.title)}</text>`
    );
  }

  out.push(m.titleH ? `<g transform="translate(0,${num(m.titleH)})">` : '<g>');

  for (const b of m.layout.braces) {
    out.push(`<path class="bm-brace" fill="none" d="${b.d}"/>`);
  }
  /*
   * closing 的分组标签：位置、锚点已经在布局里算好（尖端外侧 + cross 居中），
   * 这里只管出字。字号/字体族/填充色跟节点文字一致，全部靠 .brace-map-svg text
   * 那条 CSS 继承下来，不单独写属性；基线也用 central，和节点文字同一套口径。
   */
  for (const b of m.layout.braces) {
    if (b.kind !== 'closing' || !b.label) continue;
    out.push(
      `<text class="bm-closing-label" x="${num(b.labelX)}" y="${num(b.labelY)}"`
      + ` text-anchor="${b.labelAnchor}" dominant-baseline="central">${esc(b.label)}</text>`
    );
  }
  for (const n of m.layout.nodes) {
    if (n.boxed) {
      out.push(
        `<rect class="bm-box" fill="none" x="${num(n.x - n.bw / 2)}" y="${num(n.y - n.bh / 2)}"`
        + ` width="${num(n.bw)}" height="${num(n.bh)}" rx="3" ry="3"/>`
      );
    }
    // 文字始终正立，不旋转；锚点规则见 textPlace
    // data-seq 放在 text-anchor 之后：自校准按它回填实测宽度，贴在最前面会
    // 打断既有标记解析（x/y/anchor 必须紧跟在 class 后面）。
    const p = textPlace(n, dir);
    if (nodeHasMath(n)) {
      out.push(mathNodeMarkup(n, p, m));
      continue;
    }
    if (n.textLines && n.textLines.length > 1) {
      // 多行：首行基线往上偏移 (行数-1)*lineH/2，让整块相对节点中心居中；
      // 后续行用 tspan dy=lineH 往下推。
      const count = n.textLines.length;
      const firstY = n.y - (count - 1) * lineH / 2;
      const spans = [];
      for (let i = 0; i < count; i++) {
        const dy = i === 0 ? 0 : lineH;
        spans.push(
          `<tspan x="${num(p.x)}" dy="${num(dy)}">${renderRuns(n.textLines[i].pieces, '')}</tspan>`
        );
      }
      out.push(
        `<text class="bm-text" x="${num(p.x)}" y="${num(firstY)}"`
        + ` text-anchor="${p.anchor}" data-seq="${num(n.seq)}" dominant-baseline="central"${rootAttr(n)}>${spans.join('')}</text>`
      );
      continue;
    }
    out.push(
      `<text class="bm-text" x="${num(p.x)}" y="${num(n.y)}"`
      + ` text-anchor="${p.anchor}" data-seq="${num(n.seq)}" dominant-baseline="central"${rootAttr(n)}>${renderRuns(n.runs, n.text)}</text>`
    );
  }

  out.push('</g></svg>');
  return out.join('');
}

function buildSvg(cfg, opts) {
  const o = opts || {};
  const fontSize = o.fontSize || OPT.baseFont;
  const lineH = o.lineH || Math.round(fontSize * OPT.lineHRatio);
  const rowGap = o.rowGap == null ? Math.round(lineH * OPT.rowGapRatio) : o.rowGap;
  const fontFamily = o.fontFamily || 'sans-serif';
  const titleSize = Math.round(fontSize * 1.15);

  let measure = o.measure;
  let tempMeasure = null;
  if (typeof measure !== 'function') {
    tempMeasure = createDomMeasure(fontFamily, fontSize, 400, o.host);
    measure = tempMeasure;
  }

  // 粗体 run 用 600 字重测量，与渲染出来的字重对得上
  let measureBold = o.measureBold;
  let tempBoldRuns = null;
  if (typeof measureBold !== 'function') {
    tempBoldRuns = createDomMeasure(fontFamily, fontSize, 600, o.host);
    measureBold = tempBoldRuns;
  }

  const title = cfg.title || '';
  let layout;
  let titleW = 0;
  let titleH = 0;
  let width = 0;
  let height = 0;
  let markup = '';

  try {
    layout = layoutTree(cfg.roots, {
      dir: cfg.dir,
      brace: cfg.brace,
      box: cfg.box,
      closing: cfg.closing,
      closingGroups: cfg.closingGroups,
      measure,
      measureBold,
      splitRuns: o.splitRuns,
      onWidth: o.onWidth,
      maxWidth: o.maxWidth != null ? o.maxWidth : cfg.maxWidth,
      fontSize,
      lineH,
      rowGap,
      fontFamily,
      colGap: o.colGap,
      braceWidth: o.braceWidth,
      boxPadX: o.boxPadX,
      boxPadY: o.boxPadY,
      pad: o.pad,
    });

    if (title) {
      // 标题是粗体，优先用 measureTitle（沿用旧的标题口径），再退到 600 字重的 measure
      let bold = o.measureTitle || o.measureBold;
      let tempBold = null;
      if (typeof bold !== 'function') {
        if (typeof o.measure === 'function') {
          bold = o.measure;                 // 只注入了正文 measure（如 selftest）
        } else {
          tempBold = createDomMeasure(fontFamily, titleSize, 600, o.host);
          bold = tempBold;
        }
      }
      titleW = bold(title) + OPT.pad * 2;
      if (tempBold && tempBold.dispose) tempBold.dispose();
      if (!Number.isFinite(titleW)) titleW = 0;
      titleH = Math.round(titleSize * 1.7) + OPT.titleGap;
    }

    // 出图放在 dispose 之前：公式节点的逐段宽度还要用一次 measure
    width = Math.max(layout.width, titleW, OPT.pad * 2 + 40);
    height = layout.height + titleH;
    markup = svgMarkup({
      layout, title, titleSize, titleH, width, height,
      fontSize, lineH, measure, measureBold,
    });
  } finally {
    if (tempMeasure && tempMeasure.dispose) tempMeasure.dispose();
    if (tempBoldRuns && tempBoldRuns.dispose) tempBoldRuns.dispose();
  }

  const seqs = layout.nodes.map((n) => n.seq);
  return {
    markup, layout, width, height, titleW, titleH, seqs,
    // closing 点名的诊断（名字没命中之类），不参与绘制
    warnings: (layout && layout.warnings) || [],
  };
}

module.exports = { textPlace, buildSvg };
