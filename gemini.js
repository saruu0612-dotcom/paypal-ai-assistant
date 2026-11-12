const { GoogleGenAI } = require('@google/genai');

const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const DEFAULT_FALLBACK_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
];
const MAX_TRANSIENT_RETRIES = 2;
const RETRY_DELAY_MS = 1200;
const REQUEST_TIMEOUT_MS = 20000;
const MODEL_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const FRIENDLY_AI_BUSY_MESSAGE = 'The AI service is busy. Please try again in a moment.';

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

const discoveryState = {
  discoveredAll: [],
  discoveredFlash: [],
  candidates: [],
  lastWorkingModel: null,
  unavailableModels: new Set(),
  discoveryOk: false,
  lastRefreshedAt: null,
  inFlightRefresh: null,
  intervalHandle: null,
  lastEnvSignature: null,
};

function normalizeModelName(name) {
  return String(name || '')
    .trim()
    .replace(/^models\//i, '');
}

function getConfiguredEnvModels() {
  const configuredPrimary = normalizeModelName(process.env.GEMINI_MODEL || '');
  const rawFallbacks = (process.env.GEMINI_FALLBACK_MODELS || '').trim();
  const configuredFallbacks = rawFallbacks
    ? rawFallbacks
        .split(',')
        .map((m) => normalizeModelName(m))
        .filter(Boolean)
    : [];

  return {
    configuredPrimary: configuredPrimary || null,
    configuredFallbacks,
  };
}

function parseVersionNumbers(modelName) {
  const match = String(modelName || '').match(/(\d+)(?:\.(\d+))?/);
  if (!match) return [0, 0];
  return [Number(match[1]) || 0, Number(match[2]) || 0];
}

function isTextFlashModelName(modelName) {
  const lower = String(modelName || '').toLowerCase();
  if (!lower.includes('flash')) return false;
  if (/(?:-image|-tts|-audio|-transcribe|-live)(?:-|$)/.test(lower)) {
    return false;
  }
  return true;
}

function compareFlashModels(a, b) {
  if (a === DEFAULT_GEMINI_MODEL && b !== DEFAULT_GEMINI_MODEL) return -1;
  if (b === DEFAULT_GEMINI_MODEL && a !== DEFAULT_GEMINI_MODEL) return 1;

  const [majorA, minorA] = parseVersionNumbers(a);
  const [majorB, minorB] = parseVersionNumbers(b);
  if (majorA !== majorB) return majorB - majorA;
  if (minorA !== minorB) return minorB - minorA;

  const scoreVariant = (name) => {
    const lower = name.toLowerCase();
    let score = 0;
    if (!lower.includes('lite')) score += 4;
    if (!lower.includes('preview')) score += 2;
    if (!lower.includes('omni')) score += 1;
    return score;
  };
  const variantDiff = scoreVariant(b) - scoreVariant(a);
  if (variantDiff !== 0) return variantDiff;

  return b.localeCompare(a);
}

function supportsGenerateContent(modelObj) {
  const actions = Array.isArray(modelObj?.supportedActions)
    ? modelObj.supportedActions
    : Array.isArray(modelObj?.supportedGenerationMethods)
      ? modelObj.supportedGenerationMethods
      : null;

  if (!actions) return false;
  return actions.some((action) => String(action).toLowerCase() === 'generatecontent');
}

function buildRankedCandidateList() {
  const { configuredPrimary, configuredFallbacks } = getConfiguredEnvModels();
  const discoveredAllSet = new Set(discoveryState.discoveredAll);
  const hasDiscovered = discoveryState.discoveryOk && discoveredAllSet.size > 0;
  const unavailable = discoveryState.unavailableModels;

  const envExplicit = [];
  if (configuredPrimary) envExplicit.push(configuredPrimary);
  for (const fb of configuredFallbacks) envExplicit.push(fb);

  const ordered = [];
  const seen = new Set();
  const addIfUsable = (modelName) => {
    const normalized = normalizeModelName(modelName);
    if (!normalized || seen.has(normalized) || unavailable.has(normalized)) return;
    if (hasDiscovered && !discoveredAllSet.has(normalized)) return;
    seen.add(normalized);
    ordered.push(normalized);
  };

  // 1. Explicitly configured GEMINI_MODEL and GEMINI_FALLBACK_MODELS first (when not known retired).
  for (const cfgModel of envExplicit) {
    addIfUsable(cfgModel);
  }

  // 2. Discovered flash models supporting generateContent (gemini-3.8-flash preferred, newest first).
  for (const flashModel of discoveryState.discoveredFlash) {
    addIfUsable(flashModel);
  }

  // 3. Fallback defaults if live discovery has not populated candidates yet.
  if (ordered.length === 0) {
    addIfUsable(DEFAULT_GEMINI_MODEL);
    for (const defModel of DEFAULT_FALLBACK_MODELS) {
      addIfUsable(defModel);
    }
  }

  discoveryState.candidates = ordered;
  return ordered;
}

function warnIfConfiguredModelsMissing(discoveredAllSet) {
  const { configuredPrimary, configuredFallbacks } = getConfiguredEnvModels();
  const configuredList = [
    ...(configuredPrimary ? [configuredPrimary] : []),
    ...configuredFallbacks,
  ];
  for (const cfgModel of configuredList) {
    if (!discoveredAllSet.has(cfgModel) || discoveryState.unavailableModels.has(cfgModel)) {
      console.warn(
        `[Gemini] Configured model "${cfgModel}" is retired or unavailable for generateContent; using ranked fallback candidates.`
      );
    }
  }
}

async function refreshAvailableModels({ aiOverride } = {}) {
  if (discoveryState.inFlightRefresh) {
    return discoveryState.inFlightRefresh;
  }

  discoveryState.inFlightRefresh = (async () => {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey && !aiOverride) {
      discoveryState.discoveryOk = false;
      discoveryState.discoveredAll = [];
      discoveryState.discoveredFlash = [];
      discoveryState.candidates = [];
      return getGeminiHealth();
    }

    try {
      const ai = aiOverride || new GoogleGenAI({ apiKey });
      const pager = await ai.models.list();
      const discoveredAll = [];

      for await (const modelObj of pager) {
        if (!supportsGenerateContent(modelObj)) continue;
        const normalized = normalizeModelName(modelObj?.name);
        if (normalized) {
          discoveredAll.push(normalized);
        }
      }

      const uniqueAll = Array.from(new Set(discoveredAll));
      const discoveredFlash = uniqueAll
        .filter((name) => isTextFlashModelName(name) && !discoveryState.unavailableModels.has(name))
        .sort(compareFlashModels);

      discoveryState.discoveredAll = uniqueAll;
      discoveryState.discoveredFlash = discoveredFlash;
      discoveryState.discoveryOk = uniqueAll.length > 0;
      discoveryState.lastRefreshedAt = new Date().toISOString();

      const { configuredPrimary, configuredFallbacks } = getConfiguredEnvModels();
      discoveryState.lastEnvSignature = `${configuredPrimary || ''}|${configuredFallbacks.join(',')}`;
      warnIfConfiguredModelsMissing(new Set(uniqueAll));
      const ranked = buildRankedCandidateList();
      console.log(
        `[Gemini] Model discovery complete: ${ranked.length} candidate(s) ready (top: ${ranked[0] || 'none'}).`
      );
    } catch (err) {
      discoveryState.discoveryOk = false;
      buildRankedCandidateList();
      console.warn(
        `[Gemini] Model discovery failed (${err?.message || err}); using ranked fallback list.`
      );
    } finally {
      discoveryState.inFlightRefresh = null;
    }

    return getGeminiHealth();
  })();

  return discoveryState.inFlightRefresh;
}

function initGeminiModelDiscovery() {
  if (!discoveryState.intervalHandle) {
    discoveryState.intervalHandle = setInterval(() => {
      refreshAvailableModels().catch(() => {});
    }, MODEL_REFRESH_INTERVAL_MS);
    if (typeof discoveryState.intervalHandle.unref === 'function') {
      discoveryState.intervalHandle.unref();
    }
  }
  return refreshAvailableModels();
}

async function ensureModelsDiscovered() {
  if (discoveryState.inFlightRefresh) {
    await discoveryState.inFlightRefresh;
  } else if (!discoveryState.lastRefreshedAt && (process.env.GEMINI_API_KEY || '').trim()) {
    await refreshAvailableModels();
  }
  return getGeminiHealth();
}

function syncEnvChangesIfNeeded() {
  const { configuredPrimary, configuredFallbacks } = getConfiguredEnvModels();
  const signature = `${configuredPrimary || ''}|${configuredFallbacks.join(',')}`;
  if (discoveryState.lastEnvSignature !== signature) {
    discoveryState.lastEnvSignature = signature;
    if (discoveryState.discoveryOk) {
      warnIfConfiguredModelsMissing(new Set(discoveryState.discoveredAll));
    }
    buildRankedCandidateList();
  }
}

function getRuntimeAttemptModels() {
  syncEnvChangesIfNeeded();
  const ranked = buildRankedCandidateList();
  const last = discoveryState.lastWorkingModel;
  if (last && !discoveryState.unavailableModels.has(last)) {
    return [last, ...ranked.filter((m) => m !== last)];
  }
  return ranked;
}

function getGeminiHealth() {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    return {
      ready: false,
      activeModel: null,
      candidates: [],
      configuredModel: (process.env.GEMINI_MODEL || '').trim() || DEFAULT_GEMINI_MODEL,
      discoveryOk: false,
      lastRefreshedAt: discoveryState.lastRefreshedAt,
    };
  }

  syncEnvChangesIfNeeded();
  const ranked = getRuntimeAttemptModels();
  const hasRealWorkingModel =
    Boolean(discoveryState.lastWorkingModel && !discoveryState.unavailableModels.has(discoveryState.lastWorkingModel)) ||
    (discoveryState.discoveryOk && ranked.length > 0);
  const activeModel = hasRealWorkingModel ? ranked[0] || null : null;

  return {
    ready: hasRealWorkingModel,
    activeModel,
    candidates: ranked,
    configuredModel: (process.env.GEMINI_MODEL || '').trim() || DEFAULT_GEMINI_MODEL,
    discoveryOk: discoveryState.discoveryOk,
    lastRefreshedAt: discoveryState.lastRefreshedAt,
  };
}

function getGeminiConfig() {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const { configuredPrimary, configuredFallbacks } = getConfiguredEnvModels();
  const model = configuredPrimary || DEFAULT_GEMINI_MODEL;

  if (!apiKey) {
    console.warn('[Gemini] Request attempted without GEMINI_API_KEY configured.');
    throw new GeminiServiceError(FRIENDLY_AI_BUSY_MESSAGE, {
      status: 503,
      code: 'GEMINI_MISSING_KEY',
      retryable: false,
    });
  }

  const models = getRuntimeAttemptModels();

  return {
    apiKey,
    model,
    fallbackModels: configuredFallbacks.length > 0 ? configuredFallbacks : DEFAULT_FALLBACK_MODELS,
    models,
  };
}

function getClient() {
  const config = getGeminiConfig();
  return {
    ai: new GoogleGenAI({ apiKey: config.apiKey }),
    ...config,
  };
}

function classifyGeminiError(err) {
  if (err instanceof GeminiServiceError) {
    return { error: err, isTransient: err.retryable, isModelUnavailable: false, isAuthError: false };
  }

  const rawMsg = String(err?.message || '');
  const lower = rawMsg.toLowerCase();
  const nameLower = String(err?.name || '').toLowerCase();
  const causeCode = String(err?.cause?.code || err?.code || '').toLowerCase();
  const statusCode = Number(err?.status || err?.statusCode || err?.error?.code) || 0;

  if (
    statusCode === 401 ||
    statusCode === 403 ||
    lower.includes('api key') ||
    lower.includes('permission_denied')
  ) {
    return {
      error: new GeminiServiceError(FRIENDLY_AI_BUSY_MESSAGE, {
        status: 503,
        code: 'GEMINI_AUTH_ERROR',
        retryable: false,
      }),
      isTransient: false,
      isModelUnavailable: false,
      isAuthError: true,
    };
  }

  if (
    statusCode === 404 ||
    lower.includes('not_found') ||
    lower.includes('not found') ||
    lower.includes('no longer available') ||
    lower.includes('is deprecated') ||
    lower.includes('"code":404')
  ) {
    return {
      error: new GeminiServiceError(FRIENDLY_AI_BUSY_MESSAGE, {
        status: 503,
        code: 'GEMINI_MODEL_UNAVAILABLE',
        retryable: false,
      }),
      isTransient: false,
      isModelUnavailable: true,
      isAuthError: false,
    };
  }

  if (
    statusCode === 503 ||
    lower.includes('unavailable') ||
    lower.includes('high demand') ||
    lower.includes('overloaded') ||
    lower.includes('"code":503')
  ) {
    return {
      error: new GeminiServiceError(FRIENDLY_AI_BUSY_MESSAGE, {
        status: 503,
        code: 'GEMINI_UNAVAILABLE',
        retryable: true,
      }),
      isTransient: true,
      isModelUnavailable: false,
      isAuthError: false,
    };
  }

  if (
    statusCode === 429 ||
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('resource_exhausted') ||
    lower.includes('"code":429')
  ) {
    return {
      error: new GeminiServiceError(FRIENDLY_AI_BUSY_MESSAGE, {
        status: 429,
        code: 'GEMINI_RATE_LIMIT',
        retryable: true,
      }),
      isTransient: true,
      isModelUnavailable: false,
      isAuthError: false,
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
    lower.includes('"code":408') ||
    lower.includes('aborted') ||
    causeCode.includes('timeout') ||
    causeCode === 'etimedout' ||
    causeCode === 'econnreset' ||
    causeCode === 'econnrefused' ||
    causeCode === 'enotfound' ||
    causeCode === 'eai_again' ||
    lower.includes('fetch') ||
    lower.includes('network')
  ) {
    return {
      error: new GeminiServiceError(FRIENDLY_AI_BUSY_MESSAGE, {
        status: 504,
        code: 'GEMINI_TIMEOUT',
        retryable: true,
      }),
      isTransient: true,
      isModelUnavailable: false,
      isAuthError: false,
    };
  }

  return {
    error: new GeminiServiceError(FRIENDLY_AI_BUSY_MESSAGE, {
      status: 503,
      code: 'GEMINI_API_ERROR',
      retryable: true,
    }),
    isTransient: true,
    isModelUnavailable: false,
    isAuthError: false,
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
      const classified = classifyGeminiError(err);
      lastClassified = classified;

      if (classified.isModelUnavailable) {
        console.warn(
          `[Gemini] Model "${model}" is retired or unavailable (${err?.message || classified.error.code}); skipping to next candidate.`
        );
        return { ok: false, classified };
      }

      console.error(
        `[Gemini] Call error (model=${model}, try=${retry + 1}/${maxRetries + 1}, code=${classified.error.code}):`,
        err?.message || err
      );

      if (classified.isTransient && retry < maxRetries) {
        console.warn(`[Gemini] Retrying busy model "${model}" in ${retryDelayMs}ms...`);
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
 * - Ranked candidates (last working model first, then env config, then discovered flash models newest first),
 * - Immediate skip on 404/NOT_FOUND/"no longer available" and 1-2 short retries on 503/429/timeout before skipping,
 * - 1 automatic validation retry if the AI returns malformed or schema-invalid JSON.
 */
async function callGeminiJsonWithRetry(
  { systemInstruction, contents, responseJsonSchema, validate },
  retryOptions = {}
) {
  if (!discoveryState.lastRefreshedAt && !retryOptions.aiOverride) {
    await ensureModelsDiscovered();
  }

  const clientInfo = retryOptions.aiOverride
    ? {
        ai: retryOptions.aiOverride,
        models: retryOptions.modelsOverride || getRuntimeAttemptModels(),
      }
    : getClient();
  const { ai, models } = clientInfo;

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
        const { error, isModelUnavailable, isAuthError } = callResult.classified;
        if (isModelUnavailable) {
          discoveryState.unavailableModels.add(model);
          if (discoveryState.lastWorkingModel === model) {
            discoveryState.lastWorkingModel = null;
          }
          buildRankedCandidateList();
        }

        if (isAuthError) {
          console.error('[Gemini] Authentication error from Gemini API. Verify API credentials on server.');
          throw error;
        }

        shouldFallbackToNextModel = true;
        if (modelIndex < models.length - 1) {
          console.warn(
            `[Gemini] Falling back from "${model}" to "${models[modelIndex + 1]}" (${error.code}).`
          );
        }
        break;
      }

      const rawText = typeof callResult.response?.text === 'string' ? callResult.response.text.trim() : '';
      if (!rawText) {
        lastValidationError = new InvalidAiResponseError('Gemini returned an empty response.');
        console.warn(`[Gemini] (${model}) JSON attempt ${jsonAttempt} returned empty text.`);
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        lastValidationError = new InvalidAiResponseError('Response was not valid JSON.');
        console.warn(`[Gemini] (${model}) JSON attempt ${jsonAttempt} returned unparseable JSON.`);
        continue;
      }

      try {
        const validated = validate(parsed);
        discoveryState.lastWorkingModel = model;
        return validated;
      } catch (validationErr) {
        lastValidationError =
          validationErr instanceof InvalidAiResponseError
            ? validationErr
            : new InvalidAiResponseError(validationErr?.message || 'Validation failed.');
        console.warn(
          `[Gemini] (${model}) JSON attempt ${jsonAttempt} failed validation: ${lastValidationError.message}`
        );
      }
    }

    if (!shouldFallbackToNextModel && modelIndex < models.length - 1) {
      console.warn(
        `[Gemini] "${model}" failed JSON validation twice; falling back to "${models[modelIndex + 1]}".`
      );
    }
  }

  throw new GeminiServiceError(FRIENDLY_AI_BUSY_MESSAGE, {
    status: 503,
    code: 'GEMINI_ALL_MODELS_FAILED',
    retryable: true,
  });
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

function resetDiscoveryStateForTests() {
  discoveryState.discoveredAll = [];
  discoveryState.discoveredFlash = [];
  discoveryState.candidates = [];
  discoveryState.lastWorkingModel = null;
  discoveryState.unavailableModels.clear();
  discoveryState.discoveryOk = false;
  discoveryState.lastRefreshedAt = null;
  discoveryState.inFlightRefresh = null;
  discoveryState.lastEnvSignature = null;
}

module.exports = {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_FALLBACK_MODELS,
  MAX_TRANSIENT_RETRIES,
  RETRY_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  MODEL_REFRESH_INTERVAL_MS,
  FRIENDLY_AI_BUSY_MESSAGE,
  GeminiServiceError,
  getGeminiConfig,
  getGeminiHealth,
  initGeminiModelDiscovery,
  refreshAvailableModels,
  ensureModelsDiscovered,
  callGeminiJsonWithRetry,
  generateChecklist,
  evaluateSubmission,
  _internal: {
    compareFlashModels,
    isTextFlashModelName,
    classifyGeminiError,
    resetDiscoveryStateForTests,
  },
};
