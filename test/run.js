'use strict';

/* ============================================================
 * brace-map selftest · 入口
 *   node test/run.js        （或 node selftest.js）
 * 依次 require 各 suite 文件：require 顺序就是用例登记顺序，
 * 也就是输出里 ok 行的顺序。
 *
 * runAll 是 async（公式用例要 await 假的 MathJax 转换），所以收尾的样张
 * 打印放进 then，保证顺序与拆分前一致。
 * ============================================================ */

const { I, runAll } = require('./framework');

require('./parse.test');
require('./brace.test');
require('./layout.test');
require('./inline.test');
require('./math.test');
require('./geometry.test');
require('./calib.test');
require('./wrap.test');
require('./export.test');
require('./link.test');
require('./boxnode.test');
require('./float.test');
require('./floatwrap.test');
require('./livefloat.test');
require('./remeasure.test');
require('./wrapdiag.test');
require('./debug.test');

runAll().then(() => {
  // 路径样例，便于人工比对形状
  console.log('');
  console.log('curly(0, 12, 0, 100)  = ' + I.bracePathCurly(0, 12, 0, 100));
  console.log('square(0, 12, 0, 100) = ' + I.bracePathSquare(0, 12, 0, 100));
  console.log('curly(0, 11, 50, 54)  = ' + I.bracePathCurly(0, 11, 50, 54));

  // v0.3.0 比例样张：w = braceWidth = 10
  console.log('');
  for (const H of [30, 60, 120, 240]) {
    const k = I.braceK(I.OPT.braceWidth, H);
    console.log('span=' + H + '  r=' + k.kHook + ' t=' + k.kTip
      + '  d = ' + I.bracePathCurly(0, I.OPT.braceWidth, 0, H));
  }
  process.exit(0);
});
