'use strict';

/* ============================================================
 * valign 对齐标记覆盖层（只读取证 · 手动开关）
 *
 * 为什么要有它：轨迹能说清「调用了多少次、从哪个分支走了」，但说不清
 * 「这张图到底该在哪、现在在哪、差多远」。把两个位置直接画在屏幕上，
 * 一张截图就能回答。
 *
 * 画三样（每张图一组）：
 *   红线  宿主当前 rect 的上边缘（现在在哪）
 *   绿线  若此刻真的调用一次 applyValignLayout，图顶会在哪（该在哪）
 *         绿线是虚线时表示「这一次会走 not-ready」，那一行的位置没有参考价值
 *   标签  贴着宿主右上角：序号 / 基准 / 浮动 / 量到的三个数 / 算出的偏移 / 当前 margin
 * 另有右上角一块总览：页面上有几张图、几张在编辑区、几张在阅读区、
 * 以及本次运行里 applyValignLayout 各分支各几次。
 *
 * 硬纪律：
 *   - 只读。不改宿主样式、不加类、不往宿主里插 DOM（全部元素挂在 body 下）
 *   - 不动布局：position: fixed + inset: 0 + pointer-events: none，样式全内联
 *   - 不用定时器：位置靠 requestAnimationFrame 每帧重算（滚动、缩放自动跟上），
 *     测量值（标签文字）借同一个循环按 250ms 节流，不另开 setInterval
 *   - 关掉时 remove() 掉自己创建的全部元素，并解绑 Esc
 *
 * 它不认识 float.js：量什么、怎么算偏移都由调用方传进来（见 show 的 api），
 * 所以这个模块可以脱离布局代码单独测。
 * ============================================================ */

const OVERLAY_ID = 'bm-valign-overlay';
/** 标签文字里那些测量值的重算间隔（借 rAF 计时，不是定时器） */
const MEASURE_GAP_MS = 250;
/** 标记线长度（px） */
const LINE_W = 200;

/** 当前开着的这一份。null = 覆盖层不存在。 */
let state = null;

/* ------------------------------ 小工具 ------------------------------ */

function fmt(v) {
  if (v === null || v === undefined) return '?';
  const n = Number(v);
  if (Number.isNaN(n)) return 'NaN';
  if (!Number.isFinite(n)) return String(n);
  return (Math.round(n * 100) / 100).toFixed(2);
}

function rectOf(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  try {
    const r = el.getBoundingClientRect();
    if (!r || !Number.isFinite(r.top) || !Number.isFinite(r.left)) return null;
    return r;
  } catch (e) { return null; }
}

/** 拆元素：优先 remove()，假 DOM / 老环境退回 parentNode.removeChild */
function removeEl(el) {
  if (!el) return false;
  try {
    if (typeof el.remove === 'function') { el.remove(); return true; }
  } catch (e) { /* 走下去 */ }
  try {
    if (el.parentNode && typeof el.parentNode.removeChild === 'function') {
      el.parentNode.removeChild(el);
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

function classHas(el, name) {
  try {
    return !!(el && el.classList && typeof el.classList.contains === 'function'
      && el.classList.contains(name));
  } catch (e) { return false; }
}

function clampX(x, viewW, width) {
  const max = Math.max(4, viewW - width - 4);
  return Math.max(4, Math.min(x, max));
}

/**
 * 读行内 margin-top 的像素值。
 *
 * 只认 px：主题给的 em / % 读不出来就当 0（不猜），标签里的「当前margin」
 * 会把原文照抄出来，对不上时人能看见。
 */
function pxOf(v) {
  const s = String(v == null ? '' : v).trim();
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(s);
  return m ? Number(m[1]) : 0;
}

/**
 * 宿主此刻在不在编辑区（.cm-content 里）。
 *
 * 跟 float.js 的 inEditorNow 同一套判据：先 closest，没有再逐层往上爬 8 层。
 * 这一步不能省：阅读视图里的宿主也是 connected 的，只查 isConnected 会把它
 * 当成编辑区，画出来的绿线就是在骗人。
 */
function inEditorNow(host) {
  if (!host) return false;
  try {
    if (typeof host.closest === 'function') return !!host.closest('.cm-content');
  } catch (e) { /* 退回逐层爬 */ }
  let cur = host;
  for (let i = 0; cur && i <= 8; i++) {
    if (classHas(cur, 'cm-content')) return true;
    cur = cur.parentElement;
  }
  return false;
}

/* ------------------------------ 判据（只读镜像） ------------------------------ */

/**
 * 假设「此刻就调用一次 applyValignLayout」，它会走哪个分支。
 *
 * 这里只是把函数开头那几个 if 按同样的顺序读一遍，纯读，不改任何东西。
 * 顺序与 float.js 保持一致：float → bm-floated → 在编辑区 → 量到了（两道门）：
 *   1. 图高 0 或根节点 0 个
 *   2. middle 档量不到标题中心
 * 任何一条对不上，覆盖层就把标签第三行换成 `→ <分支>`，提醒「这一行绿线
 * 不是它现在的位置」。
 */
function gateOf(host, probe, floatMode, valign) {
  if (!host || !host.style) return '!host';
  if (floatMode !== 'left' && floatMode !== 'right') return 'float!=lr';
  if (!classHas(host, 'bm-floated')) return '!bm-floated';
  if (host.isConnected === false) return '!inEditor';
  if (!inEditorNow(host)) return '!inEditor';
  if (!(probe.imgH > 0) || !(probe.roots > 0)) return 'not-ready';
  /* 第二扇门：只有 middle 依赖 yTitle（top 只看行高和图高） */
  const raw = probe.yTitle;
  const yT = (raw === null || raw === undefined) ? NaN : Number(raw);
  if (valign === 'middle' && !Number.isFinite(yT)) return 'not-ready';
  return 'ready';
}

/** 宿主的配置：优先它自己记的 __bmCfg，退到诊断记录 / 行内样式 */
function cfgOf(host) {
  const cfg = (host && host.__bmCfg) || null;
  const info = (host && host.__bmValignInfo) || null;
  const valign = (cfg && cfg.valign) || (info && info.valign) || 'bottom';
  let floatMode = (cfg && cfg.float) || '';
  if (!floatMode) {
    try { floatMode = (host && host.style && host.style.float) ? String(host.style.float) : ''; } catch (e) { floatMode = ''; }
  }
  return { valign, float: floatMode || 'none' };
}

/* ------------------------------ 元素 ------------------------------ */

function makeEl(doc, css, text) {
  const el = doc.createElement('div');
  if (css) el.style.cssText = css;
  if (text != null) el.textContent = text;
  return el;
}

/** 复位成一根横线：实线 = 现在的位置，虚线 = 这次算不准的位置 */
function paintLine(el, x, y, color, dashed) {
  el.style.left = (Math.round(x * 100) / 100) + 'px';
  el.style.top = (Math.round(y * 100) / 100) + 'px';
  el.style.width = LINE_W + 'px';
  if (dashed) {
    el.style.height = '0px';
    el.style.background = 'none';
    el.style.borderTop = '2px dashed ' + color;
  } else {
    el.style.height = '2px';
    el.style.background = color;
    el.style.borderTop = '0';
  }
}

function lineCss() {
  return 'position:absolute;left:0;top:0;width:' + LINE_W + 'px;height:2px;margin:0;padding:0;'
    + 'pointer-events:none;';
}

function labelCss(color) {
  return 'position:absolute;left:0;top:0;white-space:pre;font:11px/1.45 ui-monospace,'
    + 'SFMono-Regular,Menlo,Consolas,monospace;color:#f8fafc;background:rgba(15,23,42,0.82);'
    + 'border:1px solid rgba(148,163,184,0.45);border-left:3px solid ' + color + ';'
    + 'border-radius:4px;padding:3px 6px;pointer-events:none;';
}

function panelCss() {
  return 'position:absolute;right:8px;top:8px;white-space:pre;font:11px/1.5 ui-monospace,'
    + 'SFMono-Regular,Menlo,Consolas,monospace;color:#f8fafc;background:rgba(15,23,42,0.88);'
    + 'border:1px solid rgba(148,163,184,0.5);border-radius:6px;padding:6px 9px;'
    + 'pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,0.35);';
}

/* ------------------------------ 文字 ------------------------------ */

function labelText(idx, valign, floatMode, probe, gate, off, margin) {
  const head = '图' + (idx + 1) + '  val=' + (valign || '?') + ' flt=' + (floatMode || '?');
  const nums = 'imgH=' + fmt(probe.imgH) + ' yT=' + fmt(probe.yTitle) + ' lineH=' + fmt(probe.lineH);
  const tail = gate === 'ready'
    ? 'off=' + fmt(off) + '  当前margin=' + (margin ? margin : '空')
    : '→ ' + gate;
  return head + '\n' + nums + '\n' + tail;
}

/** 总览面板的文字：先回答「功能到底有没有跑到」 */
function panelText(info) {
  const rows = info.rows || [];
  const cnt = Object.create(null);
  const order = [];
  for (const r of rows) {
    if (!cnt[r.exit]) { cnt[r.exit] = 0; order.push(r.exit); }
    cnt[r.exit] += 1;
  }
  const tail = order.length ? order.map((k) => k + ' ' + cnt[k]).join(' · ') : '（一次都没调用过）';
  return 'valign 对齐标记   Esc 关闭\n'
    + '宿主 ' + info.total + '　编辑区 ' + info.inEditor + '　阅读区 ' + (info.total - info.inEditor) + '\n'
    + 'float lr ' + info.floatLR + '　其他 ' + (info.total - info.floatLR) + '\n'
    + 'applyValignLayout ' + rows.length + ' 次：' + tail;
}

/* ------------------------------ 渲染一轮 ------------------------------ */

/**
 * 重算一遍：把每个宿主的线放在哪、标签写什么。
 * @param {object} s 当前 state
 * @param {boolean} remeasure true = 连测量值一起重算（标签文字），false = 只挪位置
 */
function renderOnce(s, remeasure) {
  const win = s.win;
  const viewW = (win && Number.isFinite(win.innerWidth)) ? win.innerWidth : 1200;
  const hosts = s.hosts || [];

  for (let i = 0; i < s.items.length; i++) {
    const it = s.items[i];
    const host = it.host;
    const r = rectOf(host);
    if (!r) {
      it.root.style.display = 'none';
      continue;
    }
    it.root.style.display = '';

    /* 红：现在在哪 */
    paintLine(it.lineNow, r.left, r.top, '#e11d48', false);

    /* 绿：该在哪。
     *
     * 注意不能写成「当前顶 + 偏移」：rect.top 里已经含了当前已经生效的
     * margin-top，而写同一个 margin-top 是幂等的（写两次不会移两次）。
     * 所以目标 = 把现有位移减掉（回到未偏移的位置）+ 算出的偏移。
     * 当前 margin 为空时，它就等于「当前顶 + 偏移」。
     *
     * 没准备好 / 走不到这一步时不给目标位置：绿线画成虚线、与红线同位，
     * 因为这时算出来的 0 是「没法算」，不是「不用挪」。
     */
    if (remeasure) {
      const cfg = cfgOf(host);
      let probe = null;
      try { probe = s.api.probe(host) || {}; } catch (e) { probe = {}; }
      let off = 0;
      try {
        off = s.api.offsetOf(probe.lineH, probe.imgH, probe.yTitle, cfg.valign) || 0;
      } catch (e) { off = 0; }
      const gate = gateOf(host, probe, cfg.float, cfg.valign);
      it.off = off;
      it.gate = gate;
      const color = gate === 'ready' ? '#94a3b8' : '#f59e0b';
      it.label.style.cssText = labelCss(color);
      it.label.textContent = labelText(i, cfg.valign, cfg.float, probe, gate, off,
        host.style && host.style.marginTop ? String(host.style.marginTop) : '');
      /* 量一下标签宽度，靠右边缘时好用得上（4 次/秒，不在每帧里） */
      if (it.label.offsetWidth > 0) it.labelW = it.label.offsetWidth;
    }
    const marginPx = pxOf(host.style && host.style.marginTop);
    const targetY = it.gate === 'ready'
      ? (r.top - marginPx + (Number.isFinite(it.off) ? it.off : 0))
      : r.top;
    paintLine(it.lineTarget, r.left, targetY, '#16a34a', it.gate !== 'ready');

    /* 标签贴右上角；贴着窗口右边缘时往左让，免得被裁掉 */
    const lw = it.labelW || 240;
    it.label.style.left = clampX(r.right + 6, viewW, lw) + 'px';
    it.label.style.top = r.top + 'px';
  }

  /* 总览 */
  if (remeasure && s.panel) {
    let inEditor = 0;
    let floatLR = 0;
    for (const host of hosts) {
      try {
        if (host.isConnected !== false && inEditorNow(host)) inEditor += 1;
      } catch (e) { /* ignore */ }
      const cfg = cfgOf(host);
      if (cfg.float === 'left' || cfg.float === 'right') floatLR += 1;
    }
    let rows = [];
    try { rows = s.api.rows() || []; } catch (e) { rows = []; }
    s.panel.textContent = panelText({
      total: hosts.length, inEditor, floatLR, rows,
    });
  }
}

/** 排下一帧 */
function nextFrame(s) {
  const win = s.win;
  if (!win || typeof win.requestAnimationFrame !== 'function') return 0;
  try {
    return win.requestAnimationFrame(() => frame(s));
  } catch (e) { return 0; }
}

function frame(s) {
  if (!state || state !== s) return;
  s.raf = 0;
  const now = Date.now();
  const remeasure = !!(now - s.lastMeasure >= MEASURE_GAP_MS);
  if (remeasure) {
    s.lastMeasure = now;
    /* 新图渲染出来 / 切了笔记：宿主集合变了就把 item 重建一次（4 次/秒，不在每帧里） */
    syncItems(s, hostList(s.doc));
  }
  try { renderOnce(s, remeasure); } catch (e) { /* 一帧画不出来不影响下一帧 */ }
  s.raf = nextFrame(s);
}

/* ------------------------------ 组装 / 拆除 ------------------------------ */

/** 宿主列表（阅读视图和编辑区都在里面） */
function hostList(doc) {
  try {
    const list = doc.querySelectorAll('.block-language-brace') || [];
    const out = [];
    for (let i = 0; i < list.length; i++) out.push(list[i]);
    return out;
  } catch (e) { return []; }
}

/** 按当前宿主列表建/拆 item 元素（宿主集合变了才重建） */
function syncItems(s, hosts) {
  const same = s.hosts.length === hosts.length
    && s.hosts.every((h, i) => h === hosts[i]);
  if (same) return;
  for (const it of s.items) {
    removeEl(it.root);
  }
  s.items = [];
  s.hosts = hosts;
  for (const host of hosts) {
    const root = makeEl(s.doc, 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;');
    const lineNow = makeEl(s.doc, lineCss(), '');
    const lineTarget = makeEl(s.doc, lineCss(), '');
    const label = makeEl(s.doc, labelCss('#94a3b8'), '');
    root.appendChild(lineNow);
    root.appendChild(lineTarget);
    root.appendChild(label);
    s.root.appendChild(root);
    s.items.push({ host, root, lineNow, lineTarget, label, off: 0, gate: 'ready', labelW: 240 });
  }
}

/**
 * 打开覆盖层。已经开着就什么都不做（幂等）。
 *
 * @param {Document} doc 宿主文档（测试里可以是假 DOM）
 * @param {object} api
 *   api.probe(host)                                 → { imgH, yTitle, lineH, roots, ... }
 *   api.offsetOf(lineH, imgH, yTitle, valign)       → 偏移量（只算，不写样式）
 *   api.rows()                                      → valtrace 的记录数组（总览用）
 * @returns {boolean} 现在开着吗
 */
function show(doc, api) {
  if (state) return true;
  if (!doc || !doc.body || typeof doc.createElement !== 'function') return false;
  const win = doc.defaultView || null;

  const root = makeEl(doc, 'position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;'
    + 'z-index:999999;margin:0;padding:0;border:0;background:transparent;');
  root.id = OVERLAY_ID;
  const panel = makeEl(doc, panelCss(), 'valign 对齐标记   Esc 关闭');
  root.appendChild(panel);
  doc.body.appendChild(root);

  const s = {
    doc,
    win,
    api: api || {},
    root,
    panel,
    items: [],
    hosts: [],
    raf: 0,
    lastMeasure: 0,
    keyHandler: null,
  };
  state = s;

  /* Esc 关掉。挂在 document 的捕获阶段：编辑器把 keydown 吞掉时也能收到。 */
  s.keyHandler = (evt) => {
    const key = evt && (evt.key || evt.keyCode);
    if (key === 'Escape' || key === 'Esc' || key === 27) hide();
  };
  try { doc.addEventListener('keydown', s.keyHandler, true); } catch (e) { s.keyHandler = null; }

  syncItems(s, hostList(doc));
  s.lastMeasure = 0;
  try { renderOnce(s, true); } catch (e) { /* 第一帧失败也留着，下一帧再试 */ }
  s.raf = nextFrame(s);
  return true;
}

/** 关掉并恢复原状（元素全部 remove，Esc 解绑，rAF 停） */
function hide() {
  const s = state;
  state = null;
  if (!s) return false;
  if (s.raf) {
    try {
      if (s.win && typeof s.win.cancelAnimationFrame === 'function') s.win.cancelAnimationFrame(s.raf);
    } catch (e) { /* ignore */ }
    s.raf = 0;
  }
  if (s.keyHandler) {
    try { s.doc.removeEventListener('keydown', s.keyHandler, true); } catch (e) { /* ignore */ }
    s.keyHandler = null;
  }
  for (const it of s.items) {
    removeEl(it.root);
  }
  s.items = [];
  removeEl(s.panel);
  removeEl(s.root);
  return true;
}

/** 命令面板那个开关：开着就关，关着就开 */
function toggle(doc, api) {
  if (state) { hide(); return false; }
  return show(doc, api);
}

function isOn() {
  return !!state;
}

/** 宿主集合变了（新图渲染出来 / 切笔记）：下一次测量时重建 item */
function refreshHosts(doc) {
  if (!state) return false;
  const d = doc || state.doc;
  syncItems(state, hostList(d));
  try { renderOnce(state, true); } catch (e) { /* ignore */ }
  return true;
}

module.exports = {
  OVERLAY_ID,
  MEASURE_GAP_MS,
  LINE_W,
  show,
  hide,
  toggle,
  isOn,
  refreshHosts,
  gateOf,
  cfgOf,
  panelText,
  labelText,
  /* 自测用 */
  _state: () => state,
};
