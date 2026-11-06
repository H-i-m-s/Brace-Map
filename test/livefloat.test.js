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

const { I, ok, eq, suite } = require('./framework');

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
  ok(tree.embed.style.position === undefined, 'lp-ctl: 卸载后 embed 复位');
  ok(tree.content.style.position === undefined, 'lp-ctl: 卸载后 content 复位');
  ok(tree.line.style.position === undefined, 'lp-ctl: 卸载后行复位');
  ok(tree.lines[0].style.paddingRight === undefined, 'lp-ctl: 卸载后留白复位');

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
}

suite('live-float-lines', () => { tPlanLinesGuard(); tPlanLinesBasic(); tPlanLinesEdge(); });
suite('live-float-pads', () => { tPlanPadsBasic(); tPlanPadsMerge(); tPlanPadsGuard(); tApplyPadsWrite(); tLedger(); });
suite('live-float-dom', () => { tParts(); tClassHelpers(); tApplyGeometry(); tApplyGuards(); });
suite('live-float-reset', () => { tResetThorough(); tAttach(); });
