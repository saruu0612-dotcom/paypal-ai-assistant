const { JOB_STATUS } = require('./store');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function getStatusClass(status) {
  switch (status) {
    case JOB_STATUS.WAITING_FOR_FREELANCER:
      return 'status-waiting';
    case JOB_STATUS.ACCEPTED_WAITING_FOR_FUNDING:
      return 'status-accepted';
    case JOB_STATUS.FUNDED:
      return 'status-funded';
    case JOB_STATUS.UNDER_AI_REVIEW:
      return 'status-review';
    case JOB_STATUS.COMPLETED:
      return 'status-completed';
    default:
      return 'status-waiting';
  }
}

function renderStatusBadge(status, idAttr = '') {
  const idPart = idAttr ? ` id="${escapeHtml(idAttr)}"` : '';
  return `<span${idPart} class="status-badge ${getStatusClass(status)}"><span class="status-dot"></span><span>${escapeHtml(status)}</span></span>`;
}

function renderLayout({ title, configStatus, bodyHtml }) {
  const paypalReady = Boolean(configStatus?.paypalReady);
  const geminiReady = Boolean(configStatus?.geminiReady);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <a href="/" class="brand">
        <span class="brand-mark" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
            <path d="m9 12 2 2 4-4"></path>
          </svg>
        </span>
        <span>TrustLance</span>
        <span class="brand-tag">AI Escrow</span>
      </a>
      <nav class="topbar-nav">
        <a href="/" class="nav-link">Create Job</a>
        <a href="/test" class="nav-link">PayPal Test (/test)</a>
        <div class="env-pills">
          <span class="env-pill" title="PayPal Sandbox configuration status">
            <span class="env-dot ${paypalReady ? 'ready' : 'missing'}"></span>
            PayPal ${paypalReady ? 'Ready' : 'Not Set'}
          </span>
          <span class="env-pill" title="Gemini AI service availability">
            <span class="env-dot ${geminiReady ? 'ready' : 'missing'}"></span>
            Gemini ${geminiReady ? 'Ready' : 'Unavailable'}
          </span>
        </div>
      </nav>
    </div>
  </header>
  <main class="container">
    ${bodyHtml}
  </main>
  <script src="/app.js"></script>
</body>
</html>`;
}

function renderHomePage({ jobs, configStatus }) {
  const envWarnings = [];
  if (!configStatus.paypalReady) {
    envWarnings.push('PayPal Sandbox credentials (<code>PAYPAL_CLIENT_ID</code>, <code>PAYPAL_SECRET</code>) are missing in <code>.env</code>.');
  }
  if (!configStatus.geminiReady) {
    envWarnings.push('AI verification service is currently unavailable.');
  }

  const warningHtml =
    envWarnings.length > 0
      ? `<div class="alert alert-warn"><strong>Setup Notice:</strong> ${envWarnings.join(' ')}</div>`
      : '';

  const jobsListHtml =
    jobs.length === 0
      ? `<p class="muted">No escrow jobs created yet. Create your first AI-verified escrow contract on the left.</p>`
      : `<div class="job-list">
          ${jobs
            .map(
              (job) => `
            <a class="job-list-item" href="/job/${encodeURIComponent(job.id)}">
              <div class="job-list-top">
                <span class="job-list-title">${escapeHtml(job.title || `Escrow Job #${job.id}`)}</span>
                ${renderStatusBadge(job.status)}
              </div>
              <div class="job-list-meta">
                <span><strong>$${escapeHtml(job.priceUsd)} USD</strong></span>
                <span>&middot;</span>
                <span>${job.checklist.length} criteria</span>
                <span>&middot;</span>
                <span class="mono">#${escapeHtml(job.id)}</span>
                <span>&middot;</span>
                <span>${escapeHtml(formatDate(job.createdAt))}</span>
              </div>
            </a>`
            )
            .join('')}
        </div>`;

  const bodyHtml = `
    <section class="hero">
      <div class="hero-eyebrow">PayPal Authorize + Gemini Verification</div>
      <h1>Milestone escrow that settles automatically from verifiable proof</h1>
      <p>
        Describe the deliverable in plain English, lock funds with a PayPal Sandbox authorization hold,
        and let Gemini verify each checklist item before releasing exact pro-rata payouts.
      </p>
    </section>

    ${warningHtml}

    <div class="grid-2" id="job-builder">
      <div>
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">1. Create an Escrow Job</h2>
            <span class="muted">Step 1 of 2</span>
          </div>

          <div id="create-error" class="alert alert-error hidden" role="alert" style="display:flex; align-items:center; justify-content:space-between; gap:0.75rem; flex-wrap:wrap;">
            <span id="create-error-text"></span>
            <button type="button" id="create-retry-btn" class="btn btn-secondary btn-sm hidden">Try again</button>
          </div>

          <form id="checklist-form">
            <div class="field">
              <label for="job-description">Plain-English Work Description</label>
              <textarea
                id="job-description"
                class="textarea"
                placeholder="Example: Build a responsive HTML/CSS pricing section with 3 tiers (Starter, Pro, Enterprise), a clear CTA button per tier, and clean accessible headings."
                required
              ></textarea>
              <div class="samples">
                <button
                  type="button"
                  class="sample-chip"
                  data-sample-price="40.00"
                  data-sample-desc="Build a single-page HTML product landing snippet with an H1 headline, 3 feature bullet points, a pricing tier showing $29/mo, and a signup email form."
                >Sample: Landing HTML ($40)</button>
                <button
                  type="button"
                  class="sample-chip"
                  data-sample-price="60.00"
                  data-sample-desc="Write a JavaScript utility module exporting formatCurrency(cents) and slugify(text), plus 4 edge-case unit assertions and a short README usage snippet."
                >Sample: JS Utility ($60)</button>
                <button
                  type="button"
                  class="sample-chip"
                  data-sample-price="30.00"
                  data-sample-desc="Write a 250-word technical product release note for an API v2 launch covering: breaking changes summary, migration command, and deprecation date."
                >Sample: Release Note ($30)</button>
              </div>
            </div>

            <div class="field">
              <label for="job-price">Escrow Budget (USD)</label>
              <div class="price-wrap">
                <span class="price-prefix">$</span>
                <input
                  id="job-price"
                  type="number"
                  step="0.01"
                  min="1"
                  max="100000"
                  class="input price-input"
                  value="40.00"
                  required
                />
                <span class="price-suffix">USD</span>
              </div>
            </div>

            <button type="submit" id="generate-checklist-btn" class="btn btn-primary">
              Generate AI Checklist
            </button>
          </form>
        </div>

        <div id="checklist-step" class="card hidden">
          <div class="card-header">
            <h2 class="card-title">2. Review &amp; Edit Verification Checklist</h2>
            <span class="muted">3&ndash;6 criteria</span>
          </div>

          <div class="field">
            <label for="job-title-input">Job Title</label>
            <input id="job-title-input" type="text" class="input" maxlength="100" />
          </div>

          <div class="field">
            <label>Verifiable Deliverable Criteria (edit or remove before publishing)</label>
            <div id="checklist-editor-list" class="checklist-editor-list"></div>
            <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
              <button type="button" id="add-item-btn" class="btn btn-secondary btn-sm">+ Add Item</button>
              <button type="button" id="regenerate-checklist-btn" class="btn btn-secondary btn-sm">Regenerate with AI</button>
            </div>
          </div>

          <div class="alert alert-info" style="margin-bottom:0;">
            <strong>Escrow Payout Formula:</strong>
            <code>Payout = Price &times; (Passed Items / Total Items)</code>, rounded down to cents. Uncaptured remainder is released back to the client.
          </div>

          <div class="editor-actions">
            <span class="muted">Creates a shareable <code>/job/:id</code> escrow link.</span>
            <button type="button" id="create-job-btn" class="btn btn-emerald" style="width:auto;">
              Create job
            </button>
          </div>
        </div>
      </div>

      <div>
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">Recent Escrow Jobs</h2>
            <span class="muted">${jobs.length} saved</span>
          </div>
          ${jobsListHtml}
        </div>

        <div class="card">
          <div class="card-header">
            <h2 class="card-title">How TrustLance Works</h2>
          </div>
          <ol class="how-list">
            <li><strong>Client defines scope:</strong> Gemini converts plain English into 3&ndash;6 objective checklist items.</li>
            <li><strong>Freelancer accepts:</strong> Opens the shared link and accepts the terms.</li>
            <li><strong>PayPal Authorize hold:</strong> Client funds the full budget using PayPal Orders v2 (<code>AUTHORIZE</code>) without immediate capture.</li>
            <li><strong>AI verification:</strong> Freelancer submits pasted text/code or a public URL. Gemini evaluates pass/fail per item.</li>
            <li><strong>Automatic settlement:</strong> Server captures exact earned payout with <code>final_capture: true</code> (or voids if $0.00), releasing any remainder back to the client.</li>
          </ol>
        </div>
      </div>
    </div>
  `;

  return renderLayout({
    title: 'TrustLance — AI-Powered Freelancer Escrow',
    configStatus,
    bodyHtml,
  });
}

function renderStepper(status) {
  const steps = [
    { key: JOB_STATUS.WAITING_FOR_FREELANCER, label: 'Created' },
    { key: JOB_STATUS.ACCEPTED_WAITING_FOR_FUNDING, label: 'Accepted' },
    { key: JOB_STATUS.FUNDED, label: 'Funded' },
    { key: JOB_STATUS.UNDER_AI_REVIEW, label: 'AI Review' },
    { key: JOB_STATUS.COMPLETED, label: 'Completed' },
  ];

  const activeIdx = Math.max(
    0,
    steps.findIndex((s) => s.key === status)
  );

  return `<div class="stepper">
    ${steps
      .map((step, idx) => {
        const isDone = status === JOB_STATUS.COMPLETED ? true : idx < activeIdx;
        const isCurrent = status !== JOB_STATUS.COMPLETED && idx === activeIdx;
        const cls = isDone ? 'done' : isCurrent ? 'current' : '';
        return `<div class="step-pill ${cls}">
          <span class="step-num">${isDone ? '&#10003;' : idx + 1}</span>
          <span>${escapeHtml(step.label)}</span>
        </div>`;
      })
      .join('')}
  </div>`;
}

function renderNoticeBanner(notice, job) {
  if (!notice) return '';
  switch (notice) {
    case 'accepted':
      return `<div class="alert alert-success"><strong>Job accepted!</strong> Status is now "${escapeHtml(job.status)}". Switch to <strong>Client</strong> view to fund the PayPal escrow hold.</div>`;
    case 'funded':
      return `<div class="alert alert-success"><strong>Escrow funded!</strong> PayPal authorized <strong>$${escapeHtml(job.paypal?.authorizedAmountUsd || job.priceUsd)} USD</strong>. Switch to <strong>Freelancer</strong> view to submit the completed work.</div>`;
    case 'already_funded':
      return `<div class="alert alert-info"><strong>Already funded:</strong> This job already has an active PayPal authorization hold (<code>${escapeHtml(job.paypal?.authorizationId || '')}</code>). Duplicate funding was prevented.</div>`;
    case 'cancelled':
      return `<div class="alert alert-warn"><strong>PayPal approval cancelled:</strong> No funds were authorized. You can click <strong>Fund job</strong> again when ready.</div>`;
    case 'completed':
      return `<div class="alert alert-success"><strong>Escrow settled!</strong> AI review is complete and PayPal settlement has been finalized.</div>`;
    default:
      return '';
  }
}

function renderResultPanel(job) {
  const review = job.review;
  const settlement = job.settlement;
  if (!review || !settlement) return '';

  const isVoided = Boolean(settlement.voided);
  const captureDisplay = isVoided
    ? 'None (Authorization Voided)'
    : settlement.captureId || '—';

  return `
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">AI Verification &amp; Escrow Settlement Result</h2>
        ${renderStatusBadge(job.status)}
      </div>

      <div class="alert ${settlement.payoutCents > 0 ? 'alert-success' : 'alert-warn'}">
        <strong>AI Overall Summary:</strong> ${escapeHtml(review.summary)}
      </div>

      <div class="payout-grid">
        <div class="stat-tile highlight">
          <div class="stat-label">Payout to Freelancer</div>
          <div class="stat-value">$${escapeHtml(settlement.payoutUsd)} USD</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Returned to Client</div>
          <div class="stat-value">$${escapeHtml(settlement.returnedUsd)} USD</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Checklist Score</div>
          <div class="stat-value">${escapeHtml(settlement.passedCount)} / ${escapeHtml(settlement.totalCount)} passed</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">PayPal Capture ID</div>
          <div class="stat-value mono" style="font-size:0.95rem; word-break:break-all;">${escapeHtml(captureDisplay)}</div>
        </div>
      </div>

      <dl class="kv-list" style="margin-top:0.75rem; padding-top:0.85rem; border-top:1px solid var(--border);">
        <dt>Escrow Hold</dt>
        <dd>$${escapeHtml(job.paypal?.authorizedAmountUsd || job.priceUsd)} USD</dd>
        <dt>PayPal Order ID</dt>
        <dd class="mono">${escapeHtml(job.paypal?.orderId || '—')}</dd>
        <dt>Authorization ID</dt>
        <dd class="mono">${escapeHtml(job.paypal?.authorizationId || '—')}</dd>
        <dt>Settlement Action</dt>
        <dd>${
          isVoided
            ? `Authorization voided (${escapeHtml(settlement.voidStatus || 'VOIDED')}) because payout was $0.00`
            : `Captured $${escapeHtml(settlement.payoutUsd)} USD with <code>final_capture: true</code> (${escapeHtml(settlement.captureStatus || 'COMPLETED')})`
        }</dd>
        <dt>Settled At</dt>
        <dd>${escapeHtml(formatDate(settlement.settledAt))}</dd>
      </dl>
    </div>
  `;
}

function renderChecklistCard(job) {
  const isCompleted = job.status === JOB_STATUS.COMPLETED && job.review?.results;
  const items = isCompleted ? job.review.results : job.checklist;

  return `
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Verification Checklist</h2>
        <span class="muted">${items.length} ${items.length === 1 ? 'requirement' : 'requirements'}</span>
      </div>
      <ul class="checklist-items">
        ${items
          .map((entry, idx) => {
            if (isCompleted) {
              const cls = entry.passed ? 'pass' : 'fail';
              return `<li class="checklist-item ${cls}">
                <span class="result-tag ${cls}">${entry.passed ? 'Pass' : 'Fail'}</span>
                <div class="checklist-item-body">
                  <div class="checklist-item-title">${idx + 1}. ${escapeHtml(entry.item)}</div>
                  <div class="checklist-item-reason">${escapeHtml(entry.reason)}</div>
                </div>
              </li>`;
            }
            return `<li class="checklist-item">
              <span class="item-num">${idx + 1}</span>
              <div class="checklist-item-body">
                <div class="checklist-item-title">${escapeHtml(entry.text)}</div>
              </div>
            </li>`;
          })
          .join('')}
      </ul>
    </div>
  `;
}

function renderSubmissionCard(job) {
  if (!job.submission) return '';
  const sub = job.submission;
  const sourceHtml =
    sub.type === 'url'
      ? `<p class="muted" style="margin-top:0;">Submitted Public URL: <a href="${escapeHtml(sub.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sub.sourceUrl)}</a> (${escapeHtml(sub.charCount)} chars fetched${sub.truncated ? ', truncated to 15,000 chars' : ''})</p>`
      : `<p class="muted" style="margin-top:0;">Submitted via Pasted Text / Code (${escapeHtml(sub.charCount)} chars)</p>`;

  return `
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Submitted Deliverable</h2>
        <span class="muted">${escapeHtml(formatDate(sub.submittedAt))}</span>
      </div>
      ${sourceHtml}
      <pre class="submission-preview">${escapeHtml(sub.content)}</pre>
    </div>
  `;
}

function renderUnderReviewCard(job, roleLabel) {
  if (job.lastError) {
    return `
      <div class="card">
        <div class="card-header">
          <h2 class="card-title">AI Review Needs Retry</h2>
        </div>
        <div class="alert alert-error">
          <strong>Review Paused:</strong> ${escapeHtml(job.lastError)}
        </div>
        <p class="muted" style="margin-top:0;">
          Your PayPal escrow authorization remains untouched. Click below to run the AI verification again.
        </p>
        <button type="button" data-retry-settlement-btn class="btn btn-primary" style="width:100%;">
          Try again
        </button>
      </div>
    `;
  }

  return `
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Under AI Review</h2>
      </div>
      <div class="alert alert-info">
        <span class="spinner spinner-dark" style="vertical-align:middle; margin-right:0.45rem;"></span>
        ${escapeHtml(roleLabel)}
      </div>
    </div>
  `;
}

function renderClientPanel(job) {
  switch (job.status) {
    case JOB_STATUS.WAITING_FOR_FREELANCER:
      return `
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">Client Actions</h2>
            <span class="muted">Step 2: Accept</span>
          </div>
          <div class="alert alert-info">
            <strong>Waiting for freelancer:</strong> Share this job page link with your freelancer so they can review the checklist and click <strong>Accept</strong>.
          </div>
          <p class="muted" style="margin-bottom:0;">
            PayPal funding becomes available immediately after the freelancer accepts the job. (In demo mode, switch the top toggle to <strong>Freelancer</strong> to accept.)
          </p>
        </div>
      `;

    case JOB_STATUS.ACCEPTED_WAITING_FOR_FUNDING:
      return `
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">Fund Escrow Hold</h2>
            <span class="muted">PayPal Orders v2</span>
          </div>
          <p class="muted" style="margin-top:0;">
            Freelancer accepted on ${escapeHtml(formatDate(job.acceptedAt))}. Authorize <strong>$${escapeHtml(job.priceUsd)} USD</strong> in PayPal Sandbox.
            Funds are held only — nothing is captured until Gemini verifies the submitted deliverable.
          </p>
          <form id="fund-job-form" method="POST" action="/jobs/${encodeURIComponent(job.id)}/fund">
            <button type="submit" id="fund-job-btn" class="btn btn-paypal">
              Fund job ($${escapeHtml(job.priceUsd)} USD)
            </button>
          </form>
        </div>
      `;

    case JOB_STATUS.FUNDED:
      return `
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">Escrow Funded</h2>
            <span class="muted">Authorized Hold</span>
          </div>
          <div class="alert alert-success">
            <strong>$${escapeHtml(job.paypal?.authorizedAmountUsd || job.priceUsd)} USD held on PayPal Sandbox.</strong>
            Waiting for the freelancer to submit work for AI review.
          </div>
          <dl class="kv-list">
            <dt>Order ID</dt>
            <dd class="mono">${escapeHtml(job.paypal?.orderId || '—')}</dd>
            <dt>Authorization ID</dt>
            <dd class="mono">${escapeHtml(job.paypal?.authorizationId || '—')}</dd>
            <dt>Auth Status</dt>
            <dd>${escapeHtml(job.paypal?.authorizationStatus || 'CREATED')}</dd>
            <dt>Funded At</dt>
            <dd>${escapeHtml(formatDate(job.paypal?.fundedAt))}</dd>
          </dl>
        </div>
      `;

    case JOB_STATUS.UNDER_AI_REVIEW:
      return renderUnderReviewCard(
        job,
        'Gemini is reviewing the deliverable and settling PayPal escrow.'
      );

    case JOB_STATUS.COMPLETED:
      return `
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">Client Summary</h2>
          </div>
          <div class="alert ${job.settlement?.returnedCents > 0 ? 'alert-success' : 'alert-info'}">
            <strong>${
              job.settlement?.voided
                ? 'Full authorization voided — $0.00 charged.'
                : `$${escapeHtml(job.settlement?.payoutUsd)} USD paid to freelancer.`
            }</strong>
            ${
              !job.settlement?.voided && job.settlement?.returnedCents > 0
                ? ` $${escapeHtml(job.settlement?.returnedUsd)} USD released back to you.`
                : ''
            }
          </div>
          <dl class="kv-list">
            <dt>Capture ID</dt>
            <dd class="mono">${escapeHtml(job.settlement?.voided ? 'Voided ($0.00)' : job.settlement?.captureId || '—')}</dd>
            <dt>Items Passed</dt>
            <dd>${escapeHtml(job.settlement?.passedCount)} of ${escapeHtml(job.settlement?.totalCount)}</dd>
          </dl>
        </div>
      `;

    default:
      return '';
  }
}

function renderFreelancerPanel(job) {
  switch (job.status) {
    case JOB_STATUS.WAITING_FOR_FREELANCER:
      return `
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">Accept Escrow Job</h2>
            <span class="muted">Step 2</span>
          </div>
          <p class="muted" style="margin-top:0;">
            Review the <strong>${job.checklist.length} verification criteria</strong> and total payout budget of
            <strong>$${escapeHtml(job.priceUsd)} USD</strong>. Accept to let the client fund the PayPal escrow hold.
          </p>
          <button type="button" id="accept-job-btn" class="btn btn-emerald">
            Accept Job
          </button>
        </div>
      `;

    case JOB_STATUS.ACCEPTED_WAITING_FOR_FUNDING:
      return `
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">Accepted &mdash; Waiting for Funding</h2>
          </div>
          <div class="alert alert-warn">
            <strong>Do not submit work yet.</strong> You accepted this job on ${escapeHtml(formatDate(job.acceptedAt))}.
            Once the client completes the PayPal authorization hold, you will see <strong>Payment secured</strong> and can submit your work.
          </div>
          <p class="muted" style="margin-bottom:0;">
            (In demo mode, switch the top toggle to <strong>Client</strong> to click <strong>Fund job</strong>.)
          </p>
        </div>
      `;

    case JOB_STATUS.FUNDED:
      return `
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">Submit Deliverable</h2>
          </div>

          <div class="payment-secured-banner">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
            <span>Payment secured &mdash; $${escapeHtml(job.paypal?.authorizedAmountUsd || job.priceUsd)} USD held in PayPal</span>
          </div>

          <div id="ai-review-live-box" class="alert alert-info hidden">
            <span class="spinner spinner-dark" style="vertical-align:middle; margin-right:0.45rem;"></span>
            <strong>Under AI review:</strong> Gemini is verifying your deliverable against all ${job.checklist.length} criteria and settling PayPal escrow...
          </div>

          <form id="submit-work-form">
            <div class="tab-row">
              <button type="button" class="tab-btn active" data-submit-mode="text">Paste Text / Code</button>
              <button type="button" class="tab-btn" data-submit-mode="url">Public URL</button>
            </div>

            <div id="submit-text-group" class="field">
              <label for="submission-text">Completed Work (text, markdown, or code)</label>
              <textarea
                id="submission-text"
                class="textarea"
                style="min-height:165px;"
                placeholder="Paste your completed deliverable text, HTML, or code here..."
              ></textarea>
            </div>

            <div id="submit-url-group" class="field hidden">
              <label for="submission-url">Public URL of Completed Deliverable</label>
              <input
                id="submission-url"
                type="url"
                class="input"
                placeholder="https://example.com/deliverable"
              />
              <p class="muted" style="margin:0.35rem 0 0; font-size:0.8rem;">
                Server fetches the page HTML/text (up to 15,000 characters) for Gemini verification.
              </p>
            </div>

            <button type="submit" id="submit-work-btn" class="btn btn-primary" style="width:100%;">
              Submit Work for AI Review
            </button>
          </form>
        </div>
      `;

    case JOB_STATUS.UNDER_AI_REVIEW:
      return renderUnderReviewCard(
        job,
        'Your submission is under AI verification and PayPal settlement.'
      );

    case JOB_STATUS.COMPLETED:
      return `
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">Freelancer Payout</h2>
          </div>
          <div class="alert ${job.settlement?.payoutCents > 0 ? 'alert-success' : 'alert-warn'}">
            <strong>${
              job.settlement?.payoutCents > 0
                ? `$${escapeHtml(job.settlement?.payoutUsd)} USD captured to you!`
                : 'No items passed — $0.00 payout (authorization voided).'
            }</strong>
          </div>
          <dl class="kv-list">
            <dt>Criteria Passed</dt>
            <dd>${escapeHtml(job.settlement?.passedCount)} of ${escapeHtml(job.settlement?.totalCount)}</dd>
            <dt>PayPal Capture ID</dt>
            <dd class="mono">${escapeHtml(job.settlement?.voided ? 'Voided ($0.00)' : job.settlement?.captureId || '—')}</dd>
          </dl>
        </div>
      `;

    default:
      return '';
  }
}

function renderJobPage({ job, role, notice, shareUrl, configStatus }) {
  const activeRole = role === 'freelancer' ? 'freelancer' : 'client';
  const noticeHtml = renderNoticeBanner(notice, job);
  const completedResultHtml = job.status === JOB_STATUS.COMPLETED ? renderResultPanel(job) : '';

  const bodyHtml = `
    <div id="job-page" data-job-id="${escapeHtml(job.id)}" data-initial-role="${activeRole}" data-share-url="${escapeHtml(shareUrl || '')}">
      <div class="role-bar">
        <div class="role-toggle-wrap">
          <span class="role-label">Viewing as:</span>
          <div class="segmented" role="group" aria-label="Demo role switcher">
            <button
              type="button"
              class="segmented-btn ${activeRole === 'client' ? 'active' : ''}"
              data-role-btn="client"
              aria-pressed="${activeRole === 'client' ? 'true' : 'false'}"
            >Client</button>
            <button
              type="button"
              class="segmented-btn ${activeRole === 'freelancer' ? 'active' : ''}"
              data-role-btn="freelancer"
              aria-pressed="${activeRole === 'freelancer' ? 'true' : 'false'}"
            >Freelancer</button>
          </div>
        </div>
        <div class="share-controls">
          <button type="button" id="copy-link-btn" class="btn btn-secondary btn-sm">Copy Share Link</button>
          <a href="/" class="btn btn-secondary btn-sm">+ New Job</a>
        </div>
      </div>

      ${noticeHtml}
      <div id="job-action-error" class="alert alert-error hidden" role="alert"></div>

      <section class="card job-header-card">
        <div class="job-header-top">
          <div>
            <span class="job-id-pill mono">Job #${escapeHtml(job.id)}</span>
            <h1 class="job-title">${escapeHtml(job.title || `Escrow Job #${job.id}`)}</h1>
            <div style="margin-top:0.65rem; display:flex; align-items:center; gap:0.75rem; flex-wrap:wrap;">
              ${renderStatusBadge(job.status, 'job-status-badge')}
              <span class="muted">Created ${escapeHtml(formatDate(job.createdAt))}</span>
            </div>
          </div>
          <div class="job-price-box">
            <div class="job-price-label">Escrow Budget</div>
            <div class="job-price-value">$${escapeHtml(job.priceUsd)} <span style="font-size:0.85rem; font-weight:600; color:var(--text-muted);">USD</span></div>
          </div>
        </div>
        ${renderStepper(job.status)}
      </section>

      <div class="grid-2">
        <div>
          ${completedResultHtml}
          <div class="card">
            <div class="card-header">
              <h2 class="card-title">Job Description</h2>
            </div>
            <p style="margin:0; white-space:pre-wrap; color:var(--text-secondary);">${escapeHtml(job.description)}</p>
          </div>
          ${renderChecklistCard(job)}
          ${renderSubmissionCard(job)}
        </div>

        <div>
          <div data-role-panel="client" class="${activeRole === 'client' ? '' : 'hidden'}">
            ${renderClientPanel(job)}
          </div>
          <div data-role-panel="freelancer" class="${activeRole === 'freelancer' ? '' : 'hidden'}">
            ${renderFreelancerPanel(job)}
          </div>
        </div>
      </div>
    </div>
  `;

  return renderLayout({
    title: `${job.title || `Job #${job.id}`} — TrustLance`,
    configStatus,
    bodyHtml,
  });
}

function renderErrorView({ title, message, detail, backHref = '/', backLabel = 'Back to TrustLance', configStatus }) {
  const bodyHtml = `
    <div class="card" style="max-width:680px; margin:1.5rem auto;">
      <div class="card-header">
        <h1 class="card-title" style="font-size:1.35rem;">${escapeHtml(title)}</h1>
      </div>
      <div class="alert alert-error">
        <strong>Error:</strong> ${escapeHtml(message)}
      </div>
      ${detail ? `<p class="muted">${escapeHtml(detail)}</p>` : ''}
      <a href="${escapeHtml(backHref)}" class="btn btn-primary">${escapeHtml(backLabel)}</a>
    </div>
  `;

  return renderLayout({
    title: `${title} — TrustLance`,
    configStatus,
    bodyHtml,
  });
}

module.exports = {
  escapeHtml,
  renderHomePage,
  renderJobPage,
  renderErrorView,
};

