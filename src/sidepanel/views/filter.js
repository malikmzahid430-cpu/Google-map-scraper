/**
 * FILTER view — rating, reviews, dynamic categories, availability, quality,
 * location. Everything combines with AND; categories OR within themselves.
 *
 * Category and location options are built from the ACTUAL dataset, never
 * hard-coded, so they update as new jobs arrive.
 */
import { AVAILABILITY } from '../../engines/filters.js';
import { esc, onClick } from '../ui.js';

export function renderFilter(state) {
  const f = state.facets();
  const c = state.criteria;
  const shown = state.visibleRecords().length;
  const total = state.records.length;

  return `
  <div class="card hero-card tight">
    <div class="row" style="align-items:flex-start">
      <div class="grow">
        <div class="stat accent" style="background:transparent;border:0;padding:0">
          <div class="v" style="font-size:26px">${shown}</div>
          <div class="k">matching lead${shown === 1 ? '' : 's'} of ${total}</div>
        </div>
      </div>
      <button class="ghost" data-act="clear" ${state.activeFilterCount() ? '' : 'disabled'}>Reset${state.activeFilterCount() ? ` (${state.activeFilterCount()})` : ''}</button>
    </div>
    <input type="search" id="f-search" placeholder="Search name, address, website, phone…" value="${esc(c.search || '')}" style="margin-top:10px">
  </div>

  <div class="card">
    <h2>Rating</h2>
    <div class="row">
      <label class="field grow"><span>Minimum</span>
        <input type="number" step="0.1" min="0" max="5" data-crit="ratingMin" placeholder="any" value="${c.ratingMin ?? ''}"></label>
      <label class="field grow"><span>Maximum</span>
        <input type="number" step="0.1" min="0" max="5" data-crit="ratingMax" placeholder="any" value="${c.ratingMax ?? ''}"></label>
    </div>
    <div class="chips">
      ${[4.0, 4.3, 4.5, 4.7].map((v) => `<button class="chip" data-quick-rating="${v}" aria-pressed="${c.ratingMin === v}">&#8805; ${v.toFixed(1)}</button>`).join('')}
    </div>
    <p class="hint tiny">Data ranges from ${f.bounds.rating.min.toFixed(1)} to ${f.bounds.rating.max.toFixed(1)}. Filtering on rating excludes businesses with no rating at all.</p>
  </div>

  <div class="card">
    <h2>Reviews</h2>
    <div class="row">
      <label class="field grow"><span>Minimum</span>
        <input type="number" step="1" min="0" data-crit="reviewsMin" placeholder="any" value="${c.reviewsMin ?? ''}"></label>
      <label class="field grow"><span>Maximum</span>
        <input type="number" step="1" min="0" data-crit="reviewsMax" placeholder="any" value="${c.reviewsMax ?? ''}"></label>
    </div>
    <div class="chips">
      ${[10, 50, 100, 500].map((v) => `<button class="chip" data-quick-reviews="${v}" aria-pressed="${c.reviewsMin === v}">&#8805; ${v}</button>`).join('')}
    </div>
    <p class="hint tiny">Data ranges from ${f.bounds.reviews.min} to ${f.bounds.reviews.max} reviews.</p>
  </div>

  <div class="card">
    <h2>Category <span class="count">${f.categories.length} found</span></h2>
    ${f.categories.length ? `
      <div class="check-list">
        ${f.categories.map((cat) => `
          <label class="check">
            <input type="checkbox" data-category="${esc(cat.value)}" ${(c.categories || []).includes(cat.value) ? 'checked' : ''}>
            <span class="grow">${esc(cat.value)}</span>
            <span class="muted count-n">${cat.count}</span>
          </label>`).join('')}
      </div>
      <p class="hint tiny">Built from the records you actually collected. Selecting several matches any of them.</p>`
    : '<p class="hint">No categories in this dataset yet.</p>'}
  </div>

  <div class="card">
    <h2>Data availability</h2>
    <div class="chips">
      ${AVAILABILITY.map((a) => `
        <button class="chip" data-avail="${esc(a.id)}" aria-pressed="${(c.availability || []).includes(a.id)}">
          ${esc(a.label)}<span class="n">${f.availability[a.id] || 0}</span>
        </button>`).join('')}
    </div>
  </div>

  <div class="card">
    <h2>Quality</h2>
    <div class="row">
      <label class="field grow"><span>Minimum lead score</span>
        <input type="number" step="5" min="0" max="100" data-crit="scoreMin" placeholder="any" value="${c.scoreMin ?? ''}"></label>
    </div>
    <div class="chips">
      ${['Valid', 'Partial', 'Invalid'].map((v) => `
        <button class="chip" data-validation="${v}" aria-pressed="${(c.validation || []).includes(v)}">${v}</button>`).join('')}
    </div>
    <p class="hint tiny">Lead score and validation are produced by the Enrich tab; records that have not been scored yet are excluded when you set a minimum.</p>
  </div>

  <div class="card">
    <h2>Location</h2>
    <div class="row">
      <label class="field grow"><span>City</span>
        <input type="text" data-crit="city" placeholder="any" value="${esc(c.city || '')}"></label>
      <label class="field grow"><span>State / region</span>
        <input type="text" data-crit="state" placeholder="any" value="${esc(c.state || '')}"></label>
    </div>
    <div class="row">
      <label class="field grow"><span>Postal code</span>
        <input type="text" data-crit="postalCode" placeholder="any" value="${esc(c.postalCode || '')}"></label>
      <label class="field grow"><span>Country</span>
        <input type="text" data-crit="country" placeholder="any" value="${esc(c.country || '')}"></label>
    </div>
    ${f.locations.city.length ? `
      <div class="chips" style="margin-top:6px">
        ${f.locations.city.slice(0, 10).map((x) => `
          <button class="chip" data-quick-city="${esc(x.value)}" aria-pressed="${c.city === x.value}">${esc(x.value)}<span class="n">${x.count}</span></button>`).join('')}
      </div>` : ''}
    <p class="hint tiny">Location components are split out of the full address, so they only appear once place details have been resolved.</p>
  </div>`;
}

export function bindFilter() {
  const root = document.getElementById('view-filter');

  const num = (v) => {
    const s = String(v).trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  root.addEventListener('change', async (e) => {
    const app = await import('../app.js');
    const t = e.target;

    if (t.matches('[data-crit]')) {
      const key = t.dataset.crit;
      const numeric = ['ratingMin', 'ratingMax', 'reviewsMin', 'reviewsMax', 'scoreMin'].includes(key);
      app.setCriteria({ [key]: numeric ? num(t.value) : t.value.trim() });
    }

    if (t.matches('[data-category]')) {
      const set = new Set(app.state.criteria.categories || []);
      if (t.checked) set.add(t.dataset.category); else set.delete(t.dataset.category);
      app.setCriteria({ categories: [...set] });
    }
  });

  root.addEventListener('input', async (e) => {
    if (e.target.id !== 'f-search') return;
    const app = await import('../app.js');
    // Update the count without re-rendering, so the input keeps focus.
    app.state.criteria.search = e.target.value;
    const shown = app.state.visibleRecords().length;
    const count = root.querySelector('.hero-card .stat .v');
    const label = root.querySelector('.hero-card .stat .k');
    if (count) count.textContent = String(shown);
    if (label) label.textContent = `matching lead${shown === 1 ? '' : 's'} of ${app.state.records.length}`;
  });

  onClick(root, '[data-avail]', async (e, el) => {
    const app = await import('../app.js');
    const set = new Set(app.state.criteria.availability || []);
    const id = el.dataset.avail;
    if (set.has(id)) set.delete(id); else set.add(id);
    app.setCriteria({ availability: [...set] });
  });

  onClick(root, '[data-validation]', async (e, el) => {
    const app = await import('../app.js');
    const set = new Set(app.state.criteria.validation || []);
    const v = el.dataset.validation;
    if (set.has(v)) set.delete(v); else set.add(v);
    app.setCriteria({ validation: [...set] });
  });

  onClick(root, '[data-quick-rating]', async (e, el) => {
    const app = await import('../app.js');
    const v = Number(el.dataset.quickRating);
    app.setCriteria({ ratingMin: app.state.criteria.ratingMin === v ? null : v });
  });

  onClick(root, '[data-quick-reviews]', async (e, el) => {
    const app = await import('../app.js');
    const v = Number(el.dataset.quickReviews);
    app.setCriteria({ reviewsMin: app.state.criteria.reviewsMin === v ? null : v });
  });

  onClick(root, '[data-quick-city]', async (e, el) => {
    const app = await import('../app.js');
    const v = el.dataset.quickCity;
    app.setCriteria({ city: app.state.criteria.city === v ? '' : v });
  });

  onClick(root, '[data-act="clear"]', async () => {
    const app = await import('../app.js');
    app.clearCriteria();
  });
}
