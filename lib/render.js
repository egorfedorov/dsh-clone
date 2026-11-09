/**
 * Rendering a lane's page to a PNG, using a browser the machine already has.
 *
 * dsh-clone does not bundle or download a browser. It looks for the Chromium
 * family that people already installed (Chrome, Chromium, Edge, Brave), drives
 * it in one-shot headless screenshot mode, and treats a missing browser as a
 * normal state: the panel then shows the live page and the reader picks.
 *
 * Detection is cached for the life of the plugin, and a failed render only
 * costs the score, never the lane.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

import { decodePng } from './png.js'
import { injectCheckHarness, parseCheckResult } from './checks.js'

/**
 * Browsers that implement `--headless=new --screenshot`, in the order they are
 * probed: an explicit override first, then the per-platform install locations,
 * then bare names resolved from PATH.
 */
const CANDIDATES = [
  process.env.DSH_CLONE_BROWSER,
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  // Windows (a large share of Harness users are on Windows)
  process.env.LOCALAPPDATA === undefined ? undefined : `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  process.env.LOCALAPPDATA === undefined ? undefined : `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  // PATH names, for anything installed elsewhere
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'msedge',
  'brave-browser',
].filter((candidate) => typeof candidate === 'string' && candidate.length > 0)

/**
 * Find one usable browser and remember it.
 * @param run - the command runner injected by the Host half.
 * @returns a cached handle, or null when nothing usable is installed.
 */
export async function detectRenderer(run) {
  if (detectRenderer.cached !== undefined) return detectRenderer.cached
  for (const candidate of CANDIDATES) {
    const isPath = candidate.includes('/') || candidate.includes('\\')
    const absolute = isPath ? existsSync(candidate) : true
    if (!absolute) continue
    const probe = await run([candidate, '--version'], process.cwd(), { timeoutMs: 8_000 }).catch(() => null)
    if (probe !== null && probe.code === 0) {
      detectRenderer.cached = { command: candidate, version: probe.stdout.trim().split('\n')[0] ?? '' }
      return detectRenderer.cached
    }
  }
  detectRenderer.cached = null
  return null
}

/**
 * Render one HTML file to a PNG at the reference viewport.
 * @param args - runner, browser handle, source file, output path, viewport.
 * @returns the output path on success, or null.
 */
export async function renderPage({ run, renderer, filePath, outPath, viewport, timeoutMs = 30_000, attempts = 2 }) {
  if (renderer === null || renderer === undefined) return null
  // Cold, concurrent Chrome launches are occasionally flaky: the process exits
  // without writing the screenshot. One quiet retry costs little and removes a
  // whole class of "lane randomly has no score" reports.
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const rendered = await renderOnce({ run, renderer, filePath, outPath, viewport, timeoutMs })
    if (rendered !== null) return rendered
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
  }
  return null
}

/** One screenshot attempt: exactly one browser process, one profile, one file. */
async function renderOnce({ run, renderer, filePath, outPath, viewport, timeoutMs }) {
  const [width, height] = String(viewport ?? '1280x800')
    .split('x')
    .map((part) => Number.parseInt(part, 10))
  const size = `${Number.isFinite(width) ? width : 1280},${Number.isFinite(height) ? height : 800}`
  // Lanes finish at unpredictable moments and can overlap. Without an explicit
  // per-render profile directory, concurrent Chrome launches contend for the
  // default one and one of them exits without writing a screenshot.
  const profileDir = `${outPath}.profile`
  let result
  try {
    result = await run([
      renderer.command,
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-dev-shm-usage',
      '--virtual-time-budget=2500',
      `--user-data-dir=${profileDir}`,
      `--window-size=${size}`,
      `--screenshot=${outPath}`,
      pathToFileURL(filePath).href,
    ], process.cwd(), { timeoutMs }).catch(() => null)
  } finally {
    await rm(profileDir, { recursive: true, force: true }).catch(() => {})
  }
  if (result === null) return null
  // Chrome exits non-zero on some platforms even after writing the file, and on
  // macOS it can announce "bytes written" slightly before the file is visible,
  // so the file itself decides success — after a short, bounded wait. The file
  // must also decode: a truncated screenshot would otherwise score as garbage.
  for (let wait = 0; wait < 3000; wait += 50) {
    if (existsSync(outPath)) {
      try {
        const decoded = decodePng(await readFile(outPath))
        if (decoded.width > 0 && decoded.height > 0) return outPath
      } catch {
        /* still being written, or a failed capture: keep waiting, then retry */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  await rm(outPath, { force: true }).catch(() => {})
  return null
}

/**
 * Run the page and read its own report back.
 *
 * The harness is injected into a *copy*, so the delivered page stays untouched,
 * and `--dump-dom` prints the DOM carrying the verdict — no socket, no session,
 * no second protocol to fail.
 * @param args - runner, browser, source file, a scratch directory for the copy,
 *   and the viewport to measure against.
 * @returns the parsed report, or null when the page never reported back.
 */
export async function inspectPage({ run, renderer, filePath, scratchDir, viewport, baseHref, timeoutMs = 30_000 }) {
  if (renderer === null || renderer === undefined) return null
  const [width, height] = String(viewport ?? '1280x800')
    .split('x')
    .map((part) => Number.parseInt(part, 10))
  const size = `${Number.isFinite(width) ? width : 1280},${Number.isFinite(height) ? height : 800}`
  const source = await readFile(filePath, 'utf8').catch(() => null)
  if (source === null) return null
  // The copy lives outside the lane so the deliverable is never touched, so its
  // relative references need a base to resolve against.
  const anchored = typeof baseHref === 'string' && baseHref.length > 0
    ? source.replace(/<head[^>]*>/iu, (match) => `${match}<base href="${baseHref}">`)
    : source
  await rm(scratchDir, { recursive: true, force: true }).catch(() => {})
  await rm(`${scratchDir}.profile`, { recursive: true, force: true }).catch(() => {})
  // The copy lives beside the lane so its relative assets still resolve; the
  // harness is added to the HTML only.
  const target = `${scratchDir}.html`
  await mkdir(dirname(target), { recursive: true }).catch(() => {})
  await writeFile(target, injectCheckHarness(anchored))
  const result = await run([
    renderer.command,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-dev-shm-usage',
    '--virtual-time-budget=4000',
    `--user-data-dir=${scratchDir}.profile`,
    `--window-size=${size}`,
    '--dump-dom',
    pathToFileURL(target).href,
  ], process.cwd(), { timeoutMs }).catch(() => null)
  await rm(`${scratchDir}.profile`, { recursive: true, force: true }).catch(() => {})
  await rm(target, { force: true }).catch(() => {})
  if (result === null) return null
  return parseCheckResult(result.stdout)
}

/** Test seam: forget the detected browser. */
export function resetRendererCache() {
  detectRenderer.cached = undefined
}
