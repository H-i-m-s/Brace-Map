'use strict';

/* ============================================================
 * 实时预览：浮动施加完之后，让 CM6 重新量一次
 *
 * 症状：编辑模式（Live Preview）里给 .cm-embed-block 加 float 之后，图能贴边、
 * 文字能被挤窄、重叠 0 行 —— 排版全对，只有光标坏了：点第 18 行落到第 14 行，
 * 光标还会飘到行间空隙里。
 *
 * 假设：CM6 给 block widget 单独记一条高度（实测约 190px）。浮动之后这个块在
 * DOM 里不再贡献流内高度，而 CM6 账上还挂着 190，差的这 190px 就是光标错位的量。
 * 对图片没有这个问题：图片是行内元素，CM6 只记「这一行多高」，主题浮动它，
 * 行高不变，账没乱。
 *
 * 所以要做的只有一件事：样式写完之后，让 CM6 重新测量一次。
 * 至于重测之后 CM6 会不会把那条高度更新成 0 —— 这是本假设的判决性数据，
 * 由 dbg('lp.measure.post') 那条日志给（content 高度在重测前后有没有变）。
 *
 * 时机（同一个调度器，100ms 节流）：
 *   apply     样式写完后 schedule('apply')，下一帧（rAF）真的去 requestMeasure
 *   mutation  MutationObserver（childList + subtree）合并后
 *   resize    窗口尺寸变化
 *   scroll    滚动停止后（idle 判定，不是每帧）
 *
 * 纪律：
 *   - editor.cm 是内部 API，全程 try/catch，拿不到就静默跳过，绝不外抛
 *   - 每 100ms 最多一次；落在窗口里的请求不丢，攒到窗口末尾补一次
 *     （丢了就可能滚动之后一直错位，正是要防的事）
 * ============================================================ */

const { dbg, dbgEnabled, dbgEl } = require('./debug.js');

/** 两次 requestMeasure 之间的最小间隔（ms）。低于它就攒到窗口末尾。 */
const RMEASURE_GAP = 100;
/** 滚动停止的判定窗口（ms）：滚动本身每帧都在触发，不 debounce 会把编辑器拖死 */
const RMEASURE_SCROLL_IDLE = 150;

/** 元素高度（只读 rect，读不到返回 null 而不是 0，免得和「真的 0 高」混淆） */
function rectHeightOf(el) {
  try {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    const r = el.getBoundingClientRect();
    if (!r) return null;
    const h = Number(r.height);
    return Number.isFinite(h) ? Math.round(h * 100) / 100 : null;
  } catch (e) {
    return null;
  }
}

function round2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/**
 * 时钟：默认取浏览器那套，自测可以整体替换（raf / setTimeout / now 全注进去）。
 * 没有 rAF 时退到 setTimeout(fn, 16) —— Node 自测、离屏环境都走这条。
 */
function clockOf(o) {
  const t = o.timers || null;                  // 整套假时钟（自测用）
  const win = o.win || (typeof window !== 'undefined' ? window : null);
  const pick = (a, b, c) => (typeof a === 'function' ? a : (typeof b === 'function' ? b : (typeof c === 'function' ? c : null)));

  const setTimer = pick(t && t.setTimeout, o.setTimeout, typeof setTimeout === 'function' ? setTimeout : null);
  const clearTimer = pick(t && t.clearTimeout, o.clearTimeout, typeof clearTimeout === 'function' ? clearTimeout : null);
  const rafOwner = win && typeof win.requestAnimationFrame === 'function' ? win : null;
  const raf = pick(t && t.raf, o.raf,
    rafOwner ? ((fn) => rafOwner.requestAnimationFrame(fn)) : null)
    || (setTimer ? ((fn) => setTimer(fn, 16)) : null);
  const caf = pick(t && t.caf, o.caf,
    rafOwner && typeof win.cancelAnimationFrame === 'function'
      ? ((id) => rafOwner.cancelAnimationFrame(id))
      : clearTimer)
    || clearTimer;

  return {
    raf,
    caf,
    setTimer: setTimer ? (fn, ms) => setTimer(fn, ms) : null,
    clearTimer: clearTimer ? (id) => clearTimer(id) : null,
    now: pick(t && t.now, o.now, () => Date.now()),
  };
}

/**
 * 一个 .cm-content 一个调度器：多张浮动图共用同一份节流与同一组监听。
 *
 * @param {Element} content  这个编辑器（或任一祖先）的 .cm-content
 * @param {object}  opts     cm / getCM(host) / win / MutationObserver / scroller /
 *                           raf / caf / setTimeout / clearTimeout / now /
 *                           gap / scrollIdle / observe(false 关掉观察者)
 * @returns {{schedule, run, dispose, state, content}}
 */
function createMeasureScheduler(content, opts) {
  const o = opts || {};
  const clock = clockOf(o);
  const gap = Number(o.gap) > 0 ? Number(o.gap) : RMEASURE_GAP;
  const idle = Number(o.scrollIdle) > 0 ? Number(o.scrollIdle) : RMEASURE_SCROLL_IDLE;

  let disposed = false;
  let rafId = null;              // 排着的「下一帧执行」
  let timerId = null;            // 排着的「节流窗口末尾补一次」
  let pendingReason = '';
  let lastCallAt = -Infinity;
  let observer = null;
  let observedNode = null;
  let scrollTimer = null;
  let scrollEl = null;

  /* 计数：state() 与诊断都用它，自测直接断言 */
  const stat = { schedules: 0, runs: 0, calls: 0, deferred: 0, skipped: 0, errors: 0 };

  const resolveView = () => {
    if (o.cm && o.cm.dom) return o.cm;
    try {
      if (typeof o.getCM === 'function' && content) {
        const v = o.getCM(content);
        if (v && v.dom) return v;
      }
    } catch (e) { /* 内部 API，拿不到就算了 */ }
    return null;
  };

  /**
   * 真的调一次。返回是否调用成功。
   * 日志里带上「调用前后 content 高度」：这两个数不变就说明 CM6 没有把 widget
   * 高度更新成 0，假设被推翻。
   */
  const callNow = (reason) => {
    stat.runs++;
    const view = resolveView();
    const cmFound = !!(view && view.dom);
    const hasApi = !!(view && typeof view.requestMeasure === 'function');
    const hBefore = rectHeightOf(content);

    if (!cmFound || !hasApi) {
      stat.skipped++;
      dbg('lp.measure.skip', () => ({
        reason: reason || null,
        cmFound,
        hasApi,
        content: dbgEl(content),
        contentH: hBefore,
        runs: stat.runs,
        skipped: stat.skipped,
      }));
      return false;
    }

    let ok = false;
    let err = '';
    try {
      view.requestMeasure();
      ok = true;
    } catch (e) {
      ok = false;
      err = String(e && e.message ? e.message : e);
    }
    if (ok) {
      stat.calls++;
      lastCallAt = clock.now();
    } else {
      stat.errors++;
    }

    dbg('lp.measure.call', () => ({
      reason: reason || null,
      cmFound,
      ok,
      error: err || null,
      contentBefore: hBefore,
      contentAfterCall: rectHeightOf(content),
      calls: stat.calls,
      runs: stat.runs,
      deferred: stat.deferred,
      skipped: stat.skipped,
      errors: stat.errors,
    }));

    /* 重测是异步的（CM6 在下一帧的 measure cycle 里做），所以还要再等一帧看结果。
     * 只在诊断开着时才排这一拍，正式运行不多一次 rAF。 */
    if (ok && dbgEnabled() && typeof clock.raf === 'function') {
      try {
        clock.raf(() => {
          const hAfter = rectHeightOf(content);
          dbg('lp.measure.post', () => ({
            reason: reason || null,
            content: dbgEl(content),
            contentBefore: hBefore,
            contentAfter: hAfter,
            delta: (hBefore != null && hAfter != null) ? round2(hAfter - hBefore) : null,
            changed: (hBefore != null && hAfter != null) ? hAfter !== hBefore : null,
          }));
        });
      } catch (e) { /* 排不上就算了，少一条日志 */ }
    }
    return ok;
  };

  const later = (ms, reason) => {
    if (disposed || timerId || typeof clock.setTimer !== 'function') return false;
    try {
      timerId = clock.setTimer(() => {
        timerId = null;
        if (!disposed) run(reason);
      }, ms);
    } catch (e) {
      timerId = null;
      return false;
    }
    return true;
  };

  /** 立刻（节流允许时）执行；落在窗口内就排到窗口末尾，不丢。 */
  function run(reason) {
    if (disposed) return false;
    const dt = clock.now() - lastCallAt;
    if (dt < gap) {
      stat.deferred++;
      dbg('lp.measure.defer', () => ({
        reason: reason || null,
        wait: Math.round(gap - dt),
        deferred: stat.deferred,
      }));
      later(gap - dt, reason);
      return false;
    }
    return callNow(reason);
  }

  /**
   * 排一次重测：合并到下一帧（rAF）。
   * 样式刚写完浏览器还没布局，同步调用量到的还是旧值，所以必须等一帧。
   */
  function schedule(reason) {
    if (disposed) return false;
    stat.schedules++;
    pendingReason = reason || 'apply';
    if (rafId != null || timerId != null) return false;      // 已经排着，合并
    if (typeof clock.raf !== 'function') return later(16, pendingReason);
    try {
      rafId = clock.raf(() => {
        rafId = null;
        if (!disposed) run(pendingReason);
      });
    } catch (e) {
      rafId = null;
      return later(16, pendingReason);                       // rAF 排不上就退到定时器
    }
    return true;
  }

  /* --------------------------- 观察者与监听 --------------------------- */

  const observe = () => {
    if (disposed || observer || o.observe === false) return false;
    const MO = o.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    if (!MO || typeof MO !== 'function') return false;
    const view = resolveView();
    const node = (view && view.dom) || content;
    if (!node || typeof node.nodeType === 'undefined') return false;
    try {
      observer = new MO(() => { if (!disposed) schedule('mutation'); });
      observer.observe(node, { childList: true, subtree: true });
      observedNode = node;
      dbg('lp.measure.observe', () => ({
        node: dbgEl(node),
        isEditorRoot: !!(view && view.dom === node),
        cmFound: !!view,
      }));
      return true;
    } catch (e) {
      observer = null;
      observedNode = null;
      dbg('lp.measure.observe', () => ({ ok: false, error: String(e && e.message ? e.message : e) }));
      return false;
    }
  };

  const win = o.win
    || (content && content.ownerDocument && content.ownerDocument.defaultView)
    || (typeof window !== 'undefined' ? window : null);

  const onResize = () => { schedule('resize'); };
  if (win && typeof win.addEventListener === 'function') {
    try { win.addEventListener('resize', onResize); } catch (e) { /* ignore */ }
  }

  const scrollerOf = () => {
    if (o.scroller) return o.scroller;
    if (scrollEl) return scrollEl;
    try {
      if (content && typeof content.closest === 'function') {
        const s = content.closest('.cm-scroller');
        if (s) { scrollEl = s; return s; }
      }
    } catch (e) { /* 假 DOM 没有 closest */ }
    return null;
  };

  /* 滚动不是每帧都测：滚动途中 CM6 自己会重排版，停下来才需要一次校正 */
  const onScroll = () => {
    if (disposed || typeof clock.setTimer !== 'function') return;
    if (scrollTimer != null && typeof clock.clearTimer === 'function') {
      try { clock.clearTimer(scrollTimer); } catch (e) { /* ignore */ }
    }
    try {
      scrollTimer = clock.setTimer(() => {
        scrollTimer = null;
        schedule('scroll');
      }, idle);
    } catch (e) {
      scrollTimer = null;
    }
  };
  const scroller = scrollerOf();
  if (scroller && typeof scroller.addEventListener === 'function') {
    try { scroller.addEventListener('scroll', onScroll, { passive: true }); } catch (e) { /* ignore */ }
  }

  const dispose = () => {
    if (disposed) return false;
    disposed = true;
    if (rafId != null && typeof clock.caf === 'function') { try { clock.caf(rafId); } catch (e) { /* ignore */ } }
    rafId = null;
    if (timerId != null && typeof clock.clearTimer === 'function') { try { clock.clearTimer(timerId); } catch (e) { /* ignore */ } }
    timerId = null;
    if (scrollTimer != null && typeof clock.clearTimer === 'function') { try { clock.clearTimer(scrollTimer); } catch (e) { /* ignore */ } }
    scrollTimer = null;
    if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } }
    observer = null;
    observedNode = null;
    if (win && typeof win.removeEventListener === 'function') {
      try { win.removeEventListener('resize', onResize); } catch (e) { /* ignore */ }
    }
    if (scroller && typeof scroller.removeEventListener === 'function') {
      try { scroller.removeEventListener('scroll', onScroll, { passive: true }); } catch (e) { /* ignore */ }
    }
    dbg('lp.measure.dispose', () => ({ content: dbgEl(content), ...stat }));
    return true;
  };

  observe();

  return {
    content,
    schedule,
    run,
    dispose,
    state: () => ({
      attached: !disposed,
      content: dbgEl(content),
      observed: !!observer,
      observedNode: dbgEl(observedNode),
      scroller: dbgEl(scroller),
      gap,
      ...stat,
    }),
  };
}

module.exports = {
  RMEASURE_GAP,
  RMEASURE_SCROLL_IDLE,
  rectHeightOf,
  createMeasureScheduler,
};
