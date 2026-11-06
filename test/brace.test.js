'use strict';

/* ============================================================
 * brace-map selftest · 括号路径：开口朝向、比例、退化情形
 * ============================================================ */

const { I, ok, eq, finite, clean, suite } = require('./framework');
const { pathPoints } = require('./helpers');

function tPaths() {
  // 开口朝 body（子节点侧）：首末点在 body=12，尖端在 tip=0
  // w=12 → r = clamp(100*0.15, 3, 12*0.6=7.2) = 7.2，t = clamp(100*0.11, 2.5, 12*0.5=6) = 6
  const d = I.bracePathCurly(0, 12, 0, 100);
  eq(d, 'M 12 0 Q 6 0 6 7.2 L 6 44 L 0 50 L 6 56 L 6 92.8 Q 6 100 12 100', 'curly: exact path');
  ok(d.startsWith('M 12 0'), 'curly: 首点在 body 侧', d);
  ok(d.endsWith('12 100'), 'curly: 末点在 body 侧', d);
  ok(d.indexOf('L 0 50') >= 0, 'curly: 尖端顶点落在 tip 侧', d);
  eq(d.match(/[MLQCZ]/g), ['M', 'Q', 'L', 'L', 'L', 'L', 'Q'], 'curly: tip is straight L (no Q)');
  ok(clean(d), 'curly: no NaN/undefined', d);

  const sq = I.bracePathSquare(0, 12, 0, 100);
  eq(sq, 'M 12 0 L 0 0 L 0 100 L 12 100', 'square: exact path');
  const tok = sq.split(' ');
  ok(tok[0] === 'M' && tok[1] === '12' && tok[2] === '0', 'square: 首点 M 12 0', sq);
  ok(tok[3] === 'L' && tok[4] === '0' && tok[5] === '0', 'square: 第二点折到 tip 侧', sq);
  ok(clean(sq), 'square: no NaN/undefined', sq);
}

function tOpeningSide() {
  // 无论 tip/body 先后，开口都必须朝 body
  const a = I.bracePathCurly(0, 12, 0, 100);
  const b = I.bracePathCurly(12, 0, 0, 100);
  ok(a.startsWith('M 12 0'), 'opening: tip<0 时首点在 body');
  ok(b.startsWith('M 0 0'), 'opening: tip>0 时首点在 body');
  ok(a.indexOf('L 0 50') >= 0, 'opening: tip<0 时尖端在 tip');
  ok(b.indexOf('L 12 50') >= 0, 'opening: tip>0 时尖端在 tip');
  ok(clean(b), 'opening: no NaN/undefined', b);
}

function tDegenerate() {
  const d = I.bracePathCurly(0, 11, 50, 54);
  ok(clean(d), 'degenerate: no NaN/undefined', d);
  const nums = d.match(/-?\d+(\.\d+)?/g) || [];
  ok(nums.length > 0, 'degenerate: has numbers');
  ok(nums.every((n) => Number(n) >= 0), 'degenerate: no negative numbers', d);

  const zero = I.bracePathCurly(0, 11, 0, 0);
  ok(clean(zero), 'zero span: no NaN/undefined', zero);
  ok(zero.startsWith('M 11 0'), 'zero span: 首点仍在 body 侧', zero);

  const reversed = I.bracePathCurly(11, 0, 100, 0); // 尖端在右侧（rl 映射后）
  ok(clean(reversed), 'reversed: no NaN/undefined', reversed);
  ok(reversed.indexOf('L 11 50') >= 0, 'reversed: 尖端顶点在 tip 侧', reversed);

  // v0.3.0：r/t 非负，且中间永远留出 >= 4px 直线段
  const k6 = I.braceK(I.OPT.braceWidth, 6);
  ok(k6.kHook >= 0 && k6.kTip >= 0, 'degenerate: r/t 非负', JSON.stringify(k6));
  ok(6 - 2 * (k6.kHook + k6.kTip) >= I.OPT.minStraight - 1e-9,
    'degenerate: span=6 中间直线 >= 4', (6 - 2 * (k6.kHook + k6.kTip)).toFixed(3));

  const k0 = I.braceK(I.OPT.braceWidth, 0);
  ok(finite(k0.kHook) && finite(k0.kTip) && k0.kHook >= 0 && k0.kTip >= 0,
    'degenerate: span=0 无 NaN / 负值', JSON.stringify(k0));

  const d6 = I.bracePathCurly(0, 10, 20, 26);
  ok(clean(d6), 'degenerate: span=6 path 干净', d6);
  ok((d6.match(/-?\d+(?:\.\d+)?/g) || []).every((x) => Number(x) >= 0),
    'degenerate: span=6 无负坐标', d6);
  const pts6 = pathPoints(d6);
  ok(pts6.length >= 5, 'degenerate: span=6 有足够控制点', String(pts6.length));
}

function tTipVsHook() {
  const w = I.OPT.braceWidth; // 10

  // 大跨度撞 w 的上限：r = w*0.6、t = w*0.5
  const big = I.braceK(w, 200);
  ok(Math.abs(big.kHook - w * I.OPT.hookMaxRatio) < 1e-9, 'braceK: 大跨度 r 封顶 w*0.6', String(big.kHook));
  ok(Math.abs(big.kTip - w * I.OPT.tipMaxRatio) < 1e-9, 'braceK: 大跨度 t 封顶 w*0.5', String(big.kTip));
  ok(big.kTip < big.kHook, 'braceK: 尖端斜边 < 钩子半径', big.kHook + ' vs ' + big.kTip);

  // 小跨度按比例走：span=30 时 r=4.5 (0.15)、t=3.3 (0.11)
  const mid = I.braceK(w, 30);
  ok(Math.abs(mid.kHook - 30 * I.OPT.hookRatio) < 1e-9, 'braceK: 小跨度 r = span*0.15', String(mid.kHook));
  ok(Math.abs(mid.kTip - 30 * I.OPT.tipRatio) < 1e-9, 'braceK: 小跨度 t = span*0.11', String(mid.kTip));

  // 路径里能看出两套 k：w=10,span=100 → r=6、t=5、mid=5
  const d = I.bracePathCurly(0, w, 0, 100);
  ok(d.indexOf('Q 5 0 5 6') >= 0, 'path: 上端钩子用 r=6', d);
  ok(d.indexOf('L 5 45') >= 0 && d.indexOf('L 5 55') >= 0, 'path: 尖端斜边用 t=5', d);
  ok(d.indexOf('L 5 94') >= 0, 'path: 下端钩子用 r=6', d);

  const tiny = I.braceK(w, 4);
  ok(tiny.kTip <= tiny.kHook && tiny.kTip >= 0, 'braceK: 小跨度不自交', JSON.stringify(tiny));
}

suite('brace-paths', tPaths);
suite('brace-opening-side', tOpeningSide);
suite('brace-tip-vs-hook', tTipVsHook);
suite('brace-degenerate', tDegenerate);
