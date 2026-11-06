'use strict';

/* ============================================================
 * brace-map · 浏览器端 CommonJS 加载器
 *
 * preview.html / calib-test.html 是直接在浏览器里打开的，没有 Node 的
 * require。插件本体拆成 src/*.js 之后，这里给页面补一个同步的 require：
 *
 *   window.module   页面级模块对象，main.js 的 module.exports 落在它上面
 *   window.require  只认相对路径（'./src/text' → './src/text.js'）与 'obsidian'
 *
 * 实现都用同步 XMLHttpRequest（open(url, false)），所以只能在 http(s) 下用；
 * file:// 下浏览器会拒绝同步 XHR。起个静态服务器（例如
 * `python -m http.server` 指向插件目录）再打开页面即可。
 * ============================================================ */

(function () {
  'use strict';

  // 加载器自己的 URL：按它解析相对路径，页面挪位置也不影响
  var LOADER_URL = (function () {
    try {
      if (document.currentScript && document.currentScript.src) return document.currentScript.src;
    } catch (e) {
      /* 拿不到就退回文档地址 */
    }
    return document.baseURI;
  })();

  var BASE = LOADER_URL.replace(/[^/]*$/, '');   // 去掉文件名，留下目录（含结尾 /）

  // 已加载模块：url → { exports }。同一文件只执行一次
  var cache = Object.create(null);

  // 浏览器里没有真的 obsidian 模块，给个最简替身（与拆分前页面里的桩一致）
  var OBSIDIAN_STUB = { Plugin: class {} };

  /** './src/text' / 'src/text.js' / '../x' → 绝对 URL（相对 fromDir 解析） */
  function resolveId(id, fromDir) {
    var s = String(id == null ? '' : id).replace(/\\/g, '/');
    // 带协议的、绝对路径的一律不接受；其余（含不带前缀的 'src/x.js'）
    // 都按 fromDir 相对解析——main.js 的 loadModules 在浏览器里就是发 'src/opt.js'。
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.charAt(0) === '/') {
      throw new Error('preview-loader: 只支持相对路径 require("' + id + '")');
    }
    var url;
    try {
      url = new URL(s, fromDir).href;
    } catch (e) {
      url = fromDir + s.replace(/^\.\//, '');
    }
    return /\.js$/.test(url) ? url : url + '.js';
  }

  /** 同步取一个文件，取不到就抛，别让后面的模块在半空里跑 */
  function fetchSync(url) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    try {
      xhr.send(null);
    } catch (e) {
      throw new Error('preview-loader: 取不到 ' + url + '（' + (e && e.message ? e.message : String(e)) + '）');
    }
    var okStatus = (xhr.status >= 200 && xhr.status < 300) || (xhr.status === 0 && xhr.responseText);
    if (!okStatus) {
      throw new Error('preview-loader: 取不到 ' + url + '（HTTP ' + xhr.status + '）');
    }
    return String(xhr.responseText || '');
  }

  /** 按 CommonJS 语义执行源码：module / exports / require / __filename / __dirname */
  function execute(url, code) {
    var mod = { exports: {}, id: url };
    cache[url] = mod;                             // 先入表：真出现循环依赖也能拿到半成品
    var body = String(code).replace(/^#![^\n]*/, '');
    var fn = new Function('module', 'exports', 'require', '__filename', '__dirname', body);
    fn(mod, mod.exports, makeRequire(url), url, url.replace(/[^/]*$/, ''));
    return mod.exports;
  }

  function load(url) {
    if (cache[url]) return cache[url].exports;
    return execute(url, fetchSync(url));
  }

  /** 为某个模块造一个 require：相对路径按该模块所在目录解析 */
  function makeRequire(fromUrl) {
    var fromDir = String(fromUrl || LOADER_URL).replace(/[^/]*$/, '');
    return function require(id) {
      if (id === 'obsidian') return OBSIDIAN_STUB;
      return load(resolveId(id, fromDir));
    };
  }

  // 页面级壳子：main.js 以普通 <script> 引入，它的 module.exports 落在这里，
  // calib-test.html 读的就是 window.module.exports.__internals。
  window.module = { exports: {} };
  window.require = makeRequire(BASE + 'main.js');

  // 手动调试用：控制台里 __braceMapRequire('./src/text')
  window.__braceMapRequire = window.require;
})();
