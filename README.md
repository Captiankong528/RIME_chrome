# RIME_chrome

把 **[LibreService/my_rime](https://github.com/LibreService/my_rime)**（一个把 librime
编译成 WebAssembly 的在线输入法 PWA）改造成 **浏览器扩展形态的输入法**，
一套源码出 Chrome / Firefox 两个包。上游项目：<https://github.com/LibreService/my_rime>

| 路径 | 用途 |
| --- | --- |
| [`rime-browser-ime/`](rime-browser-ime/) | 项目本体：一个 Manifest V3 扩展，在任意网页上提供 RIME 输入。**仓库里只有这一个目录是源码。** |

另外三份文档：**[`CHANGELOG.md`](CHANGELOG.md)** 记录做过什么、为什么这么做
（含环境陷阱、CRX3 格式、Firefox 移植、常用命令速查与架构速查）；
**[`TODO.md`](TODO.md)** 记录还没做和还没验的事；
**[`LICENSE`](LICENSE)** 是 AGPL-3.0 全文（见文末「许可」）。

> 开发时工作区里还放过 `reference/`（上游仓库的克隆，只读参考，master 停在
> `c73ea17 "0.10.9: emscripten 3.1.63"`）和 `.tools/`（Chrome for Testing / Firefox /
> geckodriver，约 1.1 GB）。**两者都不入库** —— 上游随时可以自己 clone，
> 浏览器见 [`CHANGELOG.md`](CHANGELOG.md) 附录 B 的说明。

## 快速开始

**装成品**（推荐）：先打包一次，然后把 crx 拖进浏览器即可。

```bash
cd rime-browser-ime
node scripts/pack-crx.mjs
# -> dist/rime-browser-ime-0.1.0.crx   ← 把它拖进 chrome://extensions（需先开开发者模式）
```

**从源码装**（开发用）：

1. 打开 `chrome://extensions` → 右上角开「开发者模式」→ **加载已解压的扩展程序** → 选择
   [`rime-browser-ime/`](rime-browser-ime/) 目录
2. 点工具栏图标弹出小面板（开关 / 输入法 / 简繁），在里面点「开启输入法」；徽标从 `EN` 变 `中`。
   也可以直接按 `Ctrl+Shift+Space` 开关
3. 打开扩展的**设置页**，点 **运行自检** —— 它会逐层跑一遍整条输入链路，哪一层断了直接告诉你原因
4. 通过之后，在任意网页的输入框里敲 `nihao` + 空格，应该得到「你好」

`rime-browser-ime/` 里没有任何构建步骤，改完源码在 `chrome://extensions` 点一下
「重新加载」即可生效。三种安装方式的取舍见
[`rime-browser-ime/README.md`](rime-browser-ime/README.md) 的「安装」一节；
打包产物共约 36 MB（主要是 15 个输入方案的预编译词典），压缩后 16.5 MB。

## 为什么要改造

参考项目是一个**独立的静态网站**：用户要先打开 `my-rime.vercel.app`，在那个页面里的
输入框打字，再把结果复制出去。我们的目标是让输入直接发生在**用户当前所在的网页**上，
不需要切换标签页，也不需要复制粘贴。为此做了三件事：

1. **引擎搬进 offscreen document + Web Worker**，不绑定任何页面，长期常驻。
2. **新增 content script**：捕获按键、跟随光标显示候选窗、把结果注入到页面的
   `input` / `textarea` / `contenteditable`。
3. **放弃构建工具链**：上游需要 emsdk + CMake + Ninja + LLVM 才能产出 wasm，
   我们直接消费它发布在 npm 上的预编译产物。

细节见 [`rime-browser-ime/docs/ARCHITECTURE.md`](rime-browser-ime/docs/ARCHITECTURE.md)。

## 验证状况

| 层 | 命令 | 结果 |
| --- | --- | --- |
| 静态自检 | `node scripts/check.mjs` | 184 项通过 |
| 引擎全链路 | `node scripts/engine-smoke.mjs` | 27 项通过（真实 librime wasm，`nihao` + 空格 → 你好） |
| content 逻辑 | `node scripts/content-smoke.mjs` | 73 项通过 |
| IPC 全链路 | `node scripts/ipc-smoke.mjs` | 21 项通过（content → SW → offscreen → librime 往返） |
| 浏览器集成 | `node scripts/e2e-test.mjs` | **已跑通**：真实 Chrome 加载扩展，演练场与普通 HTTP 网页上 `nihao` + 空格 → 你好；**15 个输入方案逐个真机切换 + 打字上屏，15/15 通过**；工具栏面板的开关 / 换方案也会同步到网页那一侧 |
| 当前内置方案 | — | 15 个（音码 / 双拼 / 注音 / 形码），**已全部经过真机验证** |

`npm test` 一次跑完前四层；端到端那层需要一个支持 `--load-extension` 的 Chromium 内核
（品牌版 Chrome 137+ 已移除该开关），详见 [`rime-browser-ime/README.md`](rime-browser-ime/README.md)。

前三层能离线跑，是因为 `rime.js` 保留了 Node 环境分支、而 `chrome.*` 只有四件事需要模拟
（详见架构文档）。这一路踩到的坑都记在
[`rime-browser-ime/README.md`](rime-browser-ime/README.md) 的「踩到的坑」一节。

## 许可

上游 [LibreService/my_rime](https://github.com/LibreService/my_rime) 是
**AGPL-3.0-or-later**（© Qijia Liu），本改造沿用同一许可，全文见根目录 [`LICENSE`](LICENSE)，
上游版权与许可原文另存 [`rime-browser-ime/licenses/my-rime-LICENSE.txt`](rime-browser-ime/licenses/my-rime-LICENSE.txt)，
输入方案的许可随各自 `@rime-contrib/*` 包分发。

**分发时必须保留署名并同样以 AGPL 授权。**
