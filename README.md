<p align="center">
  <img src="docs/assets/hero.png" alt="dsh-clone — screenshot in, working UI out" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-4d6bff?style=flat-square"></a>
  <img alt="DeepSeek Harness plugin" src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-4d6bff?style=flat-square">
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A520-16202f?style=flat-square">
  <a href="https://github.com/egorfedorov/dsh-clone/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/egorfedorov/dsh-clone?style=flat-square&color=4d6bff"></a>
</p>

<h1 align="center">Screenshot in. Working UI out.</h1>

<p align="center">
  Paste a screenshot of any interface. Run <code>/clone 3</code>. Three agents rebuild it in parallel,<br>
  each in its own isolated directory. A live panel shows the reference beside every attempt.<br>
  You adopt the one that looks right — and it is already a working page.
</p>

<p align="center">
  <img src="docs/assets/demo.gif" alt="One run: the reference arrives, three lanes build in parallel, one is adopted into the workspace" width="100%">
  <br>
  <sub>Illustration of one run — the timings and lane states in it are the plugin's own numbers, not a mock.</sub>
</p>

---

## The 30-second version

```
you:  [paste a screenshot]  /clone 3
me:   ▸ three agents, three isolated directories, same reference
      ▸ live panel: reference | lane 1 | lane 2 | lane 3
you:  [Adopt this one]
me:   ▸ ./clone-a91c-lane-2/index.html  ← open it, it runs
```

No build step, no dependencies, no server. The adopted page is plain HTML, CSS and vanilla JS.

## Why this exists

A screenshot is the most precise specification a person can give. Every other input loses information: a paragraph drops the spacing rhythm, the type scale, the alignment of every block; a component list drops the picture.

The usual flow is still: describe it, get one attempt, describe the differences, get another attempt. One attempt is a lottery — you cannot tell whether the model misunderstood you or simply chose a different solution, because you only ever see one.

`dsh-clone` changes the cost of being wrong. Three or four builders see the same reference and work the same problem from different angles. You compare finished pages, not promises, and keep the best.

| Lane strategy | What that builder is told to do |
|---|---|
| **Measure first** | write a layout spec — regions, grid, spacing scale, sampled hex palette, type scale — then build strictly to it |
| **Structure first** | the whole page as semantic HTML first, then style region by region from the outside in |
| **Visual first** | reproduce the picture first — surfaces, type, spacing, silhouette — then add only the behaviour the image implies |
| **Component first** | find the 5-8 reused parts, define each once, compose the page from them |

## Demo

| | |
|---|---|
| **Reference** | <img src="docs/assets/reference.png" alt="reference dashboard" width="420"> |
| **A real run** | see the numbers below — same machine, one command, no retries |

<!-- RUN-TABLE -->

## Install

**In the Harness Web UI** — Settings → Plugins, then install the bundle by package name, or from a checkout directory:

```
dsh-clone
```

**From a checkout** (development):

```bash
git clone https://github.com/egorfedorov/dsh-clone
# Settings → Plugins → Install bundle → /absolute/path/to/dsh-clone
```

Requires a DeepSeek Harness profile with `subagents` (the `dsh-base` bundle ships the `spawn` backend) and Node 20+.

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

- the reference screenshot on the left, with the viewport you asked for;
- one card per lane: a live iframe of the actual page, its strategy, elapsed time, tool calls, file count, token spend;
- **Adopt this one** on any lane that produced an `index.html`;
- the suggested lane is marked once everything settles.

A small chip under the composer shows `clone · 2/3` while builders run, so you can leave the tab.

## How it works

**Isolation.** Each lane gets its own directory. Inside a git repository that is a real `git worktree` on its own branch (`dsh-clone/<id>-lane-<n>`), so nothing leaks between attempts and nothing touches your working tree. Outside a repository it is a plain directory under `.dsh-clone/<id>/lane-<n>/`. Existing `node_modules`, `.venv` and `vendor` are symlinked into each lane instead of reinstalled.

**The builders.** Each lane is a subagent with one job: read the reference image, then ship `index.html` plus any local CSS/JS/assets. The delivery contract is identical for every lane and non-negotiable:

> no build step · no network at runtime · no CDN · no placeholder copy · fill the viewport · approximate every image with CSS/SVG · leave no scratch files

The strategies differ; the contract does not. That is what makes the set worth comparing.

**The preview.** Lane pages are served from this page's own origin through `/api/dsh-clone/preview/<clone>/<lane>/` — no extra port, no proxy, the same authenticated connection the UI already uses. Because the HTML is model-written, it is served with a `sandbox` CSP (no `allow-same-origin`) and mounted in a `sandbox="allow-scripts"` iframe: a clone can run its own code, but it cannot read your cookies, storage, or this app's API.

**Adoption.** `pick` copies the chosen lane into the workspace as `clone-<id>-lane-<n>/`, without `.git`, without the symlinked dependency directories, and without the builder's scratch files. The other lanes stay where they are until you `/clone discard`.

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
- Lane pages are sandboxed into an opaque origin, so model-written HTML cannot reach your session, credentials, or the Harness API.
- Every write happens inside the workspace: `.dsh-clone/` for scratch, `clone-*/` for adopted results, plus lane branches in your repository (removed by `/clone discard`).
- `git worktree` is used without touching your checkout: no commit, no checkout, no reset in your working tree. `test/git-lane.mjs` asserts exactly that.

## Honest limits

- **Cost is N×.** Three builders cost roughly three builds. `lanes: 2` is a reasonable everyday setting; `lanes: 1` makes it a plain "screenshot → page" button.
- **You are the judge.** dsh-clone ranks by completeness and finish time, and it says so. It does not invent a pixel-similarity score: a real one needs a headless renderer, which is roadmap work, not a claim.
- **Vision is required.** The builder must actually see the reference. A text-only model produces a guess; pair dsh-clone with a vision-capable route or a vision bridge plugin.
- **Images are approximated.** Without image generation, photos and illustrations become CSS/SVG stand-ins with the right silhouette and palette, not the original pixels.
- **Static output.** No Next.js project, no design system — by design, so the result is always runnable in one click.
- **A careful builder is a slow builder.** The lane prompts carry an explicit effort budget (≈20-25 tool calls) because an agent that keeps cropping the screenshot instead of writing the page burns tokens without improving the result. Tune `lanes`, not patience.

## Roadmap

1. **Pixel-diff judging** — render each lane at the reference viewport, score structural similarity, rank objectively; falls back to the human pick.
2. **Iterate on the winner** — `/clone refine 2 "move the CTA up"` re-opens the adopted lane against the same reference.
3. **Reference regions** — "clone just this card" instead of a whole page.
4. **Adopt as a diff** — when the workspace is a component library, adopt as an edit to an existing file instead of a new folder.
5. **Lane budgets** — a token ceiling per lane, so a runaway builder cannot eat the month.

## Repository layout

```
index.js            Host half: /clone command, clone tool, web routes, poller
client.js           Client half: the Clone panel and the composer chip
lib/engine.js       Clone state machine (pure, dependency-injected)
lib/prompts.js      The delivery contract, the effort budget, four strategies
lib/parse.js        /clone grammar
lib/rank.js         Adoptability, ordering, suggestion
lib/preview.js      Static lane serving, media types, sandbox CSP, JSON routes
lib/util.js         Small pure helpers
test/smoke.mjs      19 tests, no Harness required
test/git-lane.mjs   worktree isolation against a real repository
tools/make-demo.py  Regenerates docs/assets/demo.gif from a reference image
docs/ARCHITECTURE.md
ACCEPTABLE-USE.md
```

## Development

```bash
npm run check      # syntax-check every shipped file
npm test           # 19 assertions: grammar, ranking, prompts, full engine lifecycle
npm run test:git   # the git-worktree isolation model against a real repository
npm run test:all   # both
```

The engine takes every side effect as a dependency, so the tests drive the real state machine against a temporary directory with fake subagents — no Harness, no network, no model. `test/git-lane.mjs` goes further and builds a throwaway repository to prove that lanes are real worktrees, that your own dirty working tree and branch are untouched, that dependency directories are shared by symlink, and that discard removes worktrees and branches while the adopted copy survives.

## По-русски

Плагин для DeepSeek Harness: скидываешь скриншот интерфейса, пишешь `/clone 3` — три агента параллельно собирают его в изолированных папках (в репозитории — через git worktree). В панели «Clone» видно эталон и все попытки рядом, каждая уже живая. Нажимаешь «Adopt this one» — выбранный вариант копируется в рабочую папку как готовая страница. Остальные удаляются командой `/clone discard`.

Честно: стоимость — примерно N попыток; судья — вы, автоматической оценки пиксельного совпадения в этой версии нет; нужна модель, которая видит картинку.

## License

MIT — see [LICENSE](LICENSE). Use it on interfaces you have the right to rebuild; see [ACCEPTABLE-USE.md](ACCEPTABLE-USE.md).
