/**
 * Tiny DOM helpers for the side panel.
 * No framework, no build step — the panel is small enough that plain DOM is
 * clearer than a runtime dependency.
 */

/** Escape text destined for innerHTML. */
export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function $(selector, root = document) { return root.querySelector(selector); }
export function $$(selector, root = document) { return Array.from(root.querySelectorAll(selector)); }

/** Set a view's HTML then wire its events. */
export function render(el, html) {
  if (el) el.innerHTML = html;
  return el;
}

/** Delegated click binding — survives re-renders. */
export function onClick(root, selector, handler) {
  root.addEventListener('click', (e) => {
    const target = e.target.closest(selector);
    if (target && root.contains(target)) handler(e, target);
  });
}

let toastTimer = null;

export function toast(message, kind = '') {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.className = `toast show ${kind}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, kind === 'error' ? 6500 : 3600);
}

export function fmtNumber(n) {
  const v = Number(n) || 0;
  return v.toLocaleString();
}

export function scoreClass(score) {
  const n = Number(score) || 0;
  if (n >= 70) return 'hi';
  if (n >= 40) return 'mid';
  return 'lo';
}

export function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** A stat tile. */
export function stat(value, label, kind = '') {
  return `<div class="stat ${kind}"><div class="v">${esc(fmtNumber(value))}</div><div class="k">${esc(label)}</div></div>`;
}

export function banner(kind, html) {
  return `<div class="banner ${kind}">${html}</div>`;
}

export function empty(icon, text) {
  return `<div class="empty"><div class="big">${icon}</div>${text}</div>`;
}

/* ------------------------------------------------------------------ *
 * v3 additions
 * ------------------------------------------------------------------ */

/** "4 seconds ago" — used by the heartbeat display. */
export function agoShort(ts, now = Date.now()) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** A coverage row: label, found/total, and a proportional bar. */
export function coverageRow(row) {
  const pct = row.total ? row.percent : 0;
  return `
  <div class="cov">
    <span class="cov-label">${esc(row.label)}</span>
    <span class="cov-bar"><i style="width:${pct}%"></i></span>
    <span class="cov-num">${row.found} / ${row.total}</span>
  </div>`;
}

/** Field-status chip for the Data table: ✓ Found / — Not available / ⏳ Pending / ⚠ Error. */
export function statusChip(status) {
  const map = {
    Found: ['ok', '✓'],
    'Not Found': ['muted', '—'],
    'Not Requested': ['muted', '·'],
    Pending: ['pending', '⏳'],
    Failed: ['bad', '⚠'],
  };
  const [cls, glyph] = map[status] || ['muted', '—'];
  return `<span class="st-chip ${cls}" data-status="${esc(status)}" title="${esc(status)}">${glyph}</span>`;
}

/** Number input with a label, used all over the Filter view. */
export function numberField(label, attrs) {
  const a = Object.entries(attrs || {}).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
  return `<label class="field grow"><span>${esc(label)}</span><input type="number" ${a}></label>`;
}
