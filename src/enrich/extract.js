/**
 * Pure extraction from fetched HTML — no network, no chrome APIs.
 * Kept separate from the fetching code so it is fully unit-testable.
 */
import { isPlausibleEmail } from '../collector/validators.js';
import { normalizeSocialUrl, socialPlatform, normalizeEmail } from '../engines/normalize.js';
import { SOCIAL_KEYS } from '../core/constants.js';

/* ----------------------------- EMAIL ----------------------------- */

const EMAIL_SCAN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * Pull public business email addresses out of a page.
 * Prefers `mailto:` links (an explicit publication) over loose text matches.
 * Returns the best candidate plus everything found, never an invented address.
 */
export function extractEmails(html, siteHost = '') {
  if (!html || typeof html !== 'string') return { best: '', all: [] };

  const found = new Map();   // email -> score

  const consider = (raw, bonus) => {
    const email = normalizeEmail(raw);
    if (!email || !isPlausibleEmail(email)) return;
    const prev = found.get(email) || 0;
    found.set(email, Math.max(prev, bonus));
  };

  // 1. mailto: links — the strongest signal.
  const mailto = /href\s*=\s*["']\s*mailto:([^"'?>]+)/gi;
  let m;
  while ((m = mailto.exec(html)) !== null) consider(decodeURIComponent(m[1]), 100);

  // 2. Simple obfuscations sites use to dodge scrapers.
  const deobfuscated = html
    .replace(/\s*\(\s*at\s*\)\s*/gi, '@')
    .replace(/\s*\[\s*at\s*\]\s*/gi, '@')
    .replace(/\s+at\s+(?=[\w-]+\s*(?:\.|\[dot\]|\(dot\))\s*[a-z]{2,})/gi, '@')
    .replace(/\s*\(\s*dot\s*\)\s*/gi, '.')
    .replace(/\s*\[\s*dot\s*\]\s*/gi, '.');

  // 3. Loose scan over the de-obfuscated text.
  const text = deobfuscated.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  while ((m = EMAIL_SCAN.exec(text)) !== null) consider(m[0], 10);

  if (!found.size) return { best: '', all: [] };

  const host = String(siteHost || '').toLowerCase().replace(/^www\./, '');
  const rank = (email) => {
    let score = found.get(email) || 0;
    const [local, domain] = email.split('@');
    // An address on the business's own domain is far more likely to be theirs.
    if (host && (domain === host || domain.endsWith(`.${host}`) || host.endsWith(`.${domain}`))) score += 60;
    // Role addresses beat personal ones for lead-gen purposes.
    if (/^(info|contact|hello|hi|sales|enquiries|inquiries|office|admin|support|team|mail|reception|bookings)$/i.test(local)) score += 25;
    if (/^(noreply|no-reply|donotreply|postmaster|abuse|webmaster|privacy|legal|jobs|careers|press)$/i.test(local)) score -= 40;
    // Generic free-mail domains are weaker but still valid business contacts.
    if (/^(gmail|yahoo|hotmail|outlook|aol|icloud|proton(mail)?)\./.test(`${domain}.`)) score -= 5;
    return score;
  };

  const all = [...found.keys()].sort((a, b) => rank(b) - rank(a));
  const best = rank(all[0]) > -20 ? all[0] : '';
  return { best, all: all.slice(0, 10) };
}

/* ----------------------------- SOCIAL ---------------------------- */

/**
 * Collect social profile URLs from a page's anchors.
 * Only real profile URLs survive `normalizeSocialUrl` — share widgets,
 * intent links, Google redirects and tracking pixels are dropped.
 */
export function extractSocials(html) {
  const out = {};
  const counts = {};
  if (!html || typeof html !== 'string') return out;

  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    let href = m[1].trim();
    if (href.startsWith('//')) href = `https:${href}`;
    if (!/^https?:\/\//i.test(href)) continue;

    const platform = socialPlatform(href);
    if (!platform || !SOCIAL_KEYS.includes(platform)) continue;

    const normalized = normalizeSocialUrl(href);
    if (!normalized) continue;

    counts[platform] = counts[platform] || new Map();
    counts[platform].set(normalized, (counts[platform].get(normalized) || 0) + 1);
  }

  // Pick the most-repeated URL per platform — that is almost always the
  // header/footer profile link rather than a one-off mention.
  for (const [platform, map] of Object.entries(counts)) {
    const best = [...map.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) out[platform] = best[0];
  }
  return out;
}

/* ---------------------------- LINK PICK -------------------------- */

/** Candidate contact/about pages linked from a homepage, same-origin only. */
export function findContactLinks(html, baseUrl, limit = 3) {
  if (!html || !baseUrl) return [];
  let origin;
  try { origin = new URL(baseUrl).origin; } catch { return []; }

  const wanted = /(contact|about|impressum|kontakt|reach-us|get-in-touch|connect|support|team)/i;
  const seen = new Set();
  const out = [];

  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = hrefRe.exec(html)) !== null && out.length < limit) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith('#') || /^(mailto|tel|javascript):/i.test(raw)) continue;
    if (!wanted.test(raw)) continue;

    let abs;
    try { abs = new URL(raw, baseUrl); } catch { continue; }
    if (abs.origin !== origin) continue;                  // never leave the site
    if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|mp4|css|js)$/i.test(abs.pathname)) continue;

    abs.hash = '';
    const key = abs.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Conventional fallback paths, used only when no contact link was found. */
export function guessContactUrls(baseUrl) {
  let origin;
  try { origin = new URL(baseUrl).origin; } catch { return []; }
  return ['/contact', '/contact-us', '/about', '/about-us', '/pages/contact']
    .map((p) => `${origin}${p}`);
}
