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
export async function renderPage({ run, renderer, filePath, outPath, viewport, timeoutMs = 30_000 }) {
  if (renderer === null || renderer === undefined) return null
  const [width, height] = String(viewport ?? '1280x800')
    .split('x')
    .map((part) => Number.parseInt(part, 10))
  const size = `${Number.isFinite(width) ? width : 1280},${Number.isFinite(height) ? height : 800}`
  const result = await run([
    renderer.command,
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--virtual-time-budget=2500',
    `--window-size=${size}`,
    `--screenshot=${outPath}`,
    pathToFileURL(filePath).href,
  ], process.cwd(), { timeoutMs }).catch(() => null)
  if (result === null) return null
  // Chrome exits non-zero on some platforms even after writing the file, so the
  // file itself, not the exit code, decides success.
  return existsSync(outPath) ? outPath : null
}

/** Test seam: forget the detected browser. */
export function resetRendererCache() {
  detectRenderer.cached = undefined
}
