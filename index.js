/**
 * dsh-clone — Host half.
 *
 * Screenshot in, working UI out. One command starts N builder agents, each in
 * its own isolated directory (a git worktree when the workspace is a repo,
 * a plain directory when it is not), all rebuilding the same reference image
 * in parallel. The Web panel shows the reference and every lane side by side,
 * live, and the reader adopts whichever rebuild they prefer.
 *
 * Wiring, in one place:
 *   /clone command      human entry point
 *   clone tool          the same operations for the agent
 *   static routes       panel state, reference image, lane previews, actions
 *   poller              live tool/token counters while a clone is running
 *
 * Every side effect the engine needs is injected below, so lib/engine.js stays
 * a pure state machine and test/smoke.mjs can drive it without a Harness.
 */

import { basename, extname, resolve as resolvePath } from 'node:path'
import { cp, copyFile, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { CloneEngine } from './lib/engine.js'
import { parseCloneArgs, referenceHintOf } from './lib/parse.js'
import { clampLanes, mediaTypeOf, reasonOf, truncate } from './lib/util.js'
import {
  parsePreviewPath,
  readJsonBody,
  sendJson,
  sendText,
  serveImageFile,
  serveLaneFile,
} from './lib/preview.js'

/** Cordis plugin identity. */
export const name = 'dsh-clone'

/** Services that must exist for the plugin to be useful. */
export const inject = ['commands', 'tools', 'workingDirectory', 'subagents', 'agents', 'subprocess']

/** Tunables, read defensively so a partial or missing row config still works. */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const viewport = typeof input.viewport === 'string' && /^\d{2,5}x\d{2,5}$/u.test(input.viewport)
    ? input.viewport
    : '1280x800'
  return {
    lanes: clampLanes(input.lanes ?? 3, { min: 1, max: 4, fallback: 3 }),
    maxLanes: clampLanes(input.maxLanes ?? 4, { min: 1, max: 4, fallback: 4 }),
    viewport,
    provider: typeof input.provider === 'string' && input.provider.length > 0 ? input.provider : 'spawn',
    pollMs: Number.isFinite(input.pollMs) && input.pollMs >= 200 ? Math.floor(input.pollMs) : 900,
    commandName: typeof input.commandName === 'string' && input.commandName.length > 0 ? input.commandName : 'clone',
    tool: input.tool !== false,
    command: input.command !== false,
  }
}

/**
 * Mount the plugin.
 * @param ctx - Cordis context provided by the Loader.
 * @param rawConfig - untrusted row configuration.
 */
export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`dsh-clone: ${message}`)
    } catch {
      /* logging must never break the plugin */
    }
  }

  // ── side effects handed to the engine ────────────────────────────────────

  const runCommand = async (argv, cwd, { input, timeoutMs = 120_000 } = {}) => {
    const maxBytes = 4 * 1024 * 1024
    const handle = ctx.subprocess.spawn({
      argv,
      cwd,
      stdio: {
        stdin: input === undefined ? 'ignore' : { data: input },
        stdout: { maxBytes },
        stderr: { maxBytes },
      },
      graceMs: 2_000,
    })
    const timer = setTimeout(() => {
      try {
        handle.terminate()
      } catch {
        /* already gone */
      }
    }, timeoutMs)
    let outcome
    try {
      outcome = await handle.done
    } finally {
      clearTimeout(timer)
    }
    const stdout = handle.collected?.stdout?.readFrom(0)?.text ?? ''
    const stderr = handle.collected?.stderr?.readFrom(0)?.text ?? ''
    return {
      code: typeof outcome?.exitCode === 'number' ? outcome.exitCode : outcome?.signal ? 124 : 1,
      stdout,
      stderr,
      signal: outcome?.signal ?? null,
    }
  }

  const resolveReference = async ({ agent, note }) => {
    const workspace = await ctx.workingDirectory.ensure(agent)
    const hint = referenceHintOf(note)
    if (hint !== null) {
      const absolute = resolvePath(workspace, hint)
      const stats = await stat(absolute).catch(() => null)
      if (stats !== null && stats.isFile()) {
        return {
          path: absolute,
          mediaType: mediaTypeOf(absolute),
          extension: extname(absolute) || '.png',
          label: basename(absolute),
        }
      }
    }
    const attachments = ctx.get('attachments')
    const events = agent.session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'user/message') continue
      const content = Array.isArray(event.data?.content) ? event.data.content : []
      for (let block = content.length - 1; block >= 0; block -= 1) {
        if (content[block]?.type !== 'image') continue
        const hostPath = attachments?.imageHostPath?.(content[block].attachment)
        if (typeof hostPath === 'string' && hostPath.length > 0) {
          return {
            path: hostPath,
            mediaType: content[block].attachment?.mediaType ?? mediaTypeOf(hostPath),
            extension: extname(hostPath) || '.png',
            label: 'conversation image',
          }
        }
      }
    }
    return null
  }

  const activations = new Map()

  const spawnAgent = async ({ cwd, prompt, label, parent }) => {
    const activation = await ctx.subagents.startActivation({
      provider: config.provider,
      label,
      request: {
        cwd,
        prompt: [{ type: 'text', text: prompt }],
        parent,
      },
      signal: new AbortController().signal,
      delivery: 'caller',
    })
    activations.set(activation.childId, activation)
    Promise.resolve(activation.result).then(
      () => activations.delete(activation.childId),
      () => activations.delete(activation.childId),
    )
    return {
      childId: activation.childId,
      result: activation.result,
      dispose: () => Promise.resolve(activation.dispose?.()).catch(() => {}),
    }
  }

  const engine = new CloneEngine({
    now: () => Date.now(),
    id: () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`),
    fs: { cp, copyFile, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile },
    git: (args, cwd) => runCommand(['git', ...args], cwd, { timeoutMs: 120_000 }),
    spawnAgent,
    interruptAgent: ({ childId, parent }) => {
      if (childId === null) return
      ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: parent })
      Promise.resolve(activations.get(childId)?.dispose?.()).catch(() => {})
      activations.delete(childId)
    },
    getAgent: (childId) => ctx.agents.get(childId),
    resolveReference,
    workingDirectory: ctx.workingDirectory,
    logger: { warn: (message) => log('warn', message) },
    config,
  })

  // ── text rendering shared by the command and the tool ────────────────────

  const renderStatus = (clone) => {
    if (clone === null || clone === undefined) {
      return 'No clone yet. Paste a screenshot, then run /clone 3 — or /clone 3 ./mock.png'
    }
    const lines = [
      `Clone ${clone.id} · ${clone.status}${clone.note.length > 0 ? ` · "${truncate(clone.note, 60)}"` : ''}`,
      `Reference: ${clone.reference.label} · viewport ${clone.viewport}`,
    ]
    for (const lane of clone.lanes) {
      const badge = lane.status === 'settled' ? 'ready' : lane.status
      const size = lane.files.length === 0 ? 'no files' : `${lane.files.length} files`
      const suggested = lane.index === clone.winner ? ' · suggested' : ''
      lines.push(`  lane ${lane.index + 1} (${lane.strategy.label}): ${badge} · ${lane.tools} tools · ${size}${suggested}${lane.error === null ? '' : ` · ${lane.error}`}`)
    }
    if (clone.picked !== null) lines.push(`Adopted into: ${clone.picked.path}`)
    else if (clone.status === 'finished') lines.push(`Adopt one with: /clone pick <lane>`)
    return lines.join('\n')
  }

  const startClone = async ({ agent, sessionId, lanes, note }) => {
    const clone = await engine.start({
      agent,
      sessionId,
      lanes,
      note,
      viewport: config.viewport,
    })
    const ready = clone.lanes.filter((lane) => lane.status === 'running').length
    return [
      `Clone ${clone.id} started: ${clone.lanes.length} lanes rebuilding ${clone.reference.label} in parallel.`,
      `Each lane works in its own directory. Open the Clone tab in the conversation to watch them side by side.`,
      ready === 0 ? 'No lane started — check the plugin log.' : `${ready} builder agents are running.`,
    ].join('\n')
  }

  const latestClone = (sessionId) => engine.latestForSession(sessionId)

  const perform = async ({ action, cloneId, lane, agent, sessionId, lanes, note }) => {
    switch (action) {
      case 'start': {
        const text = await startClone({ agent, sessionId, lanes, note })
        return { text, clone: latestClone(sessionId) }
      }
      case 'status':
        return { text: renderStatus(latestClone(sessionId)), clone: latestClone(sessionId) }
      case 'pick': {
        const target = cloneId === undefined ? latestClone(sessionId) : engine.get(cloneId)
        if (target === null || target === undefined) throw new Error('dsh-clone: no clone to adopt')
        const picked = await engine.pick({ cloneId: target.id, laneNumber: lane ?? null })
        return {
          text: `Lane ${picked.lane.index + 1} adopted into ${picked.path}. Open index.html to see it; the other lanes stay in .dsh-clone/ until you /clone discard.`,
          clone: target,
        }
      }
      case 'cancel': {
        const target = cloneId === undefined ? latestClone(sessionId) : engine.get(cloneId)
        if (target === null || target === undefined) throw new Error('dsh-clone: no clone to cancel')
        const clone = await engine.cancel({ cloneId: target.id })
        return { text: `Clone ${clone.id} cancelled.`, clone }
      }
      case 'discard': {
        const target = cloneId === undefined ? latestClone(sessionId) : engine.get(cloneId)
        if (target === null || target === undefined) throw new Error('dsh-clone: no clone to discard')
        const clone = await engine.discard({ cloneId: target.id })
        return { text: `Clone ${clone.id} scratch directories removed.`, clone }
      }
      default:
        throw new Error(`dsh-clone: unknown action "${String(action)}"`)
    }
  }

  // ── /clone ──────────────────────────────────────────────────────────────

  if (config.command) {
    ctx.effect(() => ctx.commands.register({
      name: config.commandName,
      description: 'Rebuild a reference screenshot as working UI: /clone [lanes] [note] | status | pick <n> | cancel | discard',
      input: { hint: '[lanes] [note]', attachments: true },
      async handler(invocation) {
        try {
          const parsed = parseCloneArgs(invocation.rawInput, { defaultLanes: config.lanes, maxLanes: config.maxLanes })
          if (parsed.kind === 'help') {
            return {
              kind: 'success',
              text: [
                '/clone [lanes] [note] — rebuild the last image in this conversation (or a path in the note) using N lanes (1-4)',
                '/clone status — lane states of the latest clone',
                '/clone pick <lane> — copy that lane into the workspace as a working app',
                '/clone cancel — stop the builders',
                '/clone discard — delete the scratch directories',
              ].join('\n'),
            }
          }
          if (parsed.kind === 'status') {
            return { kind: 'success', text: renderStatus(latestClone(invocation.agent.id)) }
          }
          const result = await perform({
            action: parsed.kind === 'pick' ? 'pick' : parsed.kind === 'cancel' ? 'cancel' : 'discard',
            lane: parsed.lane ?? null,
            agent: invocation.agent,
            sessionId: invocation.agent.id,
          })
          return { kind: 'success', text: result.text }
        } catch (error) {
          return { kind: 'error', text: reasonOf(error) }
        }
      },
    }), 'dsh-clone: /clone command')
  }

  // ── clone tool ──────────────────────────────────────────────────────────

  if (config.tool) {
    ctx.effect(() => ctx.tools.register({
      name: 'clone',
      description: [
        'Rebuild a user interface from a reference screenshot, in parallel, and adopt the result the user prefers.',
        'Use `start` when the user shows a screenshot and wants it as working code: it launches N builder agents, each in its own isolated directory (a git worktree inside a repository), all rebuilding the same reference image.',
        'The operations mirror the /clone command: start, status, pick, cancel, discard. `pick` copies one finished lane into the workspace as a working static page.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'status', 'pick', 'cancel', 'discard'],
            description: 'start a clone, read its state, adopt one lane, stop the builders, or delete the scratch directories.',
          },
          lanes: {
            type: 'number',
            description: 'Number of parallel builder lanes for `start` (1-4). Defaults to the configured value.',
          },
          note: {
            type: 'string',
            description: 'Extra instruction for the builders, and optionally a reference image path. Omitted means the last image in the conversation is the reference.',
          },
          lane: {
            type: 'number',
            description: '1-based lane number for `pick`. Omitted adopts the suggested lane.',
          },
          clone_id: {
            type: 'string',
            description: 'Target an older clone instead of the latest one for this session.',
          },
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) throw new Error('dsh-clone: the clone tool needs a calling agent')
        const result = await perform({
          action: args.action,
          cloneId: args.clone_id,
          lane: args.lane ?? null,
          agent,
          sessionId: agent.id,
          lanes: args.lanes ?? config.lanes,
          note: args.note ?? '',
        })
        return result.text
      },
    }), 'dsh-clone: clone tool')
  }

  // ── live counters ───────────────────────────────────────────────────────

  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        engine.tick()
      } catch (error) {
        log('warn', `tick failed: ${reasonOf(error)}`)
      }
    }, config.pollMs)
    return () => clearInterval(timer)
  }, 'dsh-clone: lane counter poller')

  // ── Web routes ──────────────────────────────────────────────────────────

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const reject = (request, response) => {
        const connection = ctx.get('connection')
        const rejection = connection?.requestRejection?.(request)
        if (rejection === undefined) return false
        response.statusCode = rejection
        response.end()
        return true
      }

      const state = scope.webServer.register({
        kind: 'exact',
        path: '/api/dsh-clone/state',
        handler: (request, response) => {
          if (reject(request, response)) return
          const url = new URL(request.url ?? '/', 'http://127.0.0.1')
          const sessionId = url.searchParams.get('sessionId') ?? undefined
          const cloneId = url.searchParams.get('cloneId')
          if (cloneId !== null) {
            const clone = engine.get(cloneId)
            sendJson(response, 200, { clones: clone === undefined ? [] : [engine.snapshot(clone)] })
            return
          }
          const clones = engine.listForSession(sessionId).slice(0, 8).map((clone) => engine.snapshot(clone))
          sendJson(response, 200, { clones })
        },
      })

      const reference = scope.webServer.register({
        kind: 'exact',
        path: '/api/dsh-clone/reference',
        handler: async (request, response) => {
          if (reject(request, response)) return
          const url = new URL(request.url ?? '/', 'http://127.0.0.1')
          const clone = engine.get(url.searchParams.get('cloneId') ?? '')
          if (clone === undefined) {
            sendText(response, 404, 'not found')
            return
          }
          await serveImageFile({
            fs: { readFile },
            path: clone.reference.path,
            mediaType: clone.reference.mediaType,
            response,
          })
        },
      })

      const preview = scope.webServer.register({
        kind: 'prefix',
        path: '/api/dsh-clone/preview/',
        handler: async (request, response) => {
          if (reject(request, response)) return
          const url = new URL(request.url ?? '/', 'http://127.0.0.1')
          const parsed = parsePreviewPath(url.pathname)
          if (parsed === null) {
            sendText(response, 404, 'not found')
            return
          }
          const clone = engine.get(parsed.cloneId)
          const lane = clone?.lanes?.[parsed.lane - 1]
          if (clone === undefined || lane === undefined) {
            sendText(response, 404, 'not found')
            return
          }
          await serveLaneFile({ fs: { readFile, stat }, root: lane.dir, relativePath: parsed.rest, response })
        },
      })

      const action = scope.webServer.register({
        kind: 'exact',
        path: '/api/dsh-clone/action',
        handler: async (request, response) => {
          if (reject(request, response)) return
          if (request.method !== 'POST') {
            sendText(response, 405, 'method not allowed')
            return
          }
          try {
            const body = await readJsonBody(request)
            const cloneId = typeof body.cloneId === 'string' ? body.cloneId : undefined
            const target = cloneId === undefined ? null : engine.get(cloneId)
            if (cloneId !== undefined && target === undefined) {
              sendJson(response, 404, { ok: false, error: `unknown clone "${cloneId}"` })
              return
            }
            const clone = target ?? engine.listForSession(undefined)[0]
            if (clone === undefined || clone === null) {
              sendJson(response, 404, { ok: false, error: 'no clone available' })
              return
            }
            switch (body.action) {
              case 'pick': {
                const laneNumber = Number.isInteger(body.lane) ? body.lane : null
                const picked = await engine.pick({ cloneId: clone.id, laneNumber })
                sendJson(response, 200, { ok: true, path: picked.path, lane: picked.lane.index, clone: engine.snapshot(clone) })
                return
              }
              case 'cancel':
                await engine.cancel({ cloneId: clone.id })
                sendJson(response, 200, { ok: true, clone: engine.snapshot(clone) })
                return
              case 'discard':
                await engine.discard({ cloneId: clone.id })
                sendJson(response, 200, { ok: true, clone: engine.snapshot(clone) })
                return
              default:
                sendJson(response, 400, { ok: false, error: `unknown action "${String(body.action)}"` })
            }
          } catch (error) {
            sendJson(response, 500, { ok: false, error: reasonOf(error) })
          }
        },
      })

      return () => {
        for (const dispose of [state, reference, preview, action]) {
          try {
            dispose()
          } catch {
            /* one route must not strand the others */
          }
        }
      }
    }, 'dsh-clone: web routes')
  })

  log('info', `mounted (lanes=${config.lanes}, viewport=${config.viewport}, command=/${config.commandName})`)
}
