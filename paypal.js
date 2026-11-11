const crypto = require('crypto');

const PAYPAL_API_BASE = 'https://api-m.sandbox.paypal.com';

/**
 * Error class wrapping PayPal REST/OAuth error responses with structured diagnostics.
 */
class PayPalApiError extends Error {
  constructor(message, { status, endpoint, debugId, paypalName, details, raw } = {}) {
    super(message);
    this.name = 'PayPalApiError';
    this.status = status;
    this.endpoint = endpoint;
    this.debugId = debugId || null;
    this.paypalName = paypalName || null;
    this.details = Array.isArray(details) ? details : [];
    this.raw = raw;
  }
}

function getCredentials() {
  const clientId = (process.env.PAYPAL_CLIENT_ID || '').trim();
  const secret = (process.env.PAYPAL_SECRET || '').trim();

  if (!clientId || !secret) {
    throw new Error(
      'Missing PAYPAL_CLIENT_ID or PAYPAL_SECRET in .env. Please populate both Sandbox credentials.'
    );
  }

  return { clientId, secret };
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return { data: null, rawText: '' };
  }

  try {
    return { data: JSON.parse(text), rawText: text };
  } catch {
    return { data: null, rawText: text };
  }
}

function buildPayPalError(status, endpoint, data, rawText) {
  if (data && typeof data === 'object') {
    const paypalName = data.name || data.error || 'PAYPAL_API_ERROR';
    const baseMsg = data.message || data.error_description || 'PayPal API request failed';
    const debugId = data.debug_id || null;
    const details = Array.isArray(data.details) ? data.details : [];

    const detailMessages = details
      .map((d) => [d.issue, d.description, d.field ? `(field: ${d.field})` : ''].filter(Boolean).join(' - '))
      .filter(Boolean);

    const parts = [`PayPal ${paypalName} (HTTP ${status}): ${baseMsg}`];
    if (detailMessages.length > 0) {
      parts.push(`Details: ${detailMessages.join('; ')}`);
    }
    if (debugId) {
      parts.push(`Debug ID: ${debugId}`);
    }

    return new PayPalApiError(parts.join(' | '), {
      status,
      endpoint,
      debugId,
      paypalName,
      details,
      raw: data,
    });
  }

  return new PayPalApiError(
    `PayPal API error (HTTP ${status}) at ${endpoint}: ${rawText || 'Empty response body'}`,
    {
      status,
      endpoint,
      raw: rawText,
    }
  );
}

function logPayPalError(err) {
  if (err instanceof PayPalApiError) {
    console.error('=== PayPal API Error ===');
    console.error(`Endpoint: ${err.endpoint}`);
    console.error(`HTTP Status: ${err.status}`);
    if (err.paypalName) console.error(`Error Name: ${err.paypalName}`);
    if (err.debugId) console.error(`Debug ID: ${err.debugId}`);
    console.error(`Message: ${err.message}`);
    if (err.details.length > 0) {
      console.error('Details:', JSON.stringify(err.details, null, 2));
    }
    if (err.raw) {
      console.error('Raw Response:', typeof err.raw === 'string' ? err.raw : JSON.stringify(err.raw, null, 2));
    }
    console.error('========================');
  } else {
    console.error('PayPal Flow Error:', err);
  }
}

async function getAccessToken() {
  const { clientId, secret } = getCredentials();
  const endpoint = '/v1/oauth2/token';
  const basicAuth = Buffer.from(`${clientId}:${secret}`).toString('base64');

  const response = await fetch(`${PAYPAL_API_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });

  const { data, rawText } = await parseResponseBody(response);

  if (!response.ok || !data?.access_token) {
    const err = buildPayPalError(response.status, endpoint, data, rawText);
    logPayPalError(err);
    throw err;
  }

  return data.access_token;
}

async function paypalRequest(method, endpoint, { body, requestId, preferRepresentation = false } = {}) {
  const accessToken = await getAccessToken();

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (requestId) {
    headers['PayPal-Request-Id'] = requestId;
  }
  if (preferRepresentation) {
    headers.Prefer = 'return=representation';
  }

  const response = await fetch(`${PAYPAL_API_BASE}${endpoint}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const { data, rawText } = await parseResponseBody(response);

  if (!response.ok) {
    const err = buildPayPalError(response.status, endpoint, data, rawText);
    logPayPalError(err);
    throw err;
  }

  return data;
}

async function createAuthorizeOrder({ amountValue = '40.00', currencyCode = 'USD', returnUrl, cancelUrl }) {
  const order = await paypalRequest('POST', '/v2/checkout/orders', {
    requestId: crypto.randomUUID(),
    preferRepresentation: true,
    body: {
      intent: 'AUTHORIZE',
      purchase_units: [
        {
          description: `Freelancer escrow authorization hold (${amountValue} ${currencyCode})`,
          amount: {
            currency_code: currencyCode,
            value: amountValue,
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
    },
  });

  const approvalLink = order?.links?.find(
    (link) => link.rel === 'payer-action' || link.rel === 'approve'
  );

  if (!approvalLink?.href) {
    throw new PayPalApiError(
      'PayPal order created, but no approval/payer-action redirect link was returned.',
      {
        status: 500,
        endpoint: '/v2/checkout/orders',
        raw: order,
      }
    );
  }

  return { order, approvalUrl: approvalLink.href };
}

async function authorizeOrder(orderId) {
  const order = await paypalRequest(
    'POST',
    `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`,
    {
      requestId: crypto.randomUUID(),
      preferRepresentation: true,
      body: {},
    }
  );

  const authorization = order?.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!authorization?.id) {
    throw new PayPalApiError(
      `Order ${orderId} authorize call succeeded, but no authorization object was returned.`,
      {
        status: 500,
        endpoint: `/v2/checkout/orders/${orderId}/authorize`,
        raw: order,
      }
    );
  }

  return { order, authorization };
}

async function captureAuthorization(
  authorizationId,
  { amountValue = '30.00', currencyCode = 'USD', finalCapture = true } = {}
) {
  return paypalRequest(
    'POST',
    `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`,
    {
      requestId: crypto.randomUUID(),
      preferRepresentation: true,
      body: {
        amount: {
          currency_code: currencyCode,
          value: amountValue,
        },
        final_capture: finalCapture,
        note_to_payer: `Partial capture of ${amountValue} ${currencyCode} released to freelancer; remainder released back to buyer.`,
      },
    }
  );
}

async function getAuthorization(authorizationId) {
  return paypalRequest(
    'GET',
    `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`
  );
}

module.exports = {
  PAYPAL_API_BASE,
  PayPalApiError,
  getCredentials,
  getAccessToken,
  createAuthorizeOrder,
  authorizeOrder,
  captureAuthorization,
  getAuthorization,
};

