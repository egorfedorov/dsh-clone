/**
 * The HTTP surface of the Host half: one JSON feed, one reference image, one
 * action endpoint, and a static file route that serves each lane's build.
 *
 * Lane output is model-written HTML, so it is served into an opaque origin:
 * the `sandbox` CSP directive without `allow-same-origin` means a clone can
 * run its own scripts but cannot touch this page's cookies, storage, or API.
 */

import { extname, join, normalize, sep } from 'node:path'

/** Content types the preview route may answer with. */
const MEDIA_TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
}))

/** Media type for a previewable file, defaulting to a binary-safe type. */
export function mediaTypeFor(filePath) {
  return MEDIA_TYPES.get(extname(String(filePath ?? '')).toLowerCase()) ?? 'application/octet-stream'
}

/** Response headers shared by every previewed file. */
export const PREVIEW_HEADERS = {
  'Content-Security-Policy': "sandbox allow-scripts allow-forms allow-modals allow-popups; default-src 'self' data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
}

/** Resolve a request path inside one directory, or null when it escapes. */
export function safeJoin(root, relativePath) {
  const cleaned = String(relativePath ?? '').replace(/^\/+/u, '')
  const normalized = normalize(cleaned)
  if (normalized.startsWith('..') || normalized.includes(`..${sep}`) || normalized.includes('\0')) return null
  const absolute = join(root, normalized)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (absolute !== root && !absolute.startsWith(prefix)) return null
  return absolute
}

/** Write one JSON response. */
export function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Length', Buffer.byteLength(body))
  response.end(body)
}

/** Write a small plain-text rejection. */
export function sendText(response, status, text) {
  response.statusCode = status
  response.setHeader('Content-Type', 'text/plain; charset=utf-8')
  response.end(text)
}

/** Read and parse a bounded JSON request body. */
export async function readJsonBody(request, { limit = 64 * 1024 } = {}) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request body must be an object')
  return parsed
}

/** Serve one file from a lane directory with preview-safe headers. */
export async function serveLaneFile({ fs, root, relativePath, response }) {
  let relative = String(relativePath ?? '')
  if (relative.length === 0 || relative.endsWith('/')) relative = `${relative}index.html`
  const absolute = safeJoin(root, relative)
  if (absolute === null) {
    sendText(response, 403, 'forbidden')
    return
  }
  const stats = await fs.stat(absolute).catch(() => null)
  if (stats === null || !stats.isFile()) {
    sendText(response, 404, 'not found')
    return
  }
  const body = await fs.readFile(absolute)
  response.statusCode = 200
  response.setHeader('Content-Type', mediaTypeFor(absolute))
  response.setHeader('Content-Length', body.length)
  for (const [name, value] of Object.entries(PREVIEW_HEADERS)) response.setHeader(name, value)
  response.end(body)
}

/** Serve one image file (the reference screenshot) with its own media type. */
export async function serveImageFile({ fs, path, mediaType, response }) {
  const body = await fs.readFile(path).catch(() => null)
  if (body === null) {
    sendText(response, 404, 'not found')
    return
  }
  response.statusCode = 200
  response.setHeader('Content-Type', mediaType ?? mediaTypeFor(path))
  response.setHeader('Content-Length', body.length)
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.end(body)
}

/**
 * Parse `/api/dsh-clone/preview/<cloneId>/<lane>/<rest>`.
 * @returns `{ cloneId, lane, rest }` or null for a malformed path.
 */
export function parsePreviewPath(pathname) {
  const prefix = '/api/dsh-clone/preview/'
  if (!pathname.startsWith(prefix)) return null
  const parts = pathname.slice(prefix.length).split('/')
  const cloneId = parts.shift() ?? ''
  const lane = Number(parts.shift())
  if (!/^[a-z0-9]{1,32}$/iu.test(cloneId)) return null
  if (!Number.isInteger(lane) || lane < 1 || lane > 8) return null
  return { cloneId, lane, rest: parts.join('/') }
}
