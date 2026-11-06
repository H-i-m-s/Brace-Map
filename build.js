'use strict';

/* ============================================================
 * build.js · 把 src/ 内联进 main.js
 *
 * 为什么需要这一步：移动端 Obsidian（Capacitor）没有 Node 的文件系统
 * require，运行时按路径加载 src/xxx.js 会直接抛错，插件 onload 失败，
 * 代码块处理器注册不上，括号图就原样显示成源码。
 *
 * 桌面端有完整的 require，但只要两套代码并存就迟早不一致，所以统一走内联：
 *   - src/      开发时的源文件，照旧按模块写
 *   - main.js   产物，自包含，桌面和移动端都用它
 *
 * 改了 src/ 之后跑一次：node build.js
 * 零依赖，不引打包器，就一个文件拼接。
 * ============================================================ */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'src');
const VENDOR_DIR = path.join(ROOT, 'vendor');
const MAIN = path.join(ROOT, 'main.js');

const START = '/* ==== INLINE MODULES START ==== */';
const END = '/* ==== INLINE MODULES END ==== */';

function listSources() {
  return fs.readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();
}

function listVendor() {
  if (!fs.existsSync(VENDOR_DIR)) return [];
  return fs.readdirSync(VENDOR_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();
}

/**
 * 第三方 bundle 的包装。
 *
 * mathjax 的 tex-svg.js 是个自执行的 IIFE，它会把 MathJax 实例挂到
 * window.MathJax 上。Obsidian 自己也有一个 window.MathJax（CHTML 形态），
 * 直接执行要么被它当成「已配置」而拒绝初始化，要么把它的实例顶掉。
 *
 * 所以：先把 window.MathJax 存起来并清空，执行 bundle，抓走它新建的实例，
 * 再把原对象还回去。调用方拿到的是 module.exports，全程不碰全局。
 */
function wrapVendor(file, code) {
  const id = 'vendor/' + file;
  const body = code.replace(/\r\n/g, '\n');
  const head = '__mods[' + JSON.stringify(id) + '] = function (module, exports, require) {\n'
    + 'var __hasWin = typeof window !== "undefined";\n'
    + 'var __saved = __hasWin ? window.MathJax : undefined;\n'
    + 'if (__hasWin) window.MathJax = undefined;\n'
    + 'try {\n';
  const tail = '\nmodule.exports = __hasWin ? window.MathJax : undefined;\n'
    + '} finally {\n'
    + '  if (__hasWin) window.MathJax = __saved;\n'
    + '}\n'
    + '};\n';
  return head + body + tail;
}

function wrap(id, code) {
  // 保留原文（含 'use strict'），只在外面套一层 CommonJS 工厂
  const body = code.replace(/\r\n/g, '\n');
  return '__mods[' + JSON.stringify(id) + '] = function (module, exports, require) {\n'
    + body
    + '\n};\n';
}

function main() {
  const files = listSources();
  if (!files.length) {
    console.error('src/ 下没有 .js 文件');
    process.exit(1);
  }

  const chunks = files.map((f) => {
    const id = 'src/' + f;
    const code = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
    return wrap(id, code);
  });

  // 第三方 bundle 排在前面：它们不依赖 src，体量大，放在一起便于辨认
  const vendorFiles = listVendor();
  const vendorChunks = vendorFiles.map((f) => {
    const code = fs.readFileSync(path.join(VENDOR_DIR, f), 'utf8');
    return wrapVendor(f, code);
  });

  const block = START + '\n'
    + '/* 由 build.js 生成，改这里没用，改 src/ 再跑 node build.js */\n'
    + vendorChunks.join('\n')
    + chunks.join('\n')
    + END;

  const text = fs.readFileSync(MAIN, 'utf8');
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a < 0 || b < 0 || b <= a) {
    console.error('main.js 里找不到 INLINE MODULES 标记区');
    process.exit(1);
  }

  const next = text.slice(0, a) + block + text.slice(b + END.length);
  fs.writeFileSync(MAIN, next, 'utf8');

  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  console.log('内联 ' + (files.length + vendorFiles.length) + ' 个模块 → main.js ' + kb(Buffer.byteLength(next, 'utf8')));
  for (const f of vendorFiles) {
    const size = fs.statSync(path.join(VENDOR_DIR, f)).size;
    console.log('  vendor/' + f + '  ' + kb(size));
  }
  for (const f of files) {
    const size = fs.statSync(path.join(SRC_DIR, f)).size;
    console.log('  ' + f.padEnd(14) + kb(size));
  }
}

main();
