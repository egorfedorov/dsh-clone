# Official program form — answers, field by field

Form: <https://trtgsjkv6r.feishu.cn/share/base/form/shrcnkRrxNyri4bOF9n48BIYWbb>
The form is bilingual (中文 / English). Paste the Chinese block first where a field
accepts it — the reviewers are Chinese-speaking and the form asks in both
languages.

Your details: **Egor Fedorov** · **egorfdrv@gmail.com** · <https://github.com/egorfedorov>

---

## Fields 1-3 (name, contact, GitHub — not visible in the screenshots)

- 姓名 / Name: `Egor Fedorov`
- 邮箱 / Email: `egorfdrv@gmail.com`
- GitHub / 主页: `https://github.com/egorfedorov`

If a field asks for WeChat or another channel, email is enough — put the address
in any free-text contact box too, so it survives a single-field mismatch.

---

## 4 · 团队 / 公司信息 Team / Company (optional)

```
个人开发者（独立）／ Independent individual developer
```

---

## 5 · 插件名称 / 想法名称 Plugin Name / Idea  *(required)*

```
dsh-clone — 截图进，界面出（Screenshot in, working UI out）
```

---

## 6 · 当前阶段 Current Stage  *(required, single choice)*

Select: **已发布并持续维护 Published and actively maintained**

---

## 7 · 插件 / 想法简介 About Your Plugin / Idea  *(required)*

### 中文

```
面向需要“照着截图做界面”的开发者、设计师与产品经理。

问题：文字描述会丢掉排版、间距、字号、层级——所有真正决定“像不像”的信息；而只让模型做一次等于抽奖，你无法分辨是模型误解了你，还是它选了另一种方案。
功能：一条 /clone N 命令让多个子代理并行重建同一张参考图，每个子代理在独立 git worktree 中工作；每个完成的页面都会被本机无头浏览器截图，并与参考图做“颜色＋结构”匹配度打分；由使用者采用最满意的一版，或用 /clone refine 改一处并要求最小改动，直接看到分数变化。输出是纯 HTML/CSS/JS 静态页面，可直接打开。
成果：npm 已发布 0.2.0（MIT）；39 个单元测试、真实 git worktree 隔离测试、以及走插件自身评分路径的渲染评分集成测试；四个由本插件真实生成并评分的演示页面（Nebula 仪表盘 91.9%、Aperture 落地页 91.9%、账单卡 97.8%、登录页 79%）；插件市场索引（format 1，已用官方 parseMarketIndex 校验）、商店图标与截图、GitHub Release tarball 均已就绪；已向 awesome-dsh-plugin 提交收录 PR。
```

### English

```
For developers, designers and PMs who are told “make it look like this screenshot”.

The problem: a text description loses the layout, spacing, type scale and hierarchy — everything that decides whether a rebuild actually looks like the reference — and a single attempt is a lottery, because you cannot tell whether the model misunderstood you or simply chose a different solution.
What it does: one /clone N command runs several subagents on the same reference, each in its own isolated git worktree. Every delivered page is screenshotted by a locally installed browser and compared with the reference by a colour-and-structure score; the reader adopts the one they prefer, or runs /clone refine to ask for one change with a minimal edit and see the score delta. Output is a plain HTML/CSS/JS page that opens as-is.
What exists: dsh-clone 0.2.0 on npm (MIT), 39 unit tests plus a real git-worktree isolation test and a render-and-score integration test that drives the plugin's own scoring path, four demo pages the plugin actually built and scored (Nebula dashboard 91.9%, Aperture landing 91.9%, billing card 97.8%, sign-in 79%), a format-1 market index validated with the official parseMarketIndex, a storefront icon and screenshots, a GitHub release tarball, and an open submission PR to awesome-dsh-plugin.
```

---

## 8 · 作品链接 Links (optional)

```
https://github.com/egorfedorov/dsh-clone
https://www.npmjs.com/package/dsh-clone
https://egorfedorov.github.io/dsh-clone/          （落地页）
https://egorfedorov.github.io/dsh-clone/demo/nebula/   （插件真实生成的仪表盘）
https://egorfedorov.github.io/dsh-clone/demo/aperture/ （插件真实生成的落地页）
https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/13425
```

---

## 9 · 希望获得的支持 Support You're Interested In  *(required, multi-select)*

Tick these four:

- ☑ **Token 支持 Token support** — N parallel lanes cost N builds; a grant buys published, measured comparisons instead of single runs.
- ☑ **技术交流与开发答疑 Technical exchange and development Q&A** — two concrete questions below.
- ☑ **作品推荐与曝光 Promotion and exposure for your work** — the “reference → three rebuilds → measured score” format is what convinces people.
- ☑ **用户反馈与产品打磨 User feedback and product refinement**

Leave unchecked: “通过 DSH 插件市场提供产品或服务” (this plugin is free MIT, nothing to sell), “探索其他合作 / 想先和团队交流” (only if you want a call), “其他”.

---

## 10 · 其他想说的 Anything Else (optional)

### 中文

```
三件具体的困难与下一步：

1) 子代理进度：目前插件是靠轮询子会话事件来算进度（工具数、token、耗时）。如果官方能提供“子代理进度投影”给 UI 用，插件就不用自己轮询，这对所有多智能体插件都是通用的。
2) 渲染：质量评分需要把生成的页面截图，现在只能在插件里调用本机安装的 Chrome/Chromium。如果存在稳定的“渲染工作区文件”的能力（官方或可选依赖），评分就能跨平台一致。
3) 成本：并行 N 路的成本就是 N 次构建，所以格外需要 token 支持，才能持续做公开的实测对比。

下一步计划：区域评分（只比较关心的那块界面，而不是整屏）、多参考图（一个流程多屏）、以及以 diff 形式把结果合入现有组件库。

另外说明：awesome-dsh-plugin 的 PR 目前会被“仓库满 1 天”的自动门禁拦一下，属预期，仓库 2026-11-08 16:05 UTC 创建，门禁会自动重跑。
```

### English

```
Three concrete friction points, and what comes next.

1) Subagent progress: the plugin currently polls child session events to compute progress (tool calls, tokens, elapsed). An official “subagent progress projection” for UI consumption would remove that polling for every multi-agent plugin, not just this one.
2) Rendering: scoring needs a screenshot of the generated page, so the plugin drives a locally installed Chrome/Chromium. A stable way to render a workspace file (official, or an optional dependency) would make scoring consistent across platforms.
3) Cost: N parallel lanes cost N builds, which is exactly why token support matters — it buys published, measured comparisons instead of single runs.

Next: region scoring (compare only the part of the screen you care about), multi-reference (one page per screen of a flow), and adopting results as a diff into an existing component library.

One note: the awesome-dsh-plugin PR is currently held by their automatic “repository at least 1 day old” gate. The repository was created 2026-11-08 16:05 UTC, so the gate re-runs and clears on its own.
```

---

## Before you press send

- Fields marked **必填 / required**: 5, 6, 7, 9. Everything else is optional.
- The form offers **Отправить анонимно** (anonymous submit). Since you are asking
  for support and want to be contacted, keep your email inside field 7 or 10 as
  well — an anonymous submission with no contact detail cannot be followed up.
- Paste links one per line; the box accepts multiple URLs.
