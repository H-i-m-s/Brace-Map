'use strict';

/* ============================================================
 * livefloat.test.js · 实时预览（CM6）浮动的纯逻辑
 *
 * Live Preview 里正文被切成一个个 .cm-line，widget 浮在自己那行，后面的行跟它
 * 没有兄弟关系 —— 阅读视图那套「给后续兄弟加外边距」对它无效。做法变成：
 * widget 相对 .cm-content 绝对定位 + 给重叠到的行加 padding。
 *
 * 真实布局只能靠浏览器验，这里测能用假 DOM 判定的几件事：
 *   1. planLivePreviewLines：该给哪些行留白
 *   2. planLinePads：多张图压到同一行时取最大值、不叠加
 *   3. applyLivePreviewFloat + 账本：施加、重复施加、复位是否彻底
 *   4. 几个「不该动手」的守卫
 * ============================================================ */

const { I, Plugin, ok, eq, suite } = require('./framework');

/* ------------------------------ 假 DOM ------------------------------ */

/** 极简 style：普通对象 + removeProperty（模拟 CSSStyleDeclaration） */
function styleObj(init) {
  const s = Object.assign({}, init || {});
  s.__removed = [];
  s.removeProperty = (p) => {
    s.__removed.push(p);
    delete s[p.replace(/-([a-z])/g, (m, c) => c.toUpperCase())];
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

function tDirectApply() {
  const tree = cmTreeDirect();
  const ledger = I.createStyleLedger();
  const rec = applyAll(tree.host, { float: 'right' }, { svg: tree.svg, ledger });
  ok(!!rec, 'lp-direct: 新结构能施加（旧代码在这里一个样式都不写）');
  eq(rec.mode, 'direct-embed', 'lp-direct: 结果里带分支名');
  ok(rec.line === tree.embed, 'lp-direct: 结果是拿 embed 当行算的');
  eq(rec.width, 400, 'lp-direct: 图宽取 SVG 渲染宽');
  eq(rec.height, 106, 'lp-direct: 图高取真实渲染高');
  eq(rec.span, 416, 'lp-direct: 留白 = 图宽 + 间距');
  eq(rec.lines.length, 2, 'lp-direct: 图高 106 盖住两行 60');

  eq(tree.embed.style.position, 'absolute', 'lp-direct: embed 脱离流（中间的 static 被绝对定位接管）');
  eq(tree.content.style.position, 'relative', 'lp-direct: content 成为包含块');
  eq(tree.embed.style.top, '0px', 'lp-direct: top 沿用流里的原位置');
  eq(tree.embed.style.right, '0px', 'lp-direct: 贴住右边');
  eq(tree.embed.style.left, 'auto', 'lp-direct: 另一侧归零');
  eq(tree.embed.style.width, '400px', 'lp-direct: 宽度落到行内样式');
  eq(tree.embed.style.margin, '0', 'lp-direct: 清掉外边距');

  ok(ledger.props(tree.embed).indexOf('position') >= 0, 'lp-direct: embed 的 position 走了账本（它当行用）');
  eq(tree.lines[0].style.paddingRight, '416px', 'lp-direct: 第一行留白 416');
  eq(tree.lines[1].style.paddingRight, '416px', 'lp-direct: 第二行留白 416');
  eq(tree.lines[2].style.paddingRight, undefined, 'lp-direct: 图下面那行 paddingRight 归零');

  const n = ledger.reset();
  ok(n > 0, 'lp-direct: 复位有动作');
  ok(tree.embed.style.position === undefined, 'lp-direct: 复位把 embed 的位置还回去');
  ok(tree.content.style.position === undefined, 'lp-direct: 复位把 content 的位置还回去');
  ok(tree.lines[0].style.paddingRight === undefined, 'lp-direct: 复位把第一行留白清掉');
  ok(tree.lines[1].style.paddingRight === undefined, 'lp-direct: 复位把第二行留白清掉');

  // 左浮动镜像
  const left = cmTreeDirect();
  const lrec = applyAll(left.host, { float: 'left' }, { svg: left.svg });
  ok(!!lrec && lrec.mode === 'direct-embed', 'lp-direct: 左浮动同样走回退');
  eq(left.embed.style.left, '0px', 'lp-direct: 左浮动贴左边');
  eq(left.embed.style.right, 'auto', 'lp-direct: 左浮动的另一侧归零');
  eq(left.lines[1].style.paddingLeft, '416px', 'lp-direct: 左浮动给行加 paddingLeft');
  eq(left.lines[2].style.paddingLeft, undefined, 'lp-direct: 左浮动下图下方那行不留白');

  // cfg.width 优先
  const cfgW = cmTreeDirect();
  const wrec = I.applyLivePreviewFloat(cfgW.host, { float: 'right', width: 300 }, { svg: cfgW.svg });
  eq(wrec.width, 300, 'lp-direct: cfg.width 优先');
  eq(wrec.span, 316, 'lp-direct: 留白跟着配置宽走');
}

function tDirectGuards() {
  // 后面一行正文都没有：保留放弃逻辑，避免图被裁、scroll 高度塔缩
  const solo = cmTreeDirect({ lineHeights: [] });
  eq(I.applyLivePreviewFloat(solo.host, { float: 'right' }, {}), null,
    'lp-direct: 后面没有正文行 → 直接放弃');
  ok(solo.embed.style.position === undefined, 'lp-direct: 放弃时 embed 一点样式都不写');
  ok(solo.content.style.position === undefined, 'lp-direct: 放弃时 content 也不动');

  // 兄弟只有 .cm-gap / 另一个 widget：也算没有行
  const gapOnly = cmTreeDirect({ lineHeights: [] });
  gapOnly.embed.nextElementSibling = withClass(fakeEl(['cm-gap'], 12), ['cm-gap']);
  eq(I.applyLivePreviewFloat(gapOnly.host, { float: 'right' }, {}), null,
    'lp-direct: 兄弟只有 .cm-gap → 同样放弃');

  const widgetOnly = cmTreeDirect({ lineHeights: [] });
  widgetOnly.embed.nextElementSibling = withClass(fakeEl(['cm-embed-block'], 40), ['cm-embed-block']);
  eq(I.applyLivePreviewFloat(widgetOnly.host, { float: 'right' }, {}), null,
    'lp-direct: 兄弟只有另一个 widget → 同样放弃');

  // center / inline 在新结构里也不动
  const cn = cmTreeDirect();
  eq(I.applyLivePreviewFloat(cn.host, { float: 'center' }, {}), null, 'lp-direct: center 不处理');
  ok(cn.embed.style.position === undefined, 'lp-direct: center 时一点样式都不写');
}

function tWrappedPlan() {
  // 行高随留白变：没留白时一行 25.6，加了 padding 就折成两行 51.2（真实浏览器就是这样）
  const tree = cmTreeDirect({ lineHeights: [25.6, 25.6, 25.6, 25.6, 25.6] });
  tree.lines.forEach((l) => {
    l.getBoundingClientRect = () => {
      const rows = parseFloat(l.style.paddingRight) > 0 ? 2 : 1;
      const h = 25.6 * rows;
      return { top: 0, left: 0, width: 820, height: h, right: 820, bottom: h };
    };
  });

  const rec = I.applyLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg });
  ok(!!rec, 'lp-wrap: 能施加');
  eq(rec.lines.length, 3, 'lp-wrap: 按折行后的行高规划（不是按挤窄前的 5 行）');

  // 试写量完必须复原：applyLivePreviewFloat 自己不写最终留白
  ok(tree.lines[0].style.paddingRight === undefined, 'lp-wrap: 试写后复原第一行');
  ok(tree.lines[3].style.paddingRight === undefined, 'lp-wrap: 图下方那行从来没被写过');

  const pads = I.planLinePads([{ lines: rec.lines, side: rec.side, span: rec.span }],
    { reader: () => ({ left: 0, right: 0 }) });
  I.applyLinePads(pads, rec.ledger);
  eq(tree.lines[0].style.paddingRight, '416px', 'lp-wrap: 重叠行留白');
  eq(tree.lines[2].style.paddingRight, '416px', 'lp-wrap: 最后一行重叠的也留白');
  ok(tree.lines[3].style.paddingRight === undefined, 'lp-wrap: 图下方那行 paddingRight 归零');
  ok(tree.lines[4].style.paddingRight === undefined, 'lp-wrap: 再往下也不留白');

  // 留白没改变高度时，结果与只读规划一致（回归）
  const flat = cmTreeDirect();
  const frec = I.applyLivePreviewFloat(flat.host, { float: 'right' }, { svg: flat.svg });
  eq(frec.lines.length, 2, 'lp-wrap: 行高不变时还是按原高度算（两行 60 盖住 106）');

  // 行本来就有内联 padding：试写时叠上去、复原回原值
  const keep = cmTreeDirect({ lineHeights: [25.6, 25.6, 25.6] });
  keep.lines[0].style.paddingRight = '4px';
  keep.lines.forEach((l) => {
    l.getBoundingClientRect = () => {
      const rows = parseFloat(l.style.paddingRight) > 4 ? 2 : 1;
      const h = 25.6 * rows;
      return { top: 0, left: 0, width: 820, height: h, right: 820, bottom: h };
    };
  });
  I.applyLivePreviewFloat(keep.host, { float: 'right' }, { svg: keep.svg });
  eq(keep.lines[0].style.paddingRight, '4px', 'lp-wrap: 行原本的 padding 试写后原样还回去');
}

/* ---------------- 销毁 → 重建：不留「样式归零」的时间窗 ------------------ */

/**
 * 模拟 CM6 重建 block widget：旧的 embed / host 整体换新，.cm-content 和后续行不动。
 * 重置窗口就发生在这中间：旧 widget dispose、新 widget create 之间。
 */
function rebuildDirectEmbed(tree) {
  const embedH = 106;
  const old = { embed: tree.embed, host: tree.host };
  old.embed.isConnected = false;
  old.host.isConnected = false;
  const embed = fakeEl(['cm-embed-block'], embedH,
    { top: 0, left: 0, width: 820, height: embedH, right: 820, bottom: embedH });
  embed.className = 'cm-embed-block markdown-rendered';
  embed.parentElement = tree.content;
  const host = fakeEl([], embedH, { top: 0, left: 0, width: 400, height: embedH, right: 400, bottom: embedH });
  host.parentElement = embed;
  const svg = fakeEl(['brace-map-svg'], embedH,
    { top: 0, left: 0, width: 400, height: embedH, right: 400, bottom: embedH });
  embed.nextElementSibling = tree.lines[0] || null;
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
  const tree = cmTreeDirect();
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
  const tree = cmTreeDirect();
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg });

  // 一帧一帧地取当场值：销毁 → 旧 embed 脱开 → 新 embed 挂上 → 新控制器接管
  const seen = [];
  const snap = (label) => seen.push([label, tree.lines[0].style.paddingRight]);
  snap('初始帧');
  ctl.dispose();
  snap('销毁之后');
  rebuildDirectEmbed(tree);
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
  const tree = cmTreeDirect();
  for (let i = 0; i < 5; i++) {
    const t = i === 0 ? tree : rebuildDirectEmbed(tree);
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
  const linesA = linkChain([mk(60), mk(60), mk(60)]);
  const linesB = linkChain([mk(60), mk(60), mk(60)]);
  const mkEmbed = () => {
    const embed = fakeEl(['cm-embed-block'], 106,
      { top: 0, left: 0, width: 820, height: 106, right: 820, bottom: 106 });
    embed.className = 'cm-embed-block markdown-rendered';
    embed.parentElement = content;
    return embed;
  };
  const mkHost = (embed) => {
    const host = fakeEl([], 106, { top: 0, left: 0, width: 400, height: 106, right: 400, bottom: 106 });
    host.parentElement = embed;
    return host;
  };
  const mkSvg = () => fakeEl(['brace-map-svg'], 106,
    { top: 0, left: 0, width: 400, height: 106, right: 400, bottom: 106 });

  const embedA = mkEmbed();
  const hostA = mkHost(embedA);
  const svgA = mkSvg();
  const embedB = mkEmbed();
  const hostB = mkHost(embedB);
  const svgB = mkSvg();

  // 兄弟链：embedA → A 的三行 → embedB → B 的三行
  embedA.nextElementSibling = linesA[0];
  linesA[2].nextElementSibling = embedB;
  embedB.nextElementSibling = linesB[0];

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
  const tree = cmTreeDirect();
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
  const tree = cmTreeDirect();
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
  const tree = cmTreeDirect();
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
  const tree = cmTreeDirect();
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg, resetDelay: 10 });
  ok(!!ctl, 'lp-take: 旧控制器挂上');
  ctl.dispose();
  rebuildDirectEmbed(tree);
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
  const tree = cmTreeDirect();
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
  const tree = cmTreeDirect();
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg });
  ctl.dispose();
  ok(I.dbgText().indexOf('lpf.reset.deferred') >= 0, 'lp-dbg: 排上延迟复位时记了点');

  rebuildDirectEmbed(tree);
  const ctl2 = I.attachLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg });
  ok(I.dbgText().indexOf('lpf.reset.canceled') >= 0, 'lp-dbg: 接管时记了取消');
  const creates = I.dbgText().split('\n').filter((s) => s.indexOf('manager.create') >= 0).length;
  eq(creates, 1, 'lp-dbg: 一次销毁重建只创建一个 manager（以前是 create+create）');

  ctl2.dispose();
  I.flushLivePreviewFloats();
  ok(I.dbgText().indexOf('lpf.reset.flushed') >= 0, 'lp-dbg: 复位落定也记了点');
}

suite('live-float-lines', () => { tPlanLinesGuard(); tPlanLinesBasic(); tPlanLinesEdge(); });
suite('live-float-pads', () => { tPlanPadsBasic(); tPlanPadsMerge(); tPlanPadsGuard(); tApplyPadsWrite(); tLedger(); });
suite('live-float-dom', () => { tParts(); tClassHelpers(); tApplyGeometry(); tApplyGuards(); });
suite('live-float-reset', () => { tResetThorough(); tAttach(); });
suite('live-float-direct', () => {
  tDirectParts(); tDirectCandidates(); tDirectApply(); tDirectGuards(); tWrappedPlan();
});
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
