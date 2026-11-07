'use strict';

/*
 * 临时诊断（默认关闭，见 src/debug.js）。
 * 每一次 dbg() / dbgNull() 都是只读的：取元素 / 读样式 / 记一行 JSON，
 * 不改布局、不抛错。DEBUG_LP 关掉后这些调用直接返回。
 */
const {
  dbg, dbgEl, dbgRect, dbgCss, dbgInlineAll, dbgChain,
} = require('./debug.js');

/* ============================================================
 * ★★★ 编辑模式（Live Preview）浮动总开关 ★★★
 *
 * 开（默认）：编辑模式里给宿主写一行 float / width / margin，别的什么都不做。
 *   关：一条布局样式都不写，图占整行，排法与没装插件时一致。
 * 阅读视图的图文混排不受它影响。
 *
 * 为什么一行 float 就够（真机 + headless 双重实测）：
 *   1. 宿主 float 之后，.cm-embed-block 里只有浮动子元素，高度塌成 0，
 *      CM6 量到 0、记 0，DOM 与账本两边一致，光标不错位
 *   2. .cm-embed-block 不是独立格式化上下文（styles.css 用静态规则抹掉了内核的
 *      contain: paint），浮动因此穿透到 .cm-content 那一层
 *   3. .cm-content 是 flex item，自成格式化上下文，后面的 .cm-line 真的绕排
 *
 * 之前那些机制（widget 钉高、宿主绝对定位、逐行 padding、MutationObserver、
 * 巡检、重测时间线）全是为「怎么绕开 widget 高度这笔账」发明的；上面这条路径
 * 不需要绕，账本来就是对的。所以全部删掉，编辑模式只剩一行 float。
 *
 * 设置页里的值用插件自己的 loadData / saveData 存，这里只是它的默认值。
 * ============================================================ */
const LP_FLOAT = true;

/** 运行时的真值：插件加载设置页之后会用 setLpFloatEnabled() 覆盖它 */
let lpFloatEnabled = LP_FLOAT;

/** 编辑模式浮动现在是开着的吗 */
function isLpFloatEnabled() {
  return !!lpFloatEnabled;
}

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
  // 诊断：直接回答「isLivePreview(host) 是不是 false，于是走了阅读视图那条路」
  dbg('attach.enter', () => ({
    side: side || null,
    live: isLivePreview(host),
    host: dbgEl(host),
    inDoc: !!(host && host.isConnected),
    chain: dbgChain(host, 5),
  }));
  if (side !== 'left' && side !== 'right') return null;
  if (!host || typeof host.getBoundingClientRect !== 'function') return null;
  if (typeof host.style === 'undefined') return null;
  /*
   * 编辑模式：宿主上那一行 float 就是全部（renderBraceMap 已经写过），
   * 这里不再算任何高度、不再碰任何行。开关关掉时把 float 撤掉，图回到整行。
   */
  if (isLivePreview(host)) {
    if (!isLpFloatEnabled()) resetFloatLayout(host);
    dbg('attach.branch', () => ({ branch: 'live-preview-float-only', lpFloat: isLpFloatEnabled() }));
    return null;
  }
  dbg('attach.branch', () => ({ branch: 'reader' }));
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
 * 编辑模式（CM6）为什么只用 float
 *
 *     .cm-content（flex item，自成格式化上下文）
 *       .cm-embed-block（position: relative，不是格式化上下文）
 *         host（float: right + width + margin）
 *       .cm-line × N
 *
 * 1. 浮动子元素不计入父盒高度，.cm-embed-block 高度塌成 0：CM6 量到 0、记 0，
 *    光标按真实 DOM 反推，不会错位
 * 2. embed 不是独立格式化上下文（内核那条 contain: paint 被 styles.css 的静态
 *    规则抹掉），浮动穿透到 .cm-content 那一层
 * 3. .cm-content 是 flex item，自成格式化上下文，后面的 .cm-line 真的绕排
 *
 * 所以编辑模式不需要任何尺寸干预：没有钉高、没有绝对定位、没有逐行留白、
 * 没有观察者也没有定时器。headless 实测（图 300×170、正文列 800）：
 *   embed 高度 0 / 前两行文字右边界 499 < 图左边界 516 / 零行文字压图。
 * ============================================================ */

/* --------------------------- 元素与 class 小工具 --------------------------- */

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

/* ------------------ 图为什么看不见：裁剪链体检（只读） ------------------ */

/**
 * 「SVG 在 DOM 里、尺寸正常、就是看不见」只有三种可能：被裁了、跑偏了、被隐藏了。
 * rect 帮不上忙 —— getBoundingClientRect 不反映裁剪，图被切掉时 rect 依旧完整。
 *
 * 裁剪的来源也不一定是 overflow：内核给块 widget 写过
 *   .markdown-source-view.mod-cm6 .cm-content > [contenteditable=false] {
 *     contain: paint !important;
 *   }
 * 所以体检要读五样：overflow / overflowX / overflowY / contain / clip-path。
 * styles.css 用同一条静态规则把 contain 抹掉（编辑模式全靠浮动穿透），
 * 这里只负责把真机读数吐出来，供「图怎么又不见了」时对账。
 */

/** 往上体检最多爬几层（host → .block-language-* → widget → .cm-content，十层绰绰有余） */
const CLIP_DEPTH = 24;

/**
 * 一定不碰的层：滚动容器与编辑器根。
 * 把 .cm-scroller 的 overflow 改成 visible 会废掉滚动条，所以它是硬边界：
 * 只进诊断链，绝不下手。
 */
const CLIP_HARD_STOP = ['cm-scroller', 'cm-editor', 'markdown-source-view', 'app-container'];

/** 读 computed 样式：先看注入的 getStyle（自测用），再看元素自己的 window */
function styleOfEl(el, opts) {
  const o = opts || {};
  if (!el) return null;
  try {
    if (typeof o.getStyle === 'function') {
      const cs = o.getStyle(el);
      if (cs) return cs;
    }
  } catch (e) { /* 注入的读法坏了就往下退 */ }
  try {
    const doc = el.ownerDocument;
    const view = doc && doc.defaultView;
    if (view && typeof view.getComputedStyle === 'function') return view.getComputedStyle(el);
  } catch (e) { /* 假 DOM / 离屏节点读不到 */ }
  return null;
}

/** overflow 的取值里会裁掉溢出的：hidden / scroll / auto / clip / overlay */
function overflowClips(v) {
  const s = String(v == null ? '' : v).toLowerCase().trim();
  if (!s || s === 'visible') return false;
  return /hidden|scroll|auto|clip|overlay/.test(s);
}

/** contain 的取值里会裁掉溢出的：paint / content / strict（layout 本身不裁） */
function containClips(v) {
  const s = String(v == null ? '' : v).toLowerCase().trim();
  if (!s || s === 'none') return false;
  return /paint|content|strict/.test(s);
}

/** 这一层是不是绝对不许动的（滚动容器 / 编辑器根 / 页面根） */
function isClipHardStop(el) {
  if (!el) return true;
  for (let i = 0; i < CLIP_HARD_STOP.length; i++) {
    if (classHas(el, CLIP_HARD_STOP[i])) return true;
  }
  let tag = '';
  try { tag = String(el.tagName || '').toLowerCase(); } catch (e) { tag = ''; }
  return tag === 'body' || tag === 'html';
}

/**
 * 一层的体检结果：属性原值 + 「为什么裁」。
 * why 里的标签直接对应类名，日志里一眼能定位是哪条规则在切图。
 * hard 为真的层只读不写（.cm-scroller 及以上）。
 */
function clipNodeInfo(el, opts) {
  const cs = styleOfEl(el, opts);
  const get = (p) => {
    try { return cs && cs[p] != null ? String(cs[p]) : ''; } catch (e) { return ''; }
  };
  const info = {
    el: dbgEl(el),
    overflow: get('overflow'),
    overflowX: get('overflowX'),
    overflowY: get('overflowY'),
    position: get('position'),
    transform: get('transform'),
    contain: get('contain'),
    contentVisibility: get('contentVisibility'),
    clipPath: get('clipPath'),
    visibility: get('visibility'),
    opacity: get('opacity'),
    editable: '',
    hard: false,
    why: [],
  };
  try {
    const raw = el && typeof el.getAttribute === 'function' ? el.getAttribute('contenteditable') : null;
    info.editable = raw == null ? '' : String(raw);
  } catch (e) { info.editable = ''; }
  info.hard = isClipHardStop(el);
  if (overflowClips(info.overflow) || overflowClips(info.overflowX) || overflowClips(info.overflowY)) {
    info.why.push('overflow');
  }
  if (containClips(info.contain)) info.why.push('contain');
  if (info.clipPath && info.clipPath !== 'none') info.why.push('clip-path');
  if (info.contentVisibility === 'hidden') info.why.push('content-visibility');
  /* 主题把块淡出（opacity:0）或者藏起来（visibility:hidden）也是同一个结果：图看不见 */
  if (info.opacity !== '' && Number(info.opacity) === 0) info.why.push('opacity');
  if (/hidden|collapse/.test(info.visibility)) info.why.push('visibility');
  info.clips = info.why.length > 0;
  return info;
}

/**
 * 从 startEl 往上走到 stopEl（含端点）逐层体检。
 * stopEl 传 null 就一路走到硬边界（.cm-scroller / .cm-editor）为止，只读不写。
 * 顺序是从内到外，读日志时从上到下就是 DOM 的嵌套顺序。
 *
 * @returns {Array<{node:Element, info:object}>}
 */
function clipChainOf(startEl, stopEl, opts) {
  const out = [];
  let cur = startEl;
  for (let i = 0; cur && i < CLIP_DEPTH; i++) {
    const info = clipNodeInfo(cur, opts);
    out.push({ node: cur, info });
    if (stopEl && cur === stopEl) break;
    if (info.hard) break;                    // 硬边界自己进链，到此为止
    cur = cur.parentElement;
  }
  return out;
}

/** rect 收成诊断用的四个数 */
function rectBox(r) {
  if (!r) return null;
  return { top: round2(r.top), left: round2(r.left), w: round2(r.width), h: round2(r.height) };
}

/**
 * 「图为什么看不见」的现场取证，一条记录回答三件事：
 *   被裁了   链上有没有在裁的层（rect 看不出来）
 *   跑偏了   host / svg 的 rect 是否落在视口外
 *   被隐藏了 svg 的 display / visibility / opacity
 * verdict：ok / clipped / offscreen / hidden / norect。
 * 视口尺寸拿不到（假 DOM）时 inViewport 是 null，不误判成 offscreen。
 */
function visibilityReport(host, svg, content, opts) {
  const o = opts || {};
  const chain = clipChainOf(host, content, o);
  const hostRect = rectOf(host);
  const svgRect = svg ? rectOf(svg) : null;
  const svgCs = svg ? styleOfEl(svg, o) : null;
  const pick = (p) => {
    try { return svgCs && svgCs[p] != null ? String(svgCs[p]) : ''; } catch (e) { return ''; }
  };

  let view = o.view || null;
  if (!view) {
    try {
      const doc = host && host.ownerDocument;
      view = doc && doc.defaultView ? doc.defaultView : null;
    } catch (e) { view = null; }
  }
  const vw = view && Number(view.innerWidth) > 0 ? Number(view.innerWidth) : null;
  const vh = view && Number(view.innerHeight) > 0 ? Number(view.innerHeight) : null;
  const inView = (r) => {
    if (!r || vw == null || vh == null) return null;
    return (r.top + r.height) > 0 && r.top < vh && (r.left + r.width) > 0 && r.left < vw;
  };

  const clippers = chain.filter((x) => x.info.clips && !x.info.hard);
  /* 链上只有「藏」没有「裁」：判决成 hidden，而不是 clipped */
  const onlyHidden = clippers.length > 0 && clippers.every((x) => x.info.why.every(
    (w) => w === 'opacity' || w === 'visibility'));
  const hidden = pick('display') === 'none'
    || /hidden|collapse/.test(pick('visibility'))
    || Number(pick('opacity')) === 0;
  const hostIn = inView(hostRect);
  const svgIn = inView(svgRect);

  let verdict = 'ok';
  if (!svgRect && !hostRect) verdict = 'norect';
  else if (hidden || onlyHidden) verdict = 'hidden';
  else if (clippers.length) verdict = 'clipped';
  else if (svgIn === false || (svgIn == null && hostIn === false)) verdict = 'offscreen';

  const embed = climbTo(host, 'cm-embed-block', CLIP_DEPTH);
  return {
    verdict,
    reason: clippers.length
      ? clippers.map((x) => x.info.el + ':' + x.info.why.join('+')).join(' | ')
      : '',
    viewport: { w: vw, h: vh },
    host: { rect: rectBox(hostRect), inViewport: hostIn },
    svg: {
      rect: rectBox(svgRect),
      inViewport: svgIn,
      display: pick('display'),
      visibility: pick('visibility'),
      opacity: pick('opacity'),
    },
    /* widget 自己的四个口径：高度 / overflow / position / contain 是否真的生效了 */
    embed: embed ? {
      el: dbgEl(embed),
      rect: dbgRect(embed),
      computed: dbgCss(embed, ['height', 'overflow', 'overflowX', 'overflowY',
        'position', 'contain', 'clipPath']),
      inline: dbgInlineAll(embed),
      editable: clipNodeInfo(embed, o).editable,
    } : null,
    chain: chain.map((x) => x.info),
    clipCount: clippers.length,
  };
}

/**
 * 编辑模式浮动总开关。默认值见文件顶部的 LP_FLOAT；设置页通过插件自己的
 * loadData / saveData 存，加载时用这里改运行时真值。
 *
 * 只管一个布尔值：编辑模式是否允许写 float。已经渲染过的老宿主由
 * clearLivePreviewFloatLayout() 负责撤样式，这里不碰 DOM。
 */
function setLpFloatEnabled(on) {
  lpFloatEnabled = on !== false;
  dbg('lp.float.toggle', () => ({ on: lpFloatEnabled }));
  return lpFloatEnabled;
}

/* ============================================================
 * 编辑模式与阅读视图共用的那行 float（唯一写布局样式的地方）
 *
 * 只能写在 host（Obsidian 给的代码块容器）上，不能写在内部的 .brace-map-block：
 * float 只影响「与后续兄弟元素的关系」，内部 div 浮动后宿主仍是块级。
 *
 * 阅读视图里 float 本身不产生绕排（宿主管在 flex 容器下），最终排版靠
 * floatify 的绝对定位 + 邻白；它就是那条路的前提样式。
 * 编辑模式里不再有任何后续处理：这一行写下去，剩下的交给浏览器。
 *
 * 指令词与 Blue Topaz 主题的图片浮动一致（L/R/C/inl），外边距也照它的取值。
 * ============================================================ */
function applyFloatLayout(host, cfg) {
  if (!host || !host.style || !cfg) return;
  const mode = cfg.float;
  const w = Number.isFinite(cfg.width) && cfg.width > 0 ? cfg.width + 'px' : '';
  if (!mode) return;

  /* 上一轮写下的先还回去，再把这一轮记下来：重复调用不会把我们的值当成「原值」，
   * 也不会因为换了模式而留下一堆前一轮的残留（比如 inline 的 vertical-align）。 */
  if (Array.isArray(host.__bmFloatLayout)) restoreStyles(host.__bmFloatLayout);
  const recs = [];
  const put = (prop, value) => {
    const r = setInlineStyle(host, prop, value);
    if (r) recs.push(r);
  };

  if (w) {
    put('width', w);
    put('maxWidth', '100%');
  }

  if (mode === 'left') {
    put('float', 'left');
    put('margin', '0 1rem 0.5rem 0');
    put('clear', 'both');
  } else if (mode === 'right') {
    put('float', 'right');
    put('margin', '0 0 0.5rem 1rem');
    put('clear', 'both');
  } else if (mode === 'center') {
    // 居中不是 float：强制换行后自己居中，文字不环绕
    put('float', 'none');
    put('margin', '0.5rem auto');
    put('display', 'block');
  }
  // inline：让图当成行内元素跟着文字走。SVG 本身是块级，靠宿主 display 改
  else if (mode === 'inline') {
    put('float', 'none');
    put('display', 'inline-block');
    put('verticalAlign', 'middle');
    put('margin', '0 0.1em');
  }

  host.__bmFloatLayout = recs;
  host.__bmCfg = cfg;                     // 设置页切开关时要靠它重写，不能丢
  host.classList.add('bm-floated');
  host.classList.add('bm-float-' + mode);
}

/**
 * 把 applyFloatLayout 写下的样式原样还回去（含类名）。
 * 关掉编辑模式浮动时要用：那层的 float / margin 也是布局样式，不能留着。
 */
function resetFloatLayout(host) {
  if (!host) return 0;
  const recs = host.__bmFloatLayout;
  let n = 0;
  if (Array.isArray(recs)) {
    n = restoreStyles(recs);
    host.__bmFloatLayout = null;
  }
  try {
    const cl = host.classList;
    if (cl && typeof cl.remove === 'function') {
      cl.remove('bm-floated', 'bm-float-left', 'bm-float-right', 'bm-float-center', 'bm-float-inline');
    }
  } catch (e) { /* ignore */ }
  return n;
}

/* ============================================================
 * 垂直基准（valign）：只能靠负 margin-top 模拟
 *
 * 浮动元素没法垂直居中；换成 position: absolute 又会脱离浮动流，后面的文字
 * 立刻不绕排。所以只能「量出来再顶上去」：量出图高和它后面那段可绕排文字的
 * 高度，按基准算出该往上提多少，写进宿主的 margin-top。
 *
 * 有意不做巡检：编辑过程中后面的文字段高度会变，图不会跟着重排。允许不准，
 * 重开笔记时重新量一次就恢复。这里不加 MutationObserver、不加定时器、不加
 * rAF 循环，也不重试 —— 挂载那一刻量不到就按 top 处理。
 * ============================================================ */

/**
 * 纯计算：按垂直基准算出 margin-top 该写的偏移（px，0 或负数）。
 *
 * textH 是图后面那段可绕排文字的高度，imgH 是图自己的高度。
 * 文字比图矮时没有可对齐的空间，三种基准一律返回 0：宁可贴顶，
 * 也不把图往下推（往下推会盖住后面本来该绕排的文字）。
 *
 * @param {number} textH
 * @param {number} imgH
 * @param {'top'|'middle'|'bottom'} valign
 * @returns {number}
 */
function valignOffset(textH, imgH, valign) {
  const t = Number(textH);
  const h = Number(imgH);
  if (!Number.isFinite(t) || !Number.isFinite(h)) return 0;
  if (valign !== 'middle' && valign !== 'bottom') return 0;
  const diff = t - h;
  if (!(diff > 0)) return 0;
  return valign === 'middle' ? -diff / 2 : -diff;
}

/**
 * 量「图后面那段可绕排文字」的高度：从 .cm-embed-block 的下一个兄弟开始，
 * 只累加带 cm-line 的兄弟，碰到第一个不带 cm-line 的就停。
 *
 * 停下来的那条规则是必须的：再往后就是别的块（另一个 widget、代码块），
 * 它们不参与绕排，算进来只会把图提得太高。
 */
function measureFollowTextHeight(embed) {
  let el = embed && embed.nextElementSibling ? embed.nextElementSibling : null;
  let acc = 0;
  while (el) {
    if (!classHas(el, 'cm-line')) break;
    acc += elHeight(el);
    el = el.nextElementSibling;
  }
  return acc;
}

/**
 * 按 cfg.valign 给编辑模式里的浮动图写垂直偏移（负 margin-top）。
 *
 * 只对真正浮动的 left/right 生效；center/inline 本来就不浮动，valign 没有
 * 可对齐的对象。只对编辑模式（宿主在 .cm-editor 里）生效，阅读视图那条
 * floatify / applyWrapMargins 的路一行都不动。
 *
 * 写样式必须走 setInlineStyle 并记进 host.__bmFloatLayout：那份记录归
 * resetFloatLayout 统一还原，复位后不会留下写死的 margin-top。
 *
 * 不做重试：宿主还没连进文档、或量出来 textH 为 0，都当 top（偏移 0）处理。
 *
 * @returns {number} 写下去的偏移量（0 表示没动样式）
 */
function applyValignLayout(host, cfg) {
  if (!host || !host.style || !cfg) return 0;
  const mode = cfg.float;
  if (mode !== 'left' && mode !== 'right') return 0;
  if (!climbTo(host, 'cm-editor')) return 0;       // 阅读视图 / 预览页：不碰
  if (!classHas(host, 'bm-floated')) return 0;     // float 没真写上去时不能加偏移

  const info = { valign: cfg.valign || 'top', textH: 0, imgH: 0, offset: 0 };
  host.__bmValignInfo = info;

  const embed = host.parentElement;
  if (!embed || host.isConnected === false) return 0;   // 还没挂进文档：当 top

  info.imgH = round2(elHeight(host));
  info.textH = round2(measureFollowTextHeight(embed));
  // textH 为 0（挂载那一刻还没排出文字）时 valignOffset 会返回 0，即 top
  const offset = valignOffset(info.textH, info.imgH, info.valign);
  if (!offset) return 0;

  info.offset = round2(offset);
  const rec = setInlineStyle(host, 'marginTop', info.offset + 'px');
  if (rec) {
    if (!Array.isArray(host.__bmFloatLayout)) host.__bmFloatLayout = [];
    host.__bmFloatLayout.push(rec);
  }
  return offset;
}

/**
 * 把当前页编辑区里所有括号图宿主的 float 复位（开关关掉时用）。
 * 没有 document（自测 / 非浏览器环境）时返回 0，不报错。
 */
function clearLivePreviewFloatLayout(doc) {
  return eachLiveHost(doc, (host) => resetFloatLayout(host));
}

/**
 * 把当前页编辑区里所有括号图宿主按各自记住的 cfg 重新写一遍 float（开关打开时用）。
 * 只写那一行样式，不重建图、不重算任何尺寸。
 */
function reapplyLivePreviewFloatLayout(doc) {
  return eachLiveHost(doc, (host) => {
    if (!host.__bmCfg) return 0;
    applyFloatLayout(host, host.__bmCfg);
    return 1;
  });
}

/** 走一遍 .cm-editor 里的括号图宿主（brace / bmap 两种语言块） */
function eachLiveHost(doc, fn) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d || typeof d.querySelectorAll !== 'function') return 0;
  let nodes = [];
  try {
    nodes = d.querySelectorAll('.cm-editor .block-language-brace, .cm-editor .block-language-bmap') || [];
  } catch (e) { return 0; }
  let n = 0;
  for (let i = 0; i < nodes.length; i++) {
    try { n += fn(nodes[i]) || 0; } catch (e) { /* 单个宿主失败不影响其他 */ }
  }
  return n;
}

module.exports = {
  FLOAT_GAP,
  CLIMB_LIMIT,
  WRAP_LIMIT,
  elHeight,
  collectWrapTargets,
  /* 编辑模式浮动总开关（默认值 LP_FLOAT，设置页通过 set 改运行时真值） */
  LP_FLOAT,
  isLpFloatEnabled,
  setLpFloatEnabled,
  /* 图为什么看不见：裁剪链体检（read-only，诊断命令用） */
  CLIP_DEPTH,
  CLIP_HARD_STOP,
  classHas,
  climbTo,
  styleOfEl,
  overflowClips,
  containClips,
  isClipHardStop,
  clipNodeInfo,
  clipChainOf,
  visibilityReport,
  resetFloatLayout,
  clearLivePreviewFloatLayout,
  reapplyLivePreviewFloatLayout,
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
  valignOffset,
  measureFollowTextHeight,
  applyValignLayout,
};
