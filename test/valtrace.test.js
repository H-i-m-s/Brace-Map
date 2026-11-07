'use strict';

/* ============================================================
 * valtrace.test.js · valign 调用轨迹（只读取证层）
 *
 * 验的是「能否把一次调用说清楚」，不是布局本身：
 *   - 每次调用都留一条：序号 / 入口 / 退出分支 / 那一瞬间量到的 12 个数
 *   - 同一张图「先量到 0、后量到真值」的两次调用必须分开记、数值不同
 *     （真机上 A 图「记录里 imgH 0.00 从没被更新过」就是这个形状）
 *   - 每个提前返回的分支都有各自的代号，不会混成一句「没生效」
 *   - 按宿主分组，且分组键是宿主实例而不是页面下标
 *   - 现场快照脱离 applyValignLayout 独立量：从没被调用过的图也有值
 *   - 单次运行最多 400 条，超出从头截断
 *   - 轨迹本身不改任何样式、不在宿主上留字段
 * ============================================================ */

const { I, ok, eq, suite } = require('./framework');

/* ------------------------------ 假 DOM ------------------------------ */

function fakeClassList(names) {
  const list = names ? names.slice() : [];
  return {
    contains: (c) => list.indexOf(c) >= 0,
    add: (c) => { if (list.indexOf(c) < 0) list.push(c); },
    remove: (...cs) => {
      for (const c of cs) {
        const i = list.indexOf(c);
        if (i >= 0) list.splice(i, 1);
      }
    },
    _list: list,
  };
}

function fakeEl(names, h, top) {
  const box = {
    width: 100,
    height: h == null ? 0 : h,
    left: 0,
    top: top == null ? 0 : top,
    bottom: (top == null ? 0 : top) + (h == null ? 0 : h),
  };
  return {
    classList: fakeClassList(names),
    nextElementSibling: null,
    previousElementSibling: null,
    getBoundingClientRect: () => box,
    _box: box,
  };
}

function fakeChain(items) {
  const els = items.map((it) => {
    const el = fakeEl(it.cls, it.h, it.top);
    if (it.lh) withComputed(el, { lineHeight: it.lh, fontSize: it.fontSize || '30px' });
    return el;
  });
  for (let i = 0; i < els.length - 1; i++) {
    els[i].nextElementSibling = els[i + 1];
    els[i + 1].previousElementSibling = els[i];
  }
  return els.length ? els[0] : null;
}

function withComputed(el, values) {
  el.ownerDocument = {
    defaultView: {
      getComputedStyle: (target) => ({
        lineHeight: target === el && values.lineHeight ? values.lineHeight : 'normal',
        fontSize: target === el && values.fontSize ? values.fontSize : 'normal',
      }),
    },
  };
  return el;
}

/** 一行根节点文字：top / height 摆进页面 */
function rootText(top, h) {
  return fakeEl([], h, top);
}

/**
 * host → .cm-embed-block → .cm-content → .cm-scroller → .cm-editor
 * opts 里的 imgH / rootTexts 故意做成「调用时现读」，测试里改 opts 就等于改页面。
 */
function makeHost(opts) {
  const o = opts || {};
  const editor = { classList: fakeClassList(['cm-editor']), parentElement: null };
  const scroller = { classList: fakeClassList(['cm-scroller']), parentElement: editor };
  const content = { classList: fakeClassList(['cm-content']), parentElement: scroller };
  const embed = {
    classList: fakeClassList(['cm-embed-block']),
    parentElement: content,
    nextElementSibling: null,
    previousElementSibling: null,
  };
  const host = {
    style: {},
    classList: fakeClassList([]),
    parentElement: embed,
    isConnected: true,
    getBoundingClientRect: () => ({
      width: 300,
      height: o.imgH == null ? 0 : o.imgH,
      left: 0,
      top: o.imgTop == null ? 0 : o.imgTop,
    }),
    querySelectorAll: () => (o.rootTexts || []),
  };
  return { host, embed, content, scroller, editor, opts: o };
}

/** 一行的兄弟链：正文行高 48.29 */
function withLine(ctx) {
  ctx.embed.nextElementSibling = fakeChain([{ cls: ['cm-line'], h: 40, lh: '48.29px' }]);
  return ctx;
}

/** 临时把 global.document 换成一个只会回 .block-language-brace 的壳（算页面下标用） */
function withFakeDoc(hosts, fn) {
  const had = Object.prototype.hasOwnProperty.call(global, 'document');
  const prev = global.document;
  global.document = { querySelectorAll: () => hosts };
  try {
    return fn();
  } finally {
    if (had) global.document = prev;
    else delete global.document;
  }
}

function clearRetry(host) {
  try { I.clearValignRetries(host); } catch (e) { /* ignore */ }
}

/* ------------------------------ 核心场景：先 0，后变高 ------------------------------ */

/**
 * 图 A 的形状：调用那一刻宿主高 0、内部还没有根节点文字，
 * 之后图真的画出来了（高 169.79、根节点文字 40..64），观察器再调一次。
 */
function zeroThenGrow() {
  I.vtReset();
  const ctx = withLine(makeHost({ imgH: 0, imgTop: 0, rootTexts: [] }));
  withComputed(ctx.content, { lineHeight: '48.29px', fontSize: '30px' });
  const cfg = { float: 'right', valign: 'middle' };
  I.applyFloatLayout(ctx.host, cfg);                    // 先有 bm-floated

  const off1 = I.applyValignLayout(ctx.host, cfg, false, 'render');
  const rowsAfter1 = I.vtRows();

  ctx.opts.imgH = 169.79;                               // 图真的画出来了
  ctx.opts.rootTexts = [rootText(40, 24)];              // 根文字中心 52
  const off2 = I.applyValignLayout(ctx.host, cfg, true, 'observer');
  const rows = I.vtRows();

  return { ctx, cfg, off1, off2, rowsAfter1, rows };
}

function tTwoCallsRecorded() {
  const r = zeroThenGrow();

  eq(r.rowsAfter1.length, 1, 'valtrace: 第一次调用就留了一条（哪怕量到全 0）');
  eq(r.rows.length, 2, 'valtrace: 图变高后的第二次调用又留一条，不覆盖');
  eq([r.rows[0].n, r.rows[1].n], [1, 2], 'valtrace: 序号自增');

  eq(r.rows[0].exit, 'offset=0', 'valtrace: 第一次从「偏移为 0」分支返回');
  eq(r.rows[0].src, 'render', 'valtrace: 第一次记下入口 render');
  eq(r.rows[0].probe.hHost, 0, 'valtrace: 第一次现场量到宿主高 0');
  eq(r.rows[0].probe.hSvg, null, 'valtrace: 第一次没有 svg 可量');
  eq(r.rows[0].probe.svg, 'none', 'valtrace: 第一次 pickSvg 为空');
  eq(r.rows[0].probe.roots, 0, 'valtrace: 第一次根节点 0 个');
  ok(Number.isNaN(r.rows[0].probe.yTitle), 'valtrace: 第一次 yTitle 记成 NaN 而不是漏掉');
  eq(r.rows[0].probe.lineH, 48.29, 'valtrace: 第一次行高照样量得到（与真机 31.50 同形）');
  eq(r.rows[0].offset, 0, 'valtrace: 第一次 offset 记 0');
  eq(r.rows[0].wrote, false, 'valtrace: 第一次没写 margin-top');
  eq(r.off1, 0, 'valtrace: 第一次真的没写样式（返回值 0）');

  eq(r.rows[1].exit, 'write', 'valtrace: 第二次从「写了 margin-top」分支返回');
  eq(r.rows[1].src, 'observer', 'valtrace: 第二次记下入口 observer');
  eq(r.rows[1].probe.hHost, 169.79, 'valtrace: 第二次现场量到真图高 169.79');
  eq(r.rows[1].probe.roots, 1, 'valtrace: 第二次根节点 1 个');
  eq(r.rows[1].probe.yTitle, 52, 'valtrace: 第二次量到根文字中心 52');
  ok(Math.abs(r.rows[1].offset + 27.855) < 0.01,
    'valtrace: 第二次 offset = 48.29/2 − 52（约 −27.86）');
  eq(r.rows[1].wrote, true, 'valtrace: 第二次真的写了 margin-top');
  ok(r.off2 < 0, 'valtrace: 第二次返回值是负偏移');

  ok(r.rows[0].dt <= r.rows[1].dt, 'valtrace: 时间戳单调');
  eq(r.rows[0].tag, r.rows[1].tag, 'valtrace: 同一个宿主两次调用归到同一组');
  eq(r.rows[0].vid, r.rows[1].vid, 'valtrace: 同一个宿主实例号一致');
}

function tTraceTextDistinguishesCalls() {
  const r = zeroThenGrow();
  const text = I.formatValignTrace();
  ok(text.indexOf('hHost=0.00') >= 0, 'valtrace-text: 轨迹里能看到第一次的 0');
  ok(text.indexOf('hHost=169.79') >= 0, 'valtrace-text: 轨迹里也能看到第二次的真值');
  ok(text.indexOf('yTitle=NaN') >= 0, 'valtrace-text: NaN 原样写在文本里');
  ok(text.indexOf('→ offset=0') >= 0, 'valtrace-text: 退出分支写在每行里');
  ok(text.indexOf('→ write') >= 0, 'valtrace-text: 第二次的退出分支也在');
  ok(text.indexOf('render') >= 0 && text.indexOf('observer') >= 0, 'valtrace-text: 两个入口都记了');
  ok(text.indexOf('## 一、时序总览') >= 0, 'valtrace-text: 有按序号排的时序总览');
  ok(text.indexOf('## 二、按宿主分组') >= 0, 'valtrace-text: 有按宿主分组的一节');
  ok(text.indexOf('各分支出现次数') >= 0, 'valtrace-text: 分组里给出各分支次数');
  ok(r.rows.length === 2, 'valtrace-text: 前后仍是两条记录');
}

/* ------------------------------ 每个分支都要有代号 ------------------------------ */

function tExitCodes() {
  I.vtReset();
  const cfg = { float: 'right', valign: 'top' };

  I.applyValignLayout(null, cfg);                          // !host
  I.applyValignLayout({ style: {} }, null);                // !cfg
  const c = withLine(makeHost({ imgH: 100, rootTexts: [] }));
  withComputed(c.content, { lineHeight: '48.29px', fontSize: '30px' });

  I.applyValignLayout(c.host, { float: 'center', valign: 'top' });   // float!=lr
  I.applyValignLayout(c.host, cfg);                                  // !bm-floated
  c.host.classList.add('bm-floated');
  c.host.isConnected = false;
  I.applyValignLayout(c.host, cfg, false, 'render');                 // !inEditor
  clearRetry(c.host);
  c.host.isConnected = true;

  const rows = I.vtRows();
  const exits = rows.map((x) => x.exit);
  eq(exits, ['!host', '!cfg', 'float!=lr', '!bm-floated', '!inEditor'],
    'valtrace-exit: 五个提前返回分支各有代号');
  ok(rows[4].probe.conn === false, 'valtrace-exit: !inEditor 那条记下了 isConnected 为假');
  ok(rows[2].probe.floated === false, 'valtrace-exit: float!=lr 那条记下没 bm-floated');
}

function tEntryNames() {
  I.vtReset();
  const c = withLine(makeHost({ imgH: 151, rootTexts: [rootText(60, 30)] }));
  withComputed(c.content, { lineHeight: '48.29px', fontSize: '30px' });
  const cfg = { float: 'right', valign: 'top' };
  I.applyFloatLayout(c.host, cfg);

  I.applyValignLayout(c.host, cfg, false, 'render');
  I.applyValignLayout(c.host, cfg, false, 'reapply');
  I.applyValignLayout(c.host, cfg, true, 'retry');
  I.applyValignLayout(c.host, cfg, true, 'observer');
  I.applyValignLayout(c.host, cfg);                      // 不传：other
  const srcs = I.vtRows().map((x) => x.src);
  eq(srcs, ['render', 'reapply', 'retry', 'observer', 'other'],
    'valtrace-src: 四个入口加兜底 other 都记得下来');
}

/* ------------------------------ 分组 / 现场快照 ------------------------------ */

function tGroupAndSnapshot() {
  I.vtReset();

  /* 图 1：量到 0 的那种（有记录、记录里全 0） */
  const a = withLine(makeHost({ imgH: 0, rootTexts: [] }));
  withComputed(a.content, { lineHeight: '31.5px', fontSize: '30px' });
  /* 图 2：压根没被 applyValignLayout 碰过，但现场量得到真值 */
  const b = withLine(makeHost({ imgH: 169.79, imgTop: 0, rootTexts: [rootText(79.9, 24)] }));
  withComputed(b.content, { lineHeight: '31.5px', fontSize: '30px' });
  b.host.classList.add('bm-floated');
  b.host.__bmCfg = { float: 'right', valign: 'middle' };

  /* 页面上下文（算 .block-language-brace 下标）在整段里都在：真机上 document 一直都在 */
  const { traceText, snapText, doc, items } = withFakeDoc([a.host, b.host], () => {
    const cfgA = { float: 'right', valign: 'middle' };
    I.applyFloatLayout(a.host, cfgA);
    I.applyValignLayout(a.host, cfgA, false, 'render');

    const list = [
      {
        host: a.host,
        probe: I.valignProbe(a.host),
        tag: I.vtHostTag(a.host),
        where: '页面第 1 个 .block-language-brace',
        state: {
          hasCfg: true,
          hasFloat: false,
          hasInfo: true,
          infoText: 'imgH 0.00',
          obs: true,
          fired: 2,
          retry: false,
        },
      },
      {
        host: b.host,
        probe: I.valignProbe(b.host),
        tag: I.vtHostTag(b.host),
        where: '页面第 2 个 .block-language-brace',
        state: { hasCfg: true, hasFloat: true, hasInfo: false, infoText: '', obs: false, fired: 0, retry: false },
      },
    ];
    return {
      traceText: I.formatValignTrace(),
      snapText: I.formatValignSnapshot(list),
      doc: I.formatValignDoc(list),
      items: list,
    };
  });

  ok(traceText.indexOf('图1#v1') >= 0, 'valtrace-group: 分组键带页面下标（图1）');
  ok(traceText.indexOf('图2') < 0, 'valtrace-group: 没被调用过的图不会出现在轨迹里');
  eq(I.vtRows().length, 1, 'valtrace-group: 轨迹只有图 1 那条');

  ok(snapText.indexOf('图1#v1') >= 0 && snapText.indexOf('图2#v2') >= 0,
    'valtrace-snap: 现场快照两张图都在（不管有没有被调用过）');
  ok(snapText.indexOf('| 7 `elHeight(host)` | 0.00 |') >= 0,
    'valtrace-snap: 图 1 现场量到的宿主高是 0.00');
  ok(snapText.indexOf('| 7 `elHeight(host)` | 169.79 |') >= 0,
    'valtrace-snap: 图 2 现场量到的宿主高是 169.79');
  ok(snapText.indexOf('| 11 `measureTitleCenter(host)` | NaN |') >= 0,
    'valtrace-snap: 图 1 的 yTitle 现场也是 NaN');
  ok(snapText.indexOf('量到图高 0') >= 0, 'valtrace-snap: 图 1 的现场结论是「量到图高 0」');
  ok(snapText.indexOf('__bmValignInfo') >= 0, 'valtrace-snap: 快照列出 valign 记录状态');
  ok(snapText.indexOf('已挂，已触发 2 次') >= 0, 'valtrace-snap: 快照记下观察器触发次数');
  eq(items.length, 2, 'valtrace-snap: 两图各一条快照');

  ok(doc.indexOf('## 一、时序总览') >= 0 && doc.indexOf('## 三、现场快照') >= 0,
    'valtrace-doc: 一份文档里两节都在');
}

/* ------------------------------ 上限与截断 ------------------------------ */

function tCap() {
  I.vtReset();
  const host = makeHost({ imgH: 10, rootTexts: [] }).host;
  for (let i = 0; i < 450; i++) {
    I.vtRecord({ src: 'retry', exit: 'offset=0', host, probe: { hHost: i }, offset: 0, wrote: false });
  }
  eq(I.vtCount(), I.VT_MAX_ROWS, 'valtrace-cap: 单次运行最多 400 条');
  const rows = I.vtRows();
  eq(rows[0].n, 51, 'valtrace-cap: 超出后从头截断，留下最新的 400 条');
  eq(rows[rows.length - 1].n, 450, 'valtrace-cap: 最后一条序号是 450');
  ok(rows[0].probe.hHost === 50, 'valtrace-cap: 被留下的第一条就是第 51 次调用的内容');
}

/* ------------------------------ 只读性 ------------------------------ */

function tReadOnly() {
  I.vtReset();
  const c = withLine(makeHost({ imgH: 151, rootTexts: [rootText(60, 30)] }));
  withComputed(c.content, { lineHeight: '48.29px', fontSize: '30px' });
  const cfg = { float: 'right', valign: 'top' };

  /* 第一步：只有 float!=lr 那种「一个样式都不写」的调用 */
  const before = Object.keys(c.host.style).length;
  I.applyValignLayout(c.host, { float: 'center', valign: 'top' });
  eq(Object.keys(c.host.style).length, before, 'valtrace-readonly: 记一条轨迹不写任何样式');
  eq(Object.keys(c.host.style).length, 0, 'valtrace-readonly: 假宿主上确实一个样式都没有');

  /* 第二步：轨迹不能往宿主上挂字段（宿主身份走 WeakMap） */
  const keys = Object.keys(c.host);
  const traceKeys = keys.filter((k) => /vtrace|valtrace|__bmValignTrace/i.test(k));
  eq(traceKeys, [], 'valtrace-readonly: 宿主上没有轨迹留下的字段');

  /* 第三步：反复生成文本不会多出记录（纯函数） */
  const n = I.vtCount();
  const t1 = I.formatValignTrace();
  const len1 = t1.length;
  I.formatValignTrace();
  eq(I.vtCount(), n, 'valtrace-readonly: 反复生成文本不会多出记录');
  eq(I.formatValignTrace().length, len1, 'valtrace-readonly: 同一份缓冲生成同样长度的文本');
  ok(t1.length > 0, 'valtrace-readonly: 文本非空');
}

/* ------------------------------ 登记 ------------------------------ */

suite('valtrace/two-calls', tTwoCallsRecorded);
suite('valtrace/trace-text', tTraceTextDistinguishesCalls);
suite('valtrace/exit-codes', tExitCodes);
suite('valtrace/src-names', tEntryNames);
suite('valtrace/group-snapshot', tGroupAndSnapshot);
suite('valtrace/cap', tCap);
suite('valtrace/read-only', tReadOnly);
