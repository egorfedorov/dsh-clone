# Changelog

## 0.1.0 — 2026-11-09

First release.

**Core**

- `/clone [lanes] [note]` starts 1-4 builder agents on the last image in the
  conversation (or an image path in the note), plus `status`, `pick <lane>`,
  `cancel` and `discard`; the same operations are exposed as the `clone` tool.
- Lane isolation: a real `git worktree` on its own branch inside a repository,
  a plain directory otherwise. `node_modules`, `.venv` and `vendor` are shared by
  symlink, and `.dsh-clone/` is added to `.git/info/exclude`.
- Clone panel in the conversation view ring: the reference beside every lane's
  live page, with strategy, timing, tool calls, file count and token spend.
- Adoption copies only deliverable files (no `.git`, no symlinked dependencies,
  no dotted scratch directories) into `clone-<id>-lane-<n>/`.
- Lane pages are served from the page's own origin under a `sandbox` CSP and
  mounted in a `sandbox="allow-scripts"` iframe.

**Scoring**

- Delivered lanes are screenshotted by an installed Chromium-family browser and
  compared with the reference on a coarse colour grid; the highest score
  suggests the winner. No browser means no score, and nothing else changes.
- Viewport defaults to the reference image's own pixel size.
- Per-lane wall-clock limit: a builder that keeps polishing is stopped and its
  finished page is delivered and scored.

**Distribution**

- Format-1 plugin market index (`index.json`), validated with the official
  `parseMarketIndex`, so the plugin installs from a Discover tab without npm.
- Storefront icon (`docs/assets/icon-180.png`), `screenshots.json`, GitHub
  release tarball, and a ready-to-submit awesome-dsh-plugin entry.

**Tests**

- 30 unit tests (grammar, ranking, scoring, PNG decoding, engine lifecycle), a
  real `git worktree` isolation test, and a render-and-score integration test
  that drives the plugin's own scoring path.
