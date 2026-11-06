'use strict';

/* ============================================================
 * LaTeX 公式：MathJax 探测 / 批量转换 / 内嵌矢量 SVG / 优雅降级
 *
 * 为什么是「先批量转换，再同步布局」：
 * MathJax 3 的 tex2svgPromise 是异步的，而 layoutTree 全程同步。做法是渲染入口
 * 先把整棵树里的公式扫一遍，Promise.all 批量转换，把每个 run 的尺寸（em）与矢量
 * 内容挂回 run 上；之后布局照旧同步跑，公式宽度直接取 widthEm × fontSize。
 *
 * 降级：探测不到 MathJax、转换抛错、结果里没有 <svg>（CHTML 输出只到这里）时，
 * 把这个公式的 run.math 摘掉——它立刻变回一段普通文字 $...$，后面的测量、折行、
 * 渲染、导出全都不需要额外分支。降级只影响出错的那几个公式，同一张图里其他的
 * 照常走。
 *
 * 导出安全：MathJax 的输出可能带 <defs> 与 <use xlink:href="#id">。这里做两件事：
 *   1) 有 DOM 时把 <use> 就地展开成被引用元素的副本（引用断不掉）；
 *   2) 无论如何都给 id 加一层按公式唯一的命名空间前缀——同一个 tex 会被复用，
 *      直接复制会出现重复 id，克隆/转 canvas 时 <use> 可能指到别人的目标上。
 * 展开失败（没有 DOM）也不致命：目标与引用在同一棵内嵌子树里，克隆时整棵带走。
 * ============================================================ */

const { NS, OPT } = require('./opt');
const { num } = require('./util');
const { esc } = require('./text');

/* MathJax 的 SVG 输出以 em 为单位：1em = 1000 单位；width/height 常写成 ex，
   换算比例取 MathJax 自己的 x-height（0.442em）。两者都从 viewBox 反推校验。 */
const UNITS_PER_EM = 1000;
const EX_PER_EM = 0.442;
const XLINK_NS = 'http://www.w3.org/1999/xlink';

// console.warn 只喊一次，别每个公式刷一行
const WARNED = Object.create(null);

function warnOnce(key, message) {
  if (WARNED[key]) return;
  WARNED[key] = true;
  try {
    console.warn('[brace-map] ' + message);
  } catch (e) { /* 没有控制台也不影响渲染 */ }
}

/** 最近一次 prepareMath 的结果（诊断命令用） */
let LAST_STATUS = null;

function lastMathStatus() {
  return LAST_STATUS;
}

/* ============================================================
 * run 判定
 * ============================================================ */

function isMathTex(r) {
  return !!(r && r.math && String(r.math).length);
}

/** 已转换好的公式 run（有 em 宽度），才会参与布局与渲染 */
function isReadyMath(r) {
  return !!(r && r.math && Number.isFinite(r.mathWidth) && typeof r.mathMarkup === 'string');
}

function hasMathIn(runs) {
  const list = Array.isArray(runs) ? runs : [];
  for (const r of list) if (isReadyMath(r)) return true;
  return false;
}

/** 节点里最高的公式（px）：节点高度不能用 1.2em 的常规字高装一个分式 */
function maxMathHeight(runs) {
  const list = Array.isArray(runs) ? runs : [];
  let h = 0;
  for (const r of list) {
    if (!isReadyMath(r)) continue;
    if (Number.isFinite(r.mathHeight) && r.mathHeight > h) h = r.mathHeight;
  }
  return h;
}

/** 单行节点看 runs，多行节点看每一行的 pieces */
function nodeHasMath(n) {
  if (!n) return false;
  if (hasMathIn(n.runs)) return true;
  const lines = n.textLines;
  if (Array.isArray(lines)) {
    for (const l of lines) if (l && hasMathIn(l.pieces)) return true;
  }
  return false;
}

/** 整张图里的公式 run（按出现顺序），已降级的不算 */
function collectMathRuns(cfg) {
  const out = [];
  const walk = (list) => {
    for (const n of list || []) {
      for (const r of n.runs || []) if (isMathTex(r)) out.push(r);
      if (n.children && n.children.length) walk(n.children);
    }
  };
  walk(cfg && cfg.roots);
  return out;
}

/* ============================================================
 * MathJax 探测
 *
 * Obsidian 内置 MathJax 的暴露方式随版本变化，所以多形态试：
 *   window.MathJax                      ← 正常形态（v2/v3 都在这）
 *   window.MathJax.mathjax              ← 有些打包把它塞在子命名空间里
 *   window.MathJax.startup              ← v3 的 startup 组件
 *   window.MathJax.Hub                  ← v2 的 Hub
 * 每个候选上认两种 API：
 *   tex2svgPromise(tex, opts) → Promise<Element>   （MathJax 3，异步）
 *   tex2svg(tex, opts)        → Element | Promise  （MathJax 2 / 3 的同步入口）
 * 都找不到返回 null，调用方降级。
 * ============================================================ */

/*
 * 插件自带的 MathJax（vendor/tex-svg.js，含 SVG 输出组件）。
 *
 * 为什么要自带：Obsidian 内置的那一份只打包了 CHTML 输出（安装包里
 * renderer 写死成 "CHTML"，tex2svg/tex2svgPromise 一个都没有），产出的
 * 是 HTML+CSS 形式的公式，拿不到矢量路径，也就无法内嵌进括号图、更没法
 * 导出成位图。所以走自带的一份，输出的是真 SVG。
 *
 * 懒加载：第一次需要转换时才 require，2MB 的 bundle 不必在插件加载时白跑。
 * vendor 模块自己做了隔离（见 build.js 的 wrapVendor），不会碰
 * window.MathJax，Obsidian 自己的公式排版不受影响。
 */
let ownPromise = null;
let resolveResource = null;

/**
 * 注入「插件内相对路径 → 可加载 URL」的解析器。
 * 由 main.js 在 onload 里传进来，底层是 app.vault.adapter.getResourcePath，
 * 桌面端和移动端都会给出可用的地址。
 */
function setResourceResolver(fn) {
  if (typeof fn === 'function') resolveResource = fn;
}

/** 插入一个 <script>，等它加载完 */
function injectScript(url) {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') { reject(new Error('无 document')); return; }
    const el = document.createElement('script');
    el.src = url;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('脚本加载失败：' + url));
    (document.head || document.documentElement).appendChild(el);
  });
}

/**
 * 装配自带的 MathJax。
 *
 * 为什么不把 bundle 内联进 main.js 直接 require：实测在模块工厂（函数作用域）
 * 里执行时，MathJax 只建出 {version,_,config,loader,startup,options} 这个壳，
 * startup 压根不启动，tex2svgPromise 永远不出现；同一份文件作为顶层 <script>
 * 加载就正常。所以改成动态插入 <script>，让它在顶层上下文跑。
 *
 * 全程不碰 Obsidian 自己的 window.MathJax：加载前存起来并腾空，抓到自建
 * 实例后立刻还回去，两边互不干扰。
 */
async function loadOwnMathJax() {
  if (ownPromise) return ownPromise;

  ownPromise = (async () => {
    const mark = (o) => {
      if (typeof globalThis !== 'undefined') globalThis.__bmMathDiag = o;
    };
    const hasApi = (o) => !!o
      && (typeof o.tex2svgPromise === 'function' || typeof o.tex2svg === 'function');

    const url = resolveResource ? resolveResource('vendor/tex-svg.js') : null;
    if (url) {
      const saved = typeof window !== 'undefined' ? window.MathJax : undefined;
      try {
        if (typeof window !== 'undefined') window.MathJax = undefined;
        await injectScript(url);
        const inst = typeof window !== 'undefined' ? window.MathJax : null;
        mark({ stage: inst ? 'script-ok' : 'script-null', url: String(url).slice(0, 80) });
        return inst;
      } catch (e) {
        mark({ stage: 'script-throw', message: e && e.message ? e.message : String(e) });
      } finally {
        if (typeof window !== 'undefined') window.MathJax = saved;
      }
    }

    // 没有 resolver（比如浏览器预览页）就退回内联模块。
    // 这条路在函数作用域里启动不起来，但至少能让调用方拿到对象自己去轮询。
    try {
      const mod = require('../vendor/tex-svg.js');
      if (hasApi(mod)) {
        mark({ stage: 'inline-ok' });
        return mod;
      }
      mark({ stage: 'inline-no-api', keys: mod ? Object.keys(mod).slice(0, 8) : null });
      return mod || null;
    } catch (e) {
      mark({ stage: 'inline-throw', message: e && e.message ? e.message : String(e) });
      return null;
    }
  })();

  return ownPromise;
}

function findMathJax(win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (!w) return null;

  const roots = [];
  const add = (obj, where) => {
    if (!obj) return;
    if (typeof obj !== 'object' && typeof obj !== 'function') return;
    for (const r of roots) if (r.obj === obj) return;
    roots.push({ obj, where });
  };

  const M = w.MathJax;
  add(M, 'window.MathJax');
  if (M) {
    add(M.mathjax, 'window.MathJax.mathjax');
    add(M.startup, 'window.MathJax.startup');
    add(M.Hub, 'window.MathJax.Hub');
  }

  for (const r of roots) {
    const o = r.obj;
    if (typeof o.tex2svgPromise === 'function') {
      return makeJax(o, 'tex2svgPromise', r.where);
    }
  }
  for (const r of roots) {
    const o = r.obj;
    if (typeof o.tex2svg === 'function') {
      return makeJax(o, 'tex2svg', r.where);
    }
  }
  return null;
}

function makeJax(obj, kind, where) {
  return {
    kind,
    where,
    obj,
    convert(tex, display) {
      const opts = display ? { display: true } : {};
      if (kind === 'tex2svgPromise') return obj.tex2svgPromise(tex, opts);
      return obj.tex2svg(tex, opts);
    },
  };
}

/*
 * 自带的 bundle 是「先建空壳、再异步启动」的：
 * 执行完的那一刻 MathJax 上只有 {version, _, config, loader, startup, options}，
 * tex2svgPromise 要到 startup 跑完才挂上去。而这个时候 startup.promise
 * 本身也还不存在，光靠 await 会直接跳过。所以只能轮询等。
 *
 * 只等第一次：拿到后就缓存在 ownReady 里，后续渲染不再等。
 */
let ownReady = null;

const jaxFromOwn = (own) => {
  if (!own) return null;
  if (typeof own.tex2svgPromise === 'function') {
    return makeJax(own, 'tex2svgPromise', 'vendor/tex-svg.js');
  }
  if (typeof own.tex2svg === 'function') {
    return makeJax(own, 'tex2svg', 'vendor/tex-svg.js');
  }
  return null;
};

async function waitOwnReady(own) {
  if (ownReady) return ownReady;
  let got = jaxFromOwn(own);
  if (got) { ownReady = got; return got; }

  const tick = () => new Promise((r) => {
    try { setTimeout(r, 50); } catch (e) { r(); }
  });

  for (let i = 0; i < 60; i++) {      // 最多等 3 秒
    await tick();
    got = jaxFromOwn(own);
    if (got) { ownReady = got; return got; }
  }
  return null;
}

/**
 * 探测 + 等 v3 的 startup 就位。
 * v3 在 MathJax.startup.promise 解析之后才把 tex2svg / tex2svgPromise 挂到
 * MathJax 对象上，代码块渲染得早时第一眼是看不到的，所以等一拍再探一次。
 */
async function findMathJaxReady(win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (!w) return null;

  // 自带的 bundle 优先：它是唯一能输出矢量的一组
  const own = await loadOwnMathJax();
  if (own) {
    const got = await waitOwnReady(own);
    if (got) return got;
  }

  let jax = findMathJax(w);
  if (jax) return jax;

  const M = w.MathJax;
  const p = M && M.startup && M.startup.promise;
  if (p && typeof p.then === 'function') {
    try { await p; } catch (e) { /* startup 失败：继续按找不到处理 */ }
    jax = findMathJax(w);
    if (jax) return jax;
  }
  return null;
}

/* ============================================================
 * 转换结果 → 可内嵌的矢量
 * ============================================================ */

function toMarkup(res) {
  if (res == null) throw new Error('转换返回空');
  if (typeof res === 'string') return res;
  if (typeof res.outerHTML === 'string') return res.outerHTML;
  if (typeof res.innerHTML === 'string') return res.innerHTML;
  if (typeof XMLSerializer !== 'undefined') {
    try { return new XMLSerializer().serializeToString(res); } catch (e) { /* 继续 */ }
  }
  throw new Error('转换结果无法序列化');
}

function parseAttrs(tag) {
  const out = Object.create(null);
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(String(tag))) !== null) out[m[1]] = m[2];
  return out;
}

function parseLength(v) {
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^(-?[\d.]+)\s*(em|ex|px|pt|%)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return { n, unit: String(m[2] || 'px').toLowerCase() };
}

function viewBoxOf(attrs) {
  const raw = String(attrs.viewBox == null ? '' : attrs.viewBox).trim();
  if (!raw) return null;
  const parts = raw.split(/[\s,]+/).map(Number);
  if (parts.length !== 4) return null;
  if (!parts.every(Number.isFinite)) return null;
  if (!(parts[2] > 0) || !(parts[3] > 0)) return null;
  return { minX: parts[0], minY: parts[1], w: parts[2], h: parts[3] };
}

/* MathJax 也会写 style="vertical-align: -0.566ex;"，viewBox 缺失时用它补深度 */
function depthFromStyle(styleText) {
  const m = String(styleText == null ? '' : styleText)
    .match(/vertical-align\s*:\s*(-?[\d.]+)\s*(ex|em|px)/i);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return NaN;
  const unit = m[2].toLowerCase();
  const depth = Math.max(0, -n);
  if (unit === 'ex') return depth * EX_PER_EM;
  if (unit === 'em') return depth;
  return NaN;
}

/**
 * 从转换结果里取出几何与内部标记。
 * 拿不到 <svg>（典型是 CHTML 输出：mjx-container[jax="CHTML"] 里只有 <mjx-math>）
 * 就直接抛，由调用方把这条公式降级——没有矢量就没法导出，宁可用文字。
 */
function extractMath(raw) {
  const s = String(raw);
  const start = s.search(/<svg[\s>]/i);
  if (start < 0) {
    const chtml = /jax\s*=\s*["']CHTML["']/i.test(s) || /<mjx-container\b/i.test(s);
    throw new Error(chtml
      ? 'MathJax 返回的是 CHTML（没有 <svg>），无法导出为矢量'
      : '转换结果里没有 <svg>');
  }
  const openEnd = s.indexOf('>', start);
  if (openEnd < 0) throw new Error('转换结果的 <svg> 标签不完整');
  const openTag = s.slice(start, openEnd + 1);
  if (/\/>$/.test(openTag)) throw new Error('转换结果的 <svg> 是空壳');
  const close = s.lastIndexOf('</svg>');
  if (close < openEnd) throw new Error('转换结果的 <svg> 没有闭合');

  const attrs = parseAttrs(openTag);
  const vb = viewBoxOf(attrs);
  if (!vb) throw new Error('转换结果的 <svg> 没有可用的 viewBox');

  const wAttr = parseLength(attrs.width);
  let widthEm = NaN;
  if (wAttr && wAttr.unit === 'em') widthEm = wAttr.n;
  else if (wAttr && wAttr.unit === 'ex') widthEm = wAttr.n * EX_PER_EM;
  else if (wAttr && wAttr.unit === 'px') widthEm = wAttr.n / 16;   // MathJax 默认 em = 16px
  if (!(widthEm > 0)) widthEm = vb.w / UNITS_PER_EM;

  // 单位/em 从「viewBox 宽 ÷ em 宽」反推：不锁定 MathJax 的 1000 units/em 约定，
  // v2 的 1000、v3 的 1000、将来改了也照样对。
  const units = vb.w / widthEm;
  const safeUnits = Number.isFinite(units) && units > 0 ? units : UNITS_PER_EM;

  const heightEm = vb.h / safeUnits;
  let depthEm = (vb.minY + vb.h) / safeUnits;
  if (!Number.isFinite(depthEm) || depthEm < 0) {
    const alt = depthFromStyle(attrs.style);
    depthEm = Number.isFinite(alt) ? alt : 0;
  }

  return {
    inner: s.slice(openEnd + 1, close),
    units: safeUnits,
    minX: vb.minX,
    minY: vb.minY,
    widthEm,
    heightEm,
    depthEm,
  };
}

/* ============================================================
 * <defs> / <use> 处理
 * ============================================================ */

/** 给标记里所有 id 加唯一前缀，并把所有 #id 引用跟着改掉（同一 tex 复用时的重复 id 问题） */
function namespaceIds(markup, prefix) {
  const s = String(markup);
  const ids = [];
  const re = /\bid="([^"]+)"/g;
  let m;
  while ((m = re.exec(s)) !== null) if (ids.indexOf(m[1]) < 0) ids.push(m[1]);
  if (!ids.length) return s;

  let out = s;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const safe = prefix + '-' + i;
    out = out.split('href="#' + id + '"').join('href="#' + safe + '"');
    out = out.split("href='#" + id + "'").join("href='#" + safe + "'");
    out = out.split('id="' + id + '"').join('id="' + safe + '"');
  }
  return out;
}

/**
 * 把 <use xlink:href="#id"> 就地展开成被引用元素的副本。
 * 有 DOM 才做（Obsidian / 预览页都有）；没有 DOM 就原样留着——引用目标在
 * 同一棵内嵌子树里，克隆导出时整棵带走，链不会断。
 */
function inlineUses(markup) {
  const info = { uses: 0, inlined: 0, kept: 0 };
  const s = String(markup);
  if (!/<use\b/i.test(s)) return { markup: s, info };

  info.uses = (s.match(/<use\b/gi) || []).length;
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') {
    info.kept = info.uses;
    return { markup: s, info };
  }

  try {
    const doc = new DOMParser().parseFromString(
      '<svg xmlns="' + NS + '" xmlns:xlink="' + XLINK_NS + '">' + s + '</svg>',
      'image/svg+xml'
    );
    const root = doc && doc.documentElement;
    if (!root || typeof root.getElementsByTagName !== 'function') {
      info.kept = info.uses;
      return { markup: s, info };
    }
    if (root.getElementsByTagName('parsererror').length) {
      info.kept = info.uses;
      return { markup: s, info };
    }

    // 多跑几轮：展开放进去的元素里可能还嵌着 <use>
    const lookup = (id) => {
      let t = null;
      try { t = doc.getElementById(id); } catch (e) { t = null; }
      if (!t && root.querySelector) {
        try { t = root.querySelector('[id="' + id + '"]'); } catch (e) { t = null; }
      }
      if (!t) {
        /*
         * 全局字体缓存（fontCache: 'global'）：字形路径挂在本公式之外的一个
         * <svg id="MJX-SVG-global-cache"> 里，<use> 指向它。克隆、转 canvas 时
         * 这个引用一定会断，所以把它从文档里拽回来，副本内联进本公式。
         */
        try {
          const host = typeof document !== 'undefined' ? document : null;
          const g = host && typeof host.getElementById === 'function' ? host.getElementById(id) : null;
          if (g) t = doc.importNode(g, true);
        } catch (e) { t = null; }
      }
      return t;
    };

    for (let round = 0; round < 4; round++) {
      const live = root.getElementsByTagName('use');
      if (!live.length) break;
      const list = [];
      for (let i = 0; i < live.length; i++) list.push(live[i]);
      let done = 0;
      for (const u of list) {
        const href = u.getAttribute('href')
          || u.getAttribute('xlink:href')
          || u.getAttributeNS(XLINK_NS, 'href')
          || '';
        const id = href.charAt(0) === '#' ? href.slice(1) : '';
        const target = id ? lookup(id) : null;
        if (!target) continue;

        const g = doc.createElementNS(NS, 'g');
        const parts = [];
        const x = u.getAttribute('x');
        const y = u.getAttribute('y');
        if (x != null || y != null) parts.push('translate(' + (x || '0') + ',' + (y || '0') + ')');
        const tr = u.getAttribute('transform');
        if (tr) parts.push(tr);
        if (parts.length) g.setAttribute('transform', parts.join(' '));

        const copy = target.cloneNode(true);
        copy.removeAttribute('id');
        g.appendChild(copy);
        if (u.parentNode) {
          u.parentNode.replaceChild(g, u);
          done++;
        }
      }
      info.inlined += done;
      if (!done) break;
    }

    const out = new XMLSerializer().serializeToString(root);
    const a = out.indexOf('>');
    const b = out.lastIndexOf('</svg>');
    if (a < 0 || b <= a) {
      info.kept = info.uses;
      return { markup: s, info };
    }
    // 外层 svg 自己会声明 xmlns / xmlns:xlink，内层这份重复声明是噪音
    const inner = out.slice(a + 1, b).replace(/\sxmlns:xlink="[^"]*"/g, '');
    info.kept = (inner.match(/<use\b/gi) || []).length;
    return { markup: inner, info };
  } catch (e) {
    info.kept = info.uses;
    return { markup: s, info };
  }
}

/* ============================================================
 * 转换一条公式
 * ============================================================ */

async function convertOne(jax, tex, display, tag) {
  const called = jax.convert(tex, display);
  const res = called && typeof called.then === 'function' ? await called : called;
  const raw = toMarkup(res);
  const geo = extractMath(raw);
  const inlined = inlineUses(geo.inner);
  return {
    markup: namespaceIds(inlined.markup, tag),
    uses: inlined.info,
    units: geo.units,
    minX: geo.minX,
    minY: geo.minY,
    widthEm: geo.widthEm,
    heightEm: geo.heightEm,
    depthEm: geo.depthEm,
  };
}

/** 把转换结果挂到 run 上；同一个 tex 被多个节点复用时共享同一份标记 */
function applyEntry(run, entry, fontSize) {
  run.mathMarkup = entry.markup;
  run.mathUnits = entry.units;
  run.mathMinX = entry.minX;
  run.mathMinY = entry.minY;
  run.mathWidthEm = entry.widthEm;
  run.mathHeightEm = entry.heightEm;
  run.mathDepthEm = entry.depthEm;
  run.mathWidth = entry.widthEm * fontSize;
  run.mathHeight = entry.heightEm * fontSize;
  delete run.mathFail;
}

/** 降级：摘掉 math 标记，run 立刻变回一段普通文字（text 里本来就是 $...$） */
function degradeRun(run) {
  if (!run) return;
  delete run.math;
  delete run.display;
  delete run.mathMarkup;
  delete run.mathUnits;
  delete run.mathMinX;
  delete run.mathMinY;
  delete run.mathWidthEm;
  delete run.mathHeightEm;
  delete run.mathDepthEm;
  delete run.mathWidth;
  delete run.mathHeight;
  run.mathFail = true;
}

function degradeAll(runs) {
  for (const r of runs || []) degradeRun(r);
}

/** 字号变了（自校准会换字号）就重算公式的像素宽度 */
function resolveMathWidths(cfg, fontSize) {
  const size = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : OPT.baseFont;
  for (const r of collectMathRuns(cfg)) {
    if (!Number.isFinite(r.mathWidthEm)) continue;
    r.mathWidth = r.mathWidthEm * size;
    r.mathHeight = Number.isFinite(r.mathHeightEm) ? r.mathHeightEm * size : 0;
  }
  return size;
}

/* ============================================================
 * 批量准备：渲染入口在布局之前调用
 *
 * opts.jax      注入转换器（测试用）
 * opts.win      探测窗口（默认全局 window）
 * opts.fontSize 布局字号，用来把 em 宽度换成 px
 * ============================================================ */

async function prepareMath(cfg, opts) {
  const o = opts || {};
  const fontSize = Number.isFinite(o.fontSize) && o.fontSize > 0 ? o.fontSize : OPT.baseFont;
  const runs = collectMathRuns(cfg);

  const status = {
    total: runs.length,
    converted: 0,
    failed: 0,
    engine: '',
    where: '',
    uses: 0,
    reason: runs.length ? '' : 'nomath',
    line: '',
  };

  if (!runs.length) {
    status.line = describeMathStatus(status);
    LAST_STATUS = status;
    return status;
  }

  let jax = null;
  try {
    jax = o.jax || await findMathJaxReady(o.win);
  } catch (e) {
    jax = null;
  }

  if (!jax) {
    degradeAll(runs);
    status.failed = runs.length;
    status.reason = 'notfound';
    status.line = describeMathStatus(status);
    LAST_STATUS = status;
    warnOnce('missing', '找不到 MathJax，公式已降级为纯文本');
    return status;
  }

  status.engine = jax.kind;
  status.where = jax.where || '';

  // 同一个 tex + 同一个 display 只转换一次
  const groups = new Map();
  for (const r of runs) {
    const key = (r.display ? 'D' : 'I') + '\u0000' + r.math;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const keys = Array.from(groups.keys());
  const results = await Promise.all(keys.map((key, i) => {
    const head = groups.get(key)[0];
    const tag = 'bm' + (i + 1);
    return Promise.resolve()
      .then(() => convertOne(jax, head.math, !!head.display, tag))
      .then((entry) => ({ key, entry }), (err) => ({ key, err }));
  }));

  for (const res of results) {
    const list = groups.get(res.key) || [];
    if (res.err || !res.entry) {
      degradeAll(list);
      status.failed += list.length;
      // 每条失败单独喊一次，但同一个原因只刷一行
      warnOnce('fail:' + (res.err && res.err.message ? res.err.message : 'unknown'),
        '公式转换失败，已降级为纯文本：' + (res.err && res.err.message ? res.err.message : '未知原因'));
      continue;
    }
    if (res.entry.uses) status.uses += res.entry.uses.inlined;
    for (const r of list) applyEntry(r, res.entry, fontSize);
    status.converted += list.length;
  }

  if (status.failed && !status.converted) status.reason = 'allfailed';
  else if (status.failed) status.reason = 'partial';
  status.line = describeMathStatus(status);
  LAST_STATUS = status;
  return status;
}

/** 诊断命令里那一行 */
function describeMathStatus(status) {
  const s = status || {};
  if (s.reason === 'nomath') return 'MathJax: 本次没有公式（未探测）';
  if (s.engine && s.converted > 0) {
    let line = 'MathJax: 可用（' + s.engine + '）';
    if (s.failed > 0) line += '，' + s.failed + ' 个公式转换失败已降级为纯文本';
    return line;
  }
  if (s.reason === 'notfound') return 'MathJax: 未找到，公式已降级为纯文本';
  if (s.reason === 'allfailed') return 'MathJax: 找到了但转换全部失败（' + (s.engine || '未知') + '），已降级为纯文本';
  if (s.reason === 'partial') return 'MathJax: 部分公式转换失败，已降级为纯文本';
  return 'MathJax: 不可用，公式已降级为纯文本';
}

/* ============================================================
 * 出图：把一个公式 run 变成一个绝对定位的 <g>
 *
 * 坐标口径：MathJax 的内容坐标以「em」为尺度（1em = units 个单位），
 * 基线在 y = 0 上（viewBox 的 minY 是负的，往下伸出的是 depth）。
 * 所以 scale = fontSize / units，平移让内容左边缘落在 x 上。
 * ============================================================ */

function mathGroupMarkup(run, x, baselineY, fontSize) {
  const units = Number.isFinite(run.mathUnits) && run.mathUnits > 0 ? run.mathUnits : UNITS_PER_EM;
  const k = fontSize / units;
  const minX = Number.isFinite(run.mathMinX) ? run.mathMinX : 0;
  const tx = x - minX * k;

  let attrs = 'class="bm-math" data-tex="' + esc(run.math) + '"';
  // 颜色跟随文字：<font color> 走属性，没写的继承 CSS 里的 --bm-fg
  if (run.color) attrs += ' color="' + esc(run.color) + '"';

  return '<g ' + attrs + ' transform="translate(' + num(tx) + ',' + num(baselineY) + ')'
    + ' scale(' + num(k) + ')">' + (run.mathMarkup || '') + '</g>';
}

module.exports = {
  EX_PER_EM,
  UNITS_PER_EM,
  isMathTex,
  isReadyMath,
  hasMathIn,
  nodeHasMath,
  maxMathHeight,
  collectMathRuns,
  findMathJax,
  findMathJaxReady,
  setResourceResolver,
  extractMath,
  namespaceIds,
  inlineUses,
  convertOne,
  prepareMath,
  resolveMathWidths,
  degradeRun,
  degradeAll,
  describeMathStatus,
  lastMathStatus,
  mathGroupMarkup,
};
