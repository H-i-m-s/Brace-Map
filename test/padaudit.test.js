'use strict';

/* ============================================================
 * padaudit.test.js · 留白落地诊断（lp.padAudit / lp.padTarget）
 *
 * 现场症状：算出来的留白是对的（pads=2），但写的时候判成「已达标」（styles=0），
 * 文字实际还是整宽压在图上。两种可能必须能分辨：
 *   A 值不在元素上（账本 entry.written 说写过，元素行内却是空的）
 *   B 值在元素上，但没作用到文字宽度（固定 width / box-sizing / 不折行）
 *
 * 这里验的就是新埋的这两条记录能把 A / B / ok 分开，且任何一条诊断抛错
 * 都不影响留白本身被写上。
 * ============================================================ */

const { I, ok, eq, suite } = require('./framework');

/* ------------------------------ 假 DOM ------------------------------ */

function styleObj(init) {
  const s = Object.assign({}, init || {});
  s.removeProperty = (p) => {
    delete s[p.replace(/-([a-z])/g, (m, c) => c.toUpperCase())];
  };
  return s;
}

function fakeEl(classes, h, rect, init) {
  const cls = classes || [];
  const el = {
    style: styleObj(init),
    classList: { contains: (c) => cls.indexOf(c) >= 0 },
    parentElement: null,
    nextElementSibling: null,
    isConnected: true,
    offsetHeight: h || 0,
    clientWidth: 820,
    clientLeft: 0,
    clientTop: 0,
  };
  const r = rect || { top: 0, left: 0, width: 820, height: h || 0, right: 820, bottom: h || 0 };
  el.getBoundingClientRect = () => r;
  return el;
}

function linkChain(list) {
  for (let i = 0; i + 1 < list.length; i++) list[i].nextElementSibling = list[i + 1];
  return list;
}

/**
 * 复刻老结构：.cm-content > .cm-line > .cm-embed-block > host，
 * widget 那行后面接三行 .cm-line。图贴右侧（嵌入块 rect.left = 623.5），与现场日志一致。
 *
 * 绝对定位 + 逐行留白这套现在只服务老结构（新结构的 direct-embed 走纯 CSS float），
 * 所以诊断也只在这里跑。
 */
function tree(opts) {
  const o = opts || {};
  const content = fakeEl(['cm-content'], 0,
    { top: 0, left: 0, width: 940, height: 2000, right: 940, bottom: 2000 });
  content.clientWidth = 940;

  const widgetLine = fakeEl(['cm-line'], 0,
    { top: 177.2, left: 0, width: 940, height: 0, right: 940, bottom: 177.2 });
  widgetLine.className = 'cm-line';
  widgetLine.parentElement = content;

  const embedH = o.embedH == null ? 190.8 : o.embedH;
  const embed = fakeEl(['cm-embed-block'], embedH,
    { top: 177.2, left: 623.5, width: 300, height: embedH, right: 923.5, bottom: 177.2 + embedH });
  embed.className = 'cm-embed-block markdown-rendered';
  embed.parentElement = widgetLine;

  const host = fakeEl([], embedH,
    { top: 177.2, left: 623.5, width: 300, height: embedH, right: 923.5, bottom: 177.2 + embedH });
  host.parentElement = embed;

  const svg = fakeEl(['brace-map-svg'], embedH,
    { top: 177.2, left: 623.5, width: 300, height: embedH, right: 923.5, bottom: 177.2 + embedH });

  const heights = o.lineHeights || [100, 100, 100];
  const lines = heights.map((h, i) => {
    const el = fakeEl(['cm-line'], h,
      { top: 177.2 + i * h, left: 0, width: 940, height: h, right: 940, bottom: 177.2 + (i + 1) * h });
    el.className = 'cm-line';
    return el;
  });
  linkChain(lines);
  widgetLine.nextElementSibling = lines[0] || null;

  return { content, line: widgetLine, embed, host, svg, lines };
}

/** 给元素装一个假 Range：文字右边界固定为 right（单位 px） */
function withRange(el, right, left) {
  const rect = { left: left == null ? 0 : left, right, top: 0, bottom: 20, width: right, height: 20 };
  el.ownerDocument = {
    createRange: () => ({
      selectNodeContents() {},
      getClientRects: () => [rect],
    }),
  };
  return el;
}

/** 取缓冲区里指定点名的记录 */
function points(name) {
  const text = I.dbgText();
  if (!text) return [];
  return text.split('\n').filter(Boolean)
    .map((s) => JSON.parse(s))
    .filter((r) => r.p === name);
}

function lastTarget() {
  const all = points('lp.padTarget');
  return all.length ? all[all.length - 1] : null;
}

/* ------------------------------ 用例 ------------------------------ */

function tAuditShape() {
  I.flushLivePreviewFloats();
  I.dbgReset();
  const t = tree();
  const ctl = I.attachLivePreviewFloat(t.host, { float: 'right' }, { svg: t.svg });
  ok(!!ctl, 'pad-audit: 挂上');

  const audit = points('lp.padAudit');
  ok(audit.length >= 1, 'pad-audit: 有留白目标就记一条汇总');
  eq(audit[0].pads, 2, 'pad-audit: 汇总里的 pads 数与本轮留白行一致');
  eq(audit[0].imgs, 1, 'pad-audit: 记下一张浮动图');
  eq(audit[0].imgLefts, [623.5], 'pad-audit: 图的 left 原样落进日志');
  eq(audit[0].contentW, 940, 'pad-audit: 记下正文列宽便于对照');

  const targets = points('lp.padTarget');
  eq(targets.length, 2, 'pad-audit: 每个留白目标一行');
  const rec = lastTarget();
  ok(typeof rec.cls === 'string' && rec.cls.indexOf('cm-line') >= 0, 'pad-audit: 带上 className');
  eq(rec.connected, true, 'pad-audit: 记下元素还在不在文档里');
  eq(rec.inlineR, '316px', 'pad-audit: 行内 paddingRight 是写的那个值');
  eq(rec.targetR, 316, 'pad-audit: 目标值');
  eq(rec.ledgerR.inLedger, true, 'pad-audit: 记下元素在不在账本里');
  eq(rec.ledgerR.written, '316px', 'pad-audit: 账本记的目标值');
  eq(rec.ledgerR.base, 0, 'pad-audit: entry.base 原样落盘');
  eq(rec.expectR.verdict, 'wrote-ok', 'pad-audit: 本轮写了且值在元素上');
  eq(rec.covered, null, 'pad-audit: 没有 Range 时覆盖判定是 null');
  eq(rec.diagnosis, '?', 'pad-audit: 量不到文字边界就不下结论');

  ctl.dispose();
  I.flushLivePreviewFloats();
}

function tAuditSkippedOk() {
  I.flushLivePreviewFloats();
  const t = tree();
  const ctl = I.attachLivePreviewFloat(t.host, { float: 'right' }, { svg: t.svg });
  I.dbgReset();
  ctl.update();                                  // 第二轮：值没变 → 差异写入跳过

  const rec = lastTarget();
  eq(rec.expectR.skipped, true, 'pad-skip: 第二轮判成「已达标」');
  eq(rec.expectR.readFrom, 'ledger.written', 'pad-skip: 判定依据是账本值，不是 computed');
  eq(rec.expectR.readValue, '316px', 'pad-skip: 判定时读到的值');
  eq(rec.expectR.inlineNow, '316px', 'pad-skip: 元素上确实有值');
  eq(rec.expectR.verdict, 'skipped-ok', 'pad-skip: 跳过但值在元素上');

  ctl.dispose();
  I.flushLivePreviewFloats();
}

function tAuditCaseA() {
  // A：账本以为写过，元素的行内值被抹掉了（CM6 / 主题重写 style 属性）
  I.flushLivePreviewFloats();
  const t = tree();
  const ctl = I.attachLivePreviewFloat(t.host, { float: 'right' }, { svg: t.svg });
  eq(t.lines[0].style.paddingRight, '316px', 'pad-A: 第一轮写上了');
  delete t.lines[0].style.paddingRight;          // 模拟行内样式被清掉，节点没换
  I.dbgReset();
  ctl.update();

  const rec = points('lp.padTarget').find((r) => r.inlineR === '');
  ok(!!rec, 'pad-A: 记到了行内值为空的那一行');
  eq(rec.expectR.skipped, true, 'pad-A: 差异写入判定为「已达标」，一个字节没写');
  eq(rec.expectR.inlineNow, '', 'pad-A: 元素上其实没有值');
  eq(rec.expectR.verdict, 'skipped-missing', 'pad-A: 判定成「跳过且缺失」');
  eq(rec.diagnosis, 'A', 'pad-A: 直接标成 A（值不在元素上）');

  ctl.dispose();
  I.flushLivePreviewFloats();
}

function tAuditCaseB() {
  // B：值在元素上，文字右边界仍越过图的左边线（固定宽度 / 不折行 / box-sizing）
  I.flushLivePreviewFloats();
  const t = tree();
  t.lines.forEach((l) => withRange(l, 930, 0));  // 文字画到 930，图从 623.5 开始
  const ctl = I.attachLivePreviewFloat(t.host, { float: 'right' }, { svg: t.svg });

  const rec = lastTarget();
  eq(rec.inlineR, '316px', 'pad-B: 值在元素上');
  eq(rec.expectR.verdict, 'wrote-ok', 'pad-B: 不是 A');
  eq(rec.textRight, 930, 'pad-B: Range 量出的文字右边界');
  eq(rec.imgLeft, 623.5, 'pad-B: 图的左边线');
  eq(rec.covered, true, 'pad-B: 文字压在图上');
  eq(rec.diagnosis, 'B', 'pad-B: 直接标成 B（值在但没挤到文字）');

  ctl.dispose();
  I.flushLivePreviewFloats();
}

function tAuditNotCovered() {
  // 对照：值在元素上，文字也被挤开了 → ok
  I.flushLivePreviewFloats();
  const t = tree();
  t.lines.forEach((l) => withRange(l, 600, 0));
  const ctl = I.attachLivePreviewFloat(t.host, { float: 'right' }, { svg: t.svg });

  const rec = lastTarget();
  eq(rec.covered, false, 'pad-ok: 文字右边界在图左边线以内');
  eq(rec.diagnosis, 'ok', 'pad-ok: 结论 ok');
  ok(rec.textOver < 0, 'pad-ok: 文字没溢出 padding 盒');

  ctl.dispose();
  I.flushLivePreviewFloats();
}

function tAuditSilentWithoutPads() {
  // 没有后续行 → 不算留白 → 一条都不记（避免日志膨胀）
  I.flushLivePreviewFloats();
  I.dbgReset();
  const t = tree();
  t.line.nextElementSibling = null;
  const ctl = I.attachLivePreviewFloat(t.host, { float: 'right' }, { svg: t.svg });
  ok(!!ctl, 'pad-silent: 控制器挂上（图本身照样定位）');
  eq(points('lp.padAudit').length, 0, 'pad-silent: 没有留白目标就不记汇总');
  eq(points('lp.padTarget').length, 0, 'pad-silent: 也不记单行');
  ctl.dispose();
  I.flushLivePreviewFloats();
}

function tAuditNeverBreaks() {
  // 诊断遇到会抛错的元素也不能影响留白本身
  I.flushLivePreviewFloats();
  I.dbgReset();
  const t = tree();
  t.lines[0].getBoundingClientRect = () => { throw new Error('boom'); };
  let threw = false;
  let ctl = null;
  try {
    ctl = I.attachLivePreviewFloat(t.host, { float: 'right' }, { svg: t.svg });
  } catch (e) {
    threw = true;
  }
  ok(!threw, 'pad-safe: 诊断不下抛');
  ok(!!ctl, 'pad-safe: 控制器照样挂上');
  eq(t.lines[0].style.paddingRight, '316px', 'pad-safe: 留白照样写上');
  ok(points('lp.padAudit').length >= 1, 'pad-safe: 汇总照样记（单个元素炸了不影响汇总）');

  ctl.dispose();
  I.flushLivePreviewFloats();
}

function tAuditLedgerSnapshot() {
  // 账本快照是只读拷贝：改动它不能影响账本
  const el = fakeEl(['cm-line'], 40);
  const ledger = I.createStyleLedger();
  eq(ledger.entryOf(el, 'paddingRight'), null, 'pad-ledger: 没记账 → null');
  ledger.set(el, 'paddingRight', '400px');
  const snap = ledger.entryOf(el, 'paddingRight');
  eq(snap.written, '400px', 'pad-ledger: 快照里有写过的值');
  eq(snap.base, 0, 'pad-ledger: 快照里有接管前的基准');
  snap.written = '999px';
  eq(ledger.entryOf(el, 'paddingRight').written, '400px', 'pad-ledger: 改快照不影响账本');
  eq(ledger.padBase(el, 'paddingRight'), 0, 'pad-ledger: 基准没被带歪');
  ledger.reset();
  ok(el.style.paddingRight === undefined, 'pad-ledger: 复位照常');
}

suite('pad-audit', () => {
  tAuditShape();
  tAuditSkippedOk();
  tAuditCaseA();
  tAuditCaseB();
  tAuditNotCovered();
  tAuditSilentWithoutPads();
  tAuditNeverBreaks();
  tAuditLedgerSnapshot();
});
