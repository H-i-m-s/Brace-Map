'use strict';

/* ============================================================
 * 临时诊断 · Live Preview（CM6）图文混排
 *
 * 背景：真实 Obsidian 里 Live Preview 的混排没生效（图上下撑出空白、正文整宽
 * 压不下来），而 headless 复刻的 CM6 结构里是通的。说明真实 DOM / 行高 / 内联
 * 样式跟复刻不一致。这一层只负责「把真实运行时数据吐出来」，不改任何布局行为。
 *
 * 输出：vault 根目录 brace-map-debug.log，每行一条 JSON，每次写入整体覆盖。
 *   日志里每条都有 n（自增序号，缺号说明中间被截断过）和 t（毫秒时间戳），
 *   按文件顺序读就是真实的执行顺序。
 *
 * ⚠ 这一层默认关闭（DEBUG_LP = false），保留结构备查。关着的时候 dbg() /
 *   dbgNull() / flush() 都在入口早退，几乎零开销；要再取证时把它改回 true
 *   （或者调用 dbgSetEnabled(true)）。不做成设置项：这是临时取证，不是产品功能。
 *
 * 纪律：本文件导出的每个函数都自己 try/catch，绝不外抛；调用方用
 *   dbg('点名', () => ({...})) 的惰性写法，连字段计算也在 try/catch 里面，
 *   任何一条诊断炸掉都只是少一行日志，不会影响渲染。
 * ============================================================ */

/** 总开关：排查结束，已关。关掉后 dbg() / dbgNull() / flush() 都在入口早退，几乎零开销。 */
const DEBUG_LP = false;

/** 当前是否开着。正式运行始终等于 DEBUG_LP；自测用 dbgSetEnabled(true) 临时打开。 */
let enabled = DEBUG_LP;

/** 日志文件名（相对 vault 根目录） */
const DEBUG_FILE = 'brace-map-debug.log';
/** 缓冲区最多留多少行，超了从头部裁掉 */
const LINE_MAX = 1200;
/** 裁剪后保留的行数（一次多裁一点，避免每条都 splice） */
const TRIM_TO = 600;
/** 两次落盘之间的最小间隔（ms）：字体/滚动会连着触发几十轮 recompute */
const FLUSH_GAP = 800;
/** 单个字符串字段的最大长度（cssText 可能很长） */
const FIELD_MAX = 400;

let seq = 0;
let buf = [];
let app = null;
let started = false;
let pending = 0;
let writing = false;
let dirty = false;
let lastWrite = 0;
let noAdapter = false;
let fallbackShown = false;

/* ------------------------------ 小工具 ------------------------------ */

function nowMs() {
  try { return Date.now(); } catch (e) { return 0; }
}

function round1(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

/** 把任意值收成可安全 JSON 化的短值（对象/数组浅走两层） */
function clip(v, depth) {
  const d = depth == null ? 0 : depth;
  try {
    if (v == null) return v;
    if (typeof v === 'string') return v.length > FIELD_MAX ? v.slice(0, FIELD_MAX) + '…' : v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
    if (typeof v === 'boolean') return v;
    if (d >= 2) return '[deep]';
    if (Array.isArray(v)) return v.slice(0, 12).map((x) => clip(x, d + 1));
    if (typeof v === 'object') {
      const out = {};
      const keys = Object.keys(v).slice(0, 24);
      for (const k of keys) out[k] = clip(v[k], d + 1);
      return out;
    }
    return String(v).slice(0, FIELD_MAX);
  } catch (e) {
    return '[unclip]';
  }
}

function classNameOf(el) {
  try {
    if (!el) return '';
    const cn = el.className;
    if (typeof cn === 'string') return cn;
    if (cn && typeof cn.baseVal === 'string') return cn.baseVal;      // SVG 的 className 是对象
    if (typeof el.getAttribute === 'function') {
      const a = el.getAttribute('class');
      if (a) return String(a);
    }
    const cl = el.classList;
    if (cl && typeof cl.length === 'number') return Array.prototype.join.call(cl, ' ');
  } catch (e) { /* ignore */ }
  return '';
}

function tagOf(el) {
  try {
    const t = el && (el.tagName || el.nodeName);
    return t ? String(t).toLowerCase() : '?';
  } catch (e) { return '?'; }
}

function computedOf(el) {
  try {
    if (!el) return null;
    const doc = el.ownerDocument;
    const view = doc && doc.defaultView;
    if (view && typeof view.getComputedStyle === 'function') return view.getComputedStyle(el);
    if (typeof getComputedStyle === 'function') return getComputedStyle(el);
  } catch (e) { /* 假 DOM / 离屏节点读不到 */ }
  return null;
}

/* ------------------------------ 元素取值 ------------------------------ */

/** 元素摘要：`div.#id.cls1.cls2`，className 只取前 80 字符 */
function dbgEl(el) {
  try {
    if (!el) return null;
    const cls = classNameOf(el).trim();
    const short = cls ? cls.split(/\s+/).filter(Boolean).join('.').slice(0, 80) : '';
    let id = '';
    try {
      const raw = el.id;
      if (typeof raw === 'string' && raw) id = '#' + raw.slice(0, 40);
    } catch (e) { id = ''; }
    return tagOf(el) + id + (short ? '.' + short : '');
  } catch (e) {
    return '?';
  }
}

function dbgRect(el) {
  try {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    const r = el.getBoundingClientRect();
    if (!r) return null;
    return { top: round1(r.top), left: round1(r.left), w: round1(r.width), h: round1(r.height) };
  } catch (e) {
    return null;
  }
}

/** 一组 computed 属性 */
function dbgCss(el, props) {
  const out = {};
  try {
    const cs = computedOf(el);
    if (!cs) return out;
    const list = Array.isArray(props) ? props : [];
    for (const p of list) {
      try { out[p] = String(cs[p] == null ? '' : cs[p]); } catch (e) { out[p] = '?'; }
    }
  } catch (e) { /* ignore */ }
  return out;
}

/** 行内样式的单条原样值（line.style.height 这类） */
function dbgInline(el, prop) {
  try {
    if (!el || !el.style) return '';
    const v = el.style[prop];
    return v == null ? '' : String(v);
  } catch (e) {
    return '';
  }
}

/** 行内样式全文（style.cssText） */
function dbgInlineAll(el) {
  try {
    if (!el || !el.style) return '';
    const t = el.style.cssText;
    return typeof t === 'string' ? t : '';
  } catch (e) {
    return '';
  }
}

function dbgChildCount(el) {
  try {
    return el && typeof el.childElementCount === 'number' ? el.childElementCount : -1;
  } catch (e) {
    return -1;
  }
}

function dbgFirstChild(el) {
  try { return dbgEl(el && el.firstElementChild); } catch (e) { return null; }
}

/** 祖先链摘要：从 el 自己往上 6 层，用来判断真机 CM6 结构 */
function dbgChain(el, depth) {
  const out = [];
  try {
    const max = Number(depth) > 0 ? Number(depth) : 6;
    let cur = el;
    for (let i = 0; cur && i < max; i++) {
      out.push(dbgEl(cur));
      cur = cur.parentElement;
    }
  } catch (e) { /* ignore */ }
  return out;
}

/* ------------------------------ 记录与落盘 ------------------------------ */

function push(point, data) {
  try {
    seq++;
    const rec = { n: seq, t: nowMs(), p: String(point) };
    if (data && typeof data === 'object') {
      const keys = Object.keys(data);
      for (const k of keys) rec[k] = clip(data[k]);
    } else if (data != null) {
      rec.v = clip(data);
    }
    let text;
    try {
      text = JSON.stringify(rec);
    } catch (e) {
      text = JSON.stringify({ n: seq, t: nowMs(), p: String(point), jsonError: true });
    }
    buf.push(text);
    if (buf.length > LINE_MAX) buf.splice(0, LINE_MAX - TRIM_TO);
    scheduleFlush();
  } catch (e) { /* 记录失败就算了，绝不影响渲染 */ }
}

/**
 * 记一条。fn 是惰性求值函数：字段计算也在本函数的 try/catch 里，
 * 所以调用点不需要再包一层（包了也无害）。
 */
function dbg(point, fn) {
  if (!enabled) return;
  try {
    let data = null;
    try {
      if (typeof fn === 'function') data = fn();
      else if (fn !== undefined) data = fn;          // 允许直接给字面值
    } catch (err) {
      data = { thunkError: String(err && err.message ? err.message : err) };
    }
    push(point, data);
  } catch (e) { /* ignore */ }
}

/** 记一条「在这里 return null」，at 是稳定的原因代号 */
function dbgNull(point, at) {
  if (!enabled) return;
  dbg(point, () => ({ at: String(at) }));
}

function adapterOf(a) {
  try {
    const ad = a && a.vault && a.vault.adapter;
    if (ad && typeof ad.write === 'function') return ad;
  } catch (e) { /* 移动端可能没有 adapter */ }
  return null;
}

function renderText() {
  try { return buf.join('\n') + (buf.length ? '\n' : ''); } catch (e) { return ''; }
}

function fallbackToConsole(text, err) {
  if (fallbackShown) return;
  fallbackShown = true;
  try {
    console.log('[brace-map][debug] vault 写入失败，诊断日志改用 console 输出（只打这一次）：');
    console.log(text);
    if (err) console.log('[brace-map][debug] 失败原因：', err && err.message ? err.message : err);
  } catch (e) { /* ignore */ }
}

function flush() {
  if (!enabled) return;
  if (!app) return;
  const ad = adapterOf(app);
  if (!ad) { noAdapter = true; return; }          // 没有 adapter 写权限：静默跳过
  if (writing) { dirty = true; return; }
  const text = renderText();
  if (!text) return;
  writing = true;
  let p;
  try {
    p = ad.write(DEBUG_FILE, text);               // 每次都整体覆盖，不追加
  } catch (err) {
    writing = false;
    fallbackToConsole(text, err);
    return;
  }
  const done = (err) => {
    writing = false;
    if (err) {
      fallbackToConsole(text, err);
    } else {
      lastWrite = nowMs();
      fallbackShown = false;
    }
    if (dirty) { dirty = false; scheduleFlush(); }
  };
  if (p && typeof p.then === 'function') {
    p.then(() => done(null), (err) => done(err));
  } else {
    done(null);
  }
}

function scheduleFlush() {
  if (!enabled || noAdapter || !app || pending) return;
  let wait = FLUSH_GAP;
  try {
    const gap = nowMs() - lastWrite;
    wait = gap >= FLUSH_GAP ? FLUSH_GAP : (FLUSH_GAP - gap);
  } catch (e) { wait = FLUSH_GAP; }
  if (writing) { dirty = true; return; }
  try {
    pending = setTimeout(() => { pending = 0; flush(); }, wait);
  } catch (e) {
    pending = 0;
  }
}

function envNumber(name) {
  try {
    if (typeof window === 'undefined') return null;
    const v = Number(window[name]);
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  } catch (e) { return null; }
}

function userAgent() {
  try {
    if (typeof navigator === 'undefined' || !navigator) return '';
    return String(navigator.userAgent == null ? '' : navigator.userAgent).slice(0, 180);
  } catch (e) { return ''; }
}

/** 开张那一条：环境信息，方便判断是真机 Obsidian 还是复刻页 */
function start() {
  push('session.start', {
    file: DEBUG_FILE,
    ua: userAgent(),
    dpr: envNumber('devicePixelRatio'),
    innerW: envNumber('innerWidth'),
    innerH: envNumber('innerHeight'),
    app: !!(app && app.vault),
    note: '临时诊断；默认关闭（src/debug.js 的 DEBUG_LP）',
  });
}

/**
 * 绑上 Obsidian 的 app（写日志要用它的 vault.adapter）。
 * 只在第一次成功时写一条 session.start。
 */
function dbgConfigure(a) {
  if (!enabled) return false;
  try {
    if (!a || !a.vault) return false;
    if (app === a) return true;
    // 拿不到可写的 adapter（移动端 / 测试环境）就当没这回事，静默跳过
    if (!adapterOf(a)) return false;
    app = a;
    if (!started) {
      started = true;
      start();
      scheduleFlush();
    }
    return true;
  } catch (e) {
    return false;
  }
}

/* 测试与排障用：把缓冲区当纯文本拿出来 / 清空 */
function dbgText() {
  try { return buf.join('\n'); } catch (e) { return ''; }
}

function dbgCount() {
  try { return buf.length; } catch (e) { return 0; }
}

function dbgReset() {
  try {
    buf = [];
    seq = 0;
    dirty = false;
    fallbackShown = false;
    noAdapter = false;
  } catch (e) { /* ignore */ }
}

/** 测试用：马上落一次盘（不等节流） */
function dbgFlush() {
  if (!enabled) return false;
  try {
    flush();
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 打开 / 关闭诊断层。只给自测用：正式运行永远是 DEBUG_LP 的默认值（false）。
 * 关掉时顺手把没落盘的定时器清掉，避免关完又写一次盘。
 */
function dbgSetEnabled(on) {
  enabled = !!on;
  if (!enabled && pending) {
    try { clearTimeout(pending); } catch (e) { /* ignore */ }
    pending = 0;
  }
  return enabled;
}

module.exports = {
  DEBUG_LP,
  dbgSetEnabled,
  DEBUG_FILE,
  LINE_MAX,
  TRIM_TO,
  FIELD_MAX,
  dbg,
  dbgNull,
  dbgConfigure,
  dbgEl,
  dbgRect,
  dbgCss,
  dbgInline,
  dbgInlineAll,
  dbgChildCount,
  dbgFirstChild,
  dbgChain,
  dbgText,
  dbgCount,
  dbgReset,
  dbgFlush,
};
