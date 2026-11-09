/**
 * The builder prompts. Each lane gets the same reference image and the same
 * hard delivery contract, but a different way of working — that difference is
 * what makes a set of lanes worth comparing instead of three copies of one
 * attempt.
 */

/** Fixed delivery contract every lane must satisfy. */
export const DELIVERY_CONTRACT = `Delivery contract (non-negotiable):
- Work ONLY inside the current working directory. Never read or write outside it.
- Deliver a static page that opens at index.html with no build step and no server: plain HTML, CSS and vanilla JS, plus any extra local files (styles.css, app.js, assets/*).
- No network at runtime. No CDN, no Google Fonts, no remote images, no package installs. If you need an icon or a photo, draw it with inline SVG or CSS gradients/geometry.
- The page must fill the viewport edge to edge (body margin 0; a layout that uses height:100vh). Target a ${'`'}REFERENCE_VIEWPORT${'`'} viewport; make it degrade sanely when narrower.
- Never leave placeholder text like "Lorem ipsum", "TODO", "Your text here", or a grey box where the reference shows real content. Recreate the copy you can read in the reference image, in the reference's own language.
- Match the reference as a picture: structure, spacing rhythm, colour values, type scale and weights, corner radii, borders, shadows, iconography, and the alignment of every block.
- If the reference contains a chart, table, avatar or illustration you cannot copy pixel for pixel, approximate its silhouette, palette and proportions with CSS/SVG — an honest approximation, never a blank hole.
- Do not leave working files behind (crops of the reference, notes, scripts). The deliverable is index.html plus the assets it actually loads; delete your scratch before you finish.`

/**
 * Budget guidance shared by every lane.
 *
 * A reference rebuild is a build task, not a research task: an agent that keeps
 * cropping the screenshot instead of writing the page burns tokens without
 * improving the result. The budget below is deliberately concrete because
 * "be efficient" is not actionable for a model.
 */
export const EFFORT_BUDGET = `Working budget:
- Study the reference in at most 2-3 passes (its full view, then at most two crops of regions whose detail you cannot read at full size).
- Then write the page: one large write of index.html, one or two follow-up edits. Do not iterate pixel by pixel.
- Aim to be finished within roughly 20-25 tool calls. If you are past that, ship what you have and report what still differs.`

/** Lane strategies, cycled when more lanes than strategies are requested. */
export const LANE_STRATEGIES = [
  {
    id: 'measure-first',
    label: 'Measure first',
    brief: `Strategy: measure before you build. Before writing any code, study the reference image and write a short layout spec as an HTML comment at the top of index.html: the page's regions top to bottom, the column grid, the spacing scale you infer, the palette you sample (list the hex values), and the type scale. Then build strictly to that spec. Verify at the end by re-reading your spec against the image and fixing every mismatch.`,
  },
  {
    id: 'structure-first',
    label: 'Structure first',
    brief: `Strategy: structure before cosmetics. First write the whole page as semantic HTML with every region, list, control and piece of copy in place, unstyled. Only then apply CSS in one pass, region by region, from the outside in. Finish by checking that the block geometry (widths, heights, alignments) matches the image before you polish colour and type.`,
  },
  {
    id: 'visual-first',
    label: 'Visual first',
    brief: `Strategy: visual fidelity before features. Reproduce the image as a picture first: exact background colours, the dominant surfaces, the type, the spacing, and the overall silhouette at the target viewport. Once the page looks right as a still image, add only the interactivity that the image visibly implies. Never trade visual fidelity for extra behaviour.`,
  },
  {
    id: 'component-first',
    label: 'Component first',
    brief: `Strategy: components first. Identify the 5-8 repeated or reused parts of the interface (card, row, button, tab, badge, panel) and define each once as a small CSS class or a JS factory. Compose the page from those parts, so spacing and corner treatment stay consistent across the whole screen.`,
  },
]

/**
 * The task for refining an adopted lane.
 *
 * A refine is not a new attempt: the previous page is already in the working
 * directory and the person liked it. The contract therefore forbids starting
 * over and asks for the smallest edit that satisfies the change while keeping
 * the reference agreement.
 * @param args - reference path, the requested change, viewport.
 * @returns the prompt text.
 */
export function buildRefinePrompt({ referencePath, change, viewport }) {
  return [
    'You are refining a page you already built. It is not a new attempt.',
    '',
    `The page is in this directory (index.html plus its assets). Read it first: it is your previous work and it is close to the reference already.`,
    `Reference image: ${referencePath} — open it with the read_image tool. It is still the source of truth for layout, colour, type and copy.`,
    '',
    `The change the person wants:`,
    `  ${change.length === 0 ? '(no specific change was given — improve the reference agreement where your previous version is visibly off)' : change}`,
    '',
    'Rules:',
    '- Keep everything that already agrees with the reference. Do not rewrite the page from scratch and do not restyle unrelated parts.',
    '- Make the smallest edit that satisfies the change, then check the result against the reference again.',
    `- The page must stay a self-contained static page at the target viewport \`${viewport}\`, with no build step and no network at runtime.`,
    '- Delete any scratch file you create. Ship only what the page loads.',
    '',
    'Reply with a short plain-text report: the files you touched, what changed, and anything in the reference you still cannot match. Do not paste the HTML.',
  ].join('\n')
}

/** Pick the strategy for one lane, cycling deterministically. */
export function strategyForLane(index) {
  return LANE_STRATEGIES[index % LANE_STRATEGIES.length]
}

/**
 * Build the complete task for one lane.
 * @param args - lane index, reference path, viewport, optional user note.
 * @returns the prompt text handed to the child agent.
 */
export function buildLanePrompt({ laneIndex, laneCount, strategy, referencePath, referenceLabel, viewport, note }) {
  const contract = DELIVERY_CONTRACT.replace('REFERENCE_VIEWPORT', `\`${viewport}\``)
  const noteLine = note === undefined || note === null || note.length === 0
    ? ''
    : `\nThe person asked for this specifically — honour it whenever it does not contradict the reference image:\n  ${note}\n`
  return [
    `You are rebuilding a user interface from a reference screenshot. This is a build task, not a review task.`,
    ``,
    `Reference image: ${referencePath}`,
    `Open it with the read_image tool and study it before you write anything. It is the only source of truth for layout, colour, type and copy.`,
    referenceLabel === undefined ? '' : `Reference label: ${referenceLabel}`,
    `You are lane ${laneIndex + 1} of ${laneCount}: another agent is building the same screen in parallel in a different directory, and the person will adopt whichever result they prefer. Your job is to make yours the obvious choice.`,
    noteLine,
    strategy.brief,
    ``,
    contract,
    ``,
    EFFORT_BUDGET,
    ``,
    `When you are done, reply with a short report in plain text: the files you created, the palette you sampled, and the three places where your rebuild still differs from the reference. Do not paste the HTML into the reply.`,
  ].filter((line) => line !== '').join('\n')
}
