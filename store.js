const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');
const DATA_TEMP_FILE = path.join(__dirname, 'data.json.tmp');

const JOB_STATUS = Object.freeze({
  WAITING_FOR_FREELANCER: 'Waiting for freelancer',
  ACCEPTED_WAITING_FOR_FUNDING: 'Accepted, waiting for funding',
  FUNDED: 'Funded',
  UNDER_AI_REVIEW: 'Under AI review',
  COMPLETED: 'Completed',
});

const jobs = new Map();
const jobLocks = new Map();
let writeChain = Promise.resolve();

function loadJobsFromDisk() {
  if (!fs.existsSync(DATA_FILE)) {
    return;
  }

  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8').trim();
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && Array.isArray(parsed.jobs)
        ? parsed.jobs
        : [];

    for (const job of list) {
      if (job && typeof job.id === 'string' && job.id.trim()) {
        jobs.set(job.id, job);
      }
    }
    console.log(`Loaded ${jobs.size} job(s) from data.json`);
  } catch (err) {
    console.error('Failed to read data.json on startup:', err.message);
  }
}

function snapshotJobs() {
  return Array.from(jobs.values()).sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  );
}

/**
 * Persists all in-memory jobs to data.json atomically via a serialized write queue.
 */
function persistJobs() {
  const payload = JSON.stringify({ jobs: snapshotJobs() }, null, 2);

  writeChain = writeChain
    .catch(() => { })
    .then(async () => {
      await fs.promises.writeFile(DATA_TEMP_FILE, payload, 'utf8');
      await fs.promises.rename(DATA_TEMP_FILE, DATA_FILE);
    });

  return writeChain;
}

/**
 * Serializes mutations for a single job ID so concurrent requests cannot race on payments.
 */
async function withJobLock(jobId, fn) {
  const previous = jobLocks.get(jobId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => { }).then(() => current);
  jobLocks.set(jobId, tail);

  await previous.catch(() => { });
  try {
    return await fn();
  } finally {
    release();
    if (jobLocks.get(jobId) === tail) {
      jobLocks.delete(jobId);
    }
  }
}

function generateJobId() {
  let id;
  do {
    id = crypto.randomBytes(4).toString('hex');
  } while (jobs.has(id));
  return id;
}

function parseUsdToCents(rawInput) {
  const cleaned = String(rawInput ?? '')
    .trim()
    .replace(/^\$/, '')
    .replace(/,/g, '');

  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return null;
  }

  const [wholePart, fracPart = ''] = cleaned.split('.');
  const cents = Number(wholePart) * 100 + Number(fracPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > 10_000_000) {
    return null;
  }
  return cents;
}

function centsToUsd(cents) {
  const safe = Math.max(0, Math.trunc(Number(cents) || 0));
  return (safe / 100).toFixed(2);
}

/**
 * Server-side escrow payout math: price * (passed / total), rounded down to cents,
 * and clamped so capture never exceeds the authorized PayPal amount.
 */
function calculatePayout({ priceCents, authorizedAmountCents, passedCount, totalCount }) {
  if (!Number.isInteger(totalCount) || totalCount <= 0) {
    throw new Error('Checklist must contain at least one item to calculate payout.');
  }

  const boundedPassed = Math.max(0, Math.min(totalCount, Math.trunc(passedCount)));
  const rawPayoutCents = Math.floor((priceCents * boundedPassed) / totalCount);
  const maxCapturableCents =
    Number.isInteger(authorizedAmountCents) && authorizedAmountCents >= 0
      ? Math.min(priceCents, authorizedAmountCents)
      : priceCents;

  const payoutCents = Math.max(0, Math.min(rawPayoutCents, maxCapturableCents));
  const returnedCents = Math.max(0, priceCents - payoutCents);

  return {
    passedCount: boundedPassed,
    totalCount,
    payoutCents,
    payoutUsd: centsToUsd(payoutCents),
    returnedCents,
    returnedUsd: centsToUsd(returnedCents),
  };
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

function listJobs() {
  return snapshotJobs();
}

async function createJob({ title, description, priceCents, checklist }) {
  const id = generateJobId();
  const now = new Date().toISOString();
  const job = {
    id,
    title: String(title || '').trim(),
    description: String(description || '').trim(),
    priceCents,
    priceUsd: centsToUsd(priceCents),
    currency: 'USD',
    checklist: checklist.map((text, index) => ({
      id: index + 1,
      text: String(text).trim(),
    })),
    status: JOB_STATUS.WAITING_FOR_FREELANCER,
    createdAt: now,
    updatedAt: now,
    acceptedAt: null,
    paypal: {
      pendingOrderId: null,
      orderId: null,
      orderStatus: null,
      authorizationId: null,
      authorizationStatus: null,
      authorizedAmountUsd: null,
      authorizedAmountCents: null,
      authorizationExpiresAt: null,
      fundedAt: null,
    },
    submission: null,
    review: null,
    settlement: null,
    lastError: null,
  };

  jobs.set(id, job);
  await persistJobs();
  return job;
}

async function saveJob(job) {
  job.updatedAt = new Date().toISOString();
  jobs.set(job.id, job);
  await persistJobs();
  return job;
}

loadJobsFromDisk();

module.exports = {
  JOB_STATUS,
  withJobLock,
  parseUsdToCents,
  centsToUsd,
  calculatePayout,
  getJob,
  listJobs,
  createJob,
  saveJob,
};
