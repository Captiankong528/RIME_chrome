# TODO

还没做的事、还没验的事。**做完的事全部记在 [`CHANGELOG.md`](CHANGELOG.md)**，
这里一条都不重复。当前版本 0.1.0，Chrome / Firefox 两个包都已构建并跑过真机 e2e。

> 结论先说：**输入主链路上没有已知缺陷、也没有未验证的空白。**
> 下面剩下的都是「发布流程」「可选增强」「更冷的边界」，按优先级分三节。

---

## 一、发布相关（要发出去就必须做）

### 1. 【唯一的硬待办】发布到 Chrome 应用商店，消除「非商店来源」提示

现在的 crx 是「直接分发」形态，安装时 Chrome 会提示「并非来自 Chrome 应用商店」，
这是所有非商店 crx 的必然提示，**无法绕过**。彻底消除只能走 Web Store
（需要开发者账号 + 审核）。跟打包脚本无关，改的是分发渠道。

### 2. Firefox：发布前必须换掉占位 gecko id

`scripts/lib/manifest.mjs` 里的 `GECKO_ID`（`rime-browser-ime@example.com`）是占位值，
**一旦发布就不能再改**。换掉之后走 AMO 签名（`web-ext sign`），
正式安装路径见 `rime-browser-ime/README.md` 的「Firefox」一节。

### 3. 【只能人工做一次】把 crx 真正拖进 Chrome 装一遍

`chrome://extensions` 是 WebUI，无法用脚本触发 crx 安装，所以这一步自动化不了。

现状是**「结构与签名正确」已有证据，「Chrome 一定接受」还没有**：

- 已有：`node scripts/verify-crx.mjs` 独立校验通过（容器头、protobuf 字段结构、
  RSA 签名、id 推导、`header_size` 覆盖范围、产物 manifest 的 `key` 与 crx 公钥推出
  同一个 id、载荷 zip 完整性）。
- 没有：真的把 `dist/rime-browser-ime-0.1.0.crx` 拖进 `chrome://extensions`。

**别把这两件事混为一谈** —— 第一版 crx 正是在「拖进去」这一步暴露的
`包无效:"CRX_HEADER_INVALID"`（详见 `CHANGELOG.md`）。人工验一次，一分钟的事。

---

## 二、可选增强（不影响当前使用，但迟早会碰）

### 4. `STATUS` 在 worker 还没报方案时回退到 `loadedSchemaId`

现象：e2e 里那行 `引擎就绪: ready|luna_pinyin|5`，在冷启动时机不巧时会打印
`ready|null|5`。原因：`STATUS` 读的是底层 worker 的 `currentSchema`，而它只在
`loadSchema` 里被写；`host.js` 的 `loadedSchemaId` 才是「装载成功过什么」。

改法：`STATUS` 在 worker 尚未上报方案时回退到 `loadedSchemaId`。
**纯读数问题，不影响输入**（15 个方案同一轮里全部装载并上屏成功），
所以一直没做。

### 5. Firefox 背景页被卸载后的首次按键延迟

Firefox 的 MV3 事件页闲置约 30 秒被卸载，引擎随之销毁，下一次按键要重新编译 wasm
（用户词典在 IndexedDB，不会丢）。目前**没有做保活** —— Mozilla 没有 offscreen
等价物，唯一干净的办法就是接受重载。

要做的话是在「体验」和「平台对抗」之间选：可选方案是接受、或在设置页明示
「重启后第一次打字会慢一下」。

### 6. 用户词频的跨会话持久化

`IDBFS` 落 IndexedDB 之后，**重启浏览器是否还在**没有验证过。
（Chrome / Firefox 都没测。）

### 7. 长文本 / 超长候选列表下的候选窗表现

候选条数很多时的翻页、滚动、跟随光标的边界都没专门测过。

### 8. 除 Chrome for Testing 154 / Firefox Nightly 159 之外的浏览器版本

兼容性只在这两个内核版本上验过。特别地，`chrome.offscreen.hasDocument()` 是
Chrome 150+ 的 API，代码里做了三层兜底，但**116–149 上没有真机跑过**。

### 9. Firefox：面板里真的换一次输入方案

Firefox 那段 e2e 只断言了「方案下拉框列全 15 项 + 开关来回一次」，
**没有在 Gecko 上真的切一次方案**（Chrome 的 e2e 验了）。两者走的是同一条
`setSettings`，加两行断言即可 —— 没加是因为换方案会牵动引擎装载，
而 Firefox 的背景页恰好是最容易在闲置后被卸载的那一环（见第 5 条）。

### 10. Firefox：15 个方案的遍历

方案遍历目前**只在 Chrome 上跑**（`e2e-test.mjs`）。Firefox 上只验了朙月拼音
（`e2e-firefox.mjs`：默认方案 + 简繁 + 工具栏面板）。

### 11. Firefox：Shadow DOM 里编辑器的候选窗定位

`ShadowRoot.getSelection()` 在 Firefox 不存在（Chrome 的非标准 API），
Shadow DOM 里的编辑器只能退回元素外框定位候选窗。属于「能用但不够准」，
要准就得自己维护一套 selection 映射。

### 12. `.tmp/` 里两个删不掉的早期 Chrome profile

`rime-browser-ime/.tmp/m-all-off` / `m-no-sandbox`（约 37 MB）。其中一个文件 `sqldb0`
被某个非 Chrome 进程占着句柄。它不参与打包和任何检查，**不影响功能** ——
哪天句柄释放了直接删掉即可。

---

## 三、维护提醒（不是任务，是别踩回去）

- **`rime-browser-ime.pem` 弄丢 = 换一个扩展 id = 只能卸载重装。**
  它决定 crx 与「加载已解压」共用的 id（打包时会往产物 manifest 注入 `key`）。
  已 gitignore，别提交、别外传；更新版本复用同一把钥即可覆盖升级。
- **`.tools\chrome-for-testing\`（约 600 MB）是必需品，别删。**
  Chrome 137+ 品牌版移除了 `--load-extension`，只有 CfT / Chromium 系能跑 e2e。
- **别用 `rm -rf dist` 式清理**：`package.mjs` / `pack-crx.mjs` 特意不再清空 `dist/`，
  否则打一次 Chrome 包会把 Firefox 包删掉。
- **`check.mjs` 盯着的两条不变量**：service worker 里不许再出现
  `chrome.action.onClicked`（有 `default_popup` 时它是死代码）；
  `playground.html` 的 `<script src>` 顺序必须与 manifest 的 `content_scripts` 完全一致。
- **`README.md` 里「除朙月拼音外其余 14 个方案尚未真机验证」这类旧说法不要改回去** ——
  15 个方案的遍历已经补上了。

---

## 验证现状速查（做完上面任何一条，回来更新这张表）

| 层 | 命令 | 现状 |
| --- | --- | --- |
| 静态自检 | `node scripts/check.mjs` | 184 项通过 |
| 引擎全链路 | `node scripts/engine-smoke.mjs` | 27 项通过 |
| content 逻辑 | `node scripts/content-smoke.mjs` | 73 项通过 |
| IPC（Chrome） | `node scripts/ipc-smoke.mjs` | 21 项通过 |
| IPC（Firefox） | `node scripts/ipc-smoke.mjs --platform=firefox` | 21 项通过（发往 offscreen 的消息为 0 条） |
| Chrome 真机 | `EXT_ROOT=dist/rime-browser-ime-0.1.0-unpacked node scripts/e2e-test.mjs` | 通过：15/15 方案 + 简繁 + 状态栏 + 工具栏面板 + 普通网页 |
| Firefox 真机 | `node scripts/e2e-firefox.mjs` | 通过：设置页自检 6 步 + 工具栏面板 + 普通网页打字 |
| crx 结构 / 签名 | `node scripts/verify-crx.mjs` | 通过 |
| crx 真机安装 | 人工拖进 `chrome://extensions` | **未做**（第 3 条） |
| 其余 14 个浏览器版本 | — | **未做**（第 8 条） |
| 用户词典跨会话 | — | **未做**（第 6 条） |

> 项数会随功能增长（`check.mjs` 最初 75 → 135 → 164 → 184），是脚本按断言条数统计的，
> 不是固定值。
