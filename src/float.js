'use strict';

/*
 * 临时诊断（默认关闭，见 src/debug.js）。
 * 每一次 dbg() / dbgNull() 都是只读的：取元素 / 读样式 / 记一行 JSON，
 * 不改布局、不抛错。DEBUG_LP 关掉后这些调用直接返回。
 */
const {
  dbg, dbgNull, dbgEl, dbgRect, dbgCss, dbgInline, dbgInlineAll,
  dbgChildCount, dbgFirstChild, dbgChain,
} = require('./debug.js');
const { createMeasureScheduler, RMEASURE_GAP, RMEASURE_SCROLL_IDLE } = require('./remeasure.js');

/* ============================================================
 * ★★★ 编辑模式（Live Preview）浮动总开关 ★★★
 *
 * 关闭后 Live Preview 里一条布局样式都不写：不浮动、不留白、不写宽度，
 * 图按 Obsidian 原生的块级 widget 排，光标跟没装插件时一样。
 * 阅读视图的图文混排不受它影响。
 *
 * 默认关闭：新方案（一行高度 + 绝对定位图 + 逐行留白）待真机验光标，验过再谈默认开。
 *
 * 前两版死在同一处：CM6 给 .cm-embed-block 这个 block widget 单独记一笔高度
 * （实测 190px）。
 *   1) float：widget 在流里占 0，账上还是 190，光标按错账反推（点 18 行落 14 行）
 *   2) height:0：账对上了，但浮动排除区受盒子高度限制，文字不再绕排
 * 两版都卡在「widget 高度」这笔账上，而它是插件改不了也骗不过的。
 *
 * 现行方案把账做成真的：
 *   - .cm-embed-block 高度钉死成一行，CM6 量到什么就记什么，DOM 也真的只占这么多
 *   - 图绝对定位从这一行浮出去，父盒高度已被钉死，溢出不影响父盒
 *   - 后续 .cm-line 逐行加 padding：行被挤窄 → 折行变多 → 行变高，
 *     这是真实的 DOM 变化，CM6 会自己重新量
 * 偏差从「widget 高度」搬到了「行高」，而后者的变化 CM6 认。
 *
 * 用户仍然可以在设置里打开（设置 → Brace Map → 「编辑模式浮动」）。
 * 阅读视图不受影响，那边的图文混排是好的。
 *
 * 两个关法：
 *   1. 插件设置 → Brace Map → 「编辑模式浮动」，默认就是关的
 *   2. 把下面这行的 false 改成 true，再 node build.js（默认值跟着变）
 *
 * 设置页里的值用插件自己的 loadData / saveData 存，这里只是它的默认值。
 * ============================================================ */
const LP_FLOAT = false;

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
  // 实时预览走另一条路：CM6 每行独立，阅读视图的「给兄弟加外边距」对它无效
  if (isLivePreview(host)) {
    dbg('attach.branch', () => ({ branch: 'live-preview' }));
    return attachLivePreviewFloat(host, cfg, o);
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
 * 实时预览（CM6）：两条路，按结构分派
 *
 * 结构一 direct-embed（Obsidian 1.13.7 实测）
 *     .cm-content > .cm-embed-block > host
 *   .cm-content 是 flex item，自成格式化上下文 → 原生 float 完整可用。
 *   走「一行高度 + 绝对定位图 + 逐行留白」：widget 钉成一行，图从这一行浮出去。
 *   见后面「实时预览：一行高度 + 绝对定位图 + 逐行留白」。
 *
 * 结构二 cm-line（旧版 / 部分主题）
 *     .cm-content > .cm-line > .cm-embed-block > host
 *   阅读视图那套「脱离流 + 给后续兄弟加外边距」在这里不成立：CM6 把正文切成
 *   一个个 .cm-line，widget 浮在自己那一行里，后面的行跟它没有兄弟关系，
 *   float 再正确也不会有文字绕上来。真正的做法是让 widget 相对整个 .cm-content 定位：
 *
 *     1. widget 所在的 .cm-line 设 position: static（它原本是 relative，
 *        会抢走绝对定位的包含块）
 *     2. .cm-content 设 position: relative，成为包含块
 *     3. .cm-embed-block 设 position: absolute，top 沿用它在流里的原位置，
 *        右浮动贴 right: 0、左浮动贴 left: 0
 *     4. 从 widget 那行的下一行起逐行加 paddingRight / paddingLeft，
 *        累积高度超过图高就停 —— 图下面那行不留白
 *
 *   这条路下的节拍：CM6 是虚拟滚动的，滚动、输入、折叠都会增删 .cm-line，
 *   加上的样式随时会丢。每次施加先整体复位上一轮再重算，由挂在编辑器根节点上的
 *   MutationObserver 驱动（150ms 合并），施加完调一次 requestMeasure 让 CM6
 *   重新量行高。direct-embed 结构不进这条路，这套机制只在老结构里跑。
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
 *   line    「这一行」—— 默认是它的父 .cm-line；新版 Obsidian 没有这一层时就是 embed 自己
 *   content .cm-content      —— 变成包含块的那个
 *
 * 两种结构都认（实机祖先链差一整层，两种都出现过）：
 *   结构一  content > .cm-line > .cm-embed-block   → mode 'cm-line'      （旧版 / 部分主题）
 *   结构二  content > .cm-embed-block              → mode 'direct-embed' （Obsidian 1.13.7 实测）
 *
 * 结构二里没有 .cm-line 这一层：block widget 直接是 .cm-content 的子项，
 * 它自己就跟后面的正文行平级。旧实现在「找 line」那一步返回 null，重试五轮后
 * 静默放弃，一次样式都没施加过。这里把 embed 自己当成 line 返回：
 * nextElementSibling 正好是后面第一行，位置关系跟旧结构一致，后续逻辑不用分叉。
 *
 * 注意 embed 自身 computed position 是 relative（Obsidian app.css 写死）。
 * 老结构当 line 用时，施加阶段必须把它改掉，否则绝对定位的包含块会被它自己抢走；
 * direct-embed 结构走「一行高度」那条，embed 的 position 要改成 relative 当绝对定位的包含块。
 *
 * @returns {{embed:Element, line:Element, content:Element, mode:'cm-line'|'direct-embed'}|null}
 */
function livePreviewParts(el) {
  if (!el) return null;
  const embed = climbTo(el, 'cm-embed-block', CLIMB_LIMIT + 8);
  if (!embed) return null;
  const content = climbTo(embed, 'cm-content', CLIMB_LIMIT + 12);
  if (!content) return null;

  /* 结构一：embed 在 .cm-line 里 —— 老路，先走它，不能被回退吃掉 */
  let line = embed.parentElement;
  if (!classHas(line, 'cm-line')) line = climbTo(embed, 'cm-line', CLIMB_LIMIT);
  if (line && line !== content) return { embed, line, content, mode: 'cm-line' };

  /* 结构二：embed 直接挂在 .cm-content 下，中间没有 .cm-line —— 把它自己当这一行 */
  const parent = embed.parentElement;
  if (parent && parent === content) return { embed, line: embed, content, mode: 'direct-embed' };

  return null;
}

/* --------------------------- 实时预览：诊断摘要 --------------------------- */

/**
 * 诊断：三件东西找到没、各自是什么。找不到时把 host 的祖先链一起带上——
 * 真机 CM6 的 embed 很可能不在 .cm-line 里，靠这条链子能一眼看出来。
 */
function lpPartsInfo(host, parts) {
  return {
    ok: !!parts,
    /* 走了哪条结构分支：'cm-line'（embed 在 .cm-line 里）还是 'direct-embed'（回退） */
    mode: parts ? (parts.mode || null) : null,
    found: parts ? ['embed', 'line', 'content'] : [],
    embed: parts && parts.embed ? dbgEl(parts.embed) : null,
    line: parts && parts.line ? dbgEl(parts.line) : null,
    content: parts && parts.content ? dbgEl(parts.content) : null,
    lineIsEmbed: !!(parts && parts.line && parts.line === parts.embed),
    /* 最终能用来绕排的正文行数：0 就是「后面一行都没有」，会走放弃分支 */
    candidates: parts && parts.line
      ? collectLineSiblings(parts.line.nextElementSibling, WRAP_LIMIT, parts.embed).length
      : -1,
    host: dbgEl(host),
    chain: dbgChain(host, 7),
  };
}

/** 诊断：一行 .cm-line 的四个高度口径（内联 height / 内联 min-height / computed / rect） */
function lpLineInfo(line) {
  return {
    el: dbgEl(line),
    inlineCss: dbgInlineAll(line),
    inlineHeight: dbgInline(line, 'height'),       // 非空就是 CM6 写死了行高
    inlineMinHeight: dbgInline(line, 'minHeight'),
    computed: dbgCss(line, ['position', 'height', 'minHeight', 'display', 'paddingTop']),
    rect: dbgRect(line),
    childCount: dbgChildCount(line),
    firstChild: dbgFirstChild(line),
  };
}

/** 诊断：内容列 */
function lpContentInfo(content) {
  let scrollH = -1;
  try { scrollH = Number(content.scrollHeight) || 0; } catch (e) { scrollH = -1; }
  return {
    el: dbgEl(content),
    clientWidth: Number(content.clientWidth) || 0,
    scrollHeight: scrollH,
    computed: dbgCss(content, ['position', 'display', 'paddingTop', 'paddingRight']),
    rect: dbgRect(content),
  };
}

/** 采集正文行时一律排除的东西：CM6 的占位、浮层，以及别的 block widget */
const WRAP_SKIP_CLASS = ['cm-gap', 'cm-embed-block', 'cm-widgetBuffer', 'cm-selectionLayer', 'cm-cursorLayer'];

/** 类名数组；读不到（残缺的假 DOM 之类）返回 null，交给调用方决定怎么处理 */
function classNamesOf(el) {
  try {
    if (!el) return null;
    const cls = el.classList;
    if (cls && typeof cls.length === 'number' && typeof cls.item === 'function') {
      const out = [];
      for (let i = 0; i < cls.length; i++) {
        const name = String(cls.item(i) || '').trim();
        if (name) out.push(name);
      }
      return out;
    }
    const raw = el.className;
    if (typeof raw === 'string') return raw.trim() ? raw.trim().split(/\s+/) : [];
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * 这个兄弟能不能当「正文行」用（给它加 padding 才有意义）。
 *
 * 主判据仍是 .cm-line（旧结构、以及新结构里的正文行都是它）。新版若把正文行换成
 * 别的类名，放宽到这里只接「不带 cm- 前缀类名」的块：主题/编辑器可以叫 .HyperMD-xxx、
 * .markdown-xxx，而那些都是正文块；CM6 自己的 cm-* 一律不当正文行（多半是 widget、
 * 占位或浮层）。这样不会把所有 div 都收进来。
 * 另一个 block widget 的 .cm-embed-block 也排除：它不是正文，绕排没有意义。
 */
function isWrapLine(el, exclude) {
  if (!el || el === exclude) return false;
  for (let i = 0; i < WRAP_SKIP_CLASS.length; i++) {
    if (classHas(el, WRAP_SKIP_CLASS[i])) return false;
  }
  if (classHas(el, 'cm-line')) return true;
  const names = classNamesOf(el);
  if (!names) return false;                    // 连类名都读不到：不猜
  if (!names.length) return true;              // 裸 div：正文块
  for (let i = 0; i < names.length; i++) {
    if (names[i].indexOf('cm-') === 0) return false;
  }
  return true;
}

/**
 * 从 widget 那行的下一个兄弟起收集能绕排的正文行。
 * 不是正文行的兄弟（另一个 widget、.cm-gap、浮层）跳过但继续往后走。
 * exclude 是 widget 自己：万一调用方把起点给成了它，不会被当成正文行收进来。
 */
function collectLineSiblings(startEl, limit, exclude) {
  const out = [];
  const max = Number(limit) > 0 ? Number(limit) : WRAP_LIMIT;
  const steps = max * 4 + 8;
  let el = startEl;
  let n = 0;
  while (el && out.length < max && n < steps) {
    n++;
    if (isWrapLine(el, exclude) && out.indexOf(el) < 0) out.push(el);
    el = el.nextElementSibling;
  }
  return out;
}

/** 诊断：往后取几个兄弟的摘要，下一轮日志能看清正文行到底叫什么 */
function siblingSamples(startEl, count) {
  const out = [];
  const max = Number(count) > 0 ? Number(count) : 6;
  const steps = max * 4;
  let el = startEl;
  let n = 0;
  while (el && out.length < max && n < steps) {
    n++;
    out.push(dbgEl(el));
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
 * 同 planLivePreviewLines，但每行的高度按「加了留白之后折行」量。
 *
 * 为什么不能直接用施加前的行高：留白把文字挤窄，长行会多折几行、变高。
 * 按变高前的尺寸累加，会把图下面本来不重叠的行也算进去，结果图底下挂着一条
 * 多余的右边距。做法是逐行试写留白、量真实高度、马上把行内样式还回去：
 * 试写只碰候选行的 paddingRight/Left（这些行本来就要写），同一任务内复原，
 * 最终写入仍由调用方的账本负责。
 *
 * 拿不到 style / 量不出高度时退回只读的 planLivePreviewLines。
 *
 * opts.basePad(el, prop) 给「这一行没有我们参与时」的 padding：账本里记着的基准。
 * 不给就按行内值算（老行为）。脱离账本算基准会把上一轮写的留白当成行自己的，
 * 一轮轮叠上去。
 */
function planWrappedLines(lines, height, opts) {
  const o = opts || {};
  const h = Number(height);
  const span = Number(o.span);
  const side = o.side === 'left' ? 'left' : 'right';
  const prop = side === 'left' ? 'paddingLeft' : 'paddingRight';
  if (!Array.isArray(lines) || !(h > 0) || !(span > 0)) return planLivePreviewLines(lines, height, opts);
  const limit = Number(o.limit) > 0 ? Number(o.limit) : WRAP_LIMIT;
  const basePad = typeof o.basePad === 'function'
    ? o.basePad
    : (node, key) => {
      const v = parseFloat(node && node.style ? node.style[key] : '');
      return Number.isFinite(v) ? v : 0;
    };
  const out = [];
  let acc = 0;
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const el = lines[i];
    if (!el) continue;
    if (out.indexOf(el) >= 0) continue;
    let measured = -1;
    if (el.style && typeof el.style === 'object') {
      const prev = el.style[prop] == null ? '' : String(el.style[prop]);
      let base = 0;
      try {
        const got = Number(basePad(el, prop));
        base = Number.isFinite(got) ? got : 0;
      } catch (e) { base = 0; }
      try {
        el.style[prop] = round2(base + span) + 'px';
        if (typeof el.getBoundingClientRect === 'function') measured = elHeight(el);
      } catch (e) { measured = -1; }
      try {
        if (prev) el.style[prop] = prev;
        else if (typeof el.style.removeProperty === 'function') el.style.removeProperty(cssName(prop));
        else el.style[prop] = '';
      } catch (e) { /* 复原失败也不能外抛 */ }
    }
    out.push(el);
    acc += measured > 0 ? measured : elHeight(el);
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
 * 会把它抹成空。Map 存 el → prop → 条目，复位完清空，重复施加不会叠加。
 *
 * 三种「放手」的姿势分开：
 *   sweep()          一轮结束时，把本轮没再被认领的记账原地还原（只还原该还原的）
 *   pruneDetached()  节点已脱离文档：先把样式还回去，再丢记账
 *   reset()          全部还原（真正的销毁 / 插件卸载）
 * 关键点：一轮重算里不再「先全清再重写」。那样每次重算都有一段所有留白归零的
 * 瞬间，CM6 又正好在这时候测量行高、重建 widget，很容易被画出来（文字压到图上）。
 *
 * set() 还是差异写入：同一个属性值没变就一个字节都不碰。样式写入会触发样式重算，
 * 无谓的写入本身就是 CM6 重新测量的诱因。
 */
function createStyleLedger() {
  const touched = new Map();     // el -> Map(prop -> {prev, written, base, gen})
  const order = [];              // [el, prop]，复位倒着走
  let gen = 0;                   // 轮次：本轮没再被认领的记账，sweep 时还原
  let writes = 0;

  const isPad = (prop) => prop === 'paddingLeft' || prop === 'paddingRight';

  const restore = (el, prop, entry) => {
    if (!el || !el.style) return false;
    const prev = entry ? entry.prev : '';
    try {
      if (prev) {
        el.style[prop] = prev;
      } else if (typeof el.style.removeProperty === 'function') {
        el.style.removeProperty(cssName(prop));
      } else {
        el.style[prop] = '';
      }
    } catch (e) { return false; }
    return true;
  };

  const drop = (el, prop) => {
    const rec = touched.get(el);
    if (!rec) return;
    rec.delete(prop);
    if (!rec.size) touched.delete(el);
  };

  return {
    set(el, prop, value) {
      if (!el || !el.style) return false;
      const v = String(value);
      let rec = touched.get(el);
      if (!rec) { rec = new Map(); touched.set(el, rec); }
      const entry = rec.get(prop);
      if (entry) {
        entry.gen = gen;                    // 本轮还要它，sweep 别动
        if (entry.written === v) return false;
        entry.written = v;
        el.style[prop] = v;
        writes++;
        return true;
      }
      const prev = el.style[prop] == null ? '' : String(el.style[prop]);
      const fresh = { prev, written: v, base: null, gen };
      // padding 的基准必须在动它之前抓：写进去之后 computed 里就是我们的值，
      // 再也读不回主题给的那点留白，下一轮会把我们的值当成基准再叠一次。
      if (isPad(prop)) {
        const pad = paddingOf(el);
        fresh.base = prop === 'paddingLeft' ? num(pad.left) : num(pad.right);
      }
      rec.set(prop, fresh);
      order.push([el, prop]);
      el.style[prop] = v;
      writes++;
      return true;
    },
    /** 本轮仍需要这个属性，但不必再写（computed 已经是目标值了）：只续期 */
    claim(el, prop) {
      if (!el || !el.style) return false;
      const rec = touched.get(el);
      const entry = rec && rec.get(prop);
      if (!entry) return false;
      entry.gen = gen;
      return true;
    },
    /** 开一轮：之后 set / claim 过的都算「本轮仍需要」 */
    begin() { gen++; return gen; },
    /** 一轮结束后，把本轮没认领的记账原地还原。先写后撒，没有空档。 */
    sweep() {
      let n = 0;
      const keep = [];
      for (let i = 0; i < order.length; i++) {
        const el = order[i][0];
        const prop = order[i][1];
        const rec = touched.get(el);
        const entry = rec && rec.get(prop);
        if (entry && entry.gen === gen) { keep.push(order[i]); continue; }
        if (restore(el, prop, entry)) n++;
        drop(el, prop);
      }
      order.length = 0;
      for (const pair of keep) order.push(pair);
      return n;
    },
    /** 节点已脱离文档：先把样式还回去再丢记账。还回去不会触发布局（节点不在树上），
     *  但只要 CM6 把同一批行 / widget 回收复用，就不会带着我们的行内值回来。 */
    pruneDetached() {
      let n = 0;
      const keep = [];
      for (let i = 0; i < order.length; i++) {
        const el = order[i][0];
        const prop = order[i][1];
        if (!el || el.isConnected === false) {
          const rec = el ? touched.get(el) : null;
          restore(el, prop, rec ? rec.get(prop) : null);
          drop(el, prop);
          n++;
          continue;
        }
        keep.push(order[i]);
      }
      order.length = 0;
      for (const pair of keep) order.push(pair);
      return n;
    },
    reset() {
      let n = 0;
      for (let i = order.length - 1; i >= 0; i--) {
        const el = order[i][0];
        const prop = order[i][1];
        const rec = touched.get(el);
        const entry = rec && rec.get(prop);
        if (restore(el, prop, entry)) n++;
      }
      order.length = 0;
      touched.clear();
      return n;
    },
    /** 我们接管这个属性之前，它「本该是」的 padding（px）；没接管过就是 null */
    padBase(el, prop) {
      const rec = touched.get(el);
      const entry = rec && rec.get(prop);
      return entry && typeof entry.base === 'number' ? entry.base : null;
    },
    /** 接管之前的行内值；没接管过就是 undefined */
    orig(el, prop) {
      const rec = touched.get(el);
      const entry = rec && rec.get(prop);
      return entry ? entry.prev : undefined;
    },
    has: (el) => touched.has(el),
    props: (el) => {
      const rec = touched.get(el);
      return rec ? Array.from(rec.keys()) : [];
    },
    size: () => touched.size,
    writes: () => writes,
    gen: () => gen,
  };
}

/**
 * 这一行「没有我们参与时」的 padding：账本接管过的用接管前的基准，否则读 computed。
 * planWrappedLines 的试写和 planLinePads 的叠加都要用它 —— 拿行内值当基准，
 * 上一轮写的留白会被当成行自己的 padding，一轮轮叠宽。
 */
function padBaseOf(el, ledger, prop) {
  const own = ledger && typeof ledger.padBase === 'function' ? ledger.padBase(el, prop) : null;
  if (own != null) return own;
  const got = paddingOf(el);
  return prop === 'paddingLeft' ? num(got.left) : num(got.right);
}

/** 续期一条记账：本轮还需要，但不必再写。账本没这个 api（外部传进来的）就当没事 */
function claimStyle(ledger, el, prop) {
  if (!ledger || typeof ledger.claim !== 'function') return false;
  return ledger.claim(el, prop);
}

/** 账本友好的 padding 读取器，形状跟 paddingOf 一样，给 planLinePads 用 */
function padReaderOf(ledger) {
  return (el) => {
    const got = paddingOf(el);
    const out = { left: num(got.left), right: num(got.right) };
    const l = ledger && typeof ledger.padBase === 'function' ? ledger.padBase(el, 'paddingLeft') : null;
    if (l != null) out.left = l;
    const r = ledger && typeof ledger.padBase === 'function' ? ledger.padBase(el, 'paddingRight') : null;
    if (r != null) out.right = r;
    return out;
  };
}

/** 把 planLinePads 的结果写进 DOM（经账本，可复位），返回写的条数。
 *  值是差异写入：跟上一轮相同的属性不会重复写（账本自己判断）。 */
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

/* --------------------- 实时预览：一行高度 + 绝对定位图 + 逐行留白 --------------------- */

/**
 * direct-embed 结构（.cm-embed-block 直接挂在 .cm-content 下）的浮动方案。
 *
 * 前两版的死结：CM6 实测到 widget 有 190px，单独记一笔账。
 *   a) float：widget 在流里占 0，账上还是 190 → 光标按错账反推（点 18 行落 14 行）
 *   b) height:0：账对上了，但浮动排除区受盒子高度限制，文字不再绕排
 * 两版都卡在「widget 高度」这笔账上 —— 那是插件改不了也骗不过的量。
 *
 * 这一版把账做成真的：
 *   1. .cm-embed-block 高度钉死成一行（27px 量级）。CM6 量到多少就记多少，
 *      DOM 也真的只占这么多，三方一致，widget 高度上没有偏差
 *   2. 图本身是宿主的绝对定位子元素，从这一行浮出去，高度不参与父盒计算
 *   3. 后续 .cm-line 逐行加 padding（右浮动加右、左浮动加左）给图让位。
 *      行被挤窄 → 折行变多 → 行变高：真实 DOM 变化，CM6 会自己重新量
 *
 * 关键差别：偏差从「widget 高度」搬到了「行高」上，而后者的变化 CM6 认。
 * 这条假设要在真机上验光标，headless 只能验排版（widget 高度、溢出、行留白）。
 *
 * 写下的属性全部经账本记账，卸载 / 图被删 / 关开关时原样还回去。
 */

/** 拿不到行高时的兜底（px）：Obsidian 默认主题 16px 正文的行高 */
const LP_LINE_FALLBACK = 27;

/** 元素的 computed line-height（px）；读不到 / 是 normal 时返回 null */
function computedLineHeightOf(el) {
  try {
    const doc = el && el.ownerDocument;
    const view = doc && doc.defaultView;
    const cs = view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(el) : null;
    const v = parseFloat(cs && cs.lineHeight);
    return Number.isFinite(v) && v > 0 ? round2(v) : null;
  } catch (e) {
    return null;
  }
}

/**
 * 「一行有多高」：优先量候选行里最矮的那一行（多行段落会被折行撑高，不能拿它当行高），
 * 其次取 content 的 computed line-height，最后用 27 兜底。
 */
function oneLineHeightOf(content, lines) {
  const list = Array.isArray(lines) ? lines : [];
  let min = Infinity;
  for (let i = 0; i < list.length && i < 12; i++) {
    const h = elHeight(list[i]);
    if (Number.isFinite(h) && h > 0 && h < min) min = h;
  }
  if (Number.isFinite(min)) return round2(min);
  const lh = computedLineHeightOf(content);
  return lh == null ? LP_LINE_FALLBACK : lh;
}

/* ------------------ 图为什么看不见：裁剪链体检 + 逐层放开 ------------------ */

/**
 * 「SVG 在 DOM 里、尺寸正常、就是看不见」只有三种可能：被裁了、跑偏了、被隐藏了。
 * 前两种必须分开查，而 rect 帮不上忙 —— getBoundingClientRect 不反映裁剪，
 * 图被切掉时 rect 依旧是完整的 256×128。
 *
 * 裁剪的来源也不一定是 overflow：内核给块 widget 写了
 *   .markdown-source-view.mod-cm6 .cm-content > [contenteditable=false] {
 *     contain: paint !important;
 *   }
 * contain: paint 把内容裁到 padding box，且**写 overflow: visible 也没用**。
 * 一行高度方案里图全靠溢出显示，这一层就是「图整个消失」最直接的嫌疑。
 *
 * 所以体检要读五样：overflow / overflowX / overflowY / contain / clip-path，
 * 放开时也要连 contain 一起放。
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

/**
 * A + B：从内到外把裁剪逐层放开。
 *   contain 非 none        → contain: none !important（内核的 contain: paint !important 只能这么压）
 *   溢出不是 visible       → overflow: visible !important（连同出问题的长写属性）
 *   clip-path 非 none      → none
 * 只碰 startEl 到 stopEl 这一段；硬边界（.cm-scroller 及以上）一个字节都不写。
 *
 * 写下去的值全部走 put：施加路径里 put 就是带 !important 的记账写入，
 * 卸载时能一次原样还回去。
 *
 * @returns {{chain:Array, before:Array<string>, wrote:Array, stop:string|null}}
 */
function openClipChain(startEl, stopEl, opts) {
  const o = opts || {};
  const put = typeof o.put === 'function'
    ? o.put
    : (el, prop, value) => setImportantStyle(el, prop, value);
  const chain = clipChainOf(startEl, stopEl, o);
  const wrote = [];
  const write = (node, prop, value) => {
    let s = null;
    try { s = put(node, prop, value); } catch (e) { s = null; }
    if (s) wrote.push({ el: dbgEl(node), prop: cssName(prop), value });
    return !!s;
  };

  for (let i = 0; i < chain.length; i++) {
    const info = chain[i].info;
    const node = chain[i].node;
    if (!info.clips || info.hard || !node || !node.style) continue;
    if (containClips(info.contain)) write(node, 'contain', 'none');
    if (overflowClips(info.overflow) || overflowClips(info.overflowX) || overflowClips(info.overflowY)) {
      write(node, 'overflow', 'visible');
      if (overflowClips(info.overflowX)) write(node, 'overflowX', 'visible');
      if (overflowClips(info.overflowY)) write(node, 'overflowY', 'visible');
    }
    if (info.clipPath && info.clipPath !== 'none') write(node, 'clipPath', 'none');
    if (info.contentVisibility === 'hidden') write(node, 'contentVisibility', 'visible');
    if (info.opacity !== '' && Number(info.opacity) === 0) write(node, 'opacity', '1');
    if (/hidden|collapse/.test(info.visibility)) write(node, 'visibility', 'visible');
  }

  const before = chain
    .filter((x) => x.info.clips && !x.info.hard)
    .map((x) => x.info.el + ':' + x.info.why.join('+'));
  return { chain: chain.map((x) => x.info), before, wrote, stop: stopEl ? dbgEl(stopEl) : null };
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
 * 逐行留白：从 widget 后面第一行开始，一行一行试写 padding、量真实高度、累积，
 * 累积高度盖住图高就停。
 *
 * 为什么必须量真实的：行被挤窄之后折行变多、行变高，按「加 padding 之前」的高度
 * 累加会多算几行（图下面白出一截）。所以这里没有纯算术，写一行量一行。
 *
 * @param {Element[]} lines      候选正文行（已有的 collectLineSiblings 结果）
 * @param {number}    imgHeight  图要盖住的纵向高度
 * @param {object}    opts       span / side / limit / write(el,prop,val) /
 *                               measure(el)->px / basePad(el,prop)->px
 * @returns {{pads:Array, covered:number, shortfall:number, stopped:boolean, tried:number}}
 */
function planPinnedPads(lines, imgHeight, opts) {
  const o = opts || {};
  const out = { pads: [], covered: 0, shortfall: 0, stopped: false, tried: 0 };
  const height = Number(imgHeight);
  const span = Number(o.span);
  if (!Array.isArray(lines) || !(height > 0) || !(span > 0)) return out;

  const side = o.side === 'left' ? 'left' : 'right';
  const prop = side === 'left' ? 'paddingLeft' : 'paddingRight';
  const limit = Number(o.limit) > 0 ? Number(o.limit) : WRAP_LIMIT;
  const write = typeof o.write === 'function'
    ? o.write
    : (el, p, v) => { setInlineStyle(el, p, v); };
  const measure = typeof o.measure === 'function' ? o.measure : elHeight;
  const basePad = typeof o.basePad === 'function' ? o.basePad : null;

  let covered = 0;
  for (let i = 0; i < lines.length && out.pads.length < limit; i++) {
    const el = lines[i];
    if (!el) continue;
    out.tried++;
    const base = basePad ? Number(basePad(el, prop)) || 0 : (prop === 'paddingLeft'
      ? num(paddingOf(el).left) : num(paddingOf(el).right));
    const value = round2(base + span) + 'px';
    write(el, prop, value);
    const h = Number(measure(el));
    const lineH = Number.isFinite(h) && h > 0 ? round2(h) : 0;
    covered = round2(covered + lineH);
    out.pads.push({ el, prop, value, base, height: lineH, covered });
    if (covered >= height) { out.stopped = true; break; }
  }
  out.covered = covered;
  out.shortfall = round2(Math.max(0, height - covered));
  return out;
}

/**
 * 写一条行内样式，带 !important。
 *
 * 为什么必须带：app.css 里有
 *   `.markdown-source-view.mod-cm6 .cm-content > * { margin: 0 !important; display: block; }`
 * 浮动图的宿主就是 `.cm-content` 的直接子项，行内普通声明打不过作者 !important，
 * 间距会被抹成 0（图贴着文字）。行内 !important 在作者 !important 之上，是唯一
 * 不改主题也能让间距生效的写法。其余属性照旧用普通行内值。
 */
function setImportantStyle(el, prop, value) {
  if (!el || !el.style) return null;
  const prev = el.style[prop] == null ? '' : String(el.style[prop]);
  try {
    if (typeof el.style.setProperty === 'function') el.style.setProperty(cssName(prop), value, 'important');
    else el.style[prop] = value;
  } catch (e) {
    return null;
  }
  return { el, prop, cssProp: cssName(prop), prev };
}

/**
 * 给一张浮动图施加「一行高度 + 绝对定位图 + 逐行留白」。只认 direct-embed 结构；
 * 老结构（embed 在 .cm-line 里）返回 null，交给绝对定位那条。
 *
 * 写的属性（都记原值、可还原）：
 *   embed  height / min-height / max-height 一行 / overflow:visible / float:none /
 *          width:auto / position:relative / margin:0(!important)
 *   host   position:absolute + top:0 + 贴边 / width / max-width:none / float:none /
 *          clear:none / margin:0 / display:flow-root
 *   .cm-line  逐行 padding（经账本，可复位）
 *
 * host 必须一起收拾：applyFloatLayout 已经把它设成 float:right + margin + width +
 * max-width:100%，留着的话图会被自己的 margin 往里推，max-width 还会二次收窄。
 * flow-root 让内部 .brace-map-block 的上下 margin 不外溢，图顶才能稳稳贴住 top:0。
 *
 * @returns {{mode,side,width,imgH,overflow,lineH,span,host,embed,content,pads,covered,shortfall,styles}|null}
 */
function applyLivePreviewCssFloat(host, cfg, opts) {
  const o = opts || {};
  if (!lpFloatEnabled) { dbgNull('apply.css.null', 'css.disabled'); return null; }   // 开关关掉：一条样式都不写
  const mode = cfg && cfg.float;
  const side = mode === 'left' ? 'left' : (mode === 'right' ? 'right' : '');
  if (!side) return null;                                   // center / inline 维持现状
  const parts = livePreviewParts(host);
  if (!parts || parts.mode !== 'direct-embed') return null;  // 老结构走绝对定位那条
  const embed = parts.embed;
  const content = parts.content;
  if (!embed || !embed.style || !content) return null;

  const gap = Number(o.gap) > 0 ? Number(o.gap) : FLOAT_GAP;
  const ledger = (o.ledger && typeof o.ledger.set === 'function') ? o.ledger : null;

  /* 图宽：配置优先，没写就用 SVG 实际渲染宽；超了正文列宽就收到列宽 */
  const svgRect = o.svg ? rectOf(o.svg) : null;
  const hostRect = rectOf(host);
  const eRect = rectOf(embed);
  const natural = svgRect && svgRect.width > 0 ? svgRect.width
    : (hostRect && hostRect.width > 0 ? hostRect.width : 0);
  const want = Number(cfg.width) > 0 ? Number(cfg.width) : natural;
  const cRect = rectOf(content);
  const boxW = Number(content.clientWidth) > 0
    ? Number(content.clientWidth)
    : (cRect && cRect.width > 0 ? cRect.width : 0);
  let width = want > 0 ? want : boxW;
  if (!(width > 0)) return null;                             // 连宽度都量不到：不动手
  if (boxW > 0 && width > boxW) width = boxW;
  width = round2(Math.max(1, width));

  /* 图高：钉住 widget 之前先量，这是图绝对定位后要往下占的纵向空间 */
  const imgH = round2(Math.max(
    svgRect && svgRect.height > 0 ? svgRect.height : 0,
    hostRect && hostRect.height > 0 ? hostRect.height : 0,
  ));
  if (!(imgH > 0)) return null;          // 量不到图高：不动手，否则图会盖住正文

  const candidates = collectLineSiblings(embed.nextElementSibling, o.maxLines, embed);
  const lineH = oneLineHeightOf(content, candidates);   // 必须在加 padding 之前量
  const span = round2(width + gap);

  /*
   * 需要下行留白盖住的高度 = 图底到 widget 底的距离（widget 只有一行高）。
   * 取 SVG 的底，不取宿主的底：宿主自己的上下 margin（.brace-map-block 的 0.9em）
   * 和内层 padding 都是空白，把它们算进来会在图下面多压一行正文。
   * 量不到几何才退回「图高 - 行高」的估值。
   */
  let overflow = 0;
  const bottomOf = svgRect && Number.isFinite(svgRect.bottom) ? svgRect.bottom
    : (hostRect && Number.isFinite(hostRect.bottom) ? hostRect.bottom : NaN);
  if (Number.isFinite(bottomOf) && eRect && Number.isFinite(eRect.top)) {
    overflow = round2(bottomOf - eRect.top - lineH);
  }
  if (!(overflow > 0)) overflow = round2(Math.max(0, imgH - lineH));

  const before = cssFloatHeights(embed, content);     // 读 rect 会强制布局，先取一轮基线
  const styles = [];
  const put = (el, prop, value, important) => {
    if (!el || !el.style) return null;
    const s = important ? setImportantStyle(el, prop, value) : setInlineStyle(el, prop, value);
    if (s) styles.push(s);
    return s || null;                       // 裁剪链要知道「这一条到底写进去没有」
  };

  /* widget 只占一行：CSS 高度 / DOM 高度 / CM6 记账三方对齐，不留偏差 */
  put(embed, 'height', lineH + 'px');
  put(embed, 'minHeight', '0');
  put(embed, 'maxHeight', lineH + 'px');
  put(embed, 'overflow', 'visible', true);      // 主题 / 内核可能写了 !important，普通行内压不住
  put(embed, 'float', 'none');
  put(embed, 'width', 'auto');
  put(embed, 'position', 'relative', true);     // 内部绝对定位的包含块（B：也不许被覆盖成 static）
  put(embed, 'margin', '0', true);             // app.css 给 .cm-content > * 写了 margin:0 !important

  /* 图从这一行浮出去：绝对定位贴正文列边界，父盒高度已被钉死，溢出到下方行上 */
  put(host, 'position', 'absolute');
  put(host, 'top', '0');
  put(host, side === 'left' ? 'left' : 'right', '0');
  put(host, side === 'left' ? 'right' : 'left', 'auto');
  put(host, 'width', width + 'px');
  put(host, 'maxWidth', 'none');
  put(host, 'float', 'none');
  put(host, 'clear', 'none');
  put(host, 'margin', '0');
  put(host, 'display', 'flow-root');

  /*
   * A + B：图全靠溢出显示，从宿主往上到 .cm-content，凡是在裁的层当场放开。
   * 内核给块 widget 写了 `contain: paint !important`（app.css：
   * .markdown-source-view.mod-cm6 .cm-content > [contenteditable=false]），
   * 那一层会把溢出到下一行的图整张切掉 —— 症状正是「SVG 在 DOM 里、
   * 尺寸正常、就是看不见」。contain: paint 下写 overflow: visible 不起作用，
   * 必须连 contain 一起写成行内 !important 才压得住。
   * .cm-scroller 及以上一律不碰（改滚动容器的 overflow 会废掉滚动条）。
   */
  const clip = openClipChain(host, content, {
    getStyle: o.getStyle,
    put: (el, prop, value) => put(el, prop, value, true),
  });

  /* 后续行留白：写一行量一行，盖住溢出部分就停 */
  const plan = planPinnedPads(candidates, overflow, {
    span,
    side,
    limit: o.maxLines,
    write: ledger
      ? (el, prop, v) => { ledger.set(el, prop, v); }
      : null,
    basePad: ledger ? (el, prop) => padBaseOf(el, ledger, prop) : null,
    measure: o.measure,
  });

  /* 写完再读一次：读 rect 本身会强制一次同步布局，所以这里拿到的是「施加之后」的真值 */
  const after = cssFloatHeights(embed, content);

  /* 施加之后的可见性判决：裁剪链对不对、图在不在视口里、有没有被隐藏 */
  const vis = visibilityReport(host, o.svg || null, content, {
    getStyle: o.getStyle,
    view: o.view || o.win,
  });

  return {
    mode: parts.mode, side, width, imgH, overflow, lineH, span, gap,
    host, embed, content, svg: o.svg || null,
    pads: plan.pads, covered: plan.covered, shortfall: plan.shortfall, stopped: plan.stopped,
    styles, clip, vis, diag: { before, after },
  };
}

/**
 * 诊断：一个盒子的四种高度口径 + 行内样式全文。
 * 光标错位追的是「CM6 账上的高度」与「DOM 真实高度」的差，所以四个都要：
 *   rect      布局盒（钉成一行之后应该就在 27px 量级）
 *   offsetH   元素自身布局高
 *   clientH   扣除边框滚动条
 *   cssText   我们写进去的 height / overflow / position 原文
 */
function cssFloatHeights(embed, content) {
  const e = rectOf(embed);
  const c = rectOf(content);
  return {
    embedRectH: e ? round2(e.height) : null,
    embedOffsetH: embed ? num(embed.offsetHeight) : null,
    embedClientH: embed ? num(embed.clientHeight) : null,
    embedCss: dbgInlineAll(embed),
    contentRectH: c ? round2(c.height) : null,
    contentScrollH: content ? num(content.scrollHeight) : null,
  };
}

/**
 * 诊断：CM6 账上的文档高度 vs DOM 实际高度。
 *
 * 这是这一版方案最关键的一条数据：
 *   api   CM6 自己算的 contentHeight（拿不到就是 null）
 *   dom   .cm-content 的 rect 高
 *   delta 两者之差。方案要是成立，这个差应该稳定且不随 widget 数增长；
 *         以前 widget 高 190px、账上不改，差就恒等于「widget 高度」。
 */
function cmHeightInfo(content, opts) {
  const o = opts || {};
  const domH = content ? round2(elHeight(content)) : null;
  let view = null;
  try {
    if (o.cm && o.cm.dom) view = o.cm;
    else if (typeof o.getCM === 'function' && content) view = o.getCM(content);
  } catch (e) { view = null; }
  let api = null;
  try {
    const v = view ? Number(view.contentHeight) : NaN;
    if (Number.isFinite(v)) api = round2(v);
  } catch (e) { api = null; }
  return {
    cmFound: !!view,
    api,
    dom: domH,
    delta: (api != null && domH != null) ? round2(api - domH) : null,
  };
}

/**
 * 诊断：把一次可见性取证压成一行文本。
 * 日志的 JSON 只保留浅层字段（debug.js 的 clip 有深度上限），
 * 所以链子和矩形都先在这里拼成字符串。
 */
function visLine(rep) {
  if (!rep) return '';
  const box = (b) => (b ? b.top + ',' + b.left + ' ' + b.w + 'x' + b.h : '-');
  const chain = rep.chain.map((n) => n.el + '[' + (n.overflow || '?') + '/' + (n.contain || '?')
    + (n.clips && !n.hard ? ' CLIP:' + n.why.join('+') : '') + ']').join(' > ');
  return rep.verdict + (rep.reason ? ' ' + rep.reason : '')
    + ' host=' + box(rep.host.rect) + (rep.host.inViewport === false ? '(视口外)' : '')
    + ' svg=' + box(rep.svg.rect) + (rep.svg.inViewport === false ? '(视口外)' : '')
    + ' chain=' + chain;
}

/**
 * 诊断：新路径的点位记录。
 *   widget   钉成一行之后的高度（rect / offset / client）——目标 ~27，不是 190
 *   svg      图层自己的 rect——要溢出去、位置正确、宽度对
 *   pads     每个被加 padding 的行的 rect 高度（确认折行后真的变高了）
 *   content  总高 + CM6 账上的高度（cmHeights）
 */
function cssFloatInfo(rec, applies, opts) {
  const e = rectOf(rec.embed);
  const c = rec.content ? rectOf(rec.content) : null;
  const eBottom = e ? round2(e.top + e.height) : null;
  const cBottom = c ? round2(c.top + c.height) : null;
  let scrollH = null;
  try { scrollH = Number(rec.content.scrollHeight) || 0; } catch (err) { scrollH = null; }
  const pads = Array.isArray(rec.pads) ? rec.pads.map((p) => ({
    pad: p.value,
    h: p.height,
    covered: p.covered,
  })) : [];
  return {
    mode: rec.mode,
    side: rec.side,
    width: rec.width,
    lineH: rec.lineH,
    imgH: rec.imgH,
    overflow: rec.overflow,
    span: rec.span,
    applies,
    /* 实际写下去的关键样式（用标签而不是值，避免和元素上的记账对不上） */
    styles: {
      embed: ['height:' + rec.lineH + 'px', 'max-height:' + rec.lineH + 'px',
        'min-height:0', 'overflow:visible', 'float:none', 'width:auto', 'position:relative',
        'margin:0!important'],
      host: ['position:absolute', 'top:0', (rec.side === 'left' ? 'left:0' : 'right:0'),
        'width:' + rec.width + 'px', 'max-width:none', 'float:none', 'clear:none',
        'margin:0', 'display:flow-root'],
      count: rec.styles.length,
    },
    /* 最关键的一条：widget 真的被压到一行了吗 */
    widget: {
      rect: dbgRect(rec.embed),
      rectH: e ? round2(e.height) : null,
      offsetH: rec.embed ? num(rec.embed.offsetHeight) : null,
      clientH: rec.embed ? num(rec.embed.clientHeight) : null,
      matchesLine: (e && rec.lineH) ? round2(e.height) === round2(rec.lineH) : null,
      cssText: dbgInlineAll(rec.embed),
    },
    svg: rec.svg ? dbgRect(rec.svg) : null,
    host: dbgEl(rec.host),
    hostRect: rec.host ? dbgRect(rec.host) : null,
    /* 施加前后的对照：差多少，就是 CM6 需要重新记账的量 */
    before: rec.diag ? rec.diag.before : null,
    after: rec.diag ? rec.diag.after : null,
    /* 图为什么看不见：裁剪链（哪几层在裁，放开了几层）+ 可见性判决 */
    clip: rec.clip ? {
      stop: rec.clip.stop,
      before: rec.clip.before.join(' | '),
      wrote: rec.clip.wrote.map((w) => w.el + ':' + w.prop + '=' + w.value).join(' | '),
      wroteCount: rec.clip.wrote.length,
    } : null,
    vis: rec.vis ? visLine(rec.vis) : null,
    embedBottom: eBottom,
    content: dbgEl(rec.content),
    contentRect: dbgRect(rec.content),
    contentH: c ? round2(c.height) : null,
    contentBottom: cBottom,
    contentScrollH: scrollH,
    pads,
    padCount: pads.length,
    covered: rec.covered,
    shortfall: rec.shortfall,
    stopped: rec.stopped,
    /* CM6 账上 vs DOM 实际 */
    cmHeights: cmHeightInfo(rec.content, opts),
    /* ≥0 表示容器框住了 widget；<0 是 widget 漏出容器底边 */
    bottomSlack: (cBottom != null && eBottom != null) ? round2(cBottom - eBottom) : null,
  };
}

/**
 * direct-embed 的浮动控制器，形状与其他路径一致（host / update / dispose / state）。
 *
 * 没有观察者、没有定时器、没有巡检、没有账本、没有延迟复位 —— CSS 是声明式的，
 * 这里只剩一件真事：谁在什么时候把样式还回去。update 先还原再写，重复调用不会
 * 把上一轮的值当成「原值」。
 */
const lpCssLive = new Set();          // 活着的控制器（卸载时要一起还原）

/* --------------------------- 重测调度器（按 .cm-content 共用） --------------------------- */

/**
 * 一个编辑器一套调度器：同一篇笔记里多张浮动图共用一份节流、一个 observer、一个 scroll 监听。
 * 每张图只加一次引用计数，最后一张走了才拆。
 */
const lpMeasureSlots = new WeakMap();   // .cm-content → { sched, users }
const lpMeasureLive = new Set();        // 活着的 slot（WeakMap 不能遍历，开关关掉时要能一次拆完）

/** 取（或建）这个编辑器的重测调度器，引用计数 +1 */
function acquireMeasure(content, opts) {
  const o = opts || {};
  if (!content) return null;
  let slot = lpMeasureSlots.get(content);
  if (slot) {
    const st = typeof slot.sched.state === 'function' ? slot.sched.state() : null;
    if (!st || st.attached === false) {        // 已经拆过的旧调度器不能复用
      try { lpMeasureLive.delete(slot); } catch (e) { /* ignore */ }
      lpMeasureSlots.delete(content);
      slot = null;
    }
  }
  if (!slot) {
    const t = o.timers || null;              // 自测注入的假时钟（raf / setTimeout / now）
    const sched = createMeasureScheduler(content, {
      cm: o.cm,
      getCM: o.getCM,
      win: o.win,
      MutationObserver: o.MutationObserver,
      scroller: o.scroller,
      raf: (t && t.raf) || o.raf,
      caf: (t && t.caf) || o.caf,
      setTimeout: (t && t.setTimeout) || o.setTimeout,
      clearTimeout: (t && t.clearTimeout) || o.clearTimeout,
      now: (t && t.now) || o.now,
      gap: o.measureGap,
      scrollIdle: o.scrollIdle,
    });
    slot = { sched, users: 0 };
    lpMeasureSlots.set(content, slot);
    lpMeasureLive.add(slot);
  }
  slot.users++;
  return slot.sched;
}

/** 引用计数 -1，最后一张图走了就拆掉监听与观察者 */
function releaseMeasure(content) {
  const slot = content ? lpMeasureSlots.get(content) : null;
  if (!slot) return false;
  slot.users--;
  if (slot.users > 0) return true;
  try { slot.sched.dispose(); } catch (e) { /* ignore */ }
  lpMeasureLive.delete(slot);
  lpMeasureSlots.delete(content);
  return true;
}

/** 当前活着的调度器数（诊断 / 自测用） */
function measureSchedulerCount() {
  return lpMeasureLive.size;
}

/**
 * direct-embed 的浮动控制器，形状与其他路径一致（host / update / dispose / state）。
 *
 * 没有定时器、没有巡检、没有延迟复位 —— 样式是当场写完的，
 * 这里只剩三件真事：谁在什么时候把样式还回去；行被 CM6 重建后重算一次；
 * 以及什么时候让 CM6 重新量一次。
 * update 先还原再写，重复调用不会把上一轮的值当成「原值」。
 *
 * 留白行的 padding 走控制器自己的账本：逐行试写 → 量高度 → 不够就再写一行。
 * 写下去的值必须能一次全部还回去，否则下一次 update 会在旧值上再叠一层。
 *
 * 为什么要重测：widget 高度从「图的整高」变成了一行，行高也因为留白变了，
 * 这两件都是真实 DOM 变化，CM6 会在下一次 measure cycle 里量到 —— 只是得有人叫它一声。
 */
function createCssFloatControl(host, cfg, opts) {
  const o = opts || {};
  const ledger = createStyleLedger();
  let record = null;
  let disposed = false;
  let applies = 0;
  let api = null;
  let measure = null;               // 当前挂着的重测调度器（按 content 共享）
  let measureFor = null;            // 它属于哪个 .cm-content（释放时要用）

  const dropMeasure = () => {
    if (!measure) return false;
    const c = measureFor;
    measure = null;
    measureFor = null;
    releaseMeasure(c);
    return true;
  };

  const clear = () => {
    let n = ledger.reset();              // 行留白先回位（按写入逆序）
    if (!record) return n;
    n += restoreStyles(record.styles);
    record = null;
    return n;
  };

  /* 账本交给施加函数：留白是「写一行量一行」的，只能经账本写才能一次复位 */
  const applyOpts = Object.assign({}, o, { ledger });

  /*
   * CM6 会把滚出视口的行整批销毁重建，而我们的 padding 写在行元素上：
   * 行一换就丢，文字会直接压到图上。所以盯住 .cm-content 的 childList，
   * 攒一下（LP_DEBOUNCE）再整体重算一次。
   * 只观察 childList、不观察 style：自己的写入不会反过来触发自己。
   */
  let observer = null;
  let queued = false;
  let handle = null;
  const delay = Number(o.refreshDelay) >= 0 ? Number(o.refreshDelay) : LP_DEBOUNCE;
  const setT = (o.timers && typeof o.timers.setTimeout === 'function') ? o.timers.setTimeout : setTimeout;
  const clearT = (o.timers && typeof o.timers.clearTimeout === 'function') ? o.timers.clearTimeout : clearTimeout;

  const dropQueued = () => {
    if (queued && handle != null) { try { clearT(handle); } catch (e) { /* ignore */ } }
    queued = false;
    handle = null;
  };

  const scheduleRefresh = () => {
    if (disposed || queued) return false;
    queued = true;
    try {
      handle = setT(() => {
        queued = false;
        handle = null;
        if (!disposed) apply();
      }, delay);
    } catch (e) {
      queued = false;
      handle = null;
      return false;
    }
    return true;
  };

  const observeContent = (node) => {
    if (disposed || observer) return false;
    const MO = o.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    if (typeof MO !== 'function' || !node || typeof node.nodeType !== 'number') return false;
    try {
      observer = new MO(scheduleRefresh);
      observer.observe(node, { childList: true });
      return true;
    } catch (e) {
      observer = null;
      return false;
    }
  };

  const apply = () => {
    if (disposed) return null;
    clear();                            // 先还原再写：update 不会把我们的值记成原值
    let next = null;
    try { next = applyLivePreviewCssFloat(host, cfg, applyOpts); } catch (e) { next = null; }
    record = next;
    applies++;
    if (next) {
      dbg('lpf.css', () => cssFloatInfo(next, applies, o));
      observeContent(next.content);
      /*
       * 样式写完 → 下一帧让 CM6 重测一次。同步调没用：浏览器还没布局。
       * 调度器按 .cm-content 共享，所以连着 update 不会重建它 —— 重建就意味着
       * 节流窗口清空，一连串 update 会连着一串 requestMeasure，正好是卡顿源。
       */
      try {
        if (measure && measureFor !== next.content) dropMeasure();
        if (!measure) {
          measureFor = next.content;
          measure = acquireMeasure(measureFor, o);
        }
        if (measure) measure.schedule('apply');
      } catch (e) {                      // 拿不到 cm / 没有 rAF：静默跳过
        dropMeasure();
      }
    } else {
      dropMeasure();
      dbgNull('lpf.css.null', 'css.no-record');
    }
    return next;
  };

  api = {
    host,
    kind: 'css-float',
    update() { if (!disposed) apply(); return !!record; },
    /** 立即重测一次（不经过 rAF 队列，节流仍然生效） */
    measureNow(reason) {
      if (disposed || !measure) return false;
      return measure.run(reason || 'manual');
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      dropQueued();
      if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } }
      observer = null;
      const restored = clear();
      dropMeasure();
      lpCssLive.delete(api);
      dbg('lpf.css.dispose', () => ({ host: dbgEl(host), restored, applies }));
      return true;
    },
    state() {
      return {
        kind: 'css-float',
        attached: !disposed,
        mode: record ? record.mode : null,
        side: record ? record.side : null,
        width: record ? record.width : 0,
        lineH: record ? record.lineH : 0,
        imgH: record ? record.imgH : 0,
        overflow: record ? record.overflow : 0,
        pads: record ? record.pads.length : 0,
        covered: record ? record.covered : 0,
        shortfall: record ? record.shortfall : 0,
        styles: record ? record.styles.length : 0,
        /* 施加之后的可见性判决：ok / clipped / offscreen / hidden / norect */
        vis: record && record.vis ? record.vis.verdict : null,
        clipFixed: record && record.clip ? record.clip.wrote.length : 0,
        observer: !!observer,
        applies,
        measure: measure ? measure.state() : null,
      };
    },
  };

  apply();
  lpCssLive.add(api);
  return api;
}

/* --------------------------- 实时预览：施加 --------------------------- */

/**
 * 对一张浮动图施加 Live Preview 版的「浮动」：定位三件套 + 算出该留白的行。
 * 只碰 opts.ledger 记账的样式，调用方负责在重算前 ledger.reset()。
 *
 * @returns {{host,embed,line,content,side,mode,width,height,span,top,lines,ledger}|null}
 *   mode：'cm-line' | 'direct-embed'，走了哪条结构分支（两边都会施加同样的定位三件套）
 */
function applyLivePreviewFloat(host, cfg, opts) {
  const o = opts || {};
  const mode = cfg && cfg.float;
  const side = mode === 'left' ? 'left' : (mode === 'right' ? 'right' : '');
  dbg('apply.enter', () => ({ mode: mode || null, host: dbgEl(host), hasSvg: !!o.svg }));
  if (!side) { dbgNull('apply.null', 'apply.side'); return null; }         // center / inline 保持原表现
  if (!lpFloatEnabled) { dbgNull('apply.null', 'apply.disabled'); return null; }   // 开关关掉
  const ledger = (o.ledger && typeof o.ledger.set === 'function' && typeof o.ledger.reset === 'function')
    ? o.ledger
    : createStyleLedger();
  const parts = livePreviewParts(host);
  dbg('apply.parts', () => lpPartsInfo(host, parts));
  if (!parts) { dbgNull('apply.null', 'apply.parts'); return null; }
  /* direct-embed 结构不走这里：它归「一行高度 + 逐行留白」（applyLivePreviewCssFloat）。
   * 「绝对定位 + 逐行留白」只服务 embed 在 .cm-line 里的老结构。 */
  if (parts.mode !== 'cm-line') { dbgNull('apply.null', 'apply.direct-embed'); return null; }
  const embed = parts.embed;
  const line = parts.line;
  const content = parts.content;
  if (!embed.style || !line.style || !content.style) { dbgNull('apply.null', 'apply.noStyle'); return null; }

  const cRect = rectOf(content);
  const eRect = rectOf(embed);
  if (!cRect || !eRect) { dbgNull('apply.null', 'apply.rect'); return null; }

  dbg('apply.dom', () => ({
    line: lpLineInfo(line),
    content: lpContentInfo(content),
    embed: { el: dbgEl(embed), rect: dbgRect(embed), computed: dbgCss(embed, ['position', 'display', 'marginTop']) },
    embedParentIsContent: !!embed.parentElement && embed.parentElement === content,
    embedParent: dbgEl(embed && embed.parentElement),
  }));

  const gap = Number(o.gap) > 0 ? Number(o.gap) : FLOAT_GAP;

  /* 1) 后面根本没有行可绕：干脆不动手。把 embed 改成 absolute 会让它那行塌成 0 高，
   *    而后面又没有内容撑着，.cm-content 的滚动高度会跟着缩，图可能被裁掉。
   *    阅读视图遇到同样情况（没有后续兄弟）也是直接放弃。 */
  const candidates = collectLineSiblings(line.nextElementSibling, o.maxLines, embed);
  dbg('apply.candidates', () => ({
    mode: parts.mode,
    count: candidates.length,
    next: dbgEl(line.nextElementSibling),
    lineIsEmbed: line === embed,
    lineIsDirectChildOfContent: !!line.parentElement && line.parentElement === content,
    lineNext: candidates.length ? dbgEl(candidates[0]) : null,
    siblings: siblingSamples(line.nextElementSibling, 6),
  }));
  /* 后面一行正文都没有：不动手（否则 embed 脱离流后那行塌成 0 高，图会被裁、scroll 高度塌缩）。
   * 日志单独一条，一眼能看出放弃是因为「没有行」，不是结构没认出来。 */
  if (!candidates.length) {
    dbg('apply.giveup', () => ({
      at: 'no-candidates',
      mode: parts.mode,
      line: dbgEl(line),
      next: dbgEl(line.nextElementSibling),
      siblings: siblingSamples(line.nextElementSibling, 6),
    }));
    dbgNull('apply.null', 'apply.noCandidates');
    return null;
  }

  /* 2) 定位上下文：.cm-line 原本是 relative，会把绝对定位的包含块抢到自己身上，
   *    那样 widget 只能相对这一行定位，后面的行永远绕不上来。
   *    direct-embed 分支里 line 就是 embed，它自己随后被绝对定位接管，不必先写 static。
   *    位置属性也走差异写入：computed 已经是目标值的就不再写，但要 claim 一下，
   *    让账本知道「本轮还需要它」，否则收尾的 sweep 会把它还原掉。 */
  if (line !== embed) {
    if (computedPosition(line) !== 'static') ledger.set(line, 'position', 'static');
    else claimStyle(ledger, line, 'position');
  }
  const contentPos = computedPosition(content);
  if (!contentPos || contentPos === 'static') ledger.set(content, 'position', 'relative');
  else claimStyle(ledger, content, 'position');

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
  dbg('apply.embed.before', () => ({
    el: dbgEl(embed),
    rect: dbgRect(embed),
    top: round2(top),
    width: round2(width),
    computed: dbgCss(embed, ['position', 'float', 'marginLeft', 'marginRight']),
  }));
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

  /* 6) 从 widget 那行的下一个正文行起逐行留白，累积够图高就停。
   *    高度按「加了留白、真的折行之后」量：留白会把长行挤窄，不改量法会把
   *    图下方本来不重叠的行也算进去。 */
  const lines = planWrappedLines(candidates, height, {
    limit: o.maxLines,
    span: width + gap,
    side,
    basePad: typeof o.basePad === 'function'
      ? o.basePad
      : (el, prop) => padBaseOf(el, ledger, prop),
  });

  dbg('apply.after', () => ({
    height: round2(height),
    width: round2(width),
    span: round2(width + gap),
    embedInline: dbgInlineAll(embed),
    lineInline: dbgInlineAll(line),
    contentInline: dbgInlineAll(content),
    embedRect: dbgRect(embed),
    lineRectHeight: (dbgRect(line) || {}).h,
    linePosition: dbgCss(line, ['position']).position,
    contentPosition: dbgCss(content, ['position']).position,
  }));

  dbg('apply.planLines', () => ({
    mode: parts.mode,
    candidates: candidates.length,
    lines: lines.length,
    wrapped: true,
    height: round2(height),
    span: round2(width + gap),
    maxLines: Number(o.maxLines) > 0 ? Number(o.maxLines) : null,
    lineHeights: lines.slice(0, 6).map((el) => elHeight(el)),
  }));

  return {
    host, embed, line, content, side,
    mode: parts.mode,
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
 *
 * 生命周期挂 .cm-content，不挂单个 widget：CM6 滚动 / 重排时会把 block widget
 * 整个换掉（旧 widget dispose、新 widget create）。manager 要是跟着 widget 走，
 * 每换一次就得「销毁 → 复位全部样式 → 重建 → 重测 → 再写回去」，中间那段留白是 0，
 * 文字退回整宽就压在图上。现在最后一个 widget 走了只进入「待复位」，样式原地不动，
 * 等新 widget 挂上来接管；真没人来才在 LP_RESET_DELAY 之后复位。
 */
const lpManagers = new WeakMap();     // .cm-content → manager
const lpLive = new Set();             // 活着的 manager（WeakMap 不能遍历，卸载时要能一起收）

/** 最后一个 widget 走掉后，等多久才真的复位（ms）。CM6 重建 widget 通常在几十毫秒内完成。 */
const LP_RESET_DELAY = 500;

function createLivePreviewManager(content, seed) {
  const o = Object.assign({}, seed || {});
  const ledger = createStyleLedger();
  const widgets = new Set();
  let cm = null;
  let observer = null;
  let observedNode = null;
  let timer = 0;
  let poll = 0;
  let resetTimer = 0;
  let disposed = false;
  let applies = 0;
  let api = null;
  let stats = { widgets: 0, lines: 0, styles: 0, applies: 0, swept: 0, resetState: 'live' };

  dbg('manager.create', () => ({ content: dbgEl(content), chain: dbgChain(content, 4) }));

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

  /** 一轮完整施加：按当前 DOM 先算后写，不再「先整体复位」 */
  const pass = () => {
    if (disposed) return stats;
    if (content.isConnected === false) { flush('detached'); return stats; }
    // 掉出文档的图（笔记关了、切到阅读视图重建了代码块）直接摘掉
    for (const w of Array.from(widgets)) {
      if (!w || !w.host || w.host.isConnected === false) widgets.delete(w);
    }
    if (!widgets.size) { scheduleReset(); return stats; }
    cancelReset();                        // 又有活干了，待复位作废
    applies++;
    ledger.pruneDetached();               // 已脱离文档的记账：先还样式再丢记录
    ledger.begin();                       // 开一轮：本轮没再认领的记账，收尾时还原
    const blocks = [];
    const records = [];
    for (const w of Array.from(widgets)) {
      let geo = null;
      try {
        geo = applyLivePreviewFloat(w.host, w.cfg, {
          svg: w.svg,
          gap: w.gap,
          ledger,
          basePad: (el, prop) => padBaseOf(el, ledger, prop),
        });
      } catch (err) { geo = null; }
      if (!geo) continue;
      records.push(geo);
      blocks.push({ lines: geo.lines, side: geo.side, span: geo.span });
    }
    const pads = planLinePads(blocks, { reader: padReaderOf(ledger) });
    const styles = applyLinePads(pads, ledger);
    // 先写后撒：这一轮该留白的行已经全部写好了，再收拾上一轮留下、这一轮不再需要的
    const swept = ledger.sweep();
    ledger.pruneDetached();
    stats = { widgets: records.length, lines: pads.length, styles, applies, swept, resetState: 'live' };
    dbg('manager.pass', () => ({
      applies: stats.applies,
      registered: widgets.size,
      records: records.length,
      pads: pads.length,
      styles: stats.styles,
      swept: stats.swept,
      padSamples: pads.slice(0, 3).map((p) => ({ el: dbgEl(p.el), left: p.left, right: p.right })),
    }));
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
        if (content.isConnected === false) { flush('detached'); return; }
        schedule();
      });
      observer.observe(node, { childList: true, subtree: true });
      observedNode = node;
      dbg('manager.observe', () => ({
        ok: !!observer,
        node: dbgEl(node),
        isContent: node === content,
        cmFound: !!view,
      }));
    } catch (e) {
      observer = null;
      observedNode = null;
      dbg('manager.observe', () => ({ ok: false, error: String(e && e.message ? e.message : e) }));
    }
  };

  /* 兜底巡检：observer 只在被观察子树产生 childList 变化时回调，编辑器整个被换掉
   * （切笔记、切阅读视图）时不会触发。这里低频对一下：图还在不在、观察目标换了没。 */
  const startPoll = () => {
    if (poll || disposed || typeof setInterval !== 'function') return;
    try {
      poll = setInterval(() => {
        if (disposed) return;
        if (content.isConnected === false) { flush('detached'); return; }
        for (const w of Array.from(widgets)) {
          if (!w || !w.host || w.host.isConnected === false) widgets.delete(w);
        }
        if (!widgets.size) { scheduleReset(); return; }
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

  /**
   * 最后一个 widget 走掉：不立即复位，而是排一个延迟复位。
   * 这段时间内同一个 content 上来了新 widget，就 cancelReset() 让新的那一轮接管 ——
   * 样式从头到尾没被清空过，也就不存在「文字暂时退回整宽」的窗口。
   */
  const scheduleReset = () => {
    if (disposed || resetTimer) return false;
    const delay = Number(o.resetDelay) > 0 ? Number(o.resetDelay) : LP_RESET_DELAY;
    try {
      resetTimer = setTimeout(() => {
        resetTimer = 0;
        flush('deferred');
      }, delay);
      // Node（自测）里不给进程续命；浏览器没有 unref，忽略
      if (resetTimer && typeof resetTimer.unref === 'function') resetTimer.unref();
      stats.resetState = 'pending';
      dbg('lpf.reset.deferred', () => ({
        content: dbgEl(content),
        delay,
        widgets: widgets.size,
        applies,
        inDoc: content.isConnected !== false,
      }));
      return true;
    } catch (e) {
      resetTimer = 0;
      flush('deferred');                // 定时器都排不上，只能当场复位
      return false;
    }
  };

  const cancelReset = () => {
    if (!resetTimer) return false;
    try { clearTimeout(resetTimer); } catch (e) { /* ignore */ }
    resetTimer = 0;
    stats.resetState = 'live';
    dbg('lpf.reset.canceled', () => ({ content: dbgEl(content), widgets: widgets.size, applies }));
    return true;
  };

  /**
   * 终局：同步复位 + 拆掉计时器与观察者，不留任何延迟动作。
   * 节点已经脱离文档时照样把样式还回去（不去碰它的布局，只是改行内值），
   * 这样「切走笔记 / 关掉文档」跟「插件卸载」走同一条路。
   */
  const flush = (why) => {
    if (disposed) return;
    disposed = true;
    if (resetTimer) { try { clearTimeout(resetTimer); } catch (e) { /* ignore */ } resetTimer = 0; }
    if (timer) { try { clearTimeout(timer); } catch (e) { /* ignore */ } timer = 0; }
    if (poll) { try { clearInterval(poll); } catch (e) { /* ignore */ } poll = 0; }
    if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } }
    const inDoc = content.isConnected !== false;
    let restored = 0;
    try { restored = ledger.reset(); } catch (e) { restored = 0; }
    observer = null;
    observedNode = null;
    const left = widgets.size;
    widgets.clear();
    stats.resetState = 'flushed';
    try { lpManagers.delete(content); } catch (e) { /* ignore */ }
    if (api) lpLive.delete(api);
    dbg('lpf.reset.flushed', () => ({
      content: dbgEl(content), why: why || 'sync', inDoc, restored, applies, droppedWidgets: left,
    }));
  };

  api = {
    content,
    attach(w) {
      if (disposed || !w) return false;
      if (w.opts) {
        if (w.opts.cm && !o.cm) o.cm = w.opts.cm;
        if (w.opts.app && !o.app) o.app = w.opts.app;
        if (w.opts.getCM && !o.getCM) o.getCM = w.opts.getCM;
      }
      widgets.add(w);
      cancelReset();                    // 接管待复位的旧账，样式保持不动
      dbg('manager.attach', () => ({ host: dbgEl(w && w.host), registered: widgets.size, hasCmHook: !!(o.cm || o.getCM) }));
      ensureObserved();
      startPoll();
      pass();
      return true;
    },
    detach(w) {
      widgets.delete(w);
      if (disposed) return;
      if (!widgets.size) { scheduleReset(); return; }
      pass();                           // 还有别的图在：重算一行，把走掉的那张的留白收回去
    },
    refresh() { if (!disposed) pass(); },
    /** 立即同步复位（插件卸载 / 需要确定性收尾的场合） */
    flush() { flush('sync'); },
    /** 兼容旧调用：只负责「交出 widget」，真正的复位交给延迟 */
    dispose() {
      widgets.clear();
      scheduleReset();
    },
    state() {
      return {
        attached: !disposed,
        widgets: widgets.size,
        lines: stats.lines,
        styles: stats.styles,
        applies: stats.applies,
        swept: stats.swept,
        resetState: stats.resetState,
      };
    },
  };
  lpLive.add(api);
  return api;
}

/**
 * 插件卸载 / 页面关掉：把所有待复位的 manager 和纯 CSS 浮动控制器当场同步复位。
 * 卸载后没人会来接管，留着定时器就是脏样式 + 泄漏。
 */
function flushLivePreviewFloats() {
  const list = Array.from(lpLive);
  let n = 0;
  for (const m of list) {
    if (!m || typeof m.flush !== 'function') continue;
    try { m.flush(); n++; } catch (e) { /* ignore */ }
  }
  /* direct-embed 的纯 CSS 控制器：没有定时器，只需要把行内样式还回去 */
  for (const c of Array.from(lpCssLive)) {
    try { if (c && typeof c.dispose === 'function' && c.dispose()) n++; } catch (e) { /* ignore */ }
  }
  /* 重测调度器（observer / resize / scroll）不能留到卸载之后 */
  for (const slot of Array.from(lpMeasureLive)) {
    try { slot.sched.dispose(); } catch (e) { /* ignore */ }
  }
  lpMeasureLive.clear();
  return n;
}

/** 当前活着的 manager 数（诊断 / 自测用） */
function livePreviewManagerCount() {
  return lpLive.size;
}

/**
 * 让所有活着的浮动控件按当前开关重算一遍：关了就撤样式，开了就重新施加。
 * 开关改完立刻生效，不用重载插件、也不用重开笔记。
 */
function refreshLivePreviewFloats() {
  let n = 0;
  for (const c of Array.from(lpCssLive)) {
    try { if (c && typeof c.update === 'function') { c.update(); n++; } } catch (e) { /* ignore */ }
  }
  for (const m of Array.from(lpLive)) {
    try { if (m && typeof m.refresh === 'function') { m.refresh(); n++; } } catch (e) { /* ignore */ }
  }
  return n;
}

/**
 * 编辑模式浮动总开关。默认值见文件顶部的 LP_FLOAT；设置页通过插件自己的
 * loadData / saveData 存，加载时用这里改运行时真值。
 *
 * 关掉时连带把重测调度器拆了：没了浮动就没有重新测量的理由，不该留着监听。
 */
function setLpFloatEnabled(on) {
  const next = on !== false;
  if (next === lpFloatEnabled) return lpFloatEnabled;
  lpFloatEnabled = next;
  dbg('lp.float.toggle', () => ({ on: lpFloatEnabled }));
  if (!lpFloatEnabled) {
    for (const slot of Array.from(lpMeasureLive)) {
      try { slot.sched.dispose(); } catch (e) { /* ignore */ }
    }
    lpMeasureLive.clear();
  }
  try { refreshLivePreviewFloats(); } catch (e) { /* ignore */ }
  return lpFloatEnabled;
}

/**
 * Live Preview 版浮动控制。形状与阅读视图的 attachFloatWrap 一致
 * （host / update / dispose / state），trackFloat 不用分叉。
 */
function attachLivePreviewFloat(host, cfg, opts) {
  const o = opts || {};
  const side = cfg && cfg.float;
  dbg('lpf.enter', () => ({ side: side || null, host: dbgEl(host), chain: dbgChain(host, 5), inDoc: !!(host && host.isConnected) }));
  if (side !== 'left' && side !== 'right') { dbgNull('lpf.null', 'lpf.side'); return null; }
  if (!lpFloatEnabled) { dbgNull('lpf.null', 'lpf.disabled'); return null; }   // 开关关掉：一条样式都不写
  if (!host || typeof host.getBoundingClientRect !== 'function') { dbgNull('lpf.null', 'lpf.host'); return null; }

  const widget = { host, cfg, svg: o.svg, gap: o.gap, opts: o };
  let manager = null;
  let control = null;          // direct-embed：一行高度 + 逐行留白的控制器（不建 manager）
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
    if (attempt >= LP_RETRY.length) {
      // 重试额度用完了：这一条就是「静默放弃」的证据
      dbg('lpf.giveup', () => ({ attempts: attempt, host: dbgEl(host), inDoc: !!(host && host.isConnected) }));
      return;
    }
    const delay = LP_RETRY[attempt++];
    try { retry = setTimeout(attach, delay); } catch (e) { retry = 0; }
  };

  function attach() {
    retry = 0;
    if (disposed || manager || control) return;
    const parts = livePreviewParts(host);
    if (!parts) {
      dbg('lpf.wait', () => ({
        attempt,
        host: dbgEl(host),
        inDoc: !!(host && host.isConnected),
        chain: dbgChain(host, 7),
        hasEmbed: !!climbTo(host, 'cm-embed-block', CLIMB_LIMIT + 8),
        hasContent: !!climbTo(host, 'cm-content', CLIMB_LIMIT + 12),
        hasLine: !!climbTo(host, 'cm-line', CLIMB_LIMIT),
      }));
      nextRetry();
      return;                              // 还没插进文档，稍后再试
    }
    dbg('lpf.parts', () => lpPartsInfo(host, parts));
    /* direct-embed：widget 钉成一行，图绝对定位浮出去，后续行留白 */
    if (parts.mode === 'direct-embed') {
      control = createCssFloatControl(host, cfg, o);
      dbg('lpf.attach.done', () => ({ attempt, branch: 'css-float', state: control.state() }));
      return;
    }
    let m = lpManagers.get(parts.content);
    if (m) {
      // 已经收尾的旧 manager 不能复用（它连账本都清空了）
      const st = typeof m.state === 'function' ? m.state() : null;
      if (st && st.attached === false) m = null;
    }
    if (!m) {
      m = createLivePreviewManager(parts.content, {
        cm: o.cm, app: o.app, getCM: o.getCM, resetDelay: o.resetDelay,
      });
      lpManagers.set(parts.content, m);
    }
    manager = m;
    if (!m.attach(widget)) { manager = null; nextRetry(); return; }
    dbg('lpf.attach.done', () => ({ attempt, state: typeof m.state === 'function' ? m.state() : null }));
  }

  attach();

  return {
    host,
    update: () => {
      dbg('lpf.update', () => ({ hasManager: !!manager, hasCss: !!control, disposed }));
      if (disposed) return;
      if (control) { control.update(); return; }
      if (manager && manager.state().attached === false) manager = null;   // 已收尾的旧 manager
      if (manager) manager.refresh();
      else attach();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      dbg('lpf.dispose', () => ({ host: dbgEl(host), hadManager: !!manager, hadCss: !!control }));
      stopRetry();
      if (control) {                       // 纯 CSS：当场还原，不留观察者与定时器
        const c = control;
        control = null;
        c.dispose();
        return;
      }
      const m = manager;
      manager = null;
      if (m) m.detach(widget);
    },
    state: () => (control ? control.state() : (manager ? manager.state() : { attached: false, side })),
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
    put('margin', '0.5rem 1rem 0.5rem 0');
    put('clear', 'both');
  } else if (mode === 'right') {
    put('float', 'right');
    put('margin', '0.5rem 0 0.5rem 1rem');
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

/**
 * 把当前页所有受照顾的宿主（.cm-editor 里的）全部复位。
 * 没有 document（自测 / 非浏览器环境）时返回 0，不报错。
 */
function clearLivePreviewFloatLayout(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d || typeof d.querySelectorAll !== 'function') return 0;
  let nodes = [];
  try { nodes = d.querySelectorAll('.cm-editor .bm-floated') || []; } catch (e) { return 0; }
  let n = 0;
  for (let i = 0; i < nodes.length; i++) {
    try { resetFloatLayout(nodes[i]); n++; } catch (e) { /* ignore */ }
  }
  return n;
}

module.exports = {
  FLOAT_GAP,
  CLIMB_LIMIT,
  WRAP_LIMIT,
  LP_DEBOUNCE,
  LP_POLL,
  LP_RETRY,
  LP_RESET_DELAY,
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
  padBaseOf,
  padReaderOf,
  applyLivePreviewFloat,
  findEditorView,
  attachLivePreviewFloat,
  flushLivePreviewFloats,
  livePreviewManagerCount,
  refreshLivePreviewFloats,
  /* 编辑模式浮动总开关（默认值 LP_FLOAT，设置页通过 set 改运行时真值） */
  LP_FLOAT,
  isLpFloatEnabled,
  setLpFloatEnabled,
  planWrappedLines,
  // 实时预览（CM6）：direct-embed 走「一行高度 + 绝对定位图 + 逐行留白」
  LP_LINE_FALLBACK,
  setImportantStyle,
  computedLineHeightOf,
  oneLineHeightOf,
  planPinnedPads,
  /* 图为什么看不见：裁剪链体检与逐层放开 */
  CLIP_DEPTH,
  CLIP_HARD_STOP,
  styleOfEl,
  overflowClips,
  containClips,
  isClipHardStop,
  clipNodeInfo,
  clipChainOf,
  openClipChain,
  visibilityReport,
  applyLivePreviewCssFloat,
  createCssFloatControl,
  cmHeightInfo,
  /* 施加浮动后让 CM6 重测（direct-embed 路径） */
  measureSchedulerCount,
  createMeasureScheduler,
  RMEASURE_GAP,
  RMEASURE_SCROLL_IDLE,
  resetFloatLayout,
  clearLivePreviewFloatLayout,
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
