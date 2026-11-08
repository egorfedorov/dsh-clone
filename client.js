/**
 * dsh-clone — Client half.
 *
 * Two surfaces, both drawn with the host's own React and theme tokens:
 *
 *   1. `conversation.view` — the Clone panel. The reference screenshot on the
 *      left, one live iframe per lane on the right, every lane adoptable with
 *      one click. The iframes point at this page's own origin (`/api/dsh-clone/
 *      preview/...`), so the panel needs no extra port and works over the same
 *      authenticated connection the page already has.
 *
 *   2. `conversation.composer.dock` — a quiet progress chip that appears only
 *      while builders are running.
 *
 * Lane documents are model-written HTML: they are served with a `sandbox` CSP
 * (no `allow-same-origin`) and mounted with `sandbox="allow-scripts"`, so a
 * clone can animate and run its own code but cannot read this page's cookies,
 * storage or API.
 *
 * Bundle format: `window.__ModuleLoader__.load({ id, factory })` with only
 * `react` required from the host module table. No build step, no JSX.
 */

window.__ModuleLoader__.load({
  id: 'dsh-clone',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef } = React

    // ── design tokens ───────────────────────────────────────────────────────
    const T = {
      bg: 'var(--dsw-alias-bg-base, #ffffff)',
      layer: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      layer2: 'var(--dsw-alias-bg-layer-2, #f6f6f7)',
      overlay: 'var(--dsw-alias-bg-overlay, #ffffff)',
      borderL1: 'var(--dsw-alias-border-l1, rgba(0,0,0,0.07))',
      borderL2: 'var(--dsw-alias-border-l2, rgba(0,0,0,0.14))',
      brand: 'var(--dsw-alias-brand-primary, #2f6bff)',
      label: 'var(--dsw-alias-label-primary, #1b2434)',
      label2: 'var(--dsw-alias-label-secondary, #6b6b70)',
      success: 'var(--dsw-alias-state-success-primary, #22c55e)',
      warn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
      error: 'var(--dsw-alias-state-error-primary, #ef4444)',
      idle: 'var(--dsw-alias-state-idle-primary, #9aa0a6)',
    }

    const FONT = 'Inter, var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)'
    const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace'

    const STATE_URL = '/api/dsh-clone/state'
    const ACTION_URL = '/api/dsh-clone/action'
    const POLL_RUNNING_MS = 1000
    const POLL_IDLE_MS = 5000

    // ── locale helper ───────────────────────────────────────────────────────
    const FALLBACK = {
      'panel.title': 'Clone',
      'panel.empty.title': 'Screenshot in, working UI out',
      'panel.empty.body': 'Paste a screenshot into the conversation, then run /clone 3. Three agents rebuild it in parallel, in their own directories, and you adopt the one you like.',
      'panel.empty.hint': 'Tip: /clone 4 for four attempts, /clone 2 dark variant to steer them.',
      'panel.reference': 'Reference',
      'panel.lanes': 'Lanes',
      'panel.lane': 'Lane',
      'panel.suggested': 'Suggested',
      'panel.adopt': 'Adopt this one',
      'panel.adopted': 'Adopted',
      'panel.cancel': 'Stop builders',
      'panel.discard': 'Discard scratch',
      'panel.running': 'building',
      'panel.settled': 'ready',
      'panel.scoring': 'scoring',
      'panel.emptyLane': 'no page',
      'panel.failed': 'failed',
      'panel.cancelled': 'cancelled',
      'panel.queued': 'queued',
      'panel.tools': 'tools',
      'panel.files': 'files',
      'panel.duration': 'time',
      'panel.chip': 'clone',
      'panel.loading': 'Loading clone state…',
      'panel.adoptedAt': 'Adopted into',
    }

    const translate = (props, key) => {
      const t = props && props.t
      if (typeof t === 'function') {
        try {
          const value = t(key)
          if (typeof value === 'string' && value.length > 0 && value !== key) return value
        } catch {
          /* fall through to the built-in English copy */
        }
      }
      return FALLBACK[key] ?? key
    }

    // ── one shared feed for every surface ───────────────────────────────────
    // The panel and the chip read the same tiny JSON payload, so there is at
    // most one request in flight and one store no matter how many surfaces the
    // page mounts.
    const store = { clones: [], loaded: false, error: null }
    const subscribers = new Set()
    let inflight = false
    let timer = null
    let sessionId = null

    const publish = (next) => {
      if (next.clones === store.clones && next.loaded === store.loaded && next.error === store.error) return
      store.clones = next.clones
      store.loaded = next.loaded
      store.error = next.error
      for (const fn of subscribers) {
        try {
          fn()
        } catch {
          /* one bad subscriber must not starve the others */
        }
      }
    }

    const isRunning = () => store.clones.some((clone) => clone.status === 'running')

    const fetchState = () => {
      if (inflight || typeof fetch !== 'function') return
      inflight = true
      const url = sessionId === null ? STATE_URL : `${STATE_URL}?sessionId=${encodeURIComponent(sessionId)}`
      fetch(url, { cache: 'no-store', credentials: 'same-origin' })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          if (data === null || !Array.isArray(data.clones)) return
          publish({ clones: data.clones, loaded: true, error: null })
        })
        .catch(() => {
          /* host restarting or route absent: keep the last known state */
        })
        .then(() => {
          inflight = false
          schedule()
        })
    }

    const schedule = () => {
      if (typeof window === 'undefined') return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        fetchState()
      }, isRunning() ? POLL_RUNNING_MS : POLL_IDLE_MS)
    }

    const subscribe = (fn) => {
      subscribers.add(fn)
      if (timer === null) fetchState()
      return () => subscribers.delete(fn)
    }

    const refreshNow = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      fetchState()
    }

    const postAction = async (body) => {
      const response = await fetch(ACTION_URL, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await response.json().catch(() => null)
      if (data === null || data.ok !== true) {
        throw new Error(data?.error ?? `request failed (${response.status})`)
      }
      return data
    }

    /** Subscribe one component to the shared clone feed. */
    function useClones(props) {
      const [snapshot, setSnapshot] = useState({ ...store })
      useEffect(() => {
        const id = props && props.sessionId
        if (typeof id === 'string' && id.length > 0) sessionId = id
        const sync = () => setSnapshot({ ...store })
        const unsubscribe = subscribe(sync)
        sync()
        return unsubscribe
      }, [props && props.sessionId])
      return snapshot
    }

    // ── small pieces ────────────────────────────────────────────────────────

    const STATUS_COLOR = {
      running: T.brand,
      scoring: T.brand,
      settled: T.success,
      finished: T.success,
      empty: T.warn,
      failed: T.error,
      cancelled: T.idle,
      queued: T.idle,
    }

    function Dot({ status }) {
      return h('span', {
        'aria-hidden': true,
        style: {
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: STATUS_COLOR[status] ?? T.idle,
          display: 'inline-block',
          flex: 'none',
        },
      })
    }

    function Pill({ children, tone }) {
      return h('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: 20,
          padding: '0 8px',
          borderRadius: 999,
          border: `0.5px solid ${T.borderL1}`,
          background: tone === 'success' ? 'var(--dsw-alias-state-success-primary, #22c55e)' : T.layer2,
          color: tone === 'success' ? '#ffffff' : T.label2,
          fontFamily: FONT,
          fontSize: 11,
          fontWeight: 500,
          lineHeight: '20px',
          whiteSpace: 'nowrap',
          flex: 'none',
        },
      }, children)
    }

    function Button({ children, onClick, disabled, primary, title }) {
      return h('button', {
        type: 'button',
        onClick,
        disabled: Boolean(disabled),
        title,
        style: {
          appearance: 'none',
          border: primary ? 'none' : `0.5px solid ${T.borderL2}`,
          background: primary ? T.brand : 'transparent',
          color: primary ? '#ffffff' : T.label,
          fontFamily: FONT,
          fontSize: 12,
          fontWeight: primary ? 600 : 500,
          height: 26,
          padding: '0 10px',
          borderRadius: 7,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.45 : 1,
          whiteSpace: 'nowrap',
        },
      }, children)
    }

    const formatMs = (ms) => {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
      if (ms < 1000) return `${Math.round(ms)}ms`
      const seconds = ms / 1000
      if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
      const minutes = Math.floor(seconds / 60)
      return `${minutes}m ${String(Math.round(seconds - minutes * 60)).padStart(2, '0')}s`
    }

    const formatTokens = (tokens) => {
      const total = (Number(tokens?.input) || 0) + (Number(tokens?.output) || 0) + (Number(tokens?.cacheRead) || 0)
      if (total === 0) return null
      if (total < 1000) return String(total)
      if (total < 1_000_000) return `${(total / 1000).toFixed(total < 10_000 ? 1 : 0)}k`
      return `${(total / 1_000_000).toFixed(1)}M`
    }

    /**
     * Hover text for the similarity score: what was compared, and against what.
     * The score is a coarse-grid picture comparison, not a correctness verdict.
     */
    const scoreTitle = (lane) => [
      `${lane.score}% picture match with the reference`,
      'coarse-grid colour comparison of the rendered page, not a correctness check',
      'views: live page (above) · rendered snapshot',
    ].join('\n')

    // ── lane card ───────────────────────────────────────────────────────────

    function LaneCard({ props, clone, lane, onAdopt, busy }) {
      const ready = lane.status === 'settled' && lane.delivered
      const adopted = clone.picked !== null && clone.picked.lane === lane.index
      const suggested = clone.winner === lane.index
      const showFrame = lane.status === 'settled' || lane.status === 'empty'

      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          border: `0.5px solid ${adopted ? T.brand : T.borderL1}`,
          borderRadius: 10,
          background: T.layer,
          overflow: 'hidden',
        },
      }, [
        h('div', {
          key: 'head',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 10px',
            borderBottom: `0.5px solid ${T.borderL1}`,
            background: T.layer2,
            minHeight: 34,
          },
        }, [
          h(Dot, { key: 'dot', status: lane.status }),
          h('span', {
            key: 'name',
            style: { fontFamily: FONT, fontSize: 12, fontWeight: 600, color: T.label },
          }, `${translate(props, 'panel.lane')} ${lane.index + 1}`),
          h('span', {
            key: 'strategy',
            style: {
              fontFamily: FONT, fontSize: 11, color: T.label2,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
            },
          }, lane.strategyLabel),
          h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
          typeof lane.score === 'number'
            ? h('span', {
              key: 'score',
              title: scoreTitle(lane),
              style: {
                fontFamily: MONO, fontSize: 10.5, fontWeight: 600,
                color: lane.score >= 85 ? T.success : lane.score >= 60 ? T.warn : T.error,
                fontVariantNumeric: 'tabular-nums', flex: 'none',
              },
            }, `${lane.score}%`)
            : null,
          suggested && ready
            ? h(Pill, { key: 'sug', tone: 'success' }, translate(props, 'panel.suggested'))
            : null,
        ]),
        h('div', {
          key: 'body',
          style: { position: 'relative', width: '100%', aspectRatio: '16 / 10', background: '#ffffff' },
        }, showFrame
          ? h('iframe', {
            title: `clone lane ${lane.index + 1}`,
            src: lane.previewUrl,
            sandbox: 'allow-scripts',
            style: {
              position: 'absolute', inset: 0, width: '100%', height: '100%',
              border: '0', background: '#ffffff', display: 'block',
            },
          })
          : h('div', {
            style: {
              position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 6,
              background: T.layer2, color: T.label2, fontFamily: FONT, fontSize: 12,
            },
          }, [
            h('div', {
              key: 'glyph',
              'aria-hidden': true,
              style: {
                width: 22, height: 22, borderRadius: 6,
                border: `1.5px dashed ${lane.status === 'failed' ? T.error : T.borderL2}`,
                opacity: lane.status === 'running' ? 0.9 : 0.6,
                animation: lane.status === 'running' ? 'dshClonePulse 1.4s ease-in-out infinite' : 'none',
              },
            }),
            h('span', { key: 'label' }, lane.status === 'running'
              ? translate(props, 'panel.running')
              : lane.status === 'failed'
                ? (lane.error ?? translate(props, 'panel.failed'))
                : translate(props, lane.status === 'cancelled' ? 'panel.cancelled' : 'panel.queued')),
          ])),
        h('div', {
          key: 'foot',
          style: {
            display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
            borderTop: `0.5px solid ${T.borderL1}`, minHeight: 38,
          },
        }, [
          h('span', {
            key: 'stats',
            style: {
              fontFamily: MONO, fontSize: 10.5, color: T.label2,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
            },
          }, [
            formatMs(lane.durationMs),
            ` · ${lane.tools} ${translate(props, 'panel.tools')}`,
            lane.files > 0 ? ` · ${lane.files} ${translate(props, 'panel.files')}` : '',
            formatTokens(lane.tokens) === null ? '' : ` · ${formatTokens(lane.tokens)} tok`,
          ].join('')),
          h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
          adopted
            ? h(Pill, { key: 'adopted', tone: 'success' }, translate(props, 'panel.adopted'))
            : h(Button, {
              key: 'adopt',
              primary: ready,
              disabled: !ready || busy,
              onClick: () => onAdopt(lane.index + 1),
              title: ready ? undefined : translate(props, 'panel.emptyLane'),
            }, translate(props, 'panel.adopt')),
        ]),
      ])
    }

    // ── the panel ───────────────────────────────────────────────────────────

    function ClonePanel(props) {
      const { clones, loaded, error } = useClones(props)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const clone = clones.length === 0 ? null : clones[0]

      const act = async (body, message) => {
        setBusy(true)
        setNotice(null)
        try {
          await postAction(body)
          setNotice(message)
          refreshNow()
        } catch (failure) {
          setNotice(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }

      const header = h('div', {
        key: 'header',
        style: {
          display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px',
          borderBottom: `0.5px solid ${T.borderL1}`, background: T.bg, flex: 'none', minHeight: 40,
        },
      }, [
        h('span', {
          key: 'title',
          style: { fontFamily: FONT, fontSize: 12.5, fontWeight: 600, color: T.label },
        }, translate(props, 'panel.title')),
        clone === null ? null : h('span', {
          key: 'note',
          style: {
            fontFamily: FONT, fontSize: 11.5, color: T.label2, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
        }, clone.note.length > 0 ? `· ${clone.note}` : `· ${clone.id}`),
        h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
        clone === null || clone.status !== 'running' ? null : h(Button, {
          key: 'cancel',
          disabled: busy,
          onClick: () => act({ cloneId: clone.id, action: 'cancel' }, 'Builders stopped.'),
        }, translate(props, 'panel.cancel')),
        clone === null ? null : h(Button, {
          key: 'discard',
          disabled: busy,
          onClick: () => act({ cloneId: clone.id, action: 'discard' }, 'Scratch directories removed.'),
        }, translate(props, 'panel.discard')),
      ])

      if (clone === null) {
        return h('div', {
          style: {
            boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
            width: '100%', height: '100%', minHeight: 0, overflow: 'hidden', background: T.bg,
          },
        }, [
          header,
          h('div', {
            key: 'empty',
            style: {
              flex: '1 1 auto', display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24, textAlign: 'center',
            },
          }, [
            h('div', {
              key: 'glyph',
              'aria-hidden': true,
              style: {
                width: 64, height: 44, borderRadius: 8, border: `1.5px solid ${T.borderL2}`,
                background: `linear-gradient(135deg, ${T.layer2} 0%, ${T.bg} 100%)`,
                position: 'relative',
              },
            }, h('span', {
              style: {
                position: 'absolute', inset: '8px 10px 8px 10px', borderRadius: 3,
                background: `repeating-linear-gradient(90deg, ${T.borderL1} 0 10px, transparent 10px 18px)`,
              },
            })),
            h('div', {
              key: 'title',
              style: { fontFamily: FONT, fontSize: 15, fontWeight: 600, color: T.label },
            }, translate(props, 'panel.empty.title')),
            h('div', {
              key: 'body',
              style: { fontFamily: FONT, fontSize: 12.5, lineHeight: '19px', color: T.label2, maxWidth: 460 },
            }, translate(props, 'panel.empty.body')),
            h('div', {
              key: 'hint',
              style: { fontFamily: MONO, fontSize: 11, color: T.label2, opacity: 0.8 },
            }, translate(props, 'panel.empty.hint')),
            error === null ? null : h('div', {
              key: 'error',
              style: { fontFamily: MONO, fontSize: 11, color: T.error },
            }, String(error)),
            loaded ? null : h('div', {
              key: 'loading',
              style: { fontFamily: FONT, fontSize: 11, color: T.label2 },
            }, translate(props, 'panel.loading')),
          ]),
        ])
      }

      const reference = h('div', {
        key: 'reference',
        style: {
          flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 6,
          padding: '12px 14px', borderRight: `0.5px solid ${T.borderL1}`, minWidth: 0,
          width: 'min(38%, 420px)',
        },
      }, [
        h('div', {
          key: 'label',
          style: {
            display: 'flex', alignItems: 'center', gap: 6,
            fontFamily: FONT, fontSize: 11, fontWeight: 600, color: T.label2,
            textTransform: 'uppercase', letterSpacing: '0.04em',
          },
        }, [
          translate(props, 'panel.reference'),
          h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
          h('span', {
            key: 'meta',
            style: { fontFamily: MONO, fontSize: 10, textTransform: 'none', letterSpacing: 0, fontWeight: 400 },
          }, `${clone.viewport} · ${formatMs(clone.durationMs)}`),
        ]),
        h('div', {
          key: 'image',
          style: {
            border: `0.5px solid ${T.borderL2}`, borderRadius: 8, overflow: 'hidden',
            background: T.layer2, minHeight: 0,
          },
        }, h('img', {
          src: clone.reference.url,
          alt: clone.reference.label,
          style: { display: 'block', width: '100%', height: 'auto' },
        })),
        clone.picked === null ? null : h('div', {
          key: 'adopted',
          style: { fontFamily: MONO, fontSize: 10.5, color: T.label2, wordBreak: 'break-all' },
        }, `${translate(props, 'panel.adoptedAt')}: ${clone.picked.path}`),
        notice === null ? null : h('div', {
          key: 'notice',
          style: { fontFamily: MONO, fontSize: 10.5, color: T.label2, wordBreak: 'break-word' },
        }, notice),
      ])

      const lanes = h('div', {
        key: 'lanes',
        style: {
          flex: '1 1 auto', minWidth: 0, minHeight: 0, overflow: 'auto',
          padding: 12, display: 'grid', gap: 12,
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          alignContent: 'start',
        },
      }, clone.lanes.map((lane) => h(LaneCard, {
        key: lane.index,
        props,
        clone,
        lane,
        busy,
        onAdopt: (laneNumber) => act(
          { cloneId: clone.id, action: 'pick', lane: laneNumber },
          `Lane ${laneNumber} adopted.`,
        ),
      })))

      return h('div', {
        style: {
          boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
          width: '100%', height: '100%', minHeight: 0, overflow: 'hidden', background: T.bg,
        },
      }, [
        header,
        h('div', {
          key: 'body',
          style: { flex: '1 1 auto', display: 'flex', minHeight: 0, minWidth: 0 },
        }, [reference, lanes]),
      ])
    }

    // ── composer chip ───────────────────────────────────────────────────────

    function CloneChip(props) {
      const { clones } = useClones(props)
      const clone = clones.length === 0 ? null : clones[0]
      if (clone === null) return null
      if (clone.status !== 'running' && clone.picked !== null) return null
      const summary = clone.summary ?? { done: 0, total: clone.lanes.length, delivered: 0 }
      const label = clone.status === 'running'
        ? `${summary.done}/${summary.total}`
        : `${summary.delivered} ${translate(props, 'panel.settled')}`
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 6, padding: '2px 2px 0',
          fontFamily: FONT, fontSize: 11, color: T.label2,
        },
        title: clone.note.length > 0 ? clone.note : clone.id,
      }, [
        h(Dot, { key: 'dot', status: clone.status }),
        h('span', { key: 'label' }, `${translate(props, 'panel.chip')} · ${label}`),
      ])
    }

    // ── client plugin entry ─────────────────────────────────────────────────

    const VIEW_SLOT = 'conversation.view'
    const VIEW_ID = 'dsh-clone:panel'
    const VIEW_ORDER = 46
    const DOCK_SLOT = 'conversation.composer.dock'
    const DOCK_ID = 'dsh-clone:chip'

    function apply(ctx) {
      // A keyframe for the pending lane placeholder; component-scoped so it
      // disappears with the plugin.
      if (typeof document !== 'undefined' && document.head) {
        const style = document.createElement('style')
        style.setAttribute('data-dsh-clone', 'animations')
        style.textContent = '@keyframes dshClonePulse{0%,100%{opacity:.35}50%{opacity:1}}'
        document.head.appendChild(style)
      }

      ctx.inject(['slots'], (scope) => {
        scope.effect(() => {
          const disposeView = scope.slots.inject(VIEW_SLOT, () => scope.slots.register({
            name: VIEW_SLOT,
            id: VIEW_ID,
            order: VIEW_ORDER,
            label: () => FALLBACK['panel.title'],
          }, ClonePanel))

          const disposeChip = scope.slots.inject(DOCK_SLOT, () => scope.slots.register({
            name: DOCK_SLOT,
            id: DOCK_ID,
            order: 6,
          }, CloneChip))

          return () => {
            for (const dispose of [disposeChip, disposeView]) {
              try {
                if (typeof dispose === 'function') dispose()
              } catch {
                /* one disposer must not strand the other */
              }
            }
          }
        }, 'dsh-clone: register panel and chip')
      })
    }

    exports.apply = apply
    exports.inject = []
    exports.__test = {
      getStore: () => store,
      isRunning,
      formatMs,
      formatTokens,
    }

    return module.exports
  },
})
