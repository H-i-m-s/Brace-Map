'use strict';

/* 数字格式化 */

function num(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '0';
  const r = Math.round(v * 1000) / 1000;
  return String(r === 0 ? 0 : r);
}

function clampRange(v, lo, hi) {
  const x = Number.isFinite(v) ? v : lo;
  if (hi < lo) return hi;
  return Math.max(lo, Math.min(hi, x));
}

module.exports = { num, clampRange };
