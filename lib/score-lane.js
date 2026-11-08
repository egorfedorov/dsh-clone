/**
 * The composition of "score one lane": find a browser, screenshot the page,
 * decode both PNGs, compare them.
 *
 * It lives here rather than in index.js so the Host half and the integration
 * test drive exactly the same code path — the test then asserts the real wiring
 * (engine → score → snapshot) instead of a copy of it.
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { detectRenderer, renderPage } from './render.js'
import { scoreRender } from './score.js'

/**
 * Build the `scoreLane` dependency for the engine.
 * @param run - command runner `(argv, cwd, options) => Promise<{code, stdout, stderr}>`.
 * @returns an async function `({laneDir, referencePath, outPath, viewport}) => {score, outPath} | null`.
 */
export function makeScoreLane(run) {
  return async function scoreLane({ laneDir, referencePath, outPath, viewport }) {
    const browser = await detectRenderer(run)
    if (browser === null) return null
    await mkdir(dirname(outPath), { recursive: true })
    const rendered = await renderPage({
      run,
      renderer: browser,
      filePath: join(laneDir, 'index.html'),
      outPath,
      viewport,
    })
    if (rendered === null) return null
    const [referencePng, renderPng] = await Promise.all([readFile(referencePath), readFile(rendered)])
    const { score } = scoreRender({ referencePng, renderPng })
    return { score, outPath: rendered }
  }
}
