'use strict';

/* 解析：指令区 + 列表区 */

const { cleanInline, parseRunsLines, runsText } = require('./text');

// 方向与括号样式白名单
const DIRS = ['lr', 'rl', 'tb', 'bt'];
const STYLES = ['curly', 'square'];

/* ============================================================
 * 解析：指令区 + 列表区（混写，无分隔符）
 * ============================================================ */

// 列表项：允许 `-` 后面完全为空，表示「只画括号、不画字的节点」（纯分叉点）
const LIST_RE = /^([ \t]*)(?:[-*+]|\d+[.)])(?:\s+(.*))?$/;
const DIR_RE = /^\s*(\w+)\s*:\s*(.+)$/;
const HEAD_RE = /^#{1,6}\s+(.*)$/;

/*
 * 认得这些键的 `键: 值` 才是指令。
 *
 * 只在「续行判定」里用到：缩进比上一个节点深的行本来该并进上一个节点，
 * 但它同时长得像指令（`注意: 这个很重要`）。这时看键——白名单里的还是指令
 * （`float: left` 不会被续行吞掉），不认识的当正文（不会被指令分支吃掉）。
 */
const DIR_KEYS = ['dir', 'brace', 'box', 'closing', 'title', 'maxwidth', 'float', 'width', 'valign', 'bg'];

// 续行拼接用的硬换行符：原样留在 raw 里，由 text.js 的行内解析层切开
const SOFT_BREAK = '\n';

function parseBox(v) {
  const s = String(v).trim().toLowerCase();
  if (!s || s === 'none' || s === 'off' || s === 'false') return [];
  const out = [];
  for (const part of s.split(/[,\s]+/)) {
    if (!part) continue;
    const n = parseInt(part, 10);
    if (Number.isFinite(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
}

/** 行首缩进宽度；tab 按 4 空格算，和列表项的缩进判定同一口径 */
function leadingIndent(line) {
  const m = String(line).match(/^[ \t]*/);
  return m ? m[0].replace(/\t/g, '    ').length : 0;
}

/**
 * 续行拼接：代码块里怎么换行，图上就怎么换行。
 *   普通平键 ⏎ 按端部形状分 → 两段，两行
 * 拼的是换行符，不是空格：接缝处不补空格、不做词间处理，续行本身 trim 掉
 * 行首缩进后再接。换行符走的是 <br> 同一条切分路径（<br> 本来就是硬换行）。
 */
function joinContinuation(prev, line) {
  const a = String(prev == null ? '' : prev).replace(/\s+$/, '');
  const b = String(line == null ? '' : line).trim();
  if (!a) return b;
  if (!b) return a;
  return a + SOFT_BREAK + b;
}

/**
 * 把一段原始正文解析进节点。
 *
 * 节点同时留两份：
 *   segRuns  硬换行（<br> 或续行留下的换行符）之间的每一段，每一段是一组 run
 *            —— layout 先照它分段，段内再按 maxwidth 折行
 *   runs     拍平后的全部 run（公式转换、宽度累加都按它扫）
 * 续行是在解析前就拼进 raw 的（中间是换行符），所以行内样式、公式、双链在
 * 续行里跟正文一样解析，公式与链接的原子性由切分层保证。
 */
function fillNode(node, rawBody) {
  const raw = String(rawBody == null ? '' : rawBody);
  node.raw = raw;
  const segs = [];
  for (const line of parseRunsLines(raw)) {
    if (!runsText(line)) continue;     // <br> 在行首/行尾/连写时不留空行
    segs.push(line);
  }
  node.segRuns = segs.length ? segs : [[]];
  const flat = [];
  for (const line of node.segRuns) for (const r of line) flat.push(r);
  node.runs = flat;
  node.text = runsText(flat);
  return node;
}

function makeNode(rawBody, forceBox) {
  return fillNode({
    text: '', runs: [], segRuns: [[]], raw: '',
    children: [], forceBox: !!forceBox,
    // 这个节点前面隔着几个空行（0 = 紧挨上一个兄弟）。布局按它把「空行」
    // 换成实打实的一行高度，见 layout.js 的 siblingGap。
    gapBefore: 0,
  }, rawBody);
}

function parseSource(source) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const roots = [];
  const stack = [];

  let dir = 'lr';
  let brace = 'curly';
  let box = [];
  let closing = false;
  let titleDirective = '';
  let titleHash = '';
  let maxWidth = 0;              // 节点文字折行宽度上限（SVG 坐标，px）；0 = 不折行
  let floatMode = '';            // 'left' | 'right' | 'center' | 'inline' | ''
  let valign = 'top';            // 浮动图的垂直基准：'top' | 'middle' | 'bottom'
  let width = 0;                 // 浮动时的宽度（px）；0 = 按图自身宽
  let bg = '';                   // PNG 底色；空 = 透明（默认）
  let firstContentSeen = false;
  // 连续空行的计数。碰到下一条列表项时结算到那个节点的 gapBefore 上；
  // 碰到指令、续行或任何被忽略的行，计数清零（空行只隔开紧邻的两个节点）。
  let blankRun = 0;

  for (const raw of lines) {
    if (!raw.trim()) { blankRun++; continue; }
    const isFirst = !firstContentSeen;
    firstContentSeen = true;
    const indent = leadingIndent(raw);

    // 1) 列表项
    const lm = raw.match(LIST_RE);
    if (lm) {
      let body = lm[2] == null ? '' : lm[2];
      /*
       * 行尾 {box}：只给这一个节点画框，不看层。
       * box: N 是按层框（同一深度的全部节点），碰到「只想框住其中一两个」
       * 就没法表达。行尾标记能精确点名，要几个就选几个。
       * 只在行尾匹配，正文里出现的 {box} 字样不受影响。
       */
      let forceBox = false;
      const bx = body.match(/^(.*?)\s*\{box\}$/i);
      if (bx) { body = bx[1]; forceBox = true; }
      const node = makeNode(body, forceBox);
      // 行内本来就没内容 → 空节点（纯分叉点）；
      // 有内容但被清洗空了（例如只有 ** ）→ 当作无效行跳过
      if (!node.text && body.trim() !== '') { blankRun = 0; continue; }
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      /*
       * 空行的归属：算在「较浅的那一层」，也就是新节点和它上一个同级兄弟之间。
       *
       * 弹栈之后 stack 顶就是新节点的父节点（没有就是根列表），它一定是
       * 上一个节点自己的祖先之一 —— stack 本来就是上一个节点的祖先链，
       * 所以这一层恰好是两者最浅的共同层级：
       *   - A1 / A3 之间空行   → 父节点是 A，记在 A 的子项间距上
       *   - A 的末尾 / B 之间空行 → 父节点是根，记在根列表上，不牵扯 A1、B1
       * 多层嵌套下这条规则都由同一个 pop 结果决定，不会出现两解。
       */
      const siblings = stack.length ? stack[stack.length - 1].node.children : roots;
      // 前面没有兄弟 = 自己是父节点的第一个子项，没有东西要隔开，空行丢掉
      if (blankRun > 0 && siblings.length > 0) node.gapBefore = blankRun;
      blankRun = 0;
      siblings.push(node);
      stack.push({ node, indent });
      continue;
    }

    // 2) 第一条内容行若是 # 标题，留作兼容标题
    if (isFirst) {
      const hm = raw.trim().match(HEAD_RE);
      if (hm) {
        titleHash = cleanInline(hm[1]);
        blankRun = 0;
        continue;
      }
    }

    /*
     * 3) 指令 / 续行
     *
     * 缩进比「上一个节点」深 = 续行的候选。指令优先于续行（续行里写
     * `float: left` 仍然是指令），但只有白名单里的键才算指令，否则
     * `注意: 这个很重要` 这种会被指令分支吞掉，用户写了却看不见。
     */
    const prev = stack.length ? stack[stack.length - 1] : null;
    const deeper = !!prev && indent > prev.indent;
    const dm = raw.match(DIR_RE);
    const known = !!dm && DIR_KEYS.indexOf(dm[1].toLowerCase()) >= 0;

    if (dm && (!deeper || known)) {
      const key = dm[1].toLowerCase();
      const val = dm[2].trim();
      if (key === 'dir') {
        const d = val.toLowerCase();
        if (DIRS.indexOf(d) >= 0) dir = d;
      } else if (key === 'brace') {
        const s = val.toLowerCase();
        if (STYLES.indexOf(s) >= 0) brace = s;
      } else if (key === 'box') {
        box = parseBox(val);
      } else if (key === 'closing') {
        closing = /^(true|yes|1|on)$/i.test(val);
      } else if (key === 'title') {
        titleDirective = cleanInline(val);
      } else if (key === 'maxwidth') {
        // 单位就是最终 SVG 坐标里的像素，不随字号缩放；写错或非正数一律当不折行
        const n = parseFloat(val);
        maxWidth = Number.isFinite(n) && n > 0 ? n : 0;
      } else if (key === 'float') {
        // 指令词对齐 Blue Topaz 主题的图片浮动，写笔记时只需记一套
        const v = val.toLowerCase();
        if (v === 'l' || v === 'left') floatMode = 'left';
        else if (v === 'r' || v === 'right') floatMode = 'right';
        else if (v === 'c' || v === 'center' || v === 'centre') floatMode = 'center';
        else if (v === 'inl' || v === 'inline') floatMode = 'inline';
      } else if (key === 'valign') {
        // 浮动图的垂直基准：只认三个词，写错就回落到默认的 top
        const v = val.toLowerCase();
        valign = (v === 'middle' || v === 'bottom') ? v : 'top';
      } else if (key === 'width') {
        // 浮动时用来定宽；不写就让图按自身宽度自然收缩
        const n = parseFloat(val);
        width = Number.isFinite(n) && n > 0 ? n : 0;
      } else if (key === 'bg') {
        // PNG 导出底色：不写 = 透明（默认）；theme = 取主题底色；其余当颜色值
        bg = val;
      }
      blankRun = 0;
      continue;
    }

    /*
     * 续行（软换行）：并进上一个节点，重新走一遍行内解析。
     *
     * 节点内部（续行之间）的空行直接丢掉，不在文字里留空行。理由：
     *   1) fillNode 本来就把「空段」过滤掉（<br> 在行首/行尾/连写时不留空行），
     *      想留空行就得改这条更基础的规则；
     *   2) 留空行会多出一个空 tspan 行，n.lineCount、节点高、data-seq 的
     *      几何全都跟着变，这正是这次要避免的「空行影响既有几何」；
     *   3) 节点的行数语义一直是「每行都有字」（<br> 连写都不留空行），在这里单开
     *      一个例外，同一个空行在图中会随位置变出两种效果。
     */
    if (deeper) {
      blankRun = 0;
      fillNode(prev.node, joinContinuation(prev.node.raw, raw));
      continue;
    }

    // 4) 其余忽略
    blankRun = 0;
  }

  return {
    title: titleDirective || titleHash,
    dir,
    brace,
    box,
    closing,
    maxWidth,
    float: floatMode,
    valign,
    width,
    bg,
    roots,
  };
}

module.exports = { parseBox, parseSource, DIRS, STYLES };
