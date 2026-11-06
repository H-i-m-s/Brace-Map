'use strict';

/* ============================================================
 * brace-map selftest · 解析：指令区与列表区
 * ============================================================ */

const { I, ok, eq, finite, clean, suite } = require('./framework');
const { SRC_FULL } = require('./helpers');

/* ------------------------------ 用例 ------------------------------ */

function tInternals() {
  ok(I && typeof I === 'object', 'internals exposed');
  for (const k of ['parseSource', 'bracePathCurly', 'bracePathSquare', 'layoutTree', 'buildSvg']) {
    ok(I && typeof I[k] === 'function', 'internals.' + k + ' is function');
  }
}

function tParseFull() {
  const r = I.parseSource(SRC_FULL);
  eq(r.title, '钢的分类与编号', 'parse: title');
  eq(r.dir, 'rl', 'parse: dir');
  eq(r.brace, 'square', 'parse: brace');
  eq(r.box, [1, 2], 'parse: box');
  eq(r.closing, true, 'parse: closing');

  eq(r.roots.length, 2, 'parse: level1 count');
  eq(r.roots[0].children.length, 2, 'parse: level2 count (按冶炼方法)');
  eq(r.roots[1].children.length, 1, 'parse: level2 count (按金相组织)');
  eq(r.roots[0].children[0].children.length, 2, 'parse: level3 count');
  eq(r.roots[0].text, '按冶炼方法', 'parse: level1 text');
  eq(r.roots[0].children[0].children[1].text, '乙', 'parse: level3 text');
}

function tDefaults() {
  const src = ['- 甲', '  - 乙', '  - 丙'].join('\n');
  const r = I.parseSource(src);
  eq(r.dir, 'lr', 'default: dir=lr');
  eq(r.brace, 'curly', 'default: brace=curly');
  eq(r.box, [], 'default: box=none');
  eq(r.closing, false, 'default: closing=false');
  eq(r.title, '', 'default: title empty');
  eq(r.roots.length, 1, 'default: one root');
  eq(r.roots[0].children.length, 2, 'default: two children');
}

function tHashTitle() {
  const src = ['# 某某', '- 甲', '  - 乙'].join('\n');
  const r = I.parseSource(src);
  eq(r.title, '某某', 'hash title: compat fallback');
}

function tDirectiveBeatsHash() {
  const src = ['# 旧标题', 'title: 新标题', '- 甲'].join('\n');
  const r = I.parseSource(src);
  eq(r.title, '新标题', 'hash title: directive wins');
}

function tNoTitle() {
  const src = ['- 甲', '- 乙'].join('\n');
  const r = I.parseSource(src);
  eq(r.title, '', 'no title: empty');
}

suite('internals', tInternals);
suite('parse-full', tParseFull);
suite('parse-defaults', tDefaults);
suite('parse-hash-title', tHashTitle);
suite('parse-title-priority', tDirectiveBeatsHash);
suite('parse-no-title', tNoTitle);
