'use strict';

/* 自动折行（maxWidth） */

/* ============================================================
 * 自动折行（maxWidth）
 *
 * 把一行 run 切成若干行：中文（含全角标点）按单字断开，英文/数字优先在空格
 * 处断词，单词本身超宽时才硬断。样式跟着字符走，所以一个 run 被切成两段
 * 分属两行时，两段各自保留自己的 color / bold / italic / strike。
 *
 * 折行要量很多次（每个原子、甚至每个字），这些测量绝不能带 seq 副作用：
 * estWidths[seq] 是自校准的记账本，被逐字测量写一遍就彻底失效了。所以调用
 * 方必须传不带 seq 的 measureRaw / measureBoldRaw（见 layoutTree）。
 * ============================================================ */

// 可以「单字断开」的字符：CJK、全角标点、假名、谚文
const BREAK_CHAR_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f\u3040-\u30ff\uac00-\ud7af]/;
const SPACE_CHAR_RE = /^\s$/;

/** 两个 run 的样式是否一致：一致就合并，省一堆 tspan（链接目标也得一致，否则合并就丢 href） */
function sameRunStyle(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  // 公式是整块图形，合并文字会把两个公式拼成一段，也会丢矢量内容
  if (a.math || b.math) return false;
  return a.color === b.color
    && !!a.bold === !!b.bold
    && !!a.italic === !!b.italic
    && !!a.strike === !!b.strike
    && (a.href || null) === (b.href || null);
}

/** 一段文字的宽度：粗体走 600 字重测量器，量不出来按 0 */
function pieceWidth(text, style, measure, measureBold) {
  // 公式不可拆，也没有可量的字串：宽度取转换阶段算好的 widthEm × fontSize
  if (style && style.math && Number.isFinite(style.mathWidth)) {
    return Math.max(0, style.mathWidth);
  }
  if (!text) return 0;
  const w = style && style.bold ? measureBold(text) : measure(text);
  return Number.isFinite(w) && w > 0 ? w : 0;
}

/**
 * run 列表 → 原子序列。原子只有三种：
 *   space = 连续空白（断行机会，行尾直接丢掉）
 *   char  = 一个可单字断开的字符（中文/全角标点）
 *   word  = 一段连续的非空白非 CJK 字符（英文单词、数字，含其后的标点）
 */
function wrapAtoms(runs) {
  const atoms = [];
  const list = Array.isArray(runs) ? runs : [];

  for (const r of list) {
    if (!r) continue;
    // 公式：整块原子，不从中间断开
    if (r.math) {
      if (r.text || r.math) atoms.push({ text: r.text || '', kind: 'math', style: r });
      continue;
    }
    if (!r.text) continue;
    let buf = '';
    let kind = '';
    const flush = () => {
      if (buf) atoms.push({ text: buf, kind, style: r });
      buf = '';
    };
    for (const ch of String(r.text)) {
      if (SPACE_CHAR_RE.test(ch)) {
        if (kind !== 'space') { flush(); kind = 'space'; }
        buf += ch;
        continue;
      }
      if (BREAK_CHAR_RE.test(ch)) {
        flush();
        kind = '';
        atoms.push({ text: ch, kind: 'char', style: r });
        continue;
      }
      if (kind !== 'word') { flush(); kind = 'word'; }
      buf += ch;
    }
    flush();
  }
  return atoms;
}

/**
 * 贪心折行。返回 [{ pieces, width }]，pieces 是 { text, color, bold, italic, strike }。
 * 空文本或 maxWidth 无效时返回 []（调用方据此保持单行路径）。
 */
function wrapRuns(runs, maxWidth, measure, measureBold) {
  const limit = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : 0;
  if (!limit) return [];
  const atoms = wrapAtoms(runs);
  if (!atoms.length) return [];

  const lines = [];
  let cur = [];        // [{ text, style }]
  let curW = 0;
  let pending = '';    // 攒着的空格：后面还有字才落位
  let pendingStyle = null;

  const append = (text, style) => {
    if (!text) return;
    const last = cur[cur.length - 1];
    if (last && sameRunStyle(last.style, style)) last.text += text;
    else cur.push({ text, style });
    curW += pieceWidth(text, style, measure, measureBold);
  };

  const breakLine = () => {
    if (!cur.length) return;
    lines.push({ pieces: cur, width: curW });
    cur = [];
    curW = 0;
  };

  // 断行处的空格必须留在上一行末尾，不能丢：
  // getComputedTextLength() 以外的消费方（选中复制、笔记搜索、导出 SVG）
  // 读的是文本内容，丢一个空格就变成 deliberatelymixed 这种粘连文本。
  // 补在行末而不是下一行行首，是因为行首缩进难看，而行末空格在 SVG 里不可见。
  // 关键：追加时不加进 curW，行宽仍按「不含这个空格」计算，否则本来刚好
  // 卡在 maxWidth 上的行会因为这个空格提前断行。
  const breakWithTail = (tail, style) => {
    if (tail) {
      const last = cur[cur.length - 1];
      if (last && sameRunStyle(last.style, style)) last.text += tail;
      else cur.push({ text: tail, style });
    }
    breakLine();
  };

  for (const atom of atoms) {
    if (atom.kind === 'space') {
      pending += atom.text;
      pendingStyle = atom.style;
      continue;
    }

    const w = pieceWidth(atom.text, atom.style, measure, measureBold);

    // 先看「空格 + 这个词」一起还放得下吗；放不下就在空格处断行，
    // 那个空格进上一行的行末（不计宽），下一行从词开始。
    if (cur.length) {
      const pw = pending ? pieceWidth(pending, pendingStyle, measure, measureBold) : 0;
      if (curW + pw + w > limit) {
        breakWithTail(pending, pendingStyle);
        pending = '';
      }
    }
    if (pending && cur.length) append(pending, pendingStyle);
    pending = '';

    // 空行都放不下的单词：允许硬断，逐字填满这一行
    if (!cur.length && w > limit && atom.kind === 'word' && Array.from(atom.text).length > 1) {
      for (const ch of Array.from(atom.text)) {
        const cw = pieceWidth(ch, atom.style, measure, measureBold);
        if (cur.length && curW + cw > limit) breakLine();
        append(ch, atom.style);
      }
      continue;
    }

    append(atom.text, atom.style);
  }
  breakLine();

  // 转成渲染用的 run 形态（与 parseRuns 的输出同形）
  return lines.map((l) => ({
    width: l.width,
    pieces: l.pieces.map((p) => {
      const s = p.style;
      const piece = {
        text: p.text,
        color: s.color,
        bold: !!s.bold,
        italic: !!s.italic,
        strike: !!s.strike,
        // 链接跨行时每一行都还是同一条链接，否则后半行就点不动了
        href: s.href || null,
      };
      // 公式 run 的尺寸与矢量内容跟着走，否则折行后这一段就成了空的
      if (s.math) {
        piece.math = s.math;
        piece.display = !!s.display;
        piece.mathMarkup = s.mathMarkup;
        piece.mathUnits = s.mathUnits;
        piece.mathMinX = s.mathMinX;
        piece.mathMinY = s.mathMinY;
        piece.mathWidthEm = s.mathWidthEm;
        piece.mathHeightEm = s.mathHeightEm;
        piece.mathDepthEm = s.mathDepthEm;
        piece.mathWidth = s.mathWidth;
        piece.mathHeight = s.mathHeight;
      }
      return piece;
    }),
  }));
}

module.exports = { wrapRuns, wrapAtoms };
