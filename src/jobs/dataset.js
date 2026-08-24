/**
 * Datasets — a view over one or more jobs.
 *
 * A JOB is one collection run and owns its records.
 * A DATASET is a selection of jobs read together.
 * A PROJECT is a grouping and owns settings, not records.
 *
 * Combining never destroys or moves the original jobs: it reads them, merges
 * in memory, and (optionally) writes a new combined job alongside them.
 */
import { SK } from '../core/constants.js';
import * as store from '../core/storage.js';
import * as jobs from './job-manager.js';

export const SCOPE = {
  CURRENT_JOB: 'current',
  PROJECT: 'project',
  ALL_JOBS: 'all',
  SELECTED: 'selected',
};

/**
 * Read the records a scope refers to, stamped with their provenance so the
 * Data table can always show where each row came from.
 */
export async function readScope(scope, options = {}) {
  const { jobId = null, projectId = null, jobIds = [] } = options;

  let ids = [];
  const index = await jobs.listJobs();

  switch (scope) {
    case SCOPE.ALL_JOBS:
      ids = index.map((j) => j.id);
      break;
    case SCOPE.SELECTED:
      ids = jobIds.slice();
      break;
    case SCOPE.PROJECT: {
      const all = await Promise.all(index.map((j) => jobs.getJob(j.id)));
      ids = all.filter((j) => j && j.projectId === projectId).map((j) => j.id);
      break;
    }
    case SCOPE.CURRENT_JOB:
    default: {
      const id = jobId || (await store.get(SK.ACTIVE_JOB, null));
      ids = id ? [id] : [];
      break;
    }
  }

  const out = [];
  const sources = [];

  for (const id of ids) {
    const job = await jobs.getJob(id);
    if (!job) continue;
    const records = await store.readRecords(id);
    sources.push({ jobId: id, label: jobs.jobLabel(job), count: records.length, status: job.status });

    for (const r of records) {
      out.push({
        ...r,
        jobId: id,
        jobLabel: jobs.jobLabel(job),
        searchQuery: r.searchQuery || job.query || '',
        searchLocation: r.searchLocation || job.location || '',
        projectName: r.projectName || job.projectName || '',
      });
    }
  }

  return { records: out, sources, jobIds: ids };
}

/**
 * Combine several jobs into one new job.
 *
 * The originals are left completely untouched. Duplicate detection is applied
 * to the combined set using the SAME hierarchy as the standalone dedupe stage,
 * passed in by the caller so this module stays free of engine imports.
 *
 * @param {string[]} jobIds
 * @param {Function} dedupeFn  (records) => { records, stats }  — optional
 */
export async function combineJobs(jobIds, { name = '', dedupeFn = null } = {}) {
  const { records, sources } = await readScope(SCOPE.SELECTED, { jobIds });

  const before = records.length;
  let finalRecords = records;
  let duplicates = 0;

  if (typeof dedupeFn === 'function' && records.length) {
    const result = dedupeFn(records);
    finalRecords = result.records;
    duplicates = result.stats ? result.stats.removed : before - finalRecords.length;
  }

  // Renumber so the combined set reads as one list.
  finalRecords = finalRecords.map((r, i) => ({ ...r, serial: i + 1 }));

  const label = name || `Combined — ${sources.map((s) => s.label).join(' + ')}`.slice(0, 120);

  const combined = await jobs.createJob({
    name: label,
    query: sources.map((s) => s.label).join(' | ').slice(0, 200),
    location: '',
    status: 'completed',
    combinedFrom: jobIds.slice(),
  });

  await store.writeRecords(combined.id, finalRecords);
  await jobs.refreshQuality(combined.id, finalRecords);
  await jobs.updateJob(combined.id, {
    counts: { found: finalRecords.length, duplicates },
    dedupe: { before, removed: duplicates, after: finalRecords.length, at: Date.now(), byStrategy: {} },
    endedAt: Date.now(),
  });

  return {
    jobId: combined.id,
    label,
    before,
    duplicates,
    after: finalRecords.length,
    sources,
  };
}

/** Totals for the Jobs view header. */
export async function totals() {
  const index = await jobs.listJobs();
  return {
    jobs: index.length,
    records: index.reduce((n, j) => n + (j.count || 0), 0),
  };
}
