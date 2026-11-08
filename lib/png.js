/**
 * A minimal, dependency-free PNG decoder.
 *
 * dsh-clone needs exactly one thing from a PNG: the pixels, so a rendered lane
 * can be compared with the reference screenshot. No encoder, no palette or
 * interlace support, no colour management — only the 8-bit non-interlaced
 * images a browser screenshot and an ordinary screenshot produce.
 *
 * Node's own zlib does the inflate; everything else here is the PNG spec.
 */

import { inflateSync } from 'node:zlib'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const MAX_PIXELS = 4096 * 4096

/** Channels per pixel for the colour types this decoder accepts. */
const CHANNELS = new Map([
  [0, 1], // greyscale
  [2, 3], // RGB
  [4, 2], // greyscale + alpha
  [6, 4], // RGBA
])

/**
 * Decode one PNG into straight RGBA8 pixels.
 * @param buffer - the complete PNG file bytes.
 * @returns `{ width, height, data }` where data is RGBA, one byte per channel.
 * @throws when the bytes are not a PNG this decoder supports.
 */
export function decodePng(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (bytes.length < 8) throw new Error('png: file is too short')
  for (let index = 0; index < 8; index += 1) {
    if (bytes[index] !== SIGNATURE[index]) throw new Error('png: bad signature')
  }

  let offset = 8
  let header = null
  const idat = []
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end > bytes.length) throw new Error('png: truncated chunk')
    if (type === 'IHDR') header = readHeader(bytes, start)
    else if (type === 'IDAT') idat.push(bytes.subarray(start, end))
    else if (type === 'IEND') break
    offset = end + 4 // skip the CRC
  }

  if (header === null) throw new Error('png: missing IHDR')
  if (header.interlaced) throw new Error('png: interlaced images are not supported')
  if (header.bitDepth !== 8) throw new Error(`png: unsupported bit depth ${header.bitDepth}`)
  const channels = CHANNELS.get(header.colourType)
  if (channels === undefined) throw new Error(`png: unsupported colour type ${header.colourType}`)
  if (header.width * header.height > MAX_PIXELS) throw new Error('png: image is too large')
  if (idat.length === 0) throw new Error('png: no image data')

  const raw = inflateSync(Buffer.concat(idat))
  const scanline = header.width * channels
  const expected = (scanline + 1) * header.height
  if (raw.length < expected) throw new Error('png: image data is short')

  const pixels = new Uint8Array(scanline * header.height)
  unfilter(raw, pixels, scanline, header.height, channels)
  return { width: header.width, height: header.height, data: expandToRgba(pixels, header.width, header.height, channels) }
}

/**
 * Read width and height from a PNG header without inflating the image.
 * @param buffer - PNG bytes, at least the first 24.
 * @returns `{ width, height }`, or null when the header is not readable.
 */
export function readPngSize(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (bytes.length < 24) return null
  for (let index = 0; index < 8; index += 1) {
    if (bytes[index] !== SIGNATURE[index]) return null
  }
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

/** Read the IHDR fields this decoder cares about. */
function readHeader(bytes, start) {
  const width = bytes.readUInt32BE(start)
  const height = bytes.readUInt32BE(start + 4)
  if (width <= 0 || height <= 0) throw new Error('png: empty image')
  return {
    width,
    height,
    bitDepth: bytes[start + 8],
    colourType: bytes[start + 9],
    interlaced: bytes[start + 12] !== 0,
  }
}

/** Undo the per-scanline filters in place (PNG spec section 9). */
function unfilter(raw, out, scanline, height, bpp) {
  let source = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source]
    source += 1
    const rowStart = y * scanline
    const previousStart = rowStart - scanline
    for (let x = 0; x < scanline; x += 1) {
      const value = raw[source + x]
      const left = x >= bpp ? out[rowStart + x - bpp] : 0
      const up = y > 0 ? out[previousStart + x] : 0
      const upLeft = y > 0 && x >= bpp ? out[previousStart + x - bpp] : 0
      let result
      switch (filter) {
        case 0: result = value; break
        case 1: result = value + left; break
        case 2: result = value + up; break
        case 3: result = value + ((left + up) >> 1); break
        case 4: result = value + paeth(left, up, upLeft); break
        default: throw new Error(`png: unknown filter ${filter}`)
      }
      out[rowStart + x] = result & 0xff
    }
    source += scanline
  }
}

/** The PNG Paeth predictor. */
function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft
  const distanceLeft = Math.abs(estimate - left)
  const distanceUp = Math.abs(estimate - up)
  const distanceUpLeft = Math.abs(estimate - upLeft)
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left
  return distanceUp <= distanceUpLeft ? up : upLeft
}

/** Normalize any accepted colour layout into straight RGBA8. */
function expandToRgba(pixels, width, height, channels) {
  const count = width * height
  const out = new Uint8Array(count * 4)
  for (let index = 0; index < count; index += 1) {
    const source = index * channels
    const target = index * 4
    switch (channels) {
      case 4:
        out[target] = pixels[source]
        out[target + 1] = pixels[source + 1]
        out[target + 2] = pixels[source + 2]
        out[target + 3] = pixels[source + 3]
        break
      case 3:
        out[target] = pixels[source]
        out[target + 1] = pixels[source + 1]
        out[target + 2] = pixels[source + 2]
        out[target + 3] = 255
        break
      case 2:
        out[target] = pixels[source]
        out[target + 1] = pixels[source]
        out[target + 2] = pixels[source]
        out[target + 3] = pixels[source + 1]
        break
      default:
        out[target] = pixels[source]
        out[target + 1] = pixels[source]
        out[target + 2] = pixels[source]
        out[target + 3] = 255
    }
  }
  return out
}
