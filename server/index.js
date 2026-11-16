'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateProfile, validateChat, normalizePlan, normalizeChatReply } = require('./validate');
const { buildPrompt } = require('./prompt');
const { MOCK_PLAN } = require('./mock');
const { answerChat, mockChatReply } = require('./chat');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// Load .env if present. Real environment variables take precedence.
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* no .env file: rely on the environment */
}

const PORT = Number(process.env.PORT) || 3000;
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim();
const MOCK_AI = process.env.MOCK_AI === '1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const RATE_LIMIT_PER_HOUR = Math.max(1, Number(process.env.RATE_LIMIT_PER_HOUR) || 20);
const TEXT_MODELS = (process.env.TEXT_MODELS || 'gemini-flash-latest')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

const MAX_BODY_BYTES = 64 * 1024;
const MODEL_TIMEOUT_MS = 40_000;
const MAX_ATTEMPTS_PER_MODEL = 3;
const RETRY_WAITS_MS = [2000, 4000];
const HOUR_MS = 60 * 60 * 1000;

/* ---------- helpers ---------- */

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const type = (req.headers['content-type'] || '').toLowerCase();
    if (!type.startsWith('application/json')) {
      req.resume();
      return reject(new HttpError(415, 'Content-Type must be application/json.'));
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (tooLarge) return reject(new HttpError(413, 'Request body too large.'));
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'Request body must be a JSON object.'));
      }
    });
  });
}

function clientIp(req) {
  if (TRUST_PROXY) {
    // nginx appends the real client address as the last entry.
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (forwarded.length) return forwarded[forwarded.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

/* ---------- access code ---------- */

const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest();

function codeIsValid(code) {
  if (!ACCESS_CODE) return true; // no code configured: open access
  if (typeof code !== 'string' || code.length > 200) return false;
  return crypto.timingSafeEqual(sha256(code), sha256(ACCESS_CODE));
}

/* ---------- rate limiting (in memory, sliding window per IP) ---------- */

const hits = new Map();

function checkRateLimit(bucket, ip) {
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < HOUR_MS);
  if (recent.length >= RATE_LIMIT_PER_HOUR) {
    hits.set(key, recent);
    const retryAfter = Math.max(1, Math.ceil((recent[0] + HOUR_MS - now) / 1000));
    throw new HttpError(429, 'Rate limit reached. Please try again later.', { retryAfter });
  }
  recent.push(now);
  hits.set(key, recent);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, times] of hits) {
    if (!times.some((t) => now - t < HOUR_MS)) hits.delete(key);
  }
}, 10 * 60 * 1000).unref();

/* ---------- AI ---------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseModelJson(raw) {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(trimmed);
}

// Calls one model and passes its JSON output through `normalize`, which throws if the shape is unusable.
async function callGemini(model, prompt, normalize) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw Object.assign(new Error(timedOut ? 'timeout after 40s' : `network error: ${err.message}`), {
      retryable: false,
    });
  }

  const body = await response.text();
  if (!response.ok) {
    const retryable = response.status === 500 || response.status === 503 || /high demand|overloaded/i.test(body);
    throw Object.assign(new Error(`HTTP ${response.status}`), { retryable });
  }

  const data = JSON.parse(body);
  const parts = data?.candidates?.[0]?.content?.parts;
  const output = Array.isArray(parts) ? parts.map((p) => p.text || '').join('') : '';
  if (!output) throw new Error(`empty response (finishReason: ${data?.candidates?.[0]?.finishReason || 'unknown'})`);
  return normalize(parseModelJson(output));
}

// Try each model in order; retry transient overload errors with backoff.
// Shared by /api/plan and /api/chat.
async function generateJson(prompt, normalize) {
  if (!GEMINI_API_KEY) {
    throw new HttpError(503, 'The server has no AI API key configured. Set GEMINI_API_KEY or MOCK_AI=1.');
  }
  for (const model of TEXT_MODELS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        return await callGemini(model, prompt, normalize);
      } catch (err) {
        // Never log the API key or any user content; status/message only.
        console.warn(`[ai] ${model} attempt ${attempt} failed: ${err.message}`);
        if (!err.retryable || attempt === MAX_ATTEMPTS_PER_MODEL) break;
        await sleep(RETRY_WAITS_MS[attempt - 1]);
      }
    }
  }
  throw new HttpError(502, 'The AI service is unavailable right now. Please try again in a moment.');
}

async function generatePlan(profile) {
  if (MOCK_AI) return MOCK_PLAN;
  return generateJson(buildPrompt(profile), normalizePlan);
}

// In mock mode the answer is fixed. Otherwise the model is asked, with one
// retry if the user asked for a change but no updated plan came back.
async function generateChatReply(chat) {
  if (MOCK_AI) return mockChatReply(chat.message);
  return answerChat(chat, (prompt) => generateJson(prompt, normalizeChatReply));
}

/* ---------- API routes ---------- */

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health') {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    return sendJson(res, 200, {
      status: 'ok',
      needsCode: Boolean(ACCESS_CODE),
      hasApiKey: Boolean(GEMINI_API_KEY),
      mock: MOCK_AI,
    });
  }

  if (pathname === '/api/check-code') {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    checkRateLimit('code', clientIp(req));
    const body = await readJsonBody(req);
    if (!codeIsValid(body.code)) throw new HttpError(401, 'Wrong access code.');
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/plan') {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    checkRateLimit('plan', clientIp(req));
    const body = await readJsonBody(req);
    if (!codeIsValid(body.code)) throw new HttpError(401, 'Wrong access code.');
    const result = validateProfile(body.profile);
    if (!result.ok) throw new HttpError(400, 'Invalid profile.', { errors: result.errors });
    return sendJson(res, 200, await generatePlan(result.profile));
  }

  if (pathname === '/api/chat') {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    checkRateLimit('plan', clientIp(req)); // same bucket as /api/plan
    const body = await readJsonBody(req);
    if (!codeIsValid(body.code)) throw new HttpError(401, 'Wrong access code.');

    const errors = [];
    const profileResult = validateProfile(body.profile);
    if (!profileResult.ok) errors.push(...profileResult.errors);
    const chatResult = validateChat({ message: body.message, history: body.history });
    if (!chatResult.ok) errors.push(...chatResult.errors);
    let plan = null;
    try {
      plan = normalizePlan(body.plan);
    } catch {
      errors.push('Plan must be a training plan in the format returned by /api/plan.');
    }
    if (errors.length) throw new HttpError(400, 'Invalid chat request.', { errors });

    const answer = await generateChatReply({ profile: profileResult.profile, plan, ...chatResult.chat });
    return sendJson(res, 200, answer);
  }

  throw new HttpError(404, 'Not found.');
}

/* ---------- static files ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

async function resolveStaticFile(pathname) {
  const index = path.join(PUBLIC_DIR, 'index.html');
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'Bad request.');
  }
  if (decoded.includes('\0')) throw new HttpError(400, 'Bad request.');

  const file = path.join(PUBLIC_DIR, path.normalize(decoded));
  const insidePublic = file.startsWith(PUBLIC_DIR + path.sep);
  if (insidePublic) {
    try {
      if ((await fs.promises.stat(file)).isFile()) return file;
    } catch {
      /* fall through */
    }
  }
  // Missing asset (has an extension) -> 404. Anything else -> SPA fallback.
  if (path.extname(decoded)) throw new HttpError(404, 'Not found.');
  return index;
}

async function handleStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
  const file = await resolveStaticFile(pathname);
  const data = await fs.promises.readFile(file);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

/* ---------- server ---------- */

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else await handleStatic(req, res, pathname);
  } catch (err) {
    if (res.headersSent) return res.destroy();
    if (err instanceof HttpError) {
      const headers = err.extra?.retryAfter ? { 'Retry-After': String(err.extra.retryAfter) } : {};
      return sendJson(res, err.status, { error: err.message, ...(err.extra?.errors && { errors: err.extra.errors }) }, headers);
    }
    console.error('[server] unexpected error:', err);
    sendJson(res, 500, { error: 'Internal server error.' });
  }
});

server.requestTimeout = 30_000;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Gym AI Coach listening on http://localhost:${PORT}`);
    console.log(`  mock AI: ${MOCK_AI} | API key set: ${Boolean(GEMINI_API_KEY)} | access code required: ${Boolean(ACCESS_CODE)}`);
    if (!MOCK_AI && !GEMINI_API_KEY) console.warn('  WARNING: GEMINI_API_KEY is empty and MOCK_AI is off. /api/plan will return 503.');
    if (!ACCESS_CODE) console.warn('  WARNING: ACCESS_CODE is empty. Anyone who can reach this server can use it.');
  });
}

module.exports = { server, normalizePlan };
