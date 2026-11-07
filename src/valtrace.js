'use strict';

/* ============================================================
 * valign 调用轨迹（只读取证层）
 *
 * 干什么：applyValignLayout 每被调用一次，就往这里的环形缓冲追加一条记录。
 * 记录里带「从哪个入口来 / 从哪个分支返回 / 返回那一刻现场量到的那 12 个数」。
 * 一条命令把它和一份独立的现场快照写成 vault 根目录
 *   brace-map-valign-trace.md
 *
 * 为什么是「内存里攒、命令触发才落盘」：
 *   - 不写盘就没有异步、没有节流定时器，不占 IO，也不改变任何时序
 *   - 轨迹要包含「命令点下去之前」发生的事（渲染那一刻的调用），所以必须
 *     在插件加载后就开始记，而不是开日志之后才开始
 *   - 落盘只有一处，格式改动不会散落在调用点
 *
 * 硬纪律（与 applyValignLayout 的「只读」约束对齐）：
 *   - 只读 DOM：不写样式、不加类、不改属性、不挂监听
 *   - 宿主身份用 WeakMap 记，不在宿主对象上留任何字段
 *   - 每个出口都 try/catch：轨迹自身炸了也绝不影响布局，不抛错
 *   - 单次运行最多 MAX_ROWS 条，超出从头截断（留最新的）
 *
 * 依赖：无。这个模块不 require 任何东西，也就不可能和应用里其它模块成环。
 * ============================================================ */

/** 缓冲上限：单次运行最多 400 条，超出从头截断 */
const MAX_ROWS = 400;

let rows = [];
let seq = 0;
let t0 = 0;
let vids = new WeakMap();
let vidSeq = 0;

/* ------------------------------ 小工具 ------------------------------ */

function nowMs() {
  try { return Date.now(); } catch (e) { return 0; }
}

/** 两位小数；null / undefined 记 n/a；NaN 原样记出来（NaN 本身就是线索） */
function f2(v) {
  if (v === null || v === undefined) return 'n/a';
  const n = Number(v);
  if (Number.isNaN(n)) return 'NaN';
  if (!Number.isFinite(n)) return String(n);
  return (Math.round(n * 100) / 100).toFixed(2);
}

function b01(v) {
  if (v === true) return '1';
  if (v === false) return '0';
  return '?';
}

/** 单元格：把竖线换掉，免得撑破表格 */
function cell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/* ------------------------------ 宿主身份 ------------------------------ */

/**
 * 宿主实例编号：同一个 DOM 对象永远拿到同一个号。
 * 用 WeakMap 而不是在宿主上挂 __bmXxx：轨迹层承诺「只读」，一个字段都不留。
 * 编号的作用是分清「同一个元素的第二十次调用」和「换了新元素的第一百次调用」，
 * 而后者在 DOM 重建时非常常见（上下文一改，widget 整个换掉）。
 */
function vidOf(host) {
  if (!host || (typeof host !== 'object' && typeof host !== 'function')) return null;
  try {
    let v = vids.get(host);
    if (v == null) {
      vidSeq += 1;
      v = vidSeq;
      vids.set(host, v);
    }
    return v;
  } catch (e) {
    return null;
  }
}

/** 宿主在页面 .block-language-brace 里的下标（拿不到返回 -1） */
function indexOfHost(host) {
  try {
    const doc = host && host.ownerDocument;
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || typeof d.querySelectorAll !== 'function') return -1;
    const list = d.querySelectorAll('.block-language-brace') || [];
    for (let i = 0; i < list.length; i++) {
      if (list[i] === host) return i;
    }
  } catch (e) { /* ignore */ }
  return -1;
}

/**
 * 分组用的稳定标识：`图2#v7`。
 * 前半截是「此刻它在页面上排第几张」（人看得懂），后半截是实例号
 * （DOM 一重建就会变，能戳穿「你以为还是那张图」的错觉）。
 */
function hostTag(host) {
  const vid = vidOf(host);
  const idx = indexOfHost(host);
  const head = idx >= 0 ? '图' + (idx + 1) : '图?';
  return head + (vid == null ? '' : '#v' + vid);
}

function keyOf(host) {
  return {
    tag: hostTag(host),
    vid: vidOf(host),
    idx: indexOfHost(host),
  };
}

/* ------------------------------ 记录 ------------------------------ */

/**
 * 追加一条。entry 由调用方组好：
 *   src    入口（render / retry / observer / reapply / other）
 *   exit   返回分支代号（见 EXIT_DOC）
 *   host   宿主（只用来算身份，不写任何字段）
 *   probe  返回那一刻量到的数（valignProbe 的返回值）
 *   val    配置里的垂直基准
 *   float  配置里的浮动模式
 *   offset 这次算出来的偏移量（拿不到传 null）
 *   wrote  这次有没有真的写 margin-top
 *   err    异常信息（throw 分支才有）
 * @returns {object|null} 记下来的那条（测试用）
 */
function record(entry) {
  try {
    const src = entry && entry.src ? String(entry.src) : 'other';
    const host = entry ? entry.host : null;
    seq += 1;
    const t = nowMs();
    if (!t0) t0 = t;
    const k = keyOf(host);
    const row = {
      n: seq,
      t,
      dt: t - t0,
      src,
      exit: entry && entry.exit ? String(entry.exit) : 'other',
      tag: k.tag,
      vid: k.vid,
      idx: k.idx,
      val: entry && entry.val ? String(entry.val) : '',
      float: entry && entry.float ? String(entry.float) : '',
      offset: entry && entry.offset !== undefined ? entry.offset : null,
      wrote: !!(entry && entry.wrote),
      err: entry && entry.err ? String(entry.err) : '',
      probe: (entry && entry.probe) || null,
    };
    rows.push(row);
    if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);   // 从头截断
    return row;
  } catch (e) {
    return null;
  }
}

function all() {
  try { return rows.slice(); } catch (e) { return []; }
}

function count() {
  try { return rows.length; } catch (e) { return 0; }
}

/* ============================================================
 * 阅读视图那条路（floatify）单独一个缓冲、单独一节
 *
 * 两套轨迹不能混：applyValignLayout 走的是编辑模式的 margin-top，
 * floatify 走的是阅读视图的绝对定位 top。同一条表格里排在一起，
 * 「哪张图走了哪条路」就看不出来了。
 * ============================================================ */

/** floatify 轨迹的上限，与 applyValignLayout 同一套规矩 */
const MAX_FLOAT_ROWS = 400;

let floatRows = [];
let floatSeq = 0;
let floatT0 = 0;

/**
 * 记一条 floatify 调用。
 *
 * @param {object} entry
 *   exit   出口代号（见 FLOAT_EXIT_DOC）
 *   host   宿主（只用来算身份）
 *   block  真正被脱离流的那个块（内存里留着，对照节要拿它重测）
 *   bH/bW  调用那一刻 block 的 rect 高/宽（bH 是关键字段）
 *   vin    readerValignInfo 的五个值
 *   baseTop/top  算出来的流内位置与最终写入的位置
 *   recH   改宽之后重新量到的块高
 *   wrote  有没有真的写 top
 */
function recordFloat(entry) {
  try {
    const host = entry ? entry.host : null;
    floatSeq += 1;
    const t = nowMs();
    if (!floatT0) floatT0 = t;
    const k = keyOf(host);
    const vin = (entry && entry.vin) || null;
    const row = {
      n: floatSeq,
      t,
      dt: t - floatT0,
      exit: entry && entry.exit ? String(entry.exit) : 'other',
      tag: k.tag,
      vid: k.vid,
      idx: k.idx,
      val: entry && entry.val ? String(entry.val) : '',
      float: entry && entry.float ? String(entry.float) : '',
      bH: entry && entry.bH !== undefined ? entry.bH : null,
      bW: entry && entry.bW !== undefined ? entry.bW : null,
      vin: vin
        ? {
          valign: vin.valign || '',
          lineH: vin.lineH === undefined ? null : vin.lineH,
          imgH: vin.imgH === undefined ? null : vin.imgH,
          yTitle: vin.yTitle === undefined ? null : vin.yTitle,
          offset: vin.offset === undefined ? null : vin.offset,
        }
        : null,
      baseTop: entry && entry.baseTop !== undefined ? entry.baseTop : null,
      top: entry && entry.top !== undefined ? entry.top : null,
      recH: entry && entry.recH !== undefined ? entry.recH : null,
      wrote: !!(entry && entry.wrote),
      err: entry && entry.err ? String(entry.err) : '',
      /* 内存引用，不落盘：对照节要靠它当场重测 */
      host,
      block: entry && entry.block ? entry.block : null,
    };
    floatRows.push(row);
    if (floatRows.length > MAX_FLOAT_ROWS) floatRows.splice(0, floatRows.length - MAX_FLOAT_ROWS);
    return row;
  } catch (e) {
    return null;
  }
}

function floatAll() {
  try { return floatRows.slice(); } catch (e) { return []; }
}

function floatCount() {
  try { return floatRows.length; } catch (e) { return 0; }
}

function reset() {
  try {
    rows = [];
    seq = 0;
    t0 = 0;
    vids = new WeakMap();
    vidSeq = 0;
    floatRows = [];
    floatSeq = 0;
    floatT0 = 0;
  } catch (e) { /* ignore */ }
}

/* ------------------------------ 文案 ------------------------------ */

/** 退出分支代号 → 人读的说法 */
const EXIT_DOC = [
  ['write', '正常走完，写了 margin-top'],
  ['same', '算出的偏移和账上那条一模一样，不重写（提前返回）'],
  ['not-ready', '图还没准备好（图高 0 或根节点 0 个）：不算偏移、不还原、不改编记录，保留上一次结果'],
  ['offset=0', '量到了，但算出的偏移是 0，一个样式都不写（bottom 档）'],
  ['!inEditor', '宿主不在 .cm-content 里（或 isConnected 为假）→ 排补拍后返回'],
  ['!bm-floated', '宿主没有 bm-floated 类（float 没真写上去）'],
  ['float!=lr', 'cfg.float 不是 left / right'],
  ['!cfg', '没拿到 cfg'],
  ['!host', '没拿到宿主（或宿主没有 style）'],
  ['throw', '函数体抛异常'],
];

/** 入口代号 → 说明 */
const SRC_DOC = [
  ['render', '渲染末尾那一次（main.js renderBraceMap）'],
  ['retry', '首次挂载后的补拍（120 / 480 / 1200ms）'],
  ['observer', '尺寸观察器触发（图高变了）'],
  ['reapply', '设置页把浮动开关关一次再开'],
];

function fieldTable() {
  return [
    '| 字段 | 含义 |',
    '| --- | --- |',
    '| `#` | 自增序号，缺号说明中间被截断过 |',
    '| `+ms` | 相对本次运行第一条记录的毫秒数 |',
    '| `src` | 从哪个入口来的：' + SRC_DOC.map((x) => '`' + x[0] + '`').join(' / ') + ' |',
    '| `→` | 从哪个分支返回，见下面「退出分支」 |',
    '| `conn` | `host.isConnected`（1 / 0） |',
    '| `closest` | `!!host.closest(\'.cm-content\')`（1 / 0 / ? 表示没 closest 可用） |',
    '| `climb8` | `!!climbTo(host, \'cm-content\', 8)`（逐层爬的旧判定） |',
    '| `hHost` | `elHeight(host)` |',
    '| `hSvg` | `elHeight(pickSvg(host))` |',
    '| `imgH` | 图高，取法与函数里一致：`elHeight(host) || elHeight(pickSvg(host))` |',
    '| `svg` | 宿主的 `<svg>`：`svg` = 有且 tagName 是 svg，`none` = 没有 |',
    '| `lineH` | `measureLineHeight(host)` |',
    '| `yTitle` | `measureTitleCenter(host)`（`NaN` 原样记） |',
    '| `roots` | `host.querySelectorAll(\'[data-bm-root]\').length` |',
    '| `off` | `valignOffset` 这次算出来的结果 |',
    '| `wrote` | 这次有没有真的写 `margin-top`（1 / 0） |',
    '| `rectH` | `host.getBoundingClientRect().height`（对照值） |',
    '',
    '所有量都是「即将返回的那一刻」现场取的：`write` 那一行取于写完 margin-top 之后。',
  ].join('\n');
}

function exitTable() {
  const out = ['| 退出分支 | 含义 |', '| --- | --- |'];
  for (const [k, v] of EXIT_DOC) out.push('| `' + k + '` | ' + v + ' |');
  return out.join('\n');
}

/* ------------------------------ 排版 ------------------------------ */

/** 一行紧凑的记录：时序总览用 */
function lineOf(r) {
  const p = r.probe || {};
  return '#' + String(r.n) + '  +' + String(r.dt) + 'ms  ' + r.tag.padEnd(12)
    + r.src.padEnd(10) + '→ ' + r.exit.padEnd(12)
    + ' conn=' + b01(p.conn)
    + ' closest=' + b01(p.closest)
    + ' climb8=' + b01(p.climb8)
    + ' hHost=' + f2(p.hHost)
    + ' hSvg=' + f2(p.hSvg)
    + ' imgH=' + f2(p.imgH)
    + ' svg=' + (p.svg || '?')
    + ' lineH=' + f2(p.lineH)
    + ' yTitle=' + f2(p.yTitle)
    + ' roots=' + (p.roots == null ? '?' : String(p.roots))
    + ' off=' + f2(r.offset)
    + ' wrote=' + (r.wrote ? '1' : '0')
    + ' rectH=' + f2(p.rectH)
    + (r.err ? ' err=' + r.err : '');
}

function tableHead() {
  return '| # | +ms | src | → 退出 | conn | closest | climb8 | hHost | hSvg | imgH | svg '
    + '| lineH | yTitle | roots | off | wrote | rectH |';
}

function tableSep() {
  return '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
}

function tableRow(r) {
  const p = r.probe || {};
  return '| ' + r.n + ' | +' + r.dt + ' | ' + cell(r.src) + ' | `' + cell(r.exit) + '`'
    + ' | ' + b01(p.conn) + ' | ' + b01(p.closest) + ' | ' + b01(p.climb8)
    + ' | ' + f2(p.hHost) + ' | ' + f2(p.hSvg) + ' | ' + f2(p.imgH) + ' | ' + cell(p.svg || '?')
    + ' | ' + f2(p.lineH) + ' | ' + f2(p.yTitle)
    + ' | ' + (p.roots == null ? '?' : p.roots)
    + ' | ' + f2(r.offset) + ' | ' + (r.wrote ? '1' : '0')
    + ' | ' + f2(p.rectH) + ' |';
}

/**
 * 轨迹正文：两张表。
 *   1) 时序总览——全部记录按序号排（能看出 A 和 B 的调用在时间上怎么交错）
 *   2) 按宿主分组——同一张图的所有调用摆在一起（能看出它反复在哪一步停住）
 * 两份内容同源，只是排序不同：一份看全局顺序，一份看单张图的命运。
 */
function formatTrace() {
  const list = all();
  const out = [];
  out.push('# Brace Map · valign 调用轨迹');
  out.push('');
  out.push('- 生成时间：' + new Date().toISOString());
  out.push('- 轨迹条数：' + list.length + '（上限 ' + MAX_ROWS + ' 条，超出从头截断）');
  out.push('- 采集范围：本插件加载以来 `applyValignLayout` 的每一次调用，含提前返回的那些');
  out.push('');
  out.push('## 怎么读');
  out.push('');
  out.push('一条记录 = 一次调用。`→` 那一列是它**从哪个分支返回**的：先看这个，');
  out.push('它直接回答「这张图到底走到哪一步就停了」。后面一排数值是返回那一刻现场量到的量，');
  out.push('和文末「现场快照」用同一套量法，可以直接逐字段对比。');
  out.push('');
  out.push('## 字段');
  out.push('');
  out.push(fieldTable());
  out.push('');
  out.push('## 退出分支');
  out.push('');
  out.push(exitTable());
  out.push('');
  out.push('## 一、时序总览（按序号，全局顺序）');
  out.push('');
  if (!list.length) {
    out.push('（没有记录：`applyValignLayout` 一次都没被调用过）');
  } else {
    out.push('```');
    for (const r of list) out.push(lineOf(r));
    out.push('```');
  }
  out.push('');
  out.push('## 二、按宿主分组');
  out.push('');
  if (!list.length) {
    out.push('（没有记录）');
  } else {
    /* 分组顺序按首次出现的先后，组内按序号 */
    const order = [];
    const groups = Object.create(null);
    for (const r of list) {
      const k = r.tag;
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(r);
    }
    for (const k of order) {
      const g = groups[k];
      const first = g[0];
      out.push('### ' + k + ' · 共 ' + g.length + ' 条');
      out.push('');
      out.push('- 实例号：`v' + (first.vid == null ? '?' : first.vid) + '`'
        + '｜页面下标：' + (first.idx >= 0 ? '`[' + first.idx + ']`' : '拿不到')
        + '｜valign：`' + (first.val || '') + '`｜float：`' + (first.float || '') + '`');
      out.push('- 各分支出现次数：' + summarize(g));
      out.push('');
      out.push(tableHead());
      out.push(tableSep());
      for (const r of g) out.push(tableRow(r));
      out.push('');
    }
  }
  return out.join('\n');
}

/** 「各分支出现次数」一小段：write×3 · !inEditor×7 */
function summarize(g) {
  const cnt = Object.create(null);
  const order = [];
  for (const r of g) {
    if (!cnt[r.exit]) { cnt[r.exit] = 0; order.push(r.exit); }
    cnt[r.exit] += 1;
  }
  return order.map((k) => '`' + k + '`×' + cnt[k]).join(' · ');
}

/**
 * 现场快照：命令触发那一刻，对每个 .block-language-brace 独立量一遍。
 *
 * 与轨迹的关键区别：这里不经过 applyValignLayout，不管它有没有跑过、停在哪一步，
 * 都照同一套量法量一次。所以「函数里量到的」和「同一时刻现场量到的」能直接对账。
 *
 * @param {Array<{host:object, probe:object, state:object}>} items
 */
function formatSnapshot(items) {
  const out = [];
  const list = Array.isArray(items) ? items : [];
  out.push('## 三、现场快照（命令触发时独立量，不经过 applyValignLayout）');
  out.push('');
  out.push('这一节的每个数都由诊断命令当场重新取，和 `applyValignLayout` 无关：');
  out.push('哪怕这张图一次都没被调用过、或者上次调用停在某个分支，这一节照样有值。');
  out.push('和上文同一个宿主的记录逐字段对比，差值就是「函数里量到的」与「现场量到的」的区别。');
  out.push('');
  if (!list.length) {
    out.push('（页面上没有 `.block-language-brace`）');
    return out.join('\n');
  }
  for (const it of list) {
    const host = it && it.host;
    const p = (it && it.probe) || {};
    const st = (it && it.state) || {};
    /* 分组标识优先用构建快照那一刻取好的（格式生成时机可能已经不在同一个 DOM 上下文） */
    const tag = (it && it.tag) || hostTag(host);
    out.push('### ' + tag + (it && it.where ? ' · ' + cell(it.where) : ''));
    out.push('');
    out.push('| 项 | 现场值 |');
    out.push('| --- | --- |');
    out.push('| 4 宿主 isConnected | ' + b01(p.conn) + ' |');
    out.push('| 5 `closest(\'.cm-content\')` | ' + (p.closest === null ? '拿不到 closest' : b01(p.closest)) + ' |');
    out.push('| 6 `climbTo(host,\'cm-content\',8)` | ' + b01(p.climb8) + ' |');
    out.push('| 7 `elHeight(host)` | ' + f2(p.hHost) + ' |');
    out.push('| 8 `elHeight(pickSvg(host))` | ' + f2(p.hSvg) + ' |');
    out.push('| 9 `pickSvg(host)` | ' + (p.svg && p.svg !== 'none' ? '有，tagName `' + cell(p.svg) + '`' : '没有') + ' |');
    out.push('| 10 `measureLineHeight(host)` | ' + f2(p.lineH) + ' |');
    out.push('| 11 `measureTitleCenter(host)` | ' + (Number.isNaN(Number(p.yTitle)) ? 'NaN' : f2(p.yTitle)) + ' |');
    out.push('| 12 `[data-bm-root]` 个数 | ' + (p.roots == null ? '拿不到' : p.roots) + ' |');
    out.push('| 13 现在算 `valignOffset` | ' + f2(p.probeOffset)
      + '（基准 `' + cell(p.probeValign || '') + '`） |');
    out.push('| 14 现在有没有写 `margin-top` | ' + (p.mt ? '有：`' + cell(p.mt) + '`' : '没有') + ' |');
    out.push('| 15 `getBoundingClientRect().height` | ' + f2(p.rectH) + ' |');
    out.push('');
    out.push('宿主现状（判断它到底走没走过渲染链）：');
    out.push('');
    out.push('| 项 | 值 |');
    out.push('| --- | --- |');
    out.push('| `bm-floated` 类 | ' + (p.floated === true ? '有' : (p.floated === false ? '没有' : '拿不到')) + ' |');
    out.push('| `__bmCfg`（applyFloatLayout 写过） | ' + (st.hasCfg ? '有' : '没有') + ' |');
    out.push('| `__bmFloat`（浮动控件挂过） | ' + (st.hasFloat ? '有' : '没有') + ' |');
    out.push('| `__bmValignInfo`（valign 记录） | ' + (st.hasInfo ? '有：' + cell(st.infoText) : '没有') + ' |');
    out.push('| `__bmValignObs` 观察器 | ' + (st.obs ? '已挂，已触发 ' + (st.fired || 0) + ' 次' : '未挂') + ' |');
    out.push('| 首次补拍 | ' + (st.retry ? '排队中' : '无') + ' |');
    out.push('| 若此刻调用 applyValignLayout | ' + gateVerdict(p) + ' |');
    out.push('');
  }
  return out.join('\n');
}

/**
 * 用现场的三个门槛推一遍「现在调用会走哪个分支」。
 * 纯由上面的量推出，不含猜测：就是函数开头那几个 if 的同一套判据。
 */
function gateVerdict(p) {
  if (p.floated === false) return '→ `!bm-floated`（float 没写上去）';
  if (p.conn === false) return '→ `!inEditor`（isConnected 为假）';
  if (p.closest === false && p.climb8 === false) return '→ `!inEditor`（两个判定都找不到 .cm-content）';
  if (!(p.hHost > 0) && !(p.hSvg > 0)) return '→ `not-ready`（图高量到 0，保留上一次结果）';
  if (p.roots === 0) return '→ `not-ready`（一个 `[data-bm-root]` 都没有，保留上一次结果）';
  return '能正常量到（继续算）';
}

/** floatify 的出口代号 */
const FLOAT_EXIT_DOC = [
  ['ok', '正常完成：绝对定位、top、留白全写下去了'],
  ['!side', 'cfg.float 不是 left / right'],
  ['!el', '宿主没有 style 或量不了尺寸'],
  ['isLivePreview', '实时预览（CM6）——编辑模式那条路，不在此列'],
  ['!ctx', 'pickContext 拿不到定位祖先或块'],
  ['block===ancestor', '定位祖先和要脱离的块是同一个，没法动手'],
  ['!aRect', '定位祖先量不到 rect'],
  ['!bRect', '块量不到 rect'],
  ['!plan.length', '后面没有可绕排的块（图高 0 时必走这里）'],
  ['throw', '函数体抛异常'],
];

/** 表头：floatify 一张表 */
function floatTableHead() {
  return '| # | +ms | 宿主 | → 出口 | bH | bW | val | lineH | imgH | yTitle | off | baseTop | top | recH | 写了 |';
}

function floatTableRow(r) {
  const v = r.vin || {};
  return '| ' + r.n + ' | +' + r.dt + ' | ' + cell(r.tag) + ' | `' + cell(r.exit) + '`'
    + ' | ' + f2(r.bH) + ' | ' + f2(r.bW) + ' | ' + cell(r.val || '?')
    + ' | ' + f2(v.lineH) + ' | ' + f2(v.imgH) + ' | ' + (v.yTitle === null || v.yTitle === undefined ? '—' : f2(v.yTitle))
    + ' | ' + f2(v.offset) + ' | ' + f2(r.baseTop) + ' | ' + f2(r.top)
    + ' | ' + f2(r.recH) + ' | ' + (r.wrote ? '1' : '0') + ' |';
}

/**
 * 第四节：floatify 调用轨迹。一条调用一行，按序号排。
 *
 * bH 是最该先看的一列：它就是调用那一刻 block 的 rect 高。
 * bH 为 0 而同一张图现在高 169.79，那就说明这条 top 是用 0 算出来的。
 */
function formatFloatifyTrace() {
  const list = floatAll();
  const out = [];
  out.push('## 四、floatify 调用轨迹（阅读视图）');
  out.push('');
  out.push('阅读视图的 valign 不走 `applyValignLayout`，而是 `floatify` 把偏移量加进绝对定位的 `top`。');
  out.push('这一节只记后者，与上面的编辑模式轨迹完全分开。');
  out.push('');
  out.push('- 轨迹条数：' + list.length + '（上限 ' + MAX_FLOAT_ROWS + ' 条，超出从头截断）');
  out.push('');
  out.push('| 字段 | 含义 |');
  out.push('| --- | --- |');
  out.push('| `bH` | **调用那一刻 `block.getBoundingClientRect().height`**——图还没渲染时它是 0 |');
  out.push('| `bW` | 同上，宽 |');
  out.push('| `lineH` / `imgH` / `yTitle` / `off` | `readerValignInfo` 当场量出的四个值 |');
  out.push('| `baseTop` | 块在流里的位置（= 块 rect 顶 − 祖先 rect 顶） |');
  out.push('| `top` | 最终写下去的值 = baseTop + off |');
  out.push('| `recH` | 写完宽度之后重新量到的块高（可能与 bH 不同） |');
  out.push('');
  out.push('| 出口 | 含义 |');
  out.push('| --- | --- |');
  for (const [k, v] of FLOAT_EXIT_DOC) out.push('| `' + k + '` | ' + v + ' |');
  out.push('');
  if (!list.length) {
    out.push('（没有记录：本次加载以来 `floatify` 一次都没被调用过）');
    return out.join('\n');
  }
  out.push(floatTableHead());
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of list) out.push(floatTableRow(r));
  return out.join('\n');
}

/**
 * 第五节：初值与现值对照（这节是重点）。
 *
 * 「初值」= floatify 当初算那个 top 时用的数；「现值」= 命令触发这一刻
 * 用同一个 readerValignInfo 重算一遍（只读，不写样式）。两者不同就说明：
 * top 是按一个已经过时的图高算出来的。
 *
 * @param {Array} items 每项 { host, tag, calls, exits, first, last, now }
 */
function formatFloatifyCompare(items) {
  const out = [];
  const list = Array.isArray(items) ? items : [];
  out.push('## 五、floatify 的初值与现值对照');
  out.push('');
  out.push('对每个宿主：左边两列是 `floatify` 当初 / 最后一次记下的五个值（从轨迹里读）；');
  out.push('右边一列是命令触发这一刻重新调一次 `readerValignInfo` 的结果（只读，不写样式）。');
  out.push('');
  if (!list.length) {
    out.push('（页面上没有带浮动记录的宿主）');
    return out.join('\n');
  }
  for (const it of list) {
    const first = it.first || null;
    const last = it.last || null;
    const now = it.now || null;
    const fv = (first && first.vin) || {};
    const lv = (last && last.vin) || {};
    out.push('### ' + (it.tag || '图?') + (it.extra ? ' · ' + cell(it.extra) : ''));
    out.push('');
    out.push('- floatify 调用 ' + (it.calls || 0) + ' 次' + (it.exits ? '：' + it.exits : ''));
    out.push('');
    out.push('| 量 | 初次记下' + (first ? '（#' + first.n + ' ' + first.exit + '）' : '') + ' | 最后一次记下'
      + (last ? '（#' + last.n + ' ' + last.exit + '）' : '') + ' | 命令此刻重算 |');
    out.push('| --- | --- | --- | --- |');
    const yv = (v) => (v === null || v === undefined ? '—' : f2(v));
    out.push('| bH（调用时的块高） | ' + (first ? f2(first.bH) : '—')
      + ' | ' + (last ? f2(last.bH) : '—')
      + ' | ' + (now ? f2(now.bH) : '—') + ' |');
    out.push('| imgH | ' + yv(fv.imgH) + ' | ' + yv(lv.imgH) + ' | ' + (now ? yv(now.imgH) : '—') + ' |');
    out.push('| lineH | ' + yv(fv.lineH) + ' | ' + yv(lv.lineH) + ' | ' + (now ? yv(now.lineH) : '—') + ' |');
    out.push('| yTitle | ' + yv(fv.yTitle) + ' | ' + yv(lv.yTitle) + ' | ' + (now ? yv(now.yTitle) : '—') + ' |');
    out.push('| offset | ' + yv(fv.offset) + ' | ' + yv(lv.offset) + ' | ' + (now ? yv(now.offset) : '—') + ' |');
    out.push('| 写下的 top | ' + (first && first.top !== null ? f2(first.top) : '—')
      + ' | ' + (last && last.top !== null ? f2(last.top) : '—') + ' | —（当前生效值看块自己的行内 top） |');
    out.push('');
    /* 判读：只陈述能从上面这些数直接读出的事实，不猜原因 */
    const notes = [];
    if (nowErrText(it)) notes.push(nowErrText(it));
    if (first && now && Math.abs(Number(first.bH) - Number(now.bH)) > 0.5) {
      const zeroHint = !(Number(fv.imgH) > 0) ? '（图还没渲染）' : '';
      notes.push('调用时的块高 ' + f2(first.bH) + zeroHint + ' → 现在 ' + f2(now.bH)
        + (first.wrote ? '：写下的 top 是按 ' + f2(first.bH) + ' 算的'
          : '：这一拍没写 top（出口 `' + first.exit + '`）'));
    }
    if (first && first.vin && now && Number(fv.offset) !== Number(now.offset)) {
      notes.push('偏移也随之不同：' + f2(fv.offset) + ' → ' + f2(now.offset));
    }
    if (first && last && first.n !== last.n) {
      if (first.top === last.top) {
        notes.push('后来重算过，但 top 没变（#' + first.n + ' 与 #' + last.n + ' 写的都是 ' + f2(last.top) + '）');
      } else {
        notes.push('后来重算过，top 由 ' + f2(first.top) + ' 改成 ' + f2(last.top));
      }
    } else if (first && last && first.n === last.n) {
      notes.push('只有一次调用，之后没有重算');
    }
    if (!notes.length) notes.push('初值与现值一致，没有看出偏差');
    out.push('判读：');
    for (const n of notes) out.push('- ' + n);
    out.push('');
  }
  return out.join('\n');
}

function nowErrText(it) {
  return it && it.nowError ? '重算失败：' + it.nowError : '';
}

/** 完整文档：轨迹 + 现场快照 */
function formatDoc(items, floatItems) {
  const parts = [formatTrace(), formatSnapshot(items)];
  parts.push(formatFloatifyTrace());
  if (floatItems && floatItems.length) parts.push(formatFloatifyCompare(floatItems));
  else parts.push(formatFloatifyCompare([]));
  return parts.join('\n\n') + '\n';
}

module.exports = {
  MAX_ROWS,
  MAX_FLOAT_ROWS,
  EXIT_DOC,
  FLOAT_EXIT_DOC,
  SRC_DOC,
  record,
  recordFloat,
  all,
  count,
  floatAll,
  floatCount,
  reset,
  hostTag,
  keyOf,
  f2,
  formatTrace,
  formatSnapshot,
  formatFloatifyTrace,
  formatFloatifyCompare,
  formatDoc,
};
