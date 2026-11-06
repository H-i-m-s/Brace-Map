'use strict';

/* ============================================================
 * 浮动：图文混排
 *
 * 为什么不能只靠 CSS 的 float：阅读视图里代码块宿主是
 * `.markdown-preview-sizer` 的直接子项，而 sizer 是 flex 容器
 * （display: flex; flex-direction: column）。CSS 规定 flex 容器的直接子项
 * 上 float 不产生浮动效果 —— 计算值仍是 right，布局上被当成 none。
 * 实测：宿主 x 仍是 16~836（满宽），段落行宽 [816, 352]，一点没绕。
 *
 * 所以 float 只能「手动实现」：让宿主脱离 flex 流（position: absolute），
 * 再给后续兄弟逐个加外边距，把行盒挤到另一侧。
 *   1. 记下宿主在流里的位置，absolute 回去（贴左或贴右）
 *   2. 从 nextElementSibling 往后走，右浮动加 marginRight、左浮动加 marginLeft，
 *      累积高度超过图高就停
 *   3. 尺寸一变（窗口宽度、字体加载、自校准后的图高）就整体复位重算
 *
 * 纯逻辑（找留白范围 / 加外边距 / 复位）与 DOM 操作分开，前者可以在假 DOM 上测。
 * ============================================================ */

/** 图与文字之间的横向间距（px），跟主题图片浮动保持一致的观感 */
const FLOAT_GAP = 16;
/** 往上找定位祖先最多爬几层，防止一路爬到 body */
const CLIMB_LIMIT = 4;
/** 一次最多处理多少个后续块，防止假 DOM / 兄弟链成环时死循环 */
const WRAP_LIMIT = 200;

/* ------------------------------ 小工具 ------------------------------ */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);

/** marginRight → margin-right */
function cssName(prop) {
  return String(prop).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

/** 读元素真实渲染高度：CSS 可能缩放 SVG，height 属性不可信，优先 getBoundingClientRect */
function elHeight(el) {
  if (!el) return 0;
  if (typeof el.getBoundingClientRect === 'function') {
    try {
      const r = el.getBoundingClientRect();
      if (r && Number.isFinite(r.height) && r.height > 0) return r.height;
    } catch (e) { /* 假 DOM 没布局，退回 offsetHeight */ }
  }
  const h = Number(el.offsetHeight);
  return Number.isFinite(h) && h > 0 ? h : 0;
}

function rectOf(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  try {
    const r = el.getBoundingClientRect();
    if (!r) return null;
    if (!Number.isFinite(r.left) || !Number.isFinite(r.top)) return null;
    return r;
  } catch (e) {
    return null;
  }
}

function computedPosition(el) {
  if (!el) return '';
  try {
    const doc = el.ownerDocument;
    const view = doc && doc.defaultView;
    const cs = view && view.getComputedStyle ? view.getComputedStyle(el) : null;
    if (cs) return String(cs.position || '');
  } catch (e) { /* 假 DOM 读不到就算了 */ }
  return '';
}

/** 读 padding（px）。读不到就当 0：绝对定位的基准是 padding box，正文边界在 padding 里侧。 */
function paddingOf(el) {
  const out = { left: 0, right: 0 };
  if (!el) return out;
  try {
    const doc = el.ownerDocument;
    const view = doc && doc.defaultView;
    const cs = view && view.getComputedStyle ? view.getComputedStyle(el) : null;
    if (!cs) return out;
    const l = parseFloat(cs.paddingLeft);
    const r = parseFloat(cs.paddingRight);
    if (Number.isFinite(l)) out.left = l;
    if (Number.isFinite(r)) out.right = r;
  } catch (e) { /* ignore */ }
  return out;
}

/** 实时预览（CM6 编辑器）：兄弟是 .cm-line，结构完全不同 */
function isLivePreview(el) {
  if (!el || typeof el.closest !== 'function') return false;
  try {
    if (el.closest('.cm-editor')) return true;
    if (el.closest('.cm-content')) return true;
    return false;
  } catch (e) {
    return false;
  }
}

/* --------------------------- 行内样式记账 --------------------------- */

/**
 * 写一条行内样式，返回复位记录（含写之前的值）。
 * 复位就是把「写之前的值」放回去：之前没有这条行内样式，就删掉它，
 * 让 CSS 规则重新生效 —— 不会把主题给的 margin 变成写死的 px。
 */
function setInlineStyle(el, prop, value) {
  if (!el || !el.style) return null;
  const prev = el.style[prop] == null ? '' : String(el.style[prop]);
  el.style[prop] = value;
  return { el, prop, cssProp: cssName(prop), prev };
}

/** 统一复位：按记录倒序放回原值 */
function restoreStyles(entries) {
  if (!Array.isArray(entries)) return 0;
  let n = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || !e.el || !e.el.style) continue;
    const st = e.el.style;
    if (e.prev) {
      st[e.prop] = e.prev;
    } else if (typeof st.removeProperty === 'function') {
      st.removeProperty(e.cssProp || cssName(e.prop));
    } else {
      st[e.prop] = '';
    }
    n++;
  }
  return n;
}

/* --------------------------- 留白范围（纯函数） --------------------------- */

/**
 * 从 startEl 开始往后数，返回「需要留白」的兄弟元素。
 *
 * 规则：逐块累加高度，累加到够 height（图高）为止，最后一块也带上 ——
 * 宁可多留一点白，也不要让文字压到图上。
 *
 * @param {Element|null} startEl  第一个候选（通常是宿主的 nextElementSibling）
 * @param {number} height         图真实渲染高度（px）
 * @param {{limit?:number}} [opts]
 * @returns {Element[]}
 */
function collectWrapTargets(startEl, height, opts) {
  const out = [];
  const h = Number(height);
  if (!startEl || !(h > 0)) return out;
  const limit = opts && Number(opts.limit) > 0 ? Number(opts.limit) : WRAP_LIMIT;
  let el = startEl;
  let acc = 0;
  while (el && out.length < limit) {
    if (out.indexOf(el) >= 0) break;      // 兄弟链成环（假 DOM / 异常结构）
    out.push(el);
    acc += elHeight(el);
    if (acc >= h) break;                  // 图高已盖住，后面恢复整宽
    el = el.nextElementSibling;
  }
  return out;
}

function pxValue(v) {
  const s = String(v == null ? '' : v).trim();
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(s);
  return m ? parseFloat(m[1]) : 0;
}

/**
 * 读元素此刻的左右外边距（px），优先 computed（主题可能写的是 rem / auto）。
 * 读不到就退回行内样式的 px 值。
 */
function readMargins(el) {
  const out = { left: 0, right: 0 };
  if (!el) return out;
  let cs = null;
  try {
    const doc = el.ownerDocument;
    const view = doc && doc.defaultView;
    cs = view && view.getComputedStyle ? view.getComputedStyle(el) : null;
  } catch (e) { cs = null; }
  const pick = (key, inline) => {
    if (cs) {
      const v = parseFloat(cs[key]);
      if (Number.isFinite(v)) return v;
    }
    return pxValue(el.style ? el.style[inline] : '');
  };
  out.left = pick('marginLeft', 'marginLeft');
  out.right = pick('marginRight', 'marginRight');
  return out;
}

/**
 * 给留白目标留出空间，返回复位记录。
 *
 * 两件事一起做：
 *   1. 加外边距（右浮动加 marginRight、左浮动加 marginLeft）
 *   2. 把 max-width 限制到剩余可用宽度
 * 只做第 1 件不够用：不少主题给正文块写死了 width（例如 width: 820px），
 * 写死的宽不会被外边距压窄，盒子会被挤出容器，行盒宽度一点不变。
 * max-width 比 width 优先，两件一起做才能同时兼容「自动宽」和「定宽」两种正文块。
 *
 * @param {Element[]} targets
 * @param {'left'|'right'} side
 * @param {number} span     要占掉的空间（图宽 + 间距）
 * @param {{limit?:number, reader?:Function}} [opts]
 *        limit：正文可用宽度（px），给了才写 max-width
 *        reader：自定义外边距读取（返回 {left,right}），默认读 computed
 */
function applyWrapMargins(targets, side, span, opts) {
  const entries = [];
  if (!Array.isArray(targets)) return entries;
  const extra = Number(span);
  if (!Number.isFinite(extra) || extra <= 0) return entries;
  const o = opts || {};
  const reader = typeof o.reader === 'function' ? o.reader : readMargins;
  const limit = Number(o.limit) > 0 ? Number(o.limit) : 0;
  const prop = side === 'left' ? 'marginLeft' : 'marginRight';
  for (const el of targets) {
    if (!el || !el.style) continue;
    let base = { left: 0, right: 0 };
    try {
      const got = reader(el);
      if (got && typeof got === 'object') base = got;
    } catch (e) { base = { left: 0, right: 0 }; }
    const bl = Number(base.left) || 0;
    const br = Number(base.right) || 0;
    const own = side === 'left' ? bl : br;
    const e1 = setInlineStyle(el, prop, round2(own + extra) + 'px');
    if (e1) entries.push(e1);
    if (limit > 0) {
      const avail = limit - bl - extra;
      if (avail > 0) {
        const e2 = setInlineStyle(el, 'maxWidth', round2(avail) + 'px');
        if (e2) entries.push(e2);
      }
    }
  }
  return entries;
}

/** 复位外边距（applyWrapMargins 的逆操作），返回复位条数 */
function restoreWrapMargins(entries) {
  return restoreStyles(entries);
}

/* --------------------------- 定位上下文 --------------------------- */

function isFlowColumn(el) {
  if (!el) return false;
  const cls = el.classList;
  if (cls && typeof cls.contains === 'function' && cls.contains('markdown-preview-sizer')) return true;
  return false;
}

/**
 * 这个父元素是不是只包着 child 一个东西？
 * 只看高度不可靠：子里有外边距时，外层盒子会比图高出那么十几个像素。
 */
function isPureWrapper(parent, child) {
  if (!parent || !child || parent === child) return false;
  if (parent.childElementCount !== 1) return false;
  const kids = parent.childNodes;
  if (!kids || typeof kids.length !== 'number') return true;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (k === child) continue;
    // 只允许空白文本节点（格式化产生的换行）
    if (k && k.nodeType === 3 && String(k.nodeValue || '').trim() === '') continue;
    if (k && k.nodeType !== 1 && k.nodeType !== 3) continue;   // 注释之类
    return false;
  }
  return true;
}

/**
 * 从 el 往上找「定位祖先 + 真正要脱离流的块」。
 *
 * Obsidian 给的 el 可能已经被包了一层（`.el-pre` 之类），那层壳高度和图一样、
 * 只是包装，脱离流要作用在最外层壳上，留白要落在壳的兄弟上（那才是正文块）。
 * 判断依据：父盒高度≈图高 → 它只是壳，继续往上爬；一旦父盒里还有别的内容，
 * 它就是要用的定位祖先。
 */
function pickContext(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  let parent = el.parentElement;
  if (!parent) return null;
  const own = elHeight(el);
  let child = el;
  for (let i = 0; i < CLIMB_LIMIT && parent; i++) {
    // sizer 是正文列，就算整页只有这一张图也不能再往上爬
    if (isFlowColumn(parent)) return { ancestor: parent, block: child };
    const ph = elHeight(parent);
    // 两种信号：只包着一个元素（壳），或者高度就是个图高（壳上有外边距也算）
    const wrapper = isPureWrapper(parent, child) || (ph > 0 && own > 0 && ph <= own + 2);
    if (!wrapper) return { ancestor: parent, block: child };
    const up = parent.parentElement;
    if (!up) return { ancestor: parent, block: child };
    child = parent;
    parent = up;
  }
  return { ancestor: parent, block: child };
}

/* --------------------------- 浮动本体 --------------------------- */

/**
 * 让 el 真正「浮动」：脱离流 + 后续兄弟留白。
 * 返回复位记录；不能浮动时返回 null（调用方保持原状）。
 */
function floatify(el, cfg, opts) {
  const o = opts || {};
  const mode = cfg && cfg.float;
  const side = mode === 'left' ? 'left' : (mode === 'right' ? 'right' : '');
  if (!side) return null;
  if (!el || !el.style || typeof el.getBoundingClientRect !== 'function') return null;
  if (isLivePreview(el)) return null;                 // CM6 里没法这么干，交给原来的 float
  const ctx = pickContext(el);
  if (!ctx || !ctx.ancestor || !ctx.block) return null;
  const ancestor = ctx.ancestor;
  const block = ctx.block;
  if (block === ancestor) return null;

  const aRect = rectOf(ancestor);
  const bRect = rectOf(block);
  if (!aRect || !bRect) return null;

  const gap = Number(o.gap) > 0 ? Number(o.gap) : FLOAT_GAP;
  const svgRect = o.svg ? rectOf(o.svg) : null;
  const natural = svgRect && svgRect.width > 0 ? svgRect.width : bRect.width;
  const want = Number(cfg.width) > 0 ? Number(cfg.width) : natural;
  const boxW = ancestor.clientWidth || aRect.width || want;
  const width = Math.max(1, Math.min(want, boxW));

  const originX = aRect.left + num(ancestor.clientLeft);
  const originY = aRect.top + num(ancestor.clientTop);
  const pad = paddingOf(ancestor);
  // 正文列的左右边界：绝对定位以 padding box 为基准，正文在 padding 里侧
  const contentLeft = originX + pad.left;
  const contentRight = originX + boxW - pad.right;

  const record = {
    block, ancestor, side, width, gap,
    height: bRect.height,
    clearance: 0,
    margin: 0,
    styles: [],
    wrap: [],
  };

  /*
   * 后面没有兄弟块时别动手：浮动的全部意义是「让后面的文字绕上来」，
   * 没有可绕的内容，脱离流只是白拆一次排版（还会把嵌套在 callout 里的图
   * 从它自己的壳里抽出来）。用流里的高度先数一遍上界。
   */
  const plan = collectWrapTargets(block.nextElementSibling, record.height, { limit: o.maxBlocks });
  if (!plan.length) return null;

  // 定位祖先进程：只补 position: relative，不动 display（动 display 会改整页排版）
  const pos = computedPosition(ancestor);
  if (!pos || pos === 'static') {
    const e = setInlineStyle(ancestor, 'position', 'relative');
    if (e) record.styles.push(e);
  }

  // 记下流里的位置再脱离流：top 沿用记下来的位置，横向贴住正文列左/右边界
  // （不能沿用图原来的横向位置，否则「右浮动」只在 400px 宽的小盒里贴了个左）
  const top = bRect.top - originY;
  record.styles.push(setInlineStyle(block, 'position', 'absolute'));
  record.styles.push(setInlineStyle(block, 'float', 'none'));
  record.styles.push(setInlineStyle(block, 'margin', '0'));
  record.styles.push(setInlineStyle(block, 'top', round2(top) + 'px'));
  record.styles.push(setInlineStyle(block, 'width', round2(width) + 'px'));
  record.styles.push(setInlineStyle(block, 'maxWidth', 'none'));
  if (side === 'right') {
    record.styles.push(setInlineStyle(block, 'right', round2(pad.right) + 'px'));
    record.styles.push(setInlineStyle(block, 'left', 'auto'));
  } else {
    record.styles.push(setInlineStyle(block, 'left', round2(pad.left) + 'px'));
    record.styles.push(setInlineStyle(block, 'right', 'auto'));
  }
  record.styles = record.styles.filter(Boolean);

  /*
   * 宽度写下去之后图可能整体缩放（.bm-floated .brace-map-svg 是 max-width: 100%），
   * 高度会跟着变。留白必须按「此刻的真实渲染高度」算，不能信改宽之前那个值。
   */
  const after = rectOf(block) || bRect;
  record.height = elHeight(block);
  record.clearance = side === 'right'
    ? Math.max(0, contentRight - after.left)
    : Math.max(0, after.right - contentLeft);
  record.margin = record.clearance + gap;

  /*
   * 留白范围：先用纯函数数出一个上界，再一块一块真加上去、加完重新量。
   * 为什么要重新量：提前量到的高度是「没被挤窄之前」的，一段文字被压到
   * 一半宽之后会折成更多行、变得更高。按旧高度累加会把后面的块也算进来，
   * 图下面已经恢复整宽的位置反而被白占一大块。
   * 因为挤窄只会让块变高，真实需要的块数一定不超过纯函数数出来的，所以后者当上界是安全的。
   */
  const contentW = contentRight - contentLeft;
  record.wrap = [];
  let acc = 0;
  for (const target of plan) {
    const got = applyWrapMargins([target], side, record.margin, { limit: contentW, reader: o.reader });
    for (const g of got) record.wrap.push(g);
    acc += elHeight(target);
    if (acc >= record.height) break;
  }
  return record;
}

/** 复位一次浮动：先放回兄弟外边距，再放回宿主自己的定位样式 */
function resetFloat(record) {
  if (!record) return false;
  restoreStyles(record.wrap);
  restoreStyles(record.styles);
  record.wrap = [];
  record.styles = [];
  return true;
}

/* --------------------------- 重算调度 --------------------------- */

/**
 * 给一个浮动块挂上「尺寸一变就重算」的调度器。
 *
 * 重算必须做：窗口变化、字体加载、mountBraceSvg 的自校准都会改图的真实高度，
 * 留白范围跟着变；不重算就会出现图已经变高、文字还按旧高度绕。
 *
 * @returns {{update:Function, dispose:Function}|null}
 */
function attachFloatWrap(host, cfg, opts) {
  const o = opts || {};
  const side = cfg && cfg.float;
  if (side !== 'left' && side !== 'right') return null;
  if (!host || typeof host.getBoundingClientRect !== 'function') return null;
  if (typeof host.style === 'undefined') return null;
  // 实时预览走另一条路：CM6 每行独立，阅读视图的「给兄弟加外边距」对它无效
  if (isLivePreview(host)) return attachLivePreviewFloat(host, cfg, o);
  const doc = host.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;

  const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  let record = null;
  let appliedKey = '';
  let disposed = false;
  let observedAncestor = null;

  const raf = (win && typeof win.requestAnimationFrame === 'function')
    ? (fn) => win.requestAnimationFrame(fn)
    : ((typeof requestAnimationFrame === 'function')
      ? (fn) => requestAnimationFrame(fn)
      : (fn) => setTimeout(fn, 16));
  const caf = (win && typeof win.cancelAnimationFrame === 'function')
    ? (id) => win.cancelAnimationFrame(id)
    : (typeof cancelAnimationFrame === 'function' ? (id) => cancelAnimationFrame(id) : (id) => clearTimeout(id));

  /** 当前（已应用浮动后）的几何指纹：没变就别重算，免得和 ResizeObserver 打架 */
  const keyNow = () => {
    const b = rectOf(host);
    if (!b) return '';
    const a = record ? rectOf(record.ancestor) : null;
    return [
      Math.round(b.width),
      Math.round(b.height),
      Math.round(b.top * 10) / 10,
      Math.round(b.left * 10) / 10,
      a ? Math.round(a.width) : 0,
    ].join('|');
  };

  let applies = 0;
  const apply = () => {
    applies++;
    if (disposed) return;
    if (!host.isConnected && typeof host.isConnected === 'boolean') { dispose(); return; }
    resetFloat(record);                 // 先复位，避免上一轮的改动叠上来
    record = null;
    let next = null;
    try {
      next = floatify(host, cfg, { svg: o.svg, gap: o.gap, reader: o.reader });
    } catch (err) {
      next = null;
      console.warn('[brace-map] 浮动布局失败', err);
    }
    record = next;
    appliedKey = next ? keyNow() : '';

    if (ro && record && record.ancestor !== observedAncestor) {
      if (observedAncestor) { try { ro.unobserve(observedAncestor); } catch (e) { /* ignore */ } }
      try { ro.observe(record.ancestor); observedAncestor = record.ancestor; } catch (e) { /* ignore */ }
    }
  };

  /*
   * 轻量节流：定时器 + 下一帧赛跑，谁先到算谁的。
   * 只用 requestAnimationFrame 不够可靠：headless / 窗口不可见 / 页面不重绘时
   * 帧回调会长期不投递，重算就永远排在队里出不来。定时器在任何环境都会跑。
   */
  let pending = null;
  const fire = () => {
    if (!pending) return;
    const p = pending;
    pending = null;
    if (p.timer) { try { clearTimeout(p.timer); } catch (e) { /* ignore */ } }
    if (p.raf) { try { caf(p.raf); } catch (e) { /* ignore */ } }
    apply();
  };
  const schedule = () => {
    if (disposed || pending) return;
    pending = { timer: 0, raf: 0 };
    try { pending.timer = setTimeout(fire, 16); } catch (e) { pending.timer = 0; }
    try { pending.raf = raf(fire); } catch (e) { pending.raf = 0; }
  };

  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    try {
      ro = new ResizeObserver(() => {
        if (disposed) return;
        // 指纹没变 = 这次的尺寸变化是我们自己造成的（留白把正文撑高了），跳过
        if (record && keyNow() === appliedKey) return;
        schedule();
      });
      ro.observe(host);
    } catch (e) { ro = null; }
  }

  const onResize = () => schedule();
  if (win && typeof win.addEventListener === 'function') {
    try { win.addEventListener('resize', onResize); } catch (e) { /* ignore */ }
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (pending) {
      const p = pending;
      pending = null;
      if (p.timer) { try { clearTimeout(p.timer); } catch (e) { /* ignore */ } }
      if (p.raf) { try { caf(p.raf); } catch (e) { /* ignore */ } }
    }
    if (ro) { try { ro.disconnect(); } catch (e) { /* ignore */ } ro = null; }
    if (win && typeof win.removeEventListener === 'function') {
      try { win.removeEventListener('resize', onResize); } catch (e) { /* ignore */ }
    }
    resetFloat(record);
    record = null;
  };

  apply();                              // 立即生效一次：挂载时图已经在文档里了

  /*
   * 自校准（mountBraceSvg）是异步的，会在 0/60/250/1000ms 与字体就绪后重排，
   * 图高因此变化。ResizeObserver 能收到，但离屏 / 无 RO 的环境收不到，
   * 所以再按它的节奏补几拍；指纹没变时这些补拍是空转，代价可以忽略。
   */
  try { setTimeout(() => schedule(), 120); } catch (e) { /* ignore */ }
  try { setTimeout(() => schedule(), 480); } catch (e) { /* ignore */ }
  try { setTimeout(() => schedule(), 1200); } catch (e) { /* ignore */ }
  try {
    const fonts = doc.fonts;
    if (fonts && typeof fonts.ready === 'object' && fonts.ready && typeof fonts.ready.then === 'function') {
      fonts.ready.then(() => schedule());
    }
  } catch (e) { /* ignore */ }

  return {
    host,
    update: schedule,
    dispose,
    state: () => (record
      ? { side: record.side, width: record.width, margin: record.margin, targets: record.wrap.length, applies }
      : { applies }),
  };
}

/* ============================================================
 * 实时预览（CM6）：每行独立，float 跨不了行
 *
 * 阅读视图那套「脱离流 + 给后续兄弟加外边距」在这里不成立：CM6 把正文切成
 * 一个个 .cm-line，widget 浮在自己那一行里，后面的行跟它没有兄弟关系，
 * float 再正确也不会有文字绕上来。真正的做法是让 widget 相对整个 .cm-content 定位：
 *
 *   1. widget 所在的 .cm-line 设 position: static（它原本是 relative，
 *      会抢走绝对定位的包含块）
 *   2. .cm-content 设 position: relative，成为包含块
 *   3. .cm-embed-block 设 position: absolute，top 沿用它在流里的原位置，
 *      右浮动贴 right: 0、左浮动贴 left: 0
 *   4. 从 widget 那行的下一行起逐行加 paddingRight / paddingLeft，
 *      累积高度超过图高就停 —— 图下面那行不留白
 *
 * CM6 是虚拟滚动的，滚动、输入、折叠都会增删 .cm-line，加上的样式随时会丢。
 * 所以每次施加都先整体复位上一轮、再重算一遍，由挂在编辑器根节点上的
 * MutationObserver 驱动（150ms 合并），施加完调一次 requestMeasure 让 CM6 重新量行高。
 * ============================================================ */

/** MutationObserver 到重算之间的合并窗口（ms）。滚动时每帧都变，不合并会卡。 */
const LP_DEBOUNCE = 150;
/** 兜底巡检间隔（ms）：发现图或编辑器掉出文档就自己收摊，切笔记时断开旧观察者 */
const LP_POLL = 1500;
/** 挂载时的重试节奏（ms）：CM6 有时先给元素、后才把它插进文档 */
const LP_RETRY = [0, 60, 200, 600, 1500];

/* --------------------------- 实时预览：DOM 结构 --------------------------- */

function classHas(el, name) {
  if (!el) return false;
  const cls = el.classList;
  if (!cls || typeof cls.contains !== 'function') return false;
  try { return cls.contains(name); } catch (e) { return false; }
}

/** 从 el 自己往上找最近的 `.cls`（含自己）。CM6 的结构只认 class，不走选择器引擎。 */
function climbTo(el, name, limit) {
  const max = Number(limit) > 0 ? Number(limit) : CLIMB_LIMIT;
  let cur = el;
  for (let i = 0; cur && i <= max; i++) {
    if (classHas(cur, name)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

/**
 * 从代码块渲染出的元素往上找 CM6 的三件东西：
 *   embed   .cm-embed-block  —— 要脱离流的那个盒子
 *   line    它的父 .cm-line  —— 原本 position: relative，会抢走包含块
 *   content .cm-content      —— 变成包含块的那个
 */
function livePreviewParts(el) {
  if (!el) return null;
  const embed = climbTo(el, 'cm-embed-block', CLIMB_LIMIT + 8);
  if (!embed) return null;
  const content = climbTo(embed, 'cm-content', CLIMB_LIMIT + 12);
  if (!content) return null;
  let line = embed.parentElement;
  if (!classHas(line, 'cm-line')) line = climbTo(embed, 'cm-line', CLIMB_LIMIT);
  if (!line || line === content) return null;
  return { embed, line, content };
}

/** 从 widget 那行的下一个兄弟起收集同级 .cm-line（不是行的兄弟跳过但继续走） */
function collectLineSiblings(startEl, limit) {
  const out = [];
  const max = Number(limit) > 0 ? Number(limit) : WRAP_LIMIT;
  const steps = max * 4 + 8;
  let el = startEl;
  let n = 0;
  while (el && out.length < max && n < steps) {
    n++;
    if (classHas(el, 'cm-line')) {
      if (out.indexOf(el) < 0) out.push(el);
    }
    el = el.nextElementSibling;
  }
  return out;
}

/* --------------------------- 实时预览：纯逻辑 --------------------------- */

/**
 * 从候选行里挑出「需要留白」的行：逐行累加高度，够图高就停。
 * 图高 0 / 负数 / 非数 → 没有行要留白；null 条目跳过但不断链。
 *
 * @param {Element[]} lines  widget 那行的后续兄弟，按文档顺序
 * @param {number} height    图真实渲染高度（px）
 * @param {{limit?:number}} [opts]
 * @returns {Element[]}
 */
function planLivePreviewLines(lines, height, opts) {
  const out = [];
  const h = Number(height);
  if (!Array.isArray(lines) || !(h > 0)) return out;
  const limit = opts && Number(opts.limit) > 0 ? Number(opts.limit) : WRAP_LIMIT;
  let acc = 0;
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const el = lines[i];
    if (!el) continue;                       // null 条目跳过，不中断
    if (out.indexOf(el) >= 0) continue;      // 同一行只留一次白
    out.push(el);
    acc += elHeight(el);
    if (acc >= h) break;
  }
  return out;
}

/**
 * 多张图合并成「每行该留多少白」。
 *
 * 同一行可能被两张图同时压到：留白取最大值，不能相加 —— 相加会把同一块空间
 * 算两遍，文字被挤成窄条。左右两侧各算各的。
 *
 * @param {Array<{lines:Element[], side:'left'|'right', span:number}>} blocks
 * @param {{reader?:Function}} [opts] reader：读元素现有 padding（默认读 computed）
 * @returns {Array<{el:Element, left:number, right:number}>}
 */
function planLinePads(blocks, opts) {
  const o = opts || {};
  const out = [];
  if (!Array.isArray(blocks)) return out;
  const reader = typeof o.reader === 'function' ? o.reader : paddingOf;
  const need = new Map();        // el -> {left, right}：需要的最大留白
  const order = [];
  for (const b of blocks) {
    if (!b || !Array.isArray(b.lines)) continue;
    const span = Number(b.span);
    if (!Number.isFinite(span) || span <= 0) continue;
    const side = b.side === 'left' ? 'left' : (b.side === 'right' ? 'right' : '');
    if (!side) continue;
    for (const el of b.lines) {
      if (!el || !el.style) continue;
      let cur = need.get(el);
      if (!cur) { cur = { left: 0, right: 0 }; need.set(el, cur); order.push(el); }
      if (span > cur[side]) cur[side] = span;
    }
  }
  for (const el of order) {
    const cur = need.get(el) || { left: 0, right: 0 };
    let base = { left: 0, right: 0 };
    try {
      const got = reader(el);
      if (got && typeof got === 'object') base = got;
    } catch (e) { base = { left: 0, right: 0 }; }
    out.push({
      el,
      left: round2((Number(base.left) || 0) + cur.left),
      right: round2((Number(base.right) || 0) + cur.right),
    });
  }
  return out;
}

/**
 * 行内样式账本：记下「写之前的值」，复位时按倒序放回去。
 *
 * 为什么不用 WeakSet：复位要还原成原值（可能是主题给的行内值），只记「改过谁」
 * 会把它抹成空。Map 存 el → {prop: prev}，复位完清空，重复施加不会叠加。
 */
function createStyleLedger() {
  const touched = new Map();     // el -> Map(prop -> 写之前的值)
  const order = [];              // [el, prop]，复位倒着走
  return {
    set(el, prop, value) {
      if (!el || !el.style) return false;
      let rec = touched.get(el);
      if (!rec) { rec = new Map(); touched.set(el, rec); }
      if (!rec.has(prop)) {
        const prev = el.style[prop] == null ? '' : String(el.style[prop]);
        rec.set(prop, prev);
        order.push([el, prop]);
      }
      el.style[prop] = value;
      return true;
    },
    reset() {
      let n = 0;
      for (let i = order.length - 1; i >= 0; i--) {
        const pair = order[i];
        const el = pair[0];
        const prop = pair[1];
        if (!el || !el.style) continue;
        const rec = touched.get(el);
        const prev = rec && rec.has(prop) ? rec.get(prop) : '';
        if (prev) {
          el.style[prop] = prev;
        } else if (typeof el.style.removeProperty === 'function') {
          el.style.removeProperty(cssName(prop));
        } else {
          el.style[prop] = '';
        }
        n++;
      }
      order.length = 0;
      touched.clear();
      return n;
    },
    has: (el) => touched.has(el),
    props: (el) => {
      const rec = touched.get(el);
      return rec ? Array.from(rec.keys()) : [];
    },
    size: () => touched.size,
  };
}

/** 把 planLinePads 的结果写进 DOM（经账本，可复位），返回写的条数 */
function applyLinePads(pads, ledger) {
  let n = 0;
  if (!Array.isArray(pads) || !ledger || typeof ledger.set !== 'function') return n;
  for (const p of pads) {
    if (!p || !p.el) continue;
    if (p.right > 0 && ledger.set(p.el, 'paddingRight', round2(p.right) + 'px')) n++;
    if (p.left > 0 && ledger.set(p.el, 'paddingLeft', round2(p.left) + 'px')) n++;
  }
  return n;
}

/* --------------------------- 实时预览：施加 --------------------------- */

/**
 * 对一张浮动图施加 Live Preview 版的「浮动」：定位三件套 + 算出该留白的行。
 * 只碰 opts.ledger 记账的样式，调用方负责在重算前 ledger.reset()。
 *
 * @returns {{host,embed,line,content,side,width,height,span,top,lines,ledger}|null}
 */
function applyLivePreviewFloat(host, cfg, opts) {
  const o = opts || {};
  const mode = cfg && cfg.float;
  const side = mode === 'left' ? 'left' : (mode === 'right' ? 'right' : '');
  if (!side) return null;                       // center / inline 保持原表现
  const ledger = (o.ledger && typeof o.ledger.set === 'function' && typeof o.ledger.reset === 'function')
    ? o.ledger
    : createStyleLedger();
  const parts = livePreviewParts(host);
  if (!parts) return null;
  const embed = parts.embed;
  const line = parts.line;
  const content = parts.content;
  if (!embed.style || !line.style || !content.style) return null;

  const cRect = rectOf(content);
  const eRect = rectOf(embed);
  if (!cRect || !eRect) return null;

  const gap = Number(o.gap) > 0 ? Number(o.gap) : FLOAT_GAP;

  /* 1) 后面根本没有行可绕：干脆不动手。把 embed 改成 absolute 会让它那行塌成 0 高，
   *    而后面又没有内容撑着，.cm-content 的滚动高度会跟着缩，图可能被裁掉。
   *    阅读视图遇到同样情况（没有后续兄弟）也是直接放弃。 */
  const candidates = collectLineSiblings(line.nextElementSibling, o.maxLines);
  if (!candidates.length) return null;

  /* 2) 定位上下文：.cm-line 原本是 relative，会把绝对定位的包含块抢到自己身上，
   *    那样 widget 只能相对这一行定位，后面的行永远绕不上来。 */
  if (computedPosition(line) !== 'static') ledger.set(line, 'position', 'static');
  const contentPos = computedPosition(content);
  if (!contentPos || contentPos === 'static') ledger.set(content, 'position', 'relative');

  /* 3) 图宽：配置优先，没写就用 SVG 实际渲染宽；图高一律按 getBoundingClientRect，
   *    不读 SVG 的 height 属性（CSS 会缩放它）。 */
  const svgRect = o.svg ? rectOf(o.svg) : null;
  const natural = svgRect && svgRect.width > 0 ? svgRect.width : eRect.width;
  const want = Number(cfg.width) > 0 ? Number(cfg.width) : natural;
  const boxW = content.clientWidth || cRect.width || want;
  const width = Math.max(1, Math.min(want, boxW));

  const originX = cRect.left + num(content.clientLeft);
  const originY = cRect.top + num(content.clientTop);
  const top = Math.max(0, eRect.top - originY);      // 脱离流之前在文档里的位置
  const pad = paddingOf(content);

  /* 4) 脱离流：top 沿用原位，横向贴住正文列边界 */
  ledger.set(embed, 'position', 'absolute');
  ledger.set(embed, 'float', 'none');
  ledger.set(embed, 'margin', '0');
  ledger.set(embed, 'top', round2(top) + 'px');
  ledger.set(embed, 'width', round2(width) + 'px');
  ledger.set(embed, 'maxWidth', 'none');
  if (side === 'right') {
    ledger.set(embed, 'right', round2(pad.right) + 'px');
    ledger.set(embed, 'left', 'auto');
  } else {
    ledger.set(embed, 'left', round2(pad.left) + 'px');
    ledger.set(embed, 'right', 'auto');
  }

  /* 5) 改宽之后图可能整体缩放（.bm-floated .brace-map-svg 是 max-width: 100%），
   *    留白要按此刻的真实高度算。 */
  const height = elHeight(embed) || elHeight(host) || eRect.height;

  /* 6) 从 widget 那行的下一个 .cm-line 起逐行留白，累积够图高就停 */
  const lines = planLivePreviewLines(candidates, height, { limit: o.maxLines });

  return {
    host, embed, line, content, side,
    width: round2(width),
    height: round2(height),
    span: round2(width + gap),
    top: round2(top),
    lines,
    ledger,
  };
}

/* --------------------------- 实时预览：取 CM6 view --------------------------- */

/**
 * 找 widget 所属的 CM6 view。三条路依次试，全程 try/catch：拿不到就是 null，不报错。
 *   1. opts.cm（宿主直接给）
 *   2. opts.getCM(host)（宿主注入的取法，推荐）
 *   3. 自己在模块里 require('obsidian') + opts.app：只在按标准 Node require 加载
 *      src/ 时成立；内联构建里 require 是内联表包装，取不到 obsidian，会抛错被这里吃掉。
 */
function findEditorView(host, opts) {
  const o = opts || {};
  if (o.cm && o.cm.dom) return o.cm;
  try {
    if (typeof o.getCM === 'function' && host) {
      const cm = o.getCM(host);
      if (cm && cm.dom) return cm;
    }
  } catch (e) { /* 注入的取法失败就往下退 */ }
  if (!o.app || !host) return null;
  try {
    if (typeof require !== 'function') return null;
    const obsidian = require('obsidian');
    const MarkdownView = obsidian && obsidian.MarkdownView;
    const ws = o.app.workspace;
    if (!MarkdownView || !ws) return null;
    const owns = (cm) => !!(cm && cm.dom && typeof cm.dom.contains === 'function' && cm.dom.contains(host));
    if (typeof ws.getActiveViewOfType === 'function') {
      const active = ws.getActiveViewOfType(MarkdownView);
      const cm = active && active.editor ? active.editor.cm : null;
      if (owns(cm)) return cm;
    }
    if (typeof ws.getLeavesOfType === 'function') {
      const leaves = ws.getLeavesOfType('markdown') || [];
      for (let i = 0; i < leaves.length; i++) {
        const v = leaves[i] && leaves[i].view;
        const cm = v && v.editor ? v.editor.cm : null;
        if (owns(cm)) return cm;
      }
    }
  } catch (e) { /* 内部 API，拿不到就静默跳过 */ }
  return null;
}

/* --------------------------- 实时预览：每个编辑器一个管理者 --------------------------- */

/**
 * 一个 .cm-content 对应一个 manager：一套账本、一个 observer、一次 requestMeasure。
 * 同一文档里多张浮动图共用它，留白才能按行合并（取最大）而不是互相覆盖。
 */
const lpManagers = new WeakMap();

function createLivePreviewManager(content, seed) {
  const o = Object.assign({}, seed || {});
  const ledger = createStyleLedger();
  const widgets = new Set();
  let cm = null;
  let observer = null;
  let observedNode = null;
  let timer = 0;
  let poll = 0;
  let disposed = false;
  let applies = 0;
  let stats = { widgets: 0, lines: 0, styles: 0, applies: 0 };

  const resolveCm = () => {
    if (cm && cm.dom && cm.dom.isConnected !== false) return cm;
    cm = findEditorView(content, o);
    return cm;
  };

  const requestMeasure = () => {
    const view = resolveCm();
    if (!view || typeof view.requestMeasure !== 'function') return false;
    try { view.requestMeasure(); return true; } catch (e) { return false; }
  };

  /** 一轮完整施加：先整体复位上一轮，再按当前 DOM 重算 */
  const pass = () => {
    if (disposed) return stats;
    if (content.isConnected === false) { dispose(); return stats; }
    // 掉出文档的图（笔记关了、切到阅读视图重建了代码块）直接摘掉
    for (const w of Array.from(widgets)) {
      if (!w || !w.host || w.host.isConnected === false) widgets.delete(w);
    }
    if (!widgets.size) { dispose(); return stats; }
    applies++;
    ledger.reset();                       // 复位在重算之前，改动绝不叠加
    const blocks = [];
    const records = [];
    for (const w of Array.from(widgets)) {
      let geo = null;
      try { geo = applyLivePreviewFloat(w.host, w.cfg, { svg: w.svg, gap: w.gap, ledger }); }
      catch (err) { geo = null; }
      if (!geo) continue;
      records.push(geo);
      blocks.push({ lines: geo.lines, side: geo.side, span: geo.span });
    }
    const pads = planLinePads(blocks, { reader: paddingOf });
    const styles = applyLinePads(pads, ledger);
    stats = { widgets: records.length, lines: pads.length, styles, applies };
    requestMeasure();
    return stats;
  };

  const schedule = () => {
    if (disposed || timer) return;
    try {
      timer = setTimeout(() => {
        timer = 0;
        if (disposed) return;
        pass();
      }, LP_DEBOUNCE);
    } catch (e) { timer = 0; }
  };

  const ensureObserved = () => {
    if (disposed || observer) return;
    const MO = typeof MutationObserver !== 'undefined' ? MutationObserver : null;
    if (!MO) return;
    const view = resolveCm();
    const node = (view && view.dom) ? view.dom : content;
    try {
      observer = new MO(() => {
        if (disposed) return;
        if (content.isConnected === false) { dispose(); return; }
        schedule();
      });
      observer.observe(node, { childList: true, subtree: true });
      observedNode = node;
    } catch (e) { observer = null; observedNode = null; }
  };

  /* 兜底巡检：observer 只在被观察子树产生 childList 变化时回调，编辑器整个被换掉
   * （切笔记、切阅读视图）时不会触发。这里低频对一下：图还在不在、观察目标换了没。 */
  const startPoll = () => {
    if (poll || disposed || typeof setInterval !== 'function') return;
    try {
      poll = setInterval(() => {
        if (disposed) return;
        if (content.isConnected === false) { dispose(); return; }
        for (const w of Array.from(widgets)) {
          if (!w || !w.host || w.host.isConnected === false) widgets.delete(w);
        }
        if (!widgets.size) { dispose(); return; }
        const view = resolveCm();
        const want = (view && view.dom) ? view.dom : content;
        if (observer && observedNode !== want) {
          try { observer.disconnect(); } catch (e) { /* ignore */ }
          try {
            observer.observe(want, { childList: true, subtree: true });
            observedNode = want;
            schedule();
          } catch (e) { observer = null; observedNode = null; }
        }
      }, LP_POLL);
    } catch (e) { poll = 0; }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timer) { try { clearTimeout(timer); } catch (e) { /* ignore */ } timer = 0; }
    if (poll) { try { clearInterval(poll); } catch (e) { /* ignore */ } poll = 0; }
    if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } }
    observer = null;
    observedNode = null;
    try { ledger.reset(); } catch (e) { /* ignore */ }
    widgets.clear();
    try { lpManagers.delete(content); } catch (e) { /* ignore */ }
  };

  return {
    content,
    attach(w) {
      if (disposed || !w) return false;
      if (w.opts) {
        if (w.opts.cm && !o.cm) o.cm = w.opts.cm;
        if (w.opts.app && !o.app) o.app = w.opts.app;
        if (w.opts.getCM && !o.getCM) o.getCM = w.opts.getCM;
      }
      widgets.add(w);
      ensureObserved();
      startPoll();
      pass();
      return true;
    },
    detach(w) {
      widgets.delete(w);
      if (disposed) return;
      if (!widgets.size) { dispose(); return; }
      pass();
    },
    refresh() { if (!disposed) pass(); },
    state() { return { attached: !disposed, widgets: widgets.size, lines: stats.lines, styles: stats.styles, applies: stats.applies }; },
    dispose,
  };
}

/**
 * Live Preview 版浮动控制。形状与阅读视图的 attachFloatWrap 一致
 * （host / update / dispose / state），trackFloat 不用分叉。
 */
function attachLivePreviewFloat(host, cfg, opts) {
  const o = opts || {};
  const side = cfg && cfg.float;
  if (side !== 'left' && side !== 'right') return null;
  if (!host || typeof host.getBoundingClientRect !== 'function') return null;

  const widget = { host, cfg, svg: o.svg, gap: o.gap, opts: o };
  let manager = null;
  let disposed = false;
  let attempt = 0;
  let retry = 0;

  const stopRetry = () => {
    if (!retry) return;
    try { clearTimeout(retry); } catch (e) { /* ignore */ }
    retry = 0;
  };

  const nextRetry = () => {
    if (disposed || retry) return;
    if (attempt >= LP_RETRY.length) return;
    const delay = LP_RETRY[attempt++];
    try { retry = setTimeout(attach, delay); } catch (e) { retry = 0; }
  };

  function attach() {
    retry = 0;
    if (disposed || manager) return;
    const parts = livePreviewParts(host);
    if (!parts) { nextRetry(); return; }      // 还没插进文档，稍后再试
    let m = lpManagers.get(parts.content);
    if (!m) {
      m = createLivePreviewManager(parts.content, { cm: o.cm, app: o.app, getCM: o.getCM });
      lpManagers.set(parts.content, m);
    }
    manager = m;
    m.attach(widget);
  }

  attach();

  return {
    host,
    update: () => {
      if (disposed) return;
      if (manager) manager.refresh();
      else attach();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopRetry();
      const m = manager;
      manager = null;
      if (m) m.detach(widget);
    },
    state: () => (manager ? manager.state() : { attached: false, side }),
  };
}

/* ============================================================
 * 传统 float 样式（center / inline 仍靠它；left / right 作为
 * 实时预览与 JS 浮动失败时的兜底）
 *
 * 只能写在 host（Obsidian 给的代码块容器）上，不能写在内部的 .brace-map-block：
 * float 只影响「与后续兄弟元素的关系」，内部 div 浮动后宿主仍是块级。
 *
 * 指令词与 Blue Topaz 主题的图片浮动一致（L/R/C/inl），外边距也照它的取值。
 * ============================================================ */
function applyFloatLayout(host, cfg) {
  if (!host || !host.style || !cfg) return;
  const mode = cfg.float;
  const w = Number.isFinite(cfg.width) && cfg.width > 0 ? cfg.width + 'px' : '';
  if (!mode) return;

  const s = host.style;
  if (w) {
    s.width = w;
    s.maxWidth = '100%';
  }

  if (mode === 'left') {
    s.float = 'left';
    s.margin = '0.5rem 1rem 0.5rem 0';
    s.clear = 'both';
  } else if (mode === 'right') {
    s.float = 'right';
    s.margin = '0.5rem 0 0.5rem 1rem';
    s.clear = 'both';
  } else if (mode === 'center') {
    // 居中不是 float：强制换行后自己居中，文字不环绕
    s.float = 'none';
    s.margin = w ? '0.5rem auto' : '0.5rem auto';
    s.display = 'block';
  }
  // inline：让图当成行内元素跟着文字走。SVG 本身是块级，靠宿主 display 改
  else if (mode === 'inline') {
    s.float = 'none';
    s.display = 'inline-block';
    s.verticalAlign = 'middle';
    s.margin = '0 0.1em';
  }

  host.classList.add('bm-floated');
  host.classList.add('bm-float-' + mode);
}

module.exports = {
  FLOAT_GAP,
  CLIMB_LIMIT,
  WRAP_LIMIT,
  LP_DEBOUNCE,
  LP_POLL,
  LP_RETRY,
  elHeight,
  collectWrapTargets,
  // 实时预览（CM6）
  classHas,
  climbTo,
  livePreviewParts,
  collectLineSiblings,
  planLivePreviewLines,
  planLinePads,
  applyLinePads,
  createStyleLedger,
  applyLivePreviewFloat,
  findEditorView,
  attachLivePreviewFloat,
  pxValue,
  setInlineStyle,
  restoreStyles,
  applyWrapMargins,
  restoreWrapMargins,
  readMargins,
  isLivePreview,
  pickContext,
  floatify,
  resetFloat,
  attachFloatWrap,
  applyFloatLayout,
};
