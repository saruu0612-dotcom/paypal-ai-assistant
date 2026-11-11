require('dotenv').config();

const express = require('express');
const {
  PAYPAL_API_BASE,
  PayPalApiError,
  getCredentials,
  createAuthorizeOrder,
  authorizeOrder,
  captureAuthorization,
  getAuthorization,
} = require('./paypal');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const HOLD_AMOUNT_VALUE = '40.00';
const CAPTURE_AMOUNT_VALUE = '30.00';
const REMAINING_AMOUNT_VALUE = '10.00';
const CURRENCY_CODE = 'USD';

app.use(express.urlencoded({ extended: false }));

// In-memory store keyed by PayPal order ID so refreshing /return does not re-authorize.
const authorizedOrders = new Map();

function formatAmount(amountObj, fallback = `${HOLD_AMOUNT_VALUE} ${CURRENCY_CODE}`) {
  if (amountObj && amountObj.value) {
    return `${amountObj.value} ${amountObj.currency_code || CURRENCY_CODE}`;
  }
  return fallback;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPage(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f8fa;
      --card: #ffffff;
      --border: #d0d7de;
      --text: #1f2328;
      --muted: #656d76;
      --primary: #0070ba;
      --primary-hover: #005ea6;
      --success-bg: #dafbe1;
      --success-border: #2da44e;
      --error-bg: #ffebe9;
      --error-border: #cf222e;
      --warn-bg: #fff8c5;
      --warn-border: #d4a72c;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 2rem 1rem;
      line-height: 1.5;
    }
    main {
      max-width: 720px;
      margin: 0 auto;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.75rem;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
    }
    h1 {
      margin-top: 0;
      font-size: 1.5rem;
    }
    .subtitle {
      color: var(--muted);
      margin-top: -0.25rem;
      margin-bottom: 1.25rem;
    }
    .badge {
      display: inline-block;
      padding: 0.2rem 0.55rem;
      border-radius: 999px;
      font-size: 0.8rem;
      font-weight: 600;
      background: #ddf4ff;
      color: #0969da;
      margin-bottom: 0.75rem;
    }
    .panel {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem 1.15rem;
      margin: 1rem 0;
      background: #fbfcfd;
    }
    .panel.success {
      background: var(--success-bg);
      border-color: var(--success-border);
    }
    .panel.error {
      background: var(--error-bg);
      border-color: var(--error-border);
    }
    .panel.warn {
      background: var(--warn-bg);
      border-color: var(--warn-border);
    }
    dl {
      display: grid;
      grid-template-columns: 180px 1fr;
      gap: 0.45rem 1rem;
      margin: 0;
    }
    dt {
      font-weight: 600;
      color: var(--muted);
    }
    dd {
      margin: 0;
      word-break: break-word;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.92rem;
    }
    button, .btn {
      display: inline-block;
      background: var(--primary);
      color: #ffffff;
      border: none;
      border-radius: 6px;
      padding: 0.7rem 1.25rem;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
    }
    button:hover, .btn:hover {
      background: var(--primary-hover);
    }
    .btn-secondary {
      background: #eaeef2;
      color: var(--text);
      margin-left: 0.5rem;
    }
    .btn-secondary:hover {
      background: #d8dee4;
    }
    details {
      margin-top: 1rem;
    }
    summary {
      cursor: pointer;
      font-weight: 600;
      color: var(--muted);
    }
    pre {
      background: #1f2328;
      color: #f0f6fc;
      padding: 1rem;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 0.85rem;
    }
    .actions {
      margin-top: 1.25rem;
    }
  </style>
</head>
<body>
  <main>
    <span class="badge">PayPal Sandbox &middot; ${escapeHtml(PAYPAL_API_BASE)}</span>
    ${bodyHtml}
  </main>
</body>
</html>`;
}

function renderErrorPage(res, title, err) {
  const statusCode = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  const isPayPal = err instanceof PayPalApiError;

  const detailsHtml =
    isPayPal && err.details.length > 0
      ? `<ul>${err.details
          .map(
            (d) =>
              `<li><strong>${escapeHtml(d.issue || 'DETAIL')}</strong>: ${escapeHtml(
                d.description || ''
              )}${d.field ? ` (field: <code>${escapeHtml(d.field)}</code>)` : ''}</li>`
          )
          .join('')}</ul>`
      : '';

  const rawBlock =
    isPayPal && err.raw
      ? `<details open><summary>Raw PayPal Error Response</summary><pre>${escapeHtml(
          typeof err.raw === 'string' ? err.raw : JSON.stringify(err.raw, null, 2)
        )}</pre></details>`
      : '';

  return res.status(statusCode).send(
    renderPage(
      title,
      `
      <h1>${escapeHtml(title)}</h1>
      <div class="panel error">
        <p><strong>${escapeHtml(err?.message || 'An unexpected error occurred.')}</strong></p>
        ${
          isPayPal
            ? `<dl>
                <dt>Endpoint</dt><dd>${escapeHtml(err.endpoint || 'N/A')}</dd>
                <dt>HTTP Status</dt><dd>${escapeHtml(err.status ?? 'N/A')}</dd>
                <dt>PayPal Error</dt><dd>${escapeHtml(err.paypalName || 'N/A')}</dd>
                <dt>Debug ID</dt><dd>${escapeHtml(err.debugId || 'N/A')}</dd>
              </dl>`
            : ''
        }
        ${detailsHtml}
      </div>
      ${rawBlock}
      <div class="actions">
        <a class="btn" href="/">Back to Start</a>
      </div>
    `
    )
  );
}

function getBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

app.get('/', (req, res) => {
  let credsReady = true;
  let credsMessage = 'PAYPAL_CLIENT_ID and PAYPAL_SECRET loaded from .env.';

  try {
    getCredentials();
  } catch (err) {
    credsReady = false;
    credsMessage = err.message;
  }

  res.send(
    renderPage(
      'PayPal Sandbox: Authorize & Partial Capture',
      `
      <h1>PayPal Authorize &amp; Partial Capture Test</h1>
      <p class="subtitle">
        Proves holding <strong>$${escapeHtml(HOLD_AMOUNT_VALUE)} ${escapeHtml(CURRENCY_CODE)}</strong> with <code>AUTHORIZE</code>,
        then capturing <strong>$${escapeHtml(CAPTURE_AMOUNT_VALUE)} ${escapeHtml(CURRENCY_CODE)}</strong> with
        <code>final_capture: true</code> so the remaining
        <strong>$${escapeHtml(REMAINING_AMOUNT_VALUE)} ${escapeHtml(CURRENCY_CODE)}</strong> is released back to the buyer.
      </p>
      <div class="panel ${credsReady ? '' : 'error'}">
        <strong>Environment Status:</strong> ${escapeHtml(credsMessage)}
      </div>
      <div class="panel">
        <ol>
          <li>Click <strong>Hold $40</strong> to create an Orders v2 order (<code>intent: AUTHORIZE</code> for <code>40.00 USD</code>) and redirect to PayPal Sandbox.</li>
          <li>Approve the 40.00 USD hold as a Sandbox buyer; PayPal returns to <code>/return</code> and the server authorizes the order.</li>
          <li>Click <strong>Release $30 to freelancer</strong> to capture 30.00 USD with <code>final_capture: true</code>.</li>
        </ol>
      </div>
      <form method="POST" action="/create-order" class="actions">
        <button type="submit">Hold $40</button>
      </form>
    `
    )
  );
});

app.post('/create-order', async (req, res) => {
  try {
    const baseUrl = getBaseUrl(req);
    const { order, approvalUrl } = await createAuthorizeOrder({
      amountValue: HOLD_AMOUNT_VALUE,
      currencyCode: CURRENCY_CODE,
      returnUrl: `${baseUrl}/return`,
      cancelUrl: `${baseUrl}/cancel`,
    });

    console.log(
      `Created AUTHORIZE order ${order.id} for ${HOLD_AMOUNT_VALUE} ${CURRENCY_CODE}, status=${order.status}`
    );
    return res.redirect(303, approvalUrl);
  } catch (err) {
    console.error('Failed to create PayPal order:', err.message);
    return renderErrorPage(res, 'Failed to Create PayPal Order', err);
  }
});

app.get('/cancel', (req, res) => {
  const token = req.query.token || 'unknown';
  res.send(
    renderPage(
      'Payment Cancelled',
      `
      <h1>Approval Cancelled</h1>
      <div class="panel warn">
        <p>The buyer cancelled approval on PayPal Sandbox for order <code>${escapeHtml(token)}</code>. No funds were held.</p>
      </div>
      <div class="actions">
        <a class="btn" href="/">Back to Start</a>
      </div>
    `
    )
  );
});

app.get('/return', async (req, res) => {
  const orderId = typeof req.query.token === 'string' ? req.query.token.trim() : '';

  if (!orderId) {
    return renderErrorPage(
      res,
      'Missing Order Token',
      Object.assign(
        new Error('PayPal return URL did not include a "token" query parameter.'),
        { status: 400 }
      )
    );
  }

  try {
    let result = authorizedOrders.get(orderId);
    let fromCache = true;

    if (!result) {
      result = await authorizeOrder(orderId);
      authorizedOrders.set(orderId, result);
      fromCache = false;
      console.log(
        `Authorized order ${orderId}: authorization ID=${result.authorization.id}, status=${result.authorization.status}`
      );
    }

    const { order, authorization } = result;
    const authAmountDisplay = formatAmount(authorization.amount);

    return res.send(
      renderPage(
        'Order Authorized',
        `
        <h1>Authorization Complete</h1>
        <p class="subtitle">
          Funds are now held on the buyer's account${fromCache ? ' (loaded from current session)' : ''}.
        </p>
        <div class="panel success">
          <dl>
            <dt>Order ID</dt><dd>${escapeHtml(order.id)}</dd>
            <dt>Order Status</dt><dd>${escapeHtml(order.status)}</dd>
            <dt>Authorization ID</dt><dd>${escapeHtml(authorization.id)}</dd>
            <dt>Authorization Status</dt><dd>${escapeHtml(authorization.status)}</dd>
            <dt>Held Amount</dt><dd>${escapeHtml(authAmountDisplay)}</dd>
            <dt>Expires At</dt><dd>${escapeHtml(authorization.expiration_time || 'N/A')}</dd>
          </dl>
        </div>

        <form method="POST" action="/capture" class="actions">
          <input type="hidden" name="authorizationId" value="${escapeHtml(authorization.id)}" />
          <input type="hidden" name="orderId" value="${escapeHtml(order.id)}" />
          <button type="submit">Release $30 to freelancer</button>
          <a class="btn btn-secondary" href="/">Start Over</a>
        </form>

        <details>
          <summary>Authorize Response JSON</summary>
          <pre>${escapeHtml(JSON.stringify(order, null, 2))}</pre>
        </details>
      `
      )
    );
  } catch (err) {
    console.error(`Failed to authorize order ${orderId}:`, err.message);
    return renderErrorPage(res, 'Failed to Authorize PayPal Order', err);
  }
});

app.post('/capture', async (req, res) => {
  const authorizationId =
    typeof req.body.authorizationId === 'string' ? req.body.authorizationId.trim() : '';
  const orderId = typeof req.body.orderId === 'string' ? req.body.orderId.trim() : '';

  if (!authorizationId) {
    return renderErrorPage(
      res,
      'Missing Authorization ID',
      Object.assign(new Error('Cannot capture without an authorizationId.'), { status: 400 })
    );
  }

  try {
    const capture = await captureAuthorization(authorizationId, {
      amountValue: CAPTURE_AMOUNT_VALUE,
      currencyCode: CURRENCY_CODE,
      finalCapture: true,
    });

    console.log(
      `Captured authorization ${authorizationId}: capture ID=${capture.id}, status=${capture.status}, amount=${capture.amount?.value || CAPTURE_AMOUNT_VALUE} ${capture.amount?.currency_code || CURRENCY_CODE}, final_capture=${capture.final_capture}`
    );

    let updatedAuthorization = null;
    try {
      updatedAuthorization = await getAuthorization(authorizationId);
    } catch (lookupErr) {
      console.warn(
        `Capture succeeded, but follow-up GET authorization ${authorizationId} failed:`,
        lookupErr.message
      );
    }

    const capturedAmountDisplay = formatAmount(
      capture.amount,
      `${CAPTURE_AMOUNT_VALUE} ${CURRENCY_CODE}`
    );
    const breakdown = capture.seller_receivable_breakdown;

    return res.send(
      renderPage(
        'Partial Capture Complete',
        `
        <h1>Capture Result (30.00 USD Released)</h1>
        <p class="subtitle">
          Captured <strong>${escapeHtml(capturedAmountDisplay)}</strong> with
          <code>final_capture: true</code>; the remaining
          <strong>${escapeHtml(REMAINING_AMOUNT_VALUE)} ${escapeHtml(CURRENCY_CODE)}</strong> has been released back to the buyer.
        </p>
        <div class="panel success">
          <dl>
            ${orderId ? `<dt>Order ID</dt><dd>${escapeHtml(orderId)}</dd>` : ''}
            <dt>Authorization ID</dt><dd>${escapeHtml(authorizationId)}</dd>
            ${
              updatedAuthorization?.status
                ? `<dt>Authorization Status</dt><dd>${escapeHtml(updatedAuthorization.status)}</dd>`
                : ''
            }
            <dt>Capture ID</dt><dd>${escapeHtml(capture.id)}</dd>
            <dt>Capture Status</dt><dd>${escapeHtml(capture.status)}</dd>
            <dt>Captured Amount</dt><dd>${escapeHtml(capturedAmountDisplay)}</dd>
            <dt>final_capture</dt><dd>${escapeHtml(String(capture.final_capture))}</dd>
            ${
              breakdown?.paypal_fee
                ? `<dt>PayPal Fee</dt><dd>${escapeHtml(
                    formatAmount(breakdown.paypal_fee)
                  )}</dd>`
                : ''
            }
            ${
              breakdown?.net_amount
                ? `<dt>Net Receivable</dt><dd>${escapeHtml(
                    formatAmount(breakdown.net_amount)
                  )}</dd>`
                : ''
            }
          </dl>
        </div>

        <div class="actions">
          <a class="btn" href="/">Run Another Test</a>
        </div>

        <details open>
          <summary>Capture Response JSON</summary>
          <pre>${escapeHtml(JSON.stringify(capture, null, 2))}</pre>
        </details>
        ${
          updatedAuthorization
            ? `<details>
                <summary>Updated Authorization JSON</summary>
                <pre>${escapeHtml(JSON.stringify(updatedAuthorization, null, 2))}</pre>
              </details>`
            : ''
        }
      `
      )
    );
  } catch (err) {
    console.error(`Failed to capture authorization ${authorizationId}:`, err.message);
    return renderErrorPage(res, 'Failed to Capture Authorization', err);
  }
});

app.listen(PORT, () => {
  console.log(`PayPal Sandbox test app listening at http://localhost:${PORT}`);
  try {
    getCredentials();
    console.log('Loaded PAYPAL_CLIENT_ID and PAYPAL_SECRET from .env');
  } catch (err) {
    console.warn(`Warning: ${err.message}`);
  }
});
