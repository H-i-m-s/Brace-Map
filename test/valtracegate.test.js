'use strict';

/* ============================================================
 * valtracegate.test.js · 轨迹的电源开关
 *
 * 要证的三件事：
 *   1) 关着的时候一条都不记（三个缓冲都空）
 *   2) 关着的时候不做任何诊断用的 DOM 测量 —— 用计数桩把
 *      getBoundingClientRect / getComputedStyle / querySelector(All) / closest
 *      全数一遍，和「同一段代码、同样的页面、开着」逐项对账
 *   3) 开着的时侯行为与降级之前完全一致（出口、字段、文本都不变），
 *      而导出命令会把开关关回去
 *
 * 计数对账的两种口径：
 *   - applyValignLayout：开着比关着多出来的，必须恰好等于 valignProbe 自己的成本
 *   - attachFloatWrap：开着比关着多出来的，必须恰好等于 attachEnv × 每条记录
 *     （attachEnv = isLivePreview 两次 closest + 两次 closestOf = 4 次）
 * 这两种都是「多出来的部分完全可归因」，而不是拍一个总数。
 * ============================================================ */

const { I, Plugin, ok, eq, suite } = require('./framework');

/* ------------------------------ 门的开关 ------------------------------ */

/** 临时把门关上跑一段，结束后恢复原状态（后面几组套件还要用轨迹） */
function gateOff(fn) {
  const was = I.valtrace.isOn();
  I.valtrace.setOn(false);
  try {
    return fn();
  } finally {
    I.valtrace.setOn(was);
  }
}

/* ------------------------------ 计数桩 ------------------------------ */

const COUNT_KEYS = ['gbcr', 'gcs', 'qsa', 'qs', 'closest'];

function newCounters() {
  return { gbcr: 0, gcs: 0, qsa: 0, qs: 0, closest: 0 };
}

function snapCounters(c) {
  const out = {};
  for (const k of COUNT_KEYS) out[k] = c[k];
  return out;
}

function sumCounters(c) {
  let n = 0;
  for (const k of COUNT_KEYS) n += c[k];
  return n;
}

const BASE_CS = {
  lineHeight: 'normal',
  fontSize: '30px',
  position: 'static',
  display: 'block',
  height: 'auto',
  float: 'none',
  overflow: 'visible',
  contain: 'none',
  paddingLeft: '0px',
  paddingRight: '0px',
  marginLeft: '0px',
  marginRight: '0px',
};

/** 一套带计数的假 DOM：每个元素自己记 rect 次数，computed 走 defaultView */
function makeDom() {
  const C = newCounters();
  const view = {
    getComputedStyle(el) {
      C.gcs++;
      return Object.assign({}, BASE_CS, (el && el.__cs) || null);
    },
  };
  const doc = { defaultView: view };

  const mk = (cls, h, top, cs) => {
    const el = {
      style: {},
      tagName: 'DIV',
      ownerDocument: doc,
      isConnected: true,
      classList: {
        contains: (c) => (cls || []).indexOf(c) >= 0,
        add(c) { if (cls && cls.indexOf(c) < 0) cls.push(c); },
        remove(...cs2) { if (cls) for (const c of cs2) { const i = cls.indexOf(c); if (i >= 0) cls.splice(i, 1); } },
      },
      parentElement: null,
      nextElementSibling: null,
      previousElementSibling: null,
      childElementCount: 0,
      clientWidth: 800,
      clientLeft: 0,
      clientTop: 0,
      __cs: cs || null,
      __box: { left: 0, top: top || 0, width: 300, height: h || 0 },
      getBoundingClientRect() {
        C.gbcr++;
        const b = el.__box;
        return {
          left: b.left, top: b.top, width: b.width, height: b.height,
          right: b.left + b.width, bottom: b.top + b.height,
        };
      },
      querySelectorAll() { C.qsa++; return el.__qall || []; },
      querySelector() { C.qs++; return el.__qs || null; },
      closest(sel) { C.closest++; return el.__closestFn ? el.__closestFn(sel) : null; },
    };
    if (cls) el.__cls = cls;
    return el;
  };

  return { C, doc, mk };
}

/**
 * 编辑模式场景：host → .cm-embed-block → .cm-content → .cm-scroller → .cm-editor，
 * host 里有一个根节点文字，宿主后面的 .cm-line 给出 48.29 的行高。
 * 与 valtrace.test.js 里那套同形，只是每个元素都带计数。
 */
function editorScenario() {
  const { C, mk } = makeDom();
  const editor = mk(['cm-editor'], 0, 0);
  const scroller = mk(['cm-scroller'], 0, 0);
  const content = mk(['cm-content'], 0, 0);
  const embed = mk(['cm-embed-block'], 0, 0);
  const line = mk(['cm-line'], 40, 0, { lineHeight: '48.29px', fontSize: '30px' });
  const rootText = mk([], 24, 60);
  const host = mk([], 151, 0);

  scroller.parentElement = editor;
  content.parentElement = scroller;
  embed.parentElement = content;
  host.parentElement = embed;
  embed.nextElementSibling = line;
  line.previousElementSibling = embed;
  host.__qall = [rootText];
  /* 在编辑区里：closest('.cm-content') 有值、closest('.cm-editor') 没有（宿主不是编辑器根） */
  host.__closestFn = (sel) => (sel === '.cm-content' ? content : null);

  return { C, host, content, line, rootText };
}

/**
 * 阅读视图场景：sizer → host → 后面一段正文。
 * host 不在 .cm-content 里（closest 全返回 null），所以 floatify / attachFloatWrap 会走阅读视图那条路。
 */
function readerScenario() {
  const { C, mk } = makeDom();
  const sizer = mk(['markdown-preview-sizer'], 2000, 0);
  const host = mk([], 169.79, 100);
  const para = mk([], 100, 200, { lineHeight: '31.5px' });
  const rootText = mk([], 24, 179.9);

  host.parentElement = sizer;
  host.nextElementSibling = para;
  para.previousElementSibling = host;
  host.__qall = [rootText];

  return { C, host, para, sizer, rootText };
}

const CFG = { float: 'right', valign: 'top' };

/* --------------------------- 1) 关着就不记 --------------------------- */

function tGateOffRecordsNothing() {
  const out = gateOff(() => {
    I.vtReset();
    const s = editorScenario();
    s.host.classList.add('bm-floated');
    I.applyValignLayout(s.host, CFG, false, 'render');

    const early = editorScenario();                 // 没有 bm-floated：早退分支
    I.applyValignLayout(early.host, CFG, false, 'render');

    const rd = readerScenario();
    I.floatify(rd.host, { float: 'right', valign: 'middle' });

    /* 直连 record* 也不该记（防线第二层：调用点漏了守卫也记不进去） */
    I.vtRecord({ src: 'render', exit: 'write', host: s.host, probe: null });
    I.valtrace.recordFloat({ exit: 'ok', host: rd.host });
    I.valtrace.recordAttach({ exit: 'enter', host: rd.host });

    return {
      rows: I.vtRows().length,
      floats: I.vtFloatRows().length,
      attaches: I.vtAttachRows().length,
    };
  });

  eq(out.rows, 0, 'gate-off: 关着时 applyValignLayout 一条轨迹都不留');
  eq(out.floats, 0, 'gate-off: 关着时 floatify 一条轨迹都不留');
  eq(out.attaches, 0, 'gate-off: 关着时 attachFloatWrap 一条轨迹都不留');
}

/** 关着的时候导出文本也不该有记录（只有说明文字） */
function tGateOffTextEmpty() {
  const text = gateOff(() => {
    I.vtReset();
    const s = editorScenario();
    s.host.classList.add('bm-floated');
    I.applyValignLayout(s.host, CFG, false, 'render');
    return [I.formatValignTrace(), I.formatFloatTrace(), I.formatAttachTrace()].join('\n');
  });
  ok(text.indexOf('（没有记录') >= 0, 'gate-off: 轨迹文本里写着「没有记录」');
  ok(text.indexOf('轨迹条数：0') >= 0, 'gate-off: 条数是 0');
}

/* --------------------------- 2) 关着就不量 --------------------------- */

function tNoMeasurementWhenOff() {
  /* 2a 早退分支：关着时一次调用应当零次 DOM 查询 */
  const offEarly = gateOff(() => {
    const s = editorScenario();
    I.vtReset();
    I.applyValignLayout(s.host, CFG, false, 'render');   // 没有 bm-floated：一行测量都不该做
    return { c: snapCounters(s.C), rows: I.vtRows().length };
  });
  eq(offEarly.rows, 0, 'gate-measure: 早退分支关着时不记录');
  eq([offEarly.c.gbcr, offEarly.c.gcs, offEarly.c.qsa, offEarly.c.qs, offEarly.c.closest],
    [0, 0, 0, 0, 0], 'gate-measure: 早退分支关着时零次 DOM 查询');

  /* 同一个分支开着：valignProbe 会量，次数必然不为 0（证明上面的 0 有意义） */
  const onEarly = (() => {
    const s = editorScenario();
    I.vtReset();
    I.applyValignLayout(s.host, CFG, false, 'render');
    return { c: snapCounters(s.C), rows: I.vtRows().length };
  })();
  eq(onEarly.rows, 1, 'gate-measure: 同一分支开着时留一条');
  ok(sumCounters(onEarly.c) > 0, 'gate-measure: 开着时同一分支确实做了测量',
    JSON.stringify(onEarly.c));

  /* 2b 完整走完的分支：开着的增量必须恰好等于 valignProbe 自己的成本 */
  const run = (gate) => {
    const s = editorScenario();
    s.host.classList.add('bm-floated');
    I.vtReset();
    const go = () => {
      I.applyValignLayout(s.host, CFG, false, 'render');
      return { c: snapCounters(s.C), rows: I.vtRows().length, exits: I.vtRows().map((r) => r.exit) };
    };
    return gate ? go() : gateOff(go);
  };
  const offWrite = run(false);
  const onWrite = run(true);
  eq(offWrite.rows, 0, 'gate-measure: 写入分支关着时不记录');
  eq(onWrite.rows, 1, 'gate-measure: 写入分支开着时留一条');
  eq(onWrite.exits, ['write'], 'gate-measure: 开着时出口还是 write（行为没变）');

  /* valignProbe 单次成本：拿一个一模一样的宿主单独量一遍 */
  const probeRun = (() => {
    const s = editorScenario();
    I.valignProbe(s.host);
    return snapCounters(s.C);
  })();
  ok(sumCounters(probeRun) > 0, 'gate-measure: valignProbe 自己确实要测量',
    JSON.stringify(probeRun));
  for (const k of COUNT_KEYS) {
    eq(onWrite.c[k], offWrite.c[k] + probeRun[k],
      'gate-measure: ' + k + ' 的增量恰好是 valignProbe 的成本');
  }

  /* 2c floatify：轨迹本身不做 DOM 测量（值都是算好传进去的），关开应当一样 */
  const runFloat = (gate) => {
    const s = readerScenario();
    const go = () => {
      I.floatify(s.host, { float: 'right', valign: 'middle' });
      return { c: snapCounters(s.C), rows: I.vtFloatRows().length };
    };
    I.vtReset();
    return gate ? go() : gateOff(go);
  };
  const offF = runFloat(false);
  const onF = runFloat(true);
  eq(offF.rows, 0, 'gate-measure: floatify 关着时不记录');
  eq(onF.rows, 1, 'gate-measure: floatify 开着时留一条');
  for (const k of COUNT_KEYS) {
    eq(onF.c[k], offF.c[k], 'gate-measure: floatify 的 ' + k + ' 关开一致');
  }

  /* 2d attachFloatWrap：多出来的必须是 attachEnv（每条记录 4 次 closest） */
  const runAttach = (gate) => {
    const s = readerScenario();
    const go = () => {
      const ctl = I.attachFloatWrap(s.host, { float: 'right', valign: 'middle' });
      if (ctl && ctl.dispose) ctl.dispose('test');
      return { c: snapCounters(s.C), rows: I.vtAttachRows().length };
    };
    I.vtReset();
    return gate ? go() : gateOff(go);
  };
  const offA = runAttach(false);
  const onA = runAttach(true);
  eq(offA.rows, 0, 'gate-measure: attachFloatWrap 关着时不记录');
  ok(onA.rows > 0, 'gate-measure: attachFloatWrap 开着时留了记录', onA.rows);
  eq(onA.c.closest - offA.c.closest, 4 * onA.rows,
    'gate-measure: closest 的增量 = attachEnv（4 次）× 记录条数');
}

/* --------------------------- 3) 开着与降级前一致 --------------------------- */

function tGateOnSameAsBefore() {
  const rows = (() => {
    I.vtReset();
    const s = editorScenario();
    s.host.classList.add('bm-floated');
    I.applyValignLayout(s.host, CFG, false, 'render');
    return I.vtRows();
  })();
  eq(rows.length, 1, 'gate-on: 一次调用一条');
  eq(rows[0].exit, 'write', 'gate-on: 出口代号照旧');
  eq(rows[0].src, 'render', 'gate-on: 入口照旧');
  ok(rows[0].probe && rows[0].probe.hHost === 151, 'gate-on: 现场量到的宿主高照旧在记录里',
    JSON.stringify(rows[0].probe && rows[0].probe.hHost));
  ok(I.formatValignTrace().indexOf('## 一、时序总览') >= 0, 'gate-on: 文本六节结构不变');
  ok(I.formatValignDoc([]).indexOf('## 三、现场快照') >= 0, 'gate-on: 文档结构不变');
}

/* --------------------------- 4) 命令：开 → 导出 → 自动关 --------------------------- */

async function tCommands() {
  /* 自测里 require('obsidian') 是个空壳，Notice 不存在（`new Notice` 会被外面的
   * try/catch 吞掉）。所以状态提示统一从 console.log 那一路验 —— 两者写的是同一句话。 */
  const prevLog = console.log;
  const lines = [];
  console.log = (...a) => { lines.push(a.join(' ')); };

  const plugin = new Plugin();
  let written = null;
  plugin.app = {
    vault: { adapter: { write: (path, text) => { written = { path, text }; return Promise.resolve(); } } },
  };

  try {
    /* 先塞一条旧记录：开始记录应当把缓冲清空（一段就是一段） */
    I.vtReset();
    I.vtRecord({ src: 'render', exit: 'write', host: editorScenario().host, probe: null });
    eq(I.vtCount(), 1, 'gate-cmd: 预置一条旧记录');

    const on = plugin.startValignTrace();
    eq(on, true, 'gate-cmd: 开始记录返回 true');
    eq(I.valtrace.isOn(), true, 'gate-cmd: 开关真的开了');
    eq(I.vtCount(), 0, 'gate-cmd: 开记录时把旧缓冲清空');
    ok(lines.some((m) => m.indexOf('已开始记录') >= 0), 'gate-cmd: 开始记录有提示', lines.join(' | '));

    /* 开记录之后真的会记 */
    const s = editorScenario();
    s.host.classList.add('bm-floated');
    I.applyValignLayout(s.host, CFG, false, 'render');
    eq(I.vtCount(), 1, 'gate-cmd: 开着的时候照常记录');

    lines.length = 0;
    const text = await plugin.exportValignTrace();
    ok(!!written, 'gate-cmd: 导出真的写了文件');
    eq(written.path, 'brace-map-valign-trace.md', 'gate-cmd: 文件名没变');
    ok(written.text.indexOf('## 一、时序总览') >= 0, 'gate-cmd: 导出内容有轨迹节');
    ok(text === written.text, 'gate-cmd: 返回值就是写进去的正文');
    eq(I.valtrace.isOn(), false, 'gate-cmd: 导出后自动停止记录');
    ok(lines.some((m) => m.indexOf('记录已停止') >= 0), 'gate-cmd: 有「已停止记录」提示', lines.join(' | '));

    /* 关掉之后再调用：一条都不多 */
    I.vtReset();
    I.applyValignLayout(editorScenario().host, CFG, false, 'render');
    eq(I.vtCount(), 0, 'gate-cmd: 导出之后又回到零开销状态');

    /* 没开记录就导出：文件照写（现场快照与轨迹无关），但要提示怎么拿到轨迹 */
    lines.length = 0;
    const text2 = await plugin.exportValignTrace();
    ok(!!written && written.text === text2, 'gate-cmd: 没开记录也能导出');
    ok(lines.some((m) => m.indexOf('记录没开') >= 0), 'gate-cmd: 没开记录时给出提示',
      lines.join(' | '));
    eq(I.valtrace.isOn(), false, 'gate-cmd: 没开记录导出后仍然是关的');
  } finally {
    console.log = prevLog;
    I.valtrace.setOn(true);                 // 恢复给后面的套件
  }
}

/* --------------------------- 5) 其它口子 --------------------------- */

function tGateDetails() {
  /* 清缓冲不该顺手改开关 */
  gateOff(() => {
    I.vtReset();
    eq(I.valtrace.isOn(), false, 'gate-misc: vtReset 不会把门打开');
  });
  I.vtReset();
  eq(I.valtrace.isOn(), true, 'gate-misc: 恢复之后门还是开的（清缓冲不影响开关）');

  /* 开过记录这件事要留痕（导出命令用它决定提示哪一句） */
  ok(typeof I.valtrace.wasEverOn() === 'boolean', 'gate-misc: wasEverOn 是个布尔');

  /* setOn 返回真实状态，非布尔值按真假转换 */
  eq(I.valtrace.setOn(1), true, 'gate-misc: setOn(1) → true');
  eq(I.valtrace.setOn(0), false, 'gate-misc: setOn(0) → false');
  I.valtrace.setOn(true);
  eq(I.valtrace.isOn(), true, 'gate-misc: setOn(true) 之后是开的');

  /* 关着时诊断文本照样能生成（不依赖缓冲） */
  const text = gateOff(() => I.formatValignDoc([]));
  ok(text.length > 0, 'gate-misc: 关着也能生成文档骨架');
  ok(text.indexOf('## 三、现场快照') >= 0, 'gate-misc: 六节结构在');
}

/* ------------------------------ 登记 ------------------------------ */

suite('valtrace-gate/records-nothing', tGateOffRecordsNothing);
suite('valtrace-gate/text-empty', tGateOffTextEmpty);
suite('valtrace-gate/no-measurement', tNoMeasurementWhenOff);
suite('valtrace-gate/on-same-as-before', tGateOnSameAsBefore);
suite('valtrace-gate/commands', tCommands);
suite('valtrace-gate/misc', tGateDetails);
