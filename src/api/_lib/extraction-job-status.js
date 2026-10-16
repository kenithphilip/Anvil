// The states of an extraction_jobs row (the background extraction of a large
// document, drained by cron/extraction_jobs.js). PURE. No I/O.
//
// orders/extraction_jobs.js de-dupes on the in-flight list, the cron worker
// moves a job through it, and the SO workspace polls extraction_status while
// a job is in it (components/BackgroundExtractionWatch.tsx).

// Waiting for the worker, or being worked on.
export const IN_FLIGHT_JOB_STATUSES = Object.freeze(["queued", "profiling", "chunking", "extracting", "merging"]);

// Finished, one way or another. "cancelled" is set by an operator.
export const TERMINAL_JOB_STATUSES = Object.freeze(["completed", "failed", "cancelled"]);

export const isJobInFlight = (job) => !!job && IN_FLIGHT_JOB_STATUSES.includes(job.status);
export const isJobTerminal = (job) => !!job && TERMINAL_JOB_STATUSES.includes(job.status);
