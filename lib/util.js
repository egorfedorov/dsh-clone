/**
 * Small dependency-free helpers shared by the Host half and the tests.
 * Nothing here touches the filesystem or the Harness: keep it pure so the
 * smoke test can exercise it in plain Node.
 */

/** Clamp a candidate lane count into the supported range. */
export function clampLanes(value, { min = 1, max = 4, fallback = 3 } = {}) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  const rounded = Math.floor(numeric)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

/** Normalize an unknown thrown value into one readable line. */
export function reasonOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/gu, ' ').trim().slice(0, 400) || 'unknown error'
}

/** Cut a string to a display budget without splitting a surrogate pair. */
export function truncate(text, limit) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  const cut = value.slice(0, Math.max(0, limit - 1))
  return `${Array.from(cut).slice(0, -1).join('')}…`
}

/** Stable, filesystem-safe slug for the picked clone's destination folder. */
export function slugify(text, fallback = 'clone') {
  const value = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[-_.]+|[-_.]+$/gu, '')
  return value.length === 0 ? fallback : value.slice(0, 40)
}

/** Human duration for the panel: 4.2s, 1m 07s, 12m. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return rest === 0 ? `${minutes}m` : `${minutes}m ${String(rest).padStart(2, '0')}s`
}

/** Total token count for one lane's accumulated usage. */
export function totalTokens(tokens) {
  if (tokens === null || tokens === undefined) return 0
  const input = Number(tokens.input) || 0
  const output = Number(tokens.output) || 0
  const cache = Number(tokens.cacheRead) || 0
  return input + output + cache
}

/** Lowercase file extension including the dot, or '' when there is none. */
export function extensionOf(filePath) {
  const name = String(filePath ?? '')
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot).toLowerCase()
}

/** Whether a path ends in a readable raster image extension. */
export function isImagePath(filePath) {
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extensionOf(filePath))
}

/** Media type for the raster formats dsh-clone accepts as a reference. */
export function mediaTypeOf(filePath) {
  switch (extensionOf(filePath)) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return undefined
  }
}
