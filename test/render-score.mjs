/**
 * dsh-clone render-and-score integration test.
 *
 * This drives the REAL wiring the plugin uses at runtime — the engine calls the
 * shared `makeScoreLane` dependency, which finds an installed browser,
 * screenshots the lane, decodes both PNGs and compares them — with a fake
 * builder that simply copies the committed demo page into its lane.
 *
 * It proves the part a unit test cannot: that a delivered lane comes back with
 * a score, that the score reaches the snapshot and the render route, and that
 * the winner follows the score. No model is involved.
 *
 *   node test/render-score.mjs     (or: npm run test:score)
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, stat, symlink, cp, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CloneEngine } from '../lib/engine.js'
import { makeScoreLane } from '../lib/score-lane.js'
import { detectRenderer, resetRendererCache } from '../lib/render.js'

const run = promisify(execFile)
const runner = async (argv, cwd, { timeoutMs = 60_000 } = {}) => {
  const shot = argv.find((arg) => arg.includes('--screenshot='))
  try {
    const { stdout, stderr } = await run(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, maxBuffer: 8 << 20 })
    if (shot && process.env.DSH_CLONE_DEBUG) console.log('   chrome ok  ', shot.split('/').pop())
    return { code: 0, stdout, stderr }
  } catch (error) {
    if (shot && process.env.DSH_CLONE_DEBUG) {
      console.log('   chrome FAIL', shot.split('/').pop(), '|', String(error.stderr ?? error).split('\n').filter(Boolean).slice(-1)[0])
    }
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) }
  }
}

resetRendererCache()
const browser = await detectRenderer(runner)
if (browser === null) {
  console.log('  – skipped: no Chromium-family browser on this machine (scoring is optional by design)')
  process.exit(0)
}
console.log(`  browser: ${browser.version} (${browser.command})`)

const realFs = { cp, copyFile, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile }
const workspace = await mkdtemp(join(tmpdir(), 'dsh-clone-score-'))
const demoDir = new URL('../docs/demo/', import.meta.url).pathname
const referencePath = new URL('../docs/assets/reference.png', import.meta.url).pathname
let failures = 0

const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  ✗ ${name}\n    ${String(error?.message ?? error).split('\n').join('\n    ')}`)
  }
}

try {
  const children = new Map()
  const engine = new CloneEngine({
    now: () => Date.now(),
    id: () => 'c0ffee01',
    fs: realFs,
    git: async () => ({ code: 1, stdout: '', stderr: 'not a repository' }),
    spawnAgent: async ({ cwd, label }) => {
      // The two builders differ on purpose: one ships the real demo page, the
      // other ships a deliberate near-miss, so the ranking has something to do.
      const nearMiss = label.endsWith('2')
      const html = await readFile(join(demoDir, 'index.html'), 'utf8')
      await writeFile(join(cwd, 'index.html'), nearMiss ? grayscale(html) : html)
      await copyFile(join(demoDir, 'styles.css'), join(cwd, 'styles.css'))
      children.set(label, true)
      return {
        childId: `child-${label}`,
        result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
    interruptAgent: () => {},
    getAgent: () => undefined,
    resolveReference: async () => ({
      path: referencePath,
      mediaType: 'image/png',
      extension: '.png',
      label: 'reference.png',
    }),
    scoreLane: makeScoreLane(runner),
    workingDirectory: { ensure: async () => workspace },
    logger: { warn: (message) => console.log(`    (warn) ${message}`) },
    config: { laneTimeoutMs: 0 },
  })

  const clone = await engine.start({ agent: { id: 's1' }, sessionId: 's1', lanes: 2, note: '', viewport: 'auto' })
  const deadline = Date.now() + 120_000
  while (clone.status !== 'finished' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  await check('auto viewport came from the reference size', async () => {
    assert.equal(clone.viewport, '900x620')
  })

  await check('both delivered lanes came back with a real score', async () => {
    assert.equal(clone.status, 'finished', 'the clone closed')
    for (const lane of clone.lanes) {
      assert.equal(lane.status, 'settled')
      assert.equal(typeof lane.score, 'number', `lane ${lane.index + 1} has no score`)
      assert.ok(lane.score > 0 && lane.score <= 100, `implausible score ${lane.score}`)
      assert.ok(typeof lane.renderPath === 'string', 'a render was written')
      assert.equal(await stat(lane.renderPath).then(() => true, () => false), true)
    }
  })

  await check('the faithful lane outscores the near-miss', async () => {
    const [faithful, nearMiss] = clone.lanes
    assert.ok(faithful.score > nearMiss.score, `expected ${faithful.score} > ${nearMiss.score}`)
    // The committed demo page was built for 1280x800 while this test renders at
    // the reference's own 900x620, so a perfect score is not expected here — the
    // ordering is what matters, plus a clearly non-noise floor.
    assert.ok(faithful.score > 60, `expected a recognisable match, got ${faithful.score}`)
  })

  await check('the winner follows the score, and the snapshot carries both', async () => {
    assert.equal(clone.winner, 0)
    const snapshot = engine.snapshot(clone)
    assert.equal(snapshot.lanes[0].score, clone.lanes[0].score)
    assert.equal(snapshot.lanes[0].renderUrl, '/api/dsh-clone/render?cloneId=c0ffee01&lane=1')
    assert.equal(snapshot.summary.bestScore, clone.lanes[0].score)
    assert.equal(snapshot.lanes[0].delivered, true)
  })

  await check('the scored render is a valid PNG of the reference size', async () => {
    const bytes = await readFile(clone.lanes[0].renderPath)
    assert.deepEqual([...bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    assert.deepEqual({ width, height }, { width: 900, height: 620 })
  })
} finally {
  await rm(workspace, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nrender + score verified end to end' : `\n${failures} check(s) failed`)
if (failures > 0) process.exitCode = 1

/** A deliberately wrong variant: same layout, no colour. */
function grayscale(html) {
  return html.replace('</head>', '<style>html{filter:grayscale(1) brightness(0.82)}</style></head>')
}
