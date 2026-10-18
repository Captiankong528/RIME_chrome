/**
 * RIME 输入法插件的 Host 半边。
 *
 * 浏览器端（Client 半边）需要三个大件才能跑起 librime：rime.js、rime.wasm、
 * rime.data，以及每个输入方案的预编译词典（.prism.bin / .table.bin / .yaml）。
 * 这些是二进制资源，不能塞进 Client 的 JS bundle，所以由这里用只读 HTTP 路由
 * 供给页面：
 *
 *   GET  /rime-ime/config.json     → 页面启动时的默认值
 *   GET  /rime-ime/engine/*        → rime.js / rime.wasm / rime.data / worker.js
 *   GET  /rime-ime/schemas/*       → 方案清单与各方案的预编译产物
 *   POST /rime-ime/diagnostics     → 页面把自检与错误写进诊断日志
 *
 * 路由挂在 dsh 的 `webServer` 服务上；DSH Desktop 的 WebServer 会给渲染进程加
 * 一个代际令牌，所以只有 App 自己的页面能取到这些资源（普通浏览器 403）。
 *
 * 所有资源都以「文件」为单位流式返回，且做了路径穿越防护——`assets/` 之外一律 404。
 */
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 路由前缀。页面侧同名常量在 client.js 的 BASE 里。 */
const ROUTE = '/rime-ime'
/** 资源根目录：`<包目录>/assets`，由 scripts/prepare-assets.mjs 生成。 */
const ASSETS_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'assets')
/** 诊断日志上限，防止页面写疯了把磁盘写满。 */
const DIAGNOSTICS_MAX_BYTES = 256 * 1024

const CONTENT_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.data': 'application/octet-stream',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
}

const DEFAULTS = {
  defaultSchemaId: 'luna_pinyin',
  pageSize: 5,
  selfTest: true,
  /** 诊断日志路径；不配置时落在 DSH_HOME/logs/ 下。 */
  diagnosticsPath: ''
}

function resolveOptions (config) {
  const source = config && typeof config === 'object' ? config : {}
  return {
    defaultSchemaId: typeof source.defaultSchemaId === 'string' && source.defaultSchemaId ? source.defaultSchemaId : DEFAULTS.defaultSchemaId,
    pageSize: Number.isFinite(source.pageSize) && source.pageSize >= 1 && source.pageSize <= 9 ? Math.floor(source.pageSize) : DEFAULTS.pageSize,
    selfTest: source.selfTest === undefined ? DEFAULTS.selfTest : Boolean(source.selfTest),
    diagnosticsPath: typeof source.diagnosticsPath === 'string' && source.diagnosticsPath ? source.diagnosticsPath : defaultDiagnosticsPath()
  }
}

function defaultDiagnosticsPath () {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'logs', 'rime-ime-diagnostics.log')
}

export function apply (ctx, config) {
  const options = resolveOptions(config)

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: (req, res) => handle(req, res, options)
    }), 'rime-ime: asset route')
  })
}

async function handle (req, res, options) {
  let url
  try {
    url = new URL(req.url || '/', 'http://dsh.invalid')
  } catch {
    return sendText(res, 400, 'bad request')
  }

  const relative = url.pathname.slice(ROUTE.length).replace(/^\/+/, '')

  if (relative === 'config.json') {
    if (!allowRead(req, res)) return
    return sendJson(res, {
      base: `${ROUTE.slice(1)}/`,
      defaultSchemaId: options.defaultSchemaId,
      pageSize: options.pageSize,
      selfTest: options.selfTest
    }, req)
  }

  if (relative === 'diagnostics') {
    if (req.method === 'POST') return receiveDiagnostics(req, res, options)
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!allowRead(req, res)) return
      return streamDiagnostics(res, options, req.method === 'HEAD')
    }
    return sendText(res, 405, 'method not allowed')
  }

  if (relative === '' || relative === 'health') {
    if (!allowRead(req, res)) return
    return sendJson(res, {
      ok: true,
      assets: existsSync(ASSETS_ROOT),
      diagnosticsPath: options.diagnosticsPath,
      defaultSchemaId: options.defaultSchemaId,
      pageSize: options.pageSize
    }, req)
  }

  if (!allowRead(req, res)) return
  return streamAsset(req, res, relative)
}

function allowRead (req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') return true
  sendText(res, 405, 'method not allowed')
  return false
}

function streamAsset (req, res, relative) {
  let decoded
  try {
    decoded = decodeURIComponent(relative)
  } catch {
    return sendText(res, 400, 'bad path')
  }
  if (decoded.includes('\0')) return sendText(res, 400, 'bad path')

  const target = resolve(ASSETS_ROOT, decoded)
  if (target !== ASSETS_ROOT && !target.startsWith(ASSETS_ROOT + sep)) return sendText(res, 404, 'not found')

  let info
  try {
    info = statSync(target)
  } catch {
    return sendText(res, 404, 'not found')
  }
  if (!info.isFile()) return sendText(res, 404, 'not found')

  const headers = {
    'content-type': CONTENT_TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
    'content-length': String(info.size),
    // 本地回环上的静态资源：让浏览器每次再验证一次，插件重装后立即生效。
    'cache-control': 'no-cache'
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(target)
  stream.on('error', (error) => {
    ctxLog(options, 'asset-stream-error', { relative, message: String(error && error.message || error) })
    res.destroy()
  })
  stream.pipe(res)
}

async function receiveDiagnostics (req, res, options) {
  const body = await readBody(req, DIAGNOSTICS_MAX_BYTES)
  if (body === null) return sendText(res, 413, 'payload too large')
  let entry
  try {
    entry = JSON.parse(body)
  } catch {
    return sendText(res, 400, 'bad json')
  }

  const line = JSON.stringify({
    at: new Date().toISOString(),
    ...normalizeEntry(entry)
  }) + '\n'

  try {
    mkdirSync(dirname(options.diagnosticsPath), { recursive: true })
    await appendFile(options.diagnosticsPath, line, 'utf8')
  } catch (error) {
    return sendText(res, 500, `cannot write diagnostics: ${String(error && error.message || error)}`)
  }

  res.writeHead(204, { 'cache-control': 'no-store' })
  res.end()
}

function normalizeEntry (entry) {
  if (!entry || typeof entry !== 'object') return { event: 'unknown', detail: String(entry) }
  const { event, detail, ...rest } = entry
  return {
    event: typeof event === 'string' ? event.slice(0, 120) : 'unknown',
    detail: detail === undefined ? null : detail,
    ...rest
  }
}

function streamDiagnostics (res, options, headOnly) {
  if (!existsSync(options.diagnosticsPath)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('')
    return
  }
  const info = statSync(options.diagnosticsPath)
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(info.size),
    'cache-control': 'no-store'
  })
  if (headOnly) {
    res.end()
    return
  }
  createReadStream(options.diagnosticsPath).pipe(res)
}

function sendJson (res, value, req) {
  const body = JSON.stringify(value)
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store'
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function sendText (res, status, text) {
  const body = String(text)
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store'
  })
  res.end(body)
}

function readBody (req, limit) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        chunks.length = 0
        resolveBody(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolveBody(Buffer.concat(chunks).toString('utf8'))
      } catch (error) {
        rejectBody(error)
      }
    })
    req.on('error', () => resolveBody(null))
  })
}

/** Host 侧只记路由本身的异常；页面事件由页面经 /diagnostics 写进同一份日志。 */
function ctxLog (options, event, detail) {
  try {
    mkdirSync(dirname(options.diagnosticsPath), { recursive: true })
    appendFile(options.diagnosticsPath, JSON.stringify({ at: new Date().toISOString(), source: 'host', event, detail }) + '\n', 'utf8').catch(() => {})
  } catch {
    /* 日志写不进去不影响输入 */
  }
}
