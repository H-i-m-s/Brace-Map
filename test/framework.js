'use strict';

/* ============================================================
 * brace-map selftest · 测试框架
 *   断言：ok / eq / finite / clean
 *   登记：suite(name, fn) 依次登记，runAll() 按登记顺序跑并汇总
 * 无 DOM 环境：stub 掉 require('obsidian')，measure 全部注入 mock。
 * ============================================================ */

const Module = require('module');
const path = require('path');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return { Plugin: class {} };
  return origLoad.call(this, request, parent, isMain);
};

const Plugin = require(path.join(__dirname, '..', 'main.js'));
const I = Plugin && Plugin.__internals;

/* ------------------------------ 断言 ------------------------------ */

let passed = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) {
    passed++;
  } else {
    failures.push(label + (detail ? '  → ' + detail : ''));
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, label, 'got ' + a + ', want ' + b);
}

function finite(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function clean(s) {
  return !/NaN|undefined/.test(String(s));
}

/* ------------------------------ 用例登记 ------------------------------ */

const registered = [];

function suite(name, fn) {
  registered.push([name, fn]);
}

/**
 * 按登记顺序跑完全部用例，输出与拆分前逐行一致；有失败即退出码非 0。
 * 用例可以返回 Promise（公式转换是异步的），返回 thenable 时等它跑完再算一项。
 */
async function runAll() {
  for (const [name, fn] of registered) {
    const before = failures.length;
    try {
      const ret = fn();
      if (ret && typeof ret.then === 'function') await ret;
    } catch (err) {
      failures.push(name + ' threw: ' + (err && err.stack ? err.stack : err));
    }
    console.log((failures.length === before ? 'ok   ' : 'FAIL ') + name);
  }

  console.log('');
  console.log('passed: ' + passed + ', failed: ' + failures.length);
  if (failures.length) {
    console.log('');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

module.exports = { I, ok, eq, finite, clean, suite, runAll };
