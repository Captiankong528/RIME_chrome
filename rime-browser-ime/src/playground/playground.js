/**
 * 演练场的辅助脚本。
 *
 * 这段逻辑原来写成 playground.html 里的内联 <script>，被扩展自己的 CSP
 * （`script-src 'self' 'wasm-unsafe-eval'`，不允许 inline）直接拦掉了，
 * 所以状态文字一直是「读取中…」。扩展页面里不要用内联脚本。
 */
;(function () {
  const state = document.getElementById('state')
  const paint = enabled => {
    state.textContent = enabled ? '已开启' : '已关闭'
  }
  chrome.storage.local.get({ enabled: false }).then(s => paint(s.enabled))
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.enabled) paint(Boolean(changes.enabled.newValue))
  })
})()
