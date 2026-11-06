'use strict';

/* 括号几何：钩子/尖端比例、路径生成 */

const { OPT } = require('./opt');
const { num, clampRange } = require('./util');

/* ============================================================
 * 括号路径（纯函数，只产生 SVG d 字符串）
 *
 * geom 内部统一用 (u, v)：u = 沿「尖端/竖线」那条轴，v = 沿跨度那条轴。
 *   u 轴：tip 一侧是尖端，body 一侧是开口
 *   v 轴：a1 → a2 是括号括住的范围
 * 开口永远朝 body 一侧：首末点都在 body，竖线在 tip/body 中点，尖端落在 tip。
 * 最后再去映射成 x/y（横生长 = (x, y)；竖生长 = (y, x)）。
 * ============================================================ */

/**
 * 钩子半径 r 与尖端单侧斜边 t。
 *
 * 两者都按括号总高 span 的比例取，再夹在绝对上下限里：恒定像素会让矮括号
 * 的纵向空间被钩子与尖端吃光（中间几乎没有直线段，像一根压扁的波浪），
 * 高括号又显得钩子过小。比例尺配上上下限，两头都能看。
 *
 * 硬约束：2*(r + t) < H 恒成立（超了就按 H 等比压缩），保证中间永远有一
 * 段直线，长度至少 OPT.minStraight。
 */
function braceK(w, span) {
  const H = Math.max(0, Number.isFinite(span) ? span : 0);
  const ww = Math.max(0, Number.isFinite(w) ? w : 0);
  const rMax = ww * OPT.hookMaxRatio;
  const tMax = ww * OPT.tipMaxRatio;

  let r = clampRange(H * OPT.hookRatio, Math.min(OPT.hookMin, rMax), rMax);
  let t = clampRange(H * OPT.tipRatio, Math.min(OPT.tipMin, tMax), tMax);

  // 中间直线段 = H - 2*(r + t)，不够 minStraight 就等比压缩 r、t
  const budget = H - OPT.minStraight;
  const sum = r + t;
  if (budget <= 0) {
    r = 0;
    t = 0;
  } else if (2 * sum > budget) {
    const f = budget / (2 * sum);
    r *= f;
    t *= f;
  }
  return { kHook: r, kTip: t };
}

function braceGeom(style, tip, body, a1, a2) {
  const t = Number.isFinite(tip) ? tip : 0;
  const b = Number.isFinite(body) ? body : 0;
  let s1 = Number.isFinite(a1) ? a1 : 0;
  let s2 = Number.isFinite(a2) ? a2 : 0;
  if (s2 < s1) {
    const tmp = s1;
    s1 = s2;
    s2 = tmp;
  }

  const w = Math.abs(b - t);
  const span = s2 - s1;
  const mid = t + (b - t) * 0.5;              // 竖线位置，带符号，支持 b < t
  const k = braceK(w, span);
  const am = (s1 + s2) / 2;

  if (style === 'square') {
    return [
      ['M', [[b, s1]]],
      ['L', [[t, s1]]],
      ['L', [[t, s2]]],
      ['L', [[b, s2]]],
    ];
  }

  return [
    ['M', [[b, s1]]],
    ['Q', [[mid, s1], [mid, s1 + k.kHook]]],
    ['L', [[mid, am - k.kTip]]],
    ['L', [[t, am]]],
    ['L', [[mid, am + k.kTip]]],
    ['L', [[mid, s2 - k.kHook]]],
    ['Q', [[mid, s2], [b, s2]]],
  ];
}

function geomToD(geom, swap) {
  const parts = [];
  for (const cmd of geom) {
    const op = cmd[0];
    const pts = cmd[1];
    const nums = [];
    for (const p of pts) {
      if (swap) {
        nums.push(num(p[1]), num(p[0]));
      } else {
        nums.push(num(p[0]), num(p[1]));
      }
    }
    parts.push(op + ' ' + nums.join(' '));
  }
  return parts.join(' ');
}

/** 大括号：尖端在 xTip（父节点一侧），竖线在 xBody（子节点一侧） */
function bracePathCurly(xTip, xBody, y1, y2) {
  return geomToD(braceGeom('curly', xTip, xBody, y1, y2), false);
}

/** 方括号 */
function bracePathSquare(xTip, xBody, y1, y2) {
  return geomToD(braceGeom('square', xTip, xBody, y1, y2), false);
}

module.exports = {
  braceK,
  braceGeom,
  geomToD,
  bracePathCurly,
  bracePathSquare,
};
