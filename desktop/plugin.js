/**
 * Inline Comments — select text in an agent reply, attach a note, and the
 * pending notes ride along with your next message (or go out on their own).
 *
 * Flow
 *   1. Select text inside an assistant message, or in a file open in the
 *      preview pane (rendered markdown or source) → "Add to reply" pill
 *      (or Ctrl/Cmd+Alt+C). The selection snaps to whole words.
 *   2. Type a comment → Enter (Shift+Enter = newline, Esc = cancel).
 *      It becomes PENDING: highlighted in the reply + listed above the composer.
 *   3. Click a highlight in the reply to edit or delete its comment.
 *   4. Send:
 *        - type a message + Enter → comments are appended to that message;
 *        - empty composer + Enter, or "Send comments" → comments go alone.
 *   5. Sent messages carrying comments render as quote cards in your bubble.
 *
 * Pending comments are per session and persisted (ctx.storage); highlights are
 * re-anchored by text after reloads/re-renders. Slash commands never pick
 * comments up.
 */

import { atom, COMPOSER_AREAS, host, KEYBINDS_AREA, PALETTE_AREA, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-desktop-inline-comments'
const ASSISTANT_SEL = '[data-slot="aui_assistant-message-root"]'
// File previews (right rail / preview tiles): rendered markdown and the source view.
const FILE_SEL = '[data-preview-markdown], .preview-source-code'
const ROOT_SEL = `${ASSISTANT_SEL}, ${FILE_SEL}`
const PANE_SEL = '[data-pane-host]'
const UNKNOWN_FILE = '?' // preview whose path we could not read
const USER_TEXT_SEL = '[data-slot="aui_user-message-text"]'
const COMPOSER_INPUT_SEL = '[data-slot="composer-rich-input"]'
const HIGHLIGHT = 'hermes-inline-comment'
const MAX_QUOTE = 600

// Wire format (what the agent receives AND what the bubble renderer parses).
// One group per target: "your last reply", a file (`path`), or "the open file".
// Backticks are optional on parse: user bubbles render `code`, so their textContent lacks them.
const HEADER_RE = /^💬 Comments? on (your last reply|the open file|`?([^`\n]+?)`?)(?: \(\d+\))?:\s*$/
const LEGACY_HEADER_RE = /^Comments? on your last reply(?: \(\d+\))?:\s*$/
const Q_OPEN = '❝'
const Q_CLOSE = '❞'
const NOTE = '↳ '

// ── helpers ────────────────────────────────────────────────────────────────

const uid = () => Math.random().toString(36).slice(2, 10)

/** Durable key for the chat the user is looking at. */
function sessionKey() {
  const s = host.state
  return s.focusedStoredSessionId?.get() || s.focusedSessionId?.get() || s.activeSessionId?.get() || '__none__'
}

function clip(text, n) {
  const t = text.replace(/[ \t]+\n/g, '\n').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

function oneLine(text, n) {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

const baseName = p => (p && p !== UNKNOWN_FILE ? p.split(/[\\/]/).filter(Boolean).pop() || p : 'file')

/** Path as the agent should see it: relative to the session cwd when inside it. */
function displayPath(p) {
  const cwd = (host.state.cwd?.get?.() || '').replace(/[\\/]+$/, '')
  return cwd && (p.startsWith(`${cwd}/`) || p.startsWith(`${cwd}\\`)) ? p.slice(cwd.length + 1) : p
}

/** Pane/tab id of the preview showing `rootEl`. The body carries no path; the zone's
 *  active tab does: data-tree-tab="preview-tile:file:<owner>:file:///abs/path". */
function previewIdOf(rootEl) {
  const group = rootEl.closest('[data-tree-group]')
  const gid = group?.getAttribute('data-tree-group')
  if (gid) {
    const strip = document.querySelector(`[data-zone-tabstrip="${CSS.escape(gid)}"]`) || group
    const tab = strip.querySelector('[data-tree-tab^="preview-tile:file:"][data-active="true"]')
    if (tab) return tab.getAttribute('data-tree-tab')
  }
  return rootEl.closest(PANE_SEL)?.getAttribute('data-pane-host') || ''
}

/** Absolute file path of the preview containing `rootEl`; null for chat replies. */
function fileOf(rootEl) {
  if (!rootEl || rootEl.matches(ASSISTANT_SEL)) return null
  // id: `<prefix>:file:[<owner>:]<url>` with url = /abs/path, C:\path or file:///…
  const id = previewIdOf(rootEl)
  const u = id.indexOf('file://')
  if (u >= 0) {
    try {
      return decodeURIComponent(new URL(id.slice(u)).pathname)
    } catch {
      return id.slice(u + 7)
    }
  }
  const m = id.match(/:(\/.*|[A-Za-z]:[\\/].*)$/)
  return m ? m[1] : UNKNOWN_FILE
}

function formatComments(comments, userText) {
  // Group by target, reply first, files in the order they were first commented.
  const groups = new Map()
  for (const c of [...comments].sort((a, b) => (a.file == null ? 0 : 1) - (b.file == null ? 0 : 1))) {
    const k = c.file == null ? '' : c.file
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(c)
  }
  const sections = [...groups].map(([k, list]) => {
    const where = k === '' ? 'your last reply' : k === UNKNOWN_FILE ? 'the open file' : `\`${displayPath(k)}\``
    const header = list.length === 1 ? `💬 Comment on ${where}:` : `💬 Comments on ${where} (${list.length}):`
    const block = list
      .map(c => {
        const quote = clip(c.quote, MAX_QUOTE).replaceAll(Q_OPEN, '"').replaceAll(Q_CLOSE, '"')
        return `${Q_OPEN}${quote}${Q_CLOSE}\n${NOTE}${c.note.trim()}`
      })
      .join('\n\n')
    return `${header}\n\n${block}`
  })
  const body = sections.join('\n\n')
  const text = (userText || '').trim()
  return text ? `${text}\n\n${body}` : body
}

/** Group header line → null (reply), path, or UNKNOWN_FILE. */
function groupFile(headerLine) {
  const m = headerLine.match(HEADER_RE)
  if (!m || m[1] === 'your last reply') return null
  return m[2] ?? UNKNOWN_FILE
}

/** Parse a sent message back into { text, comments }, or null. */
function parseMessage(raw) {
  const lines = raw.replace(/\r/g, '').split('\n')
  const h = lines.findIndex(l => HEADER_RE.test(l.trim()) || LEGACY_HEADER_RE.test(l.trim()))
  if (h === -1) return null

  let before = lines.slice(0, h).join('\n').trim()
  before = before.replace(/\n*-{3,}\s*$/, '').trim() // legacy separator

  const comments = []
  let cur = null
  let file = groupFile(lines[h].trim())
  let state = 'idle' // idle | quote | afterQuote | legacyQuote | note
  const push = () => {
    if (cur && (cur.quote.trim() || cur.note.trim())) comments.push({ quote: cur.quote.trim(), note: cur.note.trim(), file })
    cur = null
  }

  for (const line of lines.slice(h + 1)) {
    const t = line.trim()
    if (state === 'quote') {
      const end = line.indexOf(Q_CLOSE)
      if (end === -1) cur.quote += `\n${line}`
      else {
        cur.quote += `\n${line.slice(0, end)}`
        state = 'afterQuote'
      }
      continue
    }
    if (HEADER_RE.test(t)) {
      push()
      file = groupFile(t)
      state = 'idle'
      continue
    }
    if (t.startsWith(Q_OPEN)) {
      push()
      cur = { quote: '', note: '' }
      const body = t.slice(Q_OPEN.length)
      const end = body.indexOf(Q_CLOSE)
      if (end === -1) {
        cur.quote = body
        state = 'quote'
      } else {
        cur.quote = body.slice(0, end)
        state = 'afterQuote'
      }
      continue
    }
    if (t.startsWith('> ') || t === '>') {
      if (state !== 'legacyQuote') {
        push()
        cur = { quote: '', note: '' }
      }
      cur.quote += (cur.quote ? '\n' : '') + t.replace(/^>\s?/, '')
      state = 'legacyQuote'
      continue
    }
    if (t.startsWith(NOTE.trim()) && cur) {
      cur.note = t.slice(NOTE.trim().length).trim()
      state = 'note'
      continue
    }
    if (!t) {
      if (state === 'note') cur.note += '\n'
      continue
    }
    if (cur && (state === 'note' || state === 'afterQuote' || state === 'legacyQuote')) {
      cur.note += (cur.note && !cur.note.endsWith('\n') ? '\n' : '') + t
      state = 'note'
    }
  }
  push()

  return comments.length ? { text: before, comments } : null
}

/** The commentable root (agent reply or file preview) containing `node`. */
function commentRoot(node) {
  const e = node && (node.nodeType === 1 ? node : node.parentElement)
  return e ? e.closest(ROOT_SEL) : null
}

const WORD = /[\p{L}\p{N}_'’-]/u

/** Expand a range so it doesn't start/end in the middle of a word. */
function snapToWords(range) {
  const r = range.cloneRange()
  const sc = r.startContainer
  if (sc.nodeType === 3) {
    let i = r.startOffset
    while (i > 0 && WORD.test(sc.data[i - 1]) && WORD.test(sc.data[i] ?? ' ')) i--
    r.setStart(sc, i)
  }
  const ec = r.endContainer
  if (ec.nodeType === 3) {
    let j = r.endOffset
    while (j < ec.data.length && j > 0 && WORD.test(ec.data[j]) && WORD.test(ec.data[j - 1])) j++
    r.setEnd(ec, j)
  }
  return r
}

/** A non-empty selection fully inside one reply or one file preview, or null. */
function readSelection() {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  if (!sel.toString().trim()) return null
  const a = commentRoot(sel.anchorNode)
  const f = commentRoot(sel.focusNode)
  if (!a || a !== f) return null
  const range = snapToWords(sel.getRangeAt(0))
  const text = range.toString().trim()
  const rect = range.getBoundingClientRect()
  if (!text || !rect || (rect.width === 0 && rect.height === 0)) return null
  return { text, range, rect, file: fileOf(a) }
}

/** Find `quote` inside `root`'s text (whitespace-insensitive) → Range | null. */
function locate(root, quote) {
  const target = quote.replace(/\s+/g, '')
  if (!target) return null
  const walker = document.createTreeWalker(root, 4 /* SHOW_TEXT */)
  let flat = ''
  const map = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement?.closest('[data-hic-render], .hic-layer, button, [contenteditable]')) continue
    const d = n.data
    for (let i = 0; i < d.length; i++) {
      if (/\s/.test(d[i])) continue
      flat += d[i]
      map.push(n, i)
    }
  }
  const at = flat.lastIndexOf(target)
  if (at === -1) return null
  const r = document.createRange()
  r.setStart(map[at * 2], map[at * 2 + 1])
  const endIdx = at + target.length - 1
  r.setEnd(map[endIdx * 2], map[endIdx * 2 + 1] + 1)
  return r
}

function rangeContains(range, x, y) {
  const rects = range.getClientRects ? range.getClientRects() : []
  for (const r of rects) if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) return true
  return false
}

function el(tag, props = {}, children = []) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v)
  }
  for (const c of [].concat(children)) if (c) n.append(c)
  return n
}

const ICONS = {
  // lucide "message-square-plus"
  commentAdd: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z', 'M12 7v6', 'M9 10h6'],
  // lucide "trash-2"
  trash: ['M3 6h18', 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6', 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2', 'M10 11v6', 'M14 11v6']
}
const SVG_NS = 'http://www.w3.org/2000/svg'
const SVG_ATTRS = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }

/** Plain-DOM icon. */
function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  for (const [k, v] of Object.entries(SVG_ATTRS)) svg.setAttribute(k, v)
  svg.setAttribute('class', 'hic-icon')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of ICONS[name]) {
    const p = document.createElementNS(SVG_NS, 'path')
    p.setAttribute('d', d)
    svg.append(p)
  }
  return svg
}

/** React icon. */
const Icon = ({ name, size = 12 }) =>
  jsx('svg', {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    width: size, height: size, 'aria-hidden': true, style: { flex: 'none', display: 'inline-block', verticalAlign: '-2px' },
    children: ICONS[name].map((d, i) => jsx('path', { d }, i))
  })

const editableText = node => (node.innerText !== undefined ? node.innerText : node.textContent) || ''

// ── styles (injected, removed on dispose) ──────────────────────────────────

const STYLES = `
::highlight(${HIGHLIGHT}) {
  background-color: color-mix(in srgb, var(--ui-accent, #888) 22%, transparent);
  text-decoration: underline dotted color-mix(in srgb, var(--ui-accent, #888) 80%, transparent);
  text-underline-offset: 3px;
}
[data-hic-hover] { cursor: pointer; }

.hic-layer { position: fixed; z-index: 2147483000; font: inherit; }
/* Zero-specificity reset: neutralises app-global button styles without
   beating the component classes below. */
:where(.hic-layer) button { all: unset; box-sizing: border-box; cursor: pointer; font: inherit; }

/* Opaque surface: solid app background with the elevated tint layered on top,
   so a translucent theme token never lets the reply text show through. */
.hic-surface {
  color: var(--dt-popover-foreground, var(--ui-text-primary, var(--foreground)));
  background-color: var(--background, Canvas); /* opaque base under a possibly translucent token */
  background-image: linear-gradient(var(--dt-popover, transparent), var(--dt-popover, transparent));
  border: 1px solid var(--ui-stroke-secondary, var(--border));
}
.hic-icon { width: 14px; height: 14px; flex: none; display: block; }

.hic-pill {
  display: inline-flex; align-items: center; gap: 6px;
  height: 26px; padding: 0 10px 0 8px; border-radius: 999px; user-select: none;
  font-size: 12px; font-weight: 500; line-height: 1;
  box-shadow: 0 4px 16px color-mix(in srgb, var(--foreground, #000) 22%, transparent);
}
.hic-pill .hic-icon { color: var(--ui-accent); }
.hic-pill:hover { border-color: var(--ui-accent); }

.hic-card {
  width: 300px; box-sizing: border-box; padding: 8px 8px 8px 10px; border-radius: 10px;
  border-color: var(--ui-stroke-tertiary, var(--ui-stroke-secondary, var(--border)));
  box-shadow: 0 6px 22px color-mix(in srgb, var(--foreground, #000) 20%, transparent);
  display: flex; flex-direction: column; gap: 6px;
}
.hic-edit {
  outline: none; border: 0; min-height: 20px; max-height: 180px; overflow-y: auto; padding-right: 2px;
  font-size: 13px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere;
  cursor: text;
}
.hic-edit:empty::before {
  content: attr(data-placeholder); color: var(--ui-text-quaternary, var(--ui-text-tertiary));
  pointer-events: none;
}
.hic-row { display: flex; align-items: center; gap: 6px; min-height: 24px; }
.hic-row .hic-spacer { flex: 1; }
.hic-iconbtn {
  display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 6px;
  color: var(--ui-text-tertiary);
}
.hic-iconbtn:hover { color: var(--ui-red, var(--ui-text-primary)); background: var(--ui-control-hover-background, color-mix(in srgb, currentColor 10%, transparent)); }
.hic-primary {
  display: inline-flex; align-items: center; height: 24px; padding: 0 12px; border-radius: 6px;
  font-size: 12px; font-weight: 600; line-height: 1;
  /* same tokens as the app's primary <Button> */
  color: var(--dt-primary-foreground, var(--background, Canvas));
  background: var(--dt-primary, var(--ui-accent));
}
.hic-primary:hover { filter: brightness(1.08); }
.hic-primary:active { filter: brightness(.95); }
.hic-primary[aria-disabled="true"] { opacity: .35; pointer-events: none; }

/* pending tray above the composer */
.hic-tray { display: flex; flex-direction: column; gap: 3px; padding: 6px 10px 2px; }
.hic-tray-head { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--ui-text-tertiary); }
.hic-tray-head .hic-spacer { flex: 1; }
.hic-link { font: inherit; font-size: 11px; background: none; border: 0; padding: 0; cursor: pointer; color: var(--ui-text-tertiary); }
.hic-link:hover { color: var(--ui-text-primary); }
.hic-link-accent { color: var(--ui-accent); }
.hic-item {
  display: flex; align-items: baseline; gap: 6px; box-sizing: border-box; width: 100%;
  padding: 2px 6px; border-radius: 6px; font-size: 12px; line-height: 1.35; cursor: pointer;
  background: color-mix(in srgb, var(--ui-accent, #888) 7%, transparent);
}
.hic-item:hover { background: color-mix(in srgb, var(--ui-accent, #888) 13%, transparent); }
.hic-file {
  flex: none; max-width: 30%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 0.85em; font-family: var(--font-mono, ui-monospace, monospace); padding: 0 4px; border-radius: 4px;
  color: var(--ui-text-secondary, var(--ui-text-tertiary));
  background: color-mix(in srgb, var(--ui-text-primary, currentColor) 8%, transparent);
}
.hic-item-quote { color: var(--ui-text-tertiary); flex: 0 1 45%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-style: italic; }
.hic-item-note { color: var(--ui-text-primary); flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hic-x { background: none; border: 0; cursor: pointer; padding: 0 2px; color: var(--ui-text-tertiary); font-size: 13px; line-height: 1; }
.hic-x:hover { color: var(--ui-red, var(--ui-text-primary)); }

/* sent-message rendering inside the user bubble */
${USER_TEXT_SEL}:has(+ [data-hic-render]) { display: none !important; }
/* Compact on purpose: core clamps sent bubbles to ~4 lines, so one line per
   comment keeps 3–4 comments visible. Full text: hover a row (title) or click
   the bubble to open it in the editor. */
.hic-msg { display: flex; flex-direction: column; white-space: normal; }
.hic-msg-text { white-space: pre-line; overflow-wrap: anywhere; }
.hic-msg-row { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.hic-msg-row .hic-icon { width: 12px; height: 12px; align-self: center; color: var(--ui-accent); }
.hic-msg-quote {
  flex: 0 1 auto; max-width: 45%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-style: italic; color: var(--ui-text-tertiary);
}
.hic-msg-sep { flex: none; color: var(--ui-text-quaternary, var(--ui-text-tertiary)); }
.hic-msg-note { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`

// ── plugin ─────────────────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Inline Comments',

  register(ctx) {
    // { [sessionKey]: Array<{ id, quote, note, at }> }
    const $pending = atom(ctx.storage.get('pending', {}) || {})
    const ranges = new Map() // comment id → live Range (in-memory)
    let lastSent = null // { key, comments }

    const save = next => {
      $pending.set(next)
      ctx.storage.set('pending', next)
    }
    const listFor = key => $pending.get()[key] || []
    const setList = (key, list) => {
      const next = { ...$pending.get() }
      if (list.length) next[key] = list
      else delete next[key]
      save(next)
    }

    // file: null = comment on an agent reply, else the previewed file's absolute path.
    const addComment = (quote, note, range, file = null) => {
      const key = sessionKey()
      const c = { id: uid(), quote: quote.trim(), note: note.trim(), file, at: Date.now() }
      if (range) ranges.set(c.id, range)
      setList(key, [...listFor(key), c])
    }
    const updateComment = (id, note) => {
      const key = sessionKey()
      setList(key, listFor(key).map(c => (c.id === id ? { ...c, note } : c)))
    }
    const removeComment = id => {
      const key = sessionKey()
      ranges.delete(id)
      setList(key, listFor(key).filter(c => c.id !== id))
    }
    const clearAll = () => {
      const key = sessionKey()
      for (const c of listFor(key)) ranges.delete(c.id)
      setList(key, [])
    }
    const take = () => {
      const key = sessionKey()
      const list = listFor(key)
      if (!list.length) return null
      for (const c of list) ranges.delete(c.id)
      setList(key, [])
      lastSent = { key, comments: list }
      return list
    }
    const restoreLastSent = () => {
      if (!lastSent) return host.notify({ kind: 'info', message: 'No sent comments to restore.' })
      setList(lastSent.key, [...lastSent.comments, ...listFor(lastSent.key)])
      host.notify({ kind: 'info', message: `Restored ${lastSent.comments.length} comment(s).` })
      lastSent = null
    }
    const sendCommentsOnly = () => {
      const list = take()
      if (!list) return false
      const ok = host.composer.submit(null, formatComments(list, ''))
      if (!ok) {
        setList(lastSent.key, [...list, ...listFor(lastSent.key)])
        host.notify({ kind: 'error', message: 'Could not send comments (no active composer).' })
      }
      return ok
    }

    /** Live range for a comment: cached if still valid, else re-found by text. */
    const liveRange = c => {
      const cached = ranges.get(c.id)
      if (cached && cached.startContainer?.isConnected && cached.endContainer?.isConnected && cached.toString().trim()) return cached
      const roots =
        c.file == null
          ? [...document.querySelectorAll(ASSISTANT_SEL)].reverse()
          : [...document.querySelectorAll(FILE_SEL)].filter(r => fileOf(r) === c.file)
      for (const root of roots) {
        const r = locate(root, c.quote)
        if (r) {
          ranges.set(c.id, r)
          return r
        }
      }
      ranges.delete(c.id)
      return null
    }

    // ── stylesheet + highlights ──
    const style = el('style', { 'data-plugin': ID, text: STYLES })
    document.head.appendChild(style)
    ctx.onDispose(() => style.remove())

    const hasHighlights = Boolean(window.CSS && 'highlights' in window.CSS && typeof window.Highlight === 'function')
    const paintHighlights = () => {
      if (!hasHighlights) return
      const live = listFor(sessionKey()).map(liveRange).filter(Boolean)
      if (live.length) window.CSS.highlights.set(HIGHLIGHT, new window.Highlight(...live))
      else window.CSS.highlights.delete(HIGHLIGHT)
    }
    ctx.onDispose($pending.subscribe(paintHighlights))
    if (host.state.focusedStoredSessionId?.subscribe) ctx.onDispose(host.state.focusedStoredSessionId.subscribe(paintHighlights))
    ctx.onDispose(() => hasHighlights && window.CSS.highlights.delete(HIGHLIGHT))

    /** The pending comment whose highlight is under (x, y), or null. */
    const commentAt = (target, x, y) => {
      if (!commentRoot(target)) return null
      for (const c of listFor(sessionKey())) {
        const r = liveRange(c)
        if (r && rangeContains(r, x, y)) return { c, r }
      }
      return null
    }

    // ── floating layer: pill + editor card (body-level, plain DOM) ──
    const layer = el('div', { class: 'hic-layer' })
    layer.style.display = 'none'
    document.body.appendChild(layer)
    ctx.onDispose(() => layer.remove())

    let mode = 'hidden' // hidden | pill | editor
    let anchor = null // () => DOMRect
    let prefer = 'above'

    const hide = () => {
      mode = 'hidden'
      anchor = null
      layer.style.display = 'none'
      layer.replaceChildren()
    }

    const place = () => {
      if (!anchor) return
      const rect = anchor()
      const node = layer.firstElementChild
      const w = node?.offsetWidth || 300
      const h = node?.offsetHeight || 80
      const vw = window.innerWidth
      const vh = window.innerHeight
      const left = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), vw - w - 8)
      const above = rect.top - h - 6
      const below = rect.bottom + 6
      let top = prefer === 'below' ? (below + h <= vh - 8 ? below : above) : above >= 8 ? above : below
      top = Math.min(Math.max(8, top), vh - h - 8)
      layer.style.left = `${Math.round(left)}px`
      layer.style.top = `${Math.round(top)}px`
    }

    const showPill = snap => {
      mode = 'pill'
      prefer = 'above'
      anchor = () => snap.rect
      const pill = el('button', {
        type: 'button',
        class: 'hic-pill hic-surface',
        title: 'Add a comment on this to your next reply (Ctrl/Cmd+Alt+C)',
        // mousedown, not click: keep the selection alive.
        onmousedown: e => {
          e.preventDefault()
          e.stopPropagation()
          openNew(snap)
        }
      }, [icon('commentAdd'), el('span', { text: 'Add to reply' })])
      layer.replaceChildren(pill)
      layer.style.display = 'block'
      place()
    }

    /** Editor card. opts: { getRect, note, primary, onSave(note), onDelete? } */
    const openEditor = opts => {
      mode = 'editor'
      prefer = 'below'
      anchor = opts.getRect

      const ed = el('div', {
        class: 'hic-edit',
        contenteditable: 'plaintext-only',
        role: 'textbox',
        'aria-multiline': 'true',
        'data-placeholder': 'Add a comment'
      })
      ed.textContent = opts.note || ''

      const primary = el('button', { type: 'button', class: 'hic-primary', text: opts.primary })
      const value = () => editableText(ed).trim()
      const sync = () => {
        if (!editableText(ed).trim() && ed.childNodes.length) ed.replaceChildren() // keep :empty placeholder working
        primary.setAttribute('aria-disabled', value() ? 'false' : 'true')
        place()
      }

      const commit = () => {
        const note = value()
        if (!note) return
        opts.onSave(note)
        hide()
      }

      ed.addEventListener('input', sync)
      ed.addEventListener('paste', e => {
        // plaintext-only already strips formatting; this covers older engines.
        const text = e.clipboardData?.getData('text/plain')
        if (text == null) return
        e.preventDefault()
        document.execCommand?.('insertText', false, text)
      })
      ed.addEventListener('keydown', e => {
        e.stopPropagation() // keep app shortcuts / type-to-focus out of the editor
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          hide()
        }
      })
      primary.addEventListener('click', commit)

      const card = el(
        'div',
        { class: 'hic-card hic-surface', onmousedown: e => e.stopPropagation(), onpointerdown: e => e.stopPropagation() },
        [
          ed,
          el('div', { class: 'hic-row' }, [
            opts.onDelete
              ? el(
                  'button',
                  {
                    type: 'button',
                    class: 'hic-iconbtn',
                    title: 'Delete comment',
                    'aria-label': 'Delete comment',
                    onclick: () => {
                      opts.onDelete()
                      hide()
                    }
                  },
                  [icon('trash')]
                )
              : null,
            el('span', { class: 'hic-spacer' }),
            primary
          ])
        ]
      )

      layer.replaceChildren(card)
      layer.style.display = 'block'
      sync()
      ctx.setTimeout(() => {
        if (!ed.isConnected) return
        ed.focus()
        const sel = window.getSelection()
        if (sel && ed.firstChild) {
          const r = document.createRange()
          r.selectNodeContents(ed)
          r.collapse(false)
          sel.removeAllRanges()
          sel.addRange(r)
        }
      }, 0)
    }

    const rectOf = (range, fallback) => () => {
      const r = range.getBoundingClientRect()
      return r.width || r.height ? r : fallback || r
    }

    const openNew = snap => {
      openEditor({
        getRect: rectOf(snap.range, snap.rect),
        note: '',
        primary: 'Add',
        onSave: note => {
          addComment(snap.text, note, snap.range, snap.file)
          window.getSelection()?.removeAllRanges()
        }
      })
    }

    const openEdit = (c, range) => {
      openEditor({
        getRect: rectOf(range),
        note: c.note,
        primary: 'Save',
        onSave: note => updateComment(c.id, note),
        onDelete: () => removeComment(c.id)
      })
    }

    // Selection → pill.
    ctx.addEventListener(document, 'mouseup', e => {
      if (layer.contains(e.target) || mode === 'editor') return
      ctx.setTimeout(() => {
        const snap = readSelection()
        if (snap) showPill(snap)
        else if (mode === 'pill') hide()
      }, 0)
    })
    ctx.addEventListener(
      document,
      'mousedown',
      e => {
        if (mode !== 'hidden' && !layer.contains(e.target)) hide()
      },
      { capture: true }
    )
    // Click on a highlight → edit that comment.
    ctx.addEventListener(document, 'click', e => {
      if (e.button !== 0 || layer.contains(e.target)) return
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed && sel.toString().trim()) return // finishing a drag-select
      if (e.target.closest?.('a, button')) return
      const hit = commentAt(e.target, e.clientX, e.clientY)
      if (hit) openEdit(hit.c, hit.r)
    })
    // Pointer cursor over highlights.
    let hoverRoot = null
    let hoverQueued = false
    let lastMove = null
    ctx.addEventListener(
      document,
      'mousemove',
      e => {
        lastMove = e
        if (hoverQueued) return
        hoverQueued = true
        requestAnimationFrame(() => {
          hoverQueued = false
          const ev = lastMove
          const root = commentRoot(ev.target)
          const over = root && listFor(sessionKey()).length ? commentAt(ev.target, ev.clientX, ev.clientY) : null
          if (hoverRoot && (hoverRoot !== root || !over)) {
            hoverRoot.removeAttribute('data-hic-hover')
            hoverRoot = null
          }
          if (over && root) {
            root.setAttribute('data-hic-hover', '')
            hoverRoot = root
          }
        })
      },
      { passive: true }
    )
    ctx.onDispose(() => hoverRoot?.removeAttribute('data-hic-hover'))

    ctx.addEventListener(document, 'selectionchange', () => {
      if (mode === 'pill' && !readSelection()) hide()
    })
    ctx.addEventListener(window, 'resize', () => (mode === 'pill' ? hide() : place()))
    ctx.addEventListener(document, 'scroll', () => (mode === 'pill' ? hide() : place()), { capture: true, passive: true })

    // Empty composer + Enter with pending comments → send the comments alone.
    ctx.addEventListener(
      document,
      'keydown',
      e => {
        if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return
        const input = e.target instanceof Element ? e.target.closest(COMPOSER_INPUT_SEL) : null
        if (!input) return
        if ((input.textContent || '').trim()) return
        if (input.querySelector('[data-slot*="chip"], img')) return
        if (!listFor(sessionKey()).length) return
        e.preventDefault()
        e.stopImmediatePropagation()
        sendCommentsOnly()
      },
      { capture: true }
    )

    // ── composer middleware: append pending comments to any real send ──
    ctx.register({
      id: 'attach',
      area: COMPOSER_AREAS.middleware,
      data: {
        handler: draft => {
          const text = draft.text || ''
          if (text.trim().startsWith('/')) return draft
          const list = take()
          if (!list) return draft
          return { ...draft, text: formatComments(list, text) }
        }
      }
    })

    // ── pending tray above the composer (read-only; click = jump to highlight) ──
    const swallow = e => {
      e.preventDefault()
      e.stopPropagation()
    }
    const reveal = c => {
      const r = liveRange(c)
      if (!r)
        return host.notify({
          kind: 'info',
          message: c.file == null ? 'That text is no longer on screen.' : `Open ${baseName(c.file)} to see this comment.`
        })
      const node = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement
      node?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    }

    function PendingItem({ c }) {
      return jsxs('div', {
        className: 'hic-item',
        title: `${c.file == null ? '' : `${displayPath(c.file)}\n`}${c.note}\n\nClick to show it — click the highlight there to edit.`,
        onPointerDown: swallow,
        onMouseDown: swallow,
        onClick: e => {
          e.stopPropagation()
          reveal(c)
        },
        children: [
          c.file == null ? null : jsx('span', { className: 'hic-file', children: baseName(c.file) }),
          jsx('span', { className: 'hic-item-quote', children: `“${oneLine(c.quote, 80)}”` }),
          jsx('span', { className: 'hic-item-note', children: c.note }),
          jsx('button', {
            type: 'button',
            className: 'hic-x',
            title: 'Remove comment',
            onPointerDown: swallow,
            onMouseDown: swallow,
            onClick: e => {
              e.stopPropagation()
              removeComment(c.id)
            },
            children: '×'
          })
        ]
      })
    }

    function PendingTray() {
      const all = useValue($pending)
      useValue(host.state.focusedStoredSessionId)
      const list = all[sessionKey()] || []
      if (!list.length) return null

      return jsxs('div', {
        className: 'hic-tray',
        children: [
          jsxs('div', {
            className: 'hic-tray-head',
            children: [
              jsxs('span', {
                style: { display: 'inline-flex', alignItems: 'center', gap: 5 },
                children: [jsx(Icon, { name: 'commentAdd' }), `${list.length} comment${list.length > 1 ? 's' : ''} will be added to your next message`]
              }),
              jsx('span', { className: 'hic-spacer' }),
              jsx('button', {
                type: 'button',
                className: 'hic-link hic-link-accent',
                title: 'Send only the comments (or press Enter in an empty composer)',
                onClick: sendCommentsOnly,
                children: 'Send comments'
              }),
              jsx('button', { type: 'button', className: 'hic-link', onClick: clearAll, children: 'Clear' })
            ]
          }),
          ...list.map(c => jsx(PendingItem, { c }, c.id))
        ]
      })
    }

    ctx.register({ id: 'tray', area: COMPOSER_AREAS.top, render: () => jsx(PendingTray, {}) })

    // ── render comment blocks in sent user bubbles ──
    // User bubbles are plain text, so we draw a sibling view next to core's text
    // span and hide the span via CSS (:has). Core's span is never mutated.
    const buildRender = parsed =>
      el('div', { class: 'hic-msg', 'data-hic-render': '' }, [
        parsed.text ? el('div', { class: 'hic-msg-text', text: parsed.text }) : null,
        ...parsed.comments.map(c =>
          el('div', { class: 'hic-msg-row', title: `${c.file == null ? '' : `${c.file === UNKNOWN_FILE ? 'open file' : c.file}\n`}“${c.quote}”\n↳ ${c.note}` }, [
            icon('commentAdd'),
            c.file == null ? null : el('span', { class: 'hic-file', text: baseName(c.file) }),
            el('span', { class: 'hic-msg-quote', text: `“${oneLine(c.quote, 200)}”` }),
            el('span', { class: 'hic-msg-sep', text: '→' }),
            el('span', { class: 'hic-msg-note', text: oneLine(c.note, 400) })
          ])
        )
      ])

    const enhance = span => {
      const raw = span.textContent || ''
      const next = span.nextElementSibling
      const existing = next && next.hasAttribute('data-hic-render') ? next : null
      if (existing && existing.__hicRaw === raw) return
      const parsed = parseMessage(raw)
      if (!parsed) {
        existing?.remove()
        return
      }
      const view = buildRender(parsed)
      view.__hicRaw = raw
      if (existing) existing.replaceWith(view)
      else span.after(view)
    }

    let scheduled = false
    const tick = () => {
      scheduled = false
      for (const span of document.querySelectorAll(USER_TEXT_SEL)) enhance(span)
      for (const v of document.querySelectorAll('[data-hic-render]')) {
        const prev = v.previousElementSibling
        if (!prev || !prev.matches(USER_TEXT_SEL)) v.remove()
      }
      paintHighlights() // re-anchor highlights after transcript re-renders
    }
    const schedule = () => {
      if (scheduled) return
      scheduled = true
      ctx.setTimeout(tick, 150)
    }
    const mo = new MutationObserver(muts => {
      for (const m of muts) {
        const t = m.target.nodeType === 1 ? m.target : m.target.parentElement
        if (t && t.closest?.('[data-hic-render], .hic-layer')) continue
        schedule()
        return
      }
    })
    mo.observe(document.body, { childList: true, subtree: true, characterData: true })
    ctx.onDispose(() => mo.disconnect())
    ctx.onDispose(() => document.querySelectorAll('[data-hic-render]').forEach(n => n.remove()))
    tick()

    // ── keybind + palette ──
    const commentOnSelection = () => {
      const snap = readSelection()
      if (!snap) return host.notify({ kind: 'info', message: 'Select text in an agent reply or an open file first.' })
      openNew(snap)
    }

    ctx.registerMany([
      {
        id: 'comment-key',
        area: KEYBINDS_AREA,
        data: { id: `${ID}.comment`, label: 'Add selected text to reply (comment)', defaults: ['mod+alt+c'], run: commentOnSelection }
      },
      {
        id: 'palette-send',
        area: PALETTE_AREA,
        data: {
          id: `${ID}.send`,
          label: 'Inline Comments: Send pending comments',
          keywords: ['comment', 'notes', 'review'],
          run: sendCommentsOnly
        }
      },
      {
        id: 'palette-clear',
        area: PALETTE_AREA,
        data: { id: `${ID}.clear`, label: 'Inline Comments: Clear pending comments', keywords: ['comment', 'notes'], run: clearAll }
      },
      {
        id: 'palette-restore',
        area: PALETTE_AREA,
        data: {
          id: `${ID}.restore`,
          label: 'Inline Comments: Restore last sent comments',
          keywords: ['comment', 'undo'],
          run: restoreLastSent
        }
      }
    ])

    ctx.onDispose(hide)
  }
}
