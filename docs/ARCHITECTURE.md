# Architecture

`dsh-clone` is one bundle with two halves and one state machine between them.

```
Browser (client.js)                     Host process (index.js + lib/*)
────────────────────                    ──────────────────────────────
conversation.view  ── GET state ─────▶  /api/dsh-clone/state
  Clone panel      ── GET image ─────▶  /api/dsh-clone/reference
                   ── iframe src ────▶  /api/dsh-clone/preview/<id>/<lane>/
                   ── POST action ───▶  /api/dsh-clone/action
                                          │
                                          ▼
                                     CloneEngine (lib/engine.js)
                                          │
                       ┌──────────────────┼───────────────────┐
                       ▼                  ▼                   ▼
                  filesystem            git              ctx.subagents
                 (lane dirs)         (worktrees)        (builder agents)
```

## Why the split looks like this

**The engine has no imports from the Harness.** `lib/engine.js` takes every side
effect as a dependency (`fs`, `git`, `spawnAgent`, `interruptAgent`, `getAgent`,
`resolveReference`, `workingDirectory`). `index.js` binds those to real Harness
services. The consequence is that `test/smoke.mjs` drives the complete lifecycle
— start, settle, fail, cancel, adopt, discard — against a temporary directory
with fake subagents, with no Harness and no model in the loop.

**The panel reads JSON, not session events.** Clone state is plugin-owned and
short-lived; it does not belong in the session log. Every surface polls one tiny
feed (`/api/dsh-clone/state`) through a single shared poller, so a transcript
with many mounted chips still makes one request.

**Previews are same-origin but sandboxed.** Lane pages are served by the Host's
own `webServer` route, which means no second port and no proxy. Because the HTML
is model-written, every response carries a `sandbox` CSP without
`allow-same-origin`, and the client mounts it with `sandbox="allow-scripts"`.
The page can animate and run its own code; it cannot reach cookies, storage, or
the JSON API.

## Lifecycle invariants

1. **A clone only closes when every lane is terminal** (`settled`, `empty`,
   `failed`, `cancelled`). Lanes launch one at a time, so a lane can fail before
   later lanes exist; `clone.starting` latches the close until the launch loop
   finishes.
2. **A lane is adoptable only when it produced `index.html`.** Completeness is
   the only objective fact available without a renderer, so it is the only gate.
3. **The suggested winner is a default, never a judgement.** Delivered lanes
   first, earliest finish next. The reader may adopt any lane.
4. **Adoption is idempotent.** A second `pick` returns the first result instead
   of copying again.
5. **Scratch is disposable.** `/clone discard` removes lane directories, lane
   branches, and the clone root; adopted output lives outside all of that and
   survives.

## Isolation model

| Workspace | Lane directory | Cleanup |
|---|---|---|
| git repository | `git worktree` on branch `dsh-clone/<id>-lane-<n>` | `worktree remove --force` + `branch -D` |
| anything else | plain directory `.dsh-clone/<id>/lane-<n>/` | `rm -rf` of the clone root |

`node_modules`, `.venv` and `vendor` are symlinked from the workspace into each
lane when present, so a lane never reinstalls dependencies. `.dsh-clone/` is
added to `.git/info/exclude` so scratch work never shows up in `git status`.

## Request surface

| Route | Method | Purpose |
|---|---|---|
| `/api/dsh-clone/state` | GET | newest clones for one session (`?sessionId=`), or one (`?cloneId=`) |
| `/api/dsh-clone/reference` | GET | the copied reference image |
| `/api/dsh-clone/preview/<id>/<lane>/<path>` | GET | one lane's static files, sandboxed |
| `/api/dsh-clone/action` | POST | `pick`, `cancel`, `discard` |

Every route applies `ctx.connection.requestRejection()` when that service is
present, so the feed follows the same trust fence as the shipped routes.

## Failure behaviour

- A builder that throws marks **its lane** failed; the clone continues.
- `ctx.subagents.startActivation` failing during preparation is caught per lane.
- Inventory failures degrade to an empty file list, never to a crash.
- Every poller tick and every route handler is wrapped: a defect costs one
  refresh, not the page.
