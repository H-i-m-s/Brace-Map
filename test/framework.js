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

/* 诊断层正式运行时是关的（DEBUG_LP = false），自测要验它本体，所以这里显式打开 */
if (I && typeof I.dbgSetEnabled === 'function') I.dbgSetEnabled(true);

/*
 * valign 轨迹的电源开关在正式运行时也是关的（关着时渲染路径上一个多余测量都不做）。
 * 自测要验轨迹本体，所以这里统一开着；开关自己的行为由 valtracegate 那组用例
 * 临时关掉再恢复。
 */
if (I && I.valtrace && typeof I.valtrace.setOn === 'function') I.valtrace.setOn(true);

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

module.exports = { I, Plugin, ok, eq, finite, clean, suite, runAll };
