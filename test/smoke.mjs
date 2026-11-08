/**
 * dsh-clone smoke test — plain Node, no Harness, no network.
 *
 * Covers the pure grammar/ranking/prompt helpers and drives the whole engine
 * state machine against a real temporary directory with fake subagents, so a
 * regression in the lane lifecycle fails here instead of in a live session.
 *
 *   node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, cp, copyFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseCloneArgs, referenceHintOf, DEFAULT_LANES, MAX_LANES } from '../lib/parse.js'
import { rankLanes, suggestedWinner, laneDelivered, summarize } from '../lib/rank.js'
import { buildLanePrompt, LANE_STRATEGIES, strategyForLane, DELIVERY_CONTRACT } from '../lib/prompts.js'
import { CloneEngine } from '../lib/engine.js'
import { clampLanes, formatDuration, isImagePath, mediaTypeOf, slugify, totalTokens, truncate, extensionOf } from '../lib/util.js'
import { mediaTypeFor, parsePreviewPath, safeJoin, sendJson } from '../lib/preview.js'
import { decodePng, readPngSize } from '../lib/png.js'
import { GRID, gridOf, gridSimilarity, scoreLabel, scoreRender } from '../lib/score.js'
import { detectRenderer, resetRendererCache } from '../lib/render.js'

let passed = 0
const tests = []

const test = (name, fn) => tests.push({ name, fn })

/** Poll a predicate until it holds or the deadline passes. */
async function waitFor(predicate, { timeoutMs = 4000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  throw new Error('timed out waiting for the engine')
}

// ── grammar ────────────────────────────────────────────────────────────────

test('parse: empty input starts the default lane count', () => {
  assert.deepEqual(parseCloneArgs(''), { kind: 'start', lanes: DEFAULT_LANES, note: '' })
})

test('parse: explicit lane count and note', () => {
  assert.deepEqual(parseCloneArgs('2 dark dashboard'), { kind: 'start', lanes: 2, note: 'dark dashboard' })
  assert.deepEqual(parseCloneArgs('4'), { kind: 'start', lanes: 4, note: '' })
})

test('parse: lane count is clamped to the supported range', () => {
  assert.equal(parseCloneArgs('99 build').lanes, MAX_LANES)
  assert.equal(parseCloneArgs('0 build').lanes, 1)
})

test('parse: control words', () => {
  assert.deepEqual(parseCloneArgs('status'), { kind: 'status' })
  assert.deepEqual(parseCloneArgs('pick 2'), { kind: 'pick', lane: 2 })
  assert.deepEqual(parseCloneArgs('pick'), { kind: 'pick', lane: null })
  assert.deepEqual(parseCloneArgs('cancel'), { kind: 'cancel' })
  assert.deepEqual(parseCloneArgs('discard'), { kind: 'discard' })
  assert.deepEqual(parseCloneArgs('help'), { kind: 'help' })
})

test('parse: a note keeps every non-numeric word', () => {
  assert.equal(parseCloneArgs('3 clone the pricing page').note, 'clone the pricing page')
})

test('parse: reference hint finds an image path, ignores other words', () => {
  assert.equal(referenceHintOf('2 dark ./mock.PNG please'), './mock.PNG')
  assert.equal(referenceHintOf('no image here'), null)
})

// ── helpers ────────────────────────────────────────────────────────────────

test('util: clamp, truncate, slug, duration, tokens', () => {
  assert.equal(clampLanes(7), 4)
  assert.equal(clampLanes('nope'), 3)
  assert.equal(truncate('abcdefghij', 5).endsWith('…'), true)
  assert.equal(slugify('Hello, World!'), 'hello-world')
  assert.equal(slugify('***'), 'clone')
  assert.equal(formatDuration(420), '420ms')
  assert.match(formatDuration(4200), /^4\.2s$/u)
  assert.equal(totalTokens({ input: 10, output: 5, cacheRead: 2 }), 17)
  assert.equal(extensionOf('a/b/c.PNG'), '.png')
  assert.equal(isImagePath('x.webp'), true)
  assert.equal(isImagePath('x.txt'), false)
  assert.equal(mediaTypeOf('x.jpeg'), 'image/jpeg')
})

test('preview: media types and path traversal are handled', () => {
  assert.equal(mediaTypeFor('index.html'), 'text/html; charset=utf-8')
  assert.equal(mediaTypeFor('app.js'), 'text/javascript; charset=utf-8')
  const root = '/tmp/lane'
  assert.equal(safeJoin(root, 'index.html'), '/tmp/lane/index.html')
  assert.equal(safeJoin(root, '../../etc/passwd'), null)
  assert.equal(safeJoin(root, 'nested/../../escape'), null)
})

test('preview: route parsing', () => {
  assert.deepEqual(parsePreviewPath('/api/dsh-clone/preview/abcd1234/2/index.html'), {
    cloneId: 'abcd1234', lane: 2, rest: 'index.html',
  })
  assert.deepEqual(parsePreviewPath('/api/dsh-clone/preview/abcd1234/1/'), { cloneId: 'abcd1234', lane: 1, rest: '' })
  assert.equal(parsePreviewPath('/api/dsh-clone/preview/../x/1/a'), null)
  assert.equal(parsePreviewPath('/api/dsh-clone/preview/abcd/9/a'), null)
})

test('preview: json responses are well formed', () => {
  const headers = {}
  const chunks = []
  const response = {
    statusCode: 0,
    setHeader: (name, value) => { headers[name.toLowerCase()] = value },
    end: (body) => chunks.push(body),
  }
  sendJson(response, 200, { ok: true })
  assert.equal(response.statusCode, 200)
  assert.equal(headers['content-type'], 'application/json; charset=utf-8')
  assert.deepEqual(JSON.parse(chunks.join('')), { ok: true })
})

// ── prompts ────────────────────────────────────────────────────────────────

test('prompts: strategies cycle and stay distinct', () => {
  assert.equal(strategyForLane(0).id, LANE_STRATEGIES[0].id)
  assert.equal(strategyForLane(LANE_STRATEGIES.length).id, LANE_STRATEGIES[0].id)
  const ids = new Set(LANE_STRATEGIES.map((entry) => entry.id))
  assert.equal(ids.size, LANE_STRATEGIES.length)
})

test('prompts: the delivery contract is non-negotiable and lane-specific', () => {
  const prompt = buildLanePrompt({
    laneIndex: 1,
    laneCount: 3,
    strategy: LANE_STRATEGIES[1],
    referencePath: '/tmp/ref.png',
    referenceLabel: 'reference.png',
    viewport: '1280x800',
    note: 'dark',
  })
  assert.match(prompt, /lane 2 of 3/u)
  assert.match(prompt, /\/tmp\/ref\.png/u)
  assert.match(prompt, /index\.html/u)
  assert.match(prompt, /1280x800/u)
  assert.match(prompt, /No network at runtime/u)
  assert.match(prompt, /dark/u)
  assert.ok(prompt.includes(LANE_STRATEGIES[1].brief.slice(0, 30)))
  assert.equal(DELIVERY_CONTRACT.includes('REFERENCE_VIEWPORT'), true, 'the contract template keeps its token')
})

// ── ranking ────────────────────────────────────────────────────────────────

test('rank: only a lane with index.html is adoptable', () => {
  assert.equal(laneDelivered({ status: 'settled', files: [{ path: 'index.html' }] }), true)
  assert.equal(laneDelivered({ status: 'settled', files: [{ path: 'a.css' }] }), false)
  assert.equal(laneDelivered({ status: 'failed', files: [{ path: 'index.html' }] }), false)
})

test('rank: delivered lanes lead, earliest finish is the suggestion', () => {
  const lanes = [
    { index: 0, status: 'empty', files: [], finishedAt: 1 },
    { index: 1, status: 'settled', files: [{ path: 'index.html' }], finishedAt: 20 },
    { index: 2, status: 'settled', files: [{ path: 'index.html' }], finishedAt: 10 },
  ]
  assert.equal(suggestedWinner(lanes).index, 2)
  assert.deepEqual(rankLanes(lanes).map((lane) => lane.index), [2, 1, 0])
  assert.deepEqual(summarize({ id: 'x', status: 'running', lanes }), {
    id: 'x', status: 'running', done: 3, total: 3, delivered: 2, winner: null, bestScore: null,
  })
})

test('rank: a higher similarity score outranks an earlier finish', () => {
  const lanes = [
    { index: 0, status: 'settled', files: [{ path: 'index.html' }], finishedAt: 5, score: 71.2 },
    { index: 1, status: 'settled', files: [{ path: 'index.html' }], finishedAt: 90, score: 95.5 },
    { index: 2, status: 'settled', files: [{ path: 'index.html' }], finishedAt: 40, score: null },
  ]
  assert.equal(suggestedWinner(lanes).index, 1)
  assert.deepEqual(rankLanes(lanes).map((lane) => lane.index), [1, 0, 2])
  assert.equal(summarize({ id: 'x', status: 'finished', lanes }).bestScore, 95.5)
})

test('rank: unscored lanes still fall back to finish order', () => {
  const lanes = [
    { index: 0, status: 'settled', files: [{ path: 'index.html' }], finishedAt: 30, score: null },
    { index: 1, status: 'settled', files: [{ path: 'index.html' }], finishedAt: 10, score: null },
  ]
  assert.equal(suggestedWinner(lanes).index, 1)
})

// ── pixels and scoring ────────────────────────────────────────────────────

const referencePng = await readFile(new URL('../docs/assets/reference.png', import.meta.url))
const renderPng = await readFile(new URL('./fixtures/render-lane.png', import.meta.url))

test('png: decodes the demo reference with its real dimensions and pixels', () => {
  const image = decodePng(referencePng)
  assert.equal(image.width, 900)
  assert.equal(image.height, 620)
  assert.equal(image.data.length, 900 * 620 * 4)
  assert.deepEqual([...image.data.slice(0, 4)], [244, 241, 234, 255], 'the warm canvas colour')
})

test('png: the header probe reads the size without inflating', () => {
  assert.deepEqual(readPngSize(referencePng), { width: 900, height: 620 })
  assert.equal(readPngSize(Buffer.from('short')), null)
})

test('png: rejects bytes that are not a supported PNG', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /bad signature|too short/u)
  const truncated = referencePng.subarray(0, 40)
  assert.throws(() => decodePng(truncated), /truncated|missing IHDR|no image data|image data is short/u)
})

test('score: an image against itself is a perfect match', () => {
  assert.equal(scoreRender({ referencePng, renderPng: referencePng }).score, 100)
  const grid = gridOf(decodePng(referencePng))
  assert.equal(grid.length, GRID.columns * GRID.rows * 3)
  assert.equal(gridSimilarity(grid, grid), 100)
})

test('score: a real lane render scores high against its reference', () => {
  const { score } = scoreRender({ referencePng, renderPng })
  assert.ok(score > 90, `expected a strong match, got ${score}`)
  assert.ok(score <= 100)
})

test('score: labels describe the bands without overclaiming', () => {
  assert.match(scoreLabel(96), /near-identical/u)
  assert.match(scoreLabel(88), /close/u)
  assert.match(scoreLabel(72), /recognisable/u)
  assert.match(scoreLabel(55), /same idea/u)
  assert.match(scoreLabel(20), /different page/u)
  assert.match(scoreLabel(null), /not scored/u)
})

test('render: browser detection never throws and caches its answer', async () => {
  resetRendererCache()
  const run = async () => ({ code: 1, stdout: '', stderr: '' })
  assert.equal(await detectRenderer(run), null)
  assert.equal(await detectRenderer(run), null, 'the second call reuses the cached miss')
})

// ── engine ─────────────────────────────────────────────────────────────────

const realFs = { cp, copyFile, mkdir, readFile, readdir, rm, stat, symlink, writeFile }

/** Build a fake Harness around the engine: no git, one file per lane. */
function fakeDeps(workspace, { imagePath, laneBuilder, failLanes = [] }) {
  const children = new Map()
  return {
    children,
    deps: {
      now: () => Date.now(),
      id: () => 'abcd1234',
      fs: realFs,
      git: async () => ({ code: 1, stdout: '', stderr: 'not a repository' }),
      spawnAgent: async ({ cwd, prompt, label }) => {
        const childId = `child-${label}`
        const child = { cwd, prompt, label, disposed: false }
        children.set(childId, child)
        if (failLanes.includes(label)) {
          return { childId, result: Promise.reject(new Error('builder exploded')), dispose: async () => {} }
        }
        await laneBuilder(cwd, label)
        return {
          childId,
          result: Promise.resolve({ output: [{ type: 'text', text: `${label} done` }], stopReason: 'completed' }),
          dispose: async () => { child.disposed = true },
        }
      },
      interruptAgent: ({ childId }) => { children.delete(childId) },
      getAgent: () => undefined,
      resolveReference: async () => ({ path: imagePath, mediaType: 'image/png', extension: '.png', label: 'ref.png' }),
      workingDirectory: { ensure: async () => workspace },
      logger: { warn: () => {} },
      config: { viewport: '1280x800' },
    },
  }
}

test('engine: start, settle, snapshot and adopt a lane end to end', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-clone-ws-'))
  const images = await mkdtemp(join(tmpdir(), 'dsh-clone-img-'))
  const imagePath = join(images, 'mock.png')
  await writeFile(imagePath, 'png-bytes')

  try {
    const { deps, children } = fakeDeps(workspace, {
      imagePath,
      laneBuilder: async (cwd) => {
        await writeFile(join(cwd, 'index.html'), '<!doctype html><title>clone</title>')
        await mkdir(join(cwd, 'assets'), { recursive: true })
        await writeFile(join(cwd, 'assets', 'app.css'), 'body{margin:0}')
      },
    })
    const engine = new CloneEngine(deps)

    const clone = await engine.start({ agent: { id: 's1' }, sessionId: 's1', lanes: 2, note: 'pricing page', viewport: '1280x800' })
    assert.equal(clone.lanes.length, 2)
    assert.equal(children.size, 2)
    assert.equal(clone.reference.path.endsWith('reference.png'), true)

    await waitFor(() => clone.status === 'finished')
    assert.equal(clone.lanes.every((lane) => lane.status === 'settled'), true)
    assert.equal(clone.winner, 0)

    const snapshot = engine.snapshot(clone)
    assert.equal(snapshot.lanes.length, 2)
    assert.equal(snapshot.lanes[0].files, 2)
    assert.equal(snapshot.lanes[0].delivered, true)
    assert.equal(snapshot.lanes[0].previewUrl, '/api/dsh-clone/preview/abcd1234/1/')
    assert.equal(snapshot.reference.url, '/api/dsh-clone/reference?cloneId=abcd1234')
    assert.equal(snapshot.summary.done, 2)

    // Live counters stay harmless without live agents.
    engine.tick()

    const picked = await engine.pick({ cloneId: clone.id, laneNumber: 2 })
    assert.equal(picked.lane.index, 1)
    const copied = await readdir(picked.path)
    assert.deepEqual(copied.sort(), ['assets', 'index.html'])
    assert.equal(await readFile(join(picked.path, 'index.html'), 'utf8'), '<!doctype html><title>clone</title>')

    // Adopting twice is idempotent, not a second copy.
    const again = await engine.pick({ cloneId: clone.id, laneNumber: 1 })
    assert.equal(again.path, picked.path)
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(images, { recursive: true, force: true })
  }
})

test('engine: auto viewport follows the reference image size', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-clone-ws-'))
  const images = await mkdtemp(join(tmpdir(), 'dsh-clone-img-'))
  const imagePath = join(images, 'mock.png')
  await writeFile(imagePath, referencePng)
  try {
    const { deps } = fakeDeps(workspace, {
      imagePath,
      laneBuilder: async (cwd) => { await writeFile(join(cwd, 'index.html'), 'ok') },
    })
    const engine = new CloneEngine(deps)
    const auto = await engine.start({ agent: { id: 's1' }, sessionId: 's1', lanes: 1, note: '', viewport: 'auto' })
    assert.equal(auto.viewport, '900x620', 'the reference is 900x620, so the lanes build and render at that size')

    const forced = await engine.start({ agent: { id: 's1' }, sessionId: 's1', lanes: 1, note: '', viewport: '1440x900' })
    assert.equal(forced.viewport, '1440x900', 'an explicit viewport wins')
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(images, { recursive: true, force: true })
  }
})

test('engine: a failed lane does not stop the others', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-clone-ws-'))
  const images = await mkdtemp(join(tmpdir(), 'dsh-clone-img-'))
  const imagePath = join(images, 'mock.png')
  await writeFile(imagePath, 'png-bytes')

  try {
    const { deps } = fakeDeps(workspace, {
      imagePath,
      laneBuilder: async (cwd) => { await writeFile(join(cwd, 'index.html'), 'ok') },
      failLanes: ['clone lane 1'],
    })
    const engine = new CloneEngine(deps)
    const clone = await engine.start({ agent: { id: 's1' }, sessionId: 's1', lanes: 2, note: '', viewport: '1280x800' })
    await waitFor(() => clone.status === 'finished')

    assert.equal(clone.lanes[0].status, 'failed')
    assert.match(clone.lanes[0].error, /builder exploded/u)
    assert.equal(clone.lanes[1].status, 'settled')
    assert.equal(clone.winner, 1)
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(images, { recursive: true, force: true })
  }
})

test('engine: missing reference is a clear error, not a crash', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-clone-ws-'))
  try {
    const { deps } = fakeDeps(workspace, { imagePath: '/nonexistent.png', laneBuilder: async () => {} })
    deps.resolveReference = async () => null
    const engine = new CloneEngine(deps)
    await assert.rejects(
      () => engine.start({ agent: { id: 's1' }, sessionId: 's1', lanes: 1, note: '', viewport: '1280x800' }),
      /no reference screenshot/u,
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('engine: the lane time limit settles a builder that never finishes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-clone-ws-'))
  const images = await mkdtemp(join(tmpdir(), 'dsh-clone-img-'))
  const imagePath = join(images, 'mock.png')
  await writeFile(imagePath, 'png-bytes')

  try {
    let interrupted = 0
    const { deps } = fakeDeps(workspace, {
      imagePath,
      // Writes its page, then never settles: exactly the "keeps polishing" case.
      laneBuilder: async (cwd) => { await writeFile(join(cwd, 'index.html'), '<!doctype html>ok') },
    })
    deps.config = { viewport: '900x620', laneTimeoutMs: 120 }
    deps.spawnAgent = async ({ cwd, label }) => {
      await writeFile(join(cwd, 'index.html'), '<!doctype html>ok')
      return { childId: `never-${label}`, result: new Promise(() => {}), dispose: async () => {} }
    }
    deps.interruptAgent = () => { interrupted += 1 }

    const engine = new CloneEngine(deps)
    const clone = await engine.start({ agent: { id: 's1' }, sessionId: 's1', lanes: 2, note: '', viewport: 'auto' })
    await waitFor(() => clone.status === 'finished', { timeoutMs: 5000 })

    assert.equal(clone.lanes.every((lane) => lane.timedOut === true), true)
    assert.equal(clone.lanes.every((lane) => lane.status === 'settled'), true, 'a delivered page survives the limit')
    assert.equal(clone.lanes.every((lane) => lane.stopReason === 'time-limit'), true)
    assert.equal(interrupted, 2, 'both builders were interrupted')
    assert.equal(engine.laneTimers.size, 0, 'no timer leaks after the clone closes')
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(images, { recursive: true, force: true })
  }
})

test('engine: cancel closes every running lane', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-clone-ws-'))
  const images = await mkdtemp(join(tmpdir(), 'dsh-clone-img-'))
  const imagePath = join(images, 'mock.png')
  await writeFile(imagePath, 'png-bytes')

  try {
    const { deps } = fakeDeps(workspace, {
      imagePath,
      // A builder that never settles on its own: only the cancel path can end it.
      laneBuilder: async (cwd) => { await writeFile(join(cwd, 'index.html'), 'ok') },
    })
    deps.getAgent = () => ({ session: { snapshotEvents: () => [] } })
    const engine = new CloneEngine(deps)
    const clone = await engine.start({ agent: { id: 's1' }, sessionId: 's1', lanes: 1, note: '', viewport: '1280x800' })
    await waitFor(() => clone.status === 'finished')

    // Reopen the lane to exercise cancel on live work.
    clone.status = 'running'
    clone.lanes[0].status = 'running'
    await engine.cancel({ cloneId: clone.id })
    assert.equal(clone.lanes[0].status, 'cancelled')
    assert.equal(clone.status, 'finished')
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(images, { recursive: true, force: true })
  }
})

test('engine: discard removes the scratch directory', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-clone-ws-'))
  const images = await mkdtemp(join(tmpdir(), 'dsh-clone-img-'))
  const imagePath = join(images, 'mock.png')
  await writeFile(imagePath, 'png-bytes')

  try {
    const { deps } = fakeDeps(workspace, {
      imagePath,
      laneBuilder: async (cwd) => { await writeFile(join(cwd, 'index.html'), 'ok') },
    })
    const engine = new CloneEngine(deps)
    const clone = await engine.start({ agent: { id: 's1' }, sessionId: 's1', lanes: 1, note: '', viewport: '1280x800' })
    await waitFor(() => clone.status === 'finished')
    await engine.discard({ cloneId: clone.id })
    assert.equal(clone.status, 'discarded')
    assert.equal(await stat(clone.root).then(() => true, () => false), false)
    assert.equal(engine.listForSession('s1').length, 1)
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(images, { recursive: true, force: true })
  }
})

// ── runner ─────────────────────────────────────────────────────────────────

const failures = []
for (const { name, fn } of tests) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  ✗ ${name}`)
    const detail = error instanceof Error
      ? `${error.message}\n    actual:   ${inspect(error.actual)}\n    expected: ${inspect(error.expected)}`
      : inspect(error)
    console.log(`    ${detail.split('\n').join('\n    ')}`)
  }
}

console.log(`\n${passed}/${tests.length} passed`)
if (failures.length > 0) process.exitCode = 1
