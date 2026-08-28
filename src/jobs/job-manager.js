/**
 * Job manager — owns the lifecycle of a scraping session.
 *
 * A job is a persisted record. The collector reports into it; the UI reads it.
 * Nothing else may mutate a job's status, which keeps the state machine sound
 * across service-worker eviction and extension reload.
 */
import { SK, JOB_STATUS, MODE, APP_VERSION } from '../core/constants.js';
import * as store from '../core/storage.js';
import { createLogger } from '../core/logger.js';
import { blankTechnical, recordTechnicalError, analyze } from '../core/quality.js';

/**
 * How long a RUNNING job may go without activity before the UI should say
 * "Possibly Stuck" instead of "Running".
 */
export const STALL_THRESHOLD_MS = 30000;

const log = createLogger('jobs');

const ALLOWED = {
  [JOB_STATUS.IDLE]: [JOB_STATUS.RUNNING, JOB_STATUS.ERROR],
  [JOB_STATUS.RUNNING]: [JOB_STATUS.PAUSED, JOB_STATUS.STOPPED, JOB_STATUS.COMPLETED, JOB_STATUS.ERROR],
  [JOB_STATUS.PAUSED]: [JOB_STATUS.RUNNING, JOB_STATUS.STOPPED, JOB_STATUS.COMPLETED, JOB_STATUS.ERROR],
  [JOB_STATUS.COMPLETED]: [JOB_STATUS.RUNNING],
  [JOB_STATUS.STOPPED]: [JOB_STATUS.RUNNING],
  [JOB_STATUS.ERROR]: [JOB_STATUS.RUNNING, JOB_STATUS.IDLE],
};

export function canTransition(from, to) {
  if (from === to) return true;
  return (ALLOWED[from] || []).includes(to);
}

export function newJobId() {
  const r = Math.random().toString(36).slice(2, 8);
  return `job_${Date.now().toString(36)}_${r}`;
}

export function blankJob(overrides = {}) {
  return {
    id: newJobId(),
    appVersion: APP_VERSION,
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    status: JOB_STATUS.IDLE,

    name: '',
    query: '',
    location: '',
    mode: MODE.STANDARD,
    fields: [],
    projectId: null,
    projectName: '',

    /**
     * Collection counters. NOTHING here counts a missing field.
     * `technicalErrors` is the only error number, and it is fed exclusively by
     * core/quality.js:recordTechnicalError.
     */
    counts: {
      found: 0,
      scanned: 0,
      scrolls: 0,
      duplicates: 0,
      enriched: 0,
      technicalErrors: 0,
    },

    /** Coverage report, recomputed whenever records change. Never errors. */
    quality: null,

    /** Technical failures, by category, with recent messages. */
    technical: blankTechnical(),

    /** Detail resolution progress. */
    detail: { done: 0, total: 0, resolved: 0, notFound: 0, failed: 0, ranAt: null },

    /**
     * Enrichment progress. `done < total` is what "still enriching" actually
     * means — the UI must never infer that from a human-readable progress
     * note, because a completion message ("Enrichment complete") contains
     * the same word a "still running" message does.
     */
    enrich: { done: 0, total: 0, ranAt: null },

    /** Heartbeat — the watchdog reads this to decide "Possibly Stuck". */
    lastActivityAt: Date.now(),
    lastActivity: 'Created',

    progress: { percent: 0, note: '' },
    dedupe: null,
    enrichRan: false,
    ...overrides,
  };
}

/** Human label for a job: its name, else the query, else the id. */
export function jobLabel(job) {
  if (!job) return '';
  if (job.name) return job.name;
  const parts = [job.query, job.location].filter(Boolean);
  return parts.length ? parts.join(' — ') : job.id;
}

/**
 * Is a RUNNING job actually making progress?
 * Returns { stuck, idleMs }. A paused job is never "stuck".
 */
export function stallState(job, now = Date.now()) {
  if (!job || job.status !== JOB_STATUS.RUNNING) return { stuck: false, idleMs: 0 };
  const idleMs = now - (job.lastActivityAt || job.startedAt || now);
  return { stuck: idleMs > STALL_THRESHOLD_MS, idleMs };
}

export async function createJob(fields) {
  const job = blankJob(fields);
  await store.set(SK.JOB(job.id), job);
  await store.set(SK.ACTIVE_JOB, job.id);
  await addToIndex(job);
  log.info('job created', job.id);
  return job;
}

export async function getJob(jobId) {
  if (!jobId) return null;
  return await store.get(SK.JOB(jobId), null);
}

export async function getActiveJob() {
  const id = await store.get(SK.ACTIVE_JOB, null);
  return id ? await getJob(id) : null;
}

export async function setActiveJob(jobId) {
  await store.set(SK.ACTIVE_JOB, jobId);
}

export async function saveJob(job) {
  job.updatedAt = Date.now();
  await store.set(SK.JOB(job.id), job);
  await addToIndex(job);
  return job;
}

/**
 * Apply a patch to a job. `status` transitions are validated; an illegal
 * transition is logged and ignored rather than throwing.
 */
export async function updateJob(jobId, patch) {
  const job = await getJob(jobId);
  if (!job) return null;

  if (patch.status && patch.status !== job.status) {
    if (!canTransition(job.status, patch.status)) {
      log.warn(`illegal transition ${job.status} -> ${patch.status}`, jobId);
      delete patch.status;
    }
  }

  const next = {
    ...job,
    ...patch,
    counts: { ...job.counts, ...(patch.counts || {}) },
    progress: { ...job.progress, ...(patch.progress || {}) },
    detail: { ...job.detail, ...(patch.detail || {}) },
    enrich: { ...job.enrich, ...(patch.enrich || {}) },
  };

  // Any patch that reports real movement refreshes the heartbeat.
  if (patch.lastActivityAt) next.lastActivityAt = patch.lastActivityAt;
  else if (patch.counts || patch.status || patch.detail || patch.enrich) next.lastActivityAt = Date.now();
  if (patch.lastActivity) next.lastActivity = patch.lastActivity;

  if (patch.status === JOB_STATUS.RUNNING && !next.startedAt) next.startedAt = Date.now();
  if ([JOB_STATUS.COMPLETED, JOB_STATUS.STOPPED, JOB_STATUS.ERROR].includes(patch.status)) {
    next.endedAt = Date.now();
  }

  return await saveJob(next);
}

/**
 * Record a TECHNICAL error against a job.
 *
 * Callers must pass a TECH_ERROR category. A missing website or phone must
 * never reach this function — that is coverage, tracked by refreshQuality().
 */
export async function addTechnicalError(jobId, category, message) {
  const job = await getJob(jobId);
  if (!job) return null;
  job.technical = recordTechnicalError(job.technical, category, message);
  job.counts.technicalErrors = job.technical.total;
  return await saveJob(job);
}

/** Recompute the coverage report for a job from its records. */
export async function refreshQuality(jobId, records) {
  const job = await getJob(jobId);
  if (!job) return null;
  const list = records || (await store.readRecords(jobId));
  job.quality = analyze(list);
  job.counts.found = list.length;
  return await saveJob(job);
}

/** Touch the heartbeat without changing anything else. */
export async function touch(jobId, activity) {
  const job = await getJob(jobId);
  if (!job) return null;
  job.lastActivityAt = Date.now();
  if (activity) job.lastActivity = activity;
  return await saveJob(job);
}

/* ------------------------------------------------------------------ *
 * Job index — a light list for the Data view. Full jobs are separate keys.
 * ------------------------------------------------------------------ */
async function addToIndex(job) {
  const index = await store.get(SK.JOB_INDEX, []);
  const summary = {
    id: job.id,
    createdAt: job.createdAt,
    endedAt: job.endedAt,
    status: job.status,
    name: job.name || '',
    label: jobLabel(job),
    query: job.query,
    location: job.location,
    mode: job.mode,
    projectName: job.projectName || '',
    count: job.counts.found,
    technicalErrors: job.counts.technicalErrors || 0,
  };
  const i = index.findIndex((x) => x.id === job.id);
  if (i >= 0) index[i] = summary; else index.unshift(summary);
  if (index.length > 100) index.length = 100;
  await store.set(SK.JOB_INDEX, index);
}

export async function listJobs() {
  return await store.get(SK.JOB_INDEX, []);
}

export async function deleteJob(jobId) {
  const index = (await store.get(SK.JOB_INDEX, [])).filter((x) => x.id !== jobId);
  await store.set(SK.JOB_INDEX, index);
  await store.remove([SK.JOB(jobId)]);
  await store.dropRecords(jobId);
  const active = await store.get(SK.ACTIVE_JOB, null);
  if (active === jobId) await store.set(SK.ACTIVE_JOB, index[0] ? index[0].id : null);
}

export const records = {
  append: store.appendRecords,
  read: store.readRecords,
  write: store.writeRecords,
  count: store.countRecords,
};
