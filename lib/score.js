/**
 * Reference-vs-render comparison.
 *
 * The claim dsh-clone makes is deliberately modest: how much of the picture
 * matches, not whether the page is *correct*. Three things make the number
 * useful instead of decorative:
 *
 *  1. **Coarse colour grid.** Both images are averaged into cells, so the score
 *     measures layout and palette agreement — what a person judges first.
 *  2. **Shift tolerance.** A rebuild that is a few pixels off is not a
 *     different design. The colour comparison searches small cell offsets and
 *     keeps the best agreement, so a 4px shift costs almost nothing while a
 *     panel on the wrong side still costs a lot.
 *  3. **Structure term.** Local contrast (edge energy) per cell is compared
 *     separately and mixed in, so a flat grey block that happens to average to
 *     the right colour cannot score as a faithful rebuild.
 *
 * The result is `100` for an identical image and falls off with picture
 * disagreement. It never claims correctness.
 */

import { decodePng } from './png.js'

/** Grid resolution: 48x32 keeps the comparison cheap and layout-oriented. */
export const GRID = { columns: 48, rows: 32 }

/** Largest cell shift the colour comparison forgives (in cells). */
export const MAX_SHIFT = 2

/** How the final score mixes the two measurements. */
export const WEIGHTS = { colour: 0.62, structure: 0.38 }

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
 * Per-cell luminance edge energy.
 *
 * A cell's value is the mean absolute luminance gradient inside it, scaled so a
 * strong edge is near 255. This is what distinguishes "the same average colour"
 * from "the same picture": a solid block and a striped block can average the
 * same grey but never the same edge energy.
 * @param image - decoded image.
 * @returns Float32Array of `columns * rows` values in 0..255.
 */
export function edgeGridOf(image, grid = GRID) {
  const { width, height, data } = image
  const columns = grid.columns
  const rows = grid.rows
  const sums = new Float64Array(columns * rows)
  const counts = new Float64Array(columns * rows)

  const luminance = (x, y) => {
    const index = (y * width + x) * 4
    const alpha = data[index + 3] / 255
    const red = data[index] * alpha + 255 * (1 - alpha)
    const green = data[index + 1] * alpha + 255 * (1 - alpha)
    const blue = data[index + 2] * alpha + 255 * (1 - alpha)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }

  for (let y = 0; y < height; y += 1) {
    const row = Math.min(rows - 1, Math.floor((y * rows) / height))
    for (let x = 0; x < width; x += 1) {
      const cell = row * columns + Math.min(columns - 1, Math.floor((x * columns) / width))
      const right = x + 1 < width ? luminance(x + 1, y) : luminance(x, y)
      const down = y + 1 < height ? luminance(x, y + 1) : luminance(x, y)
      sums[cell] += Math.abs(right - luminance(x, y)) + Math.abs(down - luminance(x, y))
      counts[cell] += 1
    }
  }

  const out = new Float32Array(columns * rows)
  for (let cell = 0; cell < counts.length; cell += 1) {
    if (counts[cell] === 0) continue
    // A 40-unit luminance step is already a hard edge; clamp so a few extreme
    // cells cannot dominate the mean.
    out[cell] = Math.min(255, (sums[cell] / counts[cell]) * 8)
  }
  return out
}

/**
 * Turn a list of per-cell absolute differences into a similarity.
 *
 * A plain mean hides local failure: a page that reproduces 90% of a screen and
 * leaves one panel blank still averages well. The mix below keeps the mean (how
 * much agrees) and adds the 90th percentile (how bad the worst regions are), so
 * a wrong panel costs real points while a 4px shift costs almost nothing.
 * @param differences - per-cell absolute differences in 0..255.
 * @returns 0..100 similarity.
 */
function similarityFrom(differences) {
  if (differences.length === 0) return 0
  const sorted = Float64Array.from(differences).sort()
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]
  const blended = mean * 0.62 + p90 * 0.38
  return Math.max(0, Math.min(100, 100 - (blended / 255) * 100))
}

/**
 * Soften an edge grid with a 3x3 box pass.
 *
 * Raw edge energy is unforgiving: a 2px text shift rewrites almost every edge
 * value. Blurring twice keeps the shape of "where the detail is" while dropping
 * the exact pixel alignment, which is the property a person judges.
 * @param grid - edge grid of `columns * rows`.
 * @returns a new, softened grid.
 */
export function blurEdgeGrid(grid, gridSize = GRID) {
  const columns = gridSize.columns
  const rows = gridSize.rows
  const out = new Float32Array(grid.length)
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      let sum = 0
      let count = 0
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const yy = y + dy
          const xx = x + dx
          if (yy < 0 || yy >= rows || xx < 0 || xx >= columns) continue
          sum += grid[yy * columns + xx]
          count += 1
        }
      }
      out[y * columns + x] = sum / count
    }
  }
  return out
}

/**
 * Structural agreement, measured against the reference's own edge energy.
 *
 * Absolute differences are the wrong scale here: edge values are small, so a
 * page that loses every detail would still look "close". Dividing by how much
 * edge energy the reference actually has makes a missing structure expensive and
 * a faithful one cheap.
 * @param reference - softened reference edge grid.
 * @param render - softened rendered edge grid.
 * @returns 0..100 similarity.
 */
function structureSimilarity(reference, render) {
  if (reference.length !== render.length) throw new Error('score: grid sizes differ')
  let difference = 0
  let energy = 0
  for (let index = 0; index < reference.length; index += 1) {
    difference += Math.abs(reference[index] - render[index])
    energy += reference[index]
  }
  // A reference with no edges at all is satisfied by anything without edges.
  if (energy < 1) return 100
  return Math.max(0, Math.min(100, 100 * (1 - difference / energy)))
}

/**
 * Colour similarity that forgives a small uniform shift.
 * @param reference - reference colour grid.
 * @param render - rendered colour grid.
 * @param grid - grid dimensions the two arrays were built with.
 * @param maxShift - largest cell offset to try in each axis.
 * @returns `{ similarity, shift }` with the best offset found.
 */
export function colourSimilarity(reference, render, grid = GRID, maxShift = MAX_SHIFT) {
  let best = { similarity: -1, shift: { x: 0, y: 0 } }
  for (let dy = -maxShift; dy <= maxShift; dy += 1) {
    for (let dx = -maxShift; dx <= maxShift; dx += 1) {
      // Shift the render against the reference and compare only the overlap.
      const x0 = Math.max(0, dx)
      const y0 = Math.max(0, dy)
      const x1 = Math.min(grid.columns, grid.columns + dx)
      const y1 = Math.min(grid.rows, grid.rows + dy)
      if (x1 - x0 < grid.columns - maxShift || y1 - y0 < grid.rows - maxShift) continue
      const differences = []
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const renderCell = (y * grid.columns + x) * 3
          const referenceCell = ((y - dy) * grid.columns + (x - dx)) * 3
          differences.push(
            (Math.abs(reference[referenceCell] - render[renderCell])
              + Math.abs(reference[referenceCell + 1] - render[renderCell + 1])
              + Math.abs(reference[referenceCell + 2] - render[renderCell + 2])) / 3,
          )
        }
      }
      if (differences.length === 0) continue
      const similarity = similarityFrom(differences)
      if (similarity > best.similarity) best = { similarity, shift: { x: dx, y: dy } }
    }
  }
  if (best.similarity < 0) {
    // Degenerate grid (smaller than the shift window): compare without shifting.
    return { similarity: similarityOf(reference, render), shift: { x: 0, y: 0 } }
  }
  return best
}

/**
 * Mix colour agreement and structural agreement into one number.
 * @param colour - 0..100 colour similarity.
 * @param structure - 0..100 structural similarity.
 * @returns 0..100, one decimal.
 */
export function combineScore(colour, structure) {
  const mixed = colour * WEIGHTS.colour + structure * WEIGHTS.structure
  return Math.round(Math.max(0, Math.min(100, mixed)) * 10) / 10
}

/**
 * Clamp a fractional region into a usable rectangle.
 *
 * A region is expressed in fractions of the image (0..1) so the same rectangle
 * describes the reference and the render whatever their pixel size, and so it
 * survives a viewport change.
 * @param region - `{ x, y, width, height }` fractions, or null for the whole image.
 * @returns a clamped region, or null when the input is unusable.
 */
export function normaliseRegion(region) {
  if (region === null || region === undefined || typeof region !== 'object') return null
  const clamp = (value) => Math.min(1, Math.max(0, Number(value)))
  const x = clamp(region.x)
  const y = clamp(region.y)
  const width = Math.min(1 - x, clamp(region.width))
  const height = Math.min(1 - y, clamp(region.height))
  if (!(width > 0.01) || !(height > 0.01)) return null
  return {
    x: Math.round(x * 10000) / 10000,
    y: Math.round(y * 10000) / 10000,
    width: Math.round(width * 10000) / 10000,
    height: Math.round(height * 10000) / 10000,
  }
}

/**
 * Crop a decoded image to a fractional region.
 * @param image - `{ width, height, data }`.
 * @param region - fractional region from {@link normaliseRegion}.
 * @returns a new image covering just that region.
 */
export function cropImage(image, region) {
  const area = normaliseRegion(region)
  if (area === null) return image
  const x0 = Math.min(image.width - 1, Math.floor(area.x * image.width))
  const y0 = Math.min(image.height - 1, Math.floor(area.y * image.height))
  const x1 = Math.max(x0 + 1, Math.min(image.width, Math.ceil((area.x + area.width) * image.width)))
  const y1 = Math.max(y0 + 1, Math.min(image.height, Math.ceil((area.y + area.height) * image.height)))
  const width = x1 - x0
  const height = y1 - y0
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const from = ((y0 + y) * image.width + x0) * 4
    data.set(image.data.subarray(from, from + width * 4), y * width * 4)
  }
  return { width, height, data }
}

/**
 * Score one rendered lane against the reference screenshot.
 * @param args - raw PNG bytes of both images, an optional grid, and an optional
 *   fractional region so only the part of the screen that matters is compared.
 * @returns `{ score, colour, structure, shift, region }` — score to one decimal.
 */
export function scoreRender({ referencePng, renderPng, grid = GRID, region = null }) {
  const area = normaliseRegion(region)
  const reference = cropImage(decodePng(referencePng), area)
  const render = cropImage(decodePng(renderPng), area)
  const colour = colourSimilarity(gridOf(reference, grid), gridOf(render, grid), grid)
  const softEdges = (image) => blurEdgeGrid(blurEdgeGrid(edgeGridOf(image, grid), grid), grid)
  const structure = structureSimilarity(softEdges(reference), softEdges(render))
  return {
    score: combineScore(colour.similarity, structure),
    colour: Math.round(colour.similarity * 10) / 10,
    structure: Math.round(structure * 10) / 10,
    shift: colour.shift,
    region: area,
  }
}

/**
 * One-line verdict for the panel and the tool output.
 *
 * Bands are calibrated against the measured runs in this repository: a faithful
 * rebuild of a dense screen lands at 95-99, a good-but-flawed one at 87-92, and
 * two unrelated dark interfaces at about 80.
 */
export function scoreLabel(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'not scored'
  if (score >= 95) return `${score}% match — near-identical`
  if (score >= 90) return `${score}% match — close`
  if (score >= 80) return `${score}% match — recognisable`
  if (score >= 60) return `${score}% match — same idea, different layout`
  return `${score}% match — a different page`
}
