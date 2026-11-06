'use strict';

/* 文本测量（canvas 优先，估算兜底） + 渲染上下文探针 */

const { NS, OPT } = require('./opt');

/* ============================================================
 * 文本测量（可注入）
 *
 * 必须用 canvas，不能用 DOM span 或 SVG 的实测宽度。
 *
 * 原因：Obsidian 渲染代码块时，宿主容器可能还没进入布局流（阅读视图的
 * 虚拟滚动、折叠区域、分栏未展开等）。那种状态下 getBoundingClientRect()
 * 和 getComputedTextLength() 一律返回 0，于是每一层的宽度都变成 0，
 * 所有列位塌到同一根轴上，文字会整片叠在一起。canvas 不参与布局，
 * 只要字体可用就能量出正确宽度。
 *
 * 但 canvas 的 font 简写要求含空格或中文的字体族名加引号，否则整条
 * font 声明会被静默丢弃、回退到 10px sans-serif，量出来的宽度只有实际
 * 的一小半。所以这里逐项加引号，再叠一层 0 值估算兜底。
 * ============================================================ */

function quoteFamilies(families) {
  return String(families || 'sans-serif')
    .split(',')
    .map((raw) => {
      const name = raw.trim();
      if (!name) return name;
      if (/^["']/.test(name)) return name;
      return /\s/.test(name) ? '"' + name + '"' : name;
    })
    .join(', ');
}

/** 最后的兜底：中文按 1em、其余按 0.55em 估算 */
function estimateWidth(text, fontSize) {
  let w = 0;
  for (const ch of String(text)) {
    w += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/.test(ch)
      ? fontSize
      : fontSize * 0.55;
  }
  return w;
}

function createTextMeasure(fontFamily, fontSize, fontWeight) {
  const size = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 14;
  const weight = fontWeight || 400;
  const font = weight + ' ' + size + 'px ' + quoteFamilies(fontFamily);

  let ctx = null;
  if (typeof document !== 'undefined') {
    try {
      const canvas = document.createElement('canvas');
      ctx = canvas.getContext('2d');
      if (ctx) ctx.font = font;
    } catch (e) {
      ctx = null;
    }
  }

  const measure = (text) => {
    const s = String(text);
    if (ctx) {
      const w = ctx.measureText(s).width;
      if (Number.isFinite(w) && w > 0) return w;
    }
    return estimateWidth(s, size);
  };
  measure.dispose = () => {};
  return measure;
}

// 兼容旧调用点（第 4 个参数 host 已不再需要）
const createDomMeasure = createTextMeasure;

/**
 * 节点宽度。粗体在 600 字重下明显更宽，整行按 400 量会撑破方框，
 * 所以有粗体 run 时逐段测量再累加；没有粗体时仍整行量一次，
 * 与改造前的宽度完全一致。
 *
 * 公式 run 同理：它不是一个能直接量的字符串（text 里是 $x^2$ 字面量），
 * 宽度必须是转换阶段算好的 widthEm × fontSize（见 src/math.js），
 * 否则方框盖不住公式。
 *
 * seq 只在「整行量一次」时透传给 regular，保证自校准的调用序与序号收集不变；
 * 逐段累加时各 run 不知道自己的节点序号，整行总宽由调用方自己按 seq 记账。
 */
function runsWidth(text, seq, runs, regular, bold) {
  const list = Array.isArray(runs) ? runs : null;
  if (!list || !list.length || typeof bold !== 'function') return regular(text, seq);

  let split = false;
  for (const r of list) {
    if (!r) continue;
    if (isMathPx(r) || r.bold) { split = true; break; }
  }
  if (!split) return regular(text, seq);

  let w = 0;
  for (const r of list) {
    if (!r) continue;
    if (isMathPx(r)) { w += r.mathWidth; continue; }
    if (!r.text) continue;
    w += r.bold ? bold(r.text) : regular(r.text);
  }
  return w;
}

/** 公式 run 且宽度已就位（转换失败降级的 run 已经摘掉 math，不算） */
function isMathPx(r) {
  return !!(r && r.math && Number.isFinite(r.mathWidth));
}

/**
 * 读一个元素自己算出来的字体：{ fontSize, fontFamily }；读不到返回 null。
 *
 * 关键在「读不到」这种情况：元素（或它的祖先）还没接进文档时，浏览器没有给它
 * 生成 layout，getComputedStyle 对 font-size 返回空串。以前这里直接
 * parseFloat(cs.fontSize) || 14，于是整张图静默按 14px sans-serif 排。
 */
function readLiveFont(el) {
  if (!el || typeof getComputedStyle !== 'function') return null;
  let cs = null;
  try { cs = getComputedStyle(el); } catch (e) { return null; }
  if (!cs) return null;
  const size = parseFloat(cs.fontSize);
  if (!Number.isFinite(size) || size <= 0) return null;
  const family = String(cs.fontFamily == null ? '' : cs.fontFamily).trim();
  return { fontSize: size, fontFamily: family || 'sans-serif' };
}

/**
 * 取渲染上下文：探针必须是一个真实的 .brace-map-svg 元素、
 * 挂在最终会放 SVG 的同一宿主里，读它自己的 computedStyle。
 * 读父容器的字号不行：CSS 里 .brace-map-svg 是 font-size: 0.95em，
 * 按父级字号去量会让测量值整体偏大，误差全堆到方框的一侧。
 */
function measureContext(hostEl) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'brace-map-svg');
  svg.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;visibility:hidden;';

  const probeIn = (parent) => {
    if (!parent || typeof parent.appendChild !== 'function') return null;
    parent.appendChild(svg);
    const font = readLiveFont(svg);
    if (svg.parentNode) svg.parentNode.removeChild(svg);
    return font;
  };

  const own = probeIn(hostEl);
  if (own) return own;

  /*
   * 宿主还不在文档里（Obsidian 常把代码块先渲染进离屏容器、渲染完再插进
   * 阅读视图），离屏子树没有 layout，探针的 computedStyle 读不出 fontSize。
   * 这里曾经静默退回 14px sans-serif：整张图按 14px 排、却按真实字号
   * （正文 21px × CSS 的 0.95em ≈ 19.95px）渲染。字号差 1.42 倍，于是
   * 折行在「估算坐标」里把 18 个字塞进一行（≈252px，看着没超 260），
   * 渲染出来却是 359px；方框按 252+2×7 画，只有 266 宽，文字居中后左边
   * 溢出到 x<0 被视口裁掉。这正是「maxWidth 折行后撑破方框、左边被裁」。
   *
   * 所以再往 document.body 上量一次：.brace-map-svg 的字体规则是全局选择器
   * （font-size: 0.95em），body 下量到的字号就是图真正会用的字号。
   * 两处都读不到才用 14px / sans-serif 兜底。
   */
  const global = probeIn(typeof document === 'undefined' ? null : document.body);
  if (global) return global;

  // 两处都读不到：用基准字号兜底，而不是 14。
  // 14 是历史遗留的写死值，与实际正文（21px × 0.95em ≈ 19.95px）差 1.42 倍，
  // 按它排出来的图会先撑破一遍再等异步校验修。基准字号至少与默认主题同量级，
  // 即使量不到也不至于差出一个字。
  return { fontSize: OPT.baseFont, fontFamily: 'sans-serif' };
}

module.exports = { createDomMeasure, runsWidth, measureContext, readLiveFont };
