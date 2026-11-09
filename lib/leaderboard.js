/**
 * The leaderboard: what actually works on this repository.
 *
 * Every finished clone records one row per lane — strategy, model, score, gate
 * result, and whether that lane won. After a few clones the plugin stops
 * handing out strategies blindly: `/clone` asks this module which ones have been
 * winning here and skips the ones that have been failing.
 *
 * That accumulation is the part a chat turn cannot do, and it is deliberately
 * local: the file lives next to the clones, in the workspace, and never leaves
 * the machine.
 */

/** Version of the on-disk board. Bump when the shape changes. */
export const BOARD_VERSION = 1

/** Runs a strategy needs before it may reorder the lanes on its own. */
export const MIN_RUNS_TO_RECOMMEND = 3

/** A fresh, empty board. */
export function emptyBoard() {
  return { version: BOARD_VERSION, runs: 0, strategies: {}, updatedAt: 0 }
}

/**
 * Record one lane's outcome.
 * @param board - the board to mutate.
 * @param entry - `{ strategy, model?, score, passed, won, at }`.
 * @returns the board, for chaining.
 */
export function recordRun(board, entry) {
  const strategy = String(entry.strategy ?? 'unknown')
  const current = board.strategies[strategy] ?? {
    runs: 0,
    wins: 0,
    passed: 0,
    scoreSum: 0,
    scored: 0,
    lastAt: 0,
  }
  current.runs += 1
  if (entry.won === true) current.wins += 1
  if (entry.passed === true) current.passed += 1
  if (typeof entry.score === 'number' && Number.isFinite(entry.score)) {
    current.scoreSum += entry.score
    current.scored += 1
  }
  current.lastAt = Number(entry.at) || Date.now()
  board.strategies[strategy] = current
  board.runs += 1
  board.updatedAt = current.lastAt
  if (entry.model !== undefined) {
    const model = String(entry.model)
    const models = board.models ?? {}
    const row = models[model] ?? { runs: 0, wins: 0, scoreSum: 0, scored: 0 }
    row.runs += 1
    if (entry.won === true) row.wins += 1
    if (typeof entry.score === 'number' && Number.isFinite(entry.score)) {
      row.scoreSum += entry.score
      row.scored += 1
    }
    models[model] = row
    board.models = models
  }
  return board
}

/**
 * One strategy's standing, comparable across strategies.
 *
 * A win rate alone rewards a strategy that ran once and got lucky, so the rate
 * is smoothed with a Laplace prior and mixed with the mean score — which is
 * available even for lanes that lost.
 * @param row - the stored counters.
 * @returns `{ runs, wins, winRate, meanScore, passRate, rank }` where rank is 0..1.
 */
export function standing(row) {
  const runs = Number(row?.runs) || 0
  const wins = Number(row?.wins) || 0
  const scored = Number(row?.scored) || 0
  const scoreSum = Number(row?.scoreSum) || 0
  const winRate = runs === 0 ? 0 : wins / runs
  const meanScore = scored === 0 ? 0 : scoreSum / scored
  const passRate = runs === 0 ? 0 : (Number(row?.passed) || 0) / runs
  const smoothedWin = (wins + 1) / (runs + 2)
  const rank = smoothedWin * 0.55 + (meanScore / 100) * 0.3 + passRate * 0.15
  return {
    runs,
    wins,
    winRate: Math.round(winRate * 1000) / 1000,
    meanScore: Math.round(meanScore * 10) / 10,
    passRate: Math.round(passRate * 1000) / 1000,
    rank: Math.round(rank * 10000) / 10000,
  }
}

/**
 * Order the available strategies for the next clone.
 *
 * Until a strategy has a few runs, the configured order wins — a leaderboard
 * built from one lucky run is worse than a sensible default.
 * @param board - the stored board.
 * @param args - `{ strategies, count }`: every strategy id, and how many to pick.
 * @returns `{ picked, reason }` where reason explains the choice to a human.
 */
export function recommendStrategies(board, { strategies, count }) {
  const ids = Array.isArray(strategies) ? strategies : []
  const total = Number(board?.runs) || 0
  if (total < MIN_RUNS_TO_RECOMMEND) {
    return {
      picked: ids.slice(0, count),
      reason: `default order — ${total} recorded run(s), ${MIN_RUNS_TO_RECOMMEND} needed to reorder`,
    }
  }
  const measured = ids.map((id) => ({
    id,
    ...standing(board.strategies?.[id]),
  }))
  const withRuns = measured.filter((row) => row.runs > 0).sort((left, right) => right.rank - left.rank)
  const withoutRuns = measured.filter((row) => row.runs === 0)
  const picked = [...withRuns, ...withoutRuns].slice(0, count).map((row) => row.id)
  const [best] = withRuns
  const reason = best === undefined
    ? 'default order — no strategy has a run yet'
    : `picked ${picked.join(', ')} — ${best.id} has won ${best.wins}/${best.runs} here (mean ${best.meanScore}%)`
  return { picked, reason }
}

/**
 * A compact, human-readable summary for the panel and the tool output.
 * @param board - the stored board.
 * @param limit - how many rows to include.
 * @returns `{ runs, rows }` sorted best first.
 */
export function summariseBoard(board, limit = 4) {
  const rows = Object.entries(board?.strategies ?? {})
    .map(([id, row]) => ({ id, ...standing(row) }))
    .sort((left, right) => right.rank - left.rank)
    .slice(0, limit)
  return { runs: Number(board?.runs) || 0, rows }
}
