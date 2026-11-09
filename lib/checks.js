/**
 * Dynamic checks: does the page actually behave, or does it only look right?
 *
 * A static checklist can prove every reference resolves. It cannot prove the
 * page throws on load or spills sideways past the viewport — those need the page
 * to run. Rather than drive the DevTools protocol (a socket, a session, a second
 * failure surface), this injects a tiny harness as the page's *first* script and
 * reads the answer back out of the rendered DOM that `--dump-dom` prints.
 *
 * The harness therefore runs before any page script and can catch errors from
 * them. It reports: uncaught exceptions, unhandled rejections, `console.error`
 * calls, and horizontal overflow measured against the viewport it was given.
 */

/** Attribute the harness writes its answer into. */
export const CHECK_ATTRIBUTE = 'data-dsh-check'

/**
 * The harness itself. Written as a single expression so it can be injected
 * inline without touching the page's own scripts.
 */
const HARNESS = `(function(){
var out={done:false,errors:[],rejections:[],consoleErrors:[],overflowX:0,scrollWidth:0,clientWidth:0};
function keep(list,value){if(list.length<6)list.push(String(value).slice(0,240));}
window.addEventListener('error',function(event){
  var target=event.target||{};
  if(target&&target.tagName&&target.tagName!=='SCRIPT'&&target.tagName!=='LINK'&&target.tagName!=='IMG')return;
  keep(out.errors,(event.message||'resource failed to load')+(event.filename?' @ '+String(event.filename).split('/').pop():''));
});
window.addEventListener('unhandledrejection',function(event){keep(out.rejections,(event.reason&&event.reason.message)||event.reason||'rejection');});
var originalError=console.error;
console.error=function(){keep(out.consoleErrors,Array.prototype.join.call(arguments,' '));return originalError.apply(console,arguments);};
function settle(){
  var doc=document.documentElement;
  out.scrollWidth=Math.max(doc.scrollWidth,(document.body&&document.body.scrollWidth)||0);
  out.clientWidth=doc.clientWidth;
  out.overflowX=Math.max(0,out.scrollWidth-out.clientWidth);
  out.done=true;
  doc.setAttribute('${CHECK_ATTRIBUTE}',encodeURIComponent(JSON.stringify(out)));
}
if(document.readyState==='complete')settle();
else window.addEventListener('load',function(){setTimeout(settle,250);});
setTimeout(settle,2200);
})();`

/**
 * Insert the harness as the first thing in the document.
 * @param html - the page source.
 * @returns the same page with the harness injected.
 */
export function injectCheckHarness(html) {
  const source = String(html ?? '')
  const tag = `<script>${HARNESS}</script>`
  const head = /<head[^>]*>/iu.exec(source)
  if (head !== null) return `${source.slice(0, head.index + head[0].length)}${tag}${source.slice(head.index + head[0].length)}`
  const htmlOpen = /<html[^>]*>/iu.exec(source)
  if (htmlOpen !== null) return `${source.slice(0, htmlOpen.index + htmlOpen[0].length)}${tag}${source.slice(htmlOpen.index + htmlOpen[0].length)}`
  const doctype = /<!doctype[^>]*>/iu.exec(source)
  if (doctype !== null) return `${source.slice(0, doctype.index + doctype[0].length)}${tag}${source.slice(doctype.index + doctype[0].length)}`
  return `${tag}${source}`
}

/**
 * Read the harness verdict out of a dumped DOM.
 * @param dom - the `--dump-dom` output.
 * @returns `{ done, errors, rejections, consoleErrors, overflowX, scrollWidth, clientWidth }`
 *   or null when the harness never wrote its answer (page failed to load, or the
 *   script was blocked by the page).
 */
export function parseCheckResult(dom) {
  const attribute = new RegExp(`${CHECK_ATTRIBUTE}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'iu').exec(String(dom ?? ''))
  if (attribute === null) return null
  const encoded = attribute[2] ?? attribute[3] ?? ''
  let parsed
  try {
    parsed = JSON.parse(decodeURIComponent(encoded))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  return {
    done: parsed.done === true,
    errors: Array.isArray(parsed.errors) ? parsed.errors : [],
    rejections: Array.isArray(parsed.rejections) ? parsed.rejections : [],
    consoleErrors: Array.isArray(parsed.consoleErrors) ? parsed.consoleErrors : [],
    overflowX: Number(parsed.overflowX) || 0,
    scrollWidth: Number(parsed.scrollWidth) || 0,
    clientWidth: Number(parsed.clientWidth) || 0,
  }
}

/** Overflow, in CSS pixels, that a page is allowed to exceed its viewport by. */
export const OVERFLOW_TOLERANCE = 2

/**
 * Turn one inspection into the gate checks it contributes.
 * @param result - from {@link parseCheckResult}, or null when it could not run.
 * @returns two checks: uncaught errors and horizontal overflow.
 */
export function dynamicChecks(result) {
  if (result === null || result === undefined || result.done !== true) {
    return [{ id: 'runtime', ok: true, detail: 'runtime checks unavailable (the page did not report back)' }]
  }
  const problems = [...result.errors, ...result.rejections, ...result.consoleErrors]
  const runtime = {
    id: 'runtime',
    ok: problems.length === 0,
    detail: problems.length === 0
      ? 'no uncaught errors, rejections or console.error calls'
      : problems.slice(0, 3).join(' | '),
  }
  const overflow = {
    id: 'no-overflow',
    ok: result.overflowX <= OVERFLOW_TOLERANCE,
    detail: result.overflowX <= OVERFLOW_TOLERANCE
      ? `content fits the viewport (${result.scrollWidth} ≤ ${result.clientWidth})`
      : `content is ${result.overflowX}px wider than the ${result.clientWidth}px viewport`,
  }
  return [runtime, overflow]
}
