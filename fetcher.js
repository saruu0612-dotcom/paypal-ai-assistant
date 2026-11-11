const dns = require('dns').promises;
const net = require('net');

const MAX_SUBMISSION_CHARS = 15000;
const MAX_DOWNLOAD_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 12000;
const MAX_REDIRECTS = 5;

class UrlFetchError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UrlFetchError';
    this.status = status;
  }
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIp(ip) {
  const normalized = String(ip || '').toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    return isPrivateIpv4(normalized.slice(7));
  }
  const version = net.isIP(normalized);
  if (version === 4) {
    return isPrivateIpv4(normalized);
  }
  if (version === 6) {
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
      return true;
    }
    return false;
  }
  return true;
}

async function assertPublicHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    throw new UrlFetchError('Please enter a valid public URL starting with https:// or http://.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlFetchError('Only http:// and https:// public URLs are supported.');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new UrlFetchError('Local or internal URLs cannot be fetched. Please provide a public URL.');
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new UrlFetchError('Private or loopback IP addresses are not allowed. Please provide a public URL.');
    }
    return parsed;
  }

  let records;
  try {
    records = await Promise.race([
      dns.lookup(hostname, { all: true }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DNS_TIMEOUT')), 5000)
      ),
    ]);
  } catch (err) {
    if (err?.message === 'DNS_TIMEOUT') {
      throw new UrlFetchError(
        `Timed out resolving "${hostname}". Please check that the URL is reachable and try again.`,
        504
      );
    }
    throw new UrlFetchError(
      `Could not resolve domain "${hostname}". Please check the URL and try again.`,
      422
    );
  }

  if (!Array.isArray(records) || records.length === 0 || records.some((r) => isPrivateIp(r.address))) {
    throw new UrlFetchError('The URL resolves to a private or unreachable network address.');
  }

  return parsed;
}

function isTextualContentType(contentType) {
  if (!contentType) return true;
  const lower = contentType.toLowerCase().split(';')[0].trim();
  return (
    lower.startsWith('text/') ||
    lower === 'application/json' ||
    lower === 'application/xml' ||
    lower === 'application/xhtml+xml' ||
    lower === 'application/javascript' ||
    lower === 'application/x-javascript' ||
    lower === 'application/typescript' ||
    lower.endsWith('+json') ||
    lower.endsWith('+xml')
  );
}

async function readResponseTextLimited(response, maxBytes) {
  if (!response.body) {
    return (await response.text()).slice(0, maxBytes);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      const remaining = maxBytes - total;
      if (remaining <= 0) break;
      chunks.push(value.byteLength > remaining ? value.subarray(0, remaining) : value);
      total += Math.min(value.byteLength, remaining);
      if (total >= maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

function cleanFetchedContent(rawText, contentType) {
  const lowerType = (contentType || '').toLowerCase();
  const looksLikeHtml =
    lowerType.includes('html') || /^\s*(<!doctype|<html)/i.test(rawText.slice(0, 200));

  let processed = rawText;
  if (looksLikeHtml) {
    processed = rawText
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[inline-image]')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n');
  }

  const trimmed = processed.trim();
  const truncated = trimmed.length > MAX_SUBMISSION_CHARS;
  return {
    content: trimmed.slice(0, MAX_SUBMISSION_CHARS),
    truncated,
  };
}

/**
 * Fetches a public URL's HTML or text content and limits it to 15,000 characters.
 */
async function fetchPublicUrlContent(rawUrl) {
  let currentUrl = await assertPublicHttpUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response;
    try {
      response = await fetch(currentUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': 'TrustLance-Escrow-Verifier/1.0',
          Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
        },
      });
    } catch (err) {
      const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new UrlFetchError(
        isTimeout
          ? 'Fetching the submitted URL timed out after 12 seconds. Please verify the site is online or paste your work directly.'
          : 'Could not reach the submitted URL. Please make sure it is publicly accessible.',
        502
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new UrlFetchError('Submitted URL returned an incomplete redirect response.', 422);
      }
      if (hop === MAX_REDIRECTS) {
        throw new UrlFetchError('Submitted URL redirected too many times.', 422);
      }
      currentUrl = await assertPublicHttpUrl(new URL(location, currentUrl).toString());
      continue;
    }

    if (!response.ok) {
      throw new UrlFetchError(
        `Submitted URL returned HTTP ${response.status}. Please make sure the link is public and working.`,
        422
      );
    }

    const contentType = response.headers.get('content-type') || '';
    if (!isTextualContentType(contentType)) {
      throw new UrlFetchError(
        `The submitted URL returned "${contentType}" instead of a webpage or text/code file. Please submit an HTML/text URL or paste your work directly.`,
        422
      );
    }

    const rawBody = await readResponseTextLimited(response, MAX_DOWNLOAD_BYTES);
    const { content, truncated } = cleanFetchedContent(rawBody, contentType);
    if (!content) {
      throw new UrlFetchError(
        'The submitted URL returned an empty page. Please paste your deliverable or submit a page with readable content.',
        422
      );
    }

    return {
      finalUrl: currentUrl.toString(),
      contentType: contentType || 'text/plain',
      content,
      truncated,
      charCount: content.length,
    };
  }

  throw new UrlFetchError('Unable to fetch the submitted URL.', 502);
}

module.exports = {
  MAX_SUBMISSION_CHARS,
  UrlFetchError,
  fetchPublicUrlContent,
};

