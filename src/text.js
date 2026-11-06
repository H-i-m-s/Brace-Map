'use strict';

/* 行内解析与渲染：清洗、样式 run、颜色、链接、转义 */

/* ============================================================
 * 文本清洗：剥掉行内 markdown 标记，只留字
 *
 * keepStyles = true 时保留 **粗** / *斜* / ~~删~~ 三组标记，
 * 交给 splitStyleRuns 拆成带样式的 run；其余标记（链接、行内代码、
 * 高亮、_下划线_ 等）照旧剥掉。
 * ============================================================ */

function cleanInlineCore(s, keepStyles) {
  let out = String(s);
  if (!keepStyles) {
    out = out
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1');
  }
  out = out
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/==([^=]+)==/g, '$1')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  if (!keepStyles) out = out.replace(/\*([^*]+)\*/g, '$1');
  return out
    .replace(/(^|[^\w])_([^_]+)_(?![\w])/g, '$1$2')
    // 转义美元符：maskMath 先把 \$ 换成 \u0002，没经过 maskMath 的路径（标题、
    // 指令行）这里直接还原字面量
    .replace(/\u0002/g, '$')
    .replace(/\\\$/g, '$')
    // 残留的 HTML 标签一律剥掉（<font> 已在 parseRuns 里先被抽走）
    .replace(/<[^>]*>/g, '')
    .trim();
}

/** 纯文字：标题、指令行这类只要字的地方用它 */
function cleanInline(s) {
  return cleanInlineCore(s, false);
}

/** 正文 run：留下 ** / * / ~~ 三组标记，样式由 splitStyleRuns 拆 */
function cleanRunText(s) {
  return cleanInlineCore(s, true);
}

/**
 * 把一段已清洗的文本按行内样式拆成 [{ text, bold, italic, strike }]。
 *
 * 优先级：~~删~~ → **粗** → *斜*。波浪线必须排在星号前面，否则一对 ~~ 会被
 * 当成两个斜体标记吃掉。标记可以叠加（**粗*斜*粗** 里层的 * 仍是斜体），
 * 未闭合的标记按原样保留文字，与 markdown 自身的处理一致（`**没闭合` 显示
 * 的就是带星号的原文），不吃字符。
 */
function splitStyleRuns(seg) {
  const out = [];
  walkStyle(String(seg), { bold: false, italic: false, strike: false }, out);
  return out;
}

function walkStyle(s, style, out) {
  let buf = '';
  let i = 0;
  const flush = () => {
    if (!buf) return;
    out.push({ text: buf, bold: style.bold, italic: style.italic, strike: style.strike });
    buf = '';
  };

  while (i < s.length) {
    if (s.startsWith('~~', i)) {
      const end = s.indexOf('~~', i + 2);
      if (end > i + 2) {
        flush();
        walkStyle(s.slice(i + 2, end),
          { bold: style.bold, italic: style.italic, strike: true }, out);
        i = end + 2;
        continue;
      }
      buf += '~~';
      i += 2;
      continue;
    }
    if (s.startsWith('**', i)) {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        walkStyle(s.slice(i + 2, end),
          { bold: true, italic: style.italic, strike: style.strike }, out);
        i = end + 2;
        continue;
      }
      buf += '**';
      i += 2;
      continue;
    }
    if (s.charAt(i) === '*') {
      const end = s.indexOf('*', i + 1);
      if (end > i + 1) {
        flush();
        walkStyle(s.slice(i + 1, end),
          { bold: style.bold, italic: true, strike: style.strike }, out);
        i = end + 1;
        continue;
      }
      buf += '*';
      i += 1;
      continue;
    }
    buf += s.charAt(i);
    i += 1;
  }
  flush();
}

/* ============================================================
 * 行内颜色：<font color="#d99694">文字</font>
 *
 * SVG 里颜色靠 <tspan fill>，所以文字要拆成「带色/不带色」的片段。
 * 标签本身不占宽度，所以测量仍然用拼接后的纯文本，布局与校准都不受影响。
 * ============================================================ */

const FONT_TAG_RE = /<font\s+color\s*=\s*(["'])([^"']*)\1\s*>([\s\S]*?)<\/font>/gi;
// 只放行安全的颜色字面量，防止把任意字符串塞进 SVG 属性
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-zA-Z]{3,20})$/;

function safeColor(v) {
  const s = String(v == null ? '' : v).trim();
  return COLOR_RE.test(s) ? s : null;
}

/* ============================================================
 * 行内链接：[[笔记]] / [[笔记|别名]] / [[笔记#标题]] / [文字](url)
 *
 * 链接必须在 cleanInlineCore 之前被认出来，否则 [[笔记]] 会被剥成纯字。
 * 做法是在整行原文上先扫一遍完整链接，换成占位符 \0序号\0，再让 <font> 切段
 * 照原样跑最后一轮：于是「<font> 包着链接」的段落颜色自然继承下来，而
 * 「别名里带 <font>」那几段颜色在还原链接时单独取，两种嵌套都不漏。
 *
 * 链接内部的 ** / * / ~~ 不解析：[[**粗**]] 里的星号按字面显示。
 * ============================================================ */

// [[目标]] / [[目标|别名]]；别名里的竖线允许写成 \|
const WIKI_LINK_RE = /\[\[([^\]|\\]*)(?:\\?\|([^\]]*))?\]\]/g;
// [文字](url)；紧贴在前的 ! 是图片，不算链接
const MD_LINK_RE = /(!?)\[([^\]]*)\]\(([^)]*)\)/g;

// 占位符未识别只靠 maskLinks 写入，读取统一用下面的 ANY_SLOT_RE（链接与公式一起扫）

/** 有协议头（https:、mailto: 等）算外链，其余一律算 vault 内链 */
function isExternalHref(href) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(String(href == null ? '' : href).trim());
}

/** [[笔记#标题]] 的显示文字：笔记 > 标题 */
function wikiDisplay(target) {
  const hash = target.indexOf('#');
  if (hash < 0) return target;
  const note = target.slice(0, hash).trim();
  const head = target.slice(hash + 1).trim();
  if (!head) return note || target;
  return note ? note + ' > ' + head : '#' + head;
}

/** 链接可见文字里的 <font color>：只取颜色，文字原样保留（不解析行内样式） */
function linkPieces(text) {
  const src = String(text);
  const out = [];
  let last = 0;
  let m;
  FONT_TAG_RE.lastIndex = 0;
  while ((m = FONT_TAG_RE.exec(src)) !== null) {
    if (m.index > last) out.push({ text: src.slice(last, m.index), color: null });
    const piece = { text: m[3], color: safeColor(m[2]) };
    if (piece.text) out.push(piece);
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last), color: null });
  return out.filter((p) => p.text);
}

/**
 * 把一行原文里的完整链接挖成占位符，返回 { masked, links }。
 * links[i] = { href, pieces }：href 是原始目标，pieces 是可见文字按 <font> 切好的片段。
 * 认不出来的写法（[[]]、[文字]()、![图](src)）原样留在 masked 里，交给后面剥。
 */
function maskLinks(raw) {
  const src = String(raw);
  const links = [];
  let masked = '';
  let pos = 0;

  const makeWiki = (target, alias) => {
    const href = String(target == null ? '' : target).trim();
    if (!href) return null;                                    // [[]] / [[|别名]] 当普通文本
    const display = alias == null ? wikiDisplay(href) : String(alias).replace(/\\\|/g, '|');
    const pieces = linkPieces(display);
    return pieces.length ? { href, pieces } : null;
  };
  const makeMd = (text, url) => {
    const href = String(url == null ? '' : url).trim();
    const pieces = linkPieces(text);
    return href && pieces.length ? { href, pieces } : null;      // [文字]() 没有目标，当普通文本
  };

  while (pos < src.length) {
    WIKI_LINK_RE.lastIndex = pos;
    MD_LINK_RE.lastIndex = pos;
    const wiki = WIKI_LINK_RE.exec(src);
    const md = MD_LINK_RE.exec(src);
    if (!wiki && !md) break;

    const useWiki = !!wiki && (!md || wiki.index <= md.index);
    const hit = useWiki ? wiki : md;
    const end = hit.index + hit[0].length;

    // 图片 ![alt](src)：整段原样留着，cleanRunText 会把它剥掉（与改造前一致）
    if (!useWiki && hit[1] === '!') {
      masked += src.slice(pos, end);
      pos = end;
      continue;
    }

    const link = useWiki ? makeWiki(hit[1], hit[2]) : makeMd(hit[2], hit[3]);
    masked += src.slice(pos, hit.index);
    if (link) {
      masked += '\u0000' + links.length + '\u0000';
      links.push(link);
    } else {
      masked += hit[0];
    }
    pos = end;
  }
  masked += src.slice(pos);
  return { masked, links };
}

/**
 * 把一行原文拆成 [{ text, color, bold, italic, strike, href }]。
 * color / href 为 null 表示「用主题色」/「不是链接」；三个样式位默认 false。
 * 顺序：先挖链接 → 再按 <font color> 切段 → 每段再拆行内样式，于是
 * `<font color="red">**加粗**</font>` 得到 { color:'red', bold:true }。
 */
function parseRuns(raw) {
  // 公式先挖（否则 $a*b*c$ 里的星号会被当斜体），再挖链接（否则 [[笔记]] 会被剥成纯字）
  const mathSplit = maskMath(raw);
  const split = maskLinks(mathSplit.masked);
  const src = split.masked;
  const links = split.links;
  const maths = mathSplit.maths;
  const runs = [];

  // 一段纯文本 → 若干带样式的 run；空片段（样式标记之间没字）直接丢掉
  const pushText = (text, color) => {
    for (const r of splitStyleRuns(restoreMathSlots(text, maths))) {
      if (!r.text) continue;
      runs.push({
        text: r.text, color, bold: r.bold, italic: r.italic, strike: r.strike, href: null,
      });
    }
  };

  // 链接 run：可见文字原样进图，颜色优先用别名自带的 <font>，否则继承所在段
  const pushLink = (link, color) => {
    if (!link) return;
    for (const p of link.pieces) {
      runs.push({
        text: restoreMathSlots(p.text, maths),
        color: p.color || color,
        bold: false, italic: false, strike: false,
        href: link.href,
      });
    }
  };

  // 公式 run：text 留着 $...$ 原样（转换失败时降级成它就是这段字），
  // math 是 tex 本身，由 src/math.js 在布局前填上尺寸与矢量内容
  const pushMath = (mm, color) => {
    if (!mm) return;
    const fence = mm.display ? '$$' : '$';
    runs.push({
      text: fence + mm.tex + fence,
      color, bold: false, italic: false, strike: false, href: null,
      math: mm.tex, display: !!mm.display,
    });
  };

  // 一段可能含链接/公式占位符的文本：占位符还原成对应 run，其余照旧清洗拆样式
  const push = (text, color) => {
    const s = String(text);
    const slots = [];
    let m;
    ANY_SLOT_RE.lastIndex = 0;
    while ((m = ANY_SLOT_RE.exec(s)) !== null) {
      slots.push({
        index: m.index,
        end: m.index + m[0].length,
        link: m[1] == null ? -1 : Number(m[1]),
        math: m[2] == null ? -1 : Number(m[2]),
      });
    }
    if (!slots.length) {
      pushText(cleanRunText(s), color);
      return;
    }

    let last = 0;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const gap = s.slice(last, slot.index);
      // 两个占位符之间只剩空白时保留一个空格，否则 [[甲]] [[乙]] 会粘成 [[甲]][[乙]]；
      // gap 后面紧跟着当前这个 slot 的链接，所以只要 i > 0 就是「夹在两个链接之间」。
      // 首尾的空白仍然照老规矩被 trim 掉。
      if (i > 0 && gap && !gap.trim()) {
        runs.push({
          text: ' ', color, bold: false, italic: false, strike: false, href: null,
        });
      } else {
        pushText(cleanRunText(gap), color);
      }
      if (slot.math >= 0) pushMath(maths[slot.math], color);
      else pushLink(links[slot.link], color);
      last = slot.end;
    }
    pushText(cleanRunText(s.slice(last)), color);
  };

  let last = 0;
  let m;
  FONT_TAG_RE.lastIndex = 0;

  while ((m = FONT_TAG_RE.exec(src)) !== null) {
    if (m.index > last) push(src.slice(last, m.index), null);
    push(m[3], safeColor(m[2]));
    last = m.index + m[0].length;
  }
  if (last < src.length) push(src.slice(last), null);
  if (!runs.length) push(src, null);

  // 转义的 \$ 到这里才还原成字面量；公式 run 的 text 本来就是 $-围栏，不动
  for (const r of runs) {
    if (!r.math && r.text.indexOf(DOLLAR_SLOT) >= 0) {
      r.text = r.text.split(DOLLAR_SLOT).join('$');
    }
  }
  return runs;
}

/* ============================================================
 * 行内公式：$...$ / $$...$$
 *
 * 公式必须在 cleanRunText 与 splitStyleRuns 之前被挖走，否则 $a*b*c$ 里的星号
 * 会被当成斜体标记、公式里的尖括号会被当成 HTML。做法与链接一致：先把整行原文
 * 里的公式换成占位符 \u0001序号\u0001，剩下的照原路走，最后在 push 里还原成
 * 一个 math run。
 *
 * 认不出来的写法（$5、$x 这种没闭合的、首尾带空白的）原样保留文字，
 * 与「未闭合的样式标记不吃字符」保持同一套直觉。
 * ============================================================ */

const MATH_SLOT_RE = /\u0001(\d+)\u0001/g;
// 链接与公式共用一次扫描：\u0000…\u0000 是链接，\u0001…\u0001 是公式
const ANY_SLOT_RE = /\u0000(\d+)\u0000|\u0001(\d+)\u0001/g;
// 字面美元符的占位：$ 不会被当成公式起点，收尾时统一还原
const DOLLAR_SLOT = '\u0002';

/** 是不是一个像样的公式正文：非空、首尾无空白、单行 */
function validMathTex(tex) {
  if (!tex) return false;
  if (/[\r\n]/.test(tex)) return false;
  return tex.trim() === tex;
}

/**
 * 把一行原文里的公式挖成占位符，返回 { masked, maths }。
 * maths[i] = { tex, display }。`\$` 换成占位符（收尾时还原成字面 $）。
 */
function maskMath(raw) {
  const src = String(raw);
  const maths = [];
  let out = '';
  let i = 0;

  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === '\\' && src.charAt(i + 1) === '$') {
      out += DOLLAR_SLOT;
      i += 2;
      continue;
    }
    if (ch !== '$') {
      out += ch;
      i += 1;
      continue;
    }

    const display = src.charAt(i + 1) === '$';
    const open = display ? 2 : 1;
    const from = i + open;

    let end = -1;
    if (display) {
      end = src.indexOf('$$', from);
    } else {
      let k = from;
      while (k < src.length) {
        const c = src.charAt(k);
        if (c === '\\' && src.charAt(k + 1) === '$') { k += 2; continue; }
        if (c === '$') { end = k; break; }
        k += 1;
      }
    }

    const tex = end < 0 ? '' : src.slice(from, end);
    if (end < 0 || !validMathTex(tex)) {
      out += ch;
      i += 1;
      continue;
    }

    out += '\u0001' + maths.length + '\u0001';
    maths.push({ tex, display });
    i = end + (display ? 2 : 1);
  }

  return { masked: out, maths };
}

/**
 * 公式占位符还原成字面 $tex$。
 * 只给「不进 math run 的文字」用：链接别名、[[笔记|$x$]] 这类夹着公式的可见文字，
 * 它们是链接的一部分，没法单独拆成矢量，按字面显示。
 */
function restoreMathSlots(text, maths) {
  const s = String(text);
  if (s.indexOf('\u0001') < 0) return s;
  return s.replace(MATH_SLOT_RE, (all, d) => {
    const mm = maths && maths[Number(d)];
    if (!mm) return '';
    const fence = mm.display ? '$$' : '$';
    return fence + mm.tex + fence;
  });
}

function runsText(runs) {  let out = '';
  for (const r of runs) out += r.text;
  return out;
}

/** run 是否需要套 tspan：有颜色、任一文字样式、链接或公式 */
function runStyled(r) {
  return !!(r && (r.color || r.bold || r.italic || r.strike || r.href || r.math));
}

/**
 * 渲染为一串 tspan；完全没有样式时整行裸文本，保持标记尽量简单。
 * 链接额外带 class="bm-link" + data-href，点击由容器上的事件委托接（不用 <a>）。
 */
function renderRuns(runs, fallbackText) {
  const list = Array.isArray(runs) && runs.length ? runs : null;
  if (!list) return esc(fallbackText);

  let styled = false;
  for (const r of list) if (runStyled(r)) styled = true;
  if (!styled) {
    let out = '';
    for (const r of list) out += r.text;
    return esc(out);
  }

  let out = '';
  for (const r of list) {
    if (!runStyled(r)) {
      out += esc(r.text);
      continue;
    }
    // 公式占位：真正的位置与矢量内容由 svg.js 填（它知道基线、字号与每段的推进宽）。
    // 这里只留个标记，保证即使有人直接把含公式的 runs 扔进来也不会丢节点。
    if (r.math) {
      out += '<g class="bm-math" data-tex="' + esc(r.math) + '"></g>';
      continue;
    }
    let attrs = '';
    if (r.href) attrs += ' class="bm-link" data-href="' + esc(r.href) + '"';
    if (r.bold) attrs += ' font-weight="600"';
    if (r.italic) attrs += ' font-style="italic"';
    if (r.strike) attrs += ' text-decoration="line-through"';
    if (r.color) attrs += ' fill="' + esc(r.color) + '"';
    out += '<tspan' + attrs + '>' + esc(r.text) + '</tspan>';
  }
  return out;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  cleanInline,
  safeColor,
  isExternalHref,
  wikiDisplay,
  linkPieces,
  maskLinks,
  maskMath,
  validMathTex,
  parseRuns,
  runsText,
  renderRuns,
  esc,
};
