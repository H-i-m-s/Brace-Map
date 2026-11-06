'use strict';

/* ============================================================
 * debug.test.js · 临时诊断层（src/debug.js）
 *
 * 这层只负责取证，但它自己必须是「绝对不炸」的：真机上任何一条诊断抛错
 * 都会连累渲染。所以测三件事：
 *   1. 记录格式：一行一条 JSON，带自增序号与时间戳
 *   2. 绝不外抛：字段函数抛错、参数乱给、没有 DOM，都只能少记一行
 *   3. 落盘：文件名固定、每次整体覆盖、adapter 抛错时退到 console
 * ============================================================ */

const { I, ok, eq, suite } = require('./framework');

/** 造一个只有 tagName / className 的假元素 */
function dom(tag, cls, extra) {
  return Object.assign({ tagName: tag, className: cls }, extra || {});
}

/** 取缓冲区里的记录（已解析） */
function records() {
  const text = I.dbgText();
  if (!text) return [];
  return text.split('\n').filter(Boolean).map((s) => JSON.parse(s));
}

function last() {
  const all = records();
  return all.length ? all[all.length - 1] : null;
}

/* ------------------------------ 记录格式 ------------------------------ */

function tShape() {
  eq(I.DEBUG_LP, false, 'dbg: 正式运行默认关闭（DEBUG_LP = false）');
  I.dbgReset();
  I.dbg('unit.shape', () => ({ a: 1, b: 'two' }));
  I.dbg('unit.shape2', () => ({ c: true }));
  const all = records();
  eq(all.length, 2, 'dbg: 每点一行');
  eq(all[0].p, 'unit.shape', 'dbg: 点名原样落进 p');
  eq(all[0].a, 1, 'dbg: 数值字段');
  eq(all[0].b, 'two', 'dbg: 字符串字段');
  eq(all[1].n, all[0].n + 1, 'dbg: 序号自增');
  ok(typeof all[0].t === 'number' && all[0].t > 0, 'dbg: 带毫秒时间戳');
  eq(I.dbgCount(), 2, 'dbg: 计数与行数一致');
}

function tNeverThrow() {
  I.dbgReset();
  let threw = false;
  try {
    I.dbg('unit.bad', () => { throw new Error('boom'); });
    I.dbg('unit.noarg');
    I.dbg('unit.str', 'not-a-function');
    I.dbg('unit.num', 42);
    I.dbg();
    I.dbgNull('unit.null', 'unit.reason');
  } catch (e) {
    threw = true;
  }
  ok(!threw, 'dbg: 字段函数抛错 / 参数乱给都不外抛');
  const all = records();
  eq(all.length, 6, 'dbg: 六次调用都记下了');
  eq(all[0].thunkError, 'boom', 'dbg: 字段函数的错误被记进 thunkError');
  eq(all[1].v, undefined, 'dbg: 没有字段函数时只有骨架');
  eq(all[2].v, 'not-a-function', 'dbg: 直接给字符串也能记');
  eq(all[3].v, 42, 'dbg: 非对象值落进 v');
  eq(all[5].at, 'unit.reason', 'dbgNull: 记下原因代号');
}

function tClipLong() {
  I.dbgReset();
  const long = 'x'.repeat(2000);
  I.dbg('unit.clip', () => ({ s: long, arr: [1, 2, 3] }));
  const rec = last();
  eq(rec.s.length, I.DEBUG_FIELD_MAX + 1, 'dbg: 超长字符串被截到 FIELD_MAX（末尾加省略号）');
  ok(rec.s.charAt(rec.s.length - 1) === '…', 'dbg: 截断标记是省略号');
  eq(rec.arr, [1, 2, 3], 'dbg: 短数组原样保留');
}

function tBufferCap() {
  I.dbgReset();
  const over = I.DEBUG_LINE_MAX + 200;
  for (let i = 0; i < over; i++) I.dbg('unit.cap', () => ({ i }));
  const all = records();
  ok(all.length <= I.DEBUG_LINE_MAX, 'dbg: 缓冲区不超过上限（实际 ' + all.length + '）');
  ok(all.length < over, 'dbg: 确实裁过（' + all.length + ' < ' + over + '）');
  eq(all[all.length - 1].i, over - 1, 'dbg: 裁剪从头部走，最新一条还在');
  eq(all[0].i, over - all.length, 'dbg: 留下的是一段连续尾巴');
}

/* ------------------------------ 元素取值 ------------------------------ */

function tElInfo() {
  eq(I.dbgEl(null), null, 'dbgEl: null → null');
  eq(I.dbgEl(dom('DIV', 'cm-line cm-active')), 'div.cm-line.cm-active', 'dbgEl: 标签小写 + 逐类点连');
  eq(I.dbgEl(dom('div', '')), 'div', 'dbgEl: 没有类名只留标签');
  // 只有 classList 的元素（假 DOM 常见形态）
  const onlyList = { tagName: 'SPAN', classList: { length: 2, 0: 'a', 1: 'b' } };
  eq(I.dbgEl(onlyList), 'span.a.b', 'dbgEl: 退到 classList');
  // className 过长只取前 80 字符
  const longCls = 'c'.repeat(200);
  const got = I.dbgEl(dom('div', longCls));
  eq(got.length, 'div.'.length + 80, 'dbgEl: className 截到 80 字符');
  // id 带进去
  eq(I.dbgEl(dom('div', 'x', { id: 'main' })), 'div#main.x', 'dbgEl: 带 id');
}

function tRectAndChain() {
  eq(I.dbgRect(null), null, 'dbgRect: null → null');
  eq(I.dbgRect(dom('div', 'x')), null, 'dbgRect: 没有 getBoundingClientRect → null');
  const el = dom('div', 'x', {
    getBoundingClientRect: () => ({ top: 10, left: 20.04, width: 300.06, height: 42.15 }),
  });
  eq(I.dbgRect(el), { top: 10, left: 20, w: 300.1, h: 42.2 }, 'dbgRect: 四舍到 0.1');

  const top = dom('div', 'cm-content');
  const mid = dom('div', 'cm-line', { parentElement: top });
  const self = dom('div', 'cm-embed-block', { parentElement: mid });
  eq(I.dbgChain(self, 3), ['div.cm-embed-block', 'div.cm-line', 'div.cm-content'], 'dbgChain: 自下而上');
  eq(I.dbgChain(self, 2).length, 2, 'dbgChain: 尊重深度');
  eq(I.dbgChain(null), [], 'dbgChain: null → 空数组');
}

function tCssReaders() {
  // 没有 ownerDocument / 全局 getComputedStyle：全部返回空，不抛
  const el = { tagName: 'div', className: 'cm-line', style: { height: '24px' } };
  eq(I.dbgCss(el, ['position', 'height']), {}, 'dbgCss: 没有 computed 环境 → 空对象');
  eq(I.dbgInline(el, 'height'), '24px', 'dbgInline: 读行内原样值');
  eq(I.dbgInline(el, 'minHeight'), '', 'dbgInline: 没写就是空串');
  eq(I.dbgInlineAll(el), '', 'dbgInlineAll: 没有 cssText → 空串');
  eq(I.dbgChildCount(el), -1, 'dbgChildCount: 读不到 → -1');
  eq(I.dbgFirstChild(el), null, 'dbgFirstChild: 没有子元素 → null');

  // 有 computed 环境时按属性取
  const view = { getComputedStyle: () => ({ position: 'relative', height: '24px', minHeight: 'auto' }) };
  const withDoc = { tagName: 'div', className: 'cm-line', ownerDocument: { defaultView: view } };
  eq(I.dbgCss(withDoc, ['position', 'height']), { position: 'relative', height: '24px' },
    'dbgCss: 有 computed 时按属性取');
}

/* ------------------------------ 落盘 ------------------------------ */

function tNoApp() {
  I.dbgReset();
  eq(I.dbgConfigure(null), false, 'dbgConfigure: 没有 app → false');
  eq(I.dbgConfigure({}), false, 'dbgConfigure: app 没有 vault → false');
  eq(I.dbgConfigure({ vault: { adapter: {} } }), false, 'dbgConfigure: adapter 没有 write → false');
}

async function tWrite() {
  I.dbgReset();
  const wrote = [];
  const app = {
    vault: {
      adapter: {
        write: (p, text) => { wrote.push([p, text]); return Promise.resolve(); },
      },
    },
  };
  eq(I.dbgConfigure(app), true, 'dbgConfigure: 有 adapter.write → true');
  I.dbg('unit.write', () => ({ hello: 1 }));
  I.dbgFlush();
  await Promise.resolve();                    // 等写入的 promise 落地，下一轮才不是「正在写」
  await Promise.resolve();
  eq(wrote.length, 1, 'dbgFlush: 落盘一次');
  eq(wrote[0][0], 'brace-map-debug.log', 'dbgFlush: 写到 vault 根目录的固定文件名');
  ok(wrote[0][1].indexOf('"p":"unit.write"') >= 0, 'dbgFlush: 内容含刚才那条记录');
  ok(wrote[0][1].indexOf('"p":"session.start"') >= 0, 'dbgFlush: 首次绑定写了 session.start');

  // 再来一轮：同一文件名、整篇覆盖（含新记录，不是追加）
  I.dbg('unit.write2', () => ({ hello: 2 }));
  I.dbgFlush();
  await Promise.resolve();
  await Promise.resolve();
  eq(wrote.length, 2, 'dbgFlush: 第二次落盘');
  eq(wrote[1][0], 'brace-map-debug.log', 'dbgFlush: 文件名不变（覆盖同一个文件）');
  ok(wrote[1][1].indexOf('"p":"unit.write2"') >= 0, 'dbgFlush: 新记录在里面');
  ok(wrote[1][1].indexOf('"p":"unit.write"') >= 0, 'dbgFlush: 旧记录也在（整篇覆盖而非追加）');
}

function tWriteFailFallback() {
  I.dbgReset();
  const app = {
    vault: { adapter: { write: () => { throw new Error('EACCES: 没有写权限'); } } },
  };
  I.dbgConfigure(app);
  I.dbg('unit.fail', () => ({ x: 1 }));
  const saved = console.log;
  let out = '';
  console.log = (...args) => { out += args.map((a) => String(a)).join(' '); };
  let threw = false;
  try {
    I.dbgFlush();
  } catch (e) {
    threw = true;
  } finally {
    console.log = saved;
  }
  ok(!threw, 'dbgFlush: adapter 抛错也不外抛');
  ok(out.indexOf('unit.fail') >= 0, 'dbgFlush: 写失败退到 console.log，内容里有那条记录');
  ok(out.indexOf('EACCES') >= 0, 'dbgFlush: 失败原因一并说明');
}

suite('debug-log', () => {
  tShape();
  tNeverThrow();
  tClipLong();
  tBufferCap();
});
suite('debug-dom', () => { tElInfo(); tRectAndChain(); tCssReaders(); });
suite('debug-write', async () => { tNoApp(); await tWrite(); tWriteFailFallback(); });
