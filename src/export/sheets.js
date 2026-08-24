/**
 * Google Sheets Exporter — OPTIONAL destination.
 *
 * ============================================================================
 * NOTHING IN THIS FILE CAN AFFECT COLLECTION.
 * ============================================================================
 * The collector does not import it. If OAuth fails, if the API is down, if the
 * client ID is missing — CSV and Excel still export and the scraper still runs.
 * Every entry point returns a result object; none of them throw.
 *
 * SECURITY
 *   · No client secret. An installed Chrome extension is a public client; the
 *     secret is neither needed nor safe to embed, so there is none here.
 *   · No token is written to storage. `chrome.identity` holds the token in the
 *     browser's own credential store; we ask for it per call and never persist it.
 *   · Scopes are the minimum for the feature: `spreadsheets` to read/write, and
 *     `drive.file` so "Create new spreadsheet" only ever touches files this
 *     extension created — it cannot see the rest of your Drive.
 */
import { SK } from '../core/constants.js';
import * as store from '../core/storage.js';
import { createLogger } from '../core/logger.js';
import * as diag from '../core/diagnostics.js';
import { buildColumns, headerRow, toRow } from './columns.js';

const log = createLogger('sheets');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const PLACEHOLDER = 'PASTE_YOUR_OAUTH_CLIENT_ID_HERE';

/* ==================================================================== *
 * Configuration state
 * ==================================================================== */

/**
 * Is a real OAuth client ID configured?
 * Until you paste your own, the UI shows a setup card instead of pretending
 * to be connected. That is deliberate: a placeholder must never be presented
 * as a working integration.
 */
export function getConfig() {
  let clientId = '';
  let scopes = [];
  try {
    const manifest = chrome.runtime.getManifest();
    clientId = (manifest.oauth2 && manifest.oauth2.client_id) || '';
    scopes = (manifest.oauth2 && manifest.oauth2.scopes) || [];
  } catch { /* not in an extension context */ }

  const configured = !!clientId && !clientId.includes(PLACEHOLDER) && clientId.endsWith('.apps.googleusercontent.com');

  return {
    configured,
    clientId: configured ? clientId : '',
    scopes,
    extensionId: (() => { try { return chrome.runtime.id; } catch { return ''; } })(),
    reason: configured ? '' : 'No OAuth client ID configured in manifest.json.',
  };
}

/* ==================================================================== *
 * Auth
 * ==================================================================== */

/** Get an access token. Returns { ok, token, error } — never throws. */
export async function getToken({ interactive = false } = {}) {
  const config = getConfig();
  if (!config.configured) {
    return { ok: false, token: null, error: config.reason, needsSetup: true };
  }
  try {
    const token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive }, (t) => {
        const err = chrome.runtime.lastError;
        if (err || !t) reject(new Error(err ? err.message : 'no token returned'));
        else resolve(t);
      });
    });
    diag.reportOk('auth.google', 'signed in');
    return { ok: true, token, error: null };
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    diag.reportFail('auth.google', message);
    log.warn('getAuthToken failed', message);
    return { ok: false, token: null, error: message };
  }
}

export async function signIn() {
  return await getToken({ interactive: true });
}

/** Sign out and drop the cached token so the next sign-in is clean. */
export async function signOut() {
  try {
    const current = await getToken({ interactive: false });
    if (current.ok && current.token) {
      await new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token: current.token }, resolve));
      // Revoke server-side too, so "sign out" actually means signed out.
      try {
        await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${encodeURIComponent(current.token)}`);
      } catch { /* revocation is best-effort */ }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }
}

export async function getStatus() {
  const config = getConfig();
  if (!config.configured) {
    return { configured: false, signedIn: false, reason: config.reason, extensionId: config.extensionId };
  }
  const token = await getToken({ interactive: false });
  const saved = await store.get(SK.SHEETS, {});
  return {
    configured: true,
    signedIn: token.ok,
    reason: token.ok ? '' : token.error,
    extensionId: config.extensionId,
    spreadsheetId: saved.spreadsheetId || '',
    spreadsheetName: saved.spreadsheetName || '',
    worksheet: saved.worksheet || 'Leads',
  };
}

/* ==================================================================== *
 * API helper
 * ==================================================================== */

async function api(path, { method = 'GET', body = null, token, query = null } = {}) {
  let url = path.startsWith('http') ? path : `${API}${path}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }

  if (!res.ok) {
    const message = (json && json.error && json.error.message) || `HTTP ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return json;
}

/* ==================================================================== *
 * Spreadsheet operations
 * ==================================================================== */

/** Create a new spreadsheet with a worksheet and header row. */
export async function createSpreadsheet(title, selectedFields, worksheetName = 'Leads') {
  const auth = await getToken({ interactive: true });
  if (!auth.ok) return { ok: false, error: auth.error, needsSetup: auth.needsSetup };

  try {
    const columns = buildColumns(selectedFields);
    const created = await api('', {
      method: 'POST',
      token: auth.token,
      body: {
        properties: { title: title || 'Al-Aqsa Leads' },
        sheets: [{ properties: { title: worksheetName, gridProperties: { frozenRowCount: 1 } } }],
      },
    });

    await api(`/${created.spreadsheetId}/values/${encodeURIComponent(worksheetName)}!A1`, {
      method: 'PUT',
      token: auth.token,
      query: { valueInputOption: 'RAW' },
      body: { values: [headerRow(columns)] },
    });

    await store.set(SK.SHEETS, {
      spreadsheetId: created.spreadsheetId,
      spreadsheetName: created.properties ? created.properties.title : title,
      worksheet: worksheetName,
    });

    diag.reportOk('export.sheets', 'spreadsheet created');
    return {
      ok: true,
      spreadsheetId: created.spreadsheetId,
      spreadsheetUrl: created.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${created.spreadsheetId}`,
      worksheet: worksheetName,
    };
  } catch (err) {
    diag.reportFail('export.sheets', err);
    return { ok: false, error: String(err && err.message) };
  }
}

/** Read a spreadsheet's metadata — used to validate a pasted ID/URL. */
export async function describeSpreadsheet(spreadsheetIdOrUrl) {
  const auth = await getToken({ interactive: true });
  if (!auth.ok) return { ok: false, error: auth.error, needsSetup: auth.needsSetup };

  const id = parseSpreadsheetId(spreadsheetIdOrUrl);
  if (!id) return { ok: false, error: 'Could not read a spreadsheet ID from that value.' };

  try {
    const meta = await api(`/${id}`, { token: auth.token, query: { fields: 'spreadsheetId,properties.title,sheets.properties' } });
    return {
      ok: true,
      spreadsheetId: meta.spreadsheetId,
      title: meta.properties && meta.properties.title,
      worksheets: (meta.sheets || []).map((s) => s.properties.title),
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }
}

/** Extract the ID from a full Sheets URL, or pass a bare ID through. */
export function parseSpreadsheetId(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(s)) return s;
  return '';
}

/** Ensure a worksheet exists and carries the right header row. */
async function ensureWorksheet(spreadsheetId, worksheetName, columns, token) {
  const meta = await api(`/${spreadsheetId}`, { token, query: { fields: 'sheets.properties' } });
  const existing = (meta.sheets || []).map((s) => s.properties.title);

  if (!existing.includes(worksheetName)) {
    await api(`/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      token,
      body: {
        requests: [{
          addSheet: { properties: { title: worksheetName, gridProperties: { frozenRowCount: 1 } } },
        }],
      },
    });
  }

  const head = await api(`/${spreadsheetId}/values/${encodeURIComponent(worksheetName)}!1:1`, { token });
  const current = (head && head.values && head.values[0]) || [];
  const wanted = headerRow(columns);

  if (current.length === 0) {
    await api(`/${spreadsheetId}/values/${encodeURIComponent(worksheetName)}!A1`, {
      method: 'PUT',
      token,
      query: { valueInputOption: 'RAW' },
      body: { values: [wanted] },
    });
    return wanted;
  }
  return current;
}

/**
 * Existing lead keys already in the sheet, so we append NEW leads only.
 * Matching uses the Maps URL column when present, else Business Name + Phone.
 */
async function readExistingKeys(spreadsheetId, worksheetName, header, token) {
  const keys = new Set();
  try {
    const res = await api(`/${spreadsheetId}/values/${encodeURIComponent(worksheetName)}`, {
      token,
      query: { majorDimension: 'ROWS' },
    });
    const rows = (res && res.values) || [];
    if (rows.length < 2) return keys;

    const idx = (label) => header.findIndex((h) => String(h).toLowerCase() === label.toLowerCase());
    const iUrl = idx('Maps URL');
    const iName = idx('Business Name');
    const iPhone = idx('Phone');
    const iAddr = idx('Full Address');

    for (const row of rows.slice(1)) {
      if (iUrl >= 0 && row[iUrl]) keys.add(`u:${String(row[iUrl]).trim()}`);
      if (iName >= 0 && row[iName]) {
        const name = String(row[iName]).trim().toLowerCase();
        if (iPhone >= 0 && row[iPhone]) keys.add(`np:${name}|${String(row[iPhone]).replace(/\D/g, '').slice(-10)}`);
        if (iAddr >= 0 && row[iAddr]) keys.add(`na:${name}|${String(row[iAddr]).trim().toLowerCase()}`);
      }
    }
  } catch (err) {
    // A read failure must not block the append — worst case we add a duplicate.
    log.warn('could not read existing rows; appending everything', err);
  }
  return keys;
}

function recordKeys(record) {
  const out = [];
  const url = record.mapsUrl || record.dedupeUrl;
  if (url) out.push(`u:${String(url).trim()}`);
  const name = String(record.businessName || '').trim().toLowerCase();
  if (name && record.phone) out.push(`np:${name}|${String(record.phone).replace(/\D/g, '').slice(-10)}`);
  if (name && record.fullAddress) out.push(`na:${name}|${String(record.fullAddress).trim().toLowerCase()}`);
  return out;
}

/**
 * Append records to a spreadsheet, skipping leads already present.
 * @returns {{ok, appended, skipped, spreadsheetUrl, error}}
 */
export async function appendRecords(records, selectedFields, opts = {}) {
  const auth = await getToken({ interactive: true });
  if (!auth.ok) {
    diag.reportFail('export.sheets', auth.error);
    return { ok: false, error: auth.error, needsSetup: auth.needsSetup, appended: 0, skipped: 0 };
  }

  const saved = await store.get(SK.SHEETS, {});
  const spreadsheetId = parseSpreadsheetId(opts.spreadsheetId || saved.spreadsheetId);
  const worksheetName = opts.worksheet || saved.worksheet || 'Leads';

  if (!spreadsheetId) {
    return { ok: false, error: 'No spreadsheet selected. Create one or paste a spreadsheet URL first.', appended: 0, skipped: 0 };
  }

  try {
    const columns = buildColumns(selectedFields);
    const header = await ensureWorksheet(spreadsheetId, worksheetName, columns, auth.token);

    // Align our rows to the sheet's actual header order, not ours — so an
    // existing sheet keeps its column layout.
    const order = header.map((label) => {
      const col = columns.find((c) => c.label === label);
      return col ? col.key : null;
    });

    let toAppend = records || [];
    let skipped = 0;

    if (opts.skipExisting !== false) {
      const existing = await readExistingKeys(spreadsheetId, worksheetName, header, auth.token);
      if (existing.size) {
        const before = toAppend.length;
        toAppend = toAppend.filter((r) => !recordKeys(r).some((k) => existing.has(k)));
        skipped = before - toAppend.length;
      }
    }

    if (!toAppend.length) {
      return {
        ok: true, appended: 0, skipped,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
        message: skipped ? `All ${skipped} lead(s) were already in the sheet.` : 'Nothing to append.',
      };
    }

    const values = toAppend.map((record) =>
      order.map((key) => (key ? toRow(record, [{ key, label: key }])[0] : '')));

    // Sheets caps a single request; 2000 rows per batch stays well inside it.
    const BATCH = 2000;
    let appended = 0;
    for (let i = 0; i < values.length; i += BATCH) {
      const slice = values.slice(i, i + BATCH);
      await api(`/${spreadsheetId}/values/${encodeURIComponent(worksheetName)}!A1:append`, {
        method: 'POST',
        token: auth.token,
        query: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' },
        body: { values: slice },
      });
      appended += slice.length;
    }

    await store.set(SK.SHEETS, { ...saved, spreadsheetId, worksheet: worksheetName });
    diag.reportOk('export.sheets', `${appended} row(s) appended`);

    return {
      ok: true,
      appended,
      skipped,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
    };
  } catch (err) {
    const message = String(err && err.message);
    diag.reportFail('export.sheets', message);
    log.error('append failed', message);
    return { ok: false, error: message, appended: 0, skipped: 0 };
  }
}

export async function saveDestination(dest) {
  const saved = await store.get(SK.SHEETS, {});
  await store.set(SK.SHEETS, { ...saved, ...dest });
  return await store.get(SK.SHEETS, {});
}
