'use strict';

/*
 * 临时诊断（默认关闭，见 src/debug.js）。
 * 每一次 dbg() / dbgNull() 都是只读的：取元素 / 读样式 / 记一行 JSON，
 * 不改布局、不抛错。DEBUG_LP 关掉后这些调用直接返回。
 */
const {
  dbg, dbgEl, dbgRect, dbgCss, dbgInlineAll, dbgChain,
} = require('./debug.js');
/* valign 量不到行高时的最后兜底要 fontSize × lineHRatio */
const { OPT } = require('./opt.js');
/* valign 调用轨迹：只读，内存里攒，诊断命令触发时才落盘。不写样式、不加定时器。 */
const vt = require('./valtrace.js');

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
 * startOffset 是「图顶相对第一个兄弟顶边」的有符号距离（px）：
 *   0    图顶正好贴第一个兄弟顶边 —— 默认值，与加这个参数之前逐位一致
 *   > 0  图整体下移，图底也更靠下，要多覆盖一段
 *   < 0  图整体上移，图底也跟着上移，少覆盖一段
 * acc 累加的是「块底相对第一个兄弟顶边」的深度，所以判据是「块底 >= 图底」，
 * 图底 = startOffset + height。整张图都落在第一个兄弟上方（图底 <= 0）时没有块
 * 需要绕，返回空数组。
 *
 * @param {Element|null} startEl  第一个候选（通常是宿主的 nextElementSibling）
 * @param {number} height         图真实渲染高度（px）
 * @param {{limit?:number, startOffset?:number}} [opts]
 * @returns {Element[]}
 */
function collectWrapTargets(startEl, height, opts) {
  const out = [];
  const h = Number(height);
  if (!startEl || !(h > 0)) return out;
  const limit = opts && Number(opts.limit) > 0 ? Number(opts.limit) : WRAP_LIMIT;
  const rawOffset = opts ? Number(opts.startOffset) : 0;
  const startOffset = Number.isFinite(rawOffset) ? rawOffset : 0;   // 非数字按 0
  const bottom = startOffset + h;       // 图底相对第一个兄弟顶边的深度
  if (!(bottom > 0)) return out;        // 整图在第一个兄弟上方：一块都不用留白
  let el = startEl;
  let acc = 0;
  while (el && out.length < limit) {
    if (out.indexOf(el) >= 0) break;    // 兄弟链成环（假 DOM / 异常结构）
    out.push(el);
    acc += elHeight(el);
    if (acc >= bottom) break;           // 图底已盖住，后面恢复整宽
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
 * 阅读视图的垂直基准（valign）：算一个偏移量，只加在 floatify 写下的 top 上。
 *
 * 三个量与编辑模式完全同义，公式也直接共用 valignOffset：
 *   h      图原来那一行的行高 → 紧邻段落的行高（measureReaderLineHeight）
 *   H      图高 → 被绝对定位的那个块的 rect 高
 *   yTitle 一级标题中心相对图顶边 → 根节点文字 bbox 中心减块顶边
 * 量不到就退化为 0（bottom 的行为），不硬编。
 *
 * 为什么只动 top：阅读视图里图已经靠绝对定位脱流，垂直位置只由 top 决定；
 * 浮动、留白、环绕全是横向量法，一个字节都不参与。
 *
 * @returns {{valign:string, lineH:number, imgH:number, yTitle:number|null, offset:number}}
 */
function readerValignInfo(host, block, cfg, bRect) {
  const valign = (cfg && cfg.valign) || 'bottom';
  const imgH = bRect ? bRect.height : 0;
  const lineH = measureReaderLineHeight(block);
  const y = measureTitleCenter(host, block);
  const yTitle = Number.isFinite(y) ? round2(y) : null;
  return {
    valign,
    lineH: round2(lineH),
    imgH: round2(imgH),
    yTitle,
    offset: round2(valignOffset(lineH, imgH, yTitle, valign)),
  };
}

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
   * 垂直基准（valign）先量：它不只是改 top，留白范围也跟着它走（图上下挪了
   * 多少，需要绕的段落就跟着挪多少）。量的时候什么都还没写，所以提前到
   * 留白范围之前不会引入任何状态差异。
   */
  const vin = readerValignInfo(el, block, cfg, bRect);

  /*
   * 后面没有兄弟块时别动手：浮动的全部意义是「让后面的文字绕上来」，
   * 没有可绕的内容，脱离流只是白拆一次排版（还会把嵌套在 callout 里的图
   * 从它自己的壳里抽出来）。用流里的高度先数一遍上界。
   * startOffset 把 valign 的偏移量带进来：图顶不再默认贴第一个兄弟顶边。
   */
  const plan = collectWrapTargets(block.nextElementSibling, record.height, {
    limit: o.maxBlocks,
    startOffset: vin.offset,
  });
  if (!plan.length) return null;

  // 定位祖先进程：只补 position: relative，不动 display（动 display 会改整页排版）
  const pos = computedPosition(ancestor);
  if (!pos || pos === 'static') {
    const e = setInlineStyle(ancestor, 'position', 'relative');
    if (e) record.styles.push(e);
  }

  /*
   * 记下流里的位置再脱离流：top 沿用记下来的位置，横向贴住正文列左/右边界
   * （不能沿用图原来的横向位置，否则「右浮动」只在 400px 宽的小盒里贴了个左）
   *
   * 垂直基准（valign）就加在这个 top 上：bottom 恒为 0，top / middle 把图
   * 上推或下推若干像素，别的什么都不碰。量不到任何几何量时偏移就是 0，
   * 写出来的 top 与没写 valign 时逐位相同。
   */
  const baseTop = bRect.top - originY;
  const top = baseTop + vin.offset;
  record.valign = {
    valign: vin.valign,
    lineH: vin.lineH,
    imgH: vin.imgH,
    yTitle: vin.yTitle,
    baseTop: round2(baseTop),
    top: round2(top),
    offset: vin.offset,
  };
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
   *
   * 这里只读 after.left / after.right：valign 改的是 top，横向量法不受它影响，
   * 别让垂直偏移串进来变成间距。
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
    if (acc >= record.height + vin.offset) break;   // 图底 = 图高 + 垂直偏移
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
      ? {
        side: record.side,
        width: record.width,
        margin: record.margin,
        targets: record.wrap.length,
        valign: record.valign || null,
        applies,
      }
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
  /* 宿主复位 = 这套布局作废：尺寸观察器与补拍一起停掉，免得对着一张已经
   * 没有 valign 的图重算（幽灵重算），也免得宿主被丢弃后观察器泄漏。 */
  disconnectValignObserver(host);
  clearValignRetries(host);
  host.__bmValignInfo = null;
  host.__bmValignRec = null;
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
 * 垂直基准（valign）：图相对「图片所在的那一行」上下挪
 *
 * 参照物是**行**，不是图后面那段可绕排文字。按用户原话：
 *   下 bottom（默认）：图片顶部对齐所在行 → 图就停在行顶，offset = 0
 *   上 top：          图片底部对齐所在行 → offset = h - H（图高过行，负值，整体上移）
 *   中 middle：       一级标题的中心对齐行中心 → offset = h / 2 - yTitle
 *
 * 三个量：
 *   h      图片所在那一行的行高（正文行高，不是图高，也不是后面那段文字的总高）
 *   H      图的高度（宿主 rect 高）
 *   yTitle 一级标题文字在图内的垂直中心，相对图的顶边；有多个根节点时取平均
 *
 * 为什么非浮动时一个数都不能写：
 *   styles.css 给非浮动 widget 加了 display: flow-root（8daf8aa 修的
 *   外边距塌陷）。widget 自成 BFC 时，子元素的 margin-top 会直接参与父级
 *   高度计算（负的减、正的加），widget 的 rect 跟着变，而 CM6 正是按 rect
 *   记账的 —— 图挪了多少，光标就错多少。
 *
 * 为什么浮动时反而安全：
 *   浮动状态下 styles.css 那条 flow-root 是关掉的（:not(:has(.bm-float-*))），
 *   .cm-embed-block 里只剩一个浮动子元素，高度塌成 0。0 这个数不随
 *   宿主 margin-top 变（浮动元素的外边距不进父级高度），账实仍然一致，
 *   图只是视觉上往下挪，绕排照旧。
 *
 * 所以「valign 只对 float: left / right 生效」不是妥协，是唯一安全的路径。
 * position: absolute 那条也不行：脱了浮动流，后面的文字立刻不绕排。
 *
 * 阅读视图是另一套（floatify 把图绝对定位，垂直位置只由 top 决定），语义与
 * 公式完全一致，但偏移量是加到那个 top 上，见 readerValignInfo。
 * 下面这一整套（margin-top / cm-content 守卫 / 尺寸观察器）只服务编辑模式。
 *
 * 什么时候重算：只跟尺寸走。挂上一个 ResizeObserver 盯宿主自己，尺寸一变就
 * 重算一次（16ms 防抖）；尺寸不变就永远不触发，没有轮到定时器。
 *   - 图的自校准（mountBraceSvg 在 0/60/250/1000ms 与字体就绪后重排）会改图高，
 *     正好被它接住，量到的 yTitle / imgH 才是最终值
 *   - 观察的是宿主，不是父级 .cm-embed-block：浮动让**父级**高度塌成 0（那个 0
 *     永远不动），宿主自己的高度就是图高，会变
 *
 * 首次挂载那次例外：渲染时宿主还没插进 .cm-content，量不到任何几何量。这里按
 * attachFloatWrap 的节奏补拍 120/480/1200ms 各一次（有上限，不轮询）。
 * ============================================================ */

/**
 * 纯计算：按垂直基准算出 margin-top 该写的偏移（px）。
 *
 * bottom 恒为 0；top 把图整体上推 (H - h)；middle 把「一级标题中心」挪到行中心。
 * 三个退化口子：
 *   H 为 0（图没渲染出来）→ 一律 0
 *   h 拿不到或为 0     → top / middle 都不做偏移（退化为 bottom）
 *   yTitle 拿不到      → middle 退化为 0（即 bottom）
 *
 * @param {number} h        图片所在那一行的行高（正文行高）
 * @param {number} imgH     图高（宿主 rect 高）
 * @param {number} yTitle   一级标题在图内的垂直中心，相对图的顶边
 * @param {'top'|'middle'|'bottom'} valign
 * @returns {number}
 */
function valignOffset(h, imgH, yTitle, valign) {
  const line = Number(h);
  const H = Number(imgH);
  if (!Number.isFinite(line) || !Number.isFinite(H)) return 0;
  if (!(H > 0)) return 0;                                 // 图没渲染出来：不动
  if (valign !== 'top' && valign !== 'middle') return 0;  // bottom（默认）/ 非法值
  if (!(line > 0)) return 0;                              // 行高量不到：退化为 bottom
  if (valign === 'top') return line - H;
  /* null / undefined 单独拦：Number(null) 是 0，会让「量不到标题」误当成「标题在顶边」 */
  if (yTitle == null) return 0;
  const y = Number(yTitle);
  if (!Number.isFinite(y)) return 0;                      // 取不到标题位置：退化为 bottom
  return line / 2 - y;
}

/**
 * 读一个 computed 长度，只认能变成正数 px 的。
 * line-height: normal 的计算值就是 'normal'，parseFloat 得 NaN，正好落到下一条兜底。
 * 没有 defaultView / 假 DOM 读不到时同样返回 NaN。
 */
function computedPx(el, prop) {
  if (!el) return NaN;
  try {
    const doc = el.ownerDocument;
    const view = doc && doc.defaultView;
    const cs = view && view.getComputedStyle ? view.getComputedStyle(el) : null;
    if (!cs) return NaN;
    const v = parseFloat(cs[prop]);
    return Number.isFinite(v) && v > 0 ? v : NaN;
  } catch (e) { return NaN; }
}

/**
 * 量「图片所在那一行的行高」。
 *
 * 四个候选，按可信程度排：
 *   1. 相邻 .cm-line（真的正文行元素）的 computed line-height：这是那一行自己的
 *      CSS 行高，与旁边恰好排了什么无关。也不能只看 .cm-content：宿主是块 widget，
 *      它自己不在 .cm-line 里，而 line-height 可能只写在 .cm-line 上。
 *   2. 相邻 .cm-line 里一个行盒的高（块高 ÷ 行数）：浏览器真排出来的那一行。
 *      元素 rect 高不能直接用：一个 .cm-line 是一段落，折两行就是两个行高。
 *   3. 宿主所在层级（.cm-line 祖先，没有就 .cm-content）的 computed line-height。
 *   4. fontSize × OPT.lineHRatio：连几何都量不到时的最后兜底。
 * 都拿不到返回 0，调用方按「不做偏移」处理。
 */
function measureLineHeight(host) {
  const sib = siblingLine(host);

  const fromSib = computedPx(sib, 'lineHeight');
  if (fromSib > 0) return fromSib;

  const fromRow = sib ? rowHeightOf(sib) : 0;
  if (fromRow > 0) return fromRow;

  const anchor = climbTo(host, 'cm-line', CLIMB_LIMIT) || climbTo(host, 'cm-content', CLIMB_LIMIT);
  const fromAnchor = computedPx(anchor, 'lineHeight');
  if (fromAnchor > 0) return fromAnchor;

  const fs = computedPx(sib, 'fontSize')
    || computedPx(anchor, 'fontSize')
    || computedPx(host, 'fontSize');   // 浮动后前两者可能都拿不到，宿主一定有
  return fs > 0 ? fs * OPT.lineHRatio : 0;
}

/**
 * 一个 .cm-line 里「一行行盒」的高度。
 *
 * 不能直接用元素 rect 高：CM6 里一个 .cm-line 是一段落，长文会折成好几行，
 * 元素高 = 行数 × 行高（headless 实测：折两行那段 rect 是 63px，行高 31.5px）。
 * 做法：用 Range 数它内部有几个视觉行（按顶边去重），再用块高除以行数。
 * 没 Range（假 DOM / 旧环境）或数不出行数时退回整块高。
 * opts.strict 为真时改成「数不出来就报 NaN」：阅读视图里那个段落可能已经折成
 * 好几行，拿段落总高当行高会把图推得过远，宁可退化为不偏移。
 */
function rowHeightOf(el, opts) {
  const strict = !!(opts && opts.strict);
  const blockH = elHeight(el);
  if (!(blockH > 0)) return strict ? NaN : 0;
  try {
    const doc = el && el.ownerDocument;
    if (doc && typeof doc.createRange === 'function') {
      const rng = doc.createRange();
      rng.selectNodeContents(el);
      const rects = typeof rng.getClientRects === 'function' ? rng.getClientRects() : null;
      if (rects && rects.length) {
        const tops = [];
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i];
          if (!r || !(r.height > 0)) continue;
          const t = Math.round(r.top * 10) / 10;
          if (tops.indexOf(t) < 0) tops.push(t);
        }
        if (tops.length > 1) return blockH / tops.length;
        if (tops.length === 1) return blockH;      // 只排了一行：块高本身就是行高
        if (strict) return NaN;                     // 一个有效行盒都没有：数不出来
      }
    }
  } catch (e) { /* 数不出行数就退回整块高 */ }
  /* strict：读不到就报「量不到」（NaN），让调用方退化为不偏移，
   * 而不是拿一个折了行的段落总高当行高（那会把图推得过远）。 */
  return strict ? NaN : blockH;
}

/* ---------------------- 阅读视图：图原来的流位置 ---------------------- */

/** 这元素算不算「一段正文」：<p> / Obsidian 的 .el-p / CM6 的 .cm-line / 里面包着 <p> 的壳 */
function isParagraphEl(el) {
  if (!el) return false;
  let tag = '';
  try { tag = String(el.tagName || '').toUpperCase(); } catch (e) { tag = ''; }
  if (tag === 'P') return true;
  if (classHas(el, 'el-p') || classHas(el, 'el-paragraph') || classHas(el, 'cm-line')) return true;
  try { return !!(el.querySelector && el.querySelector('p')); } catch (e) { return false; }
}

/**
 * 阅读视图里「图所在那一行」的替身：紧邻的正文段落。
 *
 * 阅读视图没有 .cm-line，正文是 <p>（或 Obsidian 包一层的 .el-p）。图的块在
 * sizer 里就是一个普通兄弟，所以「那一行」只剩紧邻段落这一个可读的东西。
 * 先往后找（图下方那段就是它原来的下一行），到文末再往前找。
 */
function readerParagraph(block) {
  if (!block) return null;
  let el = block.nextElementSibling;
  for (let i = 0; el && i < WRAP_LIMIT; i++) {
    if (isParagraphEl(el)) return el;
    el = el.nextElementSibling;
  }
  el = block.previousElementSibling;
  for (let i = 0; el && i < WRAP_LIMIT; i++) {
    if (isParagraphEl(el)) return el;
    el = el.previousElementSibling;
  }
  return null;
}

/**
 * 量阅读视图里「图所在那一行」的行高。
 *
 * computed line-height 优先（正文行高就写在段落上），读不到（normal / 假 DOM）
 * 再用「块高 ÷ Range 数出的视觉行数」。两个都拿不到返回 0，调用方按「不偏移」处理。
 * 与编辑模式共用同一套判据，只是「那一行」换成了段落，所以单独一个入口。
 */
function measureReaderLineHeight(block) {
  const para = readerParagraph(block);
  if (!para) return 0;
  const fromCss = computedPx(para, 'lineHeight');
  if (fromCss > 0) return fromCss;
  /* .el-p 这种壳自己可能是 normal，真正的行高落在里面的 <p> 上 */
  let core = para;
  try { core = (para.querySelector && para.querySelector('p')) || para; } catch (e) { core = para; }
  if (core !== para) {
    const fromCore = computedPx(core, 'lineHeight');
    if (fromCore > 0) return fromCore;
  }
  const row = rowHeightOf(core, { strict: true });
  return Number.isFinite(row) && row > 0 ? row : 0;
}

/**
 * 找一个「真正的正文行」：离宿主最近的兄弟 .cm-line。
 * 先往后（图下方那行就是图片所在行），图在笔记末尾时再往前。
 * 只看元素本身，不量尺寸——调用方自己决定要它的 computed 还是行盒高。
 */
function siblingLine(host) {
  const line = climbTo(host, 'cm-line', CLIMB_LIMIT);
  const anchor = line || (host && host.parentElement) || null;
  if (!anchor) return null;

  let el = anchor.nextElementSibling;
  for (let i = 0; el && i < WRAP_LIMIT; i++) {
    if (classHas(el, 'cm-line')) return el;
    el = el.nextElementSibling;
  }
  el = anchor.previousElementSibling;
  for (let i = 0; el && i < WRAP_LIMIT; i++) {
    if (classHas(el, 'cm-line')) return el;
    el = el.previousElementSibling;
  }
  return null;
}

/**
 * 量一级标题（cfg.roots 的根节点，不是 title: 指令那个图题）在图内的垂直中心，
 * 单位是相对宿主顶边（= 图顶边）的距离。
 *
 * 根节点的 <text> 在渲染时带 data-bm-root（见 src/svg.js）。量的是它自己的 bbox，
 * 所以缩放、题图 <g transform> 的偏移、方向映射全都自动含进去了，
 * 不需要再把 layout 的 SVG 坐标换算回宿主坐标。
 * 多行根节点取整块文字的 bbox 中心；多个根取平均；一个都量不到返回 NaN。
 *
 * origin 是「图的顶边」参照物，默认宿主自己；阅读视图里传的是真正被绝对定位
 * 的那个块（可能是包了一层的壳），那样量出来的 yTitle 才和写进 top 的坐标系一致。
 */
function measureTitleCenter(host, origin) {
  if (!host || typeof host.querySelectorAll !== 'function') return NaN;
  let roots = null;
  try { roots = host.querySelectorAll('[data-bm-root]'); } catch (e) { return NaN; }
  if (!roots || !roots.length) return NaN;
  const hr = rectOf(origin || host);
  if (!hr) return NaN;

  let sum = 0;
  let n = 0;
  for (let i = 0; i < roots.length; i++) {
    const r = rectOf(roots[i]);
    if (!r || !(r.height > 0)) continue;      // 纯公式根节点文字框可能是空的
    sum += (r.top + r.height / 2) - hr.top;
    n++;
  }
  return n ? sum / n : NaN;
}

/**
 * 按 cfg.valign 给编辑模式里的浮动图写垂直偏移（正的 margin-top 往下推，负的往上提）。
 *
 * 四个前置条件缺一不可：
 *   - cfg.float 是 left / right（center / inline 不浮动，没有可对齐的基准）
 *   - 宿主在 .cm-editor 里（阅读视图那条 floatify / applyWrapMargins 一行不碰）
 *   - 宿主已经带上 bm-floated（说明那一行 float 真的写上了）
 *   - 宿主连在文档上（否则按 120/480/1200ms 补拍三次，量不到就按 bottom）
 *
 * 再加一条「量到了才算」：图高为 0 或根节点一个都没有时算「没准备好」，
 * 直接返回，保留上一次的结果（见函数体里的注释）。
 *
 * 写样式走 setInlineStyle 并记进 host.__bmFloatLayout：那份账归
 * resetFloatLayout 统一还原，复位后不会留下写死的 margin-top。
 * 顺序上 applyFloatLayout 先写 margin 简写（margin-top: 0），这里再写
 * margin-top 长属性，长属性覆盖简写里的那一段，不会被吃掉。
 *
 * bottom 档算出来恒为 0，一个样式都不写（简写里的 margin-top 本来就是 0）。
 *
 * @returns {number} 偏移量（0 表示没写样式；值没变时照旧返回，但不重写）
 */
/**
 * 宿主现在是不是在编辑区（.cm-content）里。
 *
 * 优先用 closest：走选择器引擎，没有层数上限，也不会被中间多包的壳打断。
 * climbTo 靠 classList.contains 逐层爬，上限 4 层，而真实链路是
 *   host → .cm-embed-block → .cm-content → ...
 * 真机上它在某个环节拿不到，功能就会永远落到「未挂载」分支。
 *
 * 没有 closest 的环境（测试里的假 DOM）退回 climbTo，限于明显够用的深度。
 */
/** 宿主里那个 SVG（图真正画在里面的地方）。拿不到返回 null。 */
function pickSvg(host) {
  if (!host || typeof host.querySelector !== 'function') return null;
  try { return host.querySelector('svg'); } catch (e) { return null; }
}

/**
 * 宿主里有几个根节点文字（`[data-bm-root]`）。无 DOM 能力 / 不是宿主时返回 0。
 *
 * 它就是「图真的画出来了」的第二个证据：宿主高量得到、根节点也在，才算准备好了。
 */
function rootNodeCount(host) {
  if (!host || typeof host.querySelectorAll !== 'function') return 0;
  try {
    const roots = host.querySelectorAll('[data-bm-root]');
    return roots && roots.length ? roots.length : 0;
  } catch (e) { return 0; }
}

function inEditorNow(host) {
  if (!host) return false;
  if (typeof host.closest === 'function') {
    try { return !!host.closest('.cm-content'); } catch (e) { /* 退回下一档 */ }
  }
  return !!climbTo(host, 'cm-content', 8);
}

/* ---------------------- valign 的只读体检 ---------------------- */

/**
 * 只读体检：把 applyValignLayout 会看的每一个量单独取一次，一个字段都不写。
 *
 * 两处共用：
 *   1. 每次调用的轨迹（返回那一刻量）
 *   2. 诊断命令的现场快照（命令触发那一刻量，不经过 applyValignLayout）
 * 共用同一套量法，所以「函数里量到的」和「现场量到的」能逐字段对账。
 *
 * 每一项单独 try/catch：假 DOM / 半残对象上只是少一个数，绝不抛。
 *
 * @returns {object} 见各字段注释（编号对应诊断清单里的项）
 */
function valignProbe(host) {
  const out = {
    conn: null,        // 4  host.isConnected（!== false）
    closest: null,     // 5  !!host.closest('.cm-content')；null 表示这个宿主没有 closest
    climb8: null,      // 6  !!climbTo(host, 'cm-content', 8)
    hHost: null,       // 7  elHeight(host)
    hSvg: null,        // 8  elHeight(pickSvg(host))
    imgH: null,        // 图高：elHeight(host) || elHeight(pickSvg(host))，与函数里的取法一致
    svg: 'none',       // 9  pickSvg 的结果：'none' 或 tagName
    lineH: null,       // 10 measureLineHeight(host)
    yTitle: null,      // 11 measureTitleCenter(host)（NaN 原样保留）
    roots: null,       // 12 [data-bm-root] 个数
    rectH: null,       // 15 host.getBoundingClientRect().height
    floated: null,     // 有没有 bm-floated 类
    mt: '',            // 当前行内 margin-top 原文
    probeValign: '',   // 现场按哪个基准算（取宿主的 cfg / 旧记录）
    probeOffset: null, // 现场用现有量算出来的 valignOffset
  };
  try { out.floated = host ? classHas(host, 'bm-floated') : null; } catch (e) { out.floated = null; }
  try { out.conn = host ? host.isConnected !== false : null; } catch (e) { out.conn = null; }
  try {
    if (host && typeof host.closest === 'function') out.closest = !!host.closest('.cm-content');
  } catch (e) { out.closest = null; }
  try { out.climb8 = host ? !!climbTo(host, 'cm-content', 8) : null; } catch (e) { out.climb8 = null; }
  try { out.hHost = host ? elHeight(host) : null; } catch (e) { out.hHost = null; }
  let svgEl = null;
  try { svgEl = pickSvg(host); } catch (e) { svgEl = null; }
  try {
    if (svgEl) {
      out.hSvg = elHeight(svgEl);
      out.svg = String(svgEl.tagName || svgEl.nodeName || 'svg').toLowerCase();
    }
  } catch (e) { out.hSvg = null; }
  try { out.lineH = host ? round2(measureLineHeight(host)) : null; } catch (e) { out.lineH = null; }
  try { out.yTitle = host ? measureTitleCenter(host) : null; } catch (e) { out.yTitle = NaN; }
  /* 图高取法与函数里一致：先宿主，宿主量不到再退到 SVG */
  try {
    const img = (out.hHost > 0) ? out.hHost : ((out.hSvg > 0) ? out.hSvg : 0);
    out.imgH = round2(img);
  } catch (e) { out.imgH = null; }
  try { out.roots = host ? rootNodeCount(host) : null; } catch (e) { out.roots = null; }
  try {
    if (host && typeof host.getBoundingClientRect === 'function') {
      const r = host.getBoundingClientRect();
      if (r && Number.isFinite(r.height)) out.rectH = r.height;
    }
  } catch (e) { out.rectH = null; }
  try { out.mt = host && host.style && host.style.marginTop ? String(host.style.marginTop) : ''; } catch (e) { out.mt = ''; }
  try {
    const hcfg = (host && host.__bmCfg) || null;
    const hinfo = (host && host.__bmValignInfo) || null;
    out.probeValign = (hcfg && hcfg.valign) || (hinfo && hinfo.valign) || 'bottom';
    const imgH = out.hHost || out.hSvg || 0;
    out.probeOffset = round2(valignOffset(out.lineH, imgH, out.yTitle, out.probeValign));
  } catch (e) { out.probeOffset = null; }
  return out;
}

/**
 * 记一条轨迹。任何异常都在这里面吃掉：轨迹是取证层，不许影响布局。
 * 量的时机 = 即将返回的那一刻（write 那一趟取于写完 margin-top 之后）。
 */
function vtTrace(host, cfg, src, exit, extra) {
  try {
    vt.record({
      src,
      exit,
      host,
      probe: valignProbe(host),
      val: (cfg && cfg.valign) || 'bottom',
      float: (cfg && cfg.float) || '',
      offset: extra && extra.offset !== undefined ? extra.offset : null,
      wrote: !!(extra && extra.wrote),
      err: extra && extra.err ? String(extra.err) : '',
    });
  } catch (e) { /* 轨迹失败绝不影响布局 */ }
}

/**
 * @param {string} [from] 入口代号：render / retry / observer / reapply。
 *   只进轨迹，不参与任何判断（不传就是 other）。
 */
function applyValignLayout(host, cfg, retried, from) {   // retried：兼容旧调用，行为已由补拍统一负责
  const src = typeof from === 'string' && from ? from : 'other';
  try {
    return valignPass(host, cfg, src);
  } catch (e) {
    vtTrace(host, cfg, src, 'throw', { err: (e && e.message) ? e.message : String(e) });
    throw e;
  }
}

/** 真正干活的那一趟：每个 return 前留一条轨迹，说明从哪个分支走的 */
function valignPass(host, cfg, src) {
  if (!host || !host.style || !cfg) {
    vtTrace(host, cfg, src, host ? '!cfg' : '!host');
    return 0;
  }
  const mode = cfg.float;
  if (mode !== 'left' && mode !== 'right') {
    vtTrace(host, cfg, src, 'float!=lr');
    return 0;
  }
  if (!classHas(host, 'bm-floated')) {             // float 没真写上去时不能加偏移
    vtTrace(host, cfg, src, '!bm-floated');
    return 0;
  }

  /*
   * 判「在不在编辑区里」用 closest 而不是 climbTo：
   * climbTo 靠 classList.contains 逐层爬，上限 4 层，而真实链路是
   *   host → .cm-embed-block → .cm-content → .cm-contentContainer → .cm-sizer
   *   → .cm-scroller → .cm-editor
   * 真机上它拿不到 .cm-content，于是永远落到「未挂载」分支，功能一次都不生效。
   * closest 走选择器引擎，没有层数上限，也不会被中间多包一层壳打断。
   *
   * 未挂载时补拍 120/480/1200ms 各一次（与 attachFloatWrap 同一套节奏，
   * 覆盖自校准的 0/60/250/1000ms），每个宿主只排一轮，连上就把剩下的撤掉。
   */
  const inEditor = host.isConnected !== false && inEditorNow(host);
  if (!inEditor) {
    scheduleValignRetries(host, cfg);
    vtTrace(host, cfg, src, '!inEditor');
    return 0;
  }
  clearValignRetries(host);                         // 连上了：补拍不用再来

  /*
   * 图还没准备好：不在文档里 / 还没渲染 / 正在重建。
   *
   * 这种时刻量到的图高是 0、根节点也是 0，算出来的偏移必然是 0。以前让它照样
   * 往下走，就会把上一次写好的 margin-top（以及 __bmValignInfo）一起撤掉，
   * 于是「生效过又被一次失败的量撤回」，之后再也没恢复。
   *
   * 所以这里直接返回：不算偏移、不还原、不写样式、不碰 __bmValignInfo。
   * 时机交给已有的补拍和尺寸观察器，这里不排任何新东西。
   *
   * 判据只认 0：图小不是错，只有完全量不到才算没准备好。
   */
  const imgH = elHeight(host) || elHeight(pickSvg(host));
  if (!(imgH > 0) || !(rootNodeCount(host) > 0)) {
    vtTrace(host, cfg, src, 'not-ready');
    return 0;
  }

  const info = {
    valign: cfg.valign || 'bottom',
    lineH: 0, imgH: 0, yTitle: null, offset: 0, applied: false,
  };

  /*
   * 先量再记账。以前 info 在量之前就挂到宿主上，一旦中途 return，就留下
   * 一条「记录存在但字段全 0」的残影，诊断读到的 imgH 0.00 就是这么来的，
   * 排查时会被带偏。
   *
   * imgH 优先宿主自身，拿不到再退到 SVG：浮动刚生效、或宿主还没排出高度时，
   * 宿主 rect 可能是 0，而图已经在 SVG 里画好了。
   */
  info.imgH = round2(imgH);
  info.lineH = round2(measureLineHeight(host));
  const y = measureTitleCenter(host);
  info.yTitle = Number.isFinite(y) ? round2(y) : null;
  host.__bmValignInfo = info;

  // 行高量不到（0）或 yTitle 取不到（null）时，valignOffset 自己退化为 0
  const offset = valignOffset(info.lineH, info.imgH, info.yTitle, info.valign);
  info.offset = round2(offset);

  /* 新算的偏移和账上那条一模一样：一个字节都不重写。
   * 自校准会把图高改上十来次，没有这道闸每轮都要写一遍样式（样式抖动）。 */
  const prevRec = host.__bmValignRec;
  const want = info.offset + 'px';
  const cur = host.style.marginTop ? String(host.style.marginTop) : '';
  if (info.offset && prevRec && cur === want) {
    info.applied = true;
    ensureValignObserver(host, cfg);
    vtTrace(host, cfg, src, 'same', { offset: info.offset, wrote: true });
    return offset;
  }

  /* 同一宿主重复调用：先把上一轮的 margin-top 从账上摘掉，避免叠出两条记录。
   * 账已经不是那一份（中间跑过 applyFloatLayout）时只丢引用，不去动样式。 */
  if (prevRec) {
    const recs = host.__bmFloatLayout;
    const at = Array.isArray(recs) ? recs.indexOf(prevRec) : -1;
    if (at >= 0) {
      recs.splice(at, 1);
      restoreStyles([prevRec]);
    }
    host.__bmValignRec = null;
  }

  if (!offset) {                                    // bottom 档 / 量不到：一个样式都不写
    vtTrace(host, cfg, src, 'offset=0', { offset: info.offset });
    return 0;
  }

  const rec = setInlineStyle(host, 'marginTop', want);
  if (rec) {
    if (!Array.isArray(host.__bmFloatLayout)) host.__bmFloatLayout = [];
    host.__bmFloatLayout.push(rec);
    host.__bmValignRec = rec;
    info.applied = true;
  }
  /* 挂上「尺寸一变就重算」：只盯宿主尺寸，不变化就永远不触发。
   * 图的自校准与窗口变化都会改宿主高度，正好被它接住。 */
  ensureValignObserver(host, cfg);
  vtTrace(host, cfg, src, 'write', { offset: info.offset, wrote: !!rec });
  return offset;
}

/* ---------------------- valign 的尺寸观察器 / 首次补拍 ---------------------- */

/** 首次挂载补拍的节奏（ms）：与 attachFloatWrap 同一套，有上限，不轮询 */
const VALIGN_RETRY_DELAYS = [120, 480, 1200];

/** 尺寸变化后的防抖窗口（约一帧）：连续回调只算一次 */
const VALIGN_DEBOUNCE_MS = 16;

/** 已挂观察器登记簿：只在「宿主被丢弃又没人来道别」时兜底回收 */
const VALIGN_OBSERVERS = [];

/** 宿主所在的 window（假 DOM / 无 window 时返回 null） */
function windowOf(host) {
  const doc = host && host.ownerDocument;
  const win = doc && doc.defaultView;
  if (win) return win;
  return (typeof window !== 'undefined') ? window : null;
}

/**
 * 断开某个宿主的尺寸观察器（宿主复位 / 销毁时调）。
 * 顺带清掉还排着的防抖任务，避免它对着已经没人要的元素重算一遍。
 *
 * @returns {number} 断开了一个观察器返回 1
 */
function disconnectValignObserver(host) {
  const st = host && host.__bmValignObs;
  if (!st) return 0;
  host.__bmValignObs = null;
  if (st.timer) {
    try { clearTimeout(st.timer); } catch (e) { /* ignore */ }
    st.timer = 0;
  }
  if (st.raf) {
    const win = windowOf(host);
    try {
      if (win && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(st.raf);
      else if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(st.raf);
    } catch (e) { /* ignore */ }
    st.raf = 0;
  }
  st.pending = false;
  if (st.ro) {
    try { st.ro.disconnect(); } catch (e) { /* ignore */ }
    st.ro = null;
  }
  const at = VALIGN_OBSERVERS.indexOf(st);
  if (at >= 0) VALIGN_OBSERVERS.splice(at, 1);
  return 1;
}

/**
 * 回收已经脱离文档的宿主：widget 重建时旧宿主被直接丢弃，没有销毁钩子，
 * 只能在下一次挂新宿主时顺手清一遍（不是巡检，没有定时器）。
 */
function pruneValignObservers() {
  for (let i = VALIGN_OBSERVERS.length - 1; i >= 0; i--) {
    const st = VALIGN_OBSERVERS[i];
    if (!st) { VALIGN_OBSERVERS.splice(i, 1); continue; }
    if (!st.host || st.host.isConnected === false) disconnectValignObserver(st.host);
  }
}

/**
 * 防抖地重算一次 valign。
 * 16ms 定时器与下一帧赛跑，谁先到算谁的：headless / 页面不可见时
 * requestAnimationFrame 可能长期不投递，只靠帧会永远排不上。
 */
function scheduleValignApply(host) {
  const st = host && host.__bmValignObs;
  if (!st || st.pending) return false;
  st.pending = true;
  const fire = () => {
    if (!st.pending) return;                        // 另一路先到，这一路作废
    st.pending = false;
    if (st.timer) { try { clearTimeout(st.timer); } catch (e) { /* ignore */ } st.timer = 0; }
    if (st.raf) {
      const win = windowOf(host);
      try {
        if (win && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(st.raf);
        else if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(st.raf);
      } catch (e) { /* ignore */ }
      st.raf = 0;
    }
    if (host.isConnected === false) { disconnectValignObserver(host); return; }
    const cfg = st.cfg || host.__bmCfg;
    if (!cfg) return;
    try { applyValignLayout(host, cfg, true, 'observer'); } catch (e) { /* ignore */ }
  };
  try { st.timer = setTimeout(fire, VALIGN_DEBOUNCE_MS); } catch (e) { st.timer = 0; }
  const win = windowOf(host);
  if (win && typeof win.requestAnimationFrame === 'function') {
    try { st.raf = win.requestAnimationFrame(fire); } catch (e) { st.raf = 0; }
  }
  if (!st.timer && !st.raf) fire();                 // 两边都排不上：当场算
  return true;
}

/**
 * 给宿主挂一个只盯尺寸的观察器，同一个宿主只挂一个（重复调用直接返回）。
 *
 * 观察宿主自己而不是父级 .cm-embed-block：浮动让父级高度塌成 0，那个 0 不随图高
 * 变化；宿主自身的高度就是图高，自校准改高时它会回调。
 * 观察器的首次回调天然就是「挂载后第一次」的兜底：observe 之后浏览器会投递一次。
 *
 * @returns {{host:Object, ro:Object, fired:number}|null}
 */
function ensureValignObserver(host, cfg) {
  if (!host || typeof host !== 'object') return null;
  const has = host.__bmValignObs;
  if (has && has.ro) { has.cfg = cfg || has.cfg; return has; }   // 只挂一个，重复调用不叠加
  if (typeof ResizeObserver === 'undefined') return null;
  pruneValignObservers();
  const st = { host, ro: null, fired: 0, pending: false, timer: 0, raf: 0, cfg: cfg || null };
  try {
    st.ro = new ResizeObserver(() => {
      st.fired++;
      if (host.isConnected === false) { disconnectValignObserver(host); return; }
      scheduleValignApply(host);
    });
  } catch (e) { return null; }
  try {
    st.ro.observe(host);
  } catch (e) {
    try { st.ro.disconnect(); } catch (err) { /* ignore */ }
    return null;
  }
  host.__bmValignObs = st;
  VALIGN_OBSERVERS.push(st);
  return st;
}

/**
 * 首次挂载：宿主还没插进 .cm-content 时补拍（120 / 480 / 1200ms 各一次）。
 * 同一个宿主只排一轮；补拍成功就撤掉剩下的。上限就是这三拍，不排第四拍。
 *
 * @returns {number} 这一轮排了几拍
 */
function scheduleValignRetries(host, cfg) {
  if (!host || host.__bmValignRetry) return 0;
  const st = { timers: [] };
  host.__bmValignRetry = st;
  for (let i = 0; i < VALIGN_RETRY_DELAYS.length; i++) {
    const last = i === VALIGN_RETRY_DELAYS.length - 1;
    try {
      st.timers.push(setTimeout(() => {
        if (!host.__bmValignRetry) return;          // 已经连上 / 已复位，这一拍作废
        try { applyValignLayout(host, cfg, true, 'retry'); } catch (e) { /* ignore */ }
        if (last) clearValignRetries(host);         // 最后一拍：成没成都不再排
      }, VALIGN_RETRY_DELAYS[i]));
    } catch (e) { /* 排不上就算了，还有后面的拍 */ }
  }
  return st.timers.length;
}

/** 撤掉还排着的首次补拍 */
function clearValignRetries(host) {
  const st = host && host.__bmValignRetry;
  if (!st) return 0;
  host.__bmValignRetry = null;
  for (let i = 0; i < st.timers.length; i++) {
    try { clearTimeout(st.timers[i]); } catch (e) { /* ignore */ }
  }
  st.timers.length = 0;
  return 1;
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
    /* 重写 float 时旧账（含 valign 的 margin-top）已整体还原，这里补写回去；
     * 不补的话，设置页把开关关一次再开，图就永远停在 bottom 档。 */
    if (typeof applyValignLayout === 'function') applyValignLayout(host, host.__bmCfg, false, 'reapply');
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
  measureLineHeight,
  measureReaderLineHeight,
  measureTitleCenter,
  applyValignLayout,
  valignProbe,
  rootNodeCount,
  ensureValignObserver,
  disconnectValignObserver,
  pruneValignObservers,
  scheduleValignRetries,
  clearValignRetries,
  VALIGN_RETRY_DELAYS,
};
