/**
 * Import audit for the shipped ES modules.
 *
 * A reference to a helper that is used but never imported does not fail until
 * the code path runs — and several paths (scoring, inspection) only run inside a
 * live session, behind a `catch` that swallows the ReferenceError. That exact
 * mistake shipped once: `detectRenderer` and `scoreRender` were dropped during a
 * refactor and the runtime inspection silently reported "unavailable" forever.
 *
 * This test walks every exported lib symbol and fails when a module uses one
 * without importing or defining it.
 *
 *   node test/imports.mjs
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const source = await readFile(join(root, 'index.js'), 'utf8')

/** Every symbol the lib modules export. */
const exported = new Set()
for (const file of await readdir(join(root, 'lib'))) {
  if (!file.endsWith('.js')) continue
  const text = await readFile(join(root, 'lib', file), 'utf8')
  for (const match of text.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_]+)/gu)) exported.add(match[1])
  for (const match of text.matchAll(/export\s+\{([^}]+)\}/gu)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/u).pop()
      if (/^[A-Za-z0-9_]+$/u.test(name)) exported.add(name)
    }
  }
}

/** Names index.js imports. */
const imported = new Set()
for (const match of source.matchAll(/^import\s+\{([^}]+)\}\s+from/gmu)) {
  for (const part of match[1].split(',')) imported.add(part.trim().split(/\s+as\s+/u).pop())
}

const escapes = (name) => `${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`
// A bare name in key position (`dynamicChecks: true`) is a config key, not a call.
const used = (name) => new RegExp(`(^|[^A-Za-z0-9_.$])${escapes(name)}\\b(?!\\s*:)`, 'u').test(source)
const defined = (name) => new RegExp(`(?:const|let|var|function|class)\\s+${escapes(name)}\\b`, 'u').test(source)

const missing = [...exported].filter((name) => used(name) && !defined(name) && !imported.has(name)).sort()

if (missing.length > 0) {
  console.error(`  ✗ index.js uses ${missing.length} lib symbol(s) without importing them: ${missing.join(', ')}`)
  process.exitCode = 1
} else {
  console.log(`  ✓ index.js imports every one of the ${exported.size} lib symbols it uses`)
}
