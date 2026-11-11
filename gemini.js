const { GoogleGenAI } = require('@google/genai');

const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const DEFAULT_FALLBACK_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
];
const MAX_TRANSIENT_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 20000;

class GeminiServiceError extends Error {
  constructor(message, { status = 502, code = 'GEMINI_ERROR', retryable = false } = {}) {
    super(message);
    this.name = 'GeminiServiceError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

class InvalidAiResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidAiResponseError';
  }
}

function getGeminiConfig() {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const model = (process.env.GEMINI_MODEL || '').trim() || DEFAULT_GEMINI_MODEL;

  const rawFallbacks = (process.env.GEMINI_FALLBACK_MODELS || '').trim();
  const parsedFallbacks = rawFallbacks
    ? rawFallbacks
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
    : DEFAULT_FALLBACK_MODELS;

  const seen = new Set([model]);
  const fallbackModels = [];
  for (const candidate of parsedFallbacks) {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      fallbackModels.push(candidate);
    }
  }

  if (!apiKey) {
    throw new GeminiServiceError(
      'Gemini AI is not configured yet. Please add GEMINI_API_KEY to your .env file.',
      { status: 503, code: 'GEMINI_MISSING_KEY' }
    );
  }

  return {
    apiKey,
    model,
    fallbackModels,
    models: [model, ...fallbackModels],
  };
}

function getClient() {
  const config = getGeminiConfig();
  return {
    ai: new GoogleGenAI({ apiKey: config.apiKey }),
    ...config,
  };
}

function classifyGeminiError(err, model) {
  if (err instanceof GeminiServiceError) {
    return { error: err, isTransient: err.retryable, isModelNotFound: false };
  }

  const rawMsg = String(err?.message || '');
  const lower = rawMsg.toLowerCase();
  const nameLower = String(err?.name || '').toLowerCase();
  const causeCode = String(err?.cause?.code || err?.code || '').toLowerCase();
  const statusCode = Number(err?.status || err?.statusCode) || 0;

  if (
    statusCode === 401 ||
    statusCode === 403 ||
    lower.includes('api key') ||
    lower.includes('permission_denied')
  ) {
    return {
      error: new GeminiServiceError(
        'Gemini API authentication failed. Please verify your GEMINI_API_KEY in .env.',
        { status: 502, code: 'GEMINI_AUTH_ERROR', retryable: false }
      ),
      isTransient: false,
      isModelNotFound: false,
    };
  }

  if (statusCode === 404 || (lower.includes('model') && lower.includes('not found'))) {
    return {
      error: new GeminiServiceError(
        `Configured Gemini model "${model}" was unavailable. Check GEMINI_MODEL in .env or use ${DEFAULT_GEMINI_MODEL}.`,
        { status: 502, code: 'GEMINI_MODEL_ERROR', retryable: false }
      ),
      isTransient: false,
      isModelNotFound: true,
    };
  }

  if (
    statusCode === 503 ||
    lower.includes('unavailable') ||
    lower.includes('high demand') ||
    lower.includes('overloaded')
  ) {
    return {
      error: new GeminiServiceError(
        'Gemini AI is temporarily experiencing high demand. Please try again in a moment.',
        { status: 503, code: 'GEMINI_UNAVAILABLE', retryable: true }
      ),
      isTransient: true,
      isModelNotFound: false,
    };
  }

  if (
    statusCode === 429 ||
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('resource_exhausted')
  ) {
    return {
      error: new GeminiServiceError(
        'Gemini AI rate limit reached. Please wait a moment and try again.',
        { status: 429, code: 'GEMINI_RATE_LIMIT', retryable: true }
      ),
      isTransient: true,
      isModelNotFound: false,
    };
  }

  if (
    statusCode === 504 ||
    statusCode === 408 ||
    nameLower === 'aborterror' ||
    nameLower === 'timeouterror' ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('deadline') ||
    lower.includes('"code":504') ||
    lower.includes('aborted') ||
    causeCode.includes('timeout') ||
    causeCode === 'etimedout' ||
    causeCode === 'econnreset' ||
    lower.includes('fetch') ||
    lower.includes('network')
  ) {
    return {
      error: new GeminiServiceError(
        'Request to Gemini AI timed out or encountered a network interruption. Please try again.',
        { status: 504, code: 'GEMINI_TIMEOUT', retryable: true }
      ),
      isTransient: true,
      isModelNotFound: false,
    };
  }

  return {
    error: new GeminiServiceError(
      'Gemini AI failed to process this request. Please try again in a moment.',
      { status: 502, code: 'GEMINI_API_ERROR', retryable: false }
    ),
    isTransient: false,
    isModelNotFound: false,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callSingleModelWithRetries(
  { ai, model, systemInstruction, promptContents, responseJsonSchema },
  { maxRetries = MAX_TRANSIENT_RETRIES, retryDelayMs = RETRY_DELAY_MS, timeoutMs = REQUEST_TIMEOUT_MS } = {}
) {
  let lastClassified = null;

  for (let retry = 0; retry <= maxRetries; retry += 1) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: promptContents,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseJsonSchema,
          temperature: 0.2,
          httpOptions: { timeout: timeoutMs },
          abortSignal: AbortSignal.timeout(timeoutMs),
        },
      });
      return { ok: true, response };
    } catch (err) {
      const classified = classifyGeminiError(err, model);
      lastClassified = classified;
      console.error(
        `Gemini call error (model=${model}, try=${retry + 1}/${maxRetries + 1}, code=${classified.error.code}):`,
        err?.message || err
      );

      if (classified.isTransient && retry < maxRetries) {
        console.warn(`Retrying ${model} in ${retryDelayMs}ms...`);
        await sleep(retryDelayMs);
        continue;
      }

      return { ok: false, classified };
    }
  }

  return { ok: false, classified: lastClassified };
}

/**
 * Calls Gemini in strict JSON mode with:
 * - Up to 3 retries (2s delay) per model on 503, 429, or timeout/network errors,
 * - Automatic fallback through GEMINI_FALLBACK_MODELS if a model remains unavailable,
 * - 1 automatic validation retry if the AI returns malformed or schema-invalid JSON.
 */
async function callGeminiJsonWithRetry(
  { systemInstruction, contents, responseJsonSchema, validate },
  retryOptions = {}
) {
  const { ai, models } = getClient();
  let lastTransientError = null;

  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = models[modelIndex];
    let lastValidationError = null;
    let shouldFallbackToNextModel = false;

    for (let jsonAttempt = 1; jsonAttempt <= 2; jsonAttempt += 1) {
      const promptContents =
        jsonAttempt === 1 || !lastValidationError
          ? contents
          : `${contents}\n\nIMPORTANT: Your previous response was rejected because: ${lastValidationError.message}. Return ONLY valid JSON strictly matching the schema.`;

      const callResult = await callSingleModelWithRetries(
        { ai, model, systemInstruction, promptContents, responseJsonSchema },
        retryOptions
      );

      if (!callResult.ok) {
        const { error, isTransient, isModelNotFound } = callResult.classified;
        if (isTransient || isModelNotFound) {
          lastTransientError = error;
          shouldFallbackToNextModel = true;
          if (modelIndex < models.length - 1) {
            console.warn(
              `Falling back from ${model} to ${models[modelIndex + 1]} after ${error.code}.`
            );
          }
          break;
        }
        throw error;
      }

      const rawText = typeof callResult.response?.text === 'string' ? callResult.response.text.trim() : '';
      if (!rawText) {
        lastValidationError = new InvalidAiResponseError('Gemini returned an empty response.');
        console.warn(`Gemini (${model}) JSON attempt ${jsonAttempt} returned empty text.`);
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        lastValidationError = new InvalidAiResponseError('Response was not valid JSON.');
        console.warn(`Gemini (${model}) JSON attempt ${jsonAttempt} returned unparseable JSON.`);
        continue;
      }

      try {
        return validate(parsed);
      } catch (validationErr) {
        lastValidationError =
          validationErr instanceof InvalidAiResponseError
            ? validationErr
            : new InvalidAiResponseError(validationErr?.message || 'Validation failed.');
        console.warn(
          `Gemini (${model}) JSON attempt ${jsonAttempt} failed validation: ${lastValidationError.message}`
        );
      }
    }

    if (!shouldFallbackToNextModel) {
      throw new GeminiServiceError(
        'AI returned an invalid response format twice. Please try again.',
        { status: 502, code: 'GEMINI_INVALID_JSON', retryable: true }
      );
    }
  }

  throw (
    lastTransientError ||
    new GeminiServiceError(
      'Gemini AI is temporarily unavailable across all configured models. Please try again.',
      { status: 503, code: 'GEMINI_ALL_MODELS_FAILED', retryable: true }
    )
  );
}

const CHECKLIST_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'A short, clear 3 to 7 word title summarizing the job.',
    },
    items: {
      type: 'array',
      description: '3 to 6 specific, objective, verifiable checklist criteria.',
      minItems: 3,
      maxItems: 6,
      items: {
        type: 'string',
      },
    },
  },
  required: ['title', 'items'],
  additionalProperties: false,
};

function validateChecklistPayload(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidAiResponseError('Top-level JSON must be an object.');
  }

  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  if (title.length < 3 || title.length > 100) {
    throw new InvalidAiResponseError('Job title must be a non-empty string up to 100 characters.');
  }

  if (!Array.isArray(parsed.items)) {
    throw new InvalidAiResponseError('items must be an array.');
  }

  const cleanedItems = [];
  const seen = new Set();
  for (const rawItem of parsed.items) {
    if (typeof rawItem !== 'string') {
      throw new InvalidAiResponseError('Each checklist item must be a string.');
    }
    const item = rawItem.trim().replace(/\s+/g, ' ');
    if (item.length < 4) {
      throw new InvalidAiResponseError('Checklist items cannot be empty or trivial.');
    }
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      cleanedItems.push(item);
    }
  }

  if (cleanedItems.length < 3 || cleanedItems.length > 6) {
    throw new InvalidAiResponseError('Checklist must contain between 3 and 6 distinct items.');
  }

  return { title, items: cleanedItems };
}

/**
 * Generates a short title and 3 to 6 specific, verifiable checklist items from a job description.
 */
async function generateChecklist({ description, priceUsd }, retryOptions) {
  const systemInstruction = [
    'You are an escrow contract analyst for TrustLance.',
    'Turn a client job description into 3 to 6 specific, objective, verifiable checklist requirements.',
    'Each requirement must be concrete enough that an AI reviewer can verify pass/fail from submitted text, code, or a fetched webpage.',
    'Avoid vague requirements like "looks good" or "high quality"; specify measurable deliverables.',
    'Return valid JSON matching the requested schema.',
  ].join(' ');

  const contents = [
    `Escrow Budget: $${priceUsd} USD`,
    'Client Job Description:',
    description.trim(),
  ].join('\n\n');

  return callGeminiJsonWithRetry(
    {
      systemInstruction,
      contents,
      responseJsonSchema: CHECKLIST_SCHEMA,
      validate: validateChecklistPayload,
    },
    retryOptions
  );
}

const EVALUATION_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'A short 1 to 2 sentence overall assessment of the submission.',
    },
    results: {
      type: 'array',
      description: 'One evaluation entry for every checklist item index.',
      items: {
        type: 'object',
        properties: {
          index: {
            type: 'integer',
            description: 'Zero-based index of the checklist item.',
          },
          passed: {
            type: 'boolean',
            description: 'True if clearly satisfied by the submission, false otherwise.',
          },
          reason: {
            type: 'string',
            description: 'One concise sentence explaining why the item passed or failed.',
          },
        },
        required: ['index', 'passed', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'results'],
  additionalProperties: false,
};

function validateEvaluationPayload(parsed, checklist) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidAiResponseError('Evaluation output must be a JSON object.');
  }

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  if (summary.length < 5) {
    throw new InvalidAiResponseError('Overall summary must be a non-empty string.');
  }

  if (!Array.isArray(parsed.results) || parsed.results.length !== checklist.length) {
    throw new InvalidAiResponseError(
      `results must contain exactly ${checklist.length} entries (one per checklist item).`
    );
  }

  const byIndex = new Map();
  for (const entry of parsed.results) {
    if (!entry || typeof entry !== 'object') {
      throw new InvalidAiResponseError('Each result entry must be an object.');
    }
    if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= checklist.length) {
      throw new InvalidAiResponseError('Each result index must match a valid checklist index.');
    }
    if (byIndex.has(entry.index)) {
      throw new InvalidAiResponseError('Duplicate checklist index in results.');
    }
    if (typeof entry.passed !== 'boolean') {
      throw new InvalidAiResponseError('Each result passed field must be a boolean.');
    }
    const reason = typeof entry.reason === 'string' ? entry.reason.trim().replace(/\s+/g, ' ') : '';
    if (reason.length < 4) {
      throw new InvalidAiResponseError('Each result reason must be a non-empty sentence.');
    }

    byIndex.set(entry.index, {
      id: checklist[entry.index].id,
      item: checklist[entry.index].text,
      passed: entry.passed,
      reason,
    });
  }

  if (byIndex.size !== checklist.length) {
    throw new InvalidAiResponseError('Missing evaluation for one or more checklist items.');
  }

  const orderedResults = checklist.map((_, idx) => byIndex.get(idx));
  return {
    summary,
    results: orderedResults,
  };
}

/**
 * Evaluates a freelancer submission against every item in the job checklist.
 */
async function evaluateSubmission(
  {
    title,
    description,
    checklist,
    submissionType,
    submissionSource,
    submissionContent,
  },
  retryOptions
) {
  const systemInstruction = [
    'You are an impartial escrow verification reviewer for TrustLance.',
    'Evaluate the freelancer submission strictly and fairly against each numbered checklist item.',
    'Do not give credit for unfulfilled or missing requirements, and do not fail items that are clearly demonstrated.',
    'Do not invent payouts or percentages. Only return JSON with an overall summary and pass/fail plus a one-sentence reason for every checklist index.',
  ].join(' ');

  const numberedChecklist = checklist
    .map((item, idx) => `[${idx}] ${item.text}`)
    .join('\n');

  const sourceLine =
    submissionType === 'url'
      ? `Submission Type: Public URL (${submissionSource})`
      : 'Submission Type: Pasted Text / Code';

  const contents = [
    `Job Title: ${title}`,
    `Original Job Description:\n${description}`,
    `Verification Checklist (${checklist.length} items):\n${numberedChecklist}`,
    sourceLine,
    `Submitted Deliverable:\n"""\n${submissionContent}\n"""`,
  ].join('\n\n');

  return callGeminiJsonWithRetry(
    {
      systemInstruction,
      contents,
      responseJsonSchema: EVALUATION_SCHEMA,
      validate: (parsed) => validateEvaluationPayload(parsed, checklist),
    },
    retryOptions
  );
}

module.exports = {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_FALLBACK_MODELS,
  MAX_TRANSIENT_RETRIES,
  RETRY_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  GeminiServiceError,
  getGeminiConfig,
  generateChecklist,
  evaluateSubmission,
};
