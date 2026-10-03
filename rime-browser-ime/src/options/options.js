import '../common/const.js'

const { SCHEMAS, DEFAULTS, ENGINE_STATE, tradSimpDefault } = globalThis.RIME_CONST

const $ = id => document.getElementById(id)

/* ---------------- 初始化界面 ---------------- */

/**
 * 按 SCHEMAS 里的 group 字段分组渲染成 <optgroup>。
 * 15 个方案平铺成一个下拉框时不好找，分组后按「音码/双拼/注音/形码」归类。
 */
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

/**
 * @param {{state: string, message?: string, schemaId?: string}} engine
 * @param {'offscreen'|'local'|undefined} mode 引擎宿主形态：Chrome 在 offscreen 文档里，
 *        Firefox 就地跑在背景页里。同一个扩展的两个包行为不同，界面上标出来省得误会。
 */
function renderEngine (engine, mode) {
  const dot = $('engine-dot')
  const text = $('engine-text')
  const state = (engine && engine.state) || ENGINE_STATE.IDLE
  dot.className = 'dot ' + state
  const host = mode === 'local' ? '背景页宿主' : mode === 'offscreen' ? 'offscreen 宿主' : ''
  const labels = {
    [ENGINE_STATE.IDLE]: '未启动（打开输入法后会自动加载）',
    [ENGINE_STATE.LOADING]: engine.message || '正在加载…',
    [ENGINE_STATE.READY]: '就绪' + (engine.schemaId ? ` · ${engine.schemaId}` : '') + (host ? ` · ${host}` : ''),
    [ENGINE_STATE.ERROR]: engine.message || '出错了'
  }
  text.textContent = labels[state] || state
}

/**
 * 上一次由后台确认生效的方案。切换失败时要回滚到它——不能读 select 当前值，
 * 因为用户已经把它改成了新方案。
 */
let committedSchemaId = DEFAULTS.schemaId

function renderSettings (settings) {
  committedSchemaId = settings.schemaId || DEFAULTS.schemaId
  $('schema').value = committedSchemaId
  $('page-size').value = settings.pageSize || DEFAULTS.pageSize
  $('toggle').textContent = settings.enabled ? '已开启，点击关闭' : '已关闭，点击开启'
  $('toggle').classList.toggle('primary', !settings.enabled)
}

async function send (message) {
  const response = await chrome.runtime.sendMessage(message)
  if (!response) throw new Error('后台没有响应')
  if (!response.ok) throw new Error(response.error)
  return response.result
}

/** 切换方案进行中：暂停轮询刷新，否则 1.5 秒一次的 refresh 会覆盖「正在装载…」 */
let switching = false

async function refresh () {
  if (switching) return
  try {
    const { settings, engine, engineMode } = await send({ to: 'background', op: 'getState' })
    if (switching) return
    renderSettings(settings)
    renderEngine(engine, engineMode)
  } catch (error) {
    $('engine-text').textContent = String(error.message || error)
  }
}

/* ---------------- 交互 ---------------- */

$('toggle').addEventListener('click', async () => {
  await send({ to: 'background', op: 'toggle' })
  await refresh()
})

$('schema').addEventListener('change', async event => {
  // 首次切到某个方案要把它的词典（几 MB）写进引擎内存文件系统，可能几秒，
  // 这里给出明确的等待反馈，避免用户以为点了没反应而反复切换。
  const select = event.target
  const requested = select.value
  switching = true
  select.disabled = true
  $('engine-text').textContent = '正在装载…'
  try {
    await send({ to: 'background', op: 'setSettings', payload: { schemaId: requested } })
  } catch (error) {
    select.value = committedSchemaId
    $('engine-text').textContent = String(error.message || error)
  } finally {
    switching = false
    select.disabled = false
  }
  await refresh()
})

$('page-size').addEventListener('change', async event => {
  const size = Math.min(10, Math.max(1, Number(event.target.value) || DEFAULTS.pageSize))
  event.target.value = size
  await send({ to: 'background', op: 'setSettings', payload: { pageSize: size } })
})

$('purge').addEventListener('click', async () => {
  if (!confirm('清空用户词频与用户词典？此操作不可撤销。')) return
  await send({ to: 'background', op: 'setSettings', payload: { resetUserData: true } })
  alert('已清空。')
})

$('open-playground').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/playground/playground.html') })
})

/* ---------------- 自检 ---------------- */

/**
 * 逐层跑一遍输入链路。设计目标是：任何一层断了，这里直接显示原因，
 * 不用让用户去翻 service worker 的控制台。
 */
async function runSelfTest () {
  const list = $('self-test-result')
  const button = $('self-test')
  button.disabled = true
  button.textContent = '自检中…'
  list.hidden = false
  list.replaceChildren()

  const step = (name, ok, detail) => {
    const li = document.createElement('li')
    li.className = ok ? 'ok' : 'fail'
    const mark = document.createElement('span')
    mark.className = 'mark'
    mark.textContent = ok ? '✓' : '✗'
    const label = document.createElement('span')
    label.className = 'name'
    label.textContent = name
    li.append(mark, label)
    if (detail) {
      const detailEl = document.createElement('span')
      detailEl.className = 'detail'
      detailEl.textContent = detail
      li.append(detailEl)
    }
    list.append(li)
    return ok
  }

  let schemaId = DEFAULTS.schemaId
  /** 简繁默认值那一步的结果，最后并进「结论」 */
  let tradSimpOk = true
  try {
    // 1. service worker 是否活着并认识我们的协议
    const state = await send({ to: 'background', op: 'getState' })
    schemaId = state.settings.schemaId || schemaId
    step('background 路由', true, `开关=${state.settings.enabled ? '开' : '关'} 方案=${schemaId}`)

    // 2. 引擎宿主（Chrome 在 offscreen 文档里、Firefox 就地跑在背景页里）
    //    + 引擎 Worker + wasm 编译 + rime.data 装载
    const t0 = Date.now()
    const status = await send({ to: 'engine', op: 'status', payload: {} })
    step(state.engineMode === 'local' ? '背景页宿主 + 引擎 Worker' : 'offscreen 文档 + 引擎 Worker',
      true, `就绪，耗时 ${Date.now() - t0} ms`)

    // 3. 预编译方案能不能被 set_ime 直接命中
    const loaded = await send({ to: 'engine', op: 'loadSchema', payload: { schemaId } })
    step('装载预编译方案', true,
      loaded.written && loaded.written.length ? `写入 ${loaded.written.length} 个文件` : '已缓存')

    // 3b. 简繁：默认跟随浏览器语言（zh-TW / zh-HK / zh-MO / zh-Hant 才出繁体）
    //     不只是报个数——引擎每次 set_ime 都会把开关重置回方案 yaml 的默认值
    //     （朙月拼音的默认是繁体），所以这里顺手验证「装载时下发的那一刀」真的生效了。
    const variant = tradSimpDefault(schemaId, navigator.language)
    if (!variant) {
      step('简繁默认', true, `该方案没有简繁开关（浏览器语言 ${navigator.language}）`)
    } else if (!variant.sample) {
      step('简繁默认', true, `默认字形「${variant.name}」（浏览器语言 ${navigator.language}）`)
    } else {
      await send({ to: 'engine', op: 'process', payload: { input: '{Escape}', schemaId } })
      let probe = null
      for (const ch of variant.sample.input) {
        probe = await send({ to: 'engine', op: 'process', payload: { input: ch, schemaId } })
      }
      // send() 返回的就是引擎的 result（自检里那几处 .result.result 曾经多取了一层，
      // Firefox e2e 点自检时炸了：can't access property "candidates", probe.result is undefined）
      const first = probe && probe.candidates && probe.candidates[0]
      const got = first && first.text
      tradSimpOk = step('简繁默认', got === variant.sample.expect,
        `默认字形「${variant.name}」（浏览器语言 ${navigator.language}）：` +
        `${variant.sample.input} 首候选 ${JSON.stringify(got)}，期望 ${JSON.stringify(variant.sample.expect)}`)
      await send({ to: 'engine', op: 'process', payload: { input: '{Escape}', schemaId } })
    }

    // 4. 真正打一次字：走的是和页面上完全相同的 process 接口
    await send({ to: 'engine', op: 'process', payload: { input: '{Escape}', schemaId } })
    let last = null
    for (const ch of 'nihao') {
      last = await send({ to: 'engine', op: 'process', payload: { input: ch, schemaId } })
    }
    const candidates = (last.candidates || []).map(c => c.text).join(' / ')
    step('组字得到候选', Boolean(last.candidates && last.candidates.length), candidates)

    const space = await send({ to: 'engine', op: 'process', payload: { input: ' ', schemaId } })
    const committed = space.committed
    step('nihao + 空格 → 你好', committed === '你好', `实际上屏 ${JSON.stringify(committed)}`)
    await send({ to: 'engine', op: 'process', payload: { input: '{Escape}', schemaId } })

    step('结论', committed === '你好' && tradSimpOk,
      committed === '你好' && tradSimpOk
        ? '输入链路完全正常，可以去任意网页打字了'
        : '链路能通但结果不对，把上面几行发给我')
  } catch (error) {
    step('链路中断', false, String((error && error.message) || error))
    step('结论', false, '把上面这条错误发给我即可定位')
  } finally {
    button.disabled = false
    button.textContent = '运行自检'
    refresh()
  }
}

$('self-test').addEventListener('click', runSelfTest)

refresh()
setInterval(refresh, 1500)
