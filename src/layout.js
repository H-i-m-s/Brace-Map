'use strict';

/* 布局：先排 (main, cross)，再按 dir 映射到 x/y */

const { OPT } = require('./opt');
const { DIRS, STYLES } = require('./parse');
const { createDomMeasure, runsWidth } = require('./measure');
const { wrapRuns } = require('./wrap');
const { hasMathIn, maxMathHeight } = require('./math');
const { braceGeom, geomToD } = require('./brace');
const { dbg } = require('./debug');

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

/*
 * 兄弟之间的纵向（cross 上）间距。
 *
 * 默认就是 rowGap；节点前面记着 gapBefore 个空行时，一个空行再加一整行 lineH。
 * 「一行」的高度取 lineH（= fontSize × OPT.lineHRatio），不取 rowGap：
 *   - lineH 是「文字行高」，多行节点内部换一行的行距也是它（渲染时 tspan dy = lineH），
 *     所以空一行看起来就是文字跳过一行，两把尺子同一刻度；
 *   - rowGap = 0.4 × lineH 只是兄弟之间那道固定的呼吸间隙，拿它当「行」会让
 *     空行比文字行矮一半，连空两行时与真实行的差距会越拉越开。
 */
function siblingGap(child, rowGap, lineH) {
  const n = child && Number.isFinite(child.gapBefore) && child.gapBefore > 0
    ? child.gapBefore
    : 0;
  return rowGap + n * lineH;
}

function childrenTotal(node, rowGap, lineH) {
  let sum = 0;
  for (let i = 0; i < node.children.length; i++) {
    const c = node.children[i];
    sum += c.cSize;
    if (i > 0) sum += siblingGap(c, rowGap, lineH);
  }
  return sum;
}

/**
 * closing 的声明列表归一化。
 *   { closingGroups: [{all:true} | {names:[...]}] }  ← 解析层给的新形状
 *   closing: true                                  ← 旧形状，等价于一条「全框」
 *   closing: [ ... ]                               ← 调用方直接给数组也认
 */
function closingGroupList(o) {
  // 显式关掉（closing: false）就一条都不画，哪怕调用方手里还带着 groups ——
  // 旧调用方手里只有这一个开关，别让它失效。
  if (o.closing === false) return [];
  if (Array.isArray(o.closingGroups) && o.closingGroups.length) return o.closingGroups;
  if (Array.isArray(o.closing)) return o.closing;
  return o.closing ? [{ all: true }] : [];
}

/**
 * closing 的点名：按节点的渲染文字（n.text）匹配。
 *   - 精确匹配：两边 trim 后全等，大小写与内部空格都算数（不模糊、不指层级）
 *   - 重名全中：同名节点可能在不同分支下，都框进去
 *   - 一个都没中的名字收进 missed，交给调用方报一条诊断，不影响其他名字、其他组
 */
function resolveClosingTargets(nodes, names) {
  const targets = [];
  const missed = [];
  for (const name of names) {
    const want = String(name == null ? '' : name).trim();
    if (!want) continue;
    let hit = false;
    for (const n of nodes) {
      const label = String(n.text == null ? '' : n.text).trim();
      if (label !== want) continue;
      hit = true;
      if (targets.indexOf(n) < 0) targets.push(n);
    }
    if (!hit) missed.push(want);
  }
  return { targets, missed };
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

  // closing 的声明列表（可能为空、一条、多条）与本次布局攒下的诊断
  const closingGroups = closingGroupList(o);
  const warnings = [];

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
        n.cSize = Math.max(n.selfCross, childrenTotal(n, rowGap, lineH));
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
    let first = true;
    for (const n of list) {
      // 间距只在这里加（与 childrenTotal 同一把尺子），节点自身高度不变
      if (!first) c += siblingGap(n, rowGap, lineH);
      first = false;
      n.main = mStart + n.mSize / 2;
      const slotStart = c;
      const slotEnd = c + n.cSize;
      n.crossStart = slotStart;
      n.crossEnd = slotEnd;
      c = slotEnd;

      if (n.children.length) {
        const total = childrenTotal(n, rowGap, lineH);
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

  // 4) 末端总括号（closing）：尖端在外侧、开口（首末点）贴内容。
  //    同样居中：内容末端 → 画布内边距之间的空间里，两侧留白相等。
  //
  //    一条声明 = 一个括号，按书写顺序从内往外排：第一条贴着内容，第 k 条往外一列。
  //    每条自己决定括谁——all 括全部叶子，names 按节点文字点名（可跨层：括号就是
  //    一条长括号穿过去，中间的行不参与）。
  //
  //    带标签的组在括号尖端外侧再写一行字（见下方 labelMainEnd / 第 6 步的映射）。
  //    两遍扫描：第一遍只定列号（判据只看 cross 范围，不看标签），同时记下每列
  //    标签的占宽；第二遍才按「左边那列有没有标签」算每列的横坐标。这样没标签的
  //    列间距与以前完全一样，有标签的列才把右边的列推开。
  const leaves = nodes.filter((n) => !n.children.length);
  if (closingGroups.length) {
    // 所有 closing 共用同一条基线：内容末端（含全部节点，不只叶子）到画布内边距线
    // 之间居中。多组时共用这条线、再逐列往外推，列间恒有一道 colGap，永远不叠。
    let mEnd = -Infinity;
    for (const n of nodes) mEnd = Math.max(mEnd, n.main + n.mSize / 2);
    // 可用空间 = 内容末端到画布内边距线（braceWidth + colGap + pad）
    const avail = braceWidth + colGap + pad;
    const base = mEnd + (avail - braceWidth) / 2;
    let col = 0;                      // 实际画出来的列号：没命中的那条不留空列
    const placed = [];                // 每列已经画了哪些括号（拿来判断能不能复用这列）
    const colLabelSpan = [];          // 每列标签在 main 上的最大占宽（没标签的列不记 = 0）
    const pending = [];               // 第一遍的成果：列号定了、x 还没定的括号
    for (const [i, group] of closingGroups.entries()) {
      const all = !!(group && group.all);
      const names = group && Array.isArray(group.names) ? group.names : [];
      const resolved = all
        ? { targets: leaves, missed: [] }
        : resolveClosingTargets(nodes, names);
      const targets = resolved.targets;

      // 没命中的名字一律留痕：整条落空时它就是「为什么没画」，部分命中时它指出写错的那个
      if (resolved.missed.length) {
        warnings.push('closing 第 ' + (i + 1) + ' 条：'
          + resolved.missed.join('、') + ' 没找到对应的节点');
        dbg('closing.miss', () => ({ group: i + 1, all, names, missed: resolved.missed }));
      }
      if (!targets.length) {
        // 名字一个都没匹配上：这一组跳过，不画、不抛错，也不影响别的组
        if (all) {
          warnings.push('closing 第 ' + (i + 1) + ' 条：没有叶子节点');
          dbg('closing.miss', () => ({ group: i + 1, all: true, names: [], missed: [] }));
        }
        continue;
      }
      // 按目标自身的 cross 占位算括号两端的端点（不是子树尺寸）
      let c1 = Infinity;
      let c2 = -Infinity;
      for (const t of targets) {
        c1 = Math.min(c1, t.cross - t.selfCross / 2);
        c2 = Math.max(c2, t.cross + t.selfCross / 2);
      }
      /*
       * 第一遍：定列号。判据只看 cross 范围，与改动前完全一致 —— 两个在垂直方向
       * 根本不重叠的括号可以并排共用一列，重叠的才往外排。标签不参与这个判据。
       *
       * 标签的横向伸出去多长，等到第二遍算列坐标时才起作用（见下面的 colBody）：
       * 左边那列有标签，它右边的列就多退 labelMainSpan + colGap。
       */
      let slot = 0;
      for (let k = 0; k < placed.length; k++) {
        const hit = placed[k].some((r) => !(c2 <= r.cross1 || c1 >= r.cross2));
        if (!hit) { slot = k; break; }
        slot = k + 1;
      }
      while (placed.length <= slot) placed.push([]);
      placed[slot].push({ cross1: c1, cross2: c2 });
      col++;

      /*
       * 标签：这一组叫什么，写在尖端外侧。
       *
       * 宽度用节点文字同一把尺子量（measureRaw 不传 seq，不往自校准的
       * estWidths 里记账）；量不出来就当 0，只有右边界会因此偏窄，不会画出坏路径。
       *
       * 沿 main 方向占多少：横着生长的图里标签是横着写的，占 labelW；
       * 竖着生长的图里标签仍横着写（不转 90°），它在 main 上占的是字高 fontSize，
       * 在 cross 上占 labelW。两侧各取各的，别混。
       *
       * 竖方向横写是**已知代价**：标签越宽（字数越多），画布在 cross（x）方向就被
       * 撑得越宽，整张图看起来向右偏、留白不对称；而转 90° 竖排能把这部分宽度
       * 换成沿 main 的进深，是以后的可选改法（本次不做，不改现有排版）。
       */
      const label = group && typeof group.label === 'string' ? group.label.trim() : '';
      let labelW = 0;
      if (label) {
        const lw = measureRaw(label);
        labelW = Number.isFinite(lw) && lw > 0 ? lw : 0;
      }
      const labelMainSpan = label ? (vertical ? fontSize : labelW) : 0;
      const labelCrossSpan = label ? (vertical ? labelW : fontSize) : 0;

      // 同一列里可能有好几条括号（上下不重叠），这一列的标签占宽取最大值：
      // 只要有一条带标签，右边那些列就得给它让出位置。
      if (labelMainSpan > 0) {
        colLabelSpan[slot] = Math.max(colLabelSpan[slot] || 0, labelMainSpan);
      }

      pending.push({ i, targets, c1, c2, slot, label, labelW, labelMainSpan, labelCrossSpan });
    }

    /*
     * 第二遍：算每列的 mainBody。
     *   第 0 列还是老基线 base —— 单列、无标签、以及「只有最内列有标签」的图里，
     *   这条括号的位置与改动前一模一样，不会因为标签而挪动。
     *   第 k 列 = 第 k-1 列的尖端 + colGap（上一列没标签，老间距）+ 标签占宽 + colGap。
     * 于是内列的标签右边缘离外列的 body 恒有一道 colGap，再也不会压在括号线上。
     */
    const colBody = [];
    for (let k = 0; k < placed.length; k++) {
      if (k === 0) { colBody[0] = base; continue; }
      const prevLabelSpan = colLabelSpan[k - 1] || 0;
      colBody[k] = colBody[k - 1] + braceWidth + colGap
        + (prevLabelSpan > 0 ? prevLabelSpan + colGap : 0);
    }

    for (const p of pending) {
      const mBody = colBody[p.slot];
      const mTip = mBody + braceWidth;
      braces.push({
        kind: 'closing',
        group: p.i,                   // 第几条声明（从 0 数，诊断/自测用）
        targets: p.targets,           // 这一条括住的节点（诊断/自测用）
        mainTip: mTip,                // 尖端在外侧
        mainBody: mBody,              // 端点贴内容
        cross1: p.c1,
        cross2: p.c2,
        // 标签：label 为空时下面四个都是 0 / 空串，绘制层直接跳过
        label: p.label,
        labelW: p.labelW,
        labelCrossSpan: p.labelCrossSpan,   // 标签在 cross 上的占宽（居中放）
        labelMainEnd: p.label ? mTip + colGap + p.labelMainSpan : 0,  // 标签在 main 上的外边缘
      });
    }
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
    /*
     * 标签也占地方，不能只算括号本体：
     *   main 方向伸到 labelMainEnd（尖端 + colGap + 标签占宽），不扩就被裁一半；
     *   cross 方向按中点居中，括号本身太窄（只括一个矮节点）时标签会顶出上下沿。
     * 多组各算各的，取最大值。
     */
    if (b.label) {
      mainMax = Math.max(mainMax, b.labelMainEnd);
      const cMid = (b.cross1 + b.cross2) / 2;
      crossMin = Math.min(crossMin, cMid - b.labelCrossSpan / 2);
      crossMax = Math.max(crossMax, cMid + b.labelCrossSpan / 2);
    }
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
      if (b.label) b.labelMainEnd += dMain;
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

    /*
     * 标签锚点：尖端外侧、cross 方向居中对齐这条括号。
     *
     * 沿 main 的进深取「尖端 + colGap」：
     *   横向图（lr/rl）这个点就是文字的起始边，x 交给 mainToX（rl 会镜像到左侧），
     *   text-anchor 跟着反过来用 end，文字才是「从尖端往外长」而不是压回括号上；
     *   竖向图（tb/bt）标签仍横着写，沿 main 占一个字高，所以取它的中心
     *   （尖端 + colGap + fontSize/2）交给 mainToY，再配 middle 锚点 + 居中基线。
     * 另一轴一律取 (cross1 + cross2) / 2，与括号的 cross 中心重合。
     */
    if (b.label) {
      const cMid = (b.cross1 + b.cross2) / 2;
      if (vertical) {
        b.labelX = cMid;
        b.labelY = mainToY(b.mainTip + colGap + fontSize / 2);
        b.labelAnchor = 'middle';
      } else {
        b.labelX = mainToX(b.mainTip + colGap);
        b.labelY = cMid;
        b.labelAnchor = dir === 'rl' ? 'end' : 'start';
      }
    }
  }

  return { dir, style, width: W, height: H, lineH, nodes, braces, warnings };
}

module.exports = { layoutTree };
