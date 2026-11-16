'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateProfile } = require('./validate');
const { buildPrompt } = require('./prompt');

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

const MAX_BODY_BYTES = 16 * 1024;
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

const MOCK_PLAN = {
  summary:
    'Mock plan (MOCK_AI=1): a balanced 4-day upper/lower split focused on compound lifts, with a moderate calorie target and high protein.',
  weeklyPlan: [
    {
      day: 'Day 1',
      focus: 'Upper body (push emphasis)',
      exercises: [
        { name: 'Bench press', sets: '4', reps: '6-8', rest: '120s' },
        { name: 'Overhead press', sets: '3', reps: '8-10', rest: '90s' },
        { name: 'Incline dumbbell press', sets: '3', reps: '10-12', rest: '75s' },
        { name: 'Lateral raise', sets: '3', reps: '12-15', rest: '60s' },
        { name: 'Triceps pushdown', sets: '3', reps: '10-12', rest: '60s' },
      ],
    },
    {
      day: 'Day 2',
      focus: 'Lower body (squat emphasis)',
      exercises: [
        { name: 'Back squat', sets: '4', reps: '6-8', rest: '150s' },
        { name: 'Romanian deadlift', sets: '3', reps: '8-10', rest: '120s' },
        { name: 'Walking lunge', sets: '3', reps: '10 per leg', rest: '90s' },
        { name: 'Calf raise', sets: '3', reps: '12-15', rest: '60s' },
        { name: 'Plank', sets: '3', reps: '45s', rest: '45s' },
      ],
    },
    {
      day: 'Day 3',
      focus: 'Upper body (pull emphasis)',
      exercises: [
        { name: 'Pull-up or lat pulldown', sets: '4', reps: '6-10', rest: '120s' },
        { name: 'Barbell row', sets: '3', reps: '8-10', rest: '90s' },
        { name: 'Seated cable row', sets: '3', reps: '10-12', rest: '75s' },
        { name: 'Face pull', sets: '3', reps: '12-15', rest: '60s' },
        { name: 'Dumbbell curl', sets: '3', reps: '10-12', rest: '60s' },
      ],
    },
    {
      day: 'Day 4',
      focus: 'Lower body (hinge emphasis) + conditioning',
      exercises: [
        { name: 'Deadlift', sets: '3', reps: '5', rest: '180s' },
        { name: 'Leg press', sets: '3', reps: '10-12', rest: '90s' },
        { name: 'Leg curl', sets: '3', reps: '10-12', rest: '75s' },
        { name: 'Hanging knee raise', sets: '3', reps: '10-15', rest: '60s' },
        { name: 'Easy bike or incline walk', sets: '1', reps: '15 min', rest: '-' },
      ],
    },
  ],
  nutrition: {
    calories: '2400 kcal/day',
    protein: '150 g/day',
    tips: [
      'Include a protein source (eggs, chicken, fish, dairy, beans) in every meal.',
      'Eat a carb-rich meal 1-3 hours before training.',
      'Aim for at least 2 litres of water per day.',
      'Keep vegetables or fruit in at least two meals per day.',
    ],
  },
  safetyNotes: [
    'Warm up for 5-10 minutes and do lighter ramp-up sets before heavy lifts.',
    'Stop if you feel sharp pain. Consult a doctor or physiotherapist about any injury before training.',
    'This is general fitness guidance, not medical advice.',
  ],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const text = (value, max = 300) =>
  (typeof value === 'string' || typeof value === 'number' ? String(value) : '').trim().slice(0, max);

const textList = (value, maxItems = 10) =>
  (Array.isArray(value) ? value : []).map((item) => text(item, 400)).filter(Boolean).slice(0, maxItems);

// Force the model output into the documented response shape. Throws if unusable.
function normalizePlan(raw) {
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.weeklyPlan)) {
    throw new Error('Model response is missing weeklyPlan.');
  }
  const weeklyPlan = raw.weeklyPlan
    .filter((day) => day && typeof day === 'object')
    .slice(0, 7)
    .map((day, i) => ({
      day: text(day.day, 60) || `Day ${i + 1}`,
      focus: text(day.focus, 120),
      exercises: (Array.isArray(day.exercises) ? day.exercises : [])
        .filter((ex) => ex && typeof ex === 'object' && text(ex.name))
        .slice(0, 12)
        .map((ex) => ({
          name: text(ex.name, 120),
          sets: text(ex.sets, 40),
          reps: text(ex.reps, 40),
          rest: text(ex.rest, 40),
        })),
    }))
    .filter((day) => day.exercises.length > 0);
  if (weeklyPlan.length === 0) throw new Error('Model response contains no exercises.');

  const nutrition = raw.nutrition && typeof raw.nutrition === 'object' ? raw.nutrition : {};
  return {
    summary: text(raw.summary, 1000),
    weeklyPlan,
    nutrition: {
      calories: text(nutrition.calories, 80),
      protein: text(nutrition.protein, 80),
      tips: textList(nutrition.tips),
    },
    safetyNotes: textList(raw.safetyNotes),
  };
}

function parseModelJson(raw) {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(trimmed);
}

async function callGemini(model, prompt) {
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
  return normalizePlan(parseModelJson(output));
}

// Try each model in order; retry transient overload errors with backoff.
async function generatePlan(profile) {
  if (MOCK_AI) return { plan: MOCK_PLAN, model: 'mock' };
  if (!GEMINI_API_KEY) {
    throw new HttpError(503, 'The server has no AI API key configured. Set GEMINI_API_KEY or MOCK_AI=1.');
  }

  const prompt = buildPrompt(profile);
  for (const model of TEXT_MODELS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        return { plan: await callGemini(model, prompt), model };
      } catch (err) {
        // Never log the API key or the user's profile; status/message only.
        console.warn(`[ai] ${model} attempt ${attempt} failed: ${err.message}`);
        if (!err.retryable || attempt === MAX_ATTEMPTS_PER_MODEL) break;
        await sleep(RETRY_WAITS_MS[attempt - 1]);
      }
    }
  }
  throw new HttpError(502, 'The AI service is unavailable right now. Please try again in a moment.');
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
    const { plan } = await generatePlan(result.profile);
    return sendJson(res, 200, plan);
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
