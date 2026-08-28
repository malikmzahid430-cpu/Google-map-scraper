/**
 * Minimal DOM implementation for testing the collector in Node.
 *
 * Not a general-purpose DOM — it implements exactly the surface the collector
 * touches, with a real CSS selector matcher for the subset used in
 * selectors.js. This exists so the Start / Pause / Resume / Stop / scroll
 * behaviour can be exercised for real, with no third-party dependency.
 */

let idSeq = 0;

export class El {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = String(tag).toUpperCase();
    this.attributes = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this._text = '';
    this._uid = ++idSeq;
    this.isConnected = true;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    for (const c of children) this.append(c);
  }

  append(child) {
    if (typeof child === 'string') { this._text += child; return this; }
    child.parentElement = this;
    this.children.push(child);
    return this;
  }

  remove() {
    if (!this.parentElement) return;
    const i = this.parentElement.children.indexOf(this);
    if (i >= 0) this.parentElement.children.splice(i, 1);
    this.parentElement = null;
    this.isConnected = false;
  }

  getAttribute(name) {
    const v = this.attributes[name];
    return v === undefined ? null : v;
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }

  get className() { return this.attributes.class || ''; }
  get id() { return this.attributes.id || ''; }
  get href() { return this.attributes.href || ''; }

  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }

  /** innerText approximates block layout with newlines between children. */
  get innerText() {
    const parts = [];
    if (this._text) parts.push(this._text);
    for (const c of this.children) {
      const t = c.innerText;
      if (t) parts.push(t);
    }
    return parts.join('\n').replace(/\n{2,}/g, '\n').trim();
  }

  get lastChild() { return this.children[this.children.length - 1] || null; }

  descendants(out = []) {
    for (const c of this.children) { out.push(c); c.descendants(out); }
    return out;
  }

  matches(selector) { return matchesSelector(this, selector); }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches && node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  querySelectorAll(selector) {
    const groups = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const g of groups) {
      for (const el of matchComplex(this, g)) {
        if (!seen.has(el._uid)) { seen.add(el._uid); out.push(el); }
      }
    }
    return out;
  }
}

/* -------------------------- selector engine -------------------------- */

/** One compound selector: tag, #id, .class, [attr], [attr=v], [attr*=v], [attr^=v]. */
function matchesSelector(el, compound) {
  if (!el || !compound) return false;
  const s = compound.trim();

  if (s.includes(':has(')) {
    // Old Chrome does not support :has(). Throwing here exercises the
    // queryFirst() fallback path in dom.js exactly as a real browser would.
    const err = new Error(`unsupported pseudo-class in "${s}"`);
    err.name = 'SyntaxError';
    throw err;
  }
  if (/:nth-child\(/.test(s)) {
    const m = s.match(/^(.*?):nth-child\((\d+)\)$/);
    if (!m) return false;
    if (!el.parentElement) return false;
    const index = el.parentElement.children.indexOf(el) + 1;
    if (index !== Number(m[2])) return false;
    return m[1] ? matchesSelector(el, m[1]) : true;
  }

  const tokens = s.match(/^[a-zA-Z][\w-]*|#[\w-]+|\.[\w-]+|\[[^\]]+\]/g);
  if (!tokens) return false;
  const consumed = tokens.join('');
  if (consumed.length !== s.length) return false;

  for (const token of tokens) {
    if (token.startsWith('#')) {
      if (el.id !== token.slice(1)) return false;
    } else if (token.startsWith('.')) {
      if (!el.className.split(/\s+/).includes(token.slice(1))) return false;
    } else if (token.startsWith('[')) {
      if (!matchAttr(el, token.slice(1, -1))) return false;
    } else if (el.tagName !== token.toUpperCase()) {
      return false;
    }
  }
  return true;
}

function matchAttr(el, body) {
  const m = body.match(/^([\w-]+)\s*(\^=|\*=|\$=|=)?\s*(.*)$/);
  if (!m) return false;
  const [, name, op, rawValue] = m;
  const actual = el.getAttribute(name);
  if (actual == null) return false;
  if (!op) return true;
  const value = rawValue.replace(/^["']|["']$/g, '');
  if (op === '=') return actual === value;
  if (op === '*=') return actual.includes(value);
  if (op === '^=') return actual.startsWith(value);
  if (op === '$=') return actual.endsWith(value);
  return false;
}

/** Complex selector with descendant and > combinators. */
function matchComplex(root, selector) {
  const parts = selector.split(/\s+/).filter(Boolean);
  let current = root.descendants();

  // Rebuild honouring combinators, left to right.
  const steps = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '>') { steps.push({ combinator: 'child', sel: parts[++i] }); }
    else steps.push({ combinator: 'descendant', sel: parts[i] });
  }

  let candidates = null;
  for (const step of steps) {
    const scope = candidates === null ? [root] : candidates;
    const next = [];
    for (const node of scope) {
      const pool = step.combinator === 'child' ? node.children : node.descendants();
      for (const el of pool) {
        if (matchesSelector(el, step.sel)) next.push(el);
      }
    }
    candidates = next;
    if (!candidates.length) break;
  }
  return candidates || [];
}

/* ---------------------------- document ------------------------------- */

export function installDom() {
  const root = new El('body');
  const doc = {
    body: root,
    documentElement: root,
    querySelector: (s) => root.querySelector(s),
    querySelectorAll: (s) => root.querySelectorAll(s),
    createElement: (t) => new El(t),
  };
  globalThis.document = doc;
  globalThis.location = { href: 'https://www.google.com/maps/search/roofing+jacksonville', pathname: '/maps/search/roofing+jacksonville' };
  return { doc, root };
}

/* --------------------- Google Maps feed builder ---------------------- */

let placeSeq = 0;

/**
 * Build one realistic results card.
 * `website`/`phone` are optional — pass them to simulate Google rendering a
 * quick-action button directly on the card (what card-parser.js's
 * CARD_WEBSITE/CARD_PHONE selectors read); omit them to simulate a card that
 * doesn't expose them, same as any real result that only has these fields
 * available later, via detail resolution.
 */
export function makeCard({
  name, category, rating, reviews, street, open = true, website = '', phone = '', phoneText = '',
  layout = 'combined',
} = {}) {
  placeSeq += 1;
  const slug = String(name).replace(/[^A-Za-z0-9]+/g, '+');
  const href = `https://www.google.com/maps/place/${slug}/@30.2${placeSeq},-81.7${placeSeq},17z/data=!4m6!3m5!1s0x88e5b3f0a1b2c${String(placeSeq).padStart(3, '0')}:0x9f2a3b4c5d6e7f${String(placeSeq).padStart(2, '0')}!8m2!3d30.2${placeSeq}!4d-81.7${placeSeq}`;

  const link = new El('a', { href, 'aria-label': name });
  const heading = new El('div', { class: 'fontHeadlineSmall', role: 'heading' });
  heading.append(name);

  const star = new El('span', { role: 'img', 'aria-label': `${rating} stars ${reviews} Reviews` });
  const ratingText = new El('span', { class: 'MW4etd' });
  ratingText.append(String(rating));

  const body = new El('div', { class: 'fontBodyMedium' });
  body.append(new El('div').append(name));
  body.append(new El('div').append(`${rating} (${reviews})`));
  if (layout === 'separate') {
    // Some Maps rollouts render category and street as two independent
    // rows instead of one "category · street" middot-joined line.
    body.append(new El('div').append(category));
    body.append(new El('div').append(street));
  } else {
    body.append(new El('div').append(`${category} · ${street}`));
  }
  if (open) body.append(new El('div').append('Open ⋅ Closes 5 PM'));
  // Some Maps rollouts print the phone number as plain visible text (often
  // sharing a row with hours/status) instead of a dedicated button/anchor —
  // no data-item-id, no tel: href, nothing but the text itself.
  if (phoneText) body.append(new El('div').append(phoneText));

  const card = new El('div', { jsaction: 'pane.card', class: 'Nv2PK' });
  card.append(link);
  card.append(heading);
  card.append(star);
  card.append(ratingText);
  card.append(body);
  if (website) card.append(new El('a', { 'data-item-id': 'authority', href: website }));
  if (phone) card.append(new El('button', { 'data-item-id': `phone:tel:${phone}` }));
  return card;
}

/**
 * Build a Maps-shaped feed.
 * Structure mirrors the real one: [role=feed] > div > div[jsaction]
 */
export function makeFeed(cards = []) {
  const feed = new El('div', { role: 'feed', 'aria-label': 'Results for roofing' });
  feed.clientHeight = 800;
  feed.scrollHeight = 800 + cards.length * 120;
  const inner = new El('div');
  feed.append(inner);
  for (const c of cards) inner.append(c);
  feed.__inner = inner;
  return feed;
}

export function addCardsToFeed(feed, cards) {
  for (const c of cards) feed.__inner.append(c);
  feed.scrollHeight = 800 + feed.__inner.children.length * 120;
}

export function markEndOfList(feed) {
  const sentinel = new El('div');
  sentinel.append("You've reached the end of the list.");
  feed.__inner.append(sentinel);
}

export function sampleBusinesses(n, offset = 0) {
  const names = ['Al-Aqsa Roofing', 'Summit Roof Co', 'Coastal Roofing', 'First Coast Roofers',
    'Duval Roofing', 'Peak Exteriors', 'Riverside Roof', 'Northside Roofing',
    'Bold City Roofing', 'Atlantic Roof Works'];
  const cats = ['Roofing contractor', 'Roofer', 'Construction company'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = offset + i;
    out.push(makeCard({
      name: `${names[idx % names.length]} ${Math.floor(idx / names.length) + 1}`,
      category: cats[idx % cats.length],
      rating: (4 + ((idx % 10) / 10)).toFixed(1),
      reviews: String(7 + idx * 13),
      street: `${6215 + idx}-1 Wilson Blvd`,
    }));
  }
  return out;
}

/* ==================================================================== *
 * VIRTUALIZED FEED
 *
 * Reproduces the behaviour that broke v2: Google Maps recycles result nodes,
 * so the rendered card list is a moving WINDOW over the full result set. Cards
 * scroll off the top and are removed from the DOM while new ones append at the
 * bottom, and the array length stays roughly constant.
 * ==================================================================== */

/**
 * @param {object} opts
 * @param {number} opts.total        how many places exist in total
 * @param {number} opts.windowSize   how many are rendered at once
 * @param {number} opts.batch        how many new ones appear per scroll
 * @param {number} opts.stallEvery   every Nth scroll produces nothing (Maps pausing)
 */
export function makeVirtualFeed({ total = 60, windowSize = 20, batch = 8, stallEvery = 0 } = {}) {
  const all = sampleBusinesses(total);
  const feed = makeFeed([]);
  feed.clientHeight = 800;

  const view = { start: 0, end: Math.min(windowSize, total) };
  let scrolls = 0;

  const render = () => {
    feed.__inner.children.length = 0;
    for (let i = view.start; i < view.end; i++) {
      const card = all[i];
      card.parentElement = feed.__inner;
      feed.__inner.children.push(card);
    }
    // Height reflects the whole list, as a real virtualized feed reports.
    feed.scrollHeight = 800 + view.end * 120;
  };
  render();

  Object.defineProperty(feed, 'scrollTop', {
    get() { return this.__scrollTop || 0; },
    set(v) {
      this.__scrollTop = v;
      scrolls += 1;
      if (stallEvery && scrolls % stallEvery === 0) return;   // Maps pauses
      if (view.end >= total) {
        if (!this.__ended) { this.__ended = true; markEndOfList(this); }
        return;
      }
      view.end = Math.min(view.end + batch, total);
      // Recycle from the top — this is what invalidates a positional cursor.
      view.start = Math.max(0, view.end - windowSize);
      render();
    },
    configurable: true,
  });

  feed.__debug = () => ({ ...view, total, scrolls });
  return feed;
}
