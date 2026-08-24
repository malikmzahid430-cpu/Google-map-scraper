/**
 * Projects — a named bundle of settings you can switch between.
 * A project remembers searches, fields, mode, enrichment settings, filters
 * and the Google Sheet destination. It never holds records.
 */
import { SK, DEFAULT_SETTINGS } from '../core/constants.js';
import * as store from '../core/storage.js';

export function blankProject(name = 'Untitled project') {
  return {
    id: `prj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    createdAt: Date.now(),
    searches: [],                  // [{ query, location }]
    mode: DEFAULT_SETTINGS.mode,
    fields: DEFAULT_SETTINGS.fields.slice(),
    enrich: { ...DEFAULT_SETTINGS.enrich },
    filters: [],
    sheet: { spreadsheetId: '', spreadsheetName: '', worksheet: 'Leads' },
  };
}

export async function listProjects() {
  return await store.get(SK.PROJECTS, []);
}

export async function saveProject(project) {
  const all = await listProjects();
  const i = all.findIndex((p) => p.id === project.id);
  if (i >= 0) all[i] = project; else all.push(project);
  await store.set(SK.PROJECTS, all);
  return project;
}

export async function deleteProject(id) {
  const all = (await listProjects()).filter((p) => p.id !== id);
  await store.set(SK.PROJECTS, all);
  const active = await store.get(SK.ACTIVE_PROJECT, null);
  if (active === id) await store.set(SK.ACTIVE_PROJECT, all[0] ? all[0].id : null);
}

export async function getActiveProject() {
  const id = await store.get(SK.ACTIVE_PROJECT, null);
  if (!id) return null;
  return (await listProjects()).find((p) => p.id === id) || null;
}

export async function setActiveProject(id) {
  await store.set(SK.ACTIVE_PROJECT, id);
}
