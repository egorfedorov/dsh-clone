/**
 * Reference-vs-render comparison.
 *
 * The claim dsh-clone makes is deliberately modest: how much of the picture
 * matches, not whether the page is *correct*. The comparison therefore
 * downsamples both images to a coarse grid of average colours, composites any
 * transparency over the reference's own background, and reports the mean
 * absolute difference as a percentage.
 *
 * Why a coarse grid: a rebuild that is 3px off should not be punished like one
 * that put the panel on the wrong side. Comparing averages per cell measures
 * layout and palette agreement — exactly what a person judges first.
 */

import { decodePng } from './png.js'

/** Grid resolution: 48x32 keeps the comparison cheap and layout-oriented. */
export const GRID = { columns: 48, rows: 32 }

/**
 * Average each image into a coarse grid of RGB triples.
 * @param image - `{ width, height, data }` with straight RGBA pixels.
 * @returns Float32Array of `columns * rows * 3` values in 0..255.
 */
export function gridOf(image, grid = GRID) {
  const { width, height, data } = image
  const columns = grid.columns
  const rows = grid.rows
  const sums = new Float64Array(columns * rows * 3)
  const counts = new Float64Array(columns * rows)

  for (let y = 0; y < height; y += 1) {
    const row = Math.min(rows - 1, Math.floor((y * rows) / height))
    for (let x = 0; x < width; x += 1) {
      const cell = row * columns + Math.min(columns - 1, Math.floor((x * columns) / width))
      const index = (y * width + x) * 4
      const alpha = data[index + 3] / 255
      // Transparent pixels are composited over white, which is what a browser
      // screenshot of an unstyled page looks like.
      const red = data[index] * alpha + 255 * (1 - alpha)
      const green = data[index + 1] * alpha + 255 * (1 - alpha)
      const blue = data[index + 2] * alpha + 255 * (1 - alpha)
      sums[cell * 3] += red
      sums[cell * 3 + 1] += green
      sums[cell * 3 + 2] += blue
      counts[cell] += 1
    }
  }

  const out = new Float32Array(columns * rows * 3)
  for (let cell = 0; cell < counts.length; cell += 1) {
    const count = counts[cell]
    if (count === 0) continue
    out[cell * 3] = sums[cell * 3] / count
    out[cell * 3 + 1] = sums[cell * 3 + 1] / count
    out[cell * 3 + 2] = sums[cell * 3 + 2] / count
  }
  return out
}

/**
 * Compare two grid outlines on a 0..100 scale.
 * @param left - grid from {@link gridOf}.
 * @param right - grid from {@link gridOf}.
 * @returns similarity where 100 means every cell matches exactly.
 */
export function gridSimilarity(left, right) {
  if (left.length !== right.length) throw new Error('score: grid sizes differ')
  let total = 0
  for (let index = 0; index < left.length; index += 1) total += Math.abs(left[index] - right[index])
  const mean = total / left.length
  const similarity = 100 - (mean / 255) * 100
  return Math.max(0, Math.min(100, similarity))
}

/**
 * Score one rendered lane against the reference screenshot.
 * @param args - raw PNG bytes of both images, plus an optional grid.
 * @returns `{ score, grid }` — score rounded to one decimal.
 */
export function scoreRender({ referencePng, renderPng, grid = GRID }) {
  const reference = decodePng(referencePng)
  const render = decodePng(renderPng)
  const score = gridSimilarity(gridOf(reference, grid), gridOf(render, grid))
  return { score: Math.round(score * 10) / 10 }
}

/** One-line verdict for the panel and the tool output. */
export function scoreLabel(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'not scored'
  if (score >= 95) return `${score}% match — near-identical`
  if (score >= 85) return `${score}% match — close`
  if (score >= 70) return `${score}% match — recognisable`
  if (score >= 50) return `${score}% match — same idea, different layout`
  return `${score}% match — a different page`
}
