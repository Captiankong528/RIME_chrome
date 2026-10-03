/**
 * 全局常量。
 *
 * 这个文件同时被两种环境加载：
 *   1. content script —— 普通脚本，通过 manifest 的 js 数组按顺序注入，与其他
 *      content 文件共享同一个 isolated world 全局作用域。
 *   2. 扩展页面（service worker / offscreen / options / playground）—— ES module，
 *      用 `import './const.js'` 触发求值。
 *
 * 因此这里不写 import / export，只往 globalThis 上挂一个命名空间，
 * 两种环境都能拿到同一份定义，避免消息类型字符串两边各写一遍。
 */
;(function () {
  /* ------------------------------------------------------------------ *
   * 方案依赖
   *
   * targets 是这个方案运行所需的**全部** schemas/<target>/ 目录，包含反查依赖：
   * 双拼要借朙月拼音的词库，五笔要借袖珍简拼做反查，注音要借地球拼音。
   * 少写一个目录，select_schema 就会因为找不到 .table.bin 而失败。
   * 依赖关系照抄上游 schemas.json 的 dependencies 字段。
   * ------------------------------------------------------------------ */

  const LUNA = ['luna-pinyin', 'stroke']
  const DOUBLE_PINYIN = ['double-pinyin', 'luna-pinyin', 'stroke']
  const WUBI = ['wubi', 'pinyin-simp', 'stroke']
  const BOPOMOFO = ['bopomofo', 'terra-pinyin', 'stroke']

  /* ------------------------------------------------------------------ *
   * 简繁默认值（跟随浏览器语言）
   *
   * librime 出简体还是繁体，由方案自己声明的开关决定，而这些开关的 reset 是
   * **方案作者**的偏好，不是用户的：朙月拼音 / 双拼 / 地球拼音的
   * simplification 一律 reset 0 =「漢字」，于是谁用都是繁体。
   *
   * 上游 my_rime 是按浏览器语言选默认的（见 reference/my_rime/src/control.ts 的
   * getDefaultVariantIndex），改造成扩展时这段逻辑丢了。这里照抄它的 variant 表，
   * 只保留我们注册的这 15 个方案：
   *
   *   * 每项是 { name, options, when?[, sample] }：options 是要下发给 librime 的开关
   *     取值，when 是命中的语言子标签（任一命中就选它），没有 when 的作兜底默认。
   *   * 顺序有意义：先命中先算，所以 zh-Hant-TW 落到「臺」而不是「繁」。
   *   * 同一个方案的每个 variant 都要把该组开关写全——注音的
   *     zh_hant / zh_hans / zh_hant_tw 是三个独立 option，只设一个会残留上一次的取值。
   *   * 表里没有的方案（袖珍简拼 / 86五笔 / 86五笔·拼音 / 五笔画）压根没有简繁开关，
   *     词库本身是单一字形，不要下发任何东西。
   *   * 86五笔·繁体 同样不进表：它的词库是简体 + s2t 转换，yaml 里自己 reset: 1，
   *     默认就该出繁体；想要简体请用 86五笔。
   * ------------------------------------------------------------------ */

  /** 「繁体优先」的语言子标签：zh-TW / zh-HK / zh-MO / zh-Hant* */
  const TRADITIONAL_TAGS = ['tw', 'hk', 'mo', 'hant']

  /** 把 'zh-Hant-TW' 拆成 {'zh','hant','tw'}：只看子标签，不管大小写和顺序 */
  function localeSubtags (locale) {
    return new Set(String(locale || '').toLowerCase().split(/[-_]/).filter(Boolean))
  }

  /** 浏览器语言是不是繁体地区（zh-TW / zh-HK / zh-MO / zh-Hant 系） */
  function prefersTraditional (locale) {
    const tags = localeSubtags(locale)
    return TRADITIONAL_TAGS.some(tag => tags.has(tag))
  }

  /**
   * 简繁两态：一个 simplification 开关。
   * probe 只有全拼类方案能给——双拼的键位不是拼音字母，同一个探针词打不出来。
   */
  function binaryVariants (probe) {
    const simplified = { name: '简', options: { simplification: true } }
    const traditional = { name: '繁', options: { simplification: false }, when: TRADITIONAL_TAGS }
    if (probe) {
      simplified.sample = { input: probe, expect: '汉字' }
      traditional.sample = { input: probe, expect: '漢字' }
    }
    return [simplified, traditional]
  }

  /** 注音三态：简 / 臺(zh-TW) / 繁(zh-HK·zh-MO·zh-Hant) */
  const BOPOMOFO_VARIANTS = [
    { name: '简', options: { zh_hans: true, zh_hant: false, zh_hant_tw: false } },
    { name: '臺', options: { zh_hant_tw: true, zh_hans: false, zh_hant: false }, when: ['tw'] },
    { name: '繁', options: { zh_hant: true, zh_hans: false, zh_hant_tw: false }, when: ['hk', 'mo', 'hant'] }
  ]

  const TRAD_SIMP = {
    luna_pinyin: binaryVariants('hanzi'),
    luna_pinyin_fluency: binaryVariants('hanzi'),
    terra_pinyin: binaryVariants('hanzi'),
    double_pinyin: binaryVariants(),
    double_pinyin_abc: binaryVariants(),
    double_pinyin_flypy: binaryVariants(),
    double_pinyin_mspy: binaryVariants(),
    double_pinyin_pyjj: binaryVariants(),
    bopomofo: BOPOMOFO_VARIANTS,
    bopomofo_express: BOPOMOFO_VARIANTS
  }

  /**
   * 这个方案在当前偏好与浏览器语言下该用哪个简繁 variant。
   *
   * @param {string} schemaId
   * @param {string} locale navigator.language，例如 'zh-CN' / 'zh-Hant-TW'
   * @param {string} [preference] 'auto'（跟随浏览器语言）或某个 variant 名（'简' / '繁' / '臺' …）。
   *        名字在**当前方案**里不存在时退回语言默认——用户可能在注音里选了「臺」，
   *        再切到朙月拼音，那边根本没有这个 variant。
   * @returns {{name: string, options: Record<string, boolean>,
   *            sample?: {input: string, expect: string}}|null} null = 该方案没有简繁开关
   */
  function tradSimpDefault (schemaId, locale, preference = 'auto') {
    const variants = TRAD_SIMP[schemaId]
    if (!variants) return null
    if (preference && preference !== 'auto') {
      const picked = variants.find(v => v.name === preference)
      if (picked) return picked
    }
    const tags = localeSubtags(locale)
    return variants.find(v => (v.when || []).some(tag => tags.has(tag))) || variants[0]
  }

  globalThis.RIME_CONST = {
    /** 消息类型 */
    MSG: {
      /** content -> background：转发给引擎的请求 */
      ENGINE_REQUEST: 'rime:engine-request',
      /** background -> offscreen：发给引擎宿主的请求 */
      OFFSCREEN_REQUEST: 'rime:offscreen-request',
      /** 引擎 -> 页面：主动推送的状态（就绪/出错/正在加载） */
      ENGINE_STATUS: 'rime:engine-status',
      /** background -> content：开关状态变化、设置变化 */
      SETTINGS_CHANGED: 'rime:settings-changed'
    },

    /**
     * 引擎操作。
     *
     * 这里刻意**没有** deploy：我们的方案是直接消费上游用原生 rime_api_console
     * 部署好的 @rime-contrib/* 产物，浏览器里不跑部署流程。而 librime 的
     * start_maintenance 会在结束时回调 api.cpp 里的 _deployStatus（EM_ASM），
     * 保留一个半通的 deploy 只会制造一个走不通又难查的入口。
     */
    OP: {
      STATUS: 'status',
      INIT: 'init',
      LOAD_SCHEMA: 'loadSchema',
      PROCESS: 'process',
      SELECT_CANDIDATE: 'selectCandidate',
      CHANGE_PAGE: 'changePage',
      SET_OPTION: 'setOption',
      SET_PAGE_SIZE: 'setPageSize',
      RESET: 'reset'
    },

    /** librime 回传的 state 枚举，见 reference/my_rime/wasm/api.cpp */
    RIME_STATE: {
      COMMITTED: 0,
      ACCEPTED: 1,
      REJECTED: 2,
      UNHANDLED: 3
    },

    /** 引擎宿主状态 */
    ENGINE_STATE: {
      IDLE: 'idle',
      LOADING: 'loading',
      READY: 'ready',
      ERROR: 'error'
    },

    /** 可选的输入法。group 只用于设置页分组显示 */
    SCHEMAS: [
      // 音码
      { id: 'luna_pinyin', name: '朙月拼音', group: '音码', targets: LUNA },
      { id: 'luna_pinyin_fluency', name: '朙月拼音·语句流', group: '音码', targets: LUNA },
      { id: 'pinyin_simp', name: '袖珍简拼', group: '音码', targets: ['pinyin-simp', 'stroke'] },
      { id: 'terra_pinyin', name: '地球拼音', group: '音码', targets: ['terra-pinyin', 'stroke'] },

      // 双拼（共用一个包，词库借朙月拼音）
      { id: 'double_pinyin', name: '自然码双拼', group: '双拼', targets: DOUBLE_PINYIN },
      { id: 'double_pinyin_flypy', name: '小鹤双拼', group: '双拼', targets: DOUBLE_PINYIN },
      { id: 'double_pinyin_mspy', name: '微软双拼', group: '双拼', targets: DOUBLE_PINYIN },
      { id: 'double_pinyin_abc', name: '智能ABC双拼', group: '双拼', targets: DOUBLE_PINYIN },
      { id: 'double_pinyin_pyjj', name: '拼音加加双拼', group: '双拼', targets: DOUBLE_PINYIN },

      // 注音
      { id: 'bopomofo', name: '注音', group: '注音', targets: BOPOMOFO },
      { id: 'bopomofo_express', name: '注音·快打', group: '注音', targets: BOPOMOFO },

      // 形码
      { id: 'wubi86', name: '86五笔', group: '形码', targets: WUBI },
      { id: 'wubi_pinyin', name: '86五笔·拼音', group: '形码', targets: WUBI },
      { id: 'wubi_trad', name: '86五笔·繁体', group: '形码', targets: WUBI },
      { id: 'stroke', name: '五笔画', group: '形码', targets: ['stroke', 'luna-pinyin'] }
    ],

    DEFAULTS: {
      schemaId: 'luna_pinyin',
      pageSize: 5
    },

    /**
     * 状态栏自己的偏好存这两个键。
     *
     * 直接放 chrome.storage.local，理由和「设置一律由 background 下发」不冲突：
     * content script 有 storage 权限，而状态栏是**每个标签页各自**的界面，
     * 走background 反而要多加一套转发与白名单。storage.onChanged 负责跨标签页同步。
     */
    STORAGE_KEYS: {
      /** 'auto' = 跟随浏览器语言；也可以是 variant 名（'简' / '繁' / '臺' …） */
      tradSimp: 'statusBarTradSimp',
      /** 状态栏是否收成右下角的小胶囊 */
      collapsed: 'statusBarCollapsed'
    },

    /** 简繁默认值表：哪些方案有开关、浏览器语言怎么决定默认（见文件上半部分的注释） */
    TRAD_SIMP,
    prefersTraditional,
    tradSimpDefault
  }
})()
