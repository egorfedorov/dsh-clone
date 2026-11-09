# Changelog

## 0.2.0 — 2026-11-09

Everything in this release is about the plugin being right when it is left alone.

**Scoring is now a real measurement**

- colour comparison forgives a small uniform shift, so a 4px offset is not a
  different design while a misplaced panel still costs real points;
- a separate **structure** term compares where the detail sits (softened edge
  energy, normalised by the reference), so a flat block that happens to average
  to the right colour no longer scores as a faithful rebuild;
- published runs re-measured on the same artifacts: dashboard 91.9%, landing
  91.9%, billing card 97.8%, sign-in 79%. Two unrelated screens now score 24-58%
  instead of ~89%, which is the whole point of having a number.

**The engine survives being interrupted**

- each clone writes `state.json` next to its work; `status` and `pick` restore
  clones from disk after a plugin reload or a restart;
- a lane that was building when the plugin went away keeps whatever it had
  already written, and is reported as interrupted rather than finished;
- unloading the plugin now interrupts its builder agents instead of leaving them
  spending tokens for a result nobody can reach.

**New pass: iterate instead of restarting**

- `/clone refine [lane] [change]` copies the adopted page into a fresh
  single-lane clone and asks for the smallest edit that satisfies one change;
  the reference and viewport are unchanged, so the result reports a score delta.

**Budget**

- `laneTokenBudget` stops a lane that burns past its ceiling and keeps whatever it
  delivered. Off by default: an agent re-sends its context every step, so a naive
  ceiling stops honest builds mid-analysis — set it deliberately as a backstop.

**Robustness**

- a rendered screenshot must decode before it is scored; a truncated capture is
  retried instead of producing a garbage number;
- the renderer finds Chrome/Chromium/Edge/Brave on Windows as well as macOS and
  Linux;
- `status` accepts a `clone_id`, so an older clone stays inspectable.

## 0.1.0 — 2026-11-09

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
