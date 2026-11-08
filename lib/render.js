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
import { rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/** Browsers that implement `--headless=new --screenshot`. */
const CANDIDATES = [
  process.env.DSH_CLONE_BROWSER,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
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
    const absolute = candidate.includes('/') ? existsSync(candidate) : true
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
  // so the file itself decides success — after a short, bounded wait.
  for (let wait = 0; wait < 3000; wait += 50) {
    if (existsSync(outPath)) return outPath
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

/** Test seam: forget the detected browser. */
export function resetRendererCache() {
  detectRenderer.cached = undefined
}
