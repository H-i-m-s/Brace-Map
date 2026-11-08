# Brace Map

把 Obsidian 代码块里的缩进列表渲染成教材里的括号图。

````markdown
```brace
- 系统
  - 硬件
    - 传感器
    - 执行器
  - 软件
    - 固件
```
````

缩进决定层级，`-` 决定节点。出图是 SVG，可以导出 PNG。

> Render indented lists inside a code block as brace diagrams. Chinese-first; the syntax itself is language-agnostic.

---

## 安装

**手动**

1. 到 [Releases](../../releases) 下载最新的 `brace-map-x.y.z.zip`
2. 解压，把得到的 `brace-map` 文件夹整个放进 `<你的库>/.obsidian/plugins/`
3. 重启 Obsidian，在「设置 → 第三方插件」里启用 Brace Map

**BRAT**

在 BRAT 里添加 `H-i-m-s/Brace-Map`。

---

## 能做什么

| | |
|---|---|
| **四种方向** | `dir: lr` / `rl` / `tb` / `bt` |
| **两种括号** | `brace: curly` 大括号、`brace: square` 方括号 |
| **按层加框** | `box: 1,2` |
| **单点加框** | 行尾写 `{box}` |
| **末端总括号** | `closing: true` 框全部，`closing: 甲, 乙` 点名，可写多条 |
| **分组标签** | `closing: 动力组 = 电动机, 内燃机` |
| **节点折行** | `maxWidth: 260` |
| **图文混排** | `float: right` + `width: 300` + `valign: middle` |
| **行内样式** | 颜色、粗斜体、删除线、双链、外链 |
| **LaTeX 公式** | `$x^2$`，矢量内嵌，导出不丢 |
| **导出** | PNG（2x，透明底可选）与 SVG |

### 一个带分组的例子

````markdown
```brace
title: 机械系统的组成
brace: square
box: 1
closing: 动力组 = 电动机, 内燃机, 齿轮
closing: 全部 = true
- 动力系统
  - 电动机
  - 内燃机
- 传动系统
  - 机械传动
    - 齿轮
    - 带传动
  - 液压传动
- 执行系统
- 控制系统
  - 开环
  - 闭环
```
````

---

## 文档

- **[语法手册](doc/README.md)** — 每个指令的取值、默认值、示例
- **[踩坑记录](doc/踩坑记录.md)** — 开发过程中「看起来该 work 但不 work」的问题，以及为什么
- **使用手册** — 完整版在本地笔记里，语法手册覆盖了同样的内容

## 已知边界

有几处是**有意不做**的，不是遗漏，每条都写清了理由和以后要做的入口，见语法手册的「有意不做」一节。简单说：

- `box` 不支持 `1-3` 范围写法
- `closing` 点不到多行文字（含 `<br>` 或续行）的节点
- 竖向图里 `closing` 标签仍横排，长组名会把画布撑宽
- 标签不解析行内标记
- 编辑模式和阅读视图是两套浮动实现

## 开发

```bash
node build.js        # 把 src/ 内联成 main.js
node test/run.js     # 2311 项自测
pwsh -File release.ps1   # 打包 dist/ 与 release 附件
```

**注意 `main.js` 必须提交。** 它是构建产物，但移动端 Obsidian 没有文件系统的 `require`，插件只能靠这份自包含的文件运行。改了 `src/` 之后要跑 `build.js` 并一起提交。

## 许可

[MIT](LICENSE)
