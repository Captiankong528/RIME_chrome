# RIME 输入法（DSH Desktop 插件）

把 [`rime-browser-ime`](../rime-browser-ime/) 那套已经跑通的 librime（WebAssembly）
搬进 DSH Desktop：**在会话输入框里直接打拼音／双拼／五笔，候选窗浮在输入卡片上方，
选中的词走宿主自己的编辑器 API 上屏。** 不是另一个页面，也不是复制粘贴。

```
中 ▾   ← 输入框工具行里的胶囊：点「中/EN」开关，点方案名打开方案菜单
┌──────────────────────────────┐
│ ni hao                       │  ← 候选窗（conversation.input.overlay 槽位）
│ 1 你好  2 拟好  3 你  4 尼 …  │
│ 第 1 页       空格上屏·Esc 取消 │
└──────────────────────────────┘
```

## 装与不装

* **装好了**：本目录已经用 `plugin_manager` 的 `install_bundle` 装进当前 profile
  （`~/.dsh/profiles/desktop`），并且该 profile 是「live」的，所以**不用重启**：
  页面刷新一次，输入框右侧就会出现「中 ▾」。
* **关掉/再打开**：DSH 侧边栏 → **插件** → 找到「RIME 输入法」那一行拨开关；
  或者告诉我用 `plugin_manager` 的 `set_plugin`。
* **临时开关输入法**：点胶囊，或按 `Ctrl+Shift+Space`（关着也能用它打开）。

## 怎么用

| 动作 | 按键 |
| --- | --- |
| 开关中文输入 | `Ctrl+Shift+Space`，或点输入框工具行的「中/EN」 |
| 组字 | 直接打字母／五笔码 |
| 选候选 | `1`–`9`、`0`（按方案声明），或鼠标点 |
| 上屏 | `空格` |
| 翻页 | `,` `.`、`-` `=`、`PageUp` / `PageDown`，或候选窗里的 `‹ ›` |
| 取消组字 | `Esc` |
| 切换输入方案 | 候选窗里点方案名（或在组字时按 `F4` 让引擎自己换下一个） |
| 简繁 | 方案菜单里的「简／繁／跟随系统」（只对朙月拼音、双拼这类有开关的方案有效） |

随包 12 个方案：朙月拼音、朙月拼音·语句流、袖珍简拼、自然码/小鹤/微软/智能ABC/拼音加加双拼、
86五笔、86五笔·拼音、86五笔·繁体、五笔画。词频与用户词典存在浏览器的 IndexedDB 里
（librime 的 IDBFS），换会话、重启 App 都还在。

## 它是怎么接进来的

一个包，两个半边：

```
dsh-rime-ime/
├── package.json          dsh.bundle.patch + dsh.client（web 平台，立即激活）
├── cordis.patch.yml      插入一行 rime-ime（Host 半边）
├── index.js              Host：只读 HTTP 路由
├── client.js             Client：按键 → 引擎 → 候选窗 → 上屏
├── worker.js             引擎 Worker 源码（准备资源时复制进 assets/engine/）
├── assets/               生成物，不入库（见 .gitignore）
└── scripts/
    ├── prepare-assets.mjs  从 ../rime-browser-ime 摊出 wasm + 词库
    ├── engine-check.mjs    Node 里跑一遍引擎链路（boot → 装载 → nihao → 你好）
    └── bundle-check.mjs    解析 package.json / manifest / client.js 标记
```

**Host 半边**（`index.js`）挂在 dsh 的 `webServer` 服务上，用 `/rime-ime` 前缀提供：

| 路由 | 用途 |
| --- | --- |
| `GET /rime-ime/config.json` | 默认方案、候选数、是否自检 |
| `GET /rime-ime/engine/*` | `worker.js`、`rime.js`、`rime.wasm`、`rime.data` |
| `GET /rime-ime/schemas/*` | 方案清单与各方案的预编译产物（`.prism.bin` / `.table.bin` / `.yaml`） |
| `POST /rime-ime/diagnostics` | 页面把启动、自检、上屏失败写进诊断日志 |

这些资源是 27 MB 二进制，不能塞进 Client 的 JS bundle，所以走 HTTP 流式返回。
DSH Desktop 的 WebServer 会给渲染进程的请求加一个代际令牌（`x-dsh-desktop-renderer`），
所以只有 App 自己的页面能取到它们；普通浏览器访问返回 403。

**Client 半边**（`client.js`）注册两个槽位：

* `conversation.input.overlay` → 候选窗／方案菜单（浮在输入卡片正上方，
  定位基座就是宿主给输入卡片准备的那个 `overlayAnchor`）；
* `conversation.input.right` → 「中 ▾」胶囊。

按键用 `window` capture 阶段的 `keydown` 截获（只在焦点落在会话输入框的
contenteditable 上时接管），组字期间把事件吞掉；上屏走槽位 props 里的
`inputActions.insertText(text, inputActions.captureInsertion())`——**不碰 DOM**，
所以草稿状态、撤销、占位符、回车提交都和平常一样。

**引擎那条链**：`client.js` 在主线程把 `worker.js` / `rime.js` / `rime.wasm` / `rime.data`
取成字节 → 用 Blob URL 起 Worker → `postMessage` 把字节发进去 → worker 用
`wasmBinary` 与 `getPreloadedPackage` 直接喂给 emscripten。于是 **worker 自己不产生任何
网络请求**，绕开了「Worker 的子请求未必带上渲染进程令牌」这个坑。方案文件同理，
由主线程取好再发，worker 只负责写进 librime 的虚拟文件系统。

## 改的时候

```bash
# 重新摊 assets（改了 worker.js 或要加方案时）
node scripts/prepare-assets.mjs
# 引擎链路自检（不需要浏览器）
node scripts/engine-check.mjs
# 包结构检查
node scripts/bundle-check.mjs
```

> 这台机器上没有独立的 `node`；DSH 自带一个
> （`%APPDATA%\DSH Desktop\runtime-commands\generations\<id>\private\node-bin\node.cmd`，
> 把那个目录加进 `PATH` 就能用 `node`）。

改完 Client 代码要重装包：`plugin_manager` 的 `install_bundle` 再跑一次
（替换已安装的包需要重启才换到新的 JS 代际）。改 Host 代码后 `set_plugin` 开关一次即可。

**页面自检**：每次页面加载、引擎就绪后，Client 会在后台打一遍 `nihao` + 空格，
把结果写进诊断日志：

```
%DSH_HOME%\logs\rime-ime-diagnostics.log
```

里面会看到 `client-ready` / `config` / `engine-assets` / `selftest`（`ok: true` 且
`committed: "你好"`）/ `layout` / `commit`。引擎或路由出问题时，这份日志是第一现场。

## 许可

引擎是上游 [LibreService/my_rime](https://github.com/LibreService/my_rime) 的
librime WebAssembly 构建（AGPL-3.0-or-later，© Qijia Liu），输入方案随各自的
`@rime-contrib/*` 包分发。本插件沿用 **AGPL-3.0-or-later**。
