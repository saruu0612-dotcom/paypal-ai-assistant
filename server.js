require('dotenv').config();

const express = require('express');
const path = require('path');
const {
  PayPalApiError,
  getCredentials,
  createAuthorizeOrder,
  authorizeOrder,
  captureAuthorization,
  voidAuthorization,
} = require('./paypal');
const {
  GeminiServiceError,
  getGeminiHealth,
  initGeminiModelDiscovery,
  ensureModelsDiscovered,
  generateChecklist,
  evaluateSubmission,
} = require('./gemini');
const {
  JOB_STATUS,
  withJobLock,
  parseUsdToCents,
  centsToUsd,
  calculatePayout,
  getJob,
  listJobs,
  createJob,
  saveJob,
} = require('./store');
const { UrlFetchError, fetchPublicUrlContent } = require('./fetcher');
const { renderHomePage, renderJobPage, renderErrorView } = require('./views');
const { createTestRouter } = require('./testRoutes');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

function getBaseUrl(req) {
  const configured = (process.env.BASE_URL || '').trim().replace(/\/+$/, '');
  if (configured) {
    return configured;
  }
  if (req && typeof req.get === 'function' && req.get('host')) {
    return `${req.protocol}://${req.get('host')}`;
  }
  const renderUrl = (process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
  if (renderUrl) {
    return renderUrl;
  }
  return `http://${HOST}:${PORT}`;
}

function getConfigStatus() {
  let paypalReady = false;
  try {
    getCredentials();
    paypalReady = true;
  } catch {
    paypalReady = false;
  }

  const geminiHealth = getGeminiHealth();

  return {
    paypalReady,
    geminiReady: geminiHealth.ready,
    activeGeminiModel: geminiHealth.activeModel,
    geminiCandidates: geminiHealth.candidates,
    geminiLastRefreshedAt: geminiHealth.lastRefreshedAt,
  };
}

function toFriendlyPayPalError(err) {
  if (err instanceof PayPalApiError) {
    const issue = err.details?.[0]?.issue || '';
    if (err.status === 401 || err.paypalName === 'invalid_client') {
      return 'PayPal Sandbox authentication failed. Please check PAYPAL_CLIENT_ID and PAYPAL_SECRET in .env.';
    }
    if (issue === 'ORDER_NOT_APPROVED') {
      return 'PayPal checkout was not approved yet. Please approve the payment on PayPal Sandbox and try again.';
    }
    if (issue === 'AUTHORIZATION_ALREADY_CAPTURED' || issue === 'MAX_CAPTURE_AMOUNT_EXCEEDED') {
      return 'This PayPal authorization has already been settled or reached its capture limit.';
    }
    if (issue === 'AUTHORIZATION_VOIDED' || issue === 'AUTHORIZATION_EXPIRED') {
      return 'This PayPal authorization is no longer active (voided or expired).';
    }
    const detailDesc = err.details?.[0]?.description;
    if (detailDesc) {
      return `PayPal request failed: ${detailDesc}`;
    }
    return 'PayPal Sandbox could not complete the request. Please try again.';
  }

  const msg = String(err?.message || '');
  if (msg.includes('PAYPAL_CLIENT_ID') || msg.includes('PAYPAL_SECRET')) {
    return 'PayPal Sandbox is not configured yet. Please add PAYPAL_CLIENT_ID and PAYPAL_SECRET to .env.';
  }
  if (msg.toLowerCase().includes('fetch') || msg.toLowerCase().includes('network')) {
    return 'Could not reach PayPal Sandbox right now. Please check your internet connection and try again.';
  }
  return 'An unexpected PayPal error occurred. Please try again.';
}

function toFriendlyError(err) {
  if (err instanceof GeminiServiceError || err instanceof UrlFetchError) {
    return err.message;
  }
  if (err instanceof PayPalApiError || String(err?.message || '').includes('PAYPAL_')) {
    return toFriendlyPayPalError(err);
  }
  return err?.message || 'An unexpected error occurred. Please try again.';
}

function formatReviewError(job, err) {
  const friendly = toFriendlyError(err);
  if (!job?.review && !job?.settlement?.settledAt) {
    return `${friendly} No PayPal payment was charged or captured.`;
  }
  return friendly;
}

async function runReviewAndSettlement(job) {
  if (
    job.status === JOB_STATUS.COMPLETED ||
    job.settlement?.settledAt ||
    job.settlement?.captureId ||
    job.settlement?.voided
  ) {
    const conflict = new Error('This job has already been reviewed and settled.');
    conflict.status = 409;
    throw conflict;
  }

  if (!job.submission?.content) {
    const missing = new Error('No submitted deliverable was found for this job.');
    missing.status = 400;
    throw missing;
  }

  if (!job.paypal?.authorizationId) {
    const missingAuth = new Error('This job does not have an active PayPal authorization hold.');
    missingAuth.status = 400;
    throw missingAuth;
  }

  // Step 5: Evaluate submission with Gemini (skipped if review already succeeded before a PayPal retry).
  if (!job.review) {
    const evaluation = await evaluateSubmission({
      title: job.title,
      description: job.description,
      checklist: job.checklist,
      submissionType: job.submission.type,
      submissionSource: job.submission.sourceUrl || 'Pasted Text / Code',
      submissionContent: job.submission.content,
    });

    job.review = {
      summary: evaluation.summary,
      results: evaluation.results,
      evaluatedAt: new Date().toISOString(),
    };
    job.lastError = null;
    await saveJob(job);
  }

  // Server-side payout calculation: price * (passed / total), rounded down to cents.
  const passedCount = job.review.results.filter((r) => r.passed).length;
  const totalCount = job.checklist.length;
  const payout = calculatePayout({
    priceCents: job.priceCents,
    authorizedAmountCents: job.paypal.authorizedAmountCents,
    passedCount,
    totalCount,
  });

  // Step 6: Capture earned payout (final_capture: true) or void if payout is 0.
  let settlement;
  if (payout.payoutCents > 0) {
    const capture = await captureAuthorization(job.paypal.authorizationId, {
      amountValue: payout.payoutUsd,
      currencyCode: 'USD',
      finalCapture: true,
      requestId: `trustlance-capture-${job.id}`,
      noteToPayer: `TrustLance escrow settlement for job ${job.id}: ${passedCount}/${totalCount} criteria passed ($${payout.payoutUsd} USD captured, $${payout.returnedUsd} USD released).`,
    });

    console.log(
      `[TrustLance] Job ${job.id} captured ${payout.payoutUsd} USD (captureId=${capture.id}, final_capture=${capture.final_capture})`
    );

    settlement = {
      ...payout,
      voided: false,
      captureId: capture.id,
      captureStatus: capture.status || 'COMPLETED',
      finalCapture: true,
      settledAt: new Date().toISOString(),
    };
  } else {
    const voidResult = await voidAuthorization(job.paypal.authorizationId, {
      requestId: `trustlance-void-${job.id}`,
    });

    console.log(
      `[TrustLance] Job ${job.id} voided authorization ${job.paypal.authorizationId} ($0.00 payout)`
    );

    settlement = {
      ...payout,
      voided: true,
      voidStatus: voidResult?.status || 'VOIDED',
      captureId: null,
      finalCapture: false,
      settledAt: new Date().toISOString(),
    };
  }

  job.settlement = settlement;
  job.status = JOB_STATUS.COMPLETED;
  job.lastError = null;
  await saveJob(job);

  return job;
}

// --- TrustLance Page Routes ---

app.get('/', async (req, res) => {
  await ensureModelsDiscovered();
  res.send(
    renderHomePage({
      jobs: listJobs(),
      configStatus: getConfigStatus(),
    })
  );
});

app.get('/job/:id', async (req, res) => {
  await ensureModelsDiscovered();
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).send(
      renderErrorView({
        title: 'Escrow Job Not Found',
        message: `No escrow job exists with ID "${req.params.id}".`,
        detail: 'Check the shareable link or create a new escrow job from the home page.',
        configStatus: getConfigStatus(),
      })
    );
  }

  const role = req.query.role === 'freelancer' ? 'freelancer' : 'client';
  const notice = typeof req.query.notice === 'string' ? req.query.notice : '';
  const shareUrl = `${getBaseUrl(req)}/job/${encodeURIComponent(job.id)}`;

  return res.send(
    renderJobPage({
      job,
      role,
      notice,
      shareUrl,
      configStatus: getConfigStatus(),
    })
  );
});

// --- TrustLance API Routes ---

app.get('/api/health', async (_req, res) => {
  await ensureModelsDiscovered();
  const status = getConfigStatus();
  return res.json({
    ok: status.paypalReady && status.geminiReady,
    activeModel: status.activeGeminiModel,
    candidates: status.geminiCandidates,
    geminiReady: status.geminiReady,
    paypalConfigured: status.paypalReady,
    lastRefreshedAt: status.geminiLastRefreshedAt,
  });
});

app.post('/api/jobs/checklist', async (req, res) => {
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  const priceCents = parseUsdToCents(req.body?.price);

  if (description.length < 10) {
    return res.status(400).json({
      error: 'Please enter a plain-English job description of at least 10 characters.',
    });
  }
  if (!priceCents) {
    return res.status(400).json({
      error: 'Please enter a valid USD price between $0.01 and $100,000.00 (up to 2 decimal places).',
    });
  }

  try {
    const result = await generateChecklist({
      description,
      priceUsd: centsToUsd(priceCents),
    });
    return res.json({
      title: result.title,
      items: result.items,
      priceUsd: centsToUsd(priceCents),
    });
  } catch (err) {
    console.error('[TrustLance] Checklist generation error:', err.message);
    const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    return res.status(status).json({ error: toFriendlyError(err) });
  }
});

app.post('/api/jobs', async (req, res) => {
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  const rawTitle = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const priceCents = parseUsdToCents(req.body?.price);
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];

  if (description.length < 10) {
    return res.status(400).json({
      error: 'Job description must be at least 10 characters.',
    });
  }
  if (!priceCents) {
    return res.status(400).json({
      error: 'Please provide a valid USD price.',
    });
  }

  const cleanedItems = rawItems
    .map((item) => (typeof item === 'string' ? item.trim().replace(/\s+/g, ' ') : ''))
    .filter((item) => item.length > 0)
    .slice(0, 10);

  if (cleanedItems.length === 0) {
    return res.status(400).json({
      error: 'Checklist must contain at least one verification item.',
    });
  }

  const title =
    rawTitle.slice(0, 100) ||
    description.split(/\s+/).slice(0, 7).join(' ').slice(0, 80);

  try {
    const job = await createJob({
      title,
      description,
      priceCents,
      checklist: cleanedItems,
    });
    const shareUrl = `${getBaseUrl(req)}/job/${encodeURIComponent(job.id)}`;
    console.log(`[TrustLance] Created job ${job.id} ($${job.priceUsd} USD, ${job.checklist.length} criteria) -> ${shareUrl}`);
    return res.status(201).json({ job, shareUrl });
  } catch (err) {
    console.error('[TrustLance] Failed to persist new job:', err.message);
    return res.status(500).json({ error: 'Could not save the new escrow job. Please try again.' });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Escrow job not found.' });
  }
  return res.json({ job });
});

app.post('/api/jobs/:id/accept', async (req, res) => {
  const jobId = req.params.id;
  try {
    const job = await withJobLock(jobId, async () => {
      const existing = getJob(jobId);
      if (!existing) {
        const err = new Error('Escrow job not found.');
        err.status = 404;
        throw err;
      }

      if (existing.status !== JOB_STATUS.WAITING_FOR_FREELANCER) {
        const err = new Error(
          `This job cannot be accepted because its status is already "${existing.status}".`
        );
        err.status = 409;
        throw err;
      }

      existing.status = JOB_STATUS.ACCEPTED_WAITING_FOR_FUNDING;
      existing.acceptedAt = new Date().toISOString();
      await saveJob(existing);
      console.log(`[TrustLance] Job ${jobId} accepted by freelancer`);
      return existing;
    });

    return res.json({ job });
  } catch (err) {
    const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    return res.status(status).json({ error: toFriendlyError(err) });
  }
});

// --- PayPal Funding & Return Flow ---

app.post('/jobs/:id/fund', async (req, res) => {
  const jobId = req.params.id;
  const configStatus = getConfigStatus();

  try {
    const { approvalUrl } = await withJobLock(jobId, async () => {
      const job = getJob(jobId);
      if (!job) {
        const err = new Error('Escrow job not found.');
        err.status = 404;
        throw err;
      }

      if (job.paypal?.authorizationId || job.status === JOB_STATUS.FUNDED || job.status === JOB_STATUS.UNDER_AI_REVIEW || job.status === JOB_STATUS.COMPLETED) {
        const err = new Error('This job has already been funded. Duplicate funding is not permitted.');
        err.status = 409;
        throw err;
      }

      if (job.status !== JOB_STATUS.ACCEPTED_WAITING_FOR_FUNDING) {
        const err = new Error(
          'The freelancer must accept the job checklist before PayPal escrow funding can begin.'
        );
        err.status = 400;
        throw err;
      }

      const baseUrl = getBaseUrl(req);
      const returnUrl = `${baseUrl}/jobs/${encodeURIComponent(job.id)}/paypal/return`;
      const cancelUrl = `${baseUrl}/jobs/${encodeURIComponent(job.id)}/paypal/cancel`;

      const { order, approvalUrl: url } = await createAuthorizeOrder({
        amountValue: job.priceUsd,
        currencyCode: 'USD',
        returnUrl,
        cancelUrl,
        description: `TrustLance Escrow Hold - ${job.title || `Job #${job.id}`}`.slice(0, 127),
        customId: job.id,
      });

      job.paypal.pendingOrderId = order.id;
      job.lastError = null;
      await saveJob(job);

      console.log(`[TrustLance] Created PayPal AUTHORIZE order ${order.id} for job ${job.id} ($${job.priceUsd} USD)`);
      return { approvalUrl: url };
    });

    return res.redirect(303, approvalUrl);
  } catch (err) {
    console.error(`[TrustLance] Failed to initiate funding for job ${jobId}:`, err.message);
    const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    return res.status(status).send(
      renderErrorView({
        title: 'Unable to Start PayPal Funding',
        message: toFriendlyError(err),
        backHref: `/job/${encodeURIComponent(jobId)}?role=client`,
        backLabel: 'Back to Escrow Job',
        configStatus,
      })
    );
  }
});

app.get('/jobs/:id/paypal/cancel', (req, res) => {
  return res.redirect(303, `/job/${encodeURIComponent(req.params.id)}?role=client&notice=cancelled`);
});

app.get('/jobs/:id/paypal/return', async (req, res) => {
  const jobId = req.params.id;
  const orderId = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  const configStatus = getConfigStatus();

  try {
    const notice = await withJobLock(jobId, async () => {
      const job = getJob(jobId);
      if (!job) {
        const err = new Error('Escrow job not found.');
        err.status = 404;
        throw err;
      }

      // Idempotency guard: never authorize a funded job again on refresh or back navigation.
      if (job.paypal?.authorizationId || job.status !== JOB_STATUS.ACCEPTED_WAITING_FOR_FUNDING) {
        return 'already_funded';
      }

      if (!orderId) {
        const err = new Error('PayPal return URL was missing the order token.');
        err.status = 400;
        throw err;
      }

      const { order, authorization } = await authorizeOrder(orderId, {
        requestId: `trustlance-auth-${job.id}-${orderId}`,
      });

      const authAmountValue = authorization.amount?.value || job.priceUsd;
      const authAmountCents = parseUsdToCents(authAmountValue) ?? job.priceCents;

      job.paypal = {
        ...job.paypal,
        pendingOrderId: null,
        orderId: order.id,
        orderStatus: order.status || 'COMPLETED',
        authorizationId: authorization.id,
        authorizationStatus: authorization.status || 'CREATED',
        authorizedAmountUsd: centsToUsd(authAmountCents),
        authorizedAmountCents: authAmountCents,
        authorizationExpiresAt: authorization.expiration_time || null,
        fundedAt: new Date().toISOString(),
      };
      job.status = JOB_STATUS.FUNDED;
      job.lastError = null;
      await saveJob(job);

      console.log(
        `[TrustLance] Job ${job.id} funded: order=${order.id}, authorization=${authorization.id}, amount=$${job.paypal.authorizedAmountUsd} USD`
      );
      return 'funded';
    });

    return res.redirect(
      303,
      `/job/${encodeURIComponent(jobId)}?role=client&notice=${encodeURIComponent(notice)}`
    );
  } catch (err) {
    console.error(`[TrustLance] Failed to authorize PayPal return for job ${jobId}:`, err.message);
    const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    return res.status(status).send(
      renderErrorView({
        title: 'PayPal Authorization Error',
        message: toFriendlyError(err),
        backHref: `/job/${encodeURIComponent(jobId)}?role=client`,
        backLabel: 'Return to Job Page',
        configStatus,
      })
    );
  }
});

// --- Submission, AI Verification & Escrow Settlement ---

app.post('/api/jobs/:id/submit', async (req, res) => {
  const jobId = req.params.id;
  const submissionType = req.body?.submissionType === 'url' ? 'url' : 'text';

  try {
    const updatedJob = await withJobLock(jobId, async () => {
      const job = getJob(jobId);
      if (!job) {
        const err = new Error('Escrow job not found.');
        err.status = 404;
        throw err;
      }

      if (job.status === JOB_STATUS.COMPLETED || job.settlement?.settledAt) {
        const err = new Error('This job has already been evaluated and settled.');
        err.status = 409;
        throw err;
      }

      if (job.status === JOB_STATUS.UNDER_AI_REVIEW) {
        const err = new Error('This job already has a submission under AI review.');
        err.status = 409;
        throw err;
      }

      if (job.status !== JOB_STATUS.FUNDED) {
        const err = new Error('Work can only be submitted after the job is funded.');
        err.status = 400;
        throw err;
      }

      let submission;
      if (submissionType === 'url') {
        const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
        if (!rawUrl) {
          const err = new Error('Please enter a public URL to submit.');
          err.status = 400;
          throw err;
        }
        const fetched = await fetchPublicUrlContent(rawUrl);
        submission = {
          type: 'url',
          sourceUrl: fetched.finalUrl,
          content: fetched.content,
          charCount: fetched.charCount,
          truncated: fetched.truncated,
          submittedAt: new Date().toISOString(),
        };
      } else {
        const rawText = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
        if (!rawText) {
          const err = new Error('Please paste your deliverable text or code before submitting.');
          err.status = 400;
          throw err;
        }
        const capped = rawText.slice(0, 15000);
        submission = {
          type: 'text',
          sourceUrl: null,
          content: capped,
          charCount: capped.length,
          truncated: rawText.length > 15000,
          submittedAt: new Date().toISOString(),
        };
      }

      // Step 4: Transition to "Under AI review" before running Gemini & PayPal settlement.
      job.submission = submission;
      job.status = JOB_STATUS.UNDER_AI_REVIEW;
      job.lastError = null;
      await saveJob(job);

      try {
        return await runReviewAndSettlement(job);
      } catch (reviewErr) {
        const msg = formatReviewError(job, reviewErr);
        job.lastError = msg;
        await saveJob(job);
        reviewErr.job = job;
        reviewErr.friendlyMessage = msg;
        throw reviewErr;
      }
    });

    return res.json({ job: updatedJob });
  } catch (err) {
    console.error(`[TrustLance] Submission/review error for job ${jobId}:`, err.message);
    const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    return res.status(status).json({
      error: err.friendlyMessage || toFriendlyError(err),
      job: err.job || null,
    });
  }
});

app.post('/api/jobs/:id/retry-settlement', async (req, res) => {
  const jobId = req.params.id;
  try {
    const updatedJob = await withJobLock(jobId, async () => {
      const job = getJob(jobId);
      if (!job) {
        const err = new Error('Escrow job not found.');
        err.status = 404;
        throw err;
      }

      if (job.status === JOB_STATUS.COMPLETED || job.settlement?.settledAt) {
        const err = new Error('This job has already been settled.');
        err.status = 409;
        throw err;
      }

      if (job.status !== JOB_STATUS.UNDER_AI_REVIEW) {
        const err = new Error('Only jobs currently under AI review can be retried.');
        err.status = 400;
        throw err;
      }

      try {
        return await runReviewAndSettlement(job);
      } catch (retryErr) {
        const msg = formatReviewError(job, retryErr);
        job.lastError = msg;
        await saveJob(job);
        retryErr.friendlyMessage = msg;
        throw retryErr;
      }
    });

    return res.json({ job: updatedJob });
  } catch (err) {
    console.error(`[TrustLance] Retry settlement error for job ${jobId}:`, err.message);
    const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    return res.status(status).json({ error: err.friendlyMessage || toFriendlyError(err) });
  }
});

// Preserve the original PayPal Sandbox Authorize & Partial Capture test page at /test
app.use(createTestRouter({ getBaseUrl }));

// 404 fallback
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found.' });
  }
  return res.status(404).send(
    renderErrorView({
      title: 'Page Not Found',
      message: `No page exists at "${req.path}".`,
      configStatus: getConfigStatus(),
    })
  );
});

// Global error fallback (JSON parse errors, unexpected runtime errors)
app.use((err, req, res, _next) => {
  console.error('Unhandled server error:', err?.message || err);
  if (req.path.startsWith('/api/')) {
    const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    return res.status(status).json({ error: toFriendlyError(err) });
  }
  return res.status(500).send(
    renderErrorView({
      title: 'Something Went Wrong',
      message: 'An unexpected server error occurred. Please try again.',
      configStatus: getConfigStatus(),
    })
  );
});

app.listen(PORT, HOST, () => {
  const status = getConfigStatus();
  const baseUrl = getBaseUrl();
  console.log(`TrustLance listening on http://${HOST}:${PORT}`);
  console.log(`TrustLance base URL: ${baseUrl}`);
  console.log(`PayPal Sandbox test page available at ${baseUrl}/test`);
  console.log(`Config: PayPal=${status.paypalReady ? 'ready' : 'missing'}`);

  initGeminiModelDiscovery()
    .then((geminiHealth) => {
      console.log(
        `Gemini status: ${geminiHealth.ready ? `ready (active=${geminiHealth.activeModel})` : 'unavailable'}`
      );
    })
    .catch((err) => {
      console.warn('Gemini initial discovery error:', err?.message || err);
    });
});
