/**
 * The acceptance gate.
 *
 * A similarity score answers "does it look like the reference". It does not
 * answer the question people actually ask first: *does the page work*. A build
 * can score 93% and still reference an image that is not in the folder, pull a
 * font from a CDN the deliverable is not allowed to touch, or ship "Lorem
 * ipsum" where the copy should be.
 *
 * So every delivered lane passes a deterministic, model-free checklist before it
 * is even scored. The checks are static: they read the files, never run them, so
 * they cannot flake and cost nothing. A lane that fails is kept for inspection
 * but cannot be adopted.
 */

/** Copy that means the builder stopped early. */
const PLACEHOLDER_PATTERNS = [
  /\btodo\b/iu,
  /\blorem ipsum\b/iu,
  /\bplaceholder text\b/iu,
  /\byour text here\b/iu,
  /\bcoming soon\b/iu,
  /\binsert .{0,20}here\b/iu,
  /\bxxx+\b/iu,
]

/** Attributes that make a form control reachable by assistive tech. */
const CONTROL_ATTRS = /(aria-label|aria-labelledby|title|placeholder)\s*=/iu

/**
 * Run the gate over one delivered lane directory.
 * @param args - `{ fs, dir, files }` where files is the lane inventory.
 * @returns `{ pass, checks }`; every check carries an id, ok and a detail.
 */
export async function runAcceptance({ fs, dir, files }) {
  const inventory = new Set((Array.isArray(files) ? files : []).map((file) => file.path))
  const reads = new Map()
  const read = async (relative) => {
    if (reads.has(relative)) return reads.get(relative)
    let text = null
    try {
      text = await fs.readFile(joinPath(dir, relative), 'utf8')
    } catch {
      text = null
    }
    reads.set(relative, text)
    return text
  }

  const checks = []
  const record = (id, ok, detail) => checks.push({ id, ok, detail })

  const html = await read('index.html')
  if (html === null) {
    record('page', false, 'index.html is missing')
    return { pass: false, checks }
  }

  // ── 1. a real document, not an empty shell ────────────────────────────────
  const text = stripComments(html)
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/iu.exec(text)
  const body = bodyMatch === null ? '' : bodyMatch[1]
  const visible = stripTags(body).replace(/\s+/gu, ' ').trim()
  const elementCount = (body.match(/<[a-z][^>]*>/giu) ?? []).length
  const pageOk = visible.length >= 40 || elementCount >= 12
  record('page', pageOk,
    pageOk
      ? `${visible.length} characters of copy, ${elementCount} elements`
      : `the page is nearly empty (${visible.length} characters of copy, ${elementCount} elements)`)

  // ── 2. document metadata ─────────────────────────────────────────────────
  const lang = /<html[^>]*\blang\s*=\s*("[^"]+"|'[^']+'|[^\s>]+)/iu.exec(text)
  const title = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(text)
  const metaOk = lang !== null && title !== null && stripTags(title[1]).trim().length > 0
  record('document-meta', metaOk,
    metaOk
      ? `lang=${lang[1].replace(/['"]/gu, '')}, title "${stripTags(title[1]).trim().slice(0, 60)}"`
      : `missing ${lang === null ? '<html lang>' : ''}${lang === null && title === null ? ' and ' : ''}${title === null || stripTags(title[1]).trim().length === 0 ? '<title>' : ''}`)

  // ── 3. every local reference resolves, and nothing points outside ────────
  const references = collectReferences(text)
  for (const css of inventory) {
    if (!css.endsWith('.css')) continue
    const source = await read(css)
    if (source !== null) references.push(...collectCssReferences(source, dirnameOf(css)))
  }

  const external = references.filter((reference) => isExternal(reference.target))
  record('no-external', external.length === 0,
    external.length === 0
      ? `${references.length} references, all local`
      : `fetches ${external.slice(0, 3).map((reference) => reference.target).join(', ')}`)

  const missing = []
  for (const reference of references) {
    if (isExternal(reference.target) || reference.target.startsWith('data:')) continue
    const resolved = normaliseRelative(reference.base, reference.target)
    if (resolved === null) continue
    if (!inventory.has(resolved)) missing.push(reference.target)
  }
  record('assets', missing.length === 0,
    missing.length === 0
      ? 'every referenced file exists in the lane'
      : `missing: ${[...new Set(missing)].slice(0, 4).join(', ')}`)

  // ── 4. no leftover placeholder copy ──────────────────────────────────────
  const placeholder = PLACEHOLDER_PATTERNS
    .map((pattern) => pattern.exec(visible))
    .find((match) => match !== null)
  record('no-placeholder', placeholder === undefined,
    placeholder === undefined
      ? 'no placeholder copy'
      : `placeholder copy: "${placeholder[0]}"`)

  // ── 5. images carry alt text ─────────────────────────────────────────────
  const images = [...body.matchAll(/<img\b([^>]*)>/giu)].map((match) => match[1])
  const withoutAlt = images.filter((attributes) => !/\balt\s*=/iu.test(attributes))
  record('images-alt', withoutAlt.length === 0,
    images.length === 0
      ? 'no <img> elements'
      : withoutAlt.length === 0
        ? `${images.length} image(s) with alt`
        : `${withoutAlt.length} of ${images.length} <img> without alt`)

  // ── 6. form controls are labelled ────────────────────────────────────────
  const controls = [...body.matchAll(/<(input|select|textarea)\b([^>]*)>/giu)]
    .filter((match) => !/type\s*=\s*("|')?(hidden|submit|button|reset)\b/iu.test(match[2]))
  const unlabelled = controls.filter((match) => {
    if (CONTROL_ATTRS.test(match[2])) return false
    const id = /\bid\s*=\s*("|')([^"']+)\1/iu.exec(match[2])
    if (id === null) return !/<label[^>]*>[\s\S]{0,400}<\/label>/iu.test(body)
    return !new RegExp(`<label[^>]*\\bfor\\s*=\\s*("|')${escapeRegExp(id[2])}\\1`, 'iu').test(body)
  })
  record('form-labels', unlabelled.length === 0,
    controls.length === 0
      ? 'no form controls'
      : unlabelled.length === 0
        ? `${controls.length} control(s) labelled`
        : `${unlabelled.length} of ${controls.length} control(s) without a label`)

  return { pass: checks.every((check) => check.ok), checks }
}

/** Absolute http(s)// protocol-relative references: the contract forbids them. */
export function isExternal(target) {
  return /^(https?:)?\/\//iu.test(String(target ?? '').trim())
}

/** Strip HTML comments so commented-out markup cannot satisfy a check. */
function stripComments(html) {
  return String(html).replace(/<!--[\s\S]*?-->/gu, '')
}

/** Strip tags and inline scripts/styles to approximate visible copy. */
function stripTags(html) {
  return String(html)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&[a-z]+;/giu, ' ')
}

/** Every href/src/action attribute in a document, with its base directory. */
function collectReferences(html) {
  const out = []
  const pattern = /\b(href|src|action|poster)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/giu
  for (const match of String(html).matchAll(pattern)) {
    const target = (match[3] ?? match[4] ?? match[5] ?? '').trim()
    if (target.length === 0 || target.startsWith('#')) continue
    out.push({ base: '', target })
  }
  return out
}

/** `url(...)` and `@import` references inside a stylesheet. */
function collectCssReferences(source, baseDir) {
  const out = []
  for (const match of String(source).matchAll(/url\(\s*('|")?([^'")]+)('|")?\s*\)/giu)) {
    out.push({ base: baseDir, target: match[2].trim() })
  }
  for (const match of String(source).matchAll(/@import\s+('|")([^'"]+)\1/giu)) {
    out.push({ base: baseDir, target: match[2].trim() })
  }
  return out
}

/** POSIX-style parent directory of a lane-relative path. */
function dirnameOf(relative) {
  const index = relative.lastIndexOf('/')
  return index === -1 ? '' : relative.slice(0, index)
}

/** Join and normalise a lane-relative reference, or null when it escapes the lane. */
function normaliseRelative(base, target) {
  const cleaned = String(target).split(/[?#]/u)[0]
  if (cleaned.length === 0) return null
  const parts = `${base}/${cleaned}`.split('/')
  const stack = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (stack.length === 0) return null
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return stack.join('/')
}

/** Join two lane-relative POSIX paths. */
function joinPath(dir, relative) {
  return `${dir}/${relative}`.replace(/\/+/gu, '/')
}

/** Escape a string for use inside a regular expression. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
