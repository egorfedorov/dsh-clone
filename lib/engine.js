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

import { basename, join } from 'node:path'
import { buildLanePrompt, strategyForLane } from './prompts.js'
import { suggestedWinner, summarize } from './rank.js'
import { readPngSize } from './png.js'
import { reasonOf, truncate } from './util.js'

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

export class CloneEngine {
  /**
   * @param deps - injected side effects (see the module doc).
   */
  constructor(deps) {
    this.deps = deps
    this.clones = new Map()
    this.order = []
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

    for (let index = 0; index < lanes; index += 1) {
      const lane = {
        index,
        strategy: strategyForLane(index),
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
    Promise.resolve(handle.result).then(
      (result) => this.onLaneSettled(clone, lane, result, handle),
      (error) => this.onLaneFailed(clone, lane, error, handle),
    )
  }

  /** A lane's builder finished: inventory its output and make it adoptable. */
  async onLaneSettled(clone, lane, result, handle) {
    const deps = this.deps
    try {
      lane.finishedAt = deps.now()
      lane.stopReason = result?.stopReason ?? 'completed'
      lane.report = extractReport(result)
      lane.files = await this.inventory(lane.dir)
      const delivered = lane.files.some((file) => file.path === 'index.html')
      lane.status = delivered ? 'settled' : 'empty'
      if (!delivered) lane.error = 'the lane produced no index.html'
      if (delivered) await this.scoreLane(clone, lane)
    } catch (error) {
      lane.status = 'failed'
      lane.error = reasonOf(error)
    } finally {
      Promise.resolve(handle?.dispose?.()).catch(() => {})
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
      })
      if (scored === null || scored === undefined) return
      lane.renderPath = scored.outPath
      lane.score = scored.score
    } catch (error) {
      deps.logger?.warn?.(`dsh-clone: lane ${lane.index + 1} was not scored: ${reasonOf(error)}`)
    }
  }

  /** A lane's builder failed or was interrupted. */
  onLaneFailed(clone, lane, error, handle) {
    lane.status = lane.status === 'cancelled' ? 'cancelled' : 'failed'
    lane.error = reasonOf(error)
    lane.finishedAt = this.deps.now()
    Promise.resolve(handle?.dispose?.()).catch(() => {})
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
        } catch {
          /* A lane whose session is mid-teardown simply keeps its last numbers. */
        }
      }
    }
  }

  /** Close a clone once every lane reached a terminal state. */
  finishIfDone(clone) {
    if (clone.status !== 'running') return
    if (clone.starting === true) return
    const terminal = clone.lanes.every((lane) => ['settled', 'empty', 'failed', 'cancelled'].includes(lane.status))
    if (terminal) this.finish(clone)
  }

  /** Mark a clone finished and compute the suggested winner. */
  finish(clone) {
    clone.status = 'finished'
    clone.finishedAt = this.deps.now()
    const winner = suggestedWinner(clone.lanes)
    clone.winner = winner === null ? null : winner.index
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
    return { path: target, lane }
  }

  /** Interrupt running builders and close the clone. */
  async cancel({ cloneId }) {
    const clone = this.clones.get(cloneId)
    if (clone === undefined) throw new Error(`dsh-clone: unknown clone "${cloneId}"`)
    for (const lane of clone.lanes) {
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
        score: typeof lane.score === 'number' ? lane.score : null,
        renderUrl: lane.renderPath === undefined
          ? null
          : `/api/dsh-clone/render?cloneId=${clone.id}&lane=${lane.index + 1}`,
        stopReason: lane.stopReason,
        error: lane.error,
        report: lane.report === null || lane.report === undefined ? null : truncate(lane.report, 1200),
      })),
      summary: summarize(clone),
    }
  }
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
