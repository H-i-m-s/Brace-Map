'use strict';

/* ============================================================
 * brace-map selftest · 折行诊断 + 校准二次收敛 + 字体探针回退
 *
 * 这几条对应 v0.4.1 修掉的那个「maxWidth 折行后撑破方框、左边被裁」：
 *   1) measureContext 在宿主还没接进文档时读不到字号，以前静默退回 14px；
 *   2) 校准只重排一轮，且 fonts.ready 的异步重试会拿旧估算表把好结果盖回去；
 *   3) 现场只能靠一份折行诊断把数据带回来。
 * ============================================================ */

const { I, ok, eq, clean, suite } = require('./framework');
const { LAYOUT_OPTS } = require('./helpers');

/* ------------------------------ 字体探针 ------------------------------ */

/**
 * 极简假 DOM：只实现 measureContext 用到的那几个口子。
 * 关键语义是浏览器的那一条——元素（或祖先）不在文档里时没有 layout，
 * getComputedStyle 读不出 fontSize；在文档里才沿树继承。
 */
function fakeFontDom() {
  const bodyFont = { fontSize: '19.95px', fontFamily: '"方正FW筑紫A圆 简", sans-serif' };

  const mkNode = (font) => ({
    __font: font || null,
    parentNode: null,
    kids: [],
    style: {},
    setAttribute() {},
    getAttribute() { return null; },
    appendChild(child) {
      child.parentNode = this;
      this.kids.push(child);
      child.__font = this.__font || null;   // 字体沿树继承
      return child;
    },
    removeChild(child) {
      const i = this.kids.indexOf(child);
      if (i >= 0) this.kids.splice(i, 1);
      child.parentNode = null;
      return child;
    },
  });

  const body = mkNode(bodyFont);
  // 未接进文档的宿主（Obsidian 先把代码块渲染进离屏容器）
  const detached = mkNode(null);

  const doc = {
    body,
    createElementNS() { return mkNode(null); },
  };

  const gcs = (el) => {
    if (!el || !el.__font) return { fontSize: '', fontFamily: '' };
    return { fontSize: el.__font.fontSize, fontFamily: el.__font.fontFamily };
  };

  return { doc, gcs, detached, body };
}

/** 在假 DOM 里跑一个用例，结束后还原全局 */
function withFakeDom(fn) {
  const savedGcs = globalThis.getComputedStyle;
  const savedDoc = globalThis.document;
  const dom = fakeFontDom();
  globalThis.getComputedStyle = dom.gcs;
  globalThis.document = dom.doc;
  try {
    return fn(dom);
  } finally {
    if (savedGcs === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = savedGcs;
    if (savedDoc === undefined) delete globalThis.document;
    else globalThis.document = savedDoc;
  }
}

function tMeasureContext() {
  eq(typeof I.measureContext, 'function', 'measureContext: 导出');
  eq(typeof I.readLiveFont, 'function', 'readLiveFont: 导出');

  withFakeDom((dom) => {
    // 1) 宿主在文档里：读宿主自己的字号
    const ctx = I.measureContext(dom.body);
    eq(Math.round(ctx.fontSize * 100) / 100, 19.95, 'measureContext: 宿主在文档里时读到真字号');
    ok(/方正FW/.test(ctx.fontFamily), 'measureContext: 字族也读到了', ctx.fontFamily);

    // 2) 宿主不在文档里（离屏）：不能再退回 14px，要回退到 body 上量
    const off = I.measureContext(dom.detached);
    eq(Math.round(off.fontSize * 100) / 100, 19.95,
      'measureContext: 离屏宿主回退到 body 量字号（以前静默退回 14px）');
    ok(/方正FW/.test(off.fontFamily), 'measureContext: 离屏时字族同样回退', off.fontFamily);
    ok(off.fontSize !== 14, 'measureContext: 不再是 14px 兜底值');

    // 3) 探针必须清理干净，不能留在树里
    eq(dom.detached.kids.length, 0, 'measureContext: 离屏宿主里的探针已移除');
    eq(dom.body.kids.length, 0, 'measureContext: body 上的探针已移除');
  });

  // 4) 全读不到时才用基准字号 / sans-serif 兜底
  //    （早先写死 14px，与实际 19.95px 差 1.42 倍，会先撑破一遍再等异步校验修）
  const savedGcs = globalThis.getComputedStyle;
  const savedDoc = globalThis.document;
  globalThis.getComputedStyle = () => ({ fontSize: '', fontFamily: '' });
  globalThis.document = {
    body: { parentNode: null, kids: [], style: {}, setAttribute() {}, appendChild(c) { this.kids.push(c); c.parentNode = this; return c; }, removeChild(c) { c.parentNode = null; return c; } },
    createElementNS() {
      return { parentNode: null, kids: [], style: {}, setAttribute() {}, appendChild(c) { this.kids.push(c); c.parentNode = this; return c; }, removeChild(c) { c.parentNode = null; return c; } };
    },
  };
  try {
    const none = I.measureContext(null);
    eq(none.fontSize, I.OPT.baseFont, 'measureContext: 两处都读不到才兜底基准字号');
    eq(none.fontFamily, 'sans-serif', 'measureContext: 兜底字族 sans-serif');
  } finally {
    if (savedGcs === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = savedGcs;
    if (savedDoc === undefined) delete globalThis.document;
    else globalThis.document = savedDoc;
  }

  // readLiveFont 对读不到字号的元素返回 null（而不是 14）
  eq(I.readLiveFont({ __font: null }), null, 'readLiveFont: 读不到字号返回 null');
}

/* ------------------------------ 最宽行 ------------------------------ */

function fakeRow(len, tag) {
  const name = tag || 'tspan';
  return {
    tagName: name,
    localName: name,
    hasAttribute: (a) => a === 'dy',
    getComputedTextLength: () => len,
  };
}

function fakeStyledSpan() {
  return {
    tagName: 'tspan',
    localName: 'tspan',
    hasAttribute: () => false,        // 样式 tspan 没有 dy
    getComputedTextLength: () => 999,
  };
}

function tWidestLine() {
  eq(typeof I.measureWidestLine, 'function', 'measureWidestLine: 导出');

  const single = { children: [], getComputedTextLength: () => 88.5 };
  eq(I.measureWidestLine(single), 88.5, 'widestLine: 单行用整行长度');

  const multi = {
    children: [fakeRow(120), fakeRow(240), fakeStyledSpan()],
    getComputedTextLength: () => 360,   // 多行时它是横向累加，不能用
  };
  eq(I.measureWidestLine(multi), 240, 'widestLine: 多行取最宽行，不用累加值');

  // tagName 大写（某些宿主）也要认，否则会退化成整行累加
  const upper = {
    children: [fakeRow(120, 'TSPAN'), fakeRow(200, 'TSPAN')],
    getComputedTextLength: () => 320,
  };
  eq(I.measureWidestLine(upper), 200, 'widestLine: tagName 大写仍按行取最大');

  // 一行都量不出来时退回整行
  const zero = {
    children: [fakeRow(0), fakeRow(0)],
    getComputedTextLength: () => 0,
  };
  eq(I.measureWidestLine(zero), 0, 'widestLine: 全 0 返回 0');
}

/* ------------------------------ 二次收敛 ------------------------------ */

function tTwoRounds() {
  // 第一轮重排后仍有偏差、但偏差在变小 → 允许第二轮
  let reads = 0;
  let builds = 0;
  const estSeq = [500, 800];
  const settled = I.calibrateSvg({}, {
    estWidths: [100],
    readActual: () => {
      reads++;
      return { widths: new Map([[0, 900]]), max: 900, count: 1 };
    },
    apply: () => true,                       // 跳过 DOM 解析，只验收敛逻辑
    rebuild: () => {
      const e = estSeq[builds];
      builds++;
      return { markup: '<svg/>', estWidths: [e] };
    },
  });

  eq(settled, true, 'two-round: 收敛后返回 true');
  eq(builds, I.MAX_REBUILDS, 'two-round: 重排次数不超过 MAX_REBUILDS');
  eq(I.MAX_REBUILDS, 2, 'two-round: 上限就是 2');
  ok(reads >= 2, 'two-round: 每轮重排后复测一次', String(reads));
}

function tStopWhenNotBetter() {
  // 重排后偏差没变小 → 立刻停，不做第二轮
  let builds = 0;
  I.calibrateSvg({}, {
    estWidths: [100],
    readActual: () => ({ widths: new Map([[0, 900]]), max: 900, count: 1 }),
    apply: () => true,
    rebuild: () => { builds++; return { markup: '<svg/>', estWidths: [100] }; },
  });
  eq(builds, 1, 'two-round: 偏差没变小就停，不来回抖');
}

function tConvergeOnFirstRound() {
  // 一轮就收敛，不该再来第二轮
  let reads = 0;
  let builds = 0;
  I.calibrateSvg({}, {
    estWidths: [100],
    readActual: () => {
      reads++;
      return { widths: new Map([[0, reads === 1 ? 900 : 300]]), max: 300, count: 1 };
    },
    apply: () => true,
    rebuild: () => { builds++; return { markup: '<svg/>', estWidths: [300] }; },
  });
  eq(builds, 1, 'two-round: 一轮收敛只重排一次');
  eq(reads, 2, 'two-round: 收敛时也只复测一次');
}

function tStaleGuard() {
  // fonts.ready 那类异步重试：调用方已经换过布局（代数变了）就不许再动
  let reads = 0;
  let builds = 0;
  const settled = I.calibrateSvg({}, {
    estWidths: [100],
    isStale: () => true,
    readActual: () => { reads++; return { widths: new Map([[0, 900]]), max: 900, count: 1 }; },
    apply: () => true,
    rebuild: () => { builds++; return { markup: '<svg/>', estWidths: [900] }; },
  });
  eq(settled, true, 'stale: 过期调用直接收工');
  eq(reads, 0, 'stale: 过期调用不去读宽度');
  eq(builds, 0, 'stale: 过期调用不重排（不再覆盖已修好的布局）');

  // 没过期时照常走
  let builds2 = 0;
  I.calibrateSvg({}, {
    estWidths: [100],
    isStale: () => false,
    readActual: () => ({ widths: new Map([[0, 900]]), max: 900, count: 1 }),
    apply: () => true,
    rebuild: () => { builds2++; return { markup: '<svg/>', estWidths: [900] }; },
  });
  eq(builds2, 1, 'stale: 没过期照常重排');
}

/* ------------------------------ 重排后的方框宽 ------------------------------ */

function tRewrapWidth() {
  // 同一个 cfg 连排多轮：下一轮拿到的实测值属于上一轮的切法。
  // 切点没变才能用它；切点变了（行数不同）拿它当宽度就会把方框撑成上一轮那么宽。
  const src = ['maxWidth: 50', 'box: 1', '- 长长长长长长长长长长长长', '  - 短'].join('\n');
  const cfg = I.parseSource(src);
  const per = (t) => String(t).length * 14;
  const base = Object.assign({}, LAYOUT_OPTS, { measureBold: per, measure: per });

  const first = I.buildSvg(cfg, base);
  const long1 = first.layout.nodes.find((n) => n.lineCount > 1);
  ok(long1, 'rewrap: 第一轮确实是多行');
  eq(long1.lineCount, 4, 'rewrap: 第一轮 3 字/行 → 4 行');
  eq(long1.textWidth, 42, 'rewrap: 第一轮宽度 = 3×14');

  // 真实渲染 20px/字：最宽行 = 3×20 = 60
  const actual = new Map();
  actual.set(long1.seq, 60);
  for (const n of first.layout.nodes) {
    if (n.seq !== long1.seq && n.text) actual.set(n.seq, String(n.text).length * 20);
  }

  // 第二轮：折行切点没变 → 用实测宽，方框装得下
  const second = I.buildSvg(cfg, Object.assign({}, base, {
    measure: I.calibratedMeasure(actual, per), splitRuns: false,
  }));
  const long2 = second.layout.nodes.find((n) => n.seq === long1.seq);
  eq(long2.lineCount, 4, 'rewrap: 第二轮折行没变');
  eq(long2.textWidth, 60, 'rewrap: 切点没变 → 以实测宽为准');

  // 第三轮：折行收窄（切点变了）→ 不能用上一轮的实测宽
  const third = I.buildSvg(cfg, Object.assign({}, base, {
    measure: I.calibratedMeasure(actual, per), splitRuns: false, maxWidth: 35,
  }));
  const long3 = third.layout.nodes.find((n) => n.seq === long1.seq);
  eq(long3.lineCount, 6, 'rewrap: 第三轮 2 字/行 → 6 行');
  eq(long3.textWidth, 28, 'rewrap: 切点变了不用上一轮的宽（否则会把框撑成 60）');
  eq(long3.bw, 28 + 2 * I.OPT.boxPadX, 'rewrap: 方框宽 = 本轮最宽行 + 2×boxPadX');
}

/* ------------------------------ 诊断 ------------------------------ */

function fakeText(seq, text, lineLens, rectWidth) {
  const kids = lineLens.map((len) => ({
    localName: 'tspan',
    tagName: 'tspan',
    hasAttribute: (a) => a === 'dy',
    getComputedTextLength: () => len,
  }));
  return {
    children: kids,
    textContent: text,
    previousElementSibling: rectWidth == null ? null : {
      localName: 'rect',
      tagName: 'rect',
      getAttribute: (k) => (k === 'width' ? String(rectWidth) : null),
    },
    getAttribute(k) {
      if (k === 'data-seq') return String(seq);
      if (k === 'class') return 'bm-text';
      return null;
    },
    getComputedTextLength: () => lineLens.reduce((a, b) => a + b, 0),
  };
}

function fakeSvg(texts) {
  return { querySelectorAll: () => texts };
}

function tCollectDiag() {
  eq(typeof I.collectWrapDiagnosis, 'function', 'diag: collectWrapDiagnosis 导出');
  const items = I.collectWrapDiagnosis(fakeSvg([
    fakeText(0, '转炉钢：碱性、酸性', [120.5, 240.25], 260.5),
    fakeText(1, '没有框', [80], null),
  ]), { estWidths: [230, 80] });

  eq(items.length, 2, 'diag: 收集到两个 text');
  eq(items[0].seq, 0, 'diag: 带出 data-seq');
  eq(items[0].text, '转炉钢：碱性、酸性', 'diag: 带出文字');
  eq(items[0].lineLens, [120.5, 240.25], 'diag: 逐行实测宽度');
  eq(items[0].rectWidth, 260.5, 'diag: 带出方框宽');
  eq(items[0].est, 230, 'diag: 带出估算宽度');
  eq(items[1].rectWidth, null, 'diag: 无框节点标记为 null');
}

function tFormatDiag() {
  eq(typeof I.formatWrapDiagnosis, 'function', 'diag: formatWrapDiagnosis 导出');
  const out = I.formatWrapDiagnosis(
    [{
      seq: 0,
      text: '转炉钢：碱性、酸性、顶吹转炉钢，这是同一行里很长的说明',
      lineLens: [259.36, 259.36, 20],
      rectWidth: 250,
      est: 252,
      isTitle: false,
    }],
    { fontSize: 19.95, fontFamily: 'sans-serif', maxWidth: 260, rebuilds: 1, settled: true },
    { where: 'note.md · 图 1', liveFontSize: 21 }
  );

  ok(clean(out), 'diag: 报告里没有 NaN/undefined');
  for (const key of ['# Brace Map 折行诊断', 'seq 0', '转炉钢', '行数：3',
    '259.36', '250', '252', 'maxWidth：260px', '重排次数：1']) {
    ok(out.indexOf(key) >= 0, 'diag: 报告包含「' + key + '」');
  }
  ok(out.indexOf('与布局字号不一致') >= 0, 'diag: 字号对不上时给出提示');
  ok(out.indexOf('撑破方框') >= 0, 'diag: 框装不下时给出判定');

  // 装得下的情况判成 OK
  const good = I.formatWrapDiagnosis(
    [{ seq: 3, text: '短', lineLens: [100], rectWidth: 120, est: 100, isTitle: false }],
    { fontSize: 19.95, boxPadX: 10, maxWidth: 260 },
    {}
  );
  ok(good.indexOf('判定：OK') >= 0, 'diag: 装得下判 OK');

  // 空表也要有可读输出
  const empty = I.formatWrapDiagnosis([], {}, {});
  ok(clean(empty) && empty.indexOf('没找到') >= 0, 'diag: 没有图时给空态说明');
}

/* ------------------------------ 登记 ------------------------------ */

suite('wrap-diag/font-probe', tMeasureContext);
suite('wrap-diag/widest-line', tWidestLine);
suite('wrap-diag/two-rounds', tTwoRounds);
suite('wrap-diag/stop-when-not-better', tStopWhenNotBetter);
suite('wrap-diag/converge-first-round', tConvergeOnFirstRound);
suite('wrap-diag/stale-guard', tStaleGuard);
suite('wrap-diag/stale-width', tRewrapWidth);
suite('wrap-diag/collect', tCollectDiag);
suite('wrap-diag/format', tFormatDiag);
