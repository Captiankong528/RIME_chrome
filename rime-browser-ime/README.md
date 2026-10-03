# RIME 网页输入法（Chrome / Firefox 扩展）

把 [LibreService/my_rime](https://github.com/LibreService/my_rime) 的 librime-WebAssembly
引擎装进一个 Manifest V3 扩展，让 RIME 直接工作在**任意网页的输入框里**——不用切换标签页，
也不用复制粘贴。

- 全部计算在本地：不联网、不上传内容、不发任何请求。
- 零构建：改完源码在 `chrome://extensions` 点「重新加载」就生效。
- **一套源码出两个包**：Chrome 版与 Firefox 版（差异只有清单和「引擎住在哪」，见「Firefox」一节）。
- 当前内置 **15 个输入方案**，设置页的下拉框按「音码 / 双拼 / 注音 / 形码」分组：

| 分组 | 方案 |
| --- | --- |
| 音码 | 朙月拼音 `luna_pinyin`、朙月拼音·语句流 `luna_pinyin_fluency`、袖珍简拼 `pinyin_simp`、地球拼音 `terra_pinyin` |
| 双拼 | 自然码 `double_pinyin`、小鹤 `double_pinyin_flypy`、微软 `double_pinyin_mspy`、智能ABC `double_pinyin_abc`、拼音加加 `double_pinyin_pyjj` |
| 注音 | 注音 `bopomofo`、注音·快打 `bopomofo_express` |
| 形码 | 86五笔 `wubi86`、86五笔·拼音 `wubi_pinyin`、86五笔·繁体 `wubi_trad`、五笔画 `stroke` |

默认是朙月拼音。方案之间会自动带上反查依赖（例如双拼借朙月的词库、五笔借袖珍简拼反查），
依赖关系写在 `src/common/const.js` 的 `targets` 里。**15 个方案全部已在真实 Chrome 里
逐个切换并打字验证过**（见下方「验证」的浏览器集成一层）。

---

## 安装

先打包（只需一次），`dist/` 下会出现三种产物：

```bash
node scripts/pack-crx.mjs
# dist/rime-browser-ime-0.1.0.crx             ← 可安装（签名过的扩展包）
# dist/rime-browser-ime-0.1.0.zip             ← 分发用，解压后见方式 B
# dist/rime-browser-ime-0.1.0-unpacked/       ← 免解压，直接选这个目录（方式 B）
```

### 方式 A：安装 `.crx`（推荐，最接近「装一个插件」）

1. 打开 `chrome://extensions`，右上角打开 **开发者模式**
   （Chrome 要求开，否则会拒绝安装非商店来源的 crx）
2. 把 `dist/rime-browser-ime-0.1.0.crx` **直接拖进这个页面**
3. 弹出「是否要添加"RIME 网页输入法"？」→ 点 **添加扩展程序**

装完就是一个正常的扩展，带固定扩展 id `gnnmiafmbhofbbpgpipgmalekdekceki`，
以后重新打包出新版本，拖进去即可**覆盖升级**（前提是没换过签名私钥，见下）。

> Chrome 会提示「该扩展程序并非来自 Chrome 应用商店」。这是所有非商店 crx 的必然提示，
> 因为本项目没有上架也没有付费开发者账号。点确认即可，功能不受影响。

### 方式 B：加载已解压的扩展程序（不装 crx 时用）

1. 打开 `chrome://extensions`，右上角打开 **开发者模式**
2. 点 **加载已解压的扩展程序**，选择 `dist/rime-browser-ime-0.1.0-unpacked/`
   （或把 `dist/*.zip` 解压后选解压目录）
3. 工具栏出现扩展图标，徽标显示 `EN`（未开启）

> 方式 B 的扩展 id 与方式 A **不同**（Chrome 对「已解压」是按目录路径算 id 的，
> 只有 crx 才用内嵌公钥算 id）。两种方式都能正常用，只是 id 不一样，
> 设置/词频也不会互通——选定一种用就好。

### 方式 C：直接加载源码目录（开发用）

改源码时用这个，改完在 `chrome://extensions` 点一次「重新加载」即可，无需重新打包：

1. 打开 `chrome://extensions` → 开启 **开发者模式**
2. **加载已解压的扩展程序** → 选择本目录（`rime-browser-ime/`）

### 关于签名私钥（重要）

`pack-crx.mjs` 第一次运行会生成 `rime-browser-ime.pem`（RSA-2048 私钥），
**扩展 id 由它决定**：

- 想保持同一个扩展 id、让新版能覆盖安装 → **留着它**，并且不要外传。
- 弄丢了 → 下次打包会生成新私钥，扩展 id 变了，只能卸载重装（设置与词频会丢）。
- 它已被 `.gitignore` 覆盖（`*.pem`），不会被提交。

`--key <path>` 可以指定别处的私钥。

## 安装后

1. 点工具栏图标 → 弹出**小面板**（开关 / 输入法 / 简繁），在里面点「开启输入法」；
   面板关了也没关系，徽标从 `EN` 变 `中` 就说明开了。也可以直接用 `Ctrl+Shift+Space` 开关
2. 打开扩展的**设置页**，点 **运行自检** —— 它会逐层跑一遍整条输入链路，哪一层断了直接告诉你原因
3. 通过之后，在任意网页的输入框里敲 `nihao` + 空格，应该得到「你好」

> 需要 Chrome 116+（用到了 `chrome.offscreen.hasDocument()`）。

## 使用

| 操作 | 说明 |
| --- | --- |
| `Ctrl` + `Shift` + `Space` | 切换中/英（徽标在 `中` / `EN` 之间变化） |
| 点击工具栏图标 | 弹出**小面板**：开关输入法、换输入法、换简繁；底部进完整设置页 |
| 敲拼音 | 候选窗跟着光标出现 |
| `空格` / `数字键 1-9` | 选词上屏 |
| `-` / `=` 或 `PageUp` / `PageDown` | 翻页 |
| `Esc` | 取消本次组字 |
| `Enter` | 直接把当前编码原样上屏 |
| `F4` | 组字中切换输入方案 |

点工具栏图标弹出的小面板（真机截图）：

![工具栏面板](docs/popup.png)

**第一次开启会慢几秒**：扩展要把 2.8MB 的 wasm 编译、装载 1.1MB 预置数据、挂载
IndexedDB 用户词典。之后引擎常驻，按键是毫秒级。加载期间候选窗会显示「正在加载 RIME 引擎…」。

### 演练场

扩展设置页（`chrome://extensions` → 详情 → 扩展程序选项，或右键图标 → 选项）里有
**打开演练场** 按钮。那是一个用同一套引擎的测试页，装好即可验证输入是否正常。

### 首次验证清单

**最省事的办法**：装好后打开设置页，点 **运行自检**。它会逐层跑一遍
background 路由 → offscreen/引擎 → 方案装载 → 打字上屏，哪一层断了直接显示原因。
下面是可以自己肉眼过一遍的等价步骤：

1. `chrome://extensions` 里扩展卡片没有红色 **错误** 按钮 → 清单合法。
2. 点工具栏图标弹出小面板，在里面点「开启输入法」，徽标从 `EN` 变 `中`
   → service worker、开关链路、面板都通。
   （若 `Ctrl+Shift+Space` 没反应，去 `chrome://extensions/shortcuts` 手动设一个。）
3. 打开设置页，引擎那一行显示 **正在加载…** 然后变 **就绪 · luna_pinyin**
   → offscreen 文档建起来了、wasm 编译通过、方案装载成功（冷启动约 3–10 秒）。
4. 点 **打开演练场**，在 `textarea` 里敲 `nihao`：
   - 光标处弹出候选窗、显示编码 `nihao` 和候选词 → 按键接管 + 候选窗定位正常。
   - 按空格，文本框出现「你好」→ 上屏注入正常。
   - 再敲 `nihao` 按 `2`，应上屏第二个候选 → 数字选词正常。
5. 随便打开一个真实网站（例如搜索框），重复第 4 步。
6. 按 `Ctrl+Shift+Space` 关掉，再敲拼音应输入原始字母 → 关闭后不干扰页面。

控制台怎么看：`chrome://extensions` → 本扩展的 **Service Worker** 链接看后台日志；
页面按 F12 看 content script 日志（都以 `[rime]` / `[librime]` 开头）。

## Firefox

Firefox 同样支持 MV3，但它**没有 `chrome.offscreen`**，所以那边的引擎**就地跑在背景页里**
（背景页是真正的页面，可以直接持有 Worker），整条链路比 Chrome 版少一跳。源码是同一份，
差异只有清单和「引擎住在哪」，由 `src/background/engine-bridge.js` 里的一次能力探测分流：
有 `chrome.offscreen.createDocument` 走 offscreen，没有就就地。

```bash
node scripts/build-firefox.mjs
# dist/rime-browser-ime-0.1.0-firefox/        36.23 MB   ← 免解压目录
# dist/rime-browser-ime-0.1.0-firefox.zip     16.50 MB   ← 给 web-ext sign / AMO 上传
# 扩展 id = rime-browser-ime@example.com，最低 Firefox 109
```

三种装法：

| 方式 | 怎么做 | 说明 |
| --- | --- | --- |
| A 临时载入（开发用） | `about:debugging#/runtime/this-firefox` → **临时载入附加组件** → 选 `dist/…-firefox/manifest.json` | 不需要签名，但重启浏览器就没了 |
| B 装未签名的 zip | `about:config` 把 `xpinstall.signatures.required` 设为 `false`，再把 zip 拖进 Firefox | **只有 Nightly / Developer Edition / ESR 允许** |
| C 正式安装 | `npx web-ext sign --api-key <AMO key> --api-secret <AMO secret> --source-dir dist/rime-browser-ime-0.1.0-firefox`，再把签好的 xpi 拖进 Firefox | Release 版**必须签名**才能装，这是 Mozilla 的硬要求 |

> `browser_specific_settings.gecko.id` 是扩展在 Gecko 里的身份，**一旦发布就不能改**
> （改了等于换一个扩展，覆盖升级失效）。要上 AMO 的话，先把
> `scripts/lib/manifest.mjs` 里的 `GECKO_ID` 换成自己的。

Firefox 侧的两个已知差异（都不影响输入本身）：

- **背景事件页闲置约 30 秒会被卸载**，引擎随之销毁，下一次按键要重新编译 wasm（几秒，
  期间候选窗显示「正在加载 RIME 引擎…」）。引擎是**惰性**启动的：用户一开开关就起来，
  被无关事件唤醒时不会白编译。用户词典在 IndexedDB 里，不会丢。
- 没有 `ShadowRoot.getSelection()`（Chrome 的非标准 API），Shadow DOM 里的编辑器
  （YouTube 评论之类）只能退回元素外框定位候选窗。

真机端到端（会真的装扩展、真的敲键盘）：

```bash
node scripts/e2e-firefox.mjs
```

## 开发

不需要 `pnpm install`，依赖只有几个 Node 内置模块。

```bash
node scripts/check.mjs          # 静态自检：清单/语法/资源/协议一致性（当前 184 项）
node scripts/fetch-assets.mjs   # 重新拉取引擎 + 默认方案（会重建 .cache/）
node scripts/fetch-assets.mjs --all   # 拉取全部方案
node scripts/make-icons.mjs     # 重新生成图标
node scripts/pack-crx.mjs       # 打包：crx + zip + 解压目录（推荐，见「安装」）
node scripts/package.mjs        # 只产出 zip（体积小、可复现，给分发用）
node scripts/build-firefox.mjs  # 构建 Firefox 包（换清单 + 出 zip 与免解压目录）
```

IPC 全链路要跑两遍——Chrome 的 offscreen 宿主与 Firefox 的就地宿主是两条不同的路：

```bash
node scripts/ipc-smoke.mjs                     # Chrome 形态（service worker + offscreen）
node scripts/ipc-smoke.mjs --platform=firefox  # Firefox 形态（背景页就地宿主）
node scripts/e2e-firefox.mjs                   # Firefox 真机端到端（geckodriver + WebDriver）
```

`npm test` 会把前四层连同两条宿主形态一起跑完。

`e2e-test.mjs` 也可以直接对**打包产物**跑端到端，验证真正要发出去的那份字节没问题：

```bash
EXT_ROOT=dist/rime-browser-ime-0.1.0-unpacked node scripts/e2e-test.mjs
```

## 分发

```bash
node scripts/pack-crx.mjs
# 打包完成：
#   dist/rime-browser-ime-0.1.0.crx            16.50 MB   ← 可安装
#   dist/rime-browser-ime-0.1.0.zip            16.50 MB
#   dist/rime-browser-ime-0.1.0-unpacked/      36.23 MB
#   扩展 id     = gnnmiafmbhofbbpgpipgmalekdekceki
#   文件数      = 67   原始 36.23 MB -> 压缩后 16.50 MB
```

（体积主要来自 `schemas/`：15 个方案的预编译 `.table.bin` / `.prism.bin` 共 42 个文件、
约 32 MB。压缩后仍偏大是正常的，因为里面是二进制 trie。）

这个项目没有编译步骤，所以「打包」就是把运行时真正需要的 5 个顶层条目
（`manifest.json` / `icons` / `licenses` / `schemas` / `src`）收成一个包，
`scripts/`、`docs/`、`package.json` 这些开发用的东西不进包。
ZIP 容器是脚本自己写的（Node 只有 deflate，没有 zip 写入器），
所以 Windows / macOS / Linux 产出一致，不依赖系统的 `Compress-Archive`。

### 打包时会往 manifest 里注入 `key`

打包产物里的 `manifest.json` 会多一个 `key` 字段（DER SPKI 的 base64，由签名私钥导出）。
作用是**钉住扩展 id**：否则 Chrome 对「加载已解压的扩展程序」是按目录路径算 id 的
（`id_util::GenerateIdForPath`），会和 crx 装出来的那个对不上。
注入之后两种安装方式都得到同一个 id `gnnmiafmbhofbbpgpipgmalekdekceki`。

源目录的 `manifest.json` 保持干净，只有打包产物里那一份带 `key`
（`verify-crx.mjs` 会核对注入的 key 与 crx 公钥推出同一个 id）。

### crx 是手写的 CRX3

```
[4] "Cr24" | [4] 版本=3 | [4] 头长度 N | [N] CrxFileHeader | ZIP 载荷

CrxFileHeader { repeated AsymmetricKeyProof sha256_with_rsa = 2; bytes signed_header_data = 10000; }
AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }   // ← 公钥在子消息里，不是顶层
SignedData { bytes crx_id = 1; }            // 恰好 16 字节，没有算法字段

签名(RSA_PKCS1_SHA256) 覆盖：
  "CRX3 SignedData\0" + u32le(len(signed_header_data)) + signed_header_data + 载荷
                        ↑ 这个长度前缀最容易漏，漏了 Chrome 报 CRX_HEADER_INVALID
```

没有用 Chrome 自带的 `--pack-extension`：那个开关在受限沙箱里起不来
（crashpad `OpenProcess: 拒绝访问`），而且在当前 Chrome for Testing 上它已经不再产出文件了。
这个项目本来就没有任何外部依赖，所以照 Chromium 的
`components/crx_file/crx3.proto` 与 `crx_verifier.cc` 在 Node 里实现。

改这段代码前请先跑 `node scripts/verify-crx.mjs`：它会独立解析容器头、验签、
并断言头里不含 ZIP 中央目录 token（Chrome 会因此拒绝加载）。

> 提醒：`verify-crx.mjs` 是**独立实现**，故意不复用 `pack-crx.mjs` 的函数。
> 两边共用代码的话，同一个格式误解会在生成和校验里同时成立，
> 校验就只是自我确认——第一版正是这样漏过了 `signed-header-size`，
> 直到拖进 Chrome 报 `CRX_HEADER_INVALID` 才发现。


## 验证

分四层，前四层已经跑通：

| 层 | 命令 | 覆盖范围 | 状态 |
| --- | --- | --- | --- |
| 静态 | `node scripts/check.mjs` | 清单合法性、被引用文件齐全（含 `action.default_popup` 指向的工具栏面板）、HTML 里的本地引用、全部 JS/JSON 语法、wasm 魔数、方案注册表一致（含每个方案的 `targets` 目录都存在、`.schema.yaml` 都在 `schemas/manifest.json` 里）、无内联脚本、`OP` 操作表与 worker 处理函数不漂移、设置页与工具栏面板两处 DOM 绑定、**简繁跟随语言**、**Firefox 清单的每一项差异**、**平台层不变量**（`chrome.offscreen` 只许出现在 `engine-bridge.js`） | 184 项通过 |
| 引擎 | `node scripts/engine-smoke.mjs` | 用 `vm` 把 `rime.js` 按 Node 分支跑起来，**原样执行 `src/engine/worker.js`**，验证 init → 写入 11 个预编译方案文件 → `set_ime` → `process('nihao')` → 空格上屏「你好」→ 数字选词 → 翻页 → `setOption` → `reset` 后恢复 | 27 项通过 |
| content 逻辑 | `node scripts/content-smoke.mjs` | 按键映射、拦截策略（密码框、Ctrl 组合、页面自带输入法让行）、**Shadow DOM 目标解析**、**候选窗视口定位与翻转**、引擎返回值状态机、`execCommand` 不可用时的注入退路、**富文本编辑器（Slate 那类）的 `beforeinput` 接管判定** | 73 项通过 |
| IPC 全链路 | `node scripts/ipc-smoke.mjs [--platform=firefox]` | import **产品代码本体**（`service-worker.js` + `engine-bridge.js` + `host.js` + `worker.js`，Chrome 形态还会加载 `offscreen.js`），只替换宿主能力，验证 content → background → 引擎宿主 → worker → librime 往返、开关、徽标、设置下发、错误可诊断、**offscreen 首帧竞态重试**；并断言 **Chrome 形态确实走消息通道、Firefox 形态一跳都没有** | 21 项 × 2 种宿主形态通过 |
| 浏览器集成（Chrome） | `node scripts/e2e-test.mjs` | 真实 Chrome 加载扩展、建 offscreen 文档、真实 Worker 里编译 wasm、`nihao` + 空格 → 「你好」、数字选词、**简繁切换（`Ctrl+Shift+4`）**、**切换方案（自然码 `vuhk`→「煮好」vs 小鹤 `vuhk`→「住坏」）**、**15 个方案逐个切换 + 打字上屏**、**工具栏面板（点开关 / 换方案 / 进设置页，两条链路都验）**、普通 HTTP 网页复验 | **已跑通**（15/15 方案） |
| 浏览器集成（Firefox） | `node scripts/e2e-firefox.mjs` | 真 Firefox（Nightly，geckodriver + WebDriver）：**MV3 清单被 Gecko 接受并载入并启用**、设置页可用、**背景页里在扩展 CSP 下编译 wasm**、扩展自带自检 6 步全绿（含简繁默认值）、普通网页 `nihao` + 空格 → 「你好」 | **已跑通** |

> **15 个方案已全部经过真机验证**：`e2e-test.mjs` 会逐个切到每个方案、按该方案的键位
> 敲一串编码、用该方案实际认的确认键上屏，并断言**确切的中文结果**
> （例如 `wubi86` 的 `wqiy` → 「你」、`stroke` 的 `hpsh` → 「紅皮書」）。
> 因为期望值来自离线实测的同一套引擎，这一层实际校验的是浏览器侧那一环：
> `schemas/manifest.json` 映射、offscreen 读文件路径、跨进程传 ArrayBuffer 有没有把词典弄坏。
>
> 注意各方案的**确认键并不统一**（这是 librime 的正常语义，不是 bug）：空格在多数方案上
> 确认首候选，但在语句流/注音上只翻页；自然码双拼的回车是「原样上屏编码」。
> 断言表里每个方案用的是分别实测选出来的键位。

`npm test` 一次跑完前四层。

前几层之所以能在 Node 里跑，是因为宿主能力都可以被替换：

- `rime.js` 是 emscripten 产物、保留了 Node 环境分支，所以只要有 `self` / `importScripts` /
  `postMessage` 三个全局就能原样加载（`IDBFS` 换成内存版，只少了跨会话持久化）。
- `chrome.*` 只有四件事需要模拟：消息路由、storage、offscreen 生命周期、action 徽标。
  其中「发送者收不到自己发出的消息」这条语义用 `AsyncLocalStorage` 复刻，
  否则 service worker 发给 offscreen 的消息会绕回自己形成死循环。

这样最高风险的一段——预编译方案能不能被 `set_ime` 直接命中、三层消息能不能对上——
就不用等浏览器才能确认。

### 踩到的坑

**`chrome.offscreen.hasDocument()` 是 Chrome 150+ 的 API。** 它让「offscreen 文档是否
已存在」这件事在 Chrome 116–149 上直接变成 `TypeError: ... is not a function`。
现在 `ensureOffscreen()` 优先用它、拿不到就退回自己在 SW 生命周期内记的状态，
并且把 `createDocument` 抛出的「只能有一个」当成「已存在」处理，所以不再硬依赖它。

**offscreen 文档里没有 `chrome.storage`。** 这是实测出来的（Chrome 151，Chrome for
Testing 154 同样）：offscreen 文档只暴露极少几个 API，`chrome.storage` **是
`undefined`**。在模块顶层读它会让整个文档加载失败、连 `chrome.runtime.onMessage`
都注册不上，而页面侧只会看到 `Could not establish connection. Receiving end does not
exist.`——看上去像 service worker 挂了，实际原因完全在别处。现在 offscreen 只用
`chrome.runtime`，设置一律由 background 随请求下发。

**`chrome.offscreen.createDocument()` resolve ≠ offscreen 的监听器已就绪。** 那之前
还有 `createWorker()`、错误监听注册、引擎启动。这个窗口里 `sendMessage` 抛的还是
同一句 `Receiving end does not exist.`，所以 background 侧对「消息根本没投递」这一类
错误做了带退避的重试（只重试这一类，业务错误直接抛，不会重复处理按键）。

**service worker 的模块顶层一旦抛错，路由就注册不上。** 于是 `chrome.runtime.onMessage`
被排到所有可选 API 注册之前，且 `chrome.commands` / `chrome.action` 这类条件性 API
的注册全部包了 `safeListen`。

**`execCommand('insertText')` 不派发 `beforeinput`，富文本编辑器收不到我们上屏的字。**
真机实测：真人打字是 `beforeinput → textInput → input`，而
`document.execCommand('insertText', false, text)` 在 Chrome 上**只派发 `input`**。
Slate / ProseMirror / Lexical / Draft.js 这类编辑器只在 `beforeinput` 里更新自己的文档模型，
于是 DOM 里有字、页面模型里没字：占位符不消失、和刚打进去的字叠在一起，页面提交/翻译
读到的是空内容，下一次按模型重渲染还会把这几个字**抹掉**。百度翻译
`fanyi.baidu.com/mtpe-individual`（输入框是 Slate 编辑器）就是这样翻车的，而且
**只在空输入框第一次输入时**出现——编辑器里已经有内容时，同一条 `execCommand` 反而能被
模型吸收，所以普通网页和离线断言全都测不出来。
现在 `insertIntoContentEditable()` 先派发一个合成的 `beforeinput`：谁 `preventDefault`
就说明页面自己接管了这次输入，我们一个字都不再写；没人接管才走 `execCommand`。

### 端到端测试

`scripts/e2e-test.mjs` 会启动真实浏览器、加载本扩展、在演练场里敲字、切简繁、
逐个切换 15 个方案、在普通 HTTP 页面复验一遍，最后把**工具栏面板**当标签页打开、
用真实鼠标点它。**当前输出**（2026-10-02，对打包产物跑的，`exit=0`）：

```
加载扩展目录: …\dist\rime-browser-ime-0.1.0-unpacked (打包产物)
扩展已加载, id = gnnmiafmbhofbbpgpipgmalekdekceki
浏览器语言 = zh-CN -> 简繁默认 = 简体
引擎就绪: ready|luna_pinyin|5
offscreen 宿主: 已创建
组字中: {"composing":true,"visible":true}
textarea 内容 = "你好"
✅ 输入链路正常：nihao + 空格 -> 你好
== 简繁默认值 ==
✅ luna_pinyin：组字中 -> hanzi + 空格 -> 汉字
== Ctrl+Shift+4 切简繁 ==
✅ Ctrl+Shift+4 没有把字符打进页面
✅ Ctrl+Shift+4 切换生效：hanzi + 空格 -> 漢字
✅ Ctrl+Shift+$ 切回默认：hanzi + 空格 -> 汉字
== 状态栏（点着用）==
✅ 状态栏已出现：schema / tradSimp:auto / tradSimp:简 / tradSimp:繁 / collapse
✅ 状态栏里选了「小鹤双拼」：double_pinyin_flypy / 小鹤双拼
✅ 状态栏点「繁」：vuhk + 空格 -> 住壞
✅ 偏好「繁」已经存进 chrome.storage.local
✅ 点「跟随」回到语言默认：vuhk + 空格 -> 住坏
✅ 点状态栏没有把焦点从输入框抢走
✅ 收起后只剩胶囊：collapse
✅ 再点一次又展开了
✅ 状态栏切回 luna_pinyin
== 切换输入方案 ==
✅ double_pinyin：组字中 -> vuhk + 空格 -> 煮好
✅ double_pinyin_flypy：组字中 -> vuhk + 空格 -> 住坏
✅ 切回 luna_pinyin：nihao + 空格 -> 你好
== 全部方案遍历（15 个）==
  ✓ luna_pinyin            nihao   -> 你好
  ✓ luna_pinyin_fluency    nihao   -> 你好
  ✓ pinyin_simp            nh      -> 你好
  ✓ terra_pinyin           nihao   -> 你好
  ✓ double_pinyin          nihk    -> 你好
  ✓ double_pinyin_flypy    nihk    -> 你坏
  ✓ double_pinyin_mspy     nihk    -> 你好
  ✓ double_pinyin_abc      nihk    -> 你好
  ✓ double_pinyin_pyjj     nihao   -> 你哈哦
  ✓ bopomofo               su3cl3  -> 你好
  ✓ bopomofo_express       su3cl3  -> 你好
  ✓ wubi86                 wqiy    -> 你
  ✓ wubi_pinyin            nihao   -> 你好
  ✓ wubi_trad              nihao   -> 你好
  ✓ stroke                 hpsh    -> 紅皮書
  小计：15/15 个方案在真实浏览器里装载 + 打字上屏成功
== 普通网页（http://127.0.0.1） ==
组字中 input 内容 = "" （应仍为空，说明按键被拦下了）
✅ 普通网页上状态栏也在（影子根 closed = true）
上屏后 input 内容 = "你好"
✅ 普通网页上同样正常：nihao + 空格 -> 你好
== 工具栏面板（action.default_popup）==
✅ 面板列全了 15 个方案 / 4 个分组，当前 luna_pinyin
✅ 面板上的简繁下拉框是「跟随 + 简 + 繁」三项
✅ 面板上点「停用输入法」：storage 与网页两侧都关了
✅ 再点一次开回来：两边都恢复了
✅ 面板里切到「小鹤双拼」：storage 与网页两侧都跟上了
✅ 面板里切回朙月拼音
✅ 面板里的「打开完整设置页」把设置页开起来了
```

> 浏览器语言非繁体时默认简体，所以小鹤双拼那一行是「你坏」；若在 zh-TW / zh-Hant
> 环境下跑，期望会自动变成「你壞」，`checkAllSchemas` 与切换方案那两条都跟随语言。

> 「工具栏面板」那一段把 `chrome-extension://…/src/popup/popup.html` 当普通标签页打开
> （同一个 URL、同一份脚本），所以面板里的按钮是**用真实鼠标事件**点的：
> 覆盖了「面板 → background → storage → 广播 → 网页那一侧」这条完整回路，
> 而不只是「按钮能点」。测试收尾会把它和它拉起来的设置页一起关掉。


这条链路一次性覆盖了离线测不到的部分：MV3 加载、offscreen 文档创建（`WORKERS` reason
被接受）、真实 Worker 里在扩展 CSP 下编译 wasm、候选窗渲染、`textarea` 注入。

用 `EXT_ROOT` 可以指定要加载的目录，从而把**打包产物**（而不是源码树）跑一遍：

```bash
EXT_ROOT=dist/rime-browser-ime-0.1.0-unpacked node scripts/e2e-test.mjs
```

**两个前置条件**（都是踩出来的）：

1. **不能用品牌版 Google Chrome。** Chrome 137 起品牌版移除了 `--load-extension`，
   命令行加载扩展这条路被封死。用 Chrome for Testing：
   <https://googlechromelabs.github.io/chrome-for-testing/>（`storage.googleapis.com`
   国内直连很慢，建议找镜像或让能下的人代下）。

   仓库当前用的是 154.0.8037.92，刻意放在扩展目录**外面**：
   `RIME_chrome/.tools/chrome-for-testing/chrome-win64/chrome.exe`
   ——它解压后 600+ MB，塞进要「加载已解压」的目录既脏又容易被误打包。
   脚本会自动发现它，也兼容旧位置 `.cache/chrome-for-testing/`。

2. **在进程权限不完整的环境里要加 `--no-sandbox`**，否则 crashpad 处理器起不来，
   Chrome 会 `crash server failed to launch, self-terminating` 直接自杀；
   同时 profile 目录必须放在**可写**位置，否则 `ProcessSingleton` 建不了锁文件同样中止。
   这两项脚本里已经带上了。

```bash
node scripts/e2e-test.mjs                       # 自动找 .cache 里的 Chrome for Testing
CHROME_PATH=/path/to/chromium node scripts/e2e-test.mjs
HEADLESS=0 node scripts/e2e-test.mjs            # 弹出真实窗口，肉眼观察候选窗
```

## 扩展新方案

1. `scripts/fetch-assets.mjs` 的 `SCHEMA_PKGS` 里加目标，跑 `node scripts/fetch-assets.mjs --all`
2. `src/common/const.js` 的 `SCHEMAS` 里注册 `{ id, name, group, targets }`
3. 重新加载扩展，设置页的下拉框会自动出现新方案（按 `group` 落到对应分组里）

`id` 是 RIME 方案 id（如 `double_pinyin`），`targets` 是它依赖的所有 `schemas/<target>/` 目录。

## 目录

```
manifest.json           MV3 清单（本目录就是扩展根目录，所以不用打包）
icons/  licenses/      图标 / 上游 AGPL 许可原文
schemas/               预编译输入方案（取自 @rime-contrib/*）
src/common/const.js    消息类型 + 方案注册表（content script 与扩展页面共用）
src/background/        service worker：路由 + 开关
src/offscreen/         引擎宿主（常驻隐藏页面）
src/engine/            worker.js（我们写的） + rime.js/.wasm/.data（上游 vendored）
src/content/           按键接管、光标定位、候选窗、状态栏、上屏
src/options/           设置页
src/popup/             工具栏面板（点扩展图标弹出的小设置页）
src/playground/        演练场
scripts/               开发脚本，不参与扩展运行时
scripts/lib/zip.mjs    最小 ZIP 写入器（package.mjs 与 pack-crx.mjs 共用）
rime-browser-ime.pem   签名私钥（首次打包生成；决定扩展 id，已 gitignore）
docs/ARCHITECTURE.md   设计取舍与实现细节
```

## 许可

**AGPL-3.0-or-later**。引擎与胶水代码来自
[LibreService/my_rime](https://github.com/LibreService/my_rime)（© Qijia Liu），
原文见 [`licenses/my-rime-LICENSE.txt`](licenses/my-rime-LICENSE.txt)。
输入方案随各自 `@rime-contrib/*` 包分发，许可并不统一：朙月拼音、五笔画、仓颉等为
**LGPL-3.0-only**，双拼为 **GPL-3.0-only**，袖珍简拼为 **Apache-2.0**，粤语为 **CC-BY-4.0**。
分发时请一并保留各自的署名与许可原文。
