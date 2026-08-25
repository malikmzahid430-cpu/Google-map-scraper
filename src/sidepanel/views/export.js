/**
 * EXPORT view — CSV, Excel and Google Sheets.
 *
 * CSV and Excel are built entirely in the extension and require no Google
 * account. Google Sheets is a separate, optional destination: when it is not
 * configured the UI says exactly that instead of pretending to be connected.
 */
import { MSG, FIELDS, FIELD_GROUPS } from '../../core/constants.js';
import { esc, onClick, banner, toast, empty, stat } from '../ui.js';

export function renderExport(state) {
  const rows = state.visibleRecords();
  const selected = new Set(state.settings.fields || []);

  if (!state.records.length) {
    return `<div class="card">${empty('&#8681;', 'Nothing to export yet.<br>Run a collection on the Home tab.')}</div>`;
  }

  return `
  <div class="card">
    <h2>Columns <span class="count">${selected.size} selected</span></h2>
    ${FIELD_GROUPS.map(({ id: group, label: groupLabel }) => `
      <div style="margin-bottom:6px">
        <div class="hint tiny" style="margin:6px 0 2px;text-transform:uppercase;letter-spacing:.5px">${esc(groupLabel)}</div>
        <div class="check-grid">
          ${FIELDS.filter((f) => f.group === group).map((f) => `
            <label class="check">
              <input type="checkbox" data-xfield="${esc(f.key)}" ${selected.has(f.key) ? 'checked' : ''}>
              <span>${esc(f.label)}</span>
            </label>`).join('')}
        </div>
      </div>`).join('')}
    <div class="row" style="margin-top:8px">
      <button class="ghost grow" data-act="select-all">Select all</button>
      <button class="ghost grow" data-act="select-default">Reset to defaults</button>
    </div>
    <p class="hint tiny">The selected columns apply to all three destinations, so a CSV and a Sheets append always have the same shape.</p>
  </div>

  <div class="card">
    <h2>Download</h2>
    <div class="stats" style="margin:6px 0 10px">
      ${stat(state.records.length, 'Total records')}
      ${stat(rows.length, 'Filtered records', rows.length !== state.records.length ? 'accent' : '')}
    </div>
    ${rows.length !== state.records.length ? `
      <div class="row">
        <button class="primary grow lg" data-act="csv" data-scope="filtered" ${state.busy ? 'disabled' : ''}>Export ${rows.length} Filtered (CSV)</button>
        <button class="grow lg" data-act="xlsx" data-scope="filtered" ${state.busy ? 'disabled' : ''}>Export ${rows.length} Filtered (Excel)</button>
      </div>
      <div class="row" style="margin-top:6px">
        <button class="ghost grow" data-act="csv" data-scope="all" ${state.busy ? 'disabled' : ''}>Export All ${state.records.length} (CSV)</button>
        <button class="ghost grow" data-act="xlsx" data-scope="all" ${state.busy ? 'disabled' : ''}>Export All ${state.records.length} (Excel)</button>
      </div>
      <p class="hint tiny" style="margin-top:8px"><strong>${state.activeFilterCount()} filter(s) active</strong> — the highlighted buttons export only the ${rows.length} matching record(s). Use "Export All" to ignore the current filters instead.</p>` : `
      <div class="row">
        <button class="primary grow lg" data-act="csv" data-scope="all" ${state.busy ? 'disabled' : ''}>Export CSV</button>
        <button class="grow lg" data-act="xlsx" data-scope="all" ${state.busy ? 'disabled' : ''}>Export Excel</button>
      </div>
      <p class="hint tiny" style="margin-top:8px">No filters are active, so this exports every record in scope.</p>`}
    <p class="hint tiny">Both are generated inside the extension with no third-party library and no Google sign-in. Scope: <strong>${esc(state.scope)}</strong>.</p>
  </div>

  ${renderSheetsCard(state, rows)}
  `;
}

function renderSheetsCard(state, rows) {
  const s = state.sheets || {};

  if (!s.configured) {
    return `
    <div class="card">
      <h2>Google Sheets <span class="count">not configured</span></h2>
      ${banner('warn', `<strong>Google Sheets is switched off until you add your own OAuth client ID.</strong><br>
        <span class="hint tiny">This is not a placeholder pretending to work — the integration is fully implemented and simply has no credentials yet. A client ID is tied to your specific extension ID, so only you can create it.</span>`)}
      <ol class="hint" style="padding-left:18px;margin:10px 0 0">
        <li>Copy your extension ID: <code>${esc(s.extensionId || 'load the extension to see it')}</code></li>
        <li>Open <strong>console.cloud.google.com</strong> → APIs &amp; Services → Credentials.</li>
        <li>Create an <strong>OAuth client ID</strong> of type <strong>Chrome Extension</strong> and paste the ID above as the Application ID.</li>
        <li>Enable the <strong>Google Sheets API</strong> for the project.</li>
        <li>Paste the client ID into <code>manifest.json</code> → <code>oauth2.client_id</code>, then reload the extension.</li>
      </ol>
      <p class="hint tiny">Full walkthrough in <code>SETUP-GOOGLE-SHEETS.md</code>. CSV and Excel do not need any of this.</p>
    </div>`;
  }

  if (!s.signedIn) {
    return `
    <div class="card">
      <h2>Google Sheets <span class="count">signed out</span></h2>
      ${s.reason ? banner('error', `<strong>Last attempt failed.</strong><br><span class="hint tiny">${esc(s.reason)}</span>`) : ''}
      <button class="primary block" data-act="sheets-signin">Sign in with Google</button>
      <p class="hint tiny">Scopes requested: create and edit spreadsheets this extension makes. No token is stored by the extension — Chrome holds it.</p>
    </div>`;
  }

  return `
  <div class="card">
    <h2>Google Sheets <span class="count">signed in</span></h2>
    ${s.spreadsheetName || s.spreadsheetId
    ? `<p class="hint">Destination: <strong>${esc(s.spreadsheetName || s.spreadsheetId)}</strong> → sheet <code>${esc(s.worksheet || 'Leads')}</code></p>`
    : '<p class="hint">No destination chosen yet.</p>'}
    <div class="divider"></div>
    <label class="field"><span>Use an existing spreadsheet (paste its URL or ID)</span>
      <input type="text" id="sheet-id" placeholder="https://docs.google.com/spreadsheets/d/…" value="${esc(s.spreadsheetId || '')}">
    </label>
    <div class="row">
      <button class="grow" data-act="sheets-use">Use This Sheet</button>
      <button class="grow" data-act="sheets-create">Create New Sheet</button>
    </div>
    <div class="divider"></div>
    <button class="primary block lg" data-act="sheets-append" ${state.busy ? 'disabled' : ''}>
      Append ${rows.length} lead(s) to Google Sheets
    </button>
    <label class="check" style="margin-top:6px">
      <input type="checkbox" id="skip-existing" checked>
      <span>Skip leads already in the sheet</span>
    </label>
    <div class="divider"></div>
    <button class="ghost block" data-act="sheets-signout">Sign out</button>
  </div>`;
}

export function bindExport() {
  const root = document.getElementById('view-export');

  root.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-xfield]')) return;
    const app = await import('../app.js');
    const fields = new Set(app.state.settings.fields || []);
    if (e.target.checked) fields.add(e.target.dataset.xfield); else fields.delete(e.target.dataset.xfield);
    await app.saveSettings({ fields: [...fields] });
  });

  onClick(root, '[data-act]', async (e, el) => {
    const app = await import('../app.js');
    const fields = app.state.settings.fields;
    // "filtered" (default) respects the Filter tab's active criteria; "all"
    // exports every record in the current scope regardless of filters.
    const records = el.dataset.scope === 'all' ? app.state.records : app.state.visibleRecords();

    switch (el.dataset.act) {
      case 'csv':
        await app.command(MSG.EXPORT_CSV, { fields, records }, {
          successMessage: (d) => `CSV saved — ${d && d.rows} row(s).`, reloadAfter: false,
        });
        break;

      case 'xlsx':
        await app.command(MSG.EXPORT_XLSX, { fields, records }, {
          successMessage: (d) => `Excel file saved — ${d && d.rows} row(s).`, reloadAfter: false,
        });
        break;

      case 'select-all':
        await app.saveSettings({ fields: FIELDS.map((f) => f.key) });
        break;
      case 'select-default':
        await app.saveSettings({ fields: FIELDS.filter((f) => f.default).map((f) => f.key) });
        break;

      case 'sheets-signin':
        await app.command(MSG.SHEETS_SIGNIN, {}, { successMessage: 'Signed in to Google.', reloadAfter: false });
        await app.refreshSheetsStatus();
        break;

      case 'sheets-signout':
        await app.command(MSG.SHEETS_SIGNOUT, {}, { successMessage: 'Signed out.', reloadAfter: false });
        await app.refreshSheetsStatus();
        break;

      case 'sheets-create': {
        const title = prompt('Name for the new spreadsheet', `Al-Aqsa Leads ${new Date().toISOString().slice(0, 10)}`);
        if (!title) break;
        const res = await app.command(MSG.SHEETS_CREATE, { title, fields, worksheet: 'Leads' }, {
          successMessage: 'Spreadsheet created.', reloadAfter: false,
        });
        if (res.ok && res.data && res.data.spreadsheetUrl) {
          try { chrome.tabs.create({ url: res.data.spreadsheetUrl }); } catch { /* ignore */ }
        }
        await app.refreshSheetsStatus();
        break;
      }

      case 'sheets-use': {
        const input = document.getElementById('sheet-id');
        const value = input && input.value.trim();
        if (!value) { toast('Paste a spreadsheet URL or ID first.', 'error'); break; }
        const res = await app.command(MSG.SHEETS_LIST, { value }, { reloadAfter: false });
        if (res.ok && res.data) {
          const { saveDestination } = await import('../../export/sheets.js');
          await saveDestination({
            spreadsheetId: res.data.spreadsheetId,
            spreadsheetName: res.data.title,
            worksheet: (res.data.worksheets && res.data.worksheets[0]) || 'Leads',
          });
          toast(`Using "${res.data.title}".`, 'ok');
          await app.refreshSheetsStatus();
        }
        break;
      }

      case 'sheets-append': {
        const skip = document.getElementById('skip-existing');
        await app.command(MSG.EXPORT_SHEETS, {
          fields, records, skipExisting: !skip || skip.checked,
        }, {
          successMessage: (d) => d
            ? `${d.appended} lead(s) appended${d.skipped ? `, ${d.skipped} already present` : ''}.`
            : 'Appended to Google Sheets.',
          reloadAfter: false,
        });
        break;
      }
      default: break;
    }
  });
}
