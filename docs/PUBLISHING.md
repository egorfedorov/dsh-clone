# Publishing and distribution

How `dsh-clone` reaches users, what each channel actually requires, and which
steps need a human. Written after reading the real contracts, not from memory:
the [awesome-dsh-plugin contributing guide](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md),
the `@deepseek-ai/dsh-plugin-market` README, and the format-1 index validator
(`@deepseek-ai/dsh-plugin-market-index`).

## The channels, in order of leverage

| Channel | What it gives you | Who has to act |
|---|---|---|
| **npm** | install by package name, download counts, `update-available` in the market | you: `npm login` then `npm publish` |
| **awesome-dsh-plugin** | a row in the canonical list (23.7k ★) · powers `dsh-market` storefronts | you: open one PR after the repo is 1 day old |
| **Custom plugin indexes** | install from a Discover tab without npm | already done: `index.json` in this repo |
| **Official plugin program** | token grants, technical contact, promotion | you: the form in the launch post |
| **GitHub Release tarball** | install without npm and without a build | already done: attached to `v0.1.0` |

A plugin is "officially listed" through the chain: publish → get on the awesome
list → storefronts (`dsh-market`, and later the official marketplace) read that
list. Nothing here needs a secret handshake; the gates are mechanical.

## 1. npm — makes install and update work

This is the step that makes `dsh-clone` installable by name and updatable.

```bash
cd dsh-clone
npm login                     # interactive; a granular token with publish rights also works
npm publish --access public   # package.json already sets publishConfig.access
```

Verification after the first publish:

```bash
npm view dsh-clone version dist.tarball
npx --yes dsh-clone --help || true   # the package is a plugin, not a CLI: a "no bin" message is expected
```

Notes that matter for this package:

- `repository` in `package.json` points back at this repository. The market
  links the two through that field alone, and refuses a package that claims a
  repository which has not claimed the package.
- Nothing here imports `@deepseek-ai/*`, so there are no `peerDependencies`
  ranges to get wrong — the plugin receives every service through Cordis.
- Prebuilt npm installs skip the `allowBuilds` approval step that Git installs
  trigger.
- **Updating**: the market reports `update-available` when a newer compatible
  version exists, but "no upgrade" is a deliberate limitation of the market
  format — the actual upgrade is uninstall followed by install. `dsh-clone`
  keeps its state in the workspace (`.dsh-clone/`, `clone-*/`), so a reinstall
  loses nothing.

## 2. awesome-dsh-plugin — the list everything reads

One PR, one file. The entry is already written and committed here at
[`docs/storefront/egorfedorov__dsh-clone.yml`](storefront/egorfedorov__dsh-clone.yml);
copy it to `data/plugins/egorfedorov__dsh-clone.yml` in the list's repository.

```bash
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
cp /path/to/dsh-clone/docs/storefront/egorfedorov__dsh-clone.yml \
   data/plugins/egorfedorov__dsh-clone.yml
git checkout -b add-dsh-clone
git add data/plugins/egorfedorov__dsh-clone.yml
git commit -m "Add egorfedorov/dsh-clone"
git push -u origin add-dsh-clone
gh pr create --title "Add egorfedorov/dsh-clone" --body "$(cat <<'BODY'
Adds dsh-clone: rebuilds a reference screenshot as working UI by running agents
in parallel git worktrees, rendering each result and scoring it against the
reference.

- `dsh.bundle` is declared in package.json; `cordis.patch.yml` inserts one row
- 30 unit tests, a git-worktree isolation test and a render-and-score test
- MIT, live demo: https://egorfedorov.github.io/dsh-clone/
BODY
)"
```

Requirements from their guide, checked against this repository:

| Requirement | Status |
|---|---|
| `dsh.bundle` manifest + `cordis.patch.yml` | ✅ (`dsh.client` alone is the most common rejection) |
| Real working code, not a placeholder | ✅ |
| Repository at least **1 day old** | ⏳ created 2026-11-08 16:05 UTC — open the PR after 2026-11-09 16:05 UTC |
| `dsh-plugin` topic on the repo | ✅ |
| Description states what it does, no superlatives | ✅ one line, checked against the code |
| At most 3 entries per PR | ✅ one |
| Square GitHub-hosted raster icon | ✅ `docs/assets/icon-180.png` (SVG is refused) |
| `screenshots.json` in the repo root | ✅ four real images |

Their CI checks repo age automatically. Opening the PR before the day passes is
not fatal — the verdict is a snapshot and re-runs — but it costs a maintainer a
re-read, so wait the day.

## 3. Custom plugin indexes — install from the Discover tab, no npm needed

`index.json` in this repository is a format-1 market index, validated with the
official `parseMarketIndex`. Any user who enables **Plugins → Custom plugin
indexes** (the "Adds a Discover tab…" toggle in the screenshot) can add:

```
https://raw.githubusercontent.com/egorfedorov/dsh-clone/main/index.json
```

and install `dsh-clone` from Discover in one click. The entry currently pins a
Git commit, so it works before npm publication; after publishing, switch the
version's `source` to `{"type":"npm"}` so installs get `dsh-clone@0.1.0` and
download counts.

Re-validate the index after any edit — the schema is strict:

```bash
node -e "
import('@deepseek-ai/dsh-plugin-market-index').then(async (m) => {
  const fs = await import('node:fs/promises')
  const url = 'https://raw.githubusercontent.com/egorfedorov/dsh-clone/main/index.json'
  const doc = JSON.parse(await fs.readFile('index.json', 'utf8'))
  const index = m.parseMarketIndex(doc, url)
  console.log('valid:', index.plugins.map((p) => p.name).join(', '))
})
"
```

## 4. The official plugin program

The launch post ("Growing Together with Our Plugin Community") describes a
marketplace plus a support program with token grants, technical discussions and
promotion, and asks authors to fill in a form as an expression of interest:

<https://trtgsjkv6r.feishu.cn/share/base/form/shrcnkRrxNyri4bOF9n48BIYWbb>

Rules and support details are announced when the program launches. Filling it in
is a human step — the form needs your identity and contact, and it asks what your
plugin does and what you need. The strongest parts of this submission are the
live scored demo and the honest-limits section; lead with those.

## 5. GitHub Release tarball — install without npm

```bash
npm pack                                   # dsh-clone-0.1.0.tgz
gh release create v0.1.0 dsh-clone-0.1.0.tgz \
  --title "dsh-clone 0.1.0" \
  --notes-file CHANGELOG-0.1.0.md
```

The asset name is deliberately version-free in the awesome entry's `tarball:`
field (`latest/download/dsh-clone.tgz`), because `latest/download/` takes the
filename literally — a versioned name would 404 on the next release.

## Status

| Step | State |
|---|---|
| npm account | signed in as `egorfedorov` |
| `npm publish` | **blocked on 2FA** — the publish needs a one-time password (`EOTP`). Either run `npm publish --access public` in a terminal and finish the browser prompt, or supply the 6-digit code for `npm publish --otp=<code>` |
| Market index | live and valid, published `0.2.0` from a pinned git commit; switches to the npm source once the package is on the registry |
| awesome-dsh-plugin PR | **[#13425](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/13425)** open — CI's repo-age gate needs the repository to be 1 day old (2026-11-09 16:05 UTC); the verdict re-runs itself |
| Official program form | copy ready in [storefront/official-program-submission.md](storefront/official-program-submission.md) (EN + 中文); only the account owner can submit it |
| Storefront screenshot of the panel itself | still missing — the four declared images are real plugin outputs, not the panel. Needs a browser session |

## What is still missing

- **The npm one-time password** for the first publish (see the table above).
- **A picture of the Clone panel** for the storefront: the declared screenshots
  are real plugin output, which is honest but not the same thing.
