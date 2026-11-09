/**
 * The clone engine: one reference screenshot, N isolated build lanes, one
 * adoptable result.
 *
 * The engine owns no Harness types and no Node imports beyond paths — every
 * side effect (filesystem, git, subagents, sessions) arrives as a dependency.
 * That keeps the whole state machine testable in plain Node and keeps the
 * Cordis wiring in index.js thin.
 *
 * Lifecycle of one clone:
 *
 *   start()            reference copied, lanes prepared, children launched
 *     prepareLane()    plain directory, or a git worktree inside the repo
 *     launchLane()     one subagent per lane, each in its own directory
 *     tick()           live counters (tools, tokens) for the panel
 *     onLaneSettled()  files collected, lane becomes adoptable
 *   finish()           status finished, suggested winner chosen
 *   pick(lane)         chosen lane copied into the workspace
 *   cancel()           running children interrupted, lanes marked cancelled
 */

import { basename, dirname, join, relative, sep } from 'node:path'
import { LANE_STRATEGIES, buildLanePrompt, buildRefinePrompt, strategyForLane } from './prompts.js'
import { suggestedWinner, summarize } from './rank.js'
import { emptyBoard, recommendStrategies, recordRun, summariseBoard } from './leaderboard.js'
import { dynamicChecks } from './checks.js'
import { normaliseRegion } from './score.js'
import { readPngSize } from './png.js'
import { reasonOf, totalTokens, truncate } from './util.js'

/** Names never copied out of a lane, and never walked for the file inventory. */
const IGNORED_NAMES = new Set(['node_modules', '.dsh-clone', '.DS_Store'])

/**
 * Whether a lane entry is scratch rather than deliverable output.
 * A builder may keep working files (crops of the reference, notes) in a dotted
 * directory; none of that belongs in the inventory or in the adopted copy.
 * @param name - one directory entry name.
 * @returns true when the entry must be skipped.
 */
export function isScratchEntry(name) {
  if (typeof name !== 'string' || name.length === 0) return true
  if (IGNORED_NAMES.has(name)) return true
  return name.startsWith('.')
}

/** Dependency directories reused from the workspace instead of reinstalled. */
const SHARED_DIRECTORIES = ['node_modules', '.venv', 'vendor']

/** Capacities that bound one clone's disk and event-loop cost. */
const LIMITS = {
  filesPerLane: 400,
  copiedBytes: 64 * 1024 * 1024,
}

/**
 * Version of the on-disk clone record. Bump when the shape changes so an older
 * file is ignored instead of half-understood.
 */
const STATE_VERSION = 1

export class CloneEngine {
  /**
   * @param deps - injected side effects (see the module doc).
   */
  constructor(deps) {
    this.deps = deps
    this.clones = new Map()
    this.order = []
    this.laneTimers = new Map()
    this.boards = new Map()
  }

  /** Path of one workspace's leaderboard file. */
  boardPath(workspace) {
    return join(workspace, '.dsh-clone', 'leaderboard.json')
  }

  /** Read (and cache) one workspace's leaderboard. */
  async loadBoard(workspace) {
    const cached = this.boards.get(workspace)
    if (cached !== undefined) return cached
    let board = emptyBoard()
    try {
      const parsed = JSON.parse(await this.deps.fs.readFile(this.boardPath(workspace), 'utf8'))
      if (parsed?.version === 1 && typeof parsed === 'object') board = parsed
    } catch {
      /* no board yet, or an unreadable one: start clean */
    }
    this.boards.set(workspace, board)
    return board
  }

  /** Persist one workspace's leaderboard; failures only cost the memory. */
  async saveBoard(workspace) {
    const board = this.boards.get(workspace)
    if (board === undefined) return
    try {
      await this.deps.fs.mkdir(join(workspace, '.dsh-clone'), { recursive: true })
      await this.deps.fs.writeFile(this.boardPath(workspace), JSON.stringify(board, null, 2))
    } catch (error) {
      this.deps.logger?.warn?.(`dsh-clone: could not save the leaderboard: ${reasonOf(error)}`)
    }
  }

  /**
   * Record every scored lane of a finished clone.
   *
   * One row per lane, never per clone: the interesting question is not "did this
   * clone work" but "which strategy wins here".
   * @param clone - a finished clone.
   */
  async recordClone(clone) {
    if (clone.recorded === true) return
    const board = await this.loadBoard(clone.workspace)
    for (const lane of clone.lanes) {
      if (typeof lane.score !== 'number') continue
      recordRun(board, {
        strategy: lane.strategy?.id ?? 'unknown',
        score: lane.score,
        passed: lane.gate?.pass === true,
        won: clone.winner === lane.index,
        at: clone.finishedAt ?? this.deps.now(),
      })
    }
    clone.recorded = true
    await this.saveBoard(clone.workspace)
  }

  /** Arm the wall-clock limit for one lane. */
  armLaneTimer(clone, lane) {
    const limit = Number(this.deps.config?.laneTimeoutMs)
    if (!Number.isFinite(limit) || limit <= 0) return
    const timer = setTimeout(() => {
      Promise.resolve(this.forceSettle(clone, lane)).catch((error) => {
        this.deps.logger?.warn?.(`dsh-clone: lane ${lane.index + 1} time-limit handling failed: ${reasonOf(error)}`)
      })
    }, limit)
    if (typeof timer?.unref === 'function') timer.unref()
    this.laneTimers.set(`${clone.id}:${lane.index}`, timer)
  }

  /** Disarm one lane's wall-clock limit. */
  clearLaneTimer(clone, lane) {
    const key = `${clone.id}:${lane.index}`
    const timer = this.laneTimers.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.laneTimers.delete(key)
    }
  }

  /**
   * Stop waiting for a lane that exceeded its wall-clock limit.
   *
   * A builder that keeps polishing past its budget is not a failure: if it
   * already wrote an `index.html`, that page is delivered and scored exactly as
   * on a normal finish. Only a lane with nothing usable becomes `empty`.
   * @param clone - owning clone.
   * @param lane - the lane to settle.
   */
  async forceSettle(clone, lane, reason = 'time-limit') {
    if (lane.status !== 'running') return
    this.clearLaneTimer(clone, lane)
    lane.timedOut = true
    lane.finishedAt = this.deps.now()
    lane.stopReason = reason
    try {
      this.deps.interruptAgent({ childId: lane.childId, parent: clone.parent })
    } catch (error) {
      lane.error = reasonOf(error)
    }
    lane.files = await this.inventory(lane.dir).catch(() => [])
    const delivered = lane.files.some((file) => file.path === 'index.html')
    if (!delivered) {
      lane.status = 'empty'
      lane.error = 'the lane hit its time limit before writing index.html'
    } else {
      lane.status = 'scoring'
      await this.scoreLane(clone, lane)
      lane.status = 'settled'
    }
    this.finishIfDone(clone)
  }

  /** Whether any clone still has work in flight (drives the poll timer). */
  hasRunning() {
    for (const clone of this.clones.values()) {
      if (clone.status === 'running') return true
    }
    return false
  }

  /** One clone by id. */
  get(cloneId) {
    return this.clones.get(cloneId)
  }

  /** Most recent clone for a session, or null. */
  latestForSession(sessionId) {
    for (const id of this.order) {
      const clone = this.clones.get(id)
      if (clone !== undefined && (sessionId === undefined || clone.sessionId === sessionId)) return clone
    }
    return null
  }

  /** Every clone belonging to one session, newest first. */
  listForSession(sessionId) {
    return this.order
      .map((id) => this.clones.get(id))
      .filter((clone) => clone !== undefined && (sessionId === undefined || clone.sessionId === sessionId))
  }

  /**
   * Persist one clone's state next to its work.
   *
   * The engine's memory dies with the plugin fiber, but a finished clone and its
   * files do not: writing a small record means a reload or a restart does not
   * throw away an expensive run. Failures are logged and ignored — persistence
   * is a convenience, never a precondition.
   * @param clone - the clone to record.
   */
  async saveState(clone) {
    const record = {
      version: STATE_VERSION,
      id: clone.id,
      sessionId: clone.sessionId,
      workspace: clone.workspace,
      note: clone.note,
      viewport: clone.viewport,
      region: clone.region ?? null,
      status: clone.status,
      createdAt: clone.createdAt,
      finishedAt: clone.finishedAt,
      reference: clone.reference,
      repo: clone.repo,
      winner: clone.winner,
      picked: clone.picked,
      region: clone.region ?? null,
      kind: clone.kind ?? 'clone',
      sourceId: clone.sourceId ?? null,
      sourceScore: typeof clone.sourceScore === 'number' ? clone.sourceScore : null,
      delta: typeof clone.delta === 'number' ? clone.delta : null,
      lanes: clone.lanes.map((lane) => ({
        index: lane.index,
        strategy: lane.strategy?.id ?? 'measure-first',
        status: lane.status,
        dir: lane.dir,
        branch: lane.branch ?? null,
        startedAt: lane.startedAt,
        finishedAt: lane.finishedAt,
        tools: lane.tools,
        tokens: lane.tokens,
        score: typeof lane.score === 'number' ? lane.score : null,
        renderPath: lane.renderPath ?? null,
        gate: lane.gate === undefined
          ? null
          : { pass: lane.gate.pass === true, checks: lane.gate.checks },
        diffPath: lane.diffPath ?? null,
        worstRegion: lane.worstRegion ?? null,
        diffMean: typeof lane.diffMean === 'number' ? lane.diffMean : null,
        runtime: lane.runtime ?? null,
        runtime: lane.runtime === undefined || lane.runtime === null
          ? null
          : {
            errors: lane.runtime.errors.length,
            overflowX: lane.runtime.overflowX,
            detail: [...lane.runtime.errors, ...lane.runtime.rejections, ...lane.runtime.consoleErrors].slice(0, 3),
          },
        files: lane.files,
        stopReason: lane.stopReason ?? null,
        timedOut: lane.timedOut === true,
        nudged: lane.nudged === true,
        error: lane.error ?? null,
        report: lane.report ?? null,
      })),
    }
    try {
      await this.deps.fs.writeFile(join(clone.root, 'state.json'), JSON.stringify(record, null, 2))
    } catch (error) {
      this.deps.logger?.warn?.(`dsh-clone: could not record clone ${clone.id}: ${reasonOf(error)}`)
    }
  }

  /**
   * Rebuild the in-memory clones for one workspace from their state files.
   *
   * Anything that was still running when the plugin went away cannot be resumed:
   * its child agent is gone. Such a lane keeps whatever it already wrote (so the
   * work is adoptable) and is marked interrupted, which is the honest description
   * of what happened.
   * @param workspace - absolute workspace directory to scan.
   * @returns the number of clones restored.
   */
  async restore(workspace) {
    const deps = this.deps
    let entries
    try {
      entries = await deps.fs.readdir(join(workspace, '.dsh-clone'), { withFileTypes: true })
    } catch {
      return 0
    }
    let restored = 0
    for (const entry of entries) {
      if (!entry.isDirectory() || this.clones.has(entry.name)) continue
      const root = join(workspace, '.dsh-clone', entry.name)
      let record
      try {
        record = JSON.parse(await deps.fs.readFile(join(root, 'state.json'), 'utf8'))
      } catch {
        continue
      }
      if (record?.version !== STATE_VERSION || typeof record.id !== 'string') continue
      if (record.workspace !== undefined && record.workspace !== workspace) continue

      const lanes = Array.isArray(record.lanes) ? record.lanes.map((lane) => {
        const files = Array.isArray(lane.files) ? lane.files : []
        const delivered = files.some((file) => file?.path === 'index.html')
        const unfinished = ['running', 'scoring', 'queued'].includes(lane.status)
        return {
          index: lane.index,
          strategy: LANE_STRATEGIES.find((candidate) => candidate.id === lane.strategy) ?? LANE_STRATEGIES[0],
          status: unfinished ? (delivered ? 'settled' : 'interrupted') : lane.status,
          dir: lane.dir,
          branch: lane.branch ?? undefined,
          childId: null,
          startedAt: lane.startedAt ?? null,
          finishedAt: lane.finishedAt ?? null,
          tools: lane.tools ?? 0,
          tokens: lane.tokens ?? { input: 0, output: 0, cacheRead: 0 },
          files,
          stopReason: unfinished ? 'interrupted' : lane.stopReason ?? null,
          error: unfinished ? 'the plugin restarted while this lane was building' : lane.error ?? null,
          report: lane.report ?? null,
          timedOut: unfinished ? true : lane.timedOut === true,
          score: typeof lane.score === 'number' ? lane.score : undefined,
          renderPath: lane.renderPath ?? undefined,
          gate: lane.gate !== null && lane.gate !== undefined && typeof lane.gate === 'object'
            ? { pass: lane.gate.pass === true, checks: Array.isArray(lane.gate.checks) ? lane.gate.checks : [] }
            : undefined,
          diffPath: lane.diffPath ?? undefined,
          worstRegion: lane.worstRegion ?? null,
          diffMean: typeof lane.diffMean === 'number' ? lane.diffMean : undefined,
          runtime: lane.runtime ?? null,
          previewUrl: `/api/dsh-clone/preview/${record.id}/${lane.index + 1}/`,
        }
      }) : []

      const terminal = lanes.every((lane) => ['settled', 'rejected', 'empty', 'failed', 'cancelled', 'interrupted'].includes(lane.status))
      const clone = {
        id: record.id,
        sessionId: record.sessionId,
        workspace,
        root,
        repo: record.repo ?? null,
        note: typeof record.note === 'string' ? record.note : '',
        viewport: typeof record.viewport === 'string' ? record.viewport : '1280x800',
        region: record.region ?? null,
        status: record.status === 'discarded' ? 'discarded' : terminal ? 'finished' : 'interrupted',
        starting: false,
        createdAt: record.createdAt ?? deps.now(),
        finishedAt: record.finishedAt ?? null,
        reference: record.reference ?? { path: '', mediaType: 'image/png', label: 'reference' },
        lanes,
        winner: record.winner ?? null,
        picked: record.picked ?? null,
        error: null,
        parent: undefined,
        kind: record.kind === 'refine' ? 'refine' : 'clone',
        sourceId: record.sourceId ?? null,
        sourceScore: typeof record.sourceScore === 'number' ? record.sourceScore : null,
        delta: typeof record.delta === 'number' ? record.delta : null,
        restored: true,
      }
      if (clone.winner === null && clone.status === 'finished') {
        const winner = suggestedWinner(lanes)
        clone.winner = winner === null ? null : winner.index
      }
      this.clones.set(clone.id, clone)
      this.order.push(clone.id)
      restored += 1
    }
    this.order.sort((left, right) => {
      const a = this.clones.get(left)?.createdAt ?? 0
      const b = this.clones.get(right)?.createdAt ?? 0
      return b - a
    })
    if (restored > 0) deps.logger?.warn?.(`dsh-clone: restored ${restored} clone(s) from this workspace`)
    return restored
  }

  /**
   * Stop everything this engine is driving.
   *
   * Called when the plugin unloads. Leaving child agents running would keep
   * spending tokens with nobody reading the result, and their clone would be
   * unreachable.
   */
  dispose() {
    for (const clone of this.clones.values()) {
      for (const lane of clone.lanes) {
        this.clearLaneTimer(clone, lane)
        if (lane.status !== 'running' && lane.status !== 'scoring') continue
        lane.status = lane.status === 'scoring' ? 'settled' : 'cancelled'
        lane.finishedAt = this.deps.now()
        lane.stopReason = 'plugin-unload'
        try {
          this.deps.interruptAgent({ childId: lane.childId, parent: clone.parent })
        } catch {
          /* the child may already be gone */
        }
      }
      if (clone.status === 'running') {
        clone.status = 'finished'
        clone.finishedAt = this.deps.now()
        clone.starting = false
      }
      Promise.resolve(this.saveState(clone)).catch(() => {})
    }
    this.laneTimers.clear()
  }

  /**
   * Start one clone.
   * @param args - calling agent, session id, lane count and the user's note.
   * @returns the live clone record.
   */
  async start({ agent, sessionId, lanes, note, viewport }) {
    const deps = this.deps
    const given = await deps.workingDirectory.ensure(agent)
    // Canonicalize the workspace before it becomes a path prefix: `git
    // rev-parse --show-toplevel` answers with resolved paths, so an
    // uncanonicalized session directory (a `/var` → `/private/var` symlink on
    // macOS, for instance) would produce two spellings of the same tree.
    const workspace = typeof deps.fs.realpath === 'function'
      ? await deps.fs.realpath(given).catch(() => given)
      : given
    const reference = await deps.resolveReference({ agent, note })
    if (reference === null || reference === undefined) {
      throw new Error('dsh-clone: no reference screenshot. Paste an image into the conversation, or pass a path: /clone 3 ./mock.png')
    }

    const repo = await this.inspectRepo(workspace)
    const id = deps.id().replace(/[^a-z0-9]/giu, '').slice(0, 8)
    const root = join(workspace, '.dsh-clone', id)
    await deps.fs.mkdir(root, { recursive: true })

    const referencePath = join(root, `reference${reference.extension ?? '.png'}`)
    await deps.fs.copyFile(reference.path, referencePath)

    const clone = {
      id,
      sessionId,
      workspace,
      root,
      repo,
      note: truncate(String(note ?? ''), 300),
      viewport: await this.resolveViewport(viewport, referencePath),
      region: null,
      status: 'running',
      starting: true,
      createdAt: deps.now(),
      finishedAt: null,
      reference: {
        path: referencePath,
        mediaType: reference.mediaType,
        label: reference.label ?? basename(reference.path),
      },
      lanes: [],
      winner: null,
      picked: null,
      error: null,
      parent: agent,
    }
    this.clones.set(id, clone)
    this.order.unshift(id)

    await this.prepareRoot(clone).catch((error) => {
      deps.logger?.warn?.(`dsh-clone: could not prepare the clone root: ${reasonOf(error)}`)
    })

    const board = await this.loadBoard(workspace)
    const recommendation = deps.config?.autoStrategies === false
      ? { picked: LANE_STRATEGIES.slice(0, lanes).map((entry) => entry.id), reason: 'autoStrategies is off — default order' }
      : recommendStrategies(board, { strategies: LANE_STRATEGIES.map((entry) => entry.id), count: lanes })
    clone.strategyReason = recommendation.reason

    for (let index = 0; index < lanes; index += 1) {
      const lane = {
        index,
        strategy: LANE_STRATEGIES.find((entry) => entry.id === recommendation.picked[index]) ?? strategyForLane(index),
        status: 'queued',
        dir: join(root, `lane-${index + 1}`),
        childId: null,
        startedAt: null,
        finishedAt: null,
        tools: 0,
        tokens: { input: 0, output: 0, cacheRead: 0 },
        files: [],
        stopReason: null,
        error: null,
        report: null,
        previewUrl: `/api/dsh-clone/preview/${id}/${index + 1}/`,
      }
      clone.lanes.push(lane)
      try {
        await this.prepareLane(clone, lane)
        await this.launchLane(clone, lane)
      } catch (error) {
        lane.status = 'failed'
        lane.error = reasonOf(error)
        lane.finishedAt = deps.now()
      }
    }

    // Lanes are launched one at a time, so a lane that fails immediately can
    // report its terminal state before the remaining lanes even exist. The
    // `starting` latch keeps `finishIfDone` from closing a clone that is still
    // being populated; the check below runs after the last lane is launched.
    clone.starting = false
    this.finishIfDone(clone)
    await this.saveState(clone)
    return clone
  }

  /**
   * Decide the render/viewport size for this clone.
   *
   * `auto` means "the reference's own pixel size": building and rendering at
   * exactly the reference's aspects is what makes the similarity score a fair
   * comparison instead of two differently-shaped pictures of the same page.
   * @param configured - the configured viewport, or `auto`.
   * @param referencePath - the copied reference image.
   * @returns e.g. `900x620`.
   */
  async resolveViewport(configured, referencePath) {
    if (typeof configured === 'string' && /^\d{2,5}x\d{2,5}$/u.test(configured)) return configured
    try {
      const size = readPngSize(await this.deps.fs.readFile(referencePath))
      if (size !== null) return `${size.width}x${size.height}`
    } catch {
      /* fall through to the default */
    }
    return '1280x800'
  }

  /** Resolve the repository facts for a workspace, if it is a repository. */
  async inspectRepo(workspace) {
    try {
      const top = await this.deps.git(['rev-parse', '--show-toplevel'], workspace)
      if (top.code !== 0) return null
      const root = top.stdout.trim()
      if (root.length === 0) return null
      const head = await this.deps.git(['rev-parse', 'HEAD'], root)
      if (head.code !== 0) return null
      const gitDir = await this.deps.git(['rev-parse', '--git-common-dir'], root)
      return {
        root,
        base: head.stdout.trim(),
        gitDir: gitDir.code === 0 ? gitDir.stdout.trim() : join(root, '.git'),
      }
    } catch {
      return null
    }
  }

  /** Hide the plugin's own scratch directory from the repository's status. */
  async prepareRoot(clone) {
    const { repo, workspace } = clone
    if (repo === null) return
    const exclude = join(repo.gitDir.startsWith('/') ? repo.gitDir : join(repo.root, repo.gitDir), 'info', 'exclude')
    try {
      await this.deps.fs.mkdir(join(exclude, '..'), { recursive: true })
      const current = await this.deps.fs.readFile(exclude, 'utf8').catch(() => '')
      const line = `${workspace === repo.root ? '' : '/'}${'.dsh-clone'}/`
      if (!current.includes('.dsh-clone')) {
        await this.deps.fs.writeFile(exclude, `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}${line}\n`)
      }
    } catch {
      /* The exclude file is a convenience; a failure must not stop the race. */
    }
  }

  /** Create one lane's directory: a git worktree in a repo, a plain dir otherwise. */
  async prepareLane(clone, lane) {
    const deps = this.deps
    await deps.fs.mkdir(lane.dir, { recursive: true })
    if (clone.repo !== null) {
      const branch = `dsh-clone/${clone.id}-lane-${lane.index + 1}`
      const added = await deps.git(['worktree', 'add', '-b', branch, lane.dir, clone.repo.base], clone.repo.root)
      if (added.code !== 0) {
        lane.error = reasonOf(added.stderr || added.stdout)
        throw new Error(`could not create worktree: ${lane.error}`)
      }
      lane.branch = branch
    }
    await this.linkSharedDependencies(clone, lane)
  }

  /** Reuse the workspace's dependency directories instead of reinstalling them. */
  async linkSharedDependencies(clone, lane) {
    const source = clone.repo?.root ?? clone.workspace
    if (source === lane.dir) return
    for (const name of SHARED_DIRECTORIES) {
      const from = join(source, name)
      const to = join(lane.dir, name)
      const hasSource = await this.deps.fs.stat(from).then(() => true, () => false)
      if (!hasSource) continue
      const hasTarget = await this.deps.fs.stat(to).then(() => true, () => false)
      if (hasTarget) continue
      await this.deps.fs.symlink(from, to, 'dir').catch(() => {})
    }
  }

  /** Launch one lane's builder agent. */
  async launchLane(clone, lane) {
    const deps = this.deps
    const prompt = buildLanePrompt({
      laneIndex: lane.index,
      laneCount: clone.lanes.length,
      strategy: lane.strategy,
      referencePath: clone.reference.path,
      referenceLabel: clone.reference.label,
      viewport: clone.viewport,
      note: clone.note,
    })
    const handle = await deps.spawnAgent({
      cwd: lane.dir,
      prompt,
      label: `clone lane ${lane.index + 1}`,
      parent: clone.parent,
    })
    lane.childId = handle.childId ?? null
    lane.status = 'running'
    lane.startedAt = deps.now()
    this.armLaneTimer(clone, lane)
    Promise.resolve(handle.result).then(
      (result) => this.onLaneSettled(clone, lane, result, handle),
      (error) => this.onLaneFailed(clone, lane, error, handle),
    )
  }

  /** A lane's builder finished: inventory its output and make it adoptable. */
  async onLaneSettled(clone, lane, result, handle) {
    const deps = this.deps
    this.clearLaneTimer(clone, lane)
    if (lane.status !== 'running') {
      Promise.resolve(handle?.dispose?.()).catch(() => {})
      return
    }
    try {
      lane.finishedAt = deps.now()
      lane.stopReason = result?.stopReason ?? 'completed'
      lane.report = extractReport(result)
      lane.files = await this.inventory(lane.dir)
      const delivered = lane.files.some((file) => file.path === 'index.html')
      if (!delivered) {
        lane.status = 'empty'
        lane.error = 'the lane produced no index.html'
      } else {
        // `scoring` is deliberately not a terminal state: a clone that closed
        // while a render was still running would hand the panel a missing
        // score, and the panel stops polling once the clone is finished.
        lane.status = 'scoring'
        lane.gate = await this.acceptLane(clone, lane)
        await this.scoreLane(clone, lane)
        await this.inspectLane(clone, lane)
        lane.gate = this.applyDynamic(clone, lane, lane.gate)
        await this.diffLane(clone, lane)
        lane.status = lane.gate.pass ? 'settled' : 'rejected'
        if (!lane.gate.pass) {
          lane.error = `acceptance gate: ${lane.gate.checks.filter((check) => !check.ok).map((check) => check.id).join(', ')}`
        }
      }
    } catch (error) {
      lane.status = 'failed'
      lane.error = reasonOf(error)
    } finally {
      Promise.resolve(handle?.dispose?.()).catch(() => {})
      await this.saveState(clone).catch(() => {})
      this.finishIfDone(clone)
    }
  }

  /**
   * Render a delivered lane and score it against the reference.
   *
   * Optional at every step: no browser, a render that never lands, or bytes the
   * decoder refuses all leave the lane unscored instead of failing the clone.
   * @param clone - owning clone.
   * @param lane - the lane that just delivered.
   */
  async scoreLane(clone, lane) {
    const deps = this.deps
    if (typeof deps.scoreLane !== 'function') return
    try {
      const scored = await deps.scoreLane({
        laneDir: lane.dir,
        referencePath: clone.reference.path,
        outPath: join(clone.root, 'renders', `lane-${lane.index + 1}.png`),
        viewport: clone.viewport,
        region: clone.region ?? null,
      })
      if (scored === null || scored === undefined) return
      lane.renderPath = scored.outPath
      lane.score = scored.score
    } catch (error) {
      deps.logger?.warn?.(`dsh-clone: lane ${lane.index + 1} was not scored: ${reasonOf(error)}`)
    }
  }

  /**
   * Run the static acceptance checklist over a delivered lane.
   * @returns `{ pass, checks }`; a missing dependency service means a pass with
   *   an explicit "not checked" row rather than a silent success.
   */
  async acceptLane(clone, lane) {
    if (typeof this.deps.acceptLane !== 'function') {
      return { pass: true, checks: [{ id: 'gate', ok: true, detail: 'no acceptance checker mounted' }] }
    }
    try {
      const result = await this.deps.acceptLane({ dir: lane.dir, files: lane.files })
      if (result === null || result === undefined) {
        return { pass: true, checks: [{ id: 'gate', ok: true, detail: 'acceptance unavailable' }] }
      }
      return result
    } catch (error) {
      return { pass: true, checks: [{ id: 'gate', ok: true, detail: `acceptance failed to run: ${reasonOf(error)}` }] }
    }
  }

  /**
   * Run the delivered page and record what happened.
   *
   * Optional at every step: no browser, no report, or a disabled config all leave
   * the lane without a runtime verdict rather than failing it.
   */
  async inspectLane(clone, lane) {
    if (this.deps.config?.dynamicChecks === false) return
    if (typeof this.deps.inspectLane !== 'function') return
    try {
      const result = await this.deps.inspectLane({
        dir: lane.dir,
        viewport: clone.viewport,
        cloneId: clone.id,
        laneIndex: lane.index,
        scratch: join(clone.root, 'inspect', `lane-${lane.index + 1}`),
      })
      if (result === null || result === undefined) return
      lane.runtime = result
    } catch (error) {
      this.deps.logger?.warn?.(`dsh-clone: lane ${lane.index + 1} was not inspected: ${reasonOf(error)}`)
    }
  }

  /**
   * Fold the runtime verdict into the gate.
   *
   * Uncaught errors and horizontal overflow mean the page does not work, whatever
   * it looks like, so by default they reject the lane. `strictDynamic: false`
   * demotes them to recorded warnings for people who want the page anyway.
   */
  applyDynamic(clone, lane, gate) {
    const checks = dynamicChecks(lane.runtime ?? null)
    const merged = { pass: gate.pass, checks: [...gate.checks, ...checks] }
    const dynamicFailed = checks.some((check) => !check.ok)
    const strict = this.deps.config?.strictDynamic !== false
    merged.pass = merged.pass && (!dynamicFailed || !strict)
    lane.dynamicWarning = dynamicFailed && !strict
    return merged
  }

  /**
   * Score only part of the screen.
   *
   * Re-scoring uses the renders the clone already has, so changing the region is
   * instant and never rebuilds anything: the same attempt is simply judged on the
   * rectangle that matters.
   * @param args - clone id and a fractional `{ x, y, width, height }`, or null to
   *   score the whole page again.
   * @returns the updated clone.
   */
  async setRegion({ cloneId, region }) {
    const deps = this.deps
    const clone = this.clones.get(cloneId)
    if (clone === undefined) throw new Error(`dsh-clone: unknown clone "${cloneId}"`)
    const area = region === null || region === undefined ? null : normaliseRegion(region)
    if (region !== null && region !== undefined && area === null) {
      throw new Error('dsh-clone: the region must be a non-empty rectangle of fractions between 0 and 1')
    }
    clone.region = area
    for (const lane of clone.lanes) {
      if (typeof lane.renderPath !== 'string') continue
      if (typeof deps.rescoreLane !== 'function') break
      const scored = await deps.rescoreLane({
        referencePath: clone.reference.path,
        renderPath: lane.renderPath,
        region: area,
      }).catch(() => null)
      if (scored !== null && scored !== undefined) lane.score = scored.score
      await this.diffLane(clone, lane)
    }
    if (clone.status === 'finished') {
      const winner = suggestedWinner(clone.lanes)
      clone.winner = winner === null ? null : winner.index
    }
    await this.saveState(clone).catch(() => {})
    return clone
  }

  /**
   * Build the diff heatmap for a lane that produced a render.
   * Never fatal: the score stands on its own if the image cannot be written.
   */
  async diffLane(clone, lane) {
    if (typeof this.deps.buildDiff !== 'function') return
    if (typeof lane.renderPath !== 'string') return
    try {
      const diff = await this.deps.buildDiff({
        referencePath: clone.reference.path,
        renderPath: lane.renderPath,
        outPath: join(clone.root, 'diffs', `lane-${lane.index + 1}.png`),
        region: clone.region ?? null,
      })
      if (diff === null || diff === undefined) return
      lane.diffPath = diff.outPath
      lane.regions = diff.regions
      lane.worstRegion = diff.worst
      lane.diffMean = diff.mean
    } catch (error) {
      this.deps.logger?.warn?.(`dsh-clone: lane ${lane.index + 1} has no diff image: ${reasonOf(error)}`)
    }
  }

  /** A lane's builder failed or was interrupted. */
  onLaneFailed(clone, lane, error, handle) {
    this.clearLaneTimer(clone, lane)
    if (lane.status !== 'running') {
      Promise.resolve(handle?.dispose?.()).catch(() => {})
      return
    }
    lane.status = lane.status === 'cancelled' ? 'cancelled' : 'failed'
    lane.error = reasonOf(error)
    lane.finishedAt = this.deps.now()
    Promise.resolve(handle?.dispose?.()).catch(() => {})
    Promise.resolve(this.saveState(clone)).catch(() => {})
    this.finishIfDone(clone)
  }

  /** Refresh live counters for every running lane. */
  tick() {
    const deps = this.deps
    for (const clone of this.clones.values()) {
      if (clone.status !== 'running') continue
      for (const lane of clone.lanes) {
        if (lane.status !== 'running' || lane.childId === null) continue
        try {
          const agent = deps.getAgent(lane.childId)
          if (agent === undefined || agent === null) continue
          const events = agent.session.snapshotEvents()
          let tools = 0
          const tokens = { input: 0, output: 0, cacheRead: 0 }
          for (const event of events) {
            if (event.type === 'tool/call') tools += 1
            const usage = event.type === 'assistant/message' ? event.data.usage : undefined
            if (usage === undefined) continue
            tokens.input += Number(usage.inputTokens) || 0
            tokens.output += Number(usage.outputTokens) || 0
            tokens.cacheRead += Number(usage.cacheReadTokens) || 0
          }
          lane.tools = tools
          lane.tokens = tokens
          this.maybeNudge(clone, lane)
          const budget = Number(deps.config?.laneTokenBudget)
          if (Number.isFinite(budget) && budget > 0 && totalTokens(tokens) > budget) {
            lane.stopReason = 'token-budget'
            Promise.resolve(this.forceSettle(clone, lane, 'token-budget')).catch(() => {})
          }
        } catch {
          /* A lane whose session is mid-teardown simply keeps its last numbers. */
        }
      }
    }
  }

  /**
   * Push a lane that is still analysing towards writing the page.
   *
   * Some models answer "measure first" by sampling pixels for the entire budget
   * and then ending with nothing delivered. One steering message at a known tool
   * count is cheap, and turns a wasted run into a delivered page.
   * @param clone - owning clone.
   * @param lane - a running lane.
   */
  maybeNudge(clone, lane) {
    const deps = this.deps
    if (typeof deps.nudgeLane !== 'function') return
    const at = Number(deps.config?.nudgeAtTools)
    const threshold = Number.isFinite(at) && at > 0 ? at : 12
    if (lane.nudged === true || lane.nudgeChecked === true || lane.tools < threshold) return
    lane.nudgeChecked = true
    // The lane's file list is only filled when it settles, so ask the disk. A
    // lane that already wrote its page is polishing, not stalling — leave it be.
    Promise.resolve((async () => {
      const delivered = await deps.fs.stat(join(lane.dir, 'index.html')).then(() => true, () => false)
      if (delivered || lane.status !== 'running') return
      lane.nudged = true
      await deps.nudgeLane({
        childId: lane.childId,
        parent: clone.parent,
        text: [
          `Stop analysing and write the page now. You have made ${lane.tools} tool calls and index.html does not exist yet.`,
          'Approximate colours and spacing by eye from the reference; do not run any more image-measurement scripts.',
          'Write a complete index.html in your next tool call, then refine it if you still have budget.',
        ].join(' '),
      })
    })()).catch((error) => {
      deps.logger?.warn?.(`dsh-clone: could not nudge lane ${lane.index + 1}: ${reasonOf(error)}`)
    })
  }

  /** Close a clone once every lane reached a terminal state. */
  finishIfDone(clone) {
    if (clone.status !== 'running') return
    if (clone.starting === true) return
    const terminal = clone.lanes.every((lane) => ['settled', 'rejected', 'empty', 'failed', 'cancelled'].includes(lane.status))
    if (terminal) this.finish(clone)
  }

  /** Mark a clone finished and compute the suggested winner. */
  finish(clone) {
    clone.status = 'finished'
    clone.finishedAt = this.deps.now()
    const winner = suggestedWinner(clone.lanes)
    clone.winner = winner === null ? null : winner.index
    Promise.resolve(this.recordClone(clone)).catch(() => {})
    if (clone.kind === 'refine' && typeof clone.sourceScore === 'number') {
      const lane = winner ?? clone.lanes[0]
      clone.delta = typeof lane?.score === 'number'
        ? Math.round((lane.score - clone.sourceScore) * 10) / 10
        : null
    }
    Promise.resolve(this.saveState(clone)).catch(() => {})
  }

  /** Walk a lane directory into the flat inventory the panel renders. */
  async inventory(dir, relative = '', out = []) {
    if (out.length >= LIMITS.filesPerLane) return out
    let entries
    try {
      entries = await this.deps.fs.readdir(dir, { withFileTypes: true })
    } catch {
      return out
    }
    const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of sorted) {
      if (out.length >= LIMITS.filesPerLane) break
      if (isScratchEntry(entry.name)) continue
      const rel = relative.length === 0 ? entry.name : `${relative}/${entry.name}`
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        await this.inventory(absolute, rel, out)
        continue
      }
      const stats = await this.deps.fs.stat(absolute).catch(() => null)
      out.push({ path: rel, bytes: stats === null ? 0 : stats.size })
    }
    return out
  }

  /**
   * Refine an adopted lane instead of starting over.
   *
   * The previous page is copied into a fresh single-lane clone and a builder is
   * asked for the smallest edit that satisfies the change. Because the reference
   * and the viewport are unchanged, the result is directly comparable: the clone
   * carries the source lane's score so the panel can show the delta.
   * @param args - source clone, lane number (defaults to its winner), the change
   *   requested, and the calling agent.
   * @returns the new clone.
   */
  async refine({ cloneId, laneNumber, agent, change, viewport }) {
    const deps = this.deps
    const source = this.clones.get(cloneId)
    if (source === undefined) throw new Error(`dsh-clone: unknown clone "${cloneId}"`)
    const sourceLane = laneNumber === null || laneNumber === undefined
      ? source.lanes.find((candidate) => candidate.index === source.winner) ?? source.lanes[0]
      : source.lanes[laneNumber - 1]
    if (sourceLane === undefined || sourceLane === null || !sourceLane.files.some((file) => file.path === 'index.html')) {
      throw new Error('dsh-clone: that lane has no page to refine')
    }

    const workspace = source.workspace ?? await deps.workingDirectory.ensure(agent)
    const id = deps.id().replace(/[^a-z0-9]/giu, '').slice(0, 8)
    const root = join(workspace, '.dsh-clone', id)
    await deps.fs.mkdir(root, { recursive: true })
    const referencePath = join(root, `reference${source.reference.path.endsWith('.png') ? '.png' : ''}`)
    await deps.fs.copyFile(source.reference.path, referencePath)

    const targetViewport = viewport ?? source.viewport
    const clone = {
      id,
      sessionId: source.sessionId,
      workspace,
      root,
      repo: source.repo,
      note: truncate(String(change ?? ''), 300),
      viewport: targetViewport,
      status: 'running',
      starting: true,
      createdAt: deps.now(),
      finishedAt: null,
      reference: { path: referencePath, mediaType: source.reference.mediaType, label: source.reference.label },
      lanes: [],
      winner: null,
      picked: null,
      error: null,
      parent: agent,
      kind: 'refine',
      sourceId: source.id,
      sourceScore: typeof sourceLane.score === 'number' ? sourceLane.score : null,
    }
    this.clones.set(id, clone)
    this.order.unshift(id)

    const lane = {
      index: 0,
      strategy: strategyForLane(0),
      status: 'queued',
      dir: join(root, 'lane-1'),
      childId: null,
      startedAt: null,
      finishedAt: null,
      tools: 0,
      tokens: { input: 0, output: 0, cacheRead: 0 },
      files: [],
      stopReason: null,
      error: null,
      report: null,
      previewUrl: `/api/dsh-clone/preview/${id}/1/`,
    }
    clone.lanes.push(lane)
    clone.starting = false

    try {
      await deps.fs.mkdir(lane.dir, { recursive: true })
      await deps.fs.cp(sourceLane.dir, lane.dir, {
        recursive: true,
        force: true,
        filter: (path) => !isScratchEntry(basename(path)),
      })
      const prompt = buildRefinePrompt({
        referencePath,
        change: String(change ?? ''),
        viewport: targetViewport,
      })
      const handle = await deps.spawnAgent({
        cwd: lane.dir,
        prompt,
        label: 'clone refine',
        parent: agent,
      })
      lane.childId = handle.childId ?? null
      lane.status = 'running'
      lane.startedAt = deps.now()
      this.armLaneTimer(clone, lane)
      Promise.resolve(handle.result).then(
        (result) => this.onLaneSettled(clone, lane, result, handle),
        (error) => this.onLaneFailed(clone, lane, error, handle),
      )
    } catch (error) {
      lane.status = 'failed'
      lane.error = reasonOf(error)
      lane.finishedAt = deps.now()
      this.finishIfDone(clone)
    }

    await this.saveState(clone).catch(() => {})
    return clone
  }

  /**
   * One file's unified diff, produced by git itself.
   *
   * Hand-written hunk arithmetic drifted and produced patches `git apply`
   * rejected, so the diff comes from `git diff --no-index`; only the `---`/`+++`
   * headers are rewritten to the lane-relative path the target expects.
   * @param args - owning clone, the absolute target path root, and the file.
   * @returns the patch text for that file (empty when the files are identical).
   */
  async diffFiles({ clone, lane, target, path, patchPath }) {
    const deps = this.deps
    const scratch = join(clone.root, 'patch', 'tmp', path.replace(/[^a-z0-9._-]/giu, '_'))
    await deps.fs.mkdir(dirname(scratch), { recursive: true })
    const before = await deps.fs.readFile(join(target, path), 'utf8').catch(() => null)
    const incoming = await deps.fs.readFile(join(lane.dir, path), 'utf8').catch(() => null)
    if (before === null || incoming === null) return ''
    await deps.fs.writeFile(`${scratch}.before`, before)
    await deps.fs.writeFile(`${scratch}.after`, incoming)
    const result = await deps.git([
      'diff', '--no-index', '--unified=3', '--no-color',
      `${scratch}.before`, `${scratch}.after`,
    ], clone.workspace)
    // `git diff --no-index` exits 1 when the files differ: the output is the signal.
    if (typeof result.stdout !== 'string' || result.stdout.length === 0) return ''
    const header = patchPath ?? path
    const lines = result.stdout.split('\n')
    const rewritten = lines.map((line) => {
      if (line.startsWith('diff --git')) return `diff --git a/${header} b/${header}`
      if (line.startsWith('--- ')) return `--- a/${header}`
      if (line.startsWith('+++ ')) return `+++ b/${header}`
      return line
    })
    return rewritten.join('\n')
  }

  /**
   * Adopt a lane as a patch instead of a folder.
   *
   * The folder answer ("here is a new static page") is right for a prototype and
   * wrong for a component library, where the change belongs inside files that
   * already exist. This writes the lane's files into the target directory *when
   * they are missing*, produces a unified diff for every file that already
   * exists, and stages the result when the workspace is a git repository.
   * @param args - clone id, lane number, and the target directory.
   * @returns `{ patchPath, target, applied, conflicts }`.
   */
  async adoptAsPatch({ cloneId, laneNumber, into }) {
    const deps = this.deps
    const clone = this.clones.get(cloneId)
    if (clone === undefined) throw new Error(`dsh-clone: unknown clone "${cloneId}"`)
    const lane = laneNumber === null || laneNumber === undefined
      ? clone.lanes.find((candidate) => candidate.index === clone.winner)
      : clone.lanes[laneNumber - 1]
    if (lane === undefined || lane === null) throw new Error('dsh-clone: that lane does not exist')
    if (!['settled'].includes(lane.status)) {
      throw new Error(`dsh-clone: lane ${lane.index + 1} cannot be adopted (${lane.status})`)
    }
    const target = typeof into === 'string' && into.length > 0
      ? (into.startsWith('/') ? into : join(clone.workspace, into))
      : join(clone.workspace, `clone-${clone.id}-lane-${lane.index + 1}`)

    await deps.fs.mkdir(join(clone.root, 'patch'), { recursive: true })
    const pieces = []
    const conflicts = []
    for (const file of lane.files) {
      if (isScratchEntry(basename(file.path))) continue
      const incoming = await deps.fs.readFile(join(lane.dir, file.path), 'utf8').catch(() => null)
      if (incoming === null) continue
      const existing = await deps.fs.readFile(join(target, file.path), 'utf8').catch(() => null)
      if (existing === null) {
        // A new file: write it straight through, the patch cannot carry creation
        // context for a path that does not exist yet in the target.
        await deps.fs.mkdir(join(target, dirname(file.path)), { recursive: true })
        await deps.fs.writeFile(join(target, file.path), incoming)
        continue
      }
      if (existing === incoming) continue
      conflicts.push(file.path)
      // A patch is applied from the repository root, so its paths must be
      // root-relative even when the target directory is nested.
      const patchPath = clone.repo === null
        ? file.path
        : relative(clone.repo.root, join(target, file.path)).split(sep).join('/')
      pieces.push(await this.diffFiles({ clone, lane, target, path: file.path, patchPath }))
    }

    const patchPath = join(clone.root, 'patch', `lane-${lane.index + 1}.patch`)
    await deps.fs.writeFile(patchPath, pieces.join(''))
    let applied = false
    if (pieces.length > 0 && clone.repo !== null) {
      const result = await deps.git(['apply', '--3way', patchPath], clone.repo.root)
      applied = result.code === 0
      if (!applied) {
        const fallback = await deps.git(['apply', patchPath], clone.repo.root)
        applied = fallback.code === 0
      }
    }
    return {
      patchPath,
      target,
      applied,
      conflicts,
      written: lane.files.filter((file) => !conflicts.includes(file.path)).length,
    }
  }

  /**
   * Adopt one lane: copy its files into a fresh folder in the workspace.
   * @param args - clone id, optional 1-based lane number (defaults to the suggestion).
   * @returns `{ path, lane }` on success.
   */
  async pick({ cloneId, laneNumber }) {
    const deps = this.deps
    const clone = this.clones.get(cloneId)
    if (clone === undefined) throw new Error(`dsh-clone: unknown clone "${cloneId}"`)
    if (clone.picked !== null) return { path: clone.picked.path, lane: clone.picked.lane }

    const lane = laneNumber === null || laneNumber === undefined
      ? clone.lanes.find((candidate) => candidate.index === clone.winner)
      : clone.lanes[laneNumber - 1]
    if (lane === undefined || lane === null) throw new Error('dsh-clone: that lane does not exist')
    if (!['settled', 'empty'].includes(lane.status) || lane.files.length === 0) {
      throw new Error(`dsh-clone: lane ${lane.index + 1} has nothing to adopt (${lane.status})`)
    }

    const target = join(clone.workspace, `clone-${clone.id}-lane-${lane.index + 1}`)
    await deps.fs.mkdir(target, { recursive: true })
    await deps.fs.cp(lane.dir, target, {
      recursive: true,
      force: true,
      filter: (source) => !isScratchEntry(basename(source)),
    })
    clone.picked = {
      lane: lane.index,
      path: target,
      at: deps.now(),
    }
    await this.saveState(clone).catch(() => {})
    return { path: target, lane }
  }

  /** Interrupt running builders and close the clone. */
  async cancel({ cloneId }) {
    const clone = this.clones.get(cloneId)
    if (clone === undefined) throw new Error(`dsh-clone: unknown clone "${cloneId}"`)
    for (const lane of clone.lanes) {
      this.clearLaneTimer(clone, lane)
      if (lane.status !== 'running') continue
      lane.status = 'cancelled'
      lane.finishedAt = this.deps.now()
      try {
        this.deps.interruptAgent({ childId: lane.childId, parent: clone.parent })
      } catch (error) {
        lane.error = reasonOf(error)
      }
    }
    this.finish(clone)
    return clone
  }

  /** Remove a clone's scratch directories from the workspace. */
  async discard({ cloneId }) {
    const deps = this.deps
    const clone = this.clones.get(cloneId)
    if (clone === undefined) throw new Error(`dsh-clone: unknown clone "${cloneId}"`)
    for (const lane of clone.lanes) this.clearLaneTimer(clone, lane)
    if (clone.status === 'running') await this.cancel({ cloneId })
    if (clone.repo !== null) {
      for (const lane of clone.lanes) {
        if (lane.branch === undefined) continue
        await deps.git(['worktree', 'remove', '--force', lane.dir], clone.repo.root).catch(() => {})
        await deps.git(['branch', '-D', lane.branch], clone.repo.root).catch(() => {})
      }
    }
    await deps.fs.rm(clone.root, { recursive: true, force: true }).catch(() => {})
    clone.status = 'discarded'
    return clone
  }

  /** JSON-safe projection of one clone for the Web panel and the tools. */
  snapshot(clone) {
    if (clone === undefined || clone === null) return null
    const now = this.deps.now()
    return {
      id: clone.id,
      status: clone.status,
      note: clone.note,
      viewport: clone.viewport,
      createdAt: clone.createdAt,
      finishedAt: clone.finishedAt,
      durationMs: (clone.finishedAt ?? now) - clone.createdAt,
      repo: clone.repo === null ? null : { root: clone.repo.root },
      reference: {
        url: `/api/dsh-clone/reference?cloneId=${clone.id}`,
        label: clone.reference.label,
        mediaType: clone.reference.mediaType,
      },
      winner: clone.winner,
      picked: clone.picked,
      error: clone.error,
      region: clone.region ?? null,
      kind: clone.kind ?? 'clone',
      sourceId: clone.sourceId ?? null,
      sourceScore: typeof clone.sourceScore === 'number' ? clone.sourceScore : null,
      delta: typeof clone.delta === 'number' ? clone.delta : null,
      restored: clone.restored === true,
      lanes: clone.lanes.map((lane) => ({
        index: lane.index,
        strategy: lane.strategy.id,
        strategyLabel: lane.strategy.label,
        status: lane.status,
        previewUrl: lane.previewUrl,
        startedAt: lane.startedAt,
        finishedAt: lane.finishedAt,
        durationMs: lane.startedAt === null ? null : (lane.finishedAt ?? now) - lane.startedAt,
        tools: lane.tools,
        tokens: lane.tokens,
        files: lane.files.length,
        bytes: lane.files.reduce((sum, file) => sum + (Number(file.bytes) || 0), 0),
        delivered: lane.files.some((file) => file.path === 'index.html'),
        gate: lane.gate === undefined ? null : {
          pass: lane.gate.pass === true,
          failed: lane.gate.checks.filter((check) => !check.ok).map((check) => `${check.id}: ${check.detail}`),
          checks: lane.gate.checks.length,
        },
        score: typeof lane.score === 'number' ? lane.score : null,
        diffUrl: lane.diffPath === undefined
          ? null
          : `/api/dsh-clone/diff?cloneId=${clone.id}&lane=${lane.index + 1}`,
        worstRegion: lane.worstRegion ?? null,
        diffMean: typeof lane.diffMean === 'number' ? lane.diffMean : null,
        runtime: lane.runtime === undefined || lane.runtime === null
          ? null
          : {
            errors: lane.runtime.errors.length,
            overflowX: lane.runtime.overflowX,
            detail: [...lane.runtime.errors, ...lane.runtime.rejections, ...lane.runtime.consoleErrors].slice(0, 3),
          },
        renderUrl: lane.renderPath === undefined
          ? null
          : `/api/dsh-clone/render?cloneId=${clone.id}&lane=${lane.index + 1}`,
        stopReason: lane.stopReason,
        timedOut: lane.timedOut === true,
        nudged: lane.nudged === true,
        error: lane.error,
        report: lane.report === null || lane.report === undefined ? null : truncate(lane.report, 1200),
      })),
      summary: summarize(clone),
      strategyReason: clone.strategyReason ?? null,
      leaderboard: summariseBoard(this.boards.get(clone.workspace) ?? emptyBoard()),
    }
  }
}

/**
 * Kept for reference: a hand-written unified diff is easy to get subtly wrong
 * (hunk counts, trailing newlines), so adoption asks `git diff` instead.
 * @deprecated use {@link CloneEngine#diffFiles}.
 */
function makeUnifiedDiff({ path, before, after, target }) {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  let start = 0
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) start += 1
  let tail = 0
  while (
    tail < beforeLines.length - start
    && tail < afterLines.length - start
    && beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) tail += 1
  const context = 3
  const from = Math.max(0, start - context)
  const beforeEnd = Math.min(beforeLines.length, beforeLines.length - tail + context)
  const afterEnd = Math.min(afterLines.length, afterLines.length - tail + context)
  const header = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${from + 1},${beforeEnd - from} +${from + 1},${afterEnd - from} @@`,
  ]
  const body = [
    ...beforeLines.slice(from, beforeEnd).map((line) => `-${line}`),
    ...afterLines.slice(from, afterEnd).map((line) => `+${line}`),
  ]
  return `${header.join('\n')}\n${body.join('\n')}\n`
}

/** Pull the readable closing text out of a subagent result. */
function extractReport(result) {
  const blocks = Array.isArray(result?.output) ? result.output : []
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
  return text.length === 0 ? null : text
}

export { LIMITS, IGNORED_NAMES }
