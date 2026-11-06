'use strict';

/* 渲染后自校准（v0.4.0）+ 两阶段挂载 + 折行诊断 */

const { OPT } = require('./opt');
const { createDomMeasure, readLiveFont } = require('./measure');
const { buildSvg } = require('./svg');
const { resolveMathWidths } = require('./math');

/* ============================================================
 * 渲染后自校准（v0.4.0）
 *
 * 布局里所有列宽、方框宽、括号位置都由「文字宽度」推出来，误差按字符数累积。
 * canvas 的 measureText 不受 letter-spacing 影响，SVG <text> 的真实渲染却受它
 * 影响（主题 / CSS snippet / 字体替换都可能引入这种差异），于是长标签最先破框。
 *
 * 做法：插入 DOM 后用元素自己的 getComputedTextLength() 复测一遍，偏差超过
 * CALIB_TOLERANCE 就按实测宽度重排。取不到宽度（宿主不可见、字体未就绪）就
 * 放弃本次校准、保留上一轮布局；任何异常静默降级，不白屏。
 * ============================================================ */

const CALIB_TOLERANCE = 0.5;   // px，任一节点偏差超过它就重排

/**
 * 重排轮数上限。
 *
 * 为什么允许第二轮：第一轮拿到的实测宽度对应的是「旧折行」。重排会把每行切得
 * 更碎，最宽行反而变窄，量的口径和刚生成的布局对不上；估算字号本身就不对时
 * （见 measure.js 里 measureContext 的注释），第二轮还要连字号、行高一起换掉，
 * 一轮收敛不了是常态。第二轮用重排后的真实宽度再校一次；上限 2 轮是为了不来回抖，
 * 而且每轮只在「偏差确实变小」时才继续（见 calibrateSvg 里的 nw < worst 判断）。
 */
const MAX_REBUILDS = 2;

/**
 * 一个 text 元素的「最宽行宽」。
 *
 * 单行直接用 getComputedTextLength()。多行（子 tspan 带 dy）不能直接用它：
 * 对含多个 tspan 的 text，它返回的是所有字符横向推进宽度的总和，不是最宽行。
 * 所以按行 tspan 逐个量、取最大值。
 *
 * 结构说明（svgMarkup 里多行分支的实际产物）：每个行 tspan 都带 dy，首行 dy="0"、
 * 后续行 dy=lineH；样式 tspan（fill / font-weight）嵌在行 tspan 里面，不在 <text>
 * 下面平铺。所以「直接子元素里带 dy 的那些」正好就是行，量它们不会重复累加。
 */
function measureWidestLine(el) {
  const kids = el && el.children;
  const rows = [];
  if (kids && kids.length) {
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      // localName 与 tagName 在 SVG 命名空间里都是小写 tspan；两个都比一次，
      // 免得某个宿主把 tagName 大写成 TSPAN 时 rows 变空、退化成整行累加。
      if (!k || !k.hasAttribute || !k.hasAttribute('dy')) continue;
      const name = String(k.localName || k.tagName || '').toLowerCase();
      if (name === 'tspan') rows.push(k);
    }
  }
  if (rows.length <= 1) return el.getComputedTextLength();

  let widest = 0;
  for (let i = 0; i < rows.length; i++) {
    let w = 0;
    try { w = rows[i].getComputedTextLength(); } catch (e) { w = 0; }
    if (Number.isFinite(w) && w > widest) widest = w;
  }
  return widest;
}

/** 读回每个 data-seq 对应的实测文字宽度（多行取最宽行） */
function readActualWidths(svg) {
  const widths = new Map();
  let max = 0;
  if (!svg || typeof svg.querySelectorAll !== 'function') return { widths, max, count: 0 };
  const els = svg.querySelectorAll('text[data-seq]');
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    /*
     * 含公式的节点不参与校准：公式的宽度来自 MathJax 的矢量尺度，不在 text 的
     * 字符推进里（它是旁边的 <g>），getComputedTextLength() 量到的只是文字部分。
     * 拿它去比估算值只会得出一份假偏差，把好好的布局当成错的去重排。
     * 这些节点在 svg.js 里带了 data-math="1"。
     */
    if (typeof el.hasAttribute === 'function' && el.hasAttribute('data-math')) continue;
    const seq = parseInt(el.getAttribute('data-seq'), 10);
    if (!Number.isFinite(seq)) continue;
    let len = 0;
    try {
      len = measureWidestLine(el);
    } catch (e) {
      len = 0;
    }
    if (!Number.isFinite(len) || len < 0) len = 0;
    widths.set(seq, len);
    if (len > max) max = len;
  }
  return { widths, max, count: widths.size };
}

/** 实测表与估算表的最大偏差（px）；任一侧缺值就不参与比较 */
function maxDriftOf(widths, est) {
  let worst = 0;
  if (!widths || typeof widths.forEach !== 'function') return worst;
  widths.forEach((w, seq) => {
    const e = est[seq];
    if (!Number.isFinite(e) || !Number.isFinite(w)) return;
    const d = Math.abs(w - e);
    if (d > worst) worst = d;
  });
  return worst;
}

/** 字体就绪后重试一次；返回是否真的挂上了重试 */
function retryAfterFonts(cb) {
  try {
    if (typeof document === 'undefined' || !document.fonts) return false;
    const ready = document.fonts.ready;
    if (!ready || typeof ready.then !== 'function') return false;
    ready.then(cb, () => {});
    return true;
  } catch (e) {
    return false;
  }
}

/** 按实测宽度取宽；序号对不上（如标题）回落到原估算 */
function calibratedMeasure(actual, fallback) {
  const m = (text, seq) => {
    if (Number.isFinite(seq) && actual && typeof actual.get === 'function') {
      const w = actual.get(seq);
      if (Number.isFinite(w) && w > 0) return w;
    }
    return fallback(text);
  };
  // 返回的就是整行实测宽度（含 tspan 里的粗体），按 run 拆分会把同一行重复叠加，
  // 所以打上标记：layoutTree 看到它就只量一次（见 splitRuns 的推导）。
  m.exact = true;
  return m;
}

function parseSvgRoot(markup) {
  const doc = new DOMParser().parseFromString(String(markup), 'image/svg+xml');
  const root = doc && doc.documentElement;
  if (!root || root.localName !== 'svg') return null;
  return root;
}

/**
 * 只换内容与尺寸属性，保留 svg 元素本身：
 * 工具条的导出按钮绑的就是这个元素引用，重建元素会丢事件。
 */
function replaceSvgContent(svg, root) {
  const next = document.importNode(root, true);
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const attrs = next.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i];
    if (/^xmlns(:\w+)?$/.test(a.name)) continue;   // 命名空间声明沿用原元素
    svg.setAttribute(a.name, a.value);
  }
  while (next.firstChild) svg.appendChild(next.firstChild);
}

/** 默认落地动作：解析 markup → 换掉 svg 的内容。返回是否成功 */
function placeMarkup(svg, built) {
  try {
    const root = parseSvgRoot(built.markup);
    if (!root) return false;
    replaceSvgContent(svg, root);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 自校准。opts:
 *   estWidths  上一轮布局的估算宽度，按 seq 索引
 *   isStale()  选填：本次调用是否已经过期（调用方已经落地过新一轮布局）。
 *              fonts.ready 这类异步重试会脱离原调用栈活下去，如果不作废，
 *              它会拿第一轮的估算表去重排一个已经按实测改过的 DOM，
 *              把好的结果盖回错的。详见 mountBraceSvg 里的 gen。
 *   rebuild(actualWidths, 旧估算表) → built，返回新的 buildSvg 结果。
 *              如果返回对象上带 estWidths（这一轮的估算表），会用它继续比第二轮。
 *   onApplied(built)      每轮落地后的回调（选填）
 *   readActual / waitFonts / apply 测试注入点（选填）
 *
 * 返回值：true = 宽度已确认（无需重排，或已按实测重排完）
 *         false = 本次量不到（宿主不可见 / 字体未就绪），调用方可以等可见后再来一次
 */
function calibrateSvg(svg, opts) {
  const o = opts || {};
  const readActual = typeof o.readActual === 'function' ? o.readActual : readActualWidths;
  const waitFonts = typeof o.waitFonts === 'function' ? o.waitFonts : retryAfterFonts;
  const place = typeof o.apply === 'function'
    ? o.apply
    : (built) => placeMarkup(svg, built);
  const isStale = typeof o.isStale === 'function' ? o.isStale : null;

  let est = Array.isArray(o.estWidths) ? o.estWidths : [];
  let retried = false;
  let rebuilds = 0;

  const readOnce = () => {
    try {
      return readActual(svg);
    } catch (e) {
      return null;
    }
  };

  const attempt = () => {
    // 过期的重试直接收工（返回 true = 不必再等）
    if (isStale && isStale()) return true;
    let actual = readOnce();
    if (!actual || !actual.count) return false;

    // 全为 0：宿主不可见或字体未就绪。先等字体，等不到就交给调用方等可见。
    if (!(actual.max > 0)) {
      if (retried) return false;
      retried = true;                          // 先置位，避免回调同步触发时递归
      waitFonts(attempt);
      return false;
    }

    let worst = maxDriftOf(actual.widths, est);
    if (!(worst > CALIB_TOLERANCE)) return true;   // 估算 == 实测，不必重排

    while (rebuilds < MAX_REBUILDS && worst > CALIB_TOLERANCE) {
      let built = null;
      try {
        built = o.rebuild(actual.widths, est);
      } catch (e) {
        return false;                          // 重排失败：保留上一轮布局
      }
      if (!built || !built.markup) return false;
      try {
        if (place(built) === false) return false;
      } catch (e) {
        return false;
      }
      rebuilds++;
      if (typeof o.onApplied === 'function') o.onApplied(built);

      // 下一轮用这一轮自己的估算表：没有就没法比，收工
      if (!Array.isArray(built.estWidths)) break;
      est = built.estWidths;

      const next = readOnce();
      if (!next || !next.count || !(next.max > 0)) break;
      const drift = maxDriftOf(next.widths, est);
      if (!(drift > CALIB_TOLERANCE)) break;   // 收敛了
      if (!(drift < worst)) break;             // 没变好就停，避免两轮来回抖
      actual = next;
      worst = drift;
    }
    return true;
  };

  try {
    return attempt() === true;
  } catch (e) {
    return false;
  }
}

/**
 * 两阶段渲染 + 自校准，返回 { svg, built, estWidths }。
 *   阶段一：canvas 估算 → buildSvg → 插入 DOM（宿主不可见时也有合理布局）
 *   阶段二：插入后按元素自身实测宽度重排（见 calibrateSvg）
 */
function mountBraceSvg(container, cfg, opts) {
  const o = opts || {};
  const fontSize = o.fontSize || OPT.baseFont;
  const fontFamily = o.fontFamily || 'sans-serif';
  const lineH = o.lineH || Math.round(fontSize * OPT.lineHRatio);
  const rowGap = o.rowGap == null ? Math.round(lineH * OPT.rowGapRatio) : o.rowGap;
  const estWidths = [];

  // 用户设的折行上限（cfg 里带过来），重排时会按实测/估算比例修正。
  // 估算偏小时，按原值折行会让每行塞进过多字，落在画布上就超框。
  const baseMaxWidth = Number.isFinite(o.maxWidth)
    ? o.maxWidth
    : (Number.isFinite(cfg && cfg.maxWidth) ? cfg.maxWidth : 0);

  /**
   * 用指定字体排一版。font 为空时用挂载时的口径（阶段一）。
   * 重排一律传 svg 此刻真实的 computed 字体：挂载时量到的可能是在离屏宿主上
   * 读不到、退回 14px 的假值，而这一段跑起来时 svg 已经在文档里了。
   */
  const buildWith = (actual, maxWidthOverride, font) => {
    const fSize = font ? font.fontSize : fontSize;
    const fFamily = font ? (font.fontFamily || fontFamily) : fontFamily;
    // 字号变了，公式的像素宽度也得跟着重算（公式宽 = widthEm × 字号）
    resolveMathWidths(cfg, fSize);
    // 行高、行间距、方框内留白都跟着字号走：字号换了不重算，多行 tspan 的 dy
    // 还是旧字号的一半，重排出来行会叠在一起。
    const fLineH = o.lineH || Math.round(fSize * OPT.lineHRatio);
    const fRowGap = o.rowGap == null ? Math.round(fLineH * OPT.rowGapRatio) : o.rowGap;
    const estThis = actual ? [] : estWidths;
    const fallback = createDomMeasure(fFamily, fSize, 400, container);
    const boldFallback = createDomMeasure(fFamily, fSize, 600, container);
    try {
      const built = buildSvg(cfg, {
        measure: actual ? calibratedMeasure(actual, fallback) : fallback,
        // 实测宽度已是整行真值（含 tspan 里的粗体），不能再拆 run 累加；
        // 估算阶段才按 run 分段量，并把整行总宽写到同序号上给下一轮比对。
        splitRuns: !actual,
        // 每一轮都记账：第二轮要有自己的估算表才能判断是否收敛
        onWidth: (w, seq) => { estThis[seq] = w; },
        measureBold: boldFallback,   // 粗体 run 的 600 字重测量器
        measureTitle: fallback,      // 标题不进校准：它没有 seq，只影响画布宽度
        fontSize: fSize,
        fontFamily: fFamily,
        lineH: fLineH,
        rowGap: fRowGap,
        colGap: o.colGap,
        braceWidth: o.braceWidth,
        // 不传（undefined）时 buildSvg 回落 cfg.maxWidth
        maxWidth: maxWidthOverride,
      });
      built.estWidths = estThis;
      return built;
    } finally {
      if (fallback.dispose) fallback.dispose();
      if (boldFallback.dispose) boldFallback.dispose();
    }
  };

  const first = buildWith(null);
  const root = parseSvgRoot(first.markup);
  if (!root) {
    throw new Error('SVG 生成失败：' + String(first.markup && first.markup.slice(0, 40)));
  }
  const svg = document.importNode(root, true);
  container.appendChild(svg);

  let finalBuilt = first;

  // 诊断命令要读的那点上下文：布局用的字号/字族、折行上限、估算表、重排轮数。
  // 挂在 svg 元素自己身上，命令遍历 .brace-map-svg 就能拿到。
  const meta = {
    estWidths: first.estWidths,
    fontSize,
    fontFamily,
    maxWidth: baseMaxWidth,
    rebuilds: 0,
    settled: false,
    math: o.math || null,
  };
  svg.__braceMapMeta = meta;

  // svg 现在真实用的字体（宿主已可见时才是真值）
  const liveFont = () => readLiveFont(svg);

  // 估算与实测的全局比例。canvas 量不到主题字体真字宽时，估算会系统偏小，
  // 重排时连折行上限一起放大，否则方框按实测变宽了，每行却仍是按偏小的
  // 估算切的，行宽会明显超过用户设的上限。
  const ratioFrom = (actual, estTable) => {
    const table = Array.isArray(estTable) ? estTable : estWidths;
    let sum = 0;
    let n = 0;
    try {
      actual.forEach((w, seq) => {
        const e = table[seq];
        if (Number.isFinite(e) && e > 0 && Number.isFinite(w) && w > 0) {
          sum += w / e;
          n++;
        }
      });
    } catch (err) { /* 没有 forEach 就按 1 算 */ }
    const r = n > 0 ? sum / n : 1;
    return Number.isFinite(r) && r > 0 ? r : 1;
  };

  /*
   * 落地代数：每成功换一次布局就 +1。
   * calibrateSvg 内部的 fonts.ready 重试是异步的，本调用返回之后它还会再跑，
   * 而它手里的 est 表还是当时那一轮的。如果它在新布局落地后拿到执行机，
   * 就会用「旧的估算」去比「新的实测」，再把图重排回错的样子——
   * 用户看到的就是「改了代码、现象一点没变」。所以每次开一轮校准就锁下当前代数，
   * 代数一变就作废。
   */
  let gen = 0;

  const calibOpts = () => {
    const myGen = gen;
    return {
      estWidths: meta.estWidths,
      isStale: () => gen !== myGen,
      rebuild: (actual, estTable) => {
        const r = ratioFrom(actual, estTable);   // 实测 / 估算，>1 表示估算偏小
        // 估算偏小时，同一个 maxWidth 会塞进更多字，渲染时行宽才胀出来。
        // 所以要按比例「收窄」折行上限，而不是放大。5% 以内不动：那是行末空格、
        // 字距取整这类正常口径差，为它重排一次反而会让折行位置跳。
        const mw = (baseMaxWidth > 0 && (r > 1.05 || r < 0.95))
          ? baseMaxWidth / r
          : baseMaxWidth;
        return buildWith(actual, mw > 0 ? mw : undefined, liveFont());
      },
      onApplied: (built) => {
        finalBuilt = built;
        gen++;
        meta.rebuilds++;
        if (Array.isArray(built.estWidths)) meta.estWidths = built.estWidths;
        const font = liveFont();
        if (font) {
          meta.fontSize = font.fontSize;
          meta.fontFamily = font.fontFamily;
        }
      },
    };
  };

  let done = false;
  const settleOnce = () => {
    if (done) return true;
    let ok = false;
    try { ok = calibrateSvg(svg, calibOpts()); } catch (e) { ok = false; }
    if (ok) {
      done = true;
      meta.settled = true;
    }
    return ok;
  };

  let fontFixed = false;

  /*
   * 字号校验必须独立于校准结果，无条件挂在「可见之后」。
   *
   * 离屏时期最大的坑：宿主还没进文档时 getComputedStyle 读不出字号，阶段一按
   * 14px 兜底排；而同一时刻 getComputedTextLength() 是能返回非零值的（SVG 就
   * 按 14px 在画），两边都是 14，校准会判定「没偏差、已收敛」，于是不挂任何
   * 救援。等代码块真正显示出来，SVG 按真实字号（如 19.95px）渲染，布局却还
   * 停在 14px 那一版：每行塞了太多字，撑破方框、左边被裁。
   *
   * 所以不看校准结果，只要发现 svg 此刻的真实字号跟布局用的字号对不上，
   * 就按真实字号整体重排一遍。
   */
  const ensureFont = () => {
    if (fontFixed) return;
    const live = liveFont();
    if (!live) return;
    if (Math.abs(live.fontSize - meta.fontSize) < 0.5) {
      fontFixed = true;                    // 字号本来就对，不必动
      return;
    }
    try {
      const built = buildWith(null, baseMaxWidth > 0 ? baseMaxWidth : undefined, live);
      const root = parseSvgRoot(built.markup);
      if (!root) return;
      replaceSvgContent(svg, root);
      finalBuilt = built;
      meta.estWidths = built.estWidths;
      meta.fontSize = live.fontSize;
      meta.fontFamily = live.fontFamily;
      meta.rebuilds++;
      gen++;
      fontFixed = true;
      done = false;                        // 字号换了，宽度得重新校准一轮
    } catch (e) {
      /* 失败就维持现状，不白屏 */
    }
  };

  const settledFirst = settleOnce();

  const tick = () => {
    if (done && fontFixed) return;
    ensureFont();
    if (!done) settleOnce();
  };

  /*
   * 四条路彼此独立，谁先到算谁的（done 且 fontFixed 之后就是空转）：
   *   1) 定时器：最可靠，不依赖帧、不依赖 IntersectionObserver 的投递
   *   2) 下一帧：容器刚插进文档时最快的一条
   *   3) 字体就绪：主题字体加载完那一拍
   *   4) IntersectionObserver：真正滚进视口
   * 离屏容器上 observe 的初始条目、「插进文档但没触发新帧」、「插进去时恰好被
   * 折叠」都可能让回调一次都不来，所以不能只靠 IO。
   */
  try { setTimeout(tick, 0); } catch (e) { /* 没有定时器就算了 */ }
  try { setTimeout(tick, 60); } catch (e) { /* 同上 */ }
  try { setTimeout(tick, 250); } catch (e) { /* 同上 */ }
  try { setTimeout(tick, 1000); } catch (e) { /* 同上 */ }
  try {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tick);
  } catch (e) { /* 没有 rAF */ }
  retryAfterFonts(tick);

  if (typeof IntersectionObserver !== 'undefined') {
    try {
      const io = new IntersectionObserver((entries) => {
        let visible = false;
        for (const en of entries) if (en.isIntersecting) visible = true;
        if (!visible) return;
        io.disconnect();
        if (!svg.isConnected) return;
        tick();
      }, { rootMargin: '300px' });
      io.observe(container);
    } catch (e) {
      /* 没有 IntersectionObserver 就靠上面那几条 */
    }
  }

  // settledFirst 只影响要不要立即结束：没收敛的图，上面四条路会继续试
  void settledFirst;

  return { svg, built: finalBuilt, estWidths: meta.estWidths };
}

/* ============================================================
 * 折行诊断：把每个 text 的「估算 / 实测 / 框宽」摆到一张表里
 * ============================================================ */

const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);

/** 收集一个 svg 里每个 text 的折行实测数据（只在真实 DOM 里跑） */
function collectWrapDiagnosis(svg, meta) {
  const items = [];
  if (!svg || typeof svg.querySelectorAll !== 'function') return items;
  const est = (meta && Array.isArray(meta.estWidths)) ? meta.estWidths : [];
  const texts = svg.querySelectorAll('text[data-seq]');
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    const seq = parseInt(t.getAttribute('data-seq'), 10);

    const lineLens = [];
    const kids = t.children || [];
    for (let k = 0; k < kids.length; k++) {
      const c = kids[k];
      if (!c || !c.hasAttribute || !c.hasAttribute('dy')) continue;
      let len = 0;
      try { len = c.getComputedTextLength(); } catch (e) { len = 0; }
      lineLens.push(Number.isFinite(len) ? len : 0);
    }
    if (!lineLens.length) {
      let len = 0;
      try { len = t.getComputedTextLength(); } catch (e) { len = 0; }
      lineLens.push(Number.isFinite(len) ? len : 0);
    }

    // 框：svgMarkup 把 rect 紧挨着自己的 text 之前输出，取前一个兄弟
    let rectWidth = null;
    const prev = t.previousElementSibling;
    if (prev) {
      const name = String(prev.localName || prev.tagName || '').toLowerCase();
      if (name === 'rect') {
        const w = Number(prev.getAttribute('width'));
        if (Number.isFinite(w)) rectWidth = w;
      }
    }

    let cls = '';
    try { cls = String(t.getAttribute('class') || ''); } catch (e) { cls = ''; }
    items.push({
      seq: Number.isFinite(seq) ? seq : -1,
      text: String(t.textContent == null ? '' : t.textContent),
      lineLens,
      rectWidth,
      est: Number.isFinite(est[seq]) ? est[seq] : null,
      isTitle: cls.indexOf('bm-title') >= 0,
    });
  }
  return items;
}

/** 诊断报告正文（纯字符串，无 DOM 依赖，方便单测） */
function formatWrapDiagnosis(items, meta, extra) {
  const m = meta || {};
  const e = extra || {};
  const list = Array.isArray(items) ? items : [];
  const lines = [];

  lines.push('# Brace Map 折行诊断');
  lines.push('');
  lines.push('- 时间：' + new Date().toISOString());
  if (e.where) lines.push('- 位置：' + e.where);
  lines.push('- 布局字号：' + (Number.isFinite(m.fontSize) ? round2(m.fontSize) + 'px' : '(未知)')
    + '，字族：' + (m.fontFamily || '(未知)'));
  if (Number.isFinite(e.liveFontSize)) {
    lines.push('- 实际渲染字号：' + round2(e.liveFontSize) + 'px'
      + (Number.isFinite(m.fontSize) && Math.abs(e.liveFontSize - m.fontSize) > 0.5
        ? '  ← 与布局字号不一致，折行是按错的字号算的' : '（与布局字号一致）'));
  }
  if (e.liveFontFamily) lines.push('- 实际渲染字族：' + e.liveFontFamily);
  lines.push('- maxWidth：' + (Number.isFinite(m.maxWidth) && m.maxWidth > 0
    ? round2(m.maxWidth) + 'px' : '(不折行)'));
  lines.push('- 校准重排次数：' + (Number.isFinite(m.rebuilds) ? m.rebuilds : 0)
    + '，校准状态：' + (m.settled ? '已完成' : '未完成（宿主不可见？）'));
  if (e.mathStatus) lines.push('- ' + e.mathStatus);
  lines.push('- text 数量：' + list.length);
  lines.push('');

  // 方框内左右留白：layoutTree 就是按这个公式从字号缩放出来的
  const padX = Number.isFinite(m.boxPadX)
    ? m.boxPadX
    : Math.round(OPT.boxPadX * ((Number.isFinite(m.fontSize) ? m.fontSize : OPT.baseFont) / OPT.baseFont));

  for (const it of list) {
    const lens = Array.isArray(it.lineLens) ? it.lineLens : [];
    const widest = lens.length ? Math.max.apply(null, lens) : 0;
    const estW = Number.isFinite(it.est) ? it.est : null;
    lines.push('## seq ' + it.seq + (it.isTitle ? '（标题）' : ''));
    lines.push('- 文字：' + (it.text || '(空)'));
    lines.push('- 行数：' + lens.length);
    lines.push('- 每行实测宽度：' + lens.map((v) => round2(v)).join(' / '));
    lines.push('- 最宽行：' + round2(widest));
    lines.push('- 估算（estWidths[seq]）：' + (estW == null ? '(无)' : round2(estW))
      + (estW && estW > 0 ? '，实测/估算 = ' + round2(widest / estW) : ''));
    if (it.rectWidth == null) {
      lines.push('- 方框宽：无框');
    } else {
      const need = widest + 2 * padX;
      lines.push('- 方框宽：' + round2(it.rectWidth)
        + '，需要（最宽行 + 2×boxPadX=' + round2(padX) + '）：' + round2(need));
      lines.push('- 判定：' + (it.rectWidth + 0.01 >= need
        ? 'OK'
        : '撑破方框 ' + round2(need - it.rectWidth) + 'px'));
    }
    lines.push('');
  }

  if (!list.length) {
    lines.push('（页面上没找到 .brace-map-svg 里的 text）');
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = {
  CALIB_TOLERANCE,
  MAX_REBUILDS,
  readActualWidths,
  measureWidestLine,
  calibratedMeasure,
  replaceSvgContent,
  calibrateSvg,
  mountBraceSvg,
  collectWrapDiagnosis,
  formatWrapDiagnosis,
};
