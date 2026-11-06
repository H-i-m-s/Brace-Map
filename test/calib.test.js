'use strict';

/* ============================================================
 * brace-map selftest · 渲染后自校准
 * ============================================================ */

const { I, ok, eq, finite, clean, suite } = require('./framework');
const { FONT, LAYOUT_OPTS, mockMeasure, textEls } = require('./helpers');

/* ---------------------- v0.4.0 新增：渲染后自校准 ---------------------- */

const SRC_THREE_BOXED = [
  'box: 1,2',
  '- 按冶炼方法',
  '  - 平炉钢',
  '    - 甲',
  '    - 乙',
  '  - 转炉钢',
].join('\n');

/** 从标记里按出现顺序取出 bm-box 的 width */
function rectWidths(markup) {
  const out = [];
  const re = /<rect class="bm-box"[^>]*\bwidth="([^"]+)"/g;
  let m;
  while ((m = re.exec(String(markup)))) out.push(Number(m[1]));
  return out;
}

function boxedNodes(built) {
  return built.layout.nodes.filter((n) => n.boxed);
}

function nodeCount(cfg) {
  let n = 0;
  const walk = (list) => {
    for (const x of list) {
      n++;
      walk(x.children);
    }
  };
  walk(cfg.roots);
  return n;
}

function tMeasureSeq() {
  const cfg = I.parseSource(SRC_THREE_BOXED);

  const callsA = [];
  const recA = (text, seq) => {
    callsA.push({ text, seq });
    return mockMeasure(text);
  };
  const callsB = [];
  const recB = (text, seq) => {
    callsB.push({ text, seq });
    return mockMeasure(text);
  };

  const a = I.buildSvg(cfg, Object.assign({}, LAYOUT_OPTS, { measure: recA, measureBold: mockMeasure }));
  const b = I.buildSvg(cfg, Object.assign({}, LAYOUT_OPTS, { measure: recB, measureBold: mockMeasure }));

  const total = nodeCount(cfg);
  eq(callsA.length, total, 'seq: 每个节点只量一次');
  eq(callsA.map((c) => c.seq), callsB.map((c) => c.seq), 'seq: 两次调用的序号序列一致');
  eq(callsA.map((c) => c.text), callsB.map((c) => c.text), 'seq: 两次调用的文本顺序一致');
  ok(callsA.every((c, i) => c.seq === i), 'seq: 序号从 0 连续递增',
    JSON.stringify(callsA.map((c) => c.seq)));

  eq(b.seqs, a.seqs, 'seq: buildSvg 返回 seqs 且稳定');
  eq(a.seqs.length, a.layout.nodes.length, 'seq: seqs 长度 = 节点数');
  eq(a.seqs.slice().sort((x, y) => x - y), a.layout.nodes.map((n) => n.seq).slice().sort((x, y) => x - y),
    'seq: seqs 与节点 seq 一致');

  // 标记里每个 text 都带 data-seq，且与 seqs 一一对应
  const ds = (a.markup.match(/data-seq="(\d+)"/g) || []).map((s) => Number(s.match(/\d+/)[0]));
  eq(ds.length, a.layout.nodes.length, 'seq: 每个 text 都有 data-seq');
  eq(new Set(ds).size, ds.length, 'seq: data-seq 不重复');
  eq(ds.slice().sort((x, y) => x - y), a.seqs.slice().sort((x, y) => x - y), 'seq: data-seq 与 seqs 配对');

  // data-seq 不能打断既有标记解析（x/y/anchor 仍紧跟 class）
  eq(textEls(a.markup).length, a.layout.nodes.length, 'seq: textEls 仍能解析全部 text');
}

function tCalibRelayout() {
  const cfg = I.parseSource(SRC_THREE_BOXED);
  const padX = I.OPT.boxPadX;

  // 阶段一：10px/字，同时按 seq 收集估算宽度
  const est = [];
  const calls = [];
  const rec = (text, seq) => {
    const w = mockMeasure(text);
    if (Number.isFinite(seq)) {
      est[seq] = w;
      calls.push({ text, seq });
    }
    return w;
  };
  const first = I.buildSvg(cfg, Object.assign({}, LAYOUT_OPTS, { measure: rec, measureBold: mockMeasure }));

  // 模拟 letter-spacing：每字多 3px（实际 13px/字），按 seq 建实测表
  const actual = new Map();
  for (const c of calls) actual.set(c.seq, String(c.text).length * 13);
  ok(actual.size === calls.length && actual.size > 0, 'calib: 实测表按 seq 建好', String(actual.size));
  ok(calls.every((c) => Math.abs(actual.get(c.seq) - est[c.seq] - String(c.text).length * 3) < 1e-9),
    'calib: 实测 = 估算 + 3px/字');

  // 阶段一在字距下确实框不住（对照有效）
  const w1 = rectWidths(first.markup);
  const bn1 = boxedNodes(first);
  eq(w1.length, bn1.length, 'calib: 阶段一 rect 数 = 带框节点数');
  let broken = 0;
  bn1.forEach((n, i) => {
    if (w1[i] < actual.get(n.seq) + 2 * padX - 0.01) broken++;
  });
  eq(broken, bn1.length, 'calib: 阶段一被字距撑破（对照）');

  // 阶段二：用实测宽度重排
  const second = I.buildSvg(cfg, Object.assign({}, LAYOUT_OPTS, {
    measure: I.calibratedMeasure(actual, mockMeasure),
    measureBold: mockMeasure,
  }));

  const w2 = rectWidths(second.markup);
  const bn2 = boxedNodes(second);
  eq(w2.length, bn2.length, 'calib: 重排后 rect 数 = 带框节点数');

  const bad = [];
  bn2.forEach((n, i) => {
    const need = actual.get(n.seq) + 2 * padX - 0.01;
    if (!(w2[i] >= need)) bad.push([n.text, w2[i], need]);
  });
  ok(bad.length === 0, 'calib: 重排后方框宽度 >= 实测文字宽 + 2*boxPadX',
    JSON.stringify(bad.slice(0, 3)));

  const badNode = bn2.filter((n) => !(n.bw >= actual.get(n.seq) + 2 * padX - 0.01));
  ok(badNode.length === 0, 'calib: 节点 bw 同样满足约束', String(badNode.length));

  // 重排后的文字仍居中，且画布变宽
  ok(second.width >= first.width, 'calib: 重排后画布不变窄',
    first.width.toFixed(1) + ' → ' + second.width.toFixed(1));
  eq(second.layout.nodes.length, first.layout.nodes.length, 'calib: 节点数不变');
}

function tCalibMeasureMap() {
  const m = I.calibratedMeasure(new Map([[0, 33]]), (t) => String(t).length);
  ok(m('abc', 0) === 33, 'calibMeasure: 命中 seq 用实测宽度');
  ok(m('abc', 0) === 33, 'calibMeasure: 同一 seq 不看文本内容');
  ok(m('abc', 9) === 3, 'calibMeasure: seq 不在表里回落到估算');
  ok(m('abc') === 3, 'calibMeasure: 无 seq 回落到估算');
  ok(m('abc', 0) === 33 && m('abcdefgh', 0) === 33, 'calibMeasure: 纯按索引映射');
}

function tCalibInvisible() {
  let reads = 0;
  let retries = 0;
  let rebuilds = 0;
  const zeros = { widths: new Map([[0, 0], [1, 0], [2, 0]]), max: 0, count: 3 };

  let threw = null;
  try {
    I.calibrateSvg({}, {
      estWidths: [10, 20, 30],
      readActual: () => { reads++; return zeros; },
      waitFonts: (cb) => { retries++; cb(); return true; },
      rebuild: () => { rebuilds++; return { markup: '<svg></svg>' }; },
    });
  } catch (err) {
    threw = err;
  }

  ok(!threw, 'calib0: 全 0 不抛错', threw && threw.message);
  eq(reads, 2, 'calib0: 全 0 只读两次（首测 + 字体就绪重试）');
  eq(retries, 1, 'calib0: 字体就绪只重试一次');
  eq(rebuilds, 0, 'calib0: 全 0 不重排');
}

function tCalibNoDrift() {
  let rebuilds = 0;
  I.calibrateSvg({}, {
    estWidths: [100, 200],
    readActual: () => ({ widths: new Map([[0, 100.2], [1, 199.6]]), max: 200, count: 2 }),
    waitFonts: () => false,
    rebuild: () => { rebuilds++; return { markup: '<svg></svg>' }; },
  });
  eq(rebuilds, 0, 'calib: 偏差 <= 0.5px 不重排');
}

function tCalibOnce() {
  let reads = 0;
  let rebuilds = 0;

  // 有偏差 + 重排：node 环境无 DOMParser，走解析失败的静默降级路径
  let threw = null;
  try {
    I.calibrateSvg({}, {
      estWidths: [100, 200],
      readActual: () => {
        reads++;
        return { widths: new Map([[0, 100.6], [1, 200]]), max: 200, count: 2 };
      },
      waitFonts: () => false,
      rebuild: () => { rebuilds++; return { markup: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }; },
    });
  } catch (err) {
    threw = err;
  }
  ok(!threw, 'calib: 偏差 > 0.5px 时不抛错（标记解析失败静默降级）', threw && threw.message);
  eq(rebuilds, 1, 'calib: 偏差 > 0.5px 只重排一次');
  eq(reads, 1, 'calib: 重排后不复测，不循环');

  // readActual 抛异常：不冒泡
  let threw2 = null;
  try {
    I.calibrateSvg({}, {
      estWidths: [],
      readActual: () => { throw new Error('boom'); },
      rebuild: () => { throw new Error('should not run'); },
    });
  } catch (err) {
    threw2 = err;
  }
  ok(!threw2, 'calib: 读宽抛错不冒泡');

  // rebuild 抛异常：不冒泡，也不重试
  let reads3 = 0;
  let threw3 = null;
  try {
    I.calibrateSvg({}, {
      estWidths: [10],
      readActual: () => { reads3++; return { widths: new Map([[0, 99]]), max: 99, count: 1 }; },
      rebuild: () => { throw new Error('boom'); },
    });
  } catch (err) {
    threw3 = err;
  }
  ok(!threw3 && reads3 === 1, 'calib: rebuild 抛错也只试一次', String(reads3));
}

function tCalibRetryThenLayout() {
  let reads = 0;
  let rebuilds = 0;
  let pending = null;

  I.calibrateSvg({}, {
    estWidths: [10, 20],
    readActual: () => {
      reads++;
      if (reads === 1) return { widths: new Map([[0, 0], [1, 0]]), max: 0, count: 2 };
      return { widths: new Map([[0, 40], [1, 40]]), max: 40, count: 2 };
    },
    waitFonts: (cb) => { pending = cb; return true; },
    rebuild: () => { rebuilds++; return { markup: '<svg></svg>' }; },
  });

  eq(typeof pending, 'function', 'calib-retry: 不可见时挂上了重试');
  eq(reads, 1, 'calib-retry: 首测全 0 不重排');
  if (typeof pending === 'function') pending();
  eq(reads, 2, 'calib-retry: 字体就绪后复测一次');
  eq(rebuilds, 1, 'calib-retry: 复测有偏差则重排一次');
}

suite('calib-measure-seq', tMeasureSeq);
suite('calib-relayout', tCalibRelayout);
suite('calib-measure-map', tCalibMeasureMap);
suite('calib-invisible', tCalibInvisible);
suite('calib-threshold', tCalibNoDrift);
suite('calib-once', tCalibOnce);
suite('calib-retry', tCalibRetryThenLayout);
