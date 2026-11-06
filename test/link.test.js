'use strict';

/* ============================================================
 * brace-map selftest · 行内链接：解析、渲染、点击委托
 * ============================================================ */

const { I, ok, eq, finite, clean, suite } = require('./framework');
const { FONT, LAYOUT_OPTS, WRAP_OPTS, fakeView, fakeEl } = require('./helpers');

function fakeEvent(target) {
  const evt = { target, prevented: 0, stopped: 0, ctrlKey: false, metaKey: false };
  evt.preventDefault = () => { evt.prevented++; };
  evt.stopPropagation = () => { evt.stopped++; };
  return evt;
}

function fakeHost() {
  const host = { handler: null };
  host.addEventListener = (type, fn) => { if (type === 'click') host.handler = fn; };
  return host;
}

function tLink() {
  // 1) 四种写法：显示文字与 href
  const wiki = I.parseRuns('[[笔记名]]');
  eq(wiki.length, 1, 'link: [[笔记]] 只有一段');
  eq([wiki[0].text, wiki[0].href], ['笔记名', '笔记名'], 'link: [[笔记]] 文字与 href');

  const alias = I.parseRuns('[[笔记名|别名]]');
  eq([alias[0].text, alias[0].href], ['别名', '笔记名'], 'link: 别名显示、href 仍是目标');

  const heading = I.parseRuns('[[笔记名#标题]]');
  eq([heading[0].text, heading[0].href], ['笔记名 > 标题', '笔记名#标题'],
    'link: 带 # 标题时显示成 笔记 > 标题，href 带 #');

  const md = I.parseRuns('[文字](https://example.com)');
  eq([md[0].text, md[0].href], ['文字', 'https://example.com'], 'link: markdown 链接');

  // 2) 与 <font> 的两种嵌套
  const nested = I.parseRuns('[[笔记|<font color="red">别名</font>]]');
  eq(nested.length, 1, 'link: 别名里带 <font> 仍是一段');
  eq([nested[0].text, nested[0].href, nested[0].color], ['别名', '笔记', 'red'],
    'link: 别名里的 <font> 颜色保留、href 正确');

  const wrapped = I.parseRuns('<font color="red">[[笔记]]</font>');
  eq(wrapped.length, 1, 'link: <font> 包着链接仍是一段');
  eq([wrapped[0].text, wrapped[0].href, wrapped[0].color], ['笔记', '笔记', 'red'],
    'link: <font> 的颜色传给里面的链接');

  // 3) 链接内部的样式标记按字面显示
  const literal = I.parseRuns('[[**粗**]]');
  eq([literal[0].text, literal[0].bold, literal[0].href], ['**粗**', false, '**粗**'],
    'link: 链接里的 ** 不当样式，按字面显示');

  // 4) 普通文本 run 的 href 是 null
  ok(I.parseRuns('普通文字').every((r) => r.href === null), 'link: 普通文本 run 的 href 为 null');

  // 5) 混合行：文字/链接交替，空格不被吃掉
  const mixed = I.parseRuns('看[[笔记]]和[外链](https://x)');
  eq(mixed.map((r) => r.text), ['看', '笔记', '和', '外链'], 'link: 混合行切分顺序');
  eq(mixed.map((r) => r.href), [null, '笔记', null, 'https://x'], 'link: 混合行 href 一一对应');
  eq(I.runsText(I.parseRuns('[[甲]] [[乙]]')), '甲 乙', 'link: 两个链接之间的空格保留');

  // 6) 认不出来的写法保持原行为
  eq(I.parseRuns('[[]]').length, 0, 'link: [[]] 空目标不成链接');
  eq(I.runsText(I.parseRuns('甲![图](x.png)乙')), '甲乙', 'link: 图片语法仍被剥掉');
  eq(I.runsText(I.parseRuns('[[没闭合')), '[[没闭合', 'link: 未闭合 [[ 原样保留');

  // 7) 渲染：class + data-href，颜色跟着 run 自己的 fill
  eq(I.renderRuns(I.parseRuns('[[笔记名]]'), ''),
    '<tspan class="bm-link" data-href="笔记名">笔记名</tspan>', 'link: 链接渲染成带标记的 tspan');
  eq(I.renderRuns(I.parseRuns('[外链](https://x)'), ''),
    '<tspan class="bm-link" data-href="https://x">外链</tspan>', 'link: 外链同样是带标记 tspan');
  eq(I.renderRuns(I.parseRuns('<font color="red">[[笔记]]</font>'), ''),
    '<tspan class="bm-link" data-href="笔记" fill="red">笔记</tspan>',
    'link: 有 <font color> 时 fill 用那个色');

  // 8) 无链接时输出与改造前逐字符一致
  eq(I.renderRuns(I.parseRuns('甲**乙**'), ''), '甲<tspan font-weight="600">乙</tspan>',
    'link: 无链接时渲染结果不变');
  const plain = I.buildSvg(I.parseSource('- 甲**乙**'), LAYOUT_OPTS);
  eq(plain.markup.indexOf('bm-link'), -1, 'link: 无链接的图里没有 bm-link');
  eq(plain.markup.indexOf('data-href'), -1, 'link: 无链接的图里没有 data-href');

  // 9) 端到端：SVG 标记里出现链接 tspan
  const built = I.buildSvg(I.parseSource('- [[笔记名]]'), LAYOUT_OPTS);
  ok(built.markup.indexOf('<tspan class="bm-link" data-href="笔记名">笔记名</tspan>') >= 0,
    'link: SVG 标记里带 class 与 data-href');
  ok(clean(built.markup), 'link: 链接标记干净');

  // 10) 折行后每一段都还带 href
  const wrappedBuilt = I.buildSvg(I.parseSource('maxWidth: 60\n- [[很长很长的笔记名字]]'), WRAP_OPTS);
  const wn = wrappedBuilt.layout.nodes[0];
  ok(wn.lineCount > 1, 'link: 超宽链接会被折行', String(wn.lineCount));
  let keepHref = true;
  for (const l of wn.textLines) {
    for (const p of l.pieces) if (p.href !== '很长很长的笔记名字') keepHref = false;
  }
  ok(keepHref, 'link: 跨行的每一段都还带 href');

  // 11) 事件委托：只挂一个监听在容器上
  const host = fakeHost();
  const seen = [];
  I.bindLinkClicks(host, { openLink: (h, e) => seen.push([h, e]) });
  eq(typeof host.handler, 'function', 'link: 容器上挂上了 click 监听');

  const hitEl = { getAttribute: (k) => (k === 'data-href' ? '笔记名#标题' : null) };
  const evt = fakeEvent({ closest: (sel) => (sel === '[data-href]' ? hitEl : null) });
  host.handler(evt);
  eq(seen.length, 1, 'link: 点中链接时回调一次');
  eq(seen[0][0], '笔记名#标题', 'link: 回调拿到 data-href');
  ok(seen[0][1] === evt, 'link: 回调拿到原始事件对象');
  eq([evt.prevented, evt.stopped], [1, 1], 'link: 点中链接时阻断默认行为与冒泡');

  const miss = fakeEvent({ closest: () => null });
  host.handler(miss);
  eq(seen.length, 1, 'link: 没点中链接时回调不触发');
  eq([miss.prevented, miss.stopped], [0, 0], 'link: 没点中链接时不动事件');

  // 没传 openLink（预览页）：不报错、静默
  const silent = fakeHost();
  I.bindLinkClicks(silent, {});
  let threw = null;
  try { silent.handler(fakeEvent({ closest: () => hitEl })); } catch (e) { threw = e; }
  eq(threw, null, 'link: 没传 openLink 时点击不报错');

  // 12) 导出降级：data-href 与 bm-link 全消失，色回正文
  const view = fakeView();
  const expSvg = fakeEl('svg', { fill: 'rgb(1, 2, 3)' }, view);
  const bodyText = fakeEl('text', { fill: 'rgb(220, 220, 220)' }, view);
  expSvg.appendChild(bodyText);
  const span = fakeEl('tspan', {}, view);
  span.setAttribute('class', 'bm-bold bm-link');
  span.setAttribute('data-href', '笔记名');
  span.style.setProperty('fill', 'rgb(9, 0, 0)');
  span.style.setProperty('text-decoration', 'underline');
  expSvg.appendChild(span);

  eq(I.bodyFillOf(expSvg), 'rgb(220, 220, 220)', 'link: 正文色取自图里第一个 <text>');

  I.stripLinkMarkers(expSvg, 'rgb(220, 220, 220)');
  eq(span.getAttribute('data-href'), null, 'link: 降级后 data-href 消失');
  eq(span.getAttribute('class'), 'bm-bold', 'link: 降级后 bm-link 消失，其它类保留');
  eq(span.style.getPropertyValue('fill'), 'rgb(220, 220, 220)', 'link: 降级后填充色回到正文色');
  eq(span.style.getPropertyValue('text-decoration'), 'none', 'link: 降级后下划线被清掉');
  eq(bodyText.getAttribute('data-href'), null, 'link: 非链接元素不受影响');
  eq(bodyText.getAttribute('class'), null, 'link: 非链接元素不带 class 就是 null');

  // 13) 内链 / 外链判定
  eq(['https://x', 'http://x', 'mailto:a@b', '笔记名', '笔记名#标题'].map((h) => I.isExternalHref(h)),
    [true, true, true, false, false], 'link: 内外链判定');
}

suite('link', tLink);
