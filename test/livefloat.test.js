'use strict';

/* ============================================================
 * livefloat.test.js · 实时预览（CM6）浮动的纯逻辑
 *
 * Live Preview 里正文被切成一个个 .cm-line，widget 浮在自己那行，后面的行跟它
 * 没有兄弟关系 —— 阅读视图那套「给后续兄弟加外边距」对它无效。两种结构分两条路：
 *
 *   direct-embed（.cm-content > .cm-embed-block） → 一行高度 + 绝对定位图 + 逐行留白
 *   cm-line（.cm-content > .cm-line > .cm-embed-block）→ 绝对定位 + 逐行 padding
 *
 * 真实布局只能靠浏览器验，这里测能用假 DOM 判定的几件事：
 *   1. planLivePreviewLines / planWrappedLines：该给哪些行留白（老结构）
 *   2. planLinePads：多张图压到同一行时取最大值、不叠加
 *   3. applyLivePreviewFloat + 账本：施加、重复施加、复位是否彻底（老结构）
 *   4. applyLivePreviewCssFloat：新结构把 widget 钉成一行、图绝对定位、后续行留白
 *   5. 几个「不该动手」的守卫
 * ============================================================ */

const { I, Plugin, ok, eq, suite } = require('./framework');

/* ------------------------------ 假 DOM ------------------------------ */

/** 极简 style：普通对象 + setProperty / removeProperty（模拟 CSSStyleDeclaration） */
function styleObj(init) {
  const s = Object.assign({}, init || {});
  s.__removed = [];
  s.__important = {};                     // 记下带 !important 写过的属性
  s.setProperty = (name, value, priority) => {
    const key = String(name).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
    s[key] = String(value);
    if (priority) s.__important[key] = String(priority);
    else delete s.__important[key];
  };
  s.removeProperty = (p) => {
    s.__removed.push(p);
    const key = String(p).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
    delete s[key];
    delete s.__important[key];
  };
  return s;
}

/**
 * 假元素。classes 用数组给出（classList.contains 只认这些），
 * rect 缺省时按高度造一个贴在左上角的矩形。
 */
function fakeEl(classes, h, rect, init) {
  const cls = classes || [];
  const el = {
    style: styleObj(init),
    classList: { contains: (c) => cls.indexOf(c) >= 0 },
    parentElement: null,
    nextElementSibling: null,
    isConnected: true,
    nodeType: 1,
    offsetHeight: h || 0,
    clientWidth: 0,
    clientLeft: 0,
    clientTop: 0,
  };
  const r = rect || { top: 0, left: 0, width: 0, height: h || 0, right: 0, bottom: h || 0 };
  el.getBoundingClientRect = () => r;
  return el;
}

/** 一行 .cm-line：按高度造，兄弟链由调用方接 */
function cmLine(h, init) {
  return fakeEl(['cm-line'], h, { top: 0, left: 0, width: 820, height: h, right: 820, bottom: h }, init);
}

function linkChain(list) {
  for (let i = 0; i + 1 < list.length; i++) list[i].nextElementSibling = list[i + 1];
  return list;
}

/**
 * 复刻一份 CM6 结构：
 *   .cm-content > .cm-line(widget) > .cm-embed-block > host
 * 后面再接三行正文。图 400×106，正文列宽 820。
 */
function cmTree(opts) {
  const o = opts || {};
  const content = fakeEl(['cm-content'], 0,
    { top: 0, left: 0, width: 820, height: 2000, right: 820, bottom: 2000 });
  content.clientWidth = 820;

  const line = cmLine(0);
  line.parentElement = content;

  const embedH = o.embedH == null ? 106 : o.embedH;
  const embed = fakeEl(['cm-embed-block'], embedH,
    { top: 0, left: 0, width: 820, height: embedH, right: 820, bottom: embedH });
  embed.parentElement = line;

  const host = fakeEl([], embedH, { top: 0, left: 0, width: 400, height: embedH, right: 400, bottom: embedH });
  host.parentElement = embed;

  const svg = fakeEl(['brace-map-svg'], embedH,
    { top: 0, left: 0, width: 400, height: embedH, right: 400, bottom: embedH });

  const heights = o.lineHeights || [60, 60, 60];
  const lines = linkChain(heights.map((h) => cmLine(h)));
  line.nextElementSibling = lines[0] || null;

  return { content, line, embed, host, svg, lines };
}

/**
 * 复刻 Obsidian 1.13.7 的实测结构：
 *   .cm-content > .cm-embed-block > host        （中间没有 .cm-line）
 * .cm-embed-block 后面直接接三行 .cm-line（与它平级）。图 400×106，正文列宽 820。
 */
function cmTreeDirect(opts) {
  const o = opts || {};
  const content = fakeEl(['cm-content'], 0,
    { top: 0, left: 0, width: 820, height: 2000, right: 820, bottom: 2000 });
  content.clientWidth = 820;

  const embedH = o.embedH == null ? 106 : o.embedH;
  const embed = fakeEl(['cm-embed-block'], embedH,
    { top: 0, left: 0, width: 820, height: embedH, right: 820, bottom: embedH });
  embed.className = 'cm-embed-block markdown-rendered';
  embed.parentElement = content;

  const host = fakeEl([], embedH, { top: 0, left: 0, width: 400, height: embedH, right: 400, bottom: embedH });
  host.parentElement = embed;

  const svg = fakeEl(['brace-map-svg'], embedH,
    { top: 0, left: 0, width: 400, height: embedH, right: 400, bottom: embedH });

  const heights = o.lineHeights || [60, 60, 60];
  const lines = linkChain(heights.map((h) => cmLine(h)));
  embed.nextElementSibling = lines[0] || null;

  return { content, embed, host, svg, lines };
}

/** 给假元素补上 className（classHas 走 classList，放宽规则要读 className） */
function withClass(el, names) {
  el.className = names.join(' ');
  if (!el.tagName) el.tagName = 'div';       // dbgEl 的标签名，诊断里好认
  return el;
}

/** 把一张图的几何算完再写留白（与 manager 里的两段调用同构） */
function applyAll(host, cfg, opts) {
  const rec = I.applyLivePreviewFloat(host, cfg, opts);
  if (!rec) return null;
  const pads = I.planLinePads([{ lines: rec.lines, side: rec.side, span: rec.span }],
    { reader: opts && opts.reader });
  I.applyLinePads(pads, rec.ledger);
  return rec;
}

/* ------------------------------ 留白行 ------------------------------ */

function tPlanLinesGuard() {
  const lines = linkChain([cmLine(60), cmLine(60)]);
  eq(I.planLivePreviewLines(lines, 0), [], 'lp-lines: 图高 0 → 空');
  eq(I.planLivePreviewLines(lines, -30), [], 'lp-lines: 负图高 → 空');
  eq(I.planLivePreviewLines(lines, NaN), [], 'lp-lines: 图高 NaN → 空');
  eq(I.planLivePreviewLines(lines, undefined), [], 'lp-lines: 图高 undefined → 空');
  eq(I.planLivePreviewLines(null, 100), [], 'lp-lines: 没有候选 → 空');
  eq(I.planLivePreviewLines('abc', 100), [], 'lp-lines: 不是数组 → 空');
}

function tPlanLinesBasic() {
  // 只有一行，图比它高：只留这一行，循环自然结束
  const one = [cmLine(50)];
  eq(I.planLivePreviewLines(one, 500).length, 1, 'lp-lines: 唯一一行也留白');

  // 三行各 60，图 106 → 前两行累积 120 够高，第三行不留白
  const three = [cmLine(60), cmLine(60), cmLine(60)];
  const got = I.planLivePreviewLines(three, 106);
  eq(got.length, 2, 'lp-lines: 累积够高就停');
  ok(got[0] === three[0] && got[1] === three[1], 'lp-lines: 返回的是原元素');

  // 图高超过所有行总高：全带上并结束，不死循环
  eq(I.planLivePreviewLines(three, 10000).length, 3, 'lp-lines: 行总高不足 → 全带上');

  // 第一行就够高
  eq(I.planLivePreviewLines([cmLine(300), cmLine(60)], 100).length, 1, 'lp-lines: 第一行就盖住');

  // 零高行不贡献高度但也不清空
  eq(I.planLivePreviewLines([cmLine(0), cmLine(0), cmLine(300)], 100).length, 3, 'lp-lines: 零高行照样留白');
}

function tPlanLinesEdge() {
  // null 条目跳过且不中断（CM6 节点可能还没渲染出来）
  const a = cmLine(60);
  const b = cmLine(60);
  const withNulls = [null, a, undefined, b];
  const got = I.planLivePreviewLines(withNulls, 100);
  eq(got.length, 2, 'lp-lines: null 跳过、不中断');
  ok(got[0] === a && got[1] === b, 'lp-lines: null 之后的元素照常入选');

  // 同一元素重复出现只留一次白
  eq(I.planLivePreviewLines([a, a, b], 1).length, 1, 'lp-lines: 重复元素只算一次');

  // limit 兜底
  const many = [cmLine(1), cmLine(1), cmLine(1), cmLine(1), cmLine(1)];
  eq(I.planLivePreviewLines(many, 1e9, { limit: 2 }).length, 2, 'lp-lines: limit 生效');
}

/* ------------------------------ 每行留多少 ------------------------------ */

function tPlanPadsBasic() {
  const a = cmLine(60);
  const pads = I.planLinePads([{ lines: [a], side: 'right', span: 416 }], { reader: () => ({ left: 0, right: 0 }) });
  eq(pads.length, 1, 'lp-pads: 一行一条');
  eq(pads[0].el, a, 'lp-pads: 指向原元素');
  eq(pads[0].right, 416, 'lp-pads: 右浮动写 right');
  eq(pads[0].left, 0, 'lp-pads: 左浮动不动');

  // 左浮动镜像
  const b = cmLine(60);
  const lp = I.planLinePads([{ lines: [b], side: 'left', span: 316 }], { reader: () => ({ left: 0, right: 0 }) });
  eq(lp[0].left, 316, 'lp-pads: 左浮动写 left');
  eq(lp[0].right, 0, 'lp-pads: 右浮动不动');

  // 行自带 padding 时叠在它上面
  const c = cmLine(60);
  const cp = I.planLinePads([{ lines: [c], side: 'right', span: 400 }], { reader: () => ({ left: 12, right: 8 }) });
  eq(cp[0].right, 408, 'lp-pads: 叠在原有 padding 上');
  eq(cp[0].left, 12, 'lp-pads: 另一侧原值保留');
}

function tPlanPadsMerge() {
  // 两张图压到同一行：取最大值，不相加（相加会把同一块空间算两遍）
  const shared = cmLine(60);
  const only = cmLine(60);
  const pads = I.planLinePads([
    { lines: [shared], side: 'right', span: 416 },
    { lines: [shared, only], side: 'right', span: 300 },
  ], { reader: () => ({ left: 0, right: 0 }) });
  eq(pads.length, 2, 'lp-pads: 两行（去重后）');
  eq(pads[0].el, shared, 'lp-pads: 先出现的行排在前面');
  eq(pads[0].right, 416, 'lp-pads: 同一行取最大留白，不叠加');
  eq(pads[1].right, 300, 'lp-pads: 只有小图压到的行用小的');

  // 左右各一张：两侧各加各的
  const both = cmLine(60);
  const bp = I.planLinePads([
    { lines: [both], side: 'right', span: 416 },
    { lines: [both], side: 'left', span: 316 },
  ], { reader: () => ({ left: 0, right: 0 }) });
  eq(bp[0].left, 316, 'lp-pads: 左侧独立');
  eq(bp[0].right, 416, 'lp-pads: 右侧独立');
}

function tPlanPadsGuard() {
  const a = cmLine(60);
  eq(I.planLinePads([{ lines: [a], side: 'right', span: 0 }], {}).length, 0, 'lp-pads: 间距 0 → 空');
  eq(I.planLinePads([{ lines: [a], side: 'right', span: -5 }], {}).length, 0, 'lp-pads: 负间距 → 空');
  eq(I.planLinePads([{ lines: [a], side: 'center', span: 400 }], {}).length, 0, 'lp-pads: center 不处理');
  eq(I.planLinePads([{ lines: [a], side: 'right', span: NaN }], {}).length, 0, 'lp-pads: span 非数 → 空');
  eq(I.planLinePads([{ lines: 'x', side: 'right', span: 400 }], {}).length, 0, 'lp-pads: lines 不是数组 → 空');
  eq(I.planLinePads([{ lines: [null, a], side: 'right', span: 400 }], {}).length, 1, 'lp-pads: null 元素跳过');
  const noStyle = { classList: { contains: () => true } };
  eq(I.planLinePads([{ lines: [noStyle], side: 'right', span: 400 }], {}).length, 0, 'lp-pads: 没有 style 的对象跳过');
  eq(I.planLinePads(null, {}).length, 0, 'lp-pads: 没有块 → 空');
}

/* ------------------------------ 账本与复位 ------------------------------ */

function tApplyPadsWrite() {
  const a = cmLine(60);
  const ledger = I.createStyleLedger();
  const pads = [{ el: a, left: 0, right: 412 }];
  eq(I.applyLinePads(pads, ledger), 1, 'lp-apply: 写一条');
  eq(a.style.paddingRight, '412px', 'lp-apply: paddingRight 带 px');

  const both = [{ el: cmLine(60), left: 12, right: 412 }];
  const l2 = I.createStyleLedger();
  eq(I.applyLinePads(both, l2), 2, 'lp-apply: 左右都写算两条');
  ok(both[0].el.style.paddingLeft === '12px' && both[0].el.style.paddingRight === '412px',
    'lp-apply: 左右都落到行内样式');

  eq(I.applyLinePads(pads, null), 0, 'lp-apply: 没有账本 → 0');
  eq(I.applyLinePads(null, ledger), 0, 'lp-apply: 没有数据 → 0');
}

function tPadSurvivesBadRect() {
  // 行量尺寸会抛错时，排版路径自己不能塌：诊断层已撤掉，守的是留白本身的健壮性
  const tree = cmTree();
  tree.lines[0].getBoundingClientRect = () => { throw new Error('boom'); };
  let ctl = null;
  let threw = false;
  try {
    ctl = I.attachLivePreviewFloat(tree.host, { float: 'right', width: 300 }, { svg: tree.svg });
  } catch (e) { threw = true; }
  ok(!threw, 'lp-badrect: 量尺寸抛错不外抛');
  ok(!!ctl, 'lp-badrect: 控制器照样挂上');
  eq(tree.lines[0].style.paddingRight, '316px', 'lp-badrect: 留白照样写上');
  if (ctl) ctl.dispose();
  I.flushLivePreviewFloats();
}

function tLedger() {
  const el = fakeEl([], 0, null, { paddingRight: '8px' });
  const ledger = I.createStyleLedger();
  ledger.set(el, 'paddingRight', '412px');
  eq(el.style.paddingRight, '412px', 'ledger: 写入生效');
  ok(ledger.has(el), 'ledger: 记到了元素');
  eq(ledger.props(el), ['paddingRight'], 'ledger: 记到了属性');
  eq(ledger.size(), 1, 'ledger: 一个元素');

  // 同一属性写两次只留一条记录，复位仍是原值
  ledger.set(el, 'paddingRight', '500px');
  eq(ledger.props(el).length, 1, 'ledger: 同一属性不重复记账');
  eq(ledger.reset(), 1, 'ledger: 复位一条');
  eq(el.style.paddingRight, '8px', 'ledger: 恢复写之前的行内值');
  eq(ledger.size(), 0, 'ledger: 复位后账本清空');
  eq(ledger.reset(), 0, 'ledger: 复位幂等');

  // 原本没有行内值：复位要走 removeProperty，把 CSS 规则让回来
  const bare = fakeEl([], 0);
  const l2 = I.createStyleLedger();
  l2.set(bare, 'paddingLeft', '12px');
  l2.reset();
  ok(bare.style.paddingLeft === undefined, 'ledger: 原本没有行内值 → 复位后消失');
  ok(bare.style.__removed.indexOf('padding-left') >= 0, 'ledger: 走 removeProperty');
}

/* ------------------------------ 结构识别 ------------------------------ */

function tParts() {
  const tree = cmTree();
  const parts = I.livePreviewParts(tree.host);
  ok(parts && parts.embed === tree.embed, 'lp-parts: 找到 .cm-embed-block');
  ok(parts && parts.line === tree.line, 'lp-parts: 找到它的父 .cm-line');
  ok(parts && parts.content === tree.content, 'lp-parts: 找到 .cm-content');

  // 直接把 embed 传进来也认（host 可能就是它）
  const p2 = I.livePreviewParts(tree.embed);
  ok(p2 && p2.embed === tree.embed, 'lp-parts: 传 embed 自己也认');

  eq(I.livePreviewParts(null), null, 'lp-parts: 没有元素 → null');
  const orphan = fakeEl([], 10);
  eq(I.livePreviewParts(orphan), null, 'lp-parts: 不在 CM6 结构里 → null');
  const lonely = fakeEl(['cm-embed-block'], 10);
  eq(I.livePreviewParts(lonely), null, 'lp-parts: 有 embed 但没有 content → null');
}

function tClassHelpers() {
  const a = fakeEl(['cm-line'], 10);
  ok(I.classHas(a, 'cm-line'), 'class: 命中');
  ok(!I.classHas(a, 'cm-content'), 'class: 不命中');
  eq(I.classHas(null, 'cm-line'), false, 'class: null → false');
  eq(I.classHas({}, 'cm-line'), false, 'class: 没有 classList → false');

  const content = fakeEl(['cm-content'], 0);
  const line = fakeEl(['cm-line'], 0);
  const embed = fakeEl(['cm-embed-block'], 0);
  line.parentElement = content;
  embed.parentElement = line;
  ok(I.climbTo(embed, 'cm-line', 8) === line, 'climb: 找到祖先');
  ok(I.climbTo(embed, 'cm-embed-block', 8) === embed, 'climb: 含自己');
  eq(I.climbTo(embed, 'cm-nope', 8), null, 'climb: 找不到 → null');
}

/* ------------------------------ 施加 ------------------------------ */

function tApplyGeometry() {
  const tree = cmTree();
  const ledger = I.createStyleLedger();
  const rec = I.applyLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg, ledger });
  ok(!!rec, 'lp-apply: 右浮动能施加');
  eq(rec.side, 'right', 'lp-apply: side 正确');
  eq(rec.width, 400, 'lp-apply: 图宽取 SVG 实际渲染宽');
  eq(rec.height, 106, 'lp-apply: 图高取真实渲染高');
  eq(rec.span, 416, 'lp-apply: 留白 = 图宽 + 间距');
  eq(rec.lines.length, 2, 'lp-apply: 图高 106 盖住两行 60');

  eq(tree.line.style.position, 'static', 'lp-apply: 行让出包含块（static）');
  eq(tree.content.style.position, 'relative', 'lp-apply: content 成为包含块');
  eq(tree.embed.style.position, 'absolute', 'lp-apply: embed 脱离流');
  eq(tree.embed.style.top, '0px', 'lp-apply: top 沿用流里的原位置');
  eq(tree.embed.style.right, '0px', 'lp-apply: 右浮动贴右边');
  eq(tree.embed.style.left, 'auto', 'lp-apply: 另一侧归零');
  eq(tree.embed.style.width, '400px', 'lp-apply: 宽度落到行内样式');
  eq(tree.embed.style.maxWidth, 'none', 'lp-apply: 放开 max-width');
  eq(tree.embed.style.margin, '0', 'lp-apply: 清掉外边距，免得偏位');

  // 左浮动镜像
  const left = cmTree();
  const lrec = I.applyLivePreviewFloat(left.host, { float: 'left' }, { svg: left.svg });
  eq(lrec.side, 'left', 'lp-apply: 左浮动');
  eq(left.embed.style.left, '0px', 'lp-apply: 左浮动贴左边');
  eq(left.embed.style.right, 'auto', 'lp-apply: 左浮动的另一侧归零');
  ok(!!lrec.ledger, 'lp-apply: 没传账本时自己造一个');

  // cfg.width 优先于 SVG 渲染宽
  const cfgW = cmTree();
  const wrec = I.applyLivePreviewFloat(cfgW.host, { float: 'right', width: 300 }, { svg: cfgW.svg });
  eq(wrec.width, 300, 'lp-apply: cfg.width 优先');
  eq(wrec.span, 316, 'lp-apply: 留白 = 配置宽 + 间距');
  eq(cfgW.embed.style.width, '300px', 'lp-apply: 配置宽写进行内样式');

  // 图宽超过正文列宽：收到列宽
  const wide = cmTree();
  const wideRec = I.applyLivePreviewFloat(wide.host, { float: 'right', width: 2000 }, { svg: wide.svg });
  eq(wideRec.width, 820, 'lp-apply: 图宽不超过正文列宽');
}

function tApplyGuards() {
  const tree = cmTree();
  eq(I.applyLivePreviewFloat(tree.host, { float: 'center' }, {}), null, 'lp-guard: center 不处理');
  eq(I.applyLivePreviewFloat(tree.host, { float: 'inline' }, {}), null, 'lp-guard: inline 不处理');
  eq(I.applyLivePreviewFloat(tree.host, {}, {}), null, 'lp-guard: 没有 float 不处理');
  eq(I.applyLivePreviewFloat(null, { float: 'right' }, {}), null, 'lp-guard: 没有宿主 → null');
  const orphan = fakeEl([], 10);
  eq(I.applyLivePreviewFloat(orphan, { float: 'right' }, {}), null, 'lp-guard: 不在 CM6 结构里 → null');

  // 后续没有行可绕：按阅读视图的同一策略不动手（absolute 会把图抽到裁剪区外）
  const solo = cmTree({ lineHeights: [] });
  const rec = I.applyLivePreviewFloat(solo.host, { float: 'right' }, {});
  eq(rec, null, 'lp-guard: 后面没有行 → 不动手');
  ok(solo.embed.style.position === undefined, 'lp-guard: 不动手时一点样式都不写');
}

/* ------------------------------ 复位彻底性（重点） ------------------------------ */

function tResetThorough() {
  const tree = cmTree();
  const ledger = I.createStyleLedger();

  // 连施两次，中间不复位：模拟「重渲染太频繁、上一轮还没复位」
  const r1 = applyAll(tree.host, { float: 'right' }, { svg: tree.svg, ledger });
  const r2 = applyAll(tree.host, { float: 'right' }, { svg: tree.svg, ledger });
  ok(!!r1 && !!r2, 'reset: 两次施加都成功');
  eq(ledger.size(), 5, 'reset: 账本记 5 个元素（content/line/embed + 两行）');

  const n = ledger.reset();
  ok(n > 0, 'reset: 复位有动作');
  eq(ledger.size(), 0, 'reset: 账本清空');

  ok(tree.content.style.position === undefined, 'reset: content 的 position 还原');
  ok(tree.line.style.position === undefined, 'reset: 行的 position 还原（原本走 CSS 的 relative）');
  const e = tree.embed.style;
  ok(e.position === undefined, 'reset: embed 的 position 清掉');
  ok(e.top === undefined, 'reset: embed 的 top 清掉');
  ok(e.right === undefined, 'reset: embed 的 right 清掉');
  ok(e.left === undefined, 'reset: embed 的 left 清掉');
  ok(e.width === undefined, 'reset: embed 的 width 清掉');
  ok(e.maxWidth === undefined, 'reset: embed 的 maxWidth 清掉');
  ok(e.margin === undefined, 'reset: embed 的 margin 清掉');
  ok(e.float === undefined, 'reset: embed 的 float 清掉');
  ok(tree.lines[0].style.paddingRight === undefined, 'reset: 第一行 paddingRight 清掉');
  ok(tree.lines[1].style.paddingRight === undefined, 'reset: 第二行 paddingRight 清掉');
  ok(tree.lines[2].style.paddingRight === undefined, 'reset: 图下方的行从没被写过');

  // 复位之后再复位：幂等
  eq(ledger.reset(), 0, 'reset: 再复位一次不重复动手');

  // 行原本有行内 position：复位必须回到它，不能抹成空
  const keep = cmTree();
  keep.line.style.position = 'relative';
  keep.lines[0].style.paddingRight = '4px';
  const kl = I.createStyleLedger();
  applyAll(keep.host, { float: 'right' }, { svg: keep.svg, ledger: kl });
  eq(keep.line.style.position, 'static', 'reset: 原本的行内 position 被临时改写');
  kl.reset();
  eq(keep.line.style.position, 'relative', 'reset: 回到原本的行内值');
  eq(keep.lines[0].style.paddingRight, '4px', 'reset: 行自己的 padding 也回到原值');
}

/* ------------------------------ 控制器 ------------------------------ */

function tAttach() {
  const tree = cmTree();
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg });
  ok(!!ctl, 'lp-ctl: 挂上了');
  ok(ctl.host === tree.host, 'lp-ctl: 认得宿主');
  eq(tree.embed.style.position, 'absolute', 'lp-ctl: 挂上即生效');
  eq(tree.lines[0].style.paddingRight, '416px', 'lp-ctl: 第一行留白 416');
  eq(tree.lines[2].style.paddingRight, undefined, 'lp-ctl: 图下方那行不留白');

  const st = ctl.state();
  ok(st && st.attached === true, 'lp-ctl: state 说已挂上');
  eq(st.widgets, 1, 'lp-ctl: 一个图');

  ctl.update();
  eq(tree.lines[0].style.paddingRight, '416px', 'lp-ctl: 重算后留白不变（不叠加）');

  ctl.dispose();
  // 销毁只是「交出 widget」：样式原地不动，等新控制器接管（或延迟到期）
  ok(tree.embed.style.position === 'absolute', 'lp-ctl: 销毁后不立即复位（还有绝对定位）');
  ok(tree.content.style.position === 'relative', 'lp-ctl: 销毁后 content 还是包含块');
  ok(tree.line.style.position === 'static', 'lp-ctl: 销毁后行还是 static');
  eq(tree.lines[0].style.paddingRight, '416px', 'lp-ctl: 销毁后留白仍在（不再出现重置窗口）');

  // 同步收尾走的跟 onunload 同一条路：当场全部还原
  I.flushLivePreviewFloats();
  ok(tree.embed.style.position === undefined, 'lp-ctl: 同步复位后 embed 复位');
  ok(tree.content.style.position === undefined, 'lp-ctl: 同步复位后 content 复位');
  ok(tree.line.style.position === undefined, 'lp-ctl: 同步复位后行复位');
  ok(tree.lines[0].style.paddingRight === undefined, 'lp-ctl: 同步复位后留白复位');

  // center / inline 不挂
  eq(I.attachLivePreviewFloat(tree.host, { float: 'center' }, {}), null, 'lp-ctl: center → null');
  eq(I.attachLivePreviewFloat(tree.host, { float: 'inline' }, {}), null, 'lp-ctl: inline → null');
  eq(I.attachLivePreviewFloat(null, { float: 'right' }, {}), null, 'lp-ctl: 没有宿主 → null');

  // attachFloatWrap 在 CM6 里必须走实时预览这条路，而不是直接返回 null
  const t2 = cmTree();
  t2.host.closest = (sel) => (sel === '.cm-editor' || sel === '.cm-content' ? t2.content : null);
  const c2 = I.attachFloatWrap(t2.host, { float: 'right' }, { svg: t2.svg });
  ok(!!c2, 'lp-ctl: attachFloatWrap 对 CM6 有返回（不再直接放弃）');
  eq(t2.lines[0].style.paddingRight, '416px', 'lp-ctl: 走的是实时预览路径');
  if (c2) c2.dispose();
  I.flushLivePreviewFloats();          // 收掉延迟复位与巡检定时器，不留活口
}

/* ---------------------- 结构回退（Obsidian 1.13.7） ---------------------- */

function tDirectParts() {
  const tree = cmTreeDirect();
  const parts = I.livePreviewParts(tree.host);
  ok(!!parts, 'lp-direct: 没有 .cm-line 的新结构也能认出三件东西');
  ok(parts && parts.mode === 'direct-embed', 'lp-direct: 走 direct-embed 分支');
  ok(parts && parts.line === tree.embed, 'lp-direct: line 回退成 embed 自己');
  ok(parts && parts.embed === tree.embed, 'lp-direct: embed 还是那个 .cm-embed-block');
  ok(parts && parts.content === tree.content, 'lp-direct: content 还是 .cm-content');

  // 直接把 embed 传进来也认
  const p2 = I.livePreviewParts(tree.embed);
  ok(p2 && p2.mode === 'direct-embed' && p2.line === tree.embed, 'lp-direct: 传 embed 自己也认回退');

  // 旧结构不能回退吃掉：仍然走 .cm-line
  const old = cmTree();
  const p3 = I.livePreviewParts(old.host);
  ok(p3 && p3.mode === 'cm-line', 'lp-direct: 老结构仍走 cm-line 分支');
  ok(p3 && p3.line === old.line, 'lp-direct: 老结构的 line 是 .cm-line');
  ok(p3 && p3.line !== p3.embed, 'lp-direct: 老结构里 line ≠ embed');

  // 既没有 .cm-line、父级又是别的容器：认不出就是 null，不猜
  const content = fakeEl(['cm-content'], 0);
  const wrap = fakeEl(['cm-nope'], 0);
  const embed = fakeEl(['cm-embed-block'], 10);
  wrap.parentElement = content;
  embed.parentElement = wrap;
  eq(I.livePreviewParts(embed), null, 'lp-direct: 父级不是 .cm-content → null');
}

function tDirectCandidates() {
  const tree = cmTreeDirect();
  const got = I.collectLineSiblings(tree.embed.nextElementSibling, 0, tree.embed);
  eq(got.length, 3, 'lp-direct: 另外三个兄弟 .cm-line 全收进来');
  ok(got[0] === tree.lines[0], 'lp-direct: 第一行就是 embed 的下一个兄弟');

  // 混进非正文节点：跳过但不断链
  const self = withClass(fakeEl(['cm-embed-block'], 100), ['cm-embed-block']);
  const line1 = cmLine(60);
  const gap = withClass(fakeEl(['cm-gap'], 12), ['cm-gap']);
  const other = withClass(fakeEl(['cm-embed-block'], 40), ['cm-embed-block', 'markdown-rendered']);
  const layer = withClass(fakeEl(['cm-cursorLayer'], 0), ['cm-cursorLayer']);
  const plain = withClass(fakeEl([], 60), []);    // 裸 div（无类名，className === ''）
  const themed = withClass(fakeEl([], 60), ['HyperMD-list-line']);
  const alien = withClass(fakeEl([], 60), ['cm-someWidget']);
  linkChain([self, line1, gap, other, layer, plain, themed, alien]);

  const all = I.collectLineSiblings(self.nextElementSibling, 0, self);
  eq(all.length, 3, 'lp-direct: 只留真正的正文行');
  ok(all.indexOf(line1) >= 0, 'lp-direct: .cm-line 收');
  ok(all.indexOf(plain) >= 0, 'lp-direct: 裸 div 当正文块收');
  ok(all.indexOf(themed) >= 0, 'lp-direct: 非 cm- 类名的正文块收（类名变了也活）');
  eq(all.indexOf(gap), -1, 'lp-direct: .cm-gap 不收');
  eq(all.indexOf(other), -1, 'lp-direct: 另一个 .cm-embed-block 不收');
  eq(all.indexOf(layer), -1, 'lp-direct: 浮层 .cm-cursorLayer 不收');
  eq(all.indexOf(alien), -1, 'lp-direct: cm-* 的内部节点不收（不把所有 div 收进来）');

  // 起点给成 widget 自己：它自己不会被当成正文行
  const fromSelf = I.collectLineSiblings(self, 1, self);
  eq(fromSelf.length, 1, 'lp-direct: 起点是 widget 自己时只往后收一行');
  ok(fromSelf[0] === line1, 'lp-direct: 起点自身被排除');

  // 另一个 widget 自己也算排除对象
  const onlyWidget = I.collectLineSiblings(other, 0, self);
  eq(onlyWidget.length, 2, 'lp-direct: 从另一个 widget 起步也继续往后扫');
}

/* -------------- 新结构（direct-embed）：一行高度 + 绝对定位图 + 逐行留白 -------------- */

function tCssApply() {
  const tree = cmTreeDirect();
  const rec = I.applyLivePreviewCssFloat(tree.host, { float: 'right' }, { svg: tree.svg });
  ok(!!rec, 'lp-css: 新结构能施加');
  eq(rec.mode, 'direct-embed', 'lp-css: 结果里带分支名');
  eq(rec.side, 'right', 'lp-css: 右浮动');
  eq(rec.width, 400, 'lp-css: 图宽取 SVG 渲染宽');
  eq(rec.lineH, 60, 'lp-css: 一行高取候选行里最矮的');
  eq(rec.imgH, 106, 'lp-css: 图高取 SVG / 宿主里大的那个');
  eq(rec.overflow, 46, 'lp-css: 需要下行盖住的高度 = 图底 - widget 底');
  eq(rec.span, 416, 'lp-css: 留白宽度 = 图宽 + 间距');

  /* widget 钉成一行：CSS 高度 / DOM 高度 / CM6 记账要三方一字 */
  eq(tree.embed.style.height, '60px', 'lp-css: embed 高度钉成一行');
  eq(tree.embed.style.minHeight, '0', 'lp-css: min-height 归零');
  eq(tree.embed.style.maxHeight, '60px', 'lp-css: max-height 也是一行');
  eq(tree.embed.style.overflow, 'visible', 'lp-css: 溢出可见（图要浮出去）');
  eq(tree.embed.style.float, 'none', 'lp-css: 明确不 float');
  eq(tree.embed.style.width, 'auto', 'lp-css: 宽度不压窄');
  eq(tree.embed.style.position, 'relative', 'lp-css: 当绝对定位的包含块');
  eq(tree.embed.style.margin, '0', 'lp-css: 外边距清零');
  eq(tree.embed.style.__important.margin, 'important',
    'lp-css: 清零带 !important（app.css 给 .cm-content > * 写了 margin: 0 !important）');

  /* 图绝对定位贴右边：从这一行往下溢出 */
  eq(tree.host.style.position, 'absolute', 'lp-css: 宿主绝对定位');
  eq(tree.host.style.top, '0', 'lp-css: 图顶贴住 widget 顶');
  eq(tree.host.style.right, '0', 'lp-css: 右浮动贴正文列右边');
  eq(tree.host.style.left, 'auto', 'lp-css: 另一侧自动');
  eq(tree.host.style.width, '400px', 'lp-css: 宽度落在宿主上');
  eq(tree.host.style.maxWidth, 'none', 'lp-css: 抹掉 applyFloatLayout 的 max-width:100%');
  eq(tree.host.style.float, 'none', 'lp-css: 宿主不再浮动');
  eq(tree.host.style.clear, 'none', 'lp-css: clear:both 也清掉');
  eq(tree.host.style.margin, '0', 'lp-css: 宿主外边距清零');
  eq(tree.host.style.display, 'flow-root', 'lp-css: 宿主自成一块');
  ok(tree.content.style.position === undefined, 'lp-css: .cm-content 的 position 不动');

  /* 后续行留白：图往下溢出 46，一行 60 就盖住了，第二行不碰 */
  eq(tree.lines[0].style.paddingRight, '416px', 'lp-css: 第一行留白');
  eq(tree.lines[1].style.paddingRight, undefined, 'lp-css: 图只溢出 46，第二行不用留白');
  eq(tree.lines[2].style.paddingRight, undefined, 'lp-css: 第三行更不碰');
  eq(tree.lines[0].style.paddingLeft, undefined, 'lp-css: 右浮动不碰左留白');
  eq(rec.pads.length, 1, 'lp-css: 留白行数');
  eq(rec.covered, 60, 'lp-css: 累积高度');
  eq(rec.shortfall, 0, 'lp-css: 盖住了，没有缺口');
  eq(rec.stopped, true, 'lp-css: 是盖住之后停的');

  /* 左浮动镜像：图贴左，行加左留白 */
  const left = cmTreeDirect();
  const lrec = I.applyLivePreviewCssFloat(left.host, { float: 'left' }, { svg: left.svg });
  eq(lrec.side, 'left', 'lp-css: 左浮动');
  eq(left.host.style.left, '0', 'lp-css: 贴左边');
  eq(left.host.style.right, 'auto', 'lp-css: 右侧自动');
  eq(left.lines[0].style.paddingLeft, '416px', 'lp-css: 左浮动加左留白');
  eq(left.lines[0].style.paddingRight, undefined, 'lp-css: 左浮动不碰右留白');

  /* 图宽：配置优先，超列宽收到列宽，留白跟着宽度走 */
  const cfgW = cmTreeDirect();
  const wrec = I.applyLivePreviewCssFloat(cfgW.host, { float: 'right', width: 300 }, { svg: cfgW.svg });
  eq(wrec.width, 300, 'lp-css: cfg.width 优先');
  eq(cfgW.host.style.width, '300px', 'lp-css: 配置宽写进行内样式');
  eq(cfgW.lines[0].style.paddingRight, '316px', 'lp-css: 留白 = 图宽 + 间距');
  ok(cfgW.lines[1].style.paddingRight === undefined, 'lp-css: 一行盖住就不再往下写');
  const wide = cmTreeDirect();
  const wideRec = I.applyLivePreviewCssFloat(wide.host, { float: 'right', width: 2000 }, { svg: wide.svg });
  eq(wideRec.width, 820, 'lp-css: 图宽不超过正文列宽');
}

function tCssGuards() {
  const tree = cmTreeDirect();
  eq(I.applyLivePreviewCssFloat(tree.host, { float: 'center' }, {}), null, 'lp-css: center 不处理');
  eq(I.applyLivePreviewCssFloat(tree.host, { float: 'inline' }, {}), null, 'lp-css: inline 不处理');
  eq(I.applyLivePreviewCssFloat(tree.host, {}, {}), null, 'lp-css: 没有 float 不处理');
  eq(I.applyLivePreviewCssFloat(null, { float: 'right' }, {}), null, 'lp-css: 没有宿主 → null');
  ok(tree.embed.style.height === undefined, 'lp-css: 不处理时一个样式都不写');
  const orphan = fakeEl([], 10);
  eq(I.applyLivePreviewCssFloat(orphan, { float: 'right' }, {}), null, 'lp-css: 不在 CM6 结构里 → null');

  /* 老结构（embed 在 .cm-line 里）不走这条路 */
  const old = cmTree();
  eq(I.applyLivePreviewCssFloat(old.host, { float: 'right' }, { svg: old.svg }), null,
    'lp-css: cm-line 结构交给绝对定位那条');
  ok(old.embed.style.height === undefined, 'lp-css: 老结构的 embed 没被钉高');

  /* 旧的绝对定位实现也不再接管新结构 */
  eq(I.applyLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg }), null,
    'lp-css: 绝对定位 + 留白那套不再进 direct-embed');
  ok(tree.embed.style.position === undefined, 'lp-css: 新结构里没人写 position');

  /* 后面没有行：没东西可留白，照样施加（图溢进空白区，不遮字）*/
  const solo = cmTreeDirect({ lineHeights: [] });
  const rec = I.applyLivePreviewCssFloat(solo.host, { float: 'right' }, { svg: solo.svg });
  ok(!!rec, 'lp-css: 后面一行正文都没有也照样施加');
  eq(rec.pads.length, 0, 'lp-css: 没行就不留白');

  /* 量不到图高：彻底不动手，否则图会盖住正文 */
  const blind = cmTreeDirect({ embedH: 0 });
  blind.host.getBoundingClientRect = () => ({ top: 0, left: 0, width: 400, height: 0, right: 400, bottom: 0 });
  blind.svg.getBoundingClientRect = () => ({ top: 0, left: 0, width: 400, height: 0, right: 400, bottom: 0 });
  eq(I.applyLivePreviewCssFloat(blind.host, { float: 'right' }, { svg: blind.svg }), null,
    'lp-css: 量不到图高 → 不动手');
  ok(blind.embed.style.height === undefined, 'lp-css: 不动手时一行样式都不写');
}

/**
 * 一行高度：候选行里最矮的那一行 → content 的 computed line-height → 27 兜底。
 * 不能拿被折行撑高的段落当行高，否则 widget 会被钉成两行、三行。
 */
function tOneLineHeight() {
  const mkContent = (lineHeight) => {
    const c = fakeEl(['cm-content'], 0, { top: 0, left: 0, width: 820, height: 2000, right: 820, bottom: 2000 });
    c.clientWidth = 820;
    c.ownerDocument = {
      defaultView: { getComputedStyle: () => ({ lineHeight: lineHeight == null ? 'normal' : lineHeight }) },
    };
    return c;
  };

  const content = mkContent('31px');
  eq(I.oneLineHeightOf(content, [cmLine(60), cmLine(84), null]), 60,
    'lp-lineh: 取最矮的那一行（多行段落不算行高）');
  eq(I.oneLineHeightOf(content, [cmLine(0), cmLine(140)]), 140,
    'lp-lineh: 零高行不参与，剩一个就用它');
  eq(I.oneLineHeightOf(content, []), 31, 'lp-lineh: 量不到行就用 computed line-height');
  eq(I.oneLineHeightOf(mkContent('normal'), []), I.LP_LINE_FALLBACK,
    'lp-lineh: line-height 是 normal 时用 27 兜底');
  eq(I.oneLineHeightOf(null, null), I.LP_LINE_FALLBACK, 'lp-lineh: 什么都没有也不抛错');
}

/**
 * 留白规划：必须按「加完 padding 之后量出来的真实高度」累积。
 * 这里用注入的 measure 模拟真实浏览器：留白一加，长行就折成两行（高度翻倍）。
 */
function tPinnedPads() {
  const lines = [0, 1, 2, 3].map(() => cmLine(26));
  const ledger = I.createStyleLedger();
  const plan = I.planPinnedPads(lines, 100, {
    span: 316,
    side: 'right',
    write: (el, prop, v) => { ledger.set(el, prop, v); },
    measure: (el) => (el.style.paddingRight ? 52 : 26),
  });
  eq(plan.pads.length, 2, 'lp-pin: 两行 52 就盖住 100（按折行后的高度累加）');
  eq(plan.covered, 104, 'lp-pin: 累积高度是量出来的');
  eq(plan.stopped, true, 'lp-pin: 盖住就停');
  eq(plan.shortfall, 0, 'lp-pin: 没有缺口');
  eq(lines[0].style.paddingRight, '316px', 'lp-pin: 第一行写了留白');
  eq(lines[1].style.paddingRight, '316px', 'lp-pin: 第二行也写了');
  eq(lines[2].style.paddingRight, undefined, 'lp-pin: 第三行没轮到，一行没写');
  ledger.reset();
  ok(lines[0].style.paddingRight === undefined && lines[1].style.paddingRight === undefined,
    'lp-pin: 账本能把留白一次全收回去');

  /* 高度不够：后面没行可盖，报缺口而不是硬凑 */
  const few = [cmLine(26), cmLine(26)];
  const short = I.planPinnedPads(few, 500, {
    span: 100,
    side: 'right',
    write: () => {},
    measure: () => 26,
  });
  eq(short.pads.length, 2, 'lp-pin: 行用完了就结束，不死循环');
  eq(short.shortfall, 448, 'lp-pin: 缺口如实报出来');
  eq(short.stopped, false, 'lp-pin: 没盖住，不是自然停止');

  /* 行自带 padding：留白要叠在它自己的基准上 */
  const themed = [cmLine(26)];
  const withBase = I.planPinnedPads(themed, 20, {
    span: 316,
    side: 'right',
    write: (el, prop, v) => { el.style[prop] = v; },
    basePad: () => 10,
    measure: () => 26,
  });
  eq(withBase.pads.length, 1, 'lp-pin: 一行就够高');
  eq(themed[0].style.paddingRight, '326px', 'lp-pin: 叠加在主题自己的 padding 上');

  /* 守卫 */
  eq(I.planPinnedPads(lines, 0, { span: 100 }).pads.length, 0, 'lp-pin: 图高 0 → 不规划');
  eq(I.planPinnedPads(lines, 100, { span: 0 }).pads.length, 0, 'lp-pin: 留白宽 0 → 不规划');
  eq(I.planPinnedPads(null, 100, { span: 100 }).pads.length, 0, 'lp-pin: 没有行 → 空');
}


/** 控制器：挂上 / 重算 / 卸载还原 */
function tCssControl() {
  I.flushLivePreviewFloats();
  const tree = cmTreeDirect();
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg });
  ok(!!ctl, 'lp-css-ctl: 挂上了');
  eq(tree.embed.style.height, '60px', 'lp-css-ctl: 挂上即生效（widget 钉成一行）');
  eq(tree.lines[0].style.paddingRight, '416px', 'lp-css-ctl: 后续行留白落地');
  eq(I.livePreviewManagerCount(), 0, 'lp-css-ctl: 没建 manager / 观察者');

  const st = ctl.state();
  eq(st.kind, 'css-float', 'lp-css-ctl: state 标明是哪条路径');
  eq(st.mode, 'direct-embed', 'lp-css-ctl: state 带结构分支');
  eq(st.side, 'right', 'lp-css-ctl: state 带浮动方向');
  eq(st.width, 400, 'lp-css-ctl: state 带宽度');
  eq(st.lineH, 60, 'lp-css-ctl: state 带行高');
  eq(st.imgH, 106, 'lp-css-ctl: state 带图高');
  eq(st.pads, 1, 'lp-css-ctl: state 带留白行数');
  eq(st.covered, 60, 'lp-css-ctl: state 带累积高度');
  eq(st.overflow, 46, 'lp-css-ctl: state 带需要盖住的高度');
  eq(st.attached, true, 'lp-css-ctl: state 说已挂上');

  ctl.update();
  ctl.update();
  eq(tree.embed.style.height, '60px', 'lp-css-ctl: 反复 update 不叠加');
  eq(tree.lines[0].style.paddingRight, '416px', 'lp-css-ctl: 留白也不叠宽');
  eq(tree.lines[1].style.paddingRight, undefined, 'lp-css-ctl: 第二行本来就不该有留白');

  ctl.dispose();
  ok(tree.embed.style.height === undefined, 'lp-css-ctl: 卸载后高度还回去');
  ok(tree.embed.style.maxHeight === undefined, 'lp-css-ctl: 卸载后 max-height 还回去');
  ok(tree.embed.style.position === undefined, 'lp-css-ctl: 卸载后 position 还回去');
  ok(tree.embed.style.margin === undefined, 'lp-css-ctl: 卸载后 margin 还回去');
  ok(tree.lines[0].style.paddingRight === undefined, 'lp-css-ctl: 卸载后留白还回去');
  ok(tree.lines[1].style.paddingRight === undefined, 'lp-css-ctl: 未留白的行一直没被碰');
  ok(tree.host.style.position === undefined, 'lp-css-ctl: 卸载后宿主的绝对定位还回去');
  ok(tree.host.style.maxWidth === undefined, 'lp-css-ctl: 卸载后 max-width 还回去');
  ok(tree.host.style.float === undefined, 'lp-css-ctl: 卸载后宿主的 float 还回去');
  ok(tree.host.style.margin === undefined, 'lp-css-ctl: 卸载后宿主的 margin 还回去');
  ok(tree.host.style.display === undefined, 'lp-css-ctl: 卸载后宿主的 display 还回去');
  eq(ctl.state().attached, false, 'lp-css-ctl: state 说已卸载');

  /* attachFloatWrap 在 direct-embed 结构里也走这条路 */
  const t2 = cmTreeDirect();
  t2.host.closest = (sel) => (sel === '.cm-editor' || sel === '.cm-content' ? t2.content : null);
  const c2 = I.attachFloatWrap(t2.host, { float: 'right' }, { svg: t2.svg });
  ok(!!c2, 'lp-css-ctl: attachFloatWrap 对 direct-embed 有返回');
  eq(t2.embed.style.height, '60px', 'lp-css-ctl: 走的是同一路（widget 钉成一行）');
  eq(t2.lines[0].style.paddingRight, '416px', 'lp-css-ctl: attachFloatWrap 也加留白');
  eq(I.livePreviewManagerCount(), 0, 'lp-css-ctl: attachFloatWrap 也没建 manager');
  if (c2) c2.dispose();
  I.flushLivePreviewFloats();
  eq(I.flushLivePreviewFloats(), 0, 'lp-css-ctl: 收尾后再 flush 是空操作');
}

/** 主题已经写了行内值：要还原成它，不能抹成空 */
function tCssOriginals() {
  I.flushLivePreviewFloats();
  const tree = cmTreeDirect();
  tree.embed.style.float = 'none';
  tree.embed.style.margin = '4px';
  tree.host.style.float = 'right';
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg });
  eq(tree.embed.style.float, 'none', 'lp-css-orig: 明确写成 float:none');
  eq(tree.embed.style.margin, '0', 'lp-css-orig: 覆盖主题写在行内的 margin');
  eq(tree.embed.style.height, '60px', 'lp-css-orig: 高度钉成一行');
  ctl.dispose();
  eq(tree.embed.style.float, 'none', 'lp-css-orig: 还回主题的 float');
  eq(tree.embed.style.margin, '4px', 'lp-css-orig: 还回主题的 margin');
  eq(tree.host.style.float, 'right', 'lp-css-orig: 还回宿主的 float');
}

/** 插件卸载：活着的控制器全部还原 */
function tCssFlushAll() {
  I.flushLivePreviewFloats();
  const a = cmTreeDirect();
  const b = cmTreeDirect();
  const ca = I.attachLivePreviewFloat(a.host, { float: 'right' }, { svg: a.svg });
  const cb = I.attachLivePreviewFloat(b.host, { float: 'left' }, { svg: b.svg });
  ok(!!ca && !!cb, 'lp-css-flush: 两张图都挂上');
  eq(a.host.style.right, '0', 'lp-css-flush: A 贴右');
  eq(b.host.style.left, '0', 'lp-css-flush: B 贴左');
  eq(I.flushLivePreviewFloats(), 2, 'lp-css-flush: 卸载时两个控制器都还原');
  ok(a.embed.style.height === undefined && b.embed.style.height === undefined,
    'lp-css-flush: 两张图的 widget 高度都撤掉');
  ok(a.lines[0].style.paddingRight === undefined && b.lines[0].style.paddingLeft === undefined,
    'lp-css-flush: 两张图的留白也都撤了');
  eq(I.flushLivePreviewFloats(), 0, 'lp-css-flush: 再 flush 不重复动手');
}

/** 新路径的诊断：一次性记齐「widget 高度 / 图 rect / 每行高 / CM6 账」 */
function tCssLog() {
  I.flushLivePreviewFloats();
  I.dbgReset();
  const tree = cmTreeDirect();
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg });
  const text = I.dbgText();
  ok(text.indexOf('"p":"lpf.css"') >= 0, 'lp-css-dbg: 记了 lpf.css 点位');
  ok(text.indexOf('"branch":"css-float"') >= 0, 'lp-css-dbg: 挂载点标了分支');
  ok(text.indexOf('"widget"') >= 0, 'lp-css-dbg: 带 widget 自己的高度口径');
  ok(text.indexOf('"matchesLine":') >= 0, 'lp-css-dbg: 带「widget 高度 == 行高」的判决位');
  ok(text.indexOf('"svg":') >= 0, 'lp-css-dbg: 带 SVG 的 rect');
  ok(text.indexOf('"pads"') >= 0, 'lp-css-dbg: 带每行留白与它的实测高');
  ok(text.indexOf('"cmHeights"') >= 0, 'lp-css-dbg: 带 CM6 账上的高度对比');
  ok(text.indexOf('"contentH"') >= 0, 'lp-css-dbg: 带 content 高度');
  ctl.dispose();
  ok(I.dbgText().indexOf('"p":"lpf.css.dispose"') >= 0, 'lp-css-dbg: 还原也记一点');
  I.flushLivePreviewFloats();
}


/**
 * 行被 CM6 重建（滚出视口再滚回来）后要重算：padding 写在行元素上，行一换就丢。
 * 用注入的假 MutationObserver + 同步定时器，把这条链拉直了验。
 */
function tCssRefresh() {
  I.flushLivePreviewFloats();
  const tree = cmTreeDirect();
  const seen = [];
  class FakeMO {
    constructor(cb) { this.cb = cb; seen.push(this); }
    observe(node, opts) { this.node = node; this.opts = opts; }
    disconnect() { this.dead = true; }
  }
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' }, {
    svg: tree.svg,
    MutationObserver: FakeMO,
    timers: { setTimeout: (fn) => { fn(); return 7; }, clearTimeout: () => {} },
  });
  ok(!!ctl, 'lp-css-refresh: 挂上了');
  const mine = seen.filter((o) => o.node === tree.content && o.opts && o.opts.childList && !o.opts.subtree);
  eq(mine.length, 1, 'lp-css-refresh: 给 .cm-content 挂了一个只看 childList 的观察者');
  eq(ctl.state().observer, true, 'lp-css-refresh: state 里能看到观察者');

  /* 模拟 CM6 换掉第一行：新行没有 padding，文字会压到图上 */
  tree.lines[0].style.paddingRight = undefined;
  const before = seen.length;
  mine[0].cb();
  ok(seen.length === before, 'lp-css-refresh: 重算不会再建观察者');
  eq(tree.lines[0].style.paddingRight, '416px', 'lp-css-refresh: 行被重建后留白回来了');
  eq(tree.embed.style.height, '60px', 'lp-css-refresh: widget 高度也重新钉上');

  ctl.dispose();
  eq(mine[0].dead, true, 'lp-css-refresh: 卸载时断开观察者');
  I.flushLivePreviewFloats();
}

/**
 * planWrappedLines：按「加了留白、真的折行之后」的行高规划（老结构用）。
 * 不经过 applyLivePreviewFloat，直接测这个纯规划函数。
 */
function tWrappedPlan() {
  // 行高随留白变：没留白时一行 25.6，加了 padding 就折成两行 51.2（真实浏览器就是这样）
  const lines = [0, 1, 2, 3, 4].map(() => cmLine(25.6));
  lines.forEach((l) => {
    l.getBoundingClientRect = () => {
      const rows = parseFloat(l.style.paddingRight) > 0 ? 2 : 1;
      const h = 25.6 * rows;
      return { top: 0, left: 0, width: 820, height: h, right: 820, bottom: h };
    };
  });

  const picked = I.planWrappedLines(lines, 106, { span: 316, side: 'right' });
  eq(picked.length, 3, 'lp-wrap: 按折行后的行高规划（不是按挤窄前的 5 行）');

  // 试写量完必须复原：planWrappedLines 自己不写最终留白
  ok(lines[0].style.paddingRight === undefined, 'lp-wrap: 试写后复原第一行');
  ok(lines[3].style.paddingRight === undefined, 'lp-wrap: 图下方那行从来没被写过');

  const pads = I.planLinePads([{ lines: picked, side: 'right', span: 316 }],
    { reader: () => ({ left: 0, right: 0 }) });
  const ledger = I.createStyleLedger();
  I.applyLinePads(pads, ledger);
  eq(lines[0].style.paddingRight, '316px', 'lp-wrap: 重叠行留白');
  eq(lines[2].style.paddingRight, '316px', 'lp-wrap: 最后一行重叠的也留白');
  ok(lines[3].style.paddingRight === undefined, 'lp-wrap: 图下方那行 paddingRight 归零');
  ok(lines[4].style.paddingRight === undefined, 'lp-wrap: 再往下也不留白');
  ledger.reset();

  // 留白没改变高度时，结果与只读规划一致（回归）
  const flat = [0, 1, 2].map(() => cmLine(60));
  eq(I.planWrappedLines(flat, 106, { span: 316, side: 'right' }).length, 2,
    'lp-wrap: 行高不变时还是按原高度算（两行 60 盖住 106）');

  // 行本来就有内联 padding：试写时叠在它上面、复原回原值
  const keep = [0, 1, 2].map(() => cmLine(25.6));
  keep[0].style.paddingRight = '4px';
  keep.forEach((l) => {
    l.getBoundingClientRect = () => {
      const rows = parseFloat(l.style.paddingRight) > 4 ? 2 : 1;
      const h = 25.6 * rows;
      return { top: 0, left: 0, width: 820, height: h, right: 820, bottom: h };
    };
  });
  I.planWrappedLines(keep, 30, { span: 316, side: 'right' });
  eq(keep[0].style.paddingRight, '4px', 'lp-wrap: 行原本的 padding 试写后原样还回去');

  // 拿不到 span / 图高时退回只读规划（数高度，不试写）
  const ro = [0, 1].map(() => cmLine(60));
  eq(I.planWrappedLines(ro, 60, { span: 0, side: 'right' }).length, 1, 'lp-wrap: 没间距就退回只读规划');
  eq(I.planWrappedLines(ro, 0, { span: 316, side: 'right' }).length, 0, 'lp-wrap: 图高 0 → 空');
  ok(ro[0].style.paddingRight === undefined, 'lp-wrap: 只读规划一行都不写');
}

/* ---------------- 销毁 → 重建：不留「样式归零」的时间窗 ------------------ */

/**
 * 模拟 CM6 重建 block widget（老结构）：旧的 embed / host 整体换新，.cm-line
 * 和后面的正文行不动。重置窗口就发生在这中间：旧 widget dispose、新 widget create 之间。
 */
function rebuildEmbed(tree) {
  const embedH = 106;
  const old = { embed: tree.embed, host: tree.host };
  old.embed.isConnected = false;
  old.host.isConnected = false;
  const embed = fakeEl(['cm-embed-block'], embedH,
    { top: 0, left: 0, width: 820, height: embedH, right: 820, bottom: embedH });
  embed.className = 'cm-embed-block markdown-rendered';
  embed.parentElement = tree.line;
  const host = fakeEl([], embedH, { top: 0, left: 0, width: 400, height: embedH, right: 400, bottom: embedH });
  host.parentElement = embed;
  const svg = fakeEl(['brace-map-svg'], embedH,
    { top: 0, left: 0, width: 400, height: embedH, right: 400, bottom: embedH });
  tree.embed = embed;
  tree.host = host;
  tree.svg = svg;
  return tree;
}

/** 数「被赋值了几次」的假样式对象（验证差异写入用） */
function countingStyle(init) {
  const counts = Object.create(null);
  const base = styleObj(init);
  return new Proxy(base, {
    set(target, prop, value) {
      if (typeof prop === 'string' && prop.charAt(0) !== '_') counts[prop] = (counts[prop] || 0) + 1;
      target[prop] = value;
      return true;
    },
    get(target, prop) {
      if (prop === '__counts') return counts;
      return target[prop];
    },
  });
}

/* ------------------------------ 账本：差异写入 / 收尾 ------------------------------ */

function tLedgerDiffWrites() {
  const el = fakeEl([], 0);
  el.style = countingStyle();
  const ledger = I.createStyleLedger();

  eq(ledger.set(el, 'paddingRight', '412px'), true, 'lp-diff: 首次接管一定写');
  eq(el.style.__counts.paddingRight, 1, 'lp-diff: 样式对象被赋值一次');
  eq(ledger.set(el, 'paddingRight', '412px'), false, 'lp-diff: 值没变 → 不写');
  eq(el.style.__counts.paddingRight, 1, 'lp-diff: 值没变时样式对象一次都没再被磰');
  eq(el.style.paddingRight, '412px', 'lp-diff: 不写不代表值不对');
  eq(ledger.set(el, 'paddingRight', '420px'), true, 'lp-diff: 值变了 → 写');
  eq(el.style.__counts.paddingRight, 2, 'lp-diff: 又赋值一次');
  ledger.reset();
  ok(el.style.paddingRight === undefined, 'lp-diff: 复位回到原本没有');
}

function tLedgerSweep() {
  const a = fakeEl([], 0);
  const b = fakeEl([], 0);
  const ledger = I.createStyleLedger();
  ledger.begin();
  ledger.set(a, 'paddingRight', '100px');
  ledger.set(b, 'paddingRight', '200px');
  eq(ledger.size(), 2, 'lp-sweep: 两个元素在记账');

  ledger.begin();                        // 新一轮只认领 a
  ledger.set(a, 'paddingRight', '100px');
  eq(ledger.sweep(), 1, 'lp-sweep: 本轮没认领的那条被还原');
  eq(a.style.paddingRight, '100px', 'lp-sweep: 还在用的不动');
  ok(b.style.paddingRight === undefined, 'lp-sweep: 不再需要的还原');
  eq(ledger.size(), 1, 'lp-sweep: 记账只剩 a');
  eq(ledger.sweep(), 0, 'lp-sweep: 再 sweep 不重复动手');

  ledger.reset();
  ok(a.style.paddingRight === undefined, 'lp-sweep: reset 收尾');
  eq(ledger.size(), 0, 'lp-sweep: 账本清空');
}

function tLedgerClaim() {
  const a = fakeEl([], 0);
  const ledger = I.createStyleLedger();
  ledger.begin();
  ledger.set(a, 'position', 'static');
  ledger.begin();
  eq(ledger.claim(a, 'position'), true, 'lp-claim: 有记账才能续期');
  eq(ledger.sweep(), 0, 'lp-claim: 续期过的不会被 sweep 掉');
  eq(a.style.position, 'static', 'lp-claim: 样式还在');
  eq(ledger.claim(fakeEl([], 0), 'position'), false, 'lp-claim: 没记账 → false');
  eq(ledger.claim(null, 'position'), false, 'lp-claim: 没元素 → false');
  ledger.reset();
  ok(a.style.position === undefined, 'lp-claim: reset 收尾');
}

function tLedgerPrune() {
  const a = fakeEl([], 0);
  const b = fakeEl([], 0);
  b.isConnected = false;
  const ledger = I.createStyleLedger();
  ledger.set(a, 'paddingRight', '1px');
  ledger.set(b, 'paddingRight', '2px');
  eq(ledger.size(), 2, 'lp-prune: 两个在记账');
  eq(ledger.pruneDetached(), 1, 'lp-prune: 只处理脱离文档的');
  eq(ledger.size(), 1, 'lp-prune: 记账剩一个');
  ok(b.style.paddingRight === undefined, 'lp-prune: 脱离文档的那条先把样式还回去再丢记录');
  eq(ledger.reset(), 1, 'lp-prune: 剩下的照常复位');
}

function tPadBaseUnit() {
  const line = cmLine(60);
  line.ownerDocument = { defaultView: { getComputedStyle: () => ({ paddingLeft: '12px', paddingRight: '8px' }) } };
  const ledger = I.createStyleLedger();
  eq(I.padBaseOf(line, ledger, 'paddingRight'), 8, 'lp-base: 没接管时读 computed');
  const reader = I.padReaderOf(ledger);
  eq(reader(line), { left: 12, right: 8 }, 'lp-base: 读取器返回两侧基准');

  const p0 = I.planLinePads([{ lines: [line], side: 'right', span: 400 }], { reader });
  eq(p0[0].right, 408, 'lp-base: 叠在主题留白上');
  I.applyLinePads(p0, ledger);
  eq(line.style.paddingRight, '408px', 'lp-base: 写进行内样式');
  eq(I.padBaseOf(line, ledger, 'paddingRight'), 8, 'lp-base: 接管后基准仍是 8，不是 408');

  const p1 = I.planLinePads([{ lines: [line], side: 'right', span: 400 }], { reader });
  eq(p1[0].right, 408, 'lp-base: 再算一遍不叠宽');
  eq(I.applyLinePads(p1, ledger), 0, 'lp-base: 值没变 → 一条都不写');
  ledger.reset();
  ok(line.style.paddingRight === undefined, 'lp-base: 复位回到没有行内值');
}

/* ------------------------------ 销毁 / 接管 / 复位 ------------------------------ */

function tDisposeDeferred() {
  I.flushLivePreviewFloats();
  const tree = cmTree();
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg });
  ok(!!ctl, 'lp-live: 挂上');
  eq(tree.lines[0].style.paddingRight, '416px', 'lp-live: 挂上就有留白');

  ctl.dispose();
  eq(tree.lines[0].style.paddingRight, '416px', 'lp-live: 销毁后不立即复位（留白仍在）');
  eq(tree.lines[1].style.paddingRight, '416px', 'lp-live: 销毁后第二行留白仍在');
  eq(tree.embed.style.position, 'absolute', 'lp-live: 销毁后图仍在绝对定位上');
  eq(tree.content.style.position, 'relative', 'lp-live: 销毁后包含块还在');
  eq(I.livePreviewManagerCount(), 1, 'lp-live: 待复位期间 manager 没被销毁');

  eq(I.flushLivePreviewFloats(), 1, 'lp-live: 同步收尾一个有活口的 manager');
  ok(tree.lines[0].style.paddingRight === undefined, 'lp-live: 收尾后留白清掉');
  ok(tree.lines[1].style.paddingRight === undefined, 'lp-live: 收尾后第二行也清掉');
  ok(tree.embed.style.position === undefined, 'lp-live: 收尾后定位清掉');
  eq(I.livePreviewManagerCount(), 0, 'lp-live: 收尾后 manager 出清');
}

function tGapFree() {
  I.flushLivePreviewFloats();
  const tree = cmTree();
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg });

  // 一帧一帧地取当场值：销毁 → 旧 embed 脱开 → 新 embed 挂上 → 新控制器接管
  const seen = [];
  const snap = (label) => seen.push([label, tree.lines[0].style.paddingRight]);
  snap('初始帧');
  ctl.dispose();
  snap('销毁之后');
  rebuildEmbed(tree);
  snap('新 widget 还没接管');
  const ctl2 = I.attachLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg });
  snap('接管完成');

  const bad = seen.filter(([, v]) => !(parseFloat(v) > 0));
  ok(bad.length === 0, 'lp-gap: 销毁→重建的四帧里 paddingRight 都不为 0',
    bad.map(([l, v]) => l + '=' + String(v)).join(', '));
  ok(!seen.some(([, v]) => String(v).indexOf('0px') === 0), 'lp-gap: 没有一帧是 0px');
  ok(!!ctl2, 'lp-gap: 新控制器就位');
  eq(tree.embed.style.position, 'absolute', 'lp-gap: 新 embed 也是绝对定位');
  eq(tree.lines[0].style.paddingRight, '416px', 'lp-gap: 留白值没变');
  ctl2.dispose();
  I.flushLivePreviewFloats();
  // 反证：换成「销毁即复位」的老路径，上面那条断言一定挂。证明它真能抓住空档。
  ok(tree.lines[0].style.paddingRight === undefined, 'lp-gap: 反证 —— 立即复位就会归零');
}

function tManagerReuse() {
  I.flushLivePreviewFloats();
  const tree = cmTree();
  for (let i = 0; i < 5; i++) {
    const t = i === 0 ? tree : rebuildEmbed(tree);
    const c = I.attachLivePreviewFloat(t.host, { float: 'right' }, { svg: t.svg });
    ok(!!c, 'lp-reuse: 第 ' + (i + 1) + ' 次挂上');
    eq(I.livePreviewManagerCount(), 1, 'lp-reuse: 第 ' + (i + 1) + ' 次都复用一个 manager');
    c.dispose();
  }
  eq(tree.lines[0].style.paddingRight, '416px', 'lp-reuse: 五轮重建后留白还在');
  I.flushLivePreviewFloats();
  eq(I.livePreviewManagerCount(), 0, 'lp-reuse: 收尾后清零');
}

function tSharedManager() {
  I.flushLivePreviewFloats();
  const content = fakeEl(['cm-content'], 0,
    { top: 0, left: 0, width: 820, height: 2000, right: 820, bottom: 2000 });
  content.clientWidth = 820;

  const mk = (h) => cmLine(h);
  const mkWidgetLine = () => {
    const line = mk(0);
    line.parentElement = content;
    return line;
  };
  const mkEmbed = (line) => {
    const embed = fakeEl(['cm-embed-block'], 106,
      { top: 0, left: 0, width: 820, height: 106, right: 820, bottom: 106 });
    embed.className = 'cm-embed-block markdown-rendered';
    embed.parentElement = line;
    return embed;
  };
  const mkHost = (embed) => {
    const host = fakeEl([], 106, { top: 0, left: 0, width: 400, height: 106, right: 400, bottom: 106 });
    host.parentElement = embed;
    return host;
  };
  const mkSvg = () => fakeEl(['brace-map-svg'], 106,
    { top: 0, left: 0, width: 400, height: 106, right: 400, bottom: 106 });

  /* 结构：content > lineA > embedA，lineA 后面三行；接着 lineB > embedB，后面三行 */
  const lineA = mkWidgetLine();
  const embedA = mkEmbed(lineA);
  const hostA = mkHost(embedA);
  const svgA = mkSvg();
  const linesA = linkChain([mk(60), mk(60), mk(60)]);
  lineA.nextElementSibling = linesA[0];

  const lineB = mkWidgetLine();
  const embedB = mkEmbed(lineB);
  const hostB = mkHost(embedB);
  const svgB = mkSvg();
  const linesB = linkChain([mk(60), mk(60), mk(60)]);
  lineB.nextElementSibling = linesB[0];
  linesA[2].nextElementSibling = lineB;

  const a = I.attachLivePreviewFloat(hostA, { float: 'right' }, { svg: svgA });
  const b = I.attachLivePreviewFloat(hostB, { float: 'right' }, { svg: svgB });
  ok(!!a && !!b, 'lp-share: 两张图都挂上');
  eq(I.livePreviewManagerCount(), 1, 'lp-share: 两张图共用一个 manager（按 .cm-content 归并）');
  eq(linesA[0].style.paddingRight, '416px', 'lp-share: A 的留白');
  eq(linesB[0].style.paddingRight, '416px', 'lp-share: B 的留白');

  b.dispose();
  eq(linesA[0].style.paddingRight, '416px', 'lp-share: 只走掉一张，另一张的留白不动');
  eq(linesA[1].style.paddingRight, '416px', 'lp-share: 另一张的第二行也不动');
  ok(linesB[0].style.paddingRight === undefined, 'lp-share: 走掉那张的留白被收回');
  eq(I.livePreviewManagerCount(), 1, 'lp-share: manager 没被销毁');

  a.dispose();
  eq(linesA[0].style.paddingRight, '416px', 'lp-share: 最后一张走掉也不立即复位');
  I.flushLivePreviewFloats();
  ok(linesA[0].style.paddingRight === undefined, 'lp-share: 收尾后清掉');
  ok(linesB[0].style.paddingRight === undefined, 'lp-share: B 也是');
}

function tPassKeepsPad() {
  I.flushLivePreviewFloats();
  const tree = cmTree();
  // 主题给行 8px 右内边距（computed 视角给一个固定值）
  tree.lines.forEach((l) => {
    l.ownerDocument = { defaultView: { getComputedStyle: () => ({ paddingLeft: '0px', paddingRight: '8px' }) } };
  });
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg });
  eq(tree.lines[0].style.paddingRight, '424px', 'lp-pass: 叠在主题留白上（8 + 416）');
  ctl.update();
  ctl.update();
  eq(tree.lines[0].style.paddingRight, '424px', 'lp-pass: 反复重算不叠宽');
  eq(tree.lines[1].style.paddingRight, '424px', 'lp-pass: 第二行同样稳定');
  ctl.dispose();
  I.flushLivePreviewFloats();
  ok(tree.lines[0].style.paddingRight === undefined, 'lp-pass: 收尾回到没有行内值');
}

function tOnUnloadSync() {
  I.flushLivePreviewFloats();
  const tree = cmTree();
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg, resetDelay: 5000 });
  ok(!!ctl, 'lp-unload: 挂上');
  ctl.dispose();                       // 进待复位；延迟 5 秒，本轮肯定没触发
  eq(tree.lines[0].style.paddingRight, '416px', 'lp-unload: 卸载前留白还在');
  eq(I.livePreviewManagerCount(), 1, 'lp-unload: 卸载前还有待复位的 manager');

  Plugin.prototype.onunload.call({ app: null });

  ok(tree.lines[0].style.paddingRight === undefined, 'lp-unload: onunload 当场同步复位');
  ok(tree.embed.style.position === undefined, 'lp-unload: onunload 当场清掉定位');
  ok(tree.content.style.position === undefined, 'lp-unload: onunload 当场清掉包含块');
  eq(I.livePreviewManagerCount(), 0, 'lp-unload: 不留待复位的 manager');
  eq(I.flushLivePreviewFloats(), 0, 'lp-unload: 卸载后再 flush 是空操作');
}

function tResetAfterDelay() {
  I.flushLivePreviewFloats();
  const tree = cmTree();
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg, resetDelay: 10 });
  ctl.dispose();
  eq(tree.lines[0].style.paddingRight, '416px', 'lp-defer: 延迟期内留白还在');
  eq(I.livePreviewManagerCount(), 1, 'lp-defer: 延迟期内 manager 还在');
  return new Promise((resolve) => setTimeout(() => {
    ok(tree.lines[0].style.paddingRight === undefined, 'lp-defer: 到期且无接管 → 留白复位');
    ok(tree.embed.style.position === undefined, 'lp-defer: 到期后 embed 复位');
    ok(tree.content.style.position === undefined, 'lp-defer: 到期后 content 复位');
    eq(I.livePreviewManagerCount(), 0, 'lp-defer: 到期后 manager 收尾');
    resolve();
  }, 80));
}

function tResetCanceledOnTakeover() {
  I.flushLivePreviewFloats();
  const tree = cmTree();
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg, resetDelay: 10 });
  ok(!!ctl, 'lp-take: 旧控制器挂上');
  ctl.dispose();
  rebuildEmbed(tree);
  const ctl2 = I.attachLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg });
  ok(!!ctl2, 'lp-take: 新控制器挂上');
  eq(I.livePreviewManagerCount(), 1, 'lp-take: 复用的是同一个 manager');
  return new Promise((resolve) => setTimeout(() => {
    eq(tree.lines[0].style.paddingRight, '416px', 'lp-take: 延迟到期也不复位（已被接管）');
    eq(tree.embed.style.position, 'absolute', 'lp-take: 图仍在绝对定位上');
    eq(I.livePreviewManagerCount(), 1, 'lp-take: manager 仍活着');
    ok(ctl2.state().attached === true, 'lp-take: state 说已挂上');
    ctl2.dispose();
    I.flushLivePreviewFloats();
    resolve();
  }, 80));
}

function tDetachedFlush() {
  I.flushLivePreviewFloats();
  const tree = cmTree();
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg, resetDelay: 10 });
  ctl.dispose();
  // 延迟期内用户切走了笔记 / 关了文档：节点脱开，定时器仍要跑完
  tree.content.isConnected = false;
  tree.embed.isConnected = false;
  tree.host.isConnected = false;
  tree.lines.forEach((l) => { l.isConnected = false; });
  return new Promise((resolve) => setTimeout(() => {
    ok(tree.lines[0].style.paddingRight === undefined, 'lp-detach: 节点脱开也照样复位');
    eq(I.livePreviewManagerCount(), 0, 'lp-detach: 不留 manager / 定时器');
    resolve();
  }, 80));
}

function tDeferLogs() {
  I.flushLivePreviewFloats();
  I.dbgReset();
  const tree = cmTree();
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg });
  ctl.dispose();
  ok(I.dbgText().indexOf('lpf.reset.deferred') >= 0, 'lp-dbg: 排上延迟复位时记了点');

  rebuildEmbed(tree);
  const ctl2 = I.attachLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg });
  ok(I.dbgText().indexOf('lpf.reset.canceled') >= 0, 'lp-dbg: 接管时记了取消');
  const creates = I.dbgText().split('\n').filter((s) => s.indexOf('manager.create') >= 0).length;
  eq(creates, 1, 'lp-dbg: 一次销毁重建只创建一个 manager（以前是 create+create）');

  ctl2.dispose();
  I.flushLivePreviewFloats();
  ok(I.dbgText().indexOf('lpf.reset.flushed') >= 0, 'lp-dbg: 复位落定也记了点');
}

/* ------------------------------ 裁剪链（图为什么看不见） ------------------------------ */

/**
 * 给假元素挂一份 computed 样式。读的时候先看行内（我们写下去的值），再看基线：
 * 这样「写 !important 之后 computed 变成 visible」这件事在假 DOM 里也能成立。
 */
function withComputed(el, cs) {
  el.__cs = cs || {};
  el.ownerDocument = {
    defaultView: {
      innerWidth: 1200,
      innerHeight: 800,
      getComputedStyle: (n) => {
        const base = (n && n.__cs) || {};
        const inline = (n && n.style) || {};
        const out = {};
        for (const k of Object.keys(base)) out[k] = base[k];
        for (const k of Object.keys(inline)) {
          if (typeof inline[k] === 'string' && inline[k] !== '') out[k] = inline[k];
        }
        return out;
      },
    },
  };
  return el;
}

/**
 * 复刻真机上的裁剪现场（Obsidian 1.13.7 + Blue Topaz）：
 *
 *   .cm-scroller(overflow:auto，滚动容器)
 *     > .cm-content(overflow:hidden —— 主题写的)
 *       > .cm-embed-block(contain:paint —— 内核写的，!important)
 *         > .block-language-brace(overflow:hidden —— 中间层)
 *           > host（图，绝对定位）
 *
 * 这就是「SVG 在 DOM 里、尺寸正常、整张看不见」的布局证据：
 * 任意一层都足以把溢出到下一行的图切掉，而三层同时存在是常态。
 */
function clippedTree() {
  const tree = cmTreeDirect();
  const embed = tree.embed;
  const content = tree.content;

  const wrap = fakeEl(['markdown-rendered'], 26,
    { top: 0, left: 0, width: 820, height: 26, right: 820, bottom: 26 });
  wrap.parentElement = embed;
  tree.host.parentElement = wrap;

  const scroller = fakeEl(['cm-scroller'], 0,
    { top: 0, left: 0, width: 820, height: 800, right: 820, bottom: 800 });
  content.parentElement = scroller;

  withClass(wrap, ['markdown-rendered']);
  withClass(embed, ['cm-embed-block', 'markdown-rendered']);
  withClass(content, ['cm-content']);
  withClass(scroller, ['cm-scroller']);
  withClass(tree.host, ['block-language-brace']);

  const clipAll = (o) => Object.assign({
    overflow: 'hidden', overflowX: 'hidden', overflowY: 'hidden', position: 'static',
    transform: 'none', contain: 'none', clipPath: 'none', contentVisibility: 'visible',
  }, o);

  withComputed(wrap, clipAll());
  withComputed(embed, clipAll({ overflow: 'visible', overflowX: 'visible', overflowY: 'visible',
    position: 'relative', contain: 'paint', height: '26px' }));
  withComputed(content, clipAll());
  withComputed(scroller, clipAll({ overflow: 'auto', overflowX: 'auto', overflowY: 'auto' }));
  withComputed(tree.host, clipAll({ overflow: 'visible', overflowX: 'visible', overflowY: 'visible' }));
  withComputed(tree.svg, { display: 'block', visibility: 'visible', opacity: '1' });

  return { tree, embed, content, wrap, scroller };
}

/** 裁剪链体检：谁在裁、裁的是哪一条、链子走到哪儿停 */
function tClipChain() {
  ok(I.containClips('paint') && I.containClips('content') && I.containClips('strict'),
    'lp-clip: contain 的 paint / content / strict 都算裁');
  ok(!I.containClips('layout') && !I.containClips('none') && !I.containClips(''),
    'lp-clip: layout / none / 空都不算裁（layout 不裁溢出）');
  ok(I.overflowClips('hidden') && I.overflowClips('clip') && I.overflowClips('auto')
    && I.overflowClips('scroll'), 'lp-clip: 会裁的 overflow 取值');
  ok(!I.overflowClips('visible') && !I.overflowClips(''), 'lp-clip: visible / 读不到都不算裁');

  const { tree, content, scroller } = clippedTree();

  const chain = I.clipChainOf(tree.host, null, {});
  eq(chain[0].node, tree.host, 'lp-clip: 链子第一条是宿主自己（宿主也可能被裁）');
  eq(chain[1].info.el, 'div.markdown-rendered', 'lp-clip: 链子上有中间层');
  eq(chain[chain.length - 1].info.el, 'div.cm-scroller', 'lp-clip: 一直走到 .cm-scroller');
  eq(chain[chain.length - 1].info.hard, true, 'lp-clip: .cm-scroller 标成硬边界');
  eq(chain[chain.length - 1].node, scroller, 'lp-clip: 硬边界就是那个滚动容器');

  const stop = I.clipChainOf(tree.host, content, {});
  eq(stop[stop.length - 1].node, content, 'lp-clip: 给了 stop 就停在 .cm-content');
  ok(stop.every((x) => x.info.el.indexOf('cm-scroller') < 0), 'lp-clip: 到 .cm-content 为止，往上不进链');

  const why = {};
  for (const x of chain) why[x.info.el] = x.info.why.join('+');
  eq(why['div.cm-embed-block.markdown-rendered'], 'contain', 'lp-clip: widget 的锅是 contain');
  eq(why['div.cm-content'], 'overflow', 'lp-clip: .cm-content 的锅是 overflow');
  eq(why['div.markdown-rendered'], 'overflow', 'lp-clip: 中间层的锅是 overflow');
  eq(why['div.block-language-brace'], '', 'lp-clip: 宿主自己没在裁（浮动时它已经是 visible）');

  /* 施加前的判决必须是「被裁了」——这正是真机上发生的事 */
  const before = I.visibilityReport(tree.host, tree.svg, content, {});
  eq(before.verdict, 'clipped', 'lp-clip: 施加前判决是 clipped');
  ok(before.clipCount >= 3, 'lp-clip: 至少三层在裁');
  ok(before.reason.indexOf('contain') >= 0, 'lp-clip: 责任层里点名 contain');
  eq(before.host.inViewport, true, 'lp-clip: 宿主在视口内（不是跑偏）');
  eq(before.svg.inViewport, true, 'lp-clip: 图也在视口内');
  eq(before.svg.display, 'block', 'lp-clip: 图没被 display:none 藏起来');

  /* 没 computed 可读（假 DOM / 读不到样式）：一个字符都不写 */
  const blind = cmTreeDirect();
  eq(I.openClipChain(blind.host, blind.content, {}).wrote.length, 0,
    'lp-clip: 读不到 computed 就什么都不写（不乱动主题）');

  /* 另一类「看不见」：链上没有裁，但主题把容器淡成 opacity: 0 */
  const faded = clippedTree();
  const open = { overflow: 'visible', overflowX: 'visible', overflowY: 'visible',
    position: 'static', transform: 'none', contain: 'none', clipPath: 'none',
    visibility: 'visible', opacity: '1' };
  withComputed(faded.wrap, open);
  withComputed(faded.embed, Object.assign({}, open, { position: 'relative' }));
  withComputed(faded.content, Object.assign({}, open, { opacity: '0' }));
  const fadedRep = I.visibilityReport(faded.tree.host, faded.tree.svg, faded.content, {});
  eq(fadedRep.verdict, 'hidden', 'lp-clip: 容器被淡出 → 判决 hidden（不是 clipped）');
  ok(fadedRep.reason.indexOf('opacity') >= 0, 'lp-clip: 责任层点名 opacity');
  I.applyLivePreviewCssFloat(faded.tree.host, { float: 'right' }, { svg: faded.tree.svg });
  eq(faded.content.style.opacity, '1', 'lp-clip: 被淡出的层拉回 opacity: 1');
  eq(faded.content.style.__important.opacity, 'important', 'lp-clip: opacity 也带 !important');
}

/** 自动修正：A 逐层放开裁剪 + B 包含块保险，并且 .cm-scroller 一个字节都不碰 */
function tClipFix() {
  const { tree, embed, content, wrap, scroller } = clippedTree();

  const rec = I.applyLivePreviewCssFloat(tree.host, { float: 'right' }, { svg: tree.svg });
  ok(!!rec, 'lp-clip-fix: 裁剪现场下照样施加');

  /* A：中间层与 .cm-content 的 overflow 被放开，且带 !important */
  eq(wrap.style.overflow, 'visible', 'lp-clip-fix: 中间层的 overflow 放开');
  eq(wrap.style.__important.overflow, 'important', 'lp-clip-fix: 放开带 !important（压主题）');
  eq(content.style.overflow, 'visible', 'lp-clip-fix: .cm-content 的 overflow 也放开');
  eq(content.style.__important.overflow, 'important', 'lp-clip-fix: .cm-content 也带 !important');

  /* A：widget 的 contain 抹掉——内核写的就是 !important，只有行内 !important 压得住 */
  eq(embed.style.contain, 'none', 'lp-clip-fix: widget 的 contain 抹成 none');
  eq(embed.style.__important.contain, 'important', 'lp-clip-fix: contain 也是 !important');

  /* B：包含块保险 */
  eq(embed.style.position, 'relative', 'lp-clip-fix: widget 当包含块');
  eq(embed.style.__important.position, 'important',
    'lp-clip-fix: position 带 !important（主题写 static !important 也压得住）');

  /* 悬停时的内核规则（非 !important 的 overflow: hidden）打不过行内 !important */
  eq(embed.style.__important.overflow, 'important', 'lp-clip-fix: hover 也保不住那张图（行内 !important 压住）');

  /* 硬边界：滚动容器绝不动 */
  eq(scroller.style.overflow, undefined, 'lp-clip-fix: .cm-scroller 的 overflow 一个字不碰');
  eq(scroller.style.__important.overflow, undefined, 'lp-clip-fix: .cm-scroller 连 !important 都没写过');

  /* 放开之后图应该看得见：判决 ok、链上零裁剪 */
  eq(rec.vis.verdict, 'ok', 'lp-clip-fix: 放开后判决是 ok（图可见）');
  eq(rec.vis.clipCount, 0, 'lp-clip-fix: 链上不再有在裁的层');
  ok(rec.clip.wrote.length >= 3, 'lp-clip-fix: 至少写了三条（wrapper / widget / content）');
  eq(rec.clip.stop, 'div.cm-content', 'lp-clip-fix: 修正范围到 .cm-content 为止');

  /* 回到原位：卸载时这些样式都要还回去，不能留下脏 inline */
  I.restoreStyles(rec.styles);
  eq(wrap.style.overflow, undefined, 'lp-clip-fix: 还原中间层（交还给主题）');
  eq(embed.style.contain, undefined, 'lp-clip-fix: 还原 widget 的 contain');
  eq(embed.style.position, undefined, 'lp-clip-fix: 还原 widget 的 position');
  eq(content.style.overflow, undefined, 'lp-clip-fix: 还原 .cm-content 的 overflow');

  /* 什么都不裁的结构：一条样式都不写（不能顺手改造好页面） */
  const clean = clippedTree();
  withComputed(clean.wrap, { overflow: 'visible', overflowX: 'visible', overflowY: 'visible',
    position: 'static', transform: 'none', contain: 'none', clipPath: 'none' });
  withComputed(clean.embed, { overflow: 'visible', overflowX: 'visible', overflowY: 'visible',
    position: 'relative', transform: 'none', contain: 'none', clipPath: 'none' });
  withComputed(clean.content, { overflow: 'visible', overflowX: 'visible', overflowY: 'visible',
    position: 'static', transform: 'none', contain: 'none', clipPath: 'none' });
  const rec2 = I.applyLivePreviewCssFloat(clean.tree.host, { float: 'right' }, { svg: clean.tree.svg });
  ok(!!rec2, 'lp-clip-fix: 干净结构照样施加');
  eq(rec2.clip.wrote, [], 'lp-clip-fix: 没有裁剪就不写任何裁剪样式');
  ok(clean.wrap.style.overflow === undefined && clean.content.style.overflow === undefined,
    'lp-clip-fix: 干净结构的中间层与 .cm-content 保持原样');
  eq(rec2.vis.verdict, 'ok', 'lp-clip-fix: 干净结构判决 ok');

  /*
   * 走控制器（真机上就是这条）再验一次：日志里要能直接读出「判决 + 责任层」，
   * 并且卸载时中间层也要原样还回去。
   */
  I.flushLivePreviewFloats();
  const t3 = clippedTree();
  const ctl = I.attachLivePreviewFloat(t3.tree.host, { float: 'right' }, { svg: t3.tree.svg });
  ok(!!ctl, 'lp-clip-fix: 控制器挂上了');
  const st = ctl.state();
  eq(st.vis, 'ok', 'lp-clip-fix: state 里能看到可见性判决');
  ok(st.clipFixed >= 3, 'lp-clip-fix: state 里能看到放开了几层');
  const log = I.dbgText();
  ok(log.indexOf('"vis":"ok') >= 0, 'lp-clip-fix: 日志里记了可见性判决（施加后是 ok）');
  ok(log.indexOf(':contain') >= 0, 'lp-clip-fix: 日志点名了 contain 那一层（定罪依据）');
  ok(log.indexOf('wrote') >= 0, 'lp-clip-fix: 日志带放开了哪几条');
  ctl.dispose();
  eq(t3.wrap.style.overflow, undefined, 'lp-clip-fix: 卸载后中间层的 overflow 还回去');
  eq(t3.embed.style.contain, undefined, 'lp-clip-fix: 卸载后 contain 也还回去');
  I.flushLivePreviewFloats();
}

suite('live-float-lines', () => { tPlanLinesGuard(); tPlanLinesBasic(); tPlanLinesEdge(); });
suite('live-float-pads', () => { tPlanPadsBasic(); tPlanPadsMerge(); tPlanPadsGuard(); tApplyPadsWrite(); tPadSurvivesBadRect(); tLedger(); });
suite('live-float-dom', () => { tParts(); tClassHelpers(); tApplyGeometry(); tApplyGuards(); });
suite('live-float-reset', () => { tResetThorough(); tAttach(); });
suite('live-float-direct', () => {
  tDirectParts(); tDirectCandidates(); tWrappedPlan();
});
suite('live-float-css', () => {
  tOneLineHeight(); tPinnedPads();
  tCssApply(); tCssGuards(); tCssControl(); tCssRefresh(); tCssOriginals(); tCssFlushAll(); tCssLog();
});
suite('live-float-clip', () => { tClipChain(); tClipFix(); });
suite('live-float-ledger', () => {
  tLedgerDiffWrites(); tLedgerSweep(); tLedgerClaim(); tLedgerPrune(); tPadBaseUnit();
});
suite('live-float-dispose', () => {
  tDisposeDeferred(); tGapFree(); tManagerReuse(); tSharedManager(); tPassKeepsPad(); tDeferLogs();
});
suite('live-float-deferred', async () => {
  await tResetAfterDelay();
  await tResetCanceledOnTakeover();
  await tDetachedFlush();
  tOnUnloadSync();
});
