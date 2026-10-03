# 架构说明

## 整体数据流

```
用户敲键盘
   │
   ▼
content script（每个 frame 一份，isolated world）
   │  keydown 捕获阶段拦截 -> 翻译成 RIME 按键串
   │  chrome.runtime.sendMessage({ to: 'engine', op, payload })
   ▼
background（路由器 + 开关状态：Chrome 是 service worker，Firefox 是背景事件页）
   │  src/background/engine-bridge.js 按能力探测，把请求分到两条路之一
   │
   │   Chrome（有 chrome.offscreen）          Firefox（没有 chrome.offscreen）
   │   ──────────────────────────────         ─────────────────────────────────
   │   ① 按需创建 / 唤醒 offscreen 文档        ① 引擎就地跑在背景页同一个上下文里
   │   ② runtime.sendMessage 转发，带退避重试     （一跳都没有，直接函数调用）
   ▼
引擎宿主 src/engine/host.js（两条路共用同一份实现）
   │  ③ 从 schemas/ 读预编译方案文件（fetch + 缓存）
   │  ④ postMessage RPC
   ▼
Web Worker（src/engine/worker.js）
   │  importScripts('rime.js')  ->  emscripten 产物
   ▼
librime（WebAssembly，含 opencc / 用户词典 IndexedDB 持久化）
```

## 为什么这样分层

### 引擎为什么不在 content script 里

直观做法是把 wasm 直接放进 content script，省掉三层转发。但：

- content script 跑在页面的 **isolated world** 里，页面 CSP 会影响 `WebAssembly`
  的编译（`wasm-unsafe-eval`）；扩展自己的 CSP 管不到页面的策略。
- 每个标签页、每个 iframe 都要重新编译 2.8MB 的 wasm、重新装载方案，
  内存和启动时间都成倍增长。

放在扩展自己的上下文里，页面策略完全无关，全浏览器只有一份实例。

### 引擎为什么不在 service worker 里（Chrome）

MV3 的 service worker 空闲约 30 秒就被回收。librime 的初始化要编译 wasm、
读 1.1MB 预置数据、挂载 IndexedDB，每次唤醒重建实例会让「第一次按键」明显卡顿。
offscreen document 是一个真正的隐藏页面，不会被空闲回收，适合当常驻宿主。

还有一条更硬的：**SW 的 CSP 由浏览器固定**（`script-src 'self'`，不给
`wasm-unsafe-eval`），wasm 在 SW 里根本编译不了。这不是性能取舍，是能力问题。

### Firefox：引擎为什么住在背景页里

Firefox **没有 `chrome.offscreen`**；而 MV3 的背景页只能是**非持久**事件页
（`persistent: true` 在 MV3 下直接报错），空闲同样会被卸载。所以那边的做法是：

- 引擎**就地**跑在背景页的上下文里（`engine-bridge.js` 的 local 分支）。背景页是
  真正的页面，可以直接 `new Worker(...)`，于是整条链路少掉「offscreen 文档 +
  一次跨进程消息 + 首帧退避重试」这一整套。
- 代价：事件页被卸载时 Worker 跟着死，下一次按键要重新编译 wasm、重新装载方案
  （用户词典在 IndexedDB 里，不会丢）。为了少付这个代价，宿主是**惰性**创建的：
  用户一开开关，background 的 `warmUp()` 就会发 `STATUS`，宿主随之诞生；
  半夜被「改一次设置」这类无关事件唤醒时，不会白白编译 2.8MB 的 wasm。
- 又因为是**同一个上下文**，`engineRequest` 从「跨进程消息 + 超时重试」退化成一次
  函数调用，`Receiving end does not exist` 这一整类失败模式在 Firefox 下不存在。

两条路共用同一份宿主实现（`src/engine/host.js`），所以「读方案 → set_ime → 按键 →
上屏」的行为在两个浏览器里完全一致。差异被压缩成 `engine-bridge.js` 里的一次能力探测：

```js
export const MODE = chrome.offscreen && typeof chrome.offscreen.createDocument === 'function'
  ? 'offscreen'
  : 'local'
```

> 为什么不嗅探 UA：能力探测在两边都成立，而且将来谁先补上 API 都不用改代码
> （Firefox 万一实现了 `offscreen`，这里会自动切过去）。

Firefox 侧的清单是**构建期生成**的（`scripts/lib/manifest.mjs`），与 Chrome 的差别只有四处，
每处都有原因：

| 差异 | 原因 |
| --- | --- |
| `background.service_worker` → `background.scripts` + `type: module` | Gecko 不支持 MV3 service worker（bug 1573659），只支持背景页面 |
| 去掉 `minimum_chrome_version` | 对 Firefox 无意义 |
| `permissions` 去掉 `offscreen` | 那边没有这个 API，留着会在安装时报未知权限 |
| 加 `browser_specific_settings.gecko`（id + `strict_min_version: 109.0`） | 签名分发需要稳定 id；MV3 从 109 开始 |

CSP 原样保留：MV3 里 `extension_pages` 的 `script-src` 只允许
`'none'` / `'self'` / `'wasm-unsafe-eval'`，而**不给** `'wasm-unsafe-eval'` 时
Gecko 会拒绝编译 wasm。Chrome 103+ 的要求一模一样。

### 为什么没有构建步骤

上游 `pnpm run lib` + `pnpm run wasm` 需要 emsdk、CMake、Ninja、LLVM 以及
boost / leveldb / marisa / opencc / yaml-cpp / glog 六个子模块，Windows 上首次构建
通常以小时计。而这些产物上游已经发布在 npm 上：

| 文件 | 来源 | 说明 |
| --- | --- | --- |
| `src/engine/rime.js` | `@libreservice/my-rime/dist/rime.js` | emscripten 胶水代码 |
| `src/engine/rime.wasm` | 同上 | librime + `wasm/api.cpp` 的编译结果 |
| `src/engine/rime.data` | 同上 | 预置文件系统：opencc 数据、`default.yaml`、lua 脚本 |
| `schemas/<target>/*` | `@rime-contrib/<target>` | **已经用原生 `rime_api_console` 部署好的** `.table.bin` / `.prism.bin` / `.schema.yaml` |

所以 `scripts/fetch-assets.mjs` 一条命令就把引擎和方案拿全了。等真的需要改
`wasm/api.cpp`（比如加新导出函数）时，再按上游 README 装工具链也不迟。

## 关键实现点

### 1. 引擎加载（`src/engine/worker.js`）

`rime.js` 是 emscripten 的**经典脚本**产物，它：

- 读取全局 `var Module`，所以必须在 `importScripts` 之前把 `self.Module` 准备好；
- 用 `XMLHttpRequest` 拉同目录下的 `rime.data`；
- 用 `scriptDirectory`（即 worker 脚本所在目录）拼出 `rime.wasm` 的路径。

因此 `worker.js` 必须和 `rime.js` / `rime.wasm` / `rime.data` 放在同一目录
（`src/engine/`）。这一点不要动。

启动顺序：`FS.mkdir('/rime')` → `FS.mount(IDBFS, {}, '/rime')` → `syncfs(true)`
读回用户词典 → `ccall('init')` → `set_schema_name(...)` → `set_page_size(...)`。

### 2. offscreen 文档的生命周期（Chrome 那条路）

**offscreen 文档只有极少数几个扩展 API。** 实测（Chrome 151 与 Chrome for Testing 154）：
`chrome.runtime` 可用，但 **`chrome.storage` 是 `undefined`**。这不是小事——在模块
顶层读 `chrome.storage` 会让整个文档加载失败，连 `chrome.runtime.onMessage` 都注册
不上，而页面侧只会看到 `Could not establish connection. Receiving end does not exist.`，
看上去像 service worker 挂了，实际原因完全在别处。

所以 offscreen 只用 `chrome.runtime`；方案 id、页大小这类设置一律由 background 随请求
下发，或者由 `init` 送进来。模块顶层只做一件事：启动引擎。

**`createDocument()` resolve ≠ 监听器已就绪。** 那之前还有 `createWorker()`（要
`importScripts` 那个 114 KB 的 emscripten 胶水代码）、错误监听注册、引擎启动。
在这个窗口里 `sendMessage` 抛的还是同一句 `Receiving end does not exist.`，
所以 background 侧对「消息根本没投递」这一类错误做带退避的重试——
只重试这一类（消息没被投递，重发不会重复处理），业务错误直接抛出去。

`createDocument` 同时只允许存在一个文档，重复调用会抛错。判断「是否已存在」看起来
该用 `chrome.offscreen.hasDocument()`，但它标注 `@since Chrome 150`：在 116–149 上
它是 `undefined`，直接调用会 `TypeError`，失败点同样在按键那一刻。所以
`ensureOffscreen()` 做成三层兜底：

1. 有 `hasDocument` 就用它；
2. 没有就退回「本 SW 生命周期内是否成功建过」这个内存标记；
3. 真重复调了，把 `createDocument` 抛出的「只能有一个 offscreen 文档」当成
   「已存在」吞掉——因为无论文档是这次建的还是上个 SW 生命周期建的，
   后面的 `runtime.sendMessage` 都能送达。

### 3. 失败必须可见

offscreen 是个独立页面，它里面的未捕获异常不会冒到 service worker 或页面，
默认表现就是「用户敲了字，什么也没发生」。因此：

- `new Worker(...)` 本身抛错（例如 CSP 不允许）时被 `try/catch` 接住，
  转成一条 `error` 状态推给 background，再广播到页面显示；
- 模块级注册了 `error` / `unhandledrejection` 监听，把漏网异常也转成同一条通道；
- 所有等待中的 RPC 一并 reject，不会留下永远挂起的 Promise。

> Firefox 那条路（引擎在背景页里）不需要这两个全局监听：未捕获异常本来就落在背景页
> 自己的控制台（`about:debugging` → 检查），让它们再去改写引擎状态只会把别人家的
> 报错误标成「输入法坏了」。`Worker.onerror` 与 RPC reject 依旧会把引擎侧的错误
> 变成一条能看见的状态。

### 4. 方案装载（免部署）

桌面 RIME 的安装流程是「写 schema → 跑一次部署，把 `.dict.yaml` 编译成
`.table.bin` / `.prism.bin`」。浏览器里跑完整部署既慢又要额外的 native 产物。

`@rime-contrib/*` 包里已经是编译好的结果，所以只要把它们写进
`/usr/share/rime-data/build/`，再调 `set_ime(schemaId)` 让 librime 直接选中即可，
完全跳过部署。唯一的代价是初始启用时不能热改方案，改方案要重新取包。

正因为不跑部署，协议里**刻意没有 `deploy` 这个操作**。librime 的 `start_maintenance`
在结束时会回调 `api.cpp` 里的 `_deployStatus`（一个 `EM_ASM`），而我们的 worker
从未定义这个全局函数——留一个半通的 `deploy` 只会制造一个调用即崩、又很难查的入口。
真要支持运行时部署，需要连同 `.dict.yaml` 的资产管线一起做，那时再把
`_deployStatus` 和部署进度一起补上。

### 5. 按键映射（`src/content/ime.js`）

DOM 的 `KeyboardEvent` 需要翻译成 librime 的按键序列语法：

- 普通可打印字符直接发字符本身（`a`、`1`、` `）；
- 带修饰键或功能键发 `{Control+Shift+a}`、`{BackSpace}`、`{Return}` 这种花括号形式；
- 小键盘发 `{KP_1}`；
- 松键发 `{Release+a}`（某些方案依赖 release 语义）。

未组字时只接管「可打印字符」和 `F4`（切换方案），Ctrl/Alt/Meta 组合一律放给页面，
避免和网站快捷键打架。

还有一条容易被忽略：**键盘事件从 Shadow DOM 里冒出来时，`event.target` 会被重定向成宿主元素**
（`<my-input>` 之类），而宿主通常不是可编辑元素。直接用 `event.target` 判断的结果是
整类 Web Component 站点（YouTube、Reddit、Salesforce 等）完全用不了输入法。
所以取目标统一走 `event.composedPath()[0]`，拿不到（或抛错）时才退回 `event.target`。

### 4. 上屏（`src/content/ime.js`）

`contenteditable` 走三步，**顺序不能换**：

1. **先派发一个合成的 `beforeinput`**（`inputType: 'insertText'`、`data` 是本次要上屏的文本）。
   富文本编辑器的文档模型就是在 `beforeinput` 里更新的：它们在那里面 `preventDefault()`，
   然后自己把文本写进模型并重渲染 DOM。所以派发完**只看 `defaultPrevented`**：
   页面接管了就到此为止，剩下的 DOM 由页面自己写。
2. 页面没接管（普通 `contenteditable`、页面里没有编辑器）→ `document.execCommand('insertText')`，
   它能正确进入撤销栈，React / Vue 的受控组件也能从 `input` 事件感知。
3. 返回 false → 用 `Range` 插入文本节点，再手动派发 `input`。

`input` / `textarea` 不走这条路（受控组件本来就从 `input` 事件同步值），
仍然是 `execCommand` → 原生 `value` setter + 手动 `InputEvent` 两步。

> **为什么第 1 步必须在、而且必须在前面**：Chrome 的
> `document.execCommand('insertText')` **只派发 `input`，不派发 `beforeinput`**
> （真机实测，连最普通的 `contenteditable` 也一样；真人打字才是
> `beforeinput → textInput → input`）。
> 而模型驱动的编辑器收不到 `beforeinput` 就不会更新模型，于是出现
> **DOM 里有字、页面模型里没字**：占位符不消失（和刚打进去的字叠在一起）、
> 页面提交/翻译读到的是空内容，下一次按模型重渲染还会把这几个字**抹掉**。
>
> 百度翻译（`fanyi.baidu.com/mtpe-individual`，输入框是 Slate 编辑器）就是这样翻车的，
> 而且只在**空输入框第一次输入**时复现——恰好是每个人打开页面后的第一个动作。
> 编辑器里已经有内容时，同一条 `execCommand` 反而能被模型吸收，所以这个问题很容易漏测：
> 离线断言全绿、普通网页也正常，只有「空富文本框 + 首次输入」才炸。

### 5. 候选窗定位（`src/content/caret.js`）

- `input` / `textarea`：建一个隐藏的镜像 `div`，把排版相关样式整份复制过去，
  把光标前的文本塞进去、光标处插一个 `span`，量这个 `span` 的 `offsetLeft/Top`。
  单行输入框内部是垂直居中的，所以镜像的行高要撑到内容高度才对得上。
- `contenteditable`：`Selection.getRangeAt(0).getBoundingClientRect()`；
  空行量不到尺寸时临时插一个零宽字符再量。
  如果编辑区在 Shadow DOM 里，`document.getSelection()` 拿到的是被重定向到宿主的结果，
  得改用 `ShadowRoot.getSelection()`（Chrome 支持，非标准）。
- 兜底：退回元素外框。

候选窗本体在 Shadow DOM 里，`host` 上先 `all: initial`，页面样式进不来；
挂载点是 `<html>` 而不是 `<body>`——页面给 `body` 加 `transform`/`filter` 时，
`position: fixed` 的包含块会变成那个元素，候选窗就会跟着页面一起偏移。

### 6. 状态与开关

- 开关存在 `chrome.storage.local`，全局生效（不分标签页）。
- 变化同时通过 `chrome.tabs.sendMessage` 广播和 `chrome.storage.onChanged` 兜底，
  后者是为了让扩展自己的页面（演练场）也能收到。
- 工具栏徽标显示 `中` / `EN`。
- **点工具栏图标不再直接切中/英，而是弹出一个面板**（`action.default_popup` →
  `src/popup/`）。配了 `default_popup` 之后 `action` 的点击事件永远不会触发，
  所以 service worker 里不再注册它；快捷键 `Ctrl+Shift+Space` 仍然直接开关。
  面板只放最常用的三件事（开关 / 输入法 / 简繁），并且**刻意走两条已有的路**，
  不新增协议：开关与方案发给 background（`toggle` / `setSettings`，和设置页下拉框同一条），
  简繁直接写 `chrome.storage.local`（和右下角状态栏同一条）。

## 目录结构

```
rime-browser-ime/
├── manifest.json              # Chrome 的 MV3 清单（扩展根目录 = 仓库根目录，所以无需打包）
│                              # Firefox 那份由 scripts/build-firefox.mjs 生成，不落进仓库
├── icons/                     # 图标，由 scripts/make-icons.mjs 生成
├── licenses/                  # 上游 AGPL 许可原文
├── schemas/                   # 预编译输入方案（@rime-contrib/*）
│   ├── manifest.json          # 由 fetch-assets.mjs 生成的文件清单
│   ├── luna-pinyin/
│   └── stroke/
├── scripts/                   # 开发/构建脚本（不参与扩展运行时）
│   ├── lib/zip.mjs            # 最小 ZIP 写入器（打包共用）
│   ├── lib/files.mjs          # 运行时文件收集（三个打包脚本共用）
│   ├── lib/manifest.mjs       # Chrome 清单 → Firefox 清单（构建与自检共用一份转换）
│   ├── check.mjs              # 静态自检（含 Firefox 清单与平台层不变量）
│   ├── engine-smoke.mjs       # 引擎全链路（在 Node 里跑真 wasm）
│   ├── content-smoke.mjs      # content 逻辑
│   ├── ipc-smoke.mjs          # IPC 全链路：--platform=chrome|firefox 两条宿主都跑
│   ├── e2e-test.mjs           # Chrome 真机端到端（Chrome for Testing + CDP）
│   ├── e2e-firefox.mjs        # Firefox 真机端到端（geckodriver + WebDriver）
│   ├── pack-crx.mjs           # 打包成可安装的 crx + zip + 解压目录（Chrome 主入口）
│   ├── package.mjs            # 只出 zip
│   ├── build-firefox.mjs      # 构建 Firefox 包（换清单 + 出 zip 与免解压目录）
│   └── fetch-assets.mjs / make-icons.mjs / verify-crx.mjs
└── src/
    ├── common/const.js        # 消息类型 / 方案注册表 / 简繁默认值（content 与扩展页面共用）
    ├── background/
    │   ├── service-worker.js  # 路由 + 开关 + 状态广播（Chrome=SW，Firefox=背景页，同一份）
    │   └── engine-bridge.js   # 平台分流：offscreen 文档 vs 背景页就地宿主
    ├── offscreen/{offscreen.html,offscreen.js}   # Chrome 宿主的外壳
    ├── engine/{host.js,worker.js,rime.js,rime.wasm,rime.data}   # 后三个是 vendored
    ├── content/{caret,candidate-window,ime,status-bar,bootstrap}.js
    ├── options/{options.html,options.js}          # 完整设置页（自检 / 候选数 / 说明）
    ├── popup/{popup.html,popup.js}                # 工具栏面板（点图标弹出的小设置页）
    └── playground/playground.html
```

## 扩展新输入方案

1. 在 `scripts/fetch-assets.mjs` 的 `SCHEMA_PKGS` 里加上目标（对应上游
   `schemas.json` 里的 `target` 字段），运行 `node scripts/fetch-assets.mjs --all`。
2. 在 `src/common/const.js` 的 `SCHEMAS` 里注册：`{ id, name, targets: [...] }`，
   `id` 是方案 id（如 `double_pinyin`），`targets` 是它依赖的所有包目录。
3. 重新加载扩展。设置页面的下拉框会自动出现新方案。

## 已知限制

- 只处理 `input[type=text|search|url|tel|email]`、`textarea` 和 `contenteditable`；
  密码框和 `type=number` 不接管。
- 页面自带的输入法（如系统中文输入法）优先级更高：检测到 `isComposing` 会让行。
- 跨 iframe 的候选窗会被 iframe 边界裁剪（浏览器限制，无法渲染到父页面之上）。
- `chrome://`、扩展商店等受保护页面无法注入 content script。
- **Firefox 版的事件页会被卸载**：闲置约 30 秒后引擎随之销毁，下一次按键要重新
  编译 wasm + 装载方案（用户词典不丢）。Chrome 版没有这个问题——offscreen 文档常驻。
- **Firefox 没有 `ShadowRoot.getSelection()`**（Chrome 的非标准扩展）：候选窗在
  Shadow DOM 里的编辑器（YouTube 评论、Reddit 等 Web Component 站点）只能退回
  元素外框定位。输入本身不受影响。
- Firefox 的**正式安装需要签名**（AMO 或其自助分发签名）；未签名的包只能在
  Nightly / Developer Edition / ESR 上装，或每次用 `about:debugging` 临时载入。
