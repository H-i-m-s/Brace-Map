'use strict';

/* ============================================================
 * valoverlay.test.js · valign 对齐标记覆盖层
 *
 * 这里只验「东西有没有画出来、画对没画对、关掉后有没有收拾干净」，
 * 不验布局本身（那靠真机截图）。
 *
 * 覆盖的点：
 *   - show 之后 body 下多出几个元素，id / 位置 / 层级对不对
 *   - 红线在宿主当前顶边、绿线在「当前顶 + 算出的偏移」
 *   - 标签三行的内容；not-ready 时第三行换成 → not-ready，绿线变虚线
 *   - 总览面板的四个计数
 *   - 宿主一点都没被碰（没加类、没插 DOM、没写样式）
 *   - Esc 关掉、再点一次命令关掉、hide 后元素全没
 *   - 开着的时候再 show 不会叠加
 * ============================================================ */

const { I, ok, eq, suite } = require('./framework');

const VO = I.valoverlay;

/* ------------------------------ 最小 DOM 桩 ------------------------------ */

function fakeNode(doc) {
  const node = {
    tagName: 'DIV',
    id: '',
    className: '',
    style: {},
    textContent: '',
    children: [],
    parentNode: null,
    offsetWidth: 240,
    appendChild(c) {
      if (c.parentNode && typeof c.parentNode.removeChild === 'function') {
        c.parentNode.removeChild(c);
      }
      c.parentNode = node;
      node.children.push(c);
      return c;
    },
    removeChild(c) {
      const at = node.children.indexOf(c);
      if (at >= 0) node.children.splice(at, 1);
      c.parentNode = null;
      return c;
    },
    remove() {
      if (node.parentNode) node.parentNode.removeChild(node);
    },
  };
  return node;
}

/** 只实现覆盖层用到的那几样：body / createElement / querySelectorAll / 事件 */
function fakeDoc(hosts) {
  const doc = {
    body: null,
    _hosts: hosts || [],
    _listeners: [],
    defaultView: null,                 // 没有 rAF：只画一帧，不排循环
    createElement: () => fakeNode(doc),
    querySelectorAll: () => doc._hosts,
    addEventListener: (type, fn, capture) => { doc._listeners.push({ type, fn, capture }); },
    removeEventListener: (type, fn, capture) => {
      const at = doc._listeners.findIndex((l) => l.type === type && l.fn === fn && !!l.capture === !!capture);
      if (at >= 0) doc._listeners.splice(at, 1);
    },
    fireKey: (key) => {
      for (const l of doc._listeners.slice()) {
        if (l.type === 'keydown') l.fn({ key, preventDefault() {} });
      }
    },
  };
  doc.body = fakeNode(doc);
  return doc;
}

function countNodes(node) {
  let n = 1;
  for (const c of (node.children || [])) n += countNodes(c);
  return n;
}

function findById(node, id) {
  if (node.id === id) return node;
  for (const c of (node.children || [])) {
    const hit = findById(c, id);
    if (hit) return hit;
  }
  return null;
}

/**
 * 一个宿主桩。probe 是「函数会量到什么」，cfg 是它的配置。
 * inEditor=false 时 closest('.cm-content') 返回 null（阅读视图那种）。
 */
function fakeHost(o) {
  const opt = o || {};
  const left = opt.left == null ? 20 : opt.left;
  const top = opt.top == null ? 100 : opt.top;
  const width = opt.width == null ? 300 : opt.width;
  const height = opt.height == null ? 150 : opt.height;
  const cls = (opt.cls || ['bm-floated']).slice();
  return {
    style: { marginTop: opt.marginTop || '' },
    classList: { contains: (c) => cls.indexOf(c) >= 0, _list: cls },
    isConnected: opt.connected !== false,
    closest: (sel) => (sel === '.cm-content' && opt.inEditor !== false ? { cls: 'cm-content' } : null),
    getBoundingClientRect: () => ({
      left, top, right: left + width, bottom: top + height, width, height,
    }),
    __bmCfg: opt.cfg || { float: 'right', valign: 'middle' },
    __probe: opt.probe || { imgH: 150.89, yTitle: 73, lineH: 31.5, roots: 1 },
  };
}

function makeApi(rows) {
  return {
    probe: (h) => h.__probe,
    offsetOf: (lineH, imgH, yTitle, valign) => {
      if (valign === 'top') return lineH - imgH;
      if (valign === 'middle') return lineH / 2 - yTitle;
      return 0;
    },
    rows: () => (rows || []),
  };
}

/** 两根线 + 标签 ∈ 一个 item 容器，item 容器的孩子就是这三样 */
function itemsOf(root) {
  const out = [];
  for (const child of root.children) {
    if (child.children && child.children.length === 3) out.push(child);
  }
  return out;
}

const READY_ROWS = [
  { n: 1, exit: 'write' }, { n: 2, exit: 'write' }, { n: 3, exit: 'not-ready' },
];

/* ------------------------------ 建 / 拆 ------------------------------ */

function tShowCreatesElements() {
  VO.hide();
  const hostA = fakeHost();
  const hostB = fakeHost({ inEditor: false, top: 400 });
  const doc = fakeDoc([hostA, hostB]);

  eq(VO.show(doc, makeApi(READY_ROWS)), true, 'overlay-show: 打开成功');
  eq(doc.body.children.length, 1, 'overlay-show: body 下只多一个根元素');

  const root = findById(doc.body, VO.OVERLAY_ID);
  ok(!!root, 'overlay-show: 根元素带 id=' + VO.OVERLAY_ID);
  ok(/position:fixed/.test(root.style.cssText), 'overlay-show: 根元素 position:fixed');
  ok(/pointer-events:none/.test(root.style.cssText), 'overlay-show: 根元素不吃鼠标事件');
  ok(/z-index:999999/.test(root.style.cssText), 'overlay-show: 根元素 z-index 999999');

  /* 1 根 + 1 面板 + 2 图 ×（1 容器 + 3 件）*/
  eq(countNodes(root), 1 + 1 + 2 * 4, 'overlay-show: 元素总数 = 根 + 面板 + 2×（容器+红线+绿线+标签）');
  eq(itemsOf(root).length, 2, 'overlay-show: 两张图各一组标记');
}

function tHideRemovesEverything() {
  VO.hide();
  const doc = fakeDoc([fakeHost()]);
  VO.show(doc, makeApi(READY_ROWS));
  ok(doc.body.children.length === 1, 'overlay-hide: 先确认已经画上');
  eq(VO.hide(), true, 'overlay-hide: hide 返回 true');
  eq(doc.body.children.length, 0, 'overlay-hide: body 下不剩任何元素');
  eq(countNodes(doc.body), 1, 'overlay-hide: body 自己还在，但一个子节点都不剩');
  eq(VO.isOn(), false, 'overlay-hide: 状态回到关闭');
  eq(doc._listeners.length, 0, 'overlay-hide: Esc 监听也解绑了');
}

function tToggleAndIdempotent() {
  VO.hide();
  const doc = fakeDoc([fakeHost()]);
  const api = makeApi([]);

  eq(VO.toggle(doc, api), true, 'overlay-toggle: 第一次是打开');
  eq(doc.body.children.length, 1, 'overlay-toggle: 有一个根元素');
  eq(VO.toggle(doc, api), false, 'overlay-toggle: 第二次是关闭');
  eq(doc.body.children.length, 0, 'overlay-toggle: 关掉后没有元素');

  eq(VO.toggle(doc, api), true, 'overlay-toggle: 第三次又打开');
  eq(VO.show(doc, api), true, 'overlay-toggle: 开着时再 show 返回 true');
  eq(doc.body.children.length, 1, 'overlay-toggle: 开着时再 show 不会叠第二个根元素');
  VO.hide();
}

function tEscapeCloses() {
  VO.hide();
  const doc = fakeDoc([fakeHost()]);
  VO.show(doc, makeApi([]));
  eq(doc._listeners.length, 1, 'overlay-esc: 挂了一个 keydown');
  ok(doc._listeners[0].capture === true, 'overlay-esc: 挂在捕获阶段（编辑器吞掉也能收到）');
  doc.fireKey('Escape');
  eq(VO.isOn(), false, 'overlay-esc: 按 Esc 后关闭');
  eq(doc.body.children.length, 0, 'overlay-esc: 元素也全清了');
  doc.fireKey('Escape');                       // 再按一次不该出事
  eq(VO.isOn(), false, 'overlay-esc: 关着时按 Esc 无副作用');
}

/* ------------------------------ 线和标签 ------------------------------ */

function tLinesAndLabel() {
  VO.hide();
  const ready = fakeHost({
    left: 20, top: 100, width: 300,
    probe: { imgH: 150.89, yTitle: 73, lineH: 31.5, roots: 1 },
    cfg: { float: 'right', valign: 'middle' },
  });
  const notReady = fakeHost({
    left: 20, top: 400, width: 300,
    probe: { imgH: 0, yTitle: NaN, lineH: 31.5, roots: 0 },
    cfg: { float: 'right', valign: 'middle' },
  });
  const doc = fakeDoc([ready, notReady]);
  VO.show(doc, makeApi(READY_ROWS));
  const root = findById(doc.body, VO.OVERLAY_ID);
  const items = itemsOf(root);
  const a = items[0];
  const b = items[1];

  /* 红线：宿主当前顶边，从宿主左边缘起 200px */
  eq(a.children[0].style.top, '100px', 'overlay-line: 红线在宿主当前顶边');
  eq(a.children[0].style.left, '20px', 'overlay-line: 红线从宿主左边缘开始');
  eq(a.children[0].style.width, VO.LINE_W + 'px', 'overlay-line: 红线长 ' + VO.LINE_W + 'px');
  ok(/e11d48/.test(a.children[0].style.background), 'overlay-line: 红线是红的');

  /* 绿线：当前顶 + 偏移（31.5/2 − 73 = −57.25）→ 42.75 */
  eq(a.children[1].style.top, '42.75px', 'overlay-line: 绿线在「当前顶 + 偏移」上');
  ok(/16a34a/.test(a.children[1].style.background), 'overlay-line: 绿线是绿的');
  ok(!/dashed/.test(a.children[1].style.borderTop || ''), 'overlay-line: 能量到时绿线是实线');

  /* not-ready：偏移按 0 算（两条线重合），但绿线画成虚线、标签变橙 */
  eq(b.children[1].style.top, '400px', 'overlay-line: not-ready 时绿线落在红线处');
  ok(/dashed/.test(b.children[1].style.borderTop), 'overlay-line: not-ready 时绿线是虚线');
  ok(/f59e0b/.test(b.children[2].style.cssText), 'overlay-line: not-ready 的标签左边框是橙色');

  /* 标签三行 */
  const label = a.children[2].textContent.split('\n');
  eq(label.length, 3, 'overlay-label: 标签三行');
  eq(label[0], '图1  val=middle flt=right', 'overlay-label: 第一行序号 + 基准 + 浮动');
  eq(label[1], 'imgH=150.89 yT=73.00 lineH=31.50', 'overlay-label: 第二行三个测量值');
  eq(label[2], 'off=-57.25  当前margin=空', 'overlay-label: 第三行偏移 + 当前 margin');

  const labelB = b.children[2].textContent.split('\n');
  eq(labelB[2], '→ not-ready', 'overlay-label: not-ready 时第三行换成分支名');
  eq(labelB[1], 'imgH=0.00 yT=NaN lineH=31.50', 'overlay-label: NaN 原样写出来');

  /* 标签贴宿主右上角 */
  eq(a.children[2].style.left, '326px', 'overlay-label: 标签在宿主右边 6px 处（right 320 + 6）');
  eq(a.children[2].style.top, '100px', 'overlay-label: 标签顶对齐宿主顶边');
  VO.hide();
}

function tLabelClampedAtRightEdge() {
  VO.hide();
  const host = fakeHost({ left: 1000, top: 50, width: 300 });   // right = 1300，超出 1200 的视口
  const doc = fakeDoc([host]);
  VO.show(doc, makeApi([]));
  const root = findById(doc.body, VO.OVERLAY_ID);
  const label = itemsOf(root)[0].children[2];
  eq(label.style.left, '956px', 'overlay-label: 贴右边时往左让（1200 − 240 − 4 = 956）');
  VO.hide();
}

function tMarginShown() {
  VO.hide();
  const host = fakeHost({ marginTop: '-57.25px' });
  const doc = fakeDoc([host]);
  VO.show(doc, makeApi([]));
  const label = itemsOf(findById(doc.body, VO.OVERLAY_ID))[0].children[2];
  ok(label.textContent.indexOf('当前margin=-57.25px') >= 0, 'overlay-label: 有 margin 时把值写出来');
  VO.hide();
}

/* ------------------------------ 总览面板 ------------------------------ */

function tPanelCounts() {
  VO.hide();
  const a = fakeHost({ inEditor: true });
  const b = fakeHost({ inEditor: true, cfg: { float: 'center', valign: 'top' } });
  const c = fakeHost({ inEditor: false });
  const doc = fakeDoc([a, b, c]);
  VO.show(doc, makeApi(READY_ROWS));
  const panel = findById(doc.body, VO.OVERLAY_ID).children[0];
  const text = panel.textContent;

  ok(text.indexOf('宿主 3') >= 0, 'overlay-panel: 数出三个宿主');
  ok(text.indexOf('编辑区 2') >= 0, 'overlay-panel: 两个在编辑区');
  ok(text.indexOf('阅读区 1') >= 0, 'overlay-panel: 一个不在编辑区');
  ok(text.indexOf('float lr 2') >= 0, 'overlay-panel: 两个是 left/right');
  ok(text.indexOf('applyValignLayout 3 次') >= 0, 'overlay-panel: 记下调用次数');
  ok(text.indexOf('write 2') >= 0 && text.indexOf('not-ready 1') >= 0,
    'overlay-panel: 各分支次数都在');
  ok(text.indexOf('Esc 关闭') >= 0, 'overlay-panel: 告诉用户怎么关');
  VO.hide();
}

function tPanelEmptyTrace() {
  VO.hide();
  const doc = fakeDoc([fakeHost()]);
  VO.show(doc, makeApi([]));
  const text = findById(doc.body, VO.OVERLAY_ID).children[0].textContent;
  ok(text.indexOf('applyValignLayout 0 次') >= 0, 'overlay-panel: 没调用过就是 0 次');
  ok(text.indexOf('一次都没调用过') >= 0, 'overlay-panel: 0 次时给一句人话');
  VO.hide();
}

/* ------------------------------ 刷新（rAF，不用定时器） ------------------------------ */

function tFramesFollowMoves() {
  VO.hide();
  const host = fakeHost({ top: 100 });
  const doc = fakeDoc([host]);
  const q = [];
  const cancelled = { n: 0 };
  doc.defaultView = {
    innerWidth: 1200,
    requestAnimationFrame: (fn) => { q.push(fn); return q.length; },
    cancelAnimationFrame: () => { cancelled.n += 1; },
  };
  VO.show(doc, makeApi([]));
  const lineNow = itemsOf(findById(doc.body, VO.OVERLAY_ID))[0].children[0];
  eq(lineNow.style.top, '100px', 'overlay-frame: 打开那一刻就位');
  ok(q.length >= 1, 'overlay-frame: 靠 requestAnimationFrame 排下一帧（不是 setInterval）');

  /* 模拟页面滚动：宿主往上跑了 */
  host.getBoundingClientRect = () => ({ left: 20, top: 260, right: 320, bottom: 410, width: 300, height: 150 });
  const step = q.shift();
  step();
  eq(lineNow.style.top, '260px', 'overlay-frame: 下一帧就跟上了新位置');

  VO.hide();
  eq(cancelled.n, 1, 'overlay-frame: 关掉时 cancelAnimationFrame 一次');
  const leftover = q.shift();
  if (leftover) leftover();                    // 模拟已在队列里的帧：关掉之后不能再生效
  eq(doc.body.children.length, 0, 'overlay-frame: 关掉后残留帧不会再动 DOM');
}

/* ------------------------------ 只读性 ------------------------------ */

function tHostUntouched() {
  VO.hide();
  const host = fakeHost();
  const styleBefore = Object.keys(host.style).slice();
  const classBefore = host.classList._list;
  const doc = fakeDoc([host]);
  VO.show(doc, makeApi([]));
  eq(Object.keys(host.style), styleBefore, 'overlay-readonly: 宿主上的样式键没变');
  eq(host.style.marginTop, '', 'overlay-readonly: 没往宿主写 margin-top');
  eq(host.classList._list, classBefore, 'overlay-readonly: 没给宿主加类');
  eq(host.children, undefined, 'overlay-readonly: 没往宿主里插 DOM');
  VO.hide();
}

/* ------------------------------ 判据镜像 ------------------------------ */

function tGateMirror() {
  ok(VO.gateOf(null, {}, 'right', 'top') === '!host', 'overlay-gate: 没宿主');
  const h = fakeHost();
  eq(VO.gateOf(h, { imgH: 100, roots: 1, yTitle: 20 }, 'center', 'top'), 'float!=lr',
    'overlay-gate: 非浮动');
  eq(VO.gateOf(h, { imgH: 100, roots: 1, yTitle: 20 }, 'right', 'top'), 'ready',
    'overlay-gate: 都满足');
  eq(VO.gateOf(h, { imgH: 0, roots: 1, yTitle: 20 }, 'right', 'top'), 'not-ready',
    'overlay-gate: 图高 0');
  eq(VO.gateOf(h, { imgH: 100, roots: 0, yTitle: 20 }, 'right', 'top'), 'not-ready',
    'overlay-gate: 根节点 0 个');
  const cold = fakeHost({ cls: [] });
  eq(VO.gateOf(cold, { imgH: 100, roots: 1, yTitle: 20 }, 'right', 'top'), '!bm-floated',
    'overlay-gate: 没 bm-floated');
  const gone = fakeHost({ connected: false });
  eq(VO.gateOf(gone, { imgH: 100, roots: 1, yTitle: 20 }, 'right', 'top'), '!inEditor',
    'overlay-gate: 未连进文档');

  /* 第二扇门：middle 量不到标题中心时也算没准备好；top 不看 yTitle */
  eq(VO.gateOf(h, { imgH: 100, roots: 1, yTitle: NaN }, 'right', 'middle'), 'not-ready',
    'overlay-gate: middle 且 yTitle 是 NaN');
  eq(VO.gateOf(h, { imgH: 100, roots: 1, yTitle: null }, 'right', 'middle'), 'not-ready',
    'overlay-gate: middle 且 yTitle 是 null');
  eq(VO.gateOf(h, { imgH: 100, roots: 1, yTitle: NaN }, 'right', 'top'), 'ready',
    'overlay-gate: top 不依赖 yTitle');
}

/* ------------------------------ 登记 ------------------------------ */

suite('overlay-show', tShowCreatesElements);
suite('overlay-hide', tHideRemovesEverything);
suite('overlay-toggle', tToggleAndIdempotent);
suite('overlay-esc', tEscapeCloses);
suite('overlay-lines', tLinesAndLabel);
suite('overlay-label-edge', tLabelClampedAtRightEdge);
suite('overlay-label-margin', tMarginShown);
suite('overlay-panel', tPanelCounts);
suite('overlay-panel-empty', tPanelEmptyTrace);
suite('overlay-frame', tFramesFollowMoves);
suite('overlay-read-only', tHostUntouched);
suite('overlay-gate', tGateMirror);
