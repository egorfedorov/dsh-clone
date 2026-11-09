# Official plugin program — submission text

The launch post asks authors to fill in an expression-of-interest form:
<https://trtgsjkv6r.feishu.cn/share/base/form/shrcnkRrxNyri4bOF9n48BIYWbb>

Only the account owner can submit it (it asks for your identity and contact).

**Field-by-field answers, matched to the live form, live in
[form-answers.md](form-answers.md) — use that file.** This one holds the longer
prose version of the same material, for the description and the “anything else”
boxes.

**Your details**

- Name: Egor Fedorov
- Email: egorfdrv@gmail.com
- GitHub: <https://github.com/egorfedorov>
- Repository: <https://github.com/egorfedorov/dsh-clone>
- Package: `dsh-clone` (npm and `dsh plugin add`)
- Live demo: <https://egorfedorov.github.io/dsh-clone/>
- Licence: MIT

## English

**What the plugin does**

`dsh-clone` turns a reference screenshot into a working static page. A single
command starts several subagents on the same screen, each in its own isolated
`git worktree`; every delivered page is screenshotted by an installed browser
and compared with the reference by a colour-and-structure score, and you adopt
the result you prefer. A second pass (`refine`) edits the adopted page with one
requested change and reports the score delta.

**Why it exists**

A screenshot is the most precise specification a person can give, but one
attempt is a lottery: you cannot tell whether the model misunderstood you or
chose differently, because you only see one result. Running the same reference
through several strategies at once, and scoring the finished pages instead of
the promises, makes being wrong cheap.

**What is already built**

- 39 unit tests, a real `git worktree` isolation test, and a render-and-score
  integration test that drives the plugin's own scoring path;
- durable clone state, so a plugin reload or a restart does not throw a run away;
- sandboxed lane previews (opaque origin) and workspace-only writes;
- a format-1 market index, storefront icon and screenshots, and a GitHub release
  tarball, so the plugin installs from a Discover tab without npm;
- four real demo pages built by the plugin, served at the link above.

**What would help**

- **Token grants** to run parallel lanes on real-world references: the honest
  cost of a three-lane build is three builds, and a grant would let me publish
  measured comparisons instead of single runs.
- **Technical contact** for the plugin API: two things I hit while building this
  are worth a short conversation — how a plugin should surface a child agent's
  progress to the UI without polling, and whether a stable way to render a
  workspace file exists (right now I drive a locally installed Chrome).
- **Promotion** of the scored-demo format: a page that shows "reference →
  three rebuilds → measured score" is much more convincing than a feature list.

**Honest notes**

The similarity score measures the picture, not correctness — it ranks attempts
and never certifies one, and the README says so plainly. The plugin needs a
vision-capable model and, for scoring, an installed Chromium-family browser.

## 中文

**插件做什么**

`dsh-clone` 把参考截图变成可运行的静态页面。一条命令会让多个子代理并行处理同一屏，每个子代理在各自的 `git worktree` 中工作；每个完成的页面都会被本机浏览器截图，并与参考图做颜色与结构匹配度评分，由使用者采用最满意的一版。第二遍 `refine` 会在已采用的页面上按一句修改要求继续编辑，并给出分数变化。

**为什么做它**

截图是人能给出的最精确的规格，但只做一次就像抽奖：只看到一个结果，就无法分辨是模型误解了你，还是它选了另一种方案。把同一张参考图交给多种策略同时做，并且对完成的页面（而不是对承诺）评分，才能让"做错"变得便宜。

**已完成的部分**

- 39 个单元测试、一个真实的 `git worktree` 隔离测试，以及一个走插件自身评分路径的渲染评分集成测试；
- 克隆状态落盘，插件重载或重启不会丢掉一次运行；
- 预览页运行在不透明源的沙箱中，写入只发生在工作区内；
- 已发布 format 1 插件市场索引、商店图标与截图、GitHub Release tarball，因此无需 npm 也能从 Discover 安装；
- 上面链接里是四个由本插件真实生成并评分的演示页面。

**希望获得的支持**

- **Token 支持**：三路并行构建的真实成本就是三次构建，有支持才能持续发布"实测对比"而不是单次运行。
- **插件 API 的技术沟通**：构建过程中有两件事值得聊——插件如何在不轮询的情况下把子代理进度呈现到界面，以及是否存在稳定的方式渲染工作区文件（目前我调用本机安装的 Chrome）。
- **推广"带评分的演示"这种形式**：一页"参考图 → 三次重建 → 实测分数"比功能列表有说服力得多。

**需要说清楚的**

相似度评分衡量的是画面，不是正确性——它只对多次尝试排序，从不为某一版背书，README 里写得很直白。插件需要能看图的模型；评分需要本机安装 Chromium 系浏览器。
