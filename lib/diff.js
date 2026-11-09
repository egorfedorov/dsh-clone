/**
 * The evidence behind a score: a diff heatmap and a region breakdown.
 *
 * A percentage invites argument. A picture that shows *where* the rebuild drifts
 * — "the left panel is fine, the table is 40 units off" — ends the argument. This
 * module turns the same coarse comparison the score uses into an image worth
 * looking at, plus the twelve region names a person would say out loud.
 */

import { cropImage, normaliseRegion } from './score.js'
import { decodePng, encodePng } from './png.js'

/** Grid the heatmap, the region breakdown and the score all share. */
export const DIFF_GRID = { columns: 48, rows: 32 }

/** Cell size in the produced image (48x32 cells at 12px = 576x384). */
const CELL = 12

/** Region names, in reading order. */
const COLUMNS = ['left', 'centre-left', 'centre-right', 'right']
const ROWS = ['top', 'upper-middle', 'lower-middle', 'bottom']

/** Colour bands for one cell's mean absolute difference (0..255). */
const BANDS = [
  { limit: 6, colour: [46, 160, 96] },
  { limit: 16, colour: [140, 190, 80] },
  { limit: 32, colour: [235, 190, 70] },
  { limit: 64, colour: [235, 140, 60] },
  { limit: Number.POSITIVE_INFINITY, colour: [220, 70, 70] },
]

/**
 * Build a diff image and a region breakdown for one render against the reference.
 * @param args - raw PNG bytes of both images.
 * @returns `{ png, regions, worst, mean }` where png is the heatmap file.
 */
export function buildDiff({ referencePng, renderPng, region = null }) {
  const area = normaliseRegion(region)
  const reference = cropImage(decodePng(referencePng), area)
  const render = cropImage(decodePng(renderPng), area)
  const { columns, rows } = DIFF_GRID
  const differences = new Float64Array(columns * rows)

  // Mean absolute RGB difference per cell, sampled on a fixed stride so a huge
  // reference costs the same as a small one.
  const referenceCells = sampleGrid(reference, columns, rows)
  const renderCells = sampleGrid(render, columns, rows)
  for (let cell = 0; cell < differences.length; cell += 1) {
    const offset = cell * 3
    differences[cell] = (
      Math.abs(referenceCells[offset] - renderCells[offset])
      + Math.abs(referenceCells[offset + 1] - renderCells[offset + 1])
      + Math.abs(referenceCells[offset + 2] - renderCells[offset + 2])
    ) / 3
  }

  const width = columns * CELL
  const height = rows * CELL
  const pixels = new Uint8Array(width * height * 4)
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const difference = differences[row * columns + column]
      const colour = BANDS.find((band) => difference < band.limit).colour
      // The reference itself, dimmed, so the heat reads as "where on the page".
      const offset = (row * columns + column) * 3
      const backdrop = [0, 1, 2].map((channel) => referenceCells[offset + channel] * 0.55)
      // Agreement stays transparent (you see the page); disagreement saturates.
      const heat = Math.min(1, difference / 42) * 0.92
      for (let y = 0; y < CELL; y += 1) {
        for (let x = 0; x < CELL; x += 1) {
          const index = ((row * CELL + y) * width + column * CELL + x) * 4
          // A one-pixel dark grid line keeps the cells countable.
          const grid = x === 0 || y === 0
          const mix = grid ? 0.9 : heat
          for (let channel = 0; channel < 3; channel += 1) {
            const value = backdrop[channel] * (1 - mix) + colour[channel] * mix
            pixels[index + channel] = grid ? Math.round(value * 0.45) : Math.round(value)
          }
          pixels[index + 3] = 255
        }
      }
    }
  }

  const regions = summariseRegions(differences, columns, rows)
  const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length
  const worst = [...regions].sort((left, right) => right.difference - left.difference)[0]

  return {
    png: encodePng({ width, height, data: pixels }),
    regions,
    worst,
    mean: Math.round(mean * 10) / 10,
    region: area,
  }
}

/** Average each image into `columns * rows * 3` samples in 0..255. */
function sampleGrid(image, columns, rows) {
  const { width, height, data } = image
  const sums = new Float64Array(columns * rows * 3)
  const counts = new Float64Array(columns * rows)
  for (let y = 0; y < height; y += 1) {
    const row = Math.min(rows - 1, Math.floor((y * rows) / height))
    for (let x = 0; x < width; x += 1) {
      const cell = row * columns + Math.min(columns - 1, Math.floor((x * columns) / width))
      const index = (y * width + x) * 4
      const alpha = data[index + 3] / 255
      sums[cell * 3] += data[index] * alpha + 255 * (1 - alpha)
      sums[cell * 3 + 1] += data[index + 1] * alpha + 255 * (1 - alpha)
      sums[cell * 3 + 2] += data[index + 2] * alpha + 255 * (1 - alpha)
      counts[cell] += 1
    }
  }
  for (let cell = 0; cell < counts.length; cell += 1) {
    const count = counts[cell] || 1
    sums[cell * 3] /= count
    sums[cell * 3 + 1] /= count
    sums[cell * 3 + 2] /= count
  }
  return sums
}

/**
 * Group cells into named regions a person can act on.
 * @param differences - per-cell differences.
 * @returns twelve regions, worst first, each with a name and a 0..255 difference.
 */
export function summariseRegions(differences, columns = DIFF_GRID.columns, rows = DIFF_GRID.rows) {
  const bandColumns = 4
  const bandRows = 4
  const out = []
  for (let bandRow = 0; bandRow < bandRows; bandRow += 1) {
    for (let bandColumn = 0; bandColumn < bandColumns; bandColumn += 1) {
      const x0 = Math.floor((bandColumn * columns) / bandColumns)
      const x1 = Math.floor(((bandColumn + 1) * columns) / bandColumns)
      const y0 = Math.floor((bandRow * rows) / bandRows)
      const y1 = Math.floor(((bandRow + 1) * rows) / bandRows)
      let total = 0
      let cells = 0
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          total += differences[y * columns + x]
          cells += 1
        }
      }
      out.push({
        name: `${ROWS[bandRow]}-${COLUMNS[bandColumn]}`,
        difference: cells === 0 ? 0 : Math.round((total / cells) * 10) / 10,
      })
    }
  }
  return out.sort((left, right) => right.difference - left.difference)
}
