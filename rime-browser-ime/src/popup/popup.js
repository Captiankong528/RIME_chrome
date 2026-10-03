/**
 * 工具栏面板：点击扩展图标弹出的小设置页（清单里的 `action.default_popup`）。
 *
 * 只放最常用的三件事——开关、选输入法、选简繁；候选数、自检、使用说明这些留在
 * 完整设置页里，底部的链接直接跳过去。
 *
 * 两份设置的落地路径**刻意不同**，和它们在项目里的归属一致：
 *   - 开关 / 方案：发给 background（`toggle` / `setSettings`）。由它写 storage、
 *     更新徽标、让引擎装载方案，并广播到所有标签页——和设置页下拉框同一条路。
 *   - 简繁：直接写 chrome.storage.local（键见 `STORAGE_KEYS.tradSimp`），
 *     content script 的 `storage.onChanged` 会自己接上——和网页右下角状态栏同一条路。
 *
 * 面板是**短暂**的：用户点到页面别处它就被关掉，所以这里不做长任务，
 * 切换方案那种几秒的等待只用「正在装载…」标出来（关掉也不影响，后台会接着装完）。
 */
import '../common/const.js'

const { SCHEMAS, DEFAULTS, ENGINE_STATE, TRAD_SIMP, STORAGE_KEYS, tradSimpDefault } = globalThis.RIME_CONST

const $ = id => document.getElementById(id)

/** 简繁 variant 名 → 下拉框里的说法（状态栏上地方小，只写「简 / 繁 / 臺」） */
const VARIANT_LABELS = { 简: '简体', 繁: '繁体', 臺: '臺灣正體' }

/* ---------------- 初始化界面 ---------------- */

/** 方案下拉框：按 group 分 optgroup，和设置页、状态栏用的是同一份 SCHEMAS */
{
  const groups = new Map()
  for (const schema of SCHEMAS) {
    const name = schema.group || '其他'
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(schema)
  }
  for (const [label, list] of groups) {
    const optgroup = document.createElement('optgroup')
    optgroup.label = label
    for (const schema of list) {
      const option = document.createElement('option')
      option.value = schema.id
      option.textContent = schema.name
      optgroup.append(option)
    }
    $('schema').append(optgroup)
  }
}

$('hint').textContent = 'Ctrl+Shift+Space 也能开关；打字时按 F4 换输入法。'

/* ---------------- 与后台通信 ---------------- */

async function send (message) {
  const response = await chrome.runtime.sendMessage(message)
  if (!response) throw new Error('后台没有响应')
  if (!response.ok) throw new Error(response.error)
  return response.result
}

/** 简繁偏好：'auto'（跟随语言）或某个 variant 名 */
async function readTradSimpPreference () {
  try {
    const stored = await chrome.storage.local.get({ [STORAGE_KEYS.tradSimp]: 'auto' })
    return stored[STORAGE_KEYS.tradSimp] || 'auto'
  } catch (error) {
    return 'auto'
  }
}

/* ---------------- 渲染 ---------------- */

function renderEngine (engine) {
  const state = (engine && engine.state) || ENGINE_STATE.IDLE
  $('engine-dot').className = 'dot ' + state
  const labels = {
    [ENGINE_STATE.IDLE]: '未启动',
    [ENGINE_STATE.LOADING]: '正在加载…',
    [ENGINE_STATE.READY]: '就绪',
    [ENGINE_STATE.ERROR]: '出错'
  }
  const text = $('engine-text')
  text.textContent = labels[state] || state
  text.title = (engine && engine.message) || ''
}

/** 上一次由后台确认生效的方案：切换失败时回滚到它，而不是回滚到 select 里那个新值 */
let committedSchemaId = DEFAULTS.schemaId

function renderSettings (settings) {
  committedSchemaId = settings.schemaId || DEFAULTS.schemaId
  $('schema').value = committedSchemaId
  $('toggle').textContent = settings.enabled ? '停用输入法' : '开启输入法'
  $('toggle').classList.toggle('primary', !settings.enabled)
}

/**
 * 简繁那一行：一个「跟随浏览器语言」+ 该方案自己的每个 variant。
 * 没有简繁开关的方案（袖珍简拼、86五笔、五笔画）整行收起来。
 */
function renderTradSimp (schemaId, preference) {
  const variants = TRAD_SIMP[schemaId] || []
  const field = $('trad-simp-field')
  const select = $('trad-simp')
  field.hidden = variants.length === 0
  if (!variants.length) {
    select.replaceChildren()
    delete select.dataset.signature
    return
  }

  const auto = tradSimpDefault(schemaId, navigator.language)
  const wanted = [
    ['auto', `跟随浏览器语言（当前 ${auto ? auto.name : '默认'}）`],
    ...variants.map(variant => [variant.name, VARIANT_LABELS[variant.name] || variant.name])
  ]
  // 只在选项集合真的变了时才重建 DOM：1.2 秒一次的刷新不该动用户正在操作的下拉框
  const signature = wanted.map(([value]) => value).join(',')
  if (select.dataset.signature !== signature) {
    select.replaceChildren(...wanted.map(([value, label]) => {
      const option = document.createElement('option')
      option.value = value
      option.textContent = label
      return option
    }))
    select.dataset.signature = signature
  }
  select.value = variants.some(variant => variant.name === preference) ? preference : 'auto'
}

/** 切换方案进行中：暂停轮询，否则 1.2 秒一次的刷新会把「正在装载…」立刻盖掉 */
let switching = false

async function refresh () {
  if (switching) return
  try {
    const { settings, engine } = await send({ to: 'background', op: 'getState' })
    if (switching) return
    renderSettings(settings)
    renderEngine(engine)
    renderTradSimp(settings.schemaId, await readTradSimpPreference())
  } catch (error) {
    const text = $('engine-text')
    text.textContent = '后台无响应'
    text.title = String((error && error.message) || error)
  }
}

/* ---------------- 交互 ---------------- */

$('toggle').addEventListener('click', async () => {
  const button = $('toggle')
  button.disabled = true
  try {
    await send({ to: 'background', op: 'toggle' })
  } catch (error) {
    $('engine-text').textContent = String((error && error.message) || error)
  } finally {
    button.disabled = false
  }
  await refresh()
})

$('schema').addEventListener('change', async event => {
  // 首次切到某个方案要把它的词典装进引擎（几 MB，可能几秒），这里给出明确的等待反馈
  const select = event.target
  const requested = select.value
  switching = true
  select.disabled = true
  $('engine-text').textContent = '正在装载…'
  try {
    await send({ to: 'background', op: 'setSettings', payload: { schemaId: requested } })
  } catch (error) {
    select.value = committedSchemaId
    $('engine-text').textContent = String((error && error.message) || error)
  } finally {
    switching = false
    select.disabled = false
  }
  await refresh()
})

$('trad-simp').addEventListener('change', async event => {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.tradSimp]: event.target.value })
  } catch (error) {
    $('engine-text').textContent = String((error && error.message) || error)
  }
  await refresh()
})

$('open-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage()
})

refresh()
setInterval(refresh, 1200)
