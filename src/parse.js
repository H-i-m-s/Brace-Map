'use strict';

/* 解析：指令区 + 列表区 */

const { cleanInline, parseRuns, runsText } = require('./text');

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
  let width = 0;                 // 浮动时的宽度（px）；0 = 按图自身宽
  let bg = '';                   // PNG 底色；空 = 透明（默认）
  let firstContentSeen = false;

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const isFirst = !firstContentSeen;
    firstContentSeen = true;

    // 1) 列表项
    const lm = raw.match(LIST_RE);
    if (lm) {
      const indent = lm[1].replace(/\t/g, '    ').length;
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
      const runs = parseRuns(body);
      const text = runsText(runs);
      // 行内本来就没内容 → 空节点（纯分叉点）；
      // 有内容但被清洗空了（例如只有 ** ）→ 当作无效行跳过
      if (!text && body.trim() !== '') continue;
      const node = { text, runs, children: [], forceBox };
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      if (stack.length) stack[stack.length - 1].node.children.push(node);
      else roots.push(node);
      stack.push({ node, indent });
      continue;
    }

    // 2) 第一条内容行若是 # 标题，留作兼容标题
    if (isFirst) {
      const hm = raw.trim().match(HEAD_RE);
      if (hm) {
        titleHash = cleanInline(hm[1]);
        continue;
      }
    }

    // 3) 指令
    const dm = raw.match(DIR_RE);
    if (dm) {
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
      } else if (key === 'width') {
        // 浮动时用来定宽；不写就让图按自身宽度自然收缩
        const n = parseFloat(val);
        width = Number.isFinite(n) && n > 0 ? n : 0;
      } else if (key === 'bg') {
        // PNG 导出底色：不写 = 透明（默认）；theme = 取主题底色；其余当颜色值
        bg = val;
      }
    }
    // 4) 其余忽略
  }

  return {
    title: titleDirective || titleHash,
    dir,
    brace,
    box,
    closing,
    maxWidth,
    float: floatMode,
    width,
    bg,
    roots,
  };
}

module.exports = { parseBox, parseSource, DIRS, STYLES };
