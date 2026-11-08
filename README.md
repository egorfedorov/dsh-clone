# dsh-clone

**Screenshot in. Working UI out.**

Paste a screenshot of any interface, run `/clone 3`, and three agents rebuild it in parallel — each in its own isolated directory. A live panel shows the reference next to every attempt. You adopt the one you like, and it is already a working page.

> A DeepSeek Harness plugin. `dsh-clone` is the missing loop between "here is what I want it to look like" and "here is the code that looks like it".

---

## Why this exists

A screenshot is the most precise specification a person can give. Every other input loses information: a paragraph of text drops the spacing rhythm, the type scale, the alignment of every block; a component list drops the picture.

The usual flow is still: describe it, get one attempt, describe the differences, get another attempt. One attempt is a lottery — you cannot tell whether the model misunderstood you or simply chose a different solution, because you only ever see one.

`dsh-clone` changes the cost of being wrong. Three or four builders see the same reference and work the same problem from different angles (measure first / structure first / visual first / component first). You compare finished pages, not promises, and keep the best.

```
  you paste a screenshot
            │
            ▼
   /clone 3 "dark variant"
            │
   ┌────────┼─────────┐
   ▼        ▼         ▼
 lane 1   lane 2    lane 3        ← 3 agents, 3 isolated directories
 measure  structure visual
   │        │         │
   └────────┼─────────┘
            ▼
  reference ─┬─ lane 1 ─┬─ lane 2 ─┬─ lane 3     ← live, side by side
             │          │          │
            [ Adopt this one ]
                       │
                       ▼
        ./clone-ab12cd34-lane-2/   ← working page, ready to open
```

## Install

**In the Harness Web UI** — Settings → Plugins, and install the bundle by package name or from this directory:

```
dsh-clone
```

**From a checkout** (development):

```bash
git clone https://github.com/egorfedorov/dsh-clone
# then: Settings → Plugins → Install bundle → /absolute/path/to/dsh-clone
```

Requires a DeepSeek Harness profile with `subagents` (the `dsh-base` bundle ships the `spawn` backend). Node 20+.

## Usage

Paste a screenshot into the conversation, then:

| Command | What it does |
|---|---|
| `/clone` | 3 lanes rebuild the last image in this conversation |
| `/clone 4` | four lanes — maximal spread of approaches |
| `/clone 2 darker, mobile-first` | two lanes plus a note every builder must honour |
| `/clone 3 ./mock.png` | use an explicit image path instead of the conversation image |
| `/clone status` | lane states, timings, and the suggested winner |
| `/clone pick 2` | adopt lane 2 into the workspace |
| `/clone cancel` | stop the builders |
| `/clone discard` | delete the scratch directories and lane branches |

The agent has the same operations as a tool, so you can also just say *"rebuild this screenshot, three tries"*:

```
clone({ action: "start", lanes: 3, note: "keep the sidebar" })
clone({ action: "status" })
clone({ action: "pick", lane: 2 })
```

### The panel

A **Clone** tab appears in the conversation view ring while a clone exists:

- the reference screenshot, at a glance, with the viewport you asked for;
- one card per lane: a live iframe of the actual page, its strategy, elapsed time, tool calls, file count, token spend;
- **Adopt this one** on any lane that produced an `index.html`;
- the suggested lane is marked once everything settles.

A small chip under the composer shows `clone · 2/3` while builders run, so you can leave the tab.

## How it works

**Isolation.** Each lane gets its own directory. Inside a git repository that is a real `git worktree` on its own branch (`dsh-clone/<id>-lane-<n>`), so nothing leaks between attempts and nothing touches your working tree. Outside a repository it is a plain directory under `.dsh-clone/<id>/lane-<n>/`. Existing `node_modules`, `.venv` and `vendor` are symlinked into each lane instead of reinstalled.

**The builders.** Each lane is a subagent with one job: read the reference image, then ship `index.html` plus any local CSS/JS/assets. The delivery contract is the same for every lane and non-negotiable: no build step, no network at runtime, no CDN, no placeholder copy, fill the viewport, approximate every image with CSS/SVG. The strategies differ — that is what makes the set worth comparing.

**The preview.** Lane pages are served from this page's own origin through `/api/dsh-clone/preview/<clone>/<lane>/`, which means no extra port, no proxy, and the same authenticated connection the UI already uses. Because the HTML is model-written, it is served with a `sandbox` CSP (no `allow-same-origin`) and mounted in a `sandbox="allow-scripts"` iframe: a clone can run its own code, but it cannot read your cookies, storage, or this app's API.

**Adoption.** `pick` copies the chosen lane into the workspace as `clone-<id>-lane-<n>/`, without `.git` and without the symlinked dependency directories. The other lanes stay where they are until you `/clone discard`.

## Configuration

All optional; the defaults are the intended experience.

| Key | Default | Meaning |
|---|---|---|
| `lanes` | `3` | lane count when the command does not name one |
| `maxLanes` | `4` | hard cap on lanes per clone |
| `viewport` | `1280x800` | target viewport written into every builder prompt |
| `provider` | `spawn` | `ctx.subagents` backend used for builders |
| `pollMs` | `900` | live counter refresh interval |
| `commandName` | `clone` | rename the slash command |
| `command` / `tool` | `true` | disable either entry point |

```yaml
- id: dsh-clone
  name: dsh-clone
  config:
    lanes: 4
    viewport: 1440x900
```

## Safety

- Clones are **static pages**: no package installs, no network at runtime, no server.
- Lane pages are sandboxed into an opaque origin, so model-written HTML cannot reach your session, your credentials, or the Harness API.
- Every write happens inside the workspace: `.dsh-clone/` for scratch, `clone-*/` for adopted results, plus lane branches in your repository (removed by `/clone discard`).
- `git worktree` is used read-only against your checkout: no commit, no checkout, no reset in your working tree.

## Honest limits

- **Cost is N×.** Three builders cost roughly three builds. `lanes: 2` is a reasonable everyday setting; `lanes: 1` makes it a plain "screenshot → page" button.
- **You are the judge.** dsh-clone ranks by completeness and finish time, and it says so. It does not invent a pixel-similarity score: a real one needs a headless renderer, which is roadmap work, not a claim.
- **Vision is required.** The builder must actually see the reference. A text-only model produces a guess; pair dsh-clone with a vision-capable route or a vision bridge plugin.
- **Images are approximated.** Without image generation, photos and illustrations become CSS/SVG stand-ins with the right silhouette and palette, not the original pixels.
- **Static output.** No Next.js project, no design system — by design, so the result is always runnable in one click.
- **Fidelity is bounded by the model.** This tool makes a good attempt cheap to obtain and easy to compare; it does not make any model a pixel-perfect design tool.

## Roadmap

1. **Pixel-diff judging** — render each lane at the reference viewport, score structural similarity, and rank objectively; falls back to the current human pick.
2. **Iterate on the winner** — `/clone refine 2 "move the CTA up"` re-opens the adopted lane against the same reference.
3. **Reference regions** — point at a component ("clone just this card") instead of a whole page.
4. **Adopt as a diff** — when the workspace is a component library, adopt as an edit to the existing file instead of a new folder.
5. **Lane budgets** — a token ceiling per lane, so a runaway builder cannot eat the month.

## Repository layout

```
index.js            Host half: /clone command, clone tool, web routes, poller
client.js           Client half: the Clone panel and the composer chip
lib/engine.js       Clone state machine (pure, dependency-injected)
lib/prompts.js      The delivery contract and the four lane strategies
lib/parse.js        /clone grammar
lib/rank.js         Adoptability, ordering, suggestion
lib/preview.js      Static lane serving, media types, sandbox CSP, JSON routes
lib/util.js         Small pure helpers
test/smoke.mjs      19 tests, no Harness required
docs/ARCHITECTURE.md
ACCEPTABLE-USE.md
```

## Development

```bash
npm run check   # syntax-check every shipped file
npm test        # 19 assertions: grammar, ranking, prompts, full engine lifecycle
```

The engine takes every side effect as a dependency, so the tests drive the real state machine against a temporary directory with fake subagents — no Harness, no network, no model.

## По-русски

Плагин для DeepSeek Harness: скидываешь скриншот интерфейса, пишешь `/clone 3` — три агента параллельно собирают его в изолированных папках (в репозитории — через git worktree). В панели «Clone» видно эталон и все попытки рядом, каждая уже живая. Нажимаешь «Adopt this one» — выбранный вариант копируется в рабочую папку как готовая страница. Остальные удаляются командой `/clone discard`.

Честно: стоимость — примерно N попыток; судья — вы, автоматической оценки пиксельного совпадения в этой версии нет; нужна модель, которая видит картинку.

## License

MIT — see [LICENSE](LICENSE). Use it on interfaces you have the right to rebuild; see [ACCEPTABLE-USE.md](ACCEPTABLE-USE.md).
