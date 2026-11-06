'use strict';

/* 全局参数与命名空间常量 */

const NS = 'http://www.w3.org/2000/svg';

/* ============================================================
 * 参数
 * ============================================================ */

const OPT = {
  pad: 16,          // 画布内边距（不随字号缩放）

  // ---- 下面四项在基准字号下标定，布局时按「当前字号 / baseFont」等比缩放 ----
  // 字号一变它们跟着走，不会出现「文字放大了、括号还是那么细、层间距还是那么窄」。
  colGap: 16,       // 父节点与括号之间、括号与子列之间的最小间隙
  braceWidth: 10,   // 括号横向跨度
  boxPadX: 10,      // 方框内左右留白
  boxPadY: 5,       // 方框内上下留白
  // 标定上述四项时的 .brace-map-svg 计算字号 = 正文 21px × CSS 里的 0.95em。
  // 主题字号变了，fontSize 会跟着变，比值自动生效。
  baseFont: 19.95,

  // 纵向尺寸全部按括号总高 span 的比例取，再夹在绝对上下限里：
  // 固定像素会让矮括号被钩子和尖端吃光，高括号又显得钩子过小。
  hookRatio: 0.15,    // 钩子纵向半径 r = clamp(span * 0.15, hookMin, braceWidth * hookMaxRatio)
  tipRatio: 0.11,     // 尖端单侧斜边 t = clamp(span * 0.11, tipMin, braceWidth * tipMaxRatio)
  hookMin: 3,
  hookMaxRatio: 0.6,
  tipMin: 2.5,
  tipMaxRatio: 0.5,
  minStraight: 4,     // 括号中间至少要留出的直线段长度
  rowGapRatio: 0.4, // 兄弟行之间的额外间隙 = lineH * 该值
  lineHRatio: 1.5,  // 多行节点内部的行距 = fontSize * 该值
  /*
   * 单行节点的文字占位高 = fontSize * nodeHRatio。
   *
   * 以前单行节点高度也取 lineH（= fontSize × lineHRatio）。那是多行排版需要的
   * 行距，比字高出很多：19.95px 字号下 lineH≈30、字高≈20，每个单行节点上下白白
   * 各空 5px，两个兄弟节点之间再叠一道 rowGap，括号就被拉得离文字很远。
   * 单行没有“换行”这回事，高度按字高加一点点行距就够了。
   */
  nodeHRatio: 1.2,
  titleGap: 10,     // 标题与正文之间

  /*
   * 公式基线相对行中心的偏移 = fontSize × 该值。
   *
   * 普通文字用 dominant-baseline: central 排，y 就是行的中心；但 MathJax 的矢量
   * 坐标以 y = 0 为基线（分式、上下标都靠它），所以带公式的节点要把基线口径换成
   * alphabetic，并整体下移到这里算出的偏移量。0.35 是「em 盒中心在基线上方
   * 约 0.35em」这个通用估计（ascent 0.9em / descent 0.2em），偏差在 1px 量级，
   * 且文字与公式共用同一条基线，两者之间永远对齐。
   */
  mathBaselineRatio: 0.35,
};

module.exports = { OPT, NS };
