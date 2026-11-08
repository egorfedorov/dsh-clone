/**
 * Ranking rules for a finished set of lanes.
 *
 * dsh-clone has no oracle: the reference screenshot is the ground truth, and
 * only a human can say which rebuild looks closer. What the engine CAN judge
 * objectively is completeness and speed, so it does exactly that and no more:
 *
 *   1. a lane that produced a servable page beats one that did not;
 *   2. among those, the one that finished first is the suggested winner;
 *   3. lanes that failed stay listed but never win automatically.
 *
 * The suggestion is only a default — the panel lets the reader take any lane.
 */

/** Whether a lane produced something the preview route can serve. */
export function laneDelivered(lane) {
  if (lane === null || lane === undefined) return false
  if (lane.status !== 'settled') return false
  return Array.isArray(lane.files) && lane.files.some((file) => file?.path === 'index.html')
}

/** Whether the lane carries a comparable similarity score. */
export function laneScored(lane) {
  return lane !== null && lane !== undefined && typeof lane.score === 'number' && Number.isFinite(lane.score)
}

/**
 * Order lanes from most to least adoptable.
 *
 * Delivered lanes lead. Among them, a rendered similarity score is the
 * strongest signal available, so it decides; lanes without a score fall back
 * to finish order. Nothing here is a correctness judgement.
 */
export function rankLanes(lanes) {
  const list = Array.isArray(lanes) ? lanes : []
  return [...list].sort((left, right) => {
    const delivered = Number(laneDelivered(right)) - Number(laneDelivered(left))
    if (delivered !== 0) return delivered
    if (laneScored(left) && laneScored(right) && left.score !== right.score) return right.score - left.score
    if (laneScored(left) !== laneScored(right)) return laneScored(left) ? -1 : 1
    const finished = (left.finishedAt ?? Number.POSITIVE_INFINITY) - (right.finishedAt ?? Number.POSITIVE_INFINITY)
    if (Number.isFinite(finished) && finished !== 0) return finished
    return left.index - right.index
  })
}

/** Suggested winner lane, or null when nothing usable landed. */
export function suggestedWinner(lanes) {
  const [first] = rankLanes(lanes).filter(laneDelivered)
  return first ?? null
}

/** Whether a lane stopped working, whatever the outcome was. */
export function laneTerminal(lane) {
  return lane !== null && lane !== undefined && ['settled', 'empty', 'failed', 'cancelled'].includes(lane.status)
}

/** One-line state for the composer chip. */
export function summarize(clone) {
  if (clone === null || clone === undefined) return null
  const lanes = Array.isArray(clone.lanes) ? clone.lanes : []
  const done = lanes.filter(laneTerminal).length
  return {
    id: clone.id,
    status: clone.status,
    done,
    total: lanes.length,
    delivered: lanes.filter(laneDelivered).length,
    winner: clone.winner ?? null,
    bestScore: lanes.reduce((best, lane) => (laneScored(lane) && (best === null || lane.score > best) ? lane.score : best), null),
  }
}
