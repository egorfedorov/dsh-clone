/**
 * `/clone` grammar. Only the shapes this command owns are parsed here; every
 * remaining word is the note handed to the building agents.
 *
 *   /clone                      3 lanes, no note
 *   /clone 4                    4 lanes, no note
 *   /clone 2 dark dashboard     2 lanes, note "dark dashboard"
 *   /clone status | pick 2 | refine 2 move the CTA up | cancel | discard | help
 */

import { clampLanes } from './util.js'

export const DEFAULT_LANES = 3
export const MAX_LANES = 4

const CONTROLS = new Set(['status', 'list', 'pick', 'cancel', 'stop', 'discard', 'drop', 'help', '?', 'refine'])

/** Parse one raw command input into a discriminated action. */
export function parseCloneArgs(raw, { defaultLanes = DEFAULT_LANES, maxLanes = MAX_LANES } = {}) {
  const input = String(raw ?? '').trim()
  if (input.length === 0) return { kind: 'start', lanes: clampLanes(defaultLanes, { max: maxLanes }), note: '' }

  const parts = input.split(/\s+/u)
  const head = parts[0].toLowerCase()

  if (head === 'help' || head === '?') return { kind: 'help' }
  if (head === 'status' || head === 'list') return { kind: 'status' }
  if (head === 'cancel' || head === 'stop') return { kind: 'cancel' }
  if (head === 'discard' || head === 'drop') return { kind: 'discard' }
  if (head === 'pick') {
    const lane = parts[1] === undefined ? null : Number(parts[1])
    return { kind: 'pick', lane: Number.isInteger(lane) && lane > 0 ? lane : null }
  }
  if (head === 'refine') {
    // `/clone refine`, `/clone refine 2`, `/clone refine 2 move the CTA up`
    const lane = /^\d{1,2}$/u.test(parts[1] ?? '') ? Number(parts[1]) : null
    const change = parts.slice(lane === null ? 1 : 2).join(' ').trim()
    return { kind: 'refine', lane: lane !== null && lane > 0 ? lane : null, note: change }
  }
  if (CONTROLS.has(head)) return { kind: 'help' }

  const countToken = /^\d{1,2}$/u.test(parts[0]) ? Number(parts[0]) : null
  const rest = countToken === null ? parts : parts.slice(1)
  return {
    kind: 'start',
    lanes: clampLanes(countToken ?? defaultLanes, { max: maxLanes }),
    note: rest.join(' ').trim(),
  }
}

/** Extract an explicit reference-image path from the note, when present. */
export function referenceHintOf(note) {
  const tokens = String(note ?? '').split(/\s+/u).filter((token) => token.length > 0)
  for (const token of tokens) {
    if (/\.(png|jpe?g|webp|gif)$/iu.test(token)) return token
  }
  return null
}
