/**
 * dsh-clone git-lane test — the isolation path, against a real repository.
 *
 * `test/smoke.mjs` runs the engine in a plain directory. This one runs the
 * same engine inside an actual git repository (created in a temp folder), so
 * the worktree branch of the isolation model is exercised for real:
 *
 *   - `.dsh-clone/` is hidden from the repository's status
 *   - each lane is a real worktree on its own branch at the base commit
 *   - shared dependency directories are symlinked, not reinstalled
 *   - discard removes worktrees and branches without touching the checkout
 *
 * The builder is faked, so this needs no model and costs no tokens.
 *
 *   node test/git-lane.mjs      (or: npm run test:git)
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, stat, symlink, cp, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CloneEngine } from '../lib/engine.js'

const run = promisify(execFile)
const realFs = { cp, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile }

const git = async (args, cwd) => {
  try {
    const { stdout, stderr } = await run('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) }
  }
}

const hasGit = await git(['--version'], process.cwd()).then((result) => result.code === 0)
if (!hasGit) {
  console.log('  – skipped: git is not available on PATH')
  process.exit(0)
}

const root = await mkdtemp(join(tmpdir(), 'dsh-clone-git-'))
const workspace = join(root, 'repo')
const images = join(root, 'img')
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
  // ── a repository with one commit, a lockfile-ish layout and node_modules ──
  await mkdir(workspace, { recursive: true })
  await mkdir(images, { recursive: true })
  await mkdir(join(workspace, 'node_modules', 'fake-dep'), { recursive: true })
  await writeFile(join(workspace, 'node_modules', 'fake-dep', 'index.js'), 'module.exports = 1\n')
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node -e 0' } }, null, 2))
  await writeFile(join(workspace, 'README.md'), '# demo\n')
  await writeFile(join(workspace, '.gitignore'), 'node_modules/\n')
  await git(['init', '-q', '-b', 'main'], workspace)
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], workspace)
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], workspace)
  await writeFile(join(workspace, 'README.md'), '# demo\n\ndirty working tree\n')

  const reference = join(images, 'ref.png')
  await writeFile(reference, 'png')

  const built = []
  const engine = new CloneEngine({
    now: () => Date.now(),
    id: () => 'beef1234',
    fs: realFs,
    git,
    spawnAgent: async ({ cwd, label }) => {
      built.push({ cwd, label })
      await writeFile(join(cwd, 'index.html'), '<!doctype html><title>lane</title>')
      return {
        childId: `child-${label}`,
        result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
    interruptAgent: () => {},
    getAgent: () => undefined,
    resolveReference: async () => ({ path: reference, mediaType: 'image/png', extension: '.png', label: 'ref.png' }),
    workingDirectory: { ensure: async () => workspace },
    logger: { warn: () => {} },
    config: { viewport: '1280x800' },
  })

  const clone = await engine.start({ agent: { id: 's1' }, sessionId: 's1', lanes: 2, note: '', viewport: '1280x800' })
  const waitFor = async (predicate, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    throw new Error('timed out waiting for the lanes to settle')
  }
  await waitFor(() => clone.status === 'finished')

  await check('the workspace is recognised as a repository', async () => {
    assert.notEqual(clone.repo, null)
    assert.equal(clone.repo.root, await realpath(workspace))
    assert.equal(clone.workspace, await realpath(workspace), 'the workspace is stored canonically')
  })

  await check('every lane is a worktree on its own branch', async () => {
    const list = await git(['worktree', 'list', '--porcelain'], workspace)
    assert.equal(list.code, 0)
    const canonical = await realpath(workspace)
    const paths = list.stdout.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9))
    for (const lane of clone.lanes) {
      assert.ok(paths.includes(lane.dir), `lane ${lane.index + 1} is not a registered worktree`)
      const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], lane.dir)
      assert.equal(branch.stdout.trim(), lane.branch)
      assert.match(lane.branch, /^dsh-clone\/beef1234-lane-\d$/u)
    }
    const branches = await git(['branch', '--list', 'dsh-clone/*'], workspace)
    assert.equal(branches.stdout.trim().split('\n').length, 2)
  })

  await check('every lane sits on the base commit with its own index', async () => {
    for (const lane of clone.lanes) {
      const head = await git(['rev-parse', 'HEAD'], lane.dir)
      assert.equal(head.stdout.trim(), clone.repo.base)
      assert.equal(await readFile(join(lane.dir, 'index.html'), 'utf8'), '<!doctype html><title>lane</title>')
    }
  })

  await check('dependency directories are shared by symlink, not reinstalled', async () => {
    for (const lane of clone.lanes) {
      const stats = await lstat(join(lane.dir, 'node_modules'))
      assert.equal(stats.isSymbolicLink(), true)
      assert.equal(await readFile(join(lane.dir, 'node_modules', 'fake-dep', 'index.js'), 'utf8'), 'module.exports = 1\n')
    }
  })

  await check('the scratch directory never appears in the repository status', async () => {
    const status = await git(['status', '--porcelain'], workspace)
    assert.match(status.stdout, /README\.md/u, 'the dirty file is still reported')
    assert.doesNotMatch(status.stdout, /\.dsh-clone/u)
    const exclude = await readFile(join(workspace, '.git', 'info', 'exclude'), 'utf8')
    assert.match(exclude, /\.dsh-clone/u)
  })

  await check('the user working tree is untouched by lane work', async () => {
    assert.equal(await readFile(join(workspace, 'README.md'), 'utf8'), '# demo\n\ndirty working tree\n')
    assert.equal(await stat(join(workspace, 'index.html')).then(() => true, () => false), false)
    const current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace)
    assert.equal(current.stdout.trim(), 'main')
  })

  await check('adoption copies the chosen lane into the workspace', async () => {
    const picked = await engine.pick({ cloneId: clone.id, laneNumber: 2 })
    assert.equal(picked.lane.index, 1)
    assert.equal(await readFile(join(picked.path, 'index.html'), 'utf8'), '<!doctype html><title>lane</title>')
    assert.equal(await stat(join(picked.path, 'node_modules')).then(() => true, () => false), false, 'symlinks stay out of the adopted copy')
  })

  await check('discard removes worktrees and branches, keeps the adopted copy', async () => {
    const adopted = join(workspace, `clone-${clone.id}-lane-2`)
    await engine.discard({ cloneId: clone.id })
    assert.equal(clone.status, 'discarded')
    assert.equal(await stat(clone.root).then(() => true, () => false), false)
    const list = await git(['worktree', 'list', '--porcelain'], workspace)
    const paths = list.stdout.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9))
    assert.deepEqual(paths, [await realpath(workspace)], 'only the main checkout remains')
    const branches = await git(['branch', '--list', 'dsh-clone/*'], workspace)
    assert.equal(branches.stdout.trim(), '')
    assert.equal(await stat(join(adopted, 'index.html')).then(() => true, () => false), true, 'the adopted result survives')
  })
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\ngit lane model verified' : `\n${failures} check(s) failed`)
if (failures > 0) process.exitCode = 1
