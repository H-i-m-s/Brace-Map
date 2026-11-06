'use strict';

/* ============================================================
 * remeasure.test.js · 施加浮动之后让 CM6 重测（以及总开关）
 *
 * 假设：CM6 给 block widget 单独记一条高度，浮动之后 DOM 不再贡献流内高度，
 * CM6 账上还挂着旧值 → 光标错位。所以要「样式写完的下一帧」调一次
 * view.requestMeasure()，让它重新量。
 *
 * headless 能验的只有「这条链路有没有按预期触发」：谁调了、调了几次、节流有没有
 * 生效、拿不到 cm 会怎样、开关关掉会不会写样式。CM6 拿到消息之后有没有把高度
 * 更新成 0 —— 那只能在真实 Obsidian 里看（src/debug.js 的 lp.measure.post 那条）。
 * ============================================================ */

const { I, ok, eq, suite } = require('./framework');

/* ------------------------------ 假 DOM ------------------------------ */

function styleObj(init) {
  const s = Object.assign({}, init || {});
  s.__removed = [];
  s.__important = {};
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

function fakeEl(classes, h, rect, init) {
  const cls = classes || [];
  const el = {
    style: styleObj(init),
    classList: {
      contains: (c) => cls.indexOf(c) >= 0,
      add: (c) => { if (cls.indexOf(c) < 0) cls.push(c); },
      remove: () => { /* 测试里不需要精确的类名回滚 */ },
    },
    parentElement: null,
    nextElementSibling: null,
    isConnected: true,
    nodeType: 1,
    offsetHeight: h || 0,
    clientHeight: h || 0,
    clientWidth: 0,
  };
  const r = rect || { top: 0, left: 0, width: 0, height: h || 0, right: 0, bottom: h || 0 };
  el.getBoundingClientRect = () => r;
  return el;
}

/** .cm-content > .cm-embed-block > host，后面接三行正文（Obsidian 1.13.7 实测结构） */
function cmTreeDirect(opts) {
  const o = opts || {};
  const content = fakeEl(['cm-content'], 0,
    { top: 0, left: 0, width: 820, height: 2000, right: 820, bottom: 2000 });
  content.clientWidth = 820;

  const embedH = o.embedH == null ? 190 : o.embedH;
  const embed = fakeEl(['cm-embed-block'], embedH,
    { top: 0, left: 0, width: 820, height: embedH, right: 820, bottom: embedH });
  embed.parentElement = content;

  const host = fakeEl([], embedH, { top: 0, left: 0, width: 400, height: embedH, right: 400, bottom: embedH });
  host.parentElement = embed;

  const svg = fakeEl(['brace-map-svg'], embedH,
    { top: 0, left: 0, width: 400, height: embedH, right: 400, bottom: embedH });

  const lines = [];
  const heights = o.lineHeights || [45, 45, 45];
  for (let i = 0; i < heights.length; i++) {
    lines.push(fakeEl(['cm-line'], heights[i],
      { top: 0, left: 0, width: 820, height: heights[i], right: 820, bottom: heights[i] }));
  }
  for (let i = 0; i + 1 < lines.length; i++) lines[i].nextElementSibling = lines[i + 1];
  embed.nextElementSibling = lines[0] || null;

  return { content, embed, host, svg, lines };
}

/** 假 cm：只认 requestMeasure，顺带记次数 */
function fakeCm() {
  const cm = {
    dom: { isConnected: true, nodeType: 1, contains: () => true },
    calls: 0,
    throws: false,
    requestMeasure() {
      cm.calls++;
      if (cm.throws) throw new Error('requestMeasure 炸了');
    },
  };
  return cm;
}

/**
 * 假时钟：rAF 排队等 flushRaf()，setTimeout 按假时间排队等 advance()。
 * 节流断言必须能控制「时间过了多少」，所以 now 也是假的。
 */
function fakeClock() {
  let t = 0;
  let nextId = 1;
  const rafQ = new Map();
  const timers = new Map();
  return {
    now: () => t,
    raf(fn) { const id = nextId++; rafQ.set(id, fn); return id; },
    caf(id) { rafQ.delete(id); },
    setTimeout(fn, ms) { const id = nextId++; timers.set(id, { at: t + (Number(ms) || 0), fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    rafPending: () => rafQ.size,
    timerPending: () => timers.size,
    /** 把当前排着的 rAF 全跑掉（不动时间） */
    flushRaf() {
      let n = 0;
      while (rafQ.size && n < 20) {
        const first = rafQ.entries().next().value;
        rafQ.delete(first[0]);
        first[1]();
        n++;
      }
      return n;
    },
    /** 时间前进 ms，途中到点的定时器依次执行 */
    advance(ms) {
      const target = t + Math.max(0, Number(ms) || 0);
      let guard = 0;
      for (;;) {
        let best = null;
        for (const [id, rec] of timers) {
          if (rec.at <= target && (!best || rec.at < best.rec.at)) best = { id, rec };
        }
        if (!best || guard++ > 50) break;
        timers.delete(best.id);
        t = Math.max(t, best.rec.at);
        best.rec.fn();
      }
      t = target;
      return t;
    },
  };
}

/* ------------------------------ 用例 ------------------------------ */

/** 施加浮动后，下一帧真的调一次 requestMeasure（不是同步立刻调） */
function tMeasureFirstFrame() {
  const clock = fakeClock();
  const tree = cmTreeDirect();
  const cm = fakeCm();
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' },
    { svg: tree.svg, cm, timers: clock });
  ok(!!ctl, 'measure: 控制器挂上了');
  eq(tree.embed.style.float, 'right', 'measure: 样式已经写了');

  eq(cm.calls, 0, 'measure: 施加完不当场调（浏览器还没布局）');
  eq(clock.rafPending(), 1, 'measure: 排了一帧');
  clock.flushRaf();
  eq(cm.calls, 1, 'measure: 下一帧调了一次 requestMeasure');
  eq(ctl.state().measure.calls, 1, 'measure: 控制器 state 里能看到调用次数');
  ctl.dispose();
}

/** 节流：100ms 窗口内反复 update 只落一次，超窗的请求攒到窗口末尾补一次 */
function tMeasureThrottle() {
  const clock = fakeClock();
  const tree = cmTreeDirect();
  const cm = fakeCm();
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' },
    { svg: tree.svg, cm, timers: clock });

  clock.flushRaf();
  eq(cm.calls, 1, 'measure: 首帧一次');

  // 同一时刻连按三次 update：rAF 合并成一条，落在窗口内 → 不调，排到窗口末尾
  ctl.update();
  ctl.update();
  ctl.update();
  eq(clock.rafPending(), 1, 'measure: 三次 update 只排一帧（合并）');
  clock.flushRaf();
  eq(cm.calls, 1, 'measure: 100ms 窗口内不再调');
  eq(clock.timerPending(), 1, 'measure: 但排了一次补调');

  clock.advance(I.RMEASURE_GAP);
  eq(cm.calls, 2, 'measure: 窗口末尾补调一次，请求不丢');

  // 再等满一个窗口，再排一次
  clock.advance(I.RMEASURE_GAP);
  ctl.update();
  clock.flushRaf();
  eq(cm.calls, 3, 'measure: 过了窗口就正常调');
  ctl.dispose();
}

/** 拿不到 cm：静默跳过，不抛错，样式照样写 */
function tMeasureNoCm() {
  const clock = fakeClock();
  const tree = cmTreeDirect();
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' },
    { svg: tree.svg, timers: clock });
  ok(!!ctl, 'measure-nocm: 拿不到 cm 也照样挂控制器');
  eq(tree.embed.style.float, 'right', 'measure-nocm: 样式不受影响');
  let threw = '';
  try { clock.flushRaf(); } catch (e) { threw = String(e && e.message ? e.message : e); }
  eq(threw, '', 'measure-nocm: 拿不到 cm 不抛错');
  eq(ctl.state().measure.calls, 0, 'measure-nocm: 一次都没调');
  eq(ctl.state().measure.skipped, 1, 'measure-nocm: 记为 skipped，不是失败');
  ctl.dispose();
}

/** requestMeasure 自己抛错：不外抛，记一次 error */
function tMeasureThrow() {
  const clock = fakeClock();
  const tree = cmTreeDirect();
  const cm = fakeCm();
  cm.throws = true;
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' },
    { svg: tree.svg, cm, timers: clock });
  let threw = '';
  try { clock.flushRaf(); } catch (e) { threw = String(e && e.message ? e.message : e); }
  eq(threw, '', 'measure-throw: requestMeasure 抛错不外抛');
  eq(cm.calls, 1, 'measure-throw: 调到了（它自己炸的）');
  eq(ctl.state().measure.errors, 1, 'measure-throw: 记一次 error');
  ctl.dispose();
}

/** 内容变化 / resize / 滚动：都要触发，且合并到一帧 */
function tMeasureTriggers() {
  const clock = fakeClock();
  const tree = cmTreeDirect();
  const cm = fakeCm();

  function FakeMO(cb) {
    this.cb = cb;
    this.disconnected = false;
    FakeMO.last = this;
  }
  FakeMO.prototype.observe = function (node) { this.node = node; };
  FakeMO.prototype.disconnect = function () { this.disconnected = true; };

  const win = {
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    removeEventListener(type) { delete this.listeners[type]; },
  };
  const scroller = {
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    removeEventListener(type) { delete this.listeners[type]; },
  };

  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' }, {
    svg: tree.svg, cm, timers: clock,
    MutationObserver: FakeMO, win, scroller,
  });
  clock.flushRaf();
  eq(cm.calls, 1, 'measure-trig: 挂载时一次');

  ok(!!FakeMO.last, 'measure-trig: 建了 MutationObserver');
  ok(FakeMO.last.node === cm.dom, 'measure-trig: 观察的是编辑器根节点');

  clock.advance(I.RMEASURE_GAP);
  // 三种触发源连在一起：合并成一帧、一次调用
  FakeMO.last.cb();
  if (win.listeners.resize) win.listeners.resize();
  if (scroller.listeners.scroll) scroller.listeners.scroll();
  eq(clock.rafPending(), 1, 'measure-trig: 三种触发合成一帧');
  clock.flushRaf();
  eq(cm.calls, 2, 'measure-trig: 合并后只调一次');

  // 滚动是「停下来才测」：滚动事件本身不排 rAF，只排 idle 定时器
  clock.advance(I.RMEASURE_GAP);
  scroller.listeners.scroll();
  eq(clock.rafPending(), 0, 'measure-trig: 滚动中不测');
  eq(clock.timerPending(), 1, 'measure-trig: 等滚动停止');
  clock.advance(I.RMEASURE_SCROLL_IDLE);
  clock.flushRaf();
  eq(cm.calls, 3, 'measure-trig: 滚动停止后测一次');

  ctl.dispose();
  eq(I.measureSchedulerCount(), 0, 'measure-trig: 卸载后不再挂着调度器');
}

/** dispose 之后不再调用，观察者也断开 */
function tMeasureDispose() {
  const clock = fakeClock();
  const tree = cmTreeDirect();
  const cm = fakeCm();
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' },
    { svg: tree.svg, cm, timers: clock });
  clock.flushRaf();
  eq(cm.calls, 1, 'measure-dispose: 先调过一次');
  ctl.dispose();
  clock.advance(1000);
  clock.flushRaf();
  eq(cm.calls, 1, 'measure-dispose: 卸载后不再调');
  eq(I.measureSchedulerCount(), 0, 'measure-dispose: 调度器归零');
}

/** 调度器本体：schedule → 一帧 → 一次；重复 schedule 合并 */
function tSchedulerUnit() {
  const clock = fakeClock();
  const tree = cmTreeDirect();
  const cm = fakeCm();
  const s = I.createMeasureScheduler(tree.content, { cm, timers: clock });
  eq(s.schedule('a'), true, 'sched: 第一次排上');
  eq(s.schedule('b'), false, 'sched: 已有排着的就合并');
  eq(clock.rafPending(), 1, 'sched: 只有一帧');
  clock.flushRaf();
  eq(cm.calls, 1, 'sched: 一帧一次');

  // 手动 run 也走节流
  clock.advance(I.RMEASURE_GAP);            // 让窗口过去
  eq(s.run('manual'), true, 'sched: 过了窗口 run 调一次');
  eq(cm.calls, 2, 'sched: 计数对上');

  eq(s.run('manual'), false, 'sched: 窗口内 run 不调');
  eq(clock.timerPending(), 1, 'sched: 但排了一次补调');

  const st = s.state();
  eq(st.calls, 2, 'sched: state 里 calls');
  eq(st.deferred, 1, 'sched: state 里 deferred');
  s.dispose();
  eq(s.state().attached, false, 'sched: dispose 后 attached 为 false');
  eq(s.schedule('after-dispose'), false, 'sched: dispose 后不再排');
}

/** 总开关：关掉之后一条样式都不写（direct-embed 与老结构都不写） */
function tSwitchOff() {
  const wasOn = I.isLpFloatEnabled();
  I.setLpFloatEnabled(false);
  eq(I.isLpFloatEnabled(), false, 'switch: 关掉了');

  const tree = cmTreeDirect();
  eq(I.applyLivePreviewCssFloat(tree.host, { float: 'right' }, { svg: tree.svg }), null,
    'switch: 关掉后 applyLivePreviewCssFloat 返回 null');
  ok(tree.embed.style.float === undefined, 'switch: embed 一条样式都没写');
  ok(tree.embed.style.width === undefined, 'switch: 没有 width');
  ok(tree.host.style.float === undefined, 'switch: 宿主也没被碰');
  ok(tree.embed.style.cssText === undefined, 'switch: 行内样式一条没写');

  eq(I.attachLivePreviewFloat(tree.host, { float: 'right' }, { svg: tree.svg }), null,
    'switch: 关掉后连控制器都不建');

  const ed = cmTreeDirect();
  ed.host.closest = (sel) => (sel === '.cm-editor' || sel === '.cm-content' ? ed.content : null);
  eq(I.attachFloatWrap(ed.host, { float: 'right' }, { svg: ed.svg }), null,
    'switch: attachFloatWrap 在编辑区里也返回 null');

  const old = cmTreeDirect();
  eq(I.applyLivePreviewFloat(old.host, { float: 'right' }, { svg: old.svg }), null,
    'switch: 老结构（绝对定位 + 留白）也一并停掉');

  I.setLpFloatEnabled(wasOn !== false);
  eq(I.isLpFloatEnabled(), true, 'switch: 恢复默认');
}

/** 关掉时：已经在浮动的那张图要立刻撤样式；再打开要能重新施加 */
function tSwitchLive() {
  const tree = cmTreeDirect();
  const clock = fakeClock();
  const cm = fakeCm();
  const ctl = I.attachLivePreviewFloat(tree.host, { float: 'right' },
    { svg: tree.svg, cm, timers: clock });
  eq(tree.embed.style.float, 'right', 'switch-live: 开着时是浮动的');

  I.setLpFloatEnabled(false);
  ok(tree.embed.style.float === undefined, 'switch-live: 关掉后 float 当场撤回');
  ok(tree.embed.style.margin === undefined, 'switch-live: margin 也撤回');
  ok(tree.host.style.display === undefined, 'switch-live: 宿主的 flow-root 也撤回');
  eq(I.measureSchedulerCount(), 0, 'switch-live: 重测调度器一起拆了');

  I.setLpFloatEnabled(true);
  eq(tree.embed.style.float, 'right', 'switch-live: 再打开立刻恢复浮动');
  ctl.dispose();
  eq(I.measureSchedulerCount(), 0, 'switch-live: 卸载后调度器归零');
}

/** applyFloatLayout 那层（host 上的 float / margin）也要能还回去 */
function tResetLayout() {
  const host = fakeEl([], 100);
  I.applyFloatLayout(host, { float: 'right' });
  eq(host.style.float, 'right', 'reset-layout: 宿主浮动');
  eq(host.style.margin, '0.5rem 0 0.5rem 1rem', 'reset-layout: 宿主间距');
  ok(host.classList.contains('bm-floated'), 'reset-layout: 打了类名');

  I.applyFloatLayout(host, { float: 'left' });       // 换模式：不叠上一轮的残留
  eq(host.style.float, 'left', 'reset-layout: 换模式后是 left');

  const n = I.resetFloatLayout(host);
  ok(n > 0, 'reset-layout: 还了一组样式');
  ok(host.style.float === undefined, 'reset-layout: float 还回去');
  ok(host.style.margin === undefined, 'reset-layout: margin 还回去');
  eq(I.resetFloatLayout(host), 0, 'reset-layout: 再还一次是空操作');
  eq(I.clearLivePreviewFloatLayout(), 0, 'reset-layout: 没有 document 时不报错');
}

suite('remeasure: 施加后让 CM6 重测', () => {
  tMeasureFirstFrame();
  tMeasureThrottle();
  tMeasureNoCm();
  tMeasureThrow();
  tMeasureTriggers();
  tMeasureDispose();
  tSchedulerUnit();
  tSwitchOff();
  tSwitchLive();
  tResetLayout();
});
