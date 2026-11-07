'use strict';

/* 布局：先排 (main, cross)，再按 dir 映射到 x/y */

const { OPT } = require('./opt');
const { DIRS, STYLES } = require('./parse');
const { createDomMeasure, runsWidth } = require('./measure');
const { wrapRuns } = require('./wrap');
const { hasMathIn, maxMathHeight } = require('./math');
const { braceGeom, geomToD } = require('./brace');

/* ============================================================
 * 布局
 *
 * 只有一份算法：先在 (main, cross) 抽象坐标里排好，再按 dir 映射到 x/y。
 *   main  = 生长方向（同一父节点下，子树沿 main 推进一层）
 *   cross = 兄弟排列方向（同一父节点下，子节点沿 cross 依次排开）
 * 参数约定：
 *   selfMain  = 节点自身（不含子树）沿 main 的厚度
 *   selfCross = 节点自身（不含子树）沿 cross 的占位，即「它这一行有多高/多宽」
 *   mSize     = 同 selfMain 的布局字段
 *   cSize     = 节点在 cross 上的子树总占位，只用于兄弟排布与居中
 * ============================================================ */

function childrenTotal(node, rowGap) {
  let sum = 0;
  for (const c of node.children) sum += c.cSize;
  return sum + rowGap * (node.children.length - 1);
}

/** 一段文字的宽度：与 wrap 里 append 的口径一致（逐 run 累加，量不出来按 0） */
function runsLineWidth(runs, measure, measureBold) {
  let w = 0;
  for (const r of runs || []) {
    if (!r) continue;
    // 公式不可拆，宽度取转换阶段算好的 px
    if (r.math && Number.isFinite(r.mathWidth)) {
      w += Math.max(0, r.mathWidth);
      continue;
    }
    if (!r.text) continue;
    const t = r.text;
    const v = r.bold ? measureBold(t) : measure(t);
    if (Number.isFinite(v) && v > 0) w += v;
  }
  return w;
}

/**
 * 节点文字 → 文本行。
 *
 * 先按硬换行（<br>）分段（解析阶段已切好，segs 就是段），每段内部再按 maxWidth
 * 折行，所以两种断行可以叠加：`甲<br>乙` 恒为两行，`甲很长<br>乙` 则先把「甲很长」
 * 折开、再换到「乙」。不折行时一段就是一行。
 */
function nodeTextLines(segs, maxWidth, measure, measureBold) {
  const out = [];
  for (const seg of segs) {
    const wrapped = maxWidth ? wrapRuns(seg, maxWidth, measure, measureBold) : [];
    if (wrapped.length) {
      for (const l of wrapped) out.push(l);
      continue;
    }
    out.push({ pieces: seg, width: runsLineWidth(seg, measure, measureBold) });
  }
  return out;
}

function layoutTree(roots, opts) {
  const o = opts || {};
  const dir = DIRS.indexOf(o.dir) >= 0 ? o.dir : 'lr';
  const style = STYLES.indexOf(o.brace) >= 0 ? o.brace : 'curly';
  const vertical = dir === 'tb' || dir === 'bt';

  const fontSize = o.fontSize || OPT.baseFont;
  const lineH = o.lineH || Math.round(fontSize * OPT.lineHRatio);
  const rowGap = o.rowGap == null ? Math.round(lineH * OPT.rowGapRatio) : o.rowGap;
  // 间距与括号宽度跟随字号等比缩放。以 baseFont 为 1.0，
  // 默认主题下比值恰好是 1，数值与标定时完全一致；字号一变就跟着走。
  const fontScale = fontSize / OPT.baseFont;
  const colGap = o.colGap == null ? Math.round(OPT.colGap * fontScale) : o.colGap;
  const braceWidth = o.braceWidth == null ? Math.round(OPT.braceWidth * fontScale) : o.braceWidth;
  const boxPadX = o.boxPadX == null ? Math.round(OPT.boxPadX * fontScale) : o.boxPadX;
  const boxPadY = o.boxPadY == null ? Math.round(OPT.boxPadY * fontScale) : o.boxPadY;
  const pad = o.pad == null ? OPT.pad : o.pad;

  const boxLayers = o.box instanceof Set
    ? o.box
    : new Set(Array.isArray(o.box) ? o.box : []);

  let measure = o.measure;
  let tempMeasure = null;
  if (typeof measure !== 'function') {
    tempMeasure = createDomMeasure(o.fontFamily || 'sans-serif', fontSize, 400);
    measure = tempMeasure;
  }

  // 粗体 run 的测量器：注入的优先，否则现建一个同字号的 600 字重
  let measureBold = o.measureBold;
  let tempBold = null;
  if (typeof measureBold !== 'function') {
    tempBold = createDomMeasure(o.fontFamily || 'sans-serif', fontSize, 600);
    measureBold = tempBold;
  }

  // 按 run 累加只在「估算」阶段有意义：给了实测宽度时 measure 返回的就是整行真值，
  // 再拆 run 会把同一行重复叠加，所以显式置 false，或由 measure.exact 自动关闭。
  const splitRuns = typeof o.splitRuns === 'boolean'
    ? o.splitRuns
    : !(typeof measure === 'function' && measure.exact);
  const onWidth = typeof o.onWidth === 'function' ? o.onWidth : null;

  const levelGap = colGap + braceWidth + colGap;
  const nodes = [];
  // 折行宽度上限（px）：0 或非正数 = 不折行，走原单行路径
  const maxWidth = Number.isFinite(o.maxWidth) && o.maxWidth > 0 ? o.maxWidth : 0;
  // 折行用的测量器：一律不带 seq（不往 estWidths 记账）。
  // measure 可能带 seq 副作用，这里显式只传文本一个参数。
  const measureRaw = typeof o.measureRaw === 'function'
    ? o.measureRaw
    : (t) => measure(t);
  const measureBoldRaw = typeof o.measureBoldRaw === 'function'
    ? o.measureBoldRaw
    : (t) => measureBold(t);
  // 测量序号：sizeAll 的遍历序就是 measure 的调用序，也是 data-seq 的来源。
  // 阶段二自校准靠它把「第几个节点用了哪个实测宽度」对上。
  let seq = 0;

  // 1) 后序算尺寸
  const sizeAll = (list, depth) => {
    for (const n of list) {
      n.depth = depth;
      n.seq = seq++;

      // 公式节点：宽度只能逐段累加（公式宽 = 转换阶段算好的 px），整行量会把
      // $x^2$ 这几个字符量成宽度，撑不开方框。同时它的实测宽度不可靠（公式不在
      // text 的字符推进里），所以不走实测纠正。
      const mathNode = hasMathIn(n.runs);

      // 行：<br> 先分段（解析阶段已切好），每段内部再按 maxWidth 折行
      const segs = (n.segRuns && n.segRuns.length) ? n.segRuns : [n.runs];
      const hardBreak = segs.length > 1;
      const wrapped = (maxWidth || hardBreak)
        ? nodeTextLines(segs, maxWidth, measureRaw, measureBoldRaw)
        : [];
      // 上一轮的折行结果（cfg.roots 跨轮复用，进到这里时 n.lineCount 还是上一轮的）
      const prevCount = n.lineCount || 0;
      if (wrapped.length > 1) {
        n.textLines = wrapped;
        n.lineCount = wrapped.length;
        let maxLineW = 0;
        for (const l of wrapped) if (l.width > maxLineW) maxLineW = l.width;

        // 实测路径（calibratedMeasure 带 exact）拿到的是「最宽行的真实宽度」，
        // 可能比估算宽很多：canvas 量不到主题字体的真实字宽时，估算会偏小，
        // 折行时一行就塞进更多字，渲染时撑出方框、字被裁掉。
        // 多行节点不能像单行那样靠 data-seq 自动纠正（当时为了避开
        // getComputedTextLength 的多 tspan 语义把它排除在校准外），现在
        // readActualWidths 已改成按行取最大，这里就直接以实测为准。
        let wActual = NaN;
        if (measure.exact && !mathNode) {
          const aw = measure(n.text, n.seq);
          // 那个实测值对应的是「上一轮的折行」。这一轮重新折过（行数变了）时，
          // 两边的最宽行根本不是同一段文字，直接拿它当宽度会把方框撑成上一轮
          // 那么宽（校准日志里出现过 359 的框装 179 的字）。折行变了就先不用它，
          // 让方框跟这一轮的最宽行走；下一轮折行稳定了再拿实测纠正。
          const wrapChanged = prevCount > 0 && prevCount !== wrapped.length;
          if (!wrapChanged && Number.isFinite(aw) && aw > 0) wActual = aw;
        }
        n.textWidth = Number.isFinite(wActual) ? Math.max(wActual, maxLineW) : maxLineW;

        // 记的是估算值（不含行末补空格的宽），供下一轮跟实测比；
        // 实测路径不再记账（onWidth 只在估算阶段传入）。
        if (onWidth) onWidth(maxLineW, n.seq);
      } else {
        // 未折行（含 maxWidth 开着但只需一行）：与改造前完全同一条测量路径，
        // 保证 estWidths 里记的仍是可与 getComputedTextLength 直接比较的整行宽度。
        n.textLines = null;
        n.lineCount = 1;
        n.textWidth = (splitRuns || mathNode)
          ? runsWidth(n.text, n.seq, n.runs,
            mathNode ? measureRaw : measure,
            mathNode ? measureBoldRaw : measureBold)
          : measure(n.text, n.seq);
        if (!Number.isFinite(n.textWidth)) n.textWidth = 0;
        // 自校准记账的是整行总宽（与 getComputedTextLength 可比），不是单个 run
        if (onWidth) onWidth(n.textWidth, n.seq);
      }
      // box: N 按层框；行尾 {box} 单独点名，两者可以共存
      n.boxed = boxLayers.has(depth + 1) || n.forceBox === true;

      const ownX = n.textWidth + (n.boxed ? boxPadX * 2 : 0);
      /*
       * 节点高：单行按字高（fontSize × nodeHRatio），多行在此基础上每多一行
       * 加一个行距 lineH。以前一律按 lineH × lineCount 算，单行节点会凭空
       * 高出半个行距，兄弟节点之间的括号就被拉开一大截。
       * 带公式的单行节点还要装得下公式本身：一个分式比 1.2em 的常规字高得多，
       * 不按公式高度撑开，它会压到上下两个兄弟节点上。
       */
      let textH = Math.round(fontSize * OPT.nodeHRatio);
      if (mathNode) {
        const mh = maxMathHeight(n.runs);
        if (mh > textH) textH = Math.round(mh);
      }
      const ownY = (n.lineCount > 1 ? textH + (n.lineCount - 1) * lineH : textH)
        + (n.boxed ? boxPadY * 2 : 0);
      n.bw = ownX;                       // 方框宽（最终 x 方向）
      n.bh = ownY;                       // 方框高（最终 y 方向）
      n.selfMain = vertical ? ownY : ownX;
      n.selfCross = vertical ? ownX : ownY;

      if (n.children.length) {
        sizeAll(n.children, depth + 1);
        n.mSize = n.selfMain;
        n.cSize = Math.max(n.selfCross, childrenTotal(n, rowGap));
      } else {
        n.mSize = n.selfMain;
        n.cSize = n.selfCross;
      }
      nodes.push(n);
    }
  };
  sizeAll(roots, 0);
  if (tempMeasure && tempMeasure.dispose) tempMeasure.dispose();
  if (tempBold && tempBold.dispose) tempBold.dispose();

  // 2) 摆位（后序）：先把子节点排进父节点槽位，再用首末子节点中点定父节点
  const placeAll = (list, mStart, cStart) => {
    let c = cStart;
    for (const n of list) {
      n.main = mStart + n.mSize / 2;
      const slotStart = c;
      const slotEnd = c + n.cSize;
      n.crossStart = slotStart;
      n.crossEnd = slotEnd;
      c = slotEnd + rowGap;

      if (n.children.length) {
        const total = childrenTotal(n, rowGap);
        // 子块在槽位里居中（槽位可能比子块宽，因为父节点自身更宽）
        placeAll(n.children, mStart + n.mSize + levelGap, slotStart + (n.cSize - total) / 2);
        const kids = n.children;
        n.cross = (kids[0].cross + kids[kids.length - 1].cross) / 2;
      } else {
        n.cross = slotStart + n.cSize / 2;
      }
    }
  };
  placeAll(roots, pad, pad);

  // 3) 括号：只包住下一层那一行文字（selfCross），不包整棵子树
  //    包围盒在「父节点末端」与「子节点列起点」之间居中，两侧留白恒等：
  //    tip - 父末端 === 子列起点 - body。尖端是个凸点，视觉上比竖线更显近，
  //    所以不能让它贴着父节点放。
  const braces = [];
  const collect = (list) => {
    for (const n of list) {
      if (!n.children.length) continue;
      const kids = n.children;
      const first = kids[0];
      const last = kids[kids.length - 1];

      const parentEnd = n.main + n.mSize / 2;
      let childStart = Infinity;
      for (const k of kids) childStart = Math.min(childStart, k.main - k.mSize / 2);
      const avail = Math.max(braceWidth, childStart - parentEnd);
      const mTip = parentEnd + (avail - braceWidth) / 2;

      braces.push({
        kind: 'branch',
        owner: n,
        mainTip: mTip,
        mainBody: mTip + braceWidth,
        cross1: first.cross - first.selfCross / 2,
        cross2: last.cross + last.selfCross / 2,
      });
      collect(kids);
    }
  };
  collect(roots);

  // 4) 末端总括号：尖端在外侧、开口（首末点）贴内容。
  //    同样居中：内容末端 → 画布内边距之间的空间里，两侧留白相等。
  const leaves = nodes.filter((n) => !n.children.length);
  if (o.closing && leaves.length) {
    let mEnd = -Infinity;
    let c1 = Infinity;
    let c2 = -Infinity;
    for (const l of leaves) {
      mEnd = Math.max(mEnd, l.main + l.mSize / 2);
      c1 = Math.min(c1, l.cross - l.selfCross / 2);
      c2 = Math.max(c2, l.cross + l.selfCross / 2);
    }
    // 可用空间 = 内容末端到画布内边距线（braceWidth + colGap + pad）
    const avail = braceWidth + colGap + pad;
    const mBody = mEnd + (avail - braceWidth) / 2;
    braces.push({
      kind: 'closing',
      mainTip: mBody + braceWidth,   // 尖端在外侧
      mainBody: mBody,               // 端点贴内容
      cross1: c1,
      cross2: c2,
    });
  }

  // 5) 包围盒：按真实绘制元素算（文字/方框的自身占位 + 括号两端），
  //    父节点按子节点中点定 cross 后可能溢出原槽位，所以不能只按 cSize 算
  let mainMin = Infinity;
  let mainMax = -Infinity;
  let crossMin = Infinity;
  let crossMax = -Infinity;
  for (const n of nodes) {
    mainMin = Math.min(mainMin, n.main - n.mSize / 2);
    mainMax = Math.max(mainMax, n.main + n.mSize / 2);
    crossMin = Math.min(crossMin, n.cross - n.selfCross / 2);
    crossMax = Math.max(crossMax, n.cross + n.selfCross / 2);
  }
  for (const b of braces) {
    // 尖端可能比竖线更外（closing），两边都要算进包围盒
    mainMin = Math.min(mainMin, b.mainTip, b.mainBody);
    mainMax = Math.max(mainMax, b.mainTip, b.mainBody);
    crossMin = Math.min(crossMin, b.cross1);
    crossMax = Math.max(crossMax, b.cross2);
  }

  // 极值归一：保证左/上边距就是 pad
  const dMain = pad - mainMin;
  const dCross = pad - crossMin;
  if (dMain !== 0 || dCross !== 0) {
    for (const n of nodes) {
      n.main += dMain;
      n.cross += dCross;
      n.crossStart += dCross;
      n.crossEnd += dCross;
    }
    for (const b of braces) {
      b.mainTip += dMain;
      b.mainBody += dMain;
      b.cross1 += dCross;
      b.cross2 += dCross;
    }
    mainMax += dMain;
    crossMax += dCross;
  }
  mainMax += pad;
  crossMax += pad;

  // 6) 映射到 x/y
  const W = vertical ? crossMax : mainMax;
  const H = vertical ? mainMax : crossMax;
  // main 轴映射：rl 沿 x 镜像，bt 沿 y 镜像；cross 轴永远不镜像
  const mainToX = dir === 'rl' ? (m) => mainMax - m : (m) => m;
  const mainToY = dir === 'bt' ? (m) => mainMax - m : (m) => m;

  for (const n of nodes) {
    n.x = vertical ? n.cross : mainToX(n.main);
    n.y = vertical ? mainToY(n.main) : n.cross;
    n.w = vertical ? n.selfCross : n.selfMain;
    n.h = vertical ? n.selfMain : n.selfCross;
  }

  for (const b of braces) {
    if (vertical) {
      // 竖生长：面 x = cross，y = main，交给 geomToD 转置
      const yTip = mainToY(b.mainTip);
      const yBody = mainToY(b.mainBody);
      b.d = geomToD(braceGeom(style, yTip, yBody, b.cross1, b.cross2), true);
    } else {
      const xTip = mainToX(b.mainTip);
      const xBody = mainToX(b.mainBody);
      b.d = geomToD(braceGeom(style, xTip, xBody, b.cross1, b.cross2), false);
    }
  }

  return { dir, style, width: W, height: H, lineH, nodes, braces };
}

module.exports = { layoutTree };
