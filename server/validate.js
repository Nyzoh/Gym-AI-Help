'use strict';

const GOALS = ['build muscle', 'lose fat', 'strength', 'endurance'];
const EQUIPMENT = ['gym', 'home', 'none'];
const SEXES = ['male', 'female', 'other'];
const MAX_TEXT = 500;

const LIMITS = {
  weightKg: { min: 30, max: 300, label: 'Weight (kg)' },
  heightCm: { min: 100, max: 250, label: 'Height (cm)' },
  age: { min: 13, max: 100, label: 'Age', integer: true },
  trainingDays: { min: 1, max: 7, label: 'Training days per week', integer: true },
};

// Replace control characters (incl. newlines, tabs, DEL) with spaces and collapse whitespace.
function cleanText(value) {
  return String(value)
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

/**
 * Validates and normalises a user profile.
 * Returns { ok: true, profile } or { ok: false, errors: [..] }.
 * Only whitelisted fields are copied to the result.
 */
function validateProfile(input) {
  const errors = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['Profile must be an object.'] };
  }

  const profile = {};

  for (const [field, rule] of Object.entries(LIMITS)) {
    const n = readNumber(input[field]);
    if (!Number.isFinite(n)) {
      errors.push(`${rule.label} must be a number.`);
    } else if (rule.integer && !Number.isInteger(n)) {
      errors.push(`${rule.label} must be a whole number.`);
    } else if (n < rule.min || n > rule.max) {
      errors.push(`${rule.label} must be between ${rule.min} and ${rule.max}.`);
    } else {
      profile[field] = n;
    }
  }

  const enums = [
    ['sex', SEXES, 'Sex'],
    ['goal', GOALS, 'Goal'],
    ['equipment', EQUIPMENT, 'Equipment'],
  ];
  for (const [field, allowed, label] of enums) {
    const value = typeof input[field] === 'string' ? input[field].trim().toLowerCase() : '';
    if (!allowed.includes(value)) {
      errors.push(`${label} must be one of: ${allowed.join(', ')}.`);
    } else {
      profile[field] = value;
    }
  }

  const texts = [
    ['typicalDiet', 'Typical diet'],
    ['injuries', 'Injuries or limitations'],
  ];
  for (const [field, label] of texts) {
    const raw = input[field];
    if (raw === undefined || raw === null) {
      profile[field] = '';
    } else if (typeof raw !== 'string') {
      errors.push(`${label} must be text.`);
    } else {
      const cleaned = cleanText(raw);
      if (cleaned.length > MAX_TEXT) {
        errors.push(`${label} must be at most ${MAX_TEXT} characters.`);
      } else {
        profile[field] = cleaned;
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, profile };
}

/* ---------- plan shape ---------- */

const text = (value, max = 300) =>
  (typeof value === 'string' || typeof value === 'number' ? cleanText(value) : '').slice(0, max);

const textList = (value, maxItems = 10) =>
  (Array.isArray(value) ? value : []).map((item) => text(item, 400)).filter(Boolean).slice(0, maxItems);

/**
 * Forces a plan (from the model, or sent back by the client) into the
 * documented /api/plan shape. Throws if it is not usable as a plan.
 */
function normalizePlan(raw) {
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.weeklyPlan)) {
    throw new Error('Plan is missing weeklyPlan.');
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
  if (weeklyPlan.length === 0) throw new Error('Plan contains no exercises.');

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

/* ---------- chat ---------- */

const CHAT_ROLES = ['user', 'assistant'];
const MAX_HISTORY = 10;
const MAX_REPLY = 1500;
const PLAN_REJECTED_NOTE =
  '(Note: I tried to update your plan, but the new plan came back in an invalid format, so nothing was changed. Please ask again.)';

/**
 * Validates the chat part of a /api/chat request: { message, history }.
 * Returns { ok: true, chat: { message, history } } or { ok: false, errors }.
 */
function validateChat(input) {
  const errors = [];
  const source = input !== null && typeof input === 'object' ? input : {};

  let message = '';
  if (typeof source.message !== 'string') {
    errors.push('Message must be text.');
  } else {
    message = cleanText(source.message);
    if (message.length === 0) errors.push('Message must not be empty.');
    else if (message.length > MAX_TEXT) errors.push(`Message must be at most ${MAX_TEXT} characters.`);
  }

  const history = [];
  const rawHistory = source.history === undefined || source.history === null ? [] : source.history;
  if (!Array.isArray(rawHistory)) {
    errors.push('History must be a list of messages.');
  } else if (rawHistory.length > MAX_HISTORY) {
    errors.push(`History must contain at most ${MAX_HISTORY} messages.`);
  } else {
    rawHistory.forEach((entry, i) => {
      const label = `History message ${i + 1}`;
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return errors.push(`${label} must be an object.`);
      }
      if (!CHAT_ROLES.includes(entry.role)) {
        return errors.push(`${label} must have role "user" or "assistant".`);
      }
      if (typeof entry.text !== 'string') return errors.push(`${label} must have text.`);
      const cleaned = cleanText(entry.text);
      if (cleaned.length === 0) return errors.push(`${label} must not be empty.`);
      if (cleaned.length > MAX_TEXT) return errors.push(`${label} must be at most ${MAX_TEXT} characters.`);
      history.push({ role: entry.role, text: cleaned });
    });
  }

  return errors.length ? { ok: false, errors } : { ok: true, chat: { message, history } };
}

/**
 * Checks the model's chat answer: { reply, updatedPlan }.
 * Throws if there is no usable reply. An updatedPlan that does not follow the
 * plan format is dropped (null) and a note is appended to the reply.
 */
function normalizeChatReply(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Chat response is not an object.');
  }
  let reply = typeof raw.reply === 'string' ? text(raw.reply, MAX_REPLY) : '';
  if (!reply) throw new Error('Chat response has no reply.');

  let updatedPlan = null;
  if (raw.updatedPlan !== null && raw.updatedPlan !== undefined) {
    try {
      updatedPlan = normalizePlan(raw.updatedPlan);
    } catch {
      reply = `${reply} ${PLAN_REJECTED_NOTE}`;
    }
  }
  return { reply, updatedPlan };
}

module.exports = {
  validateProfile,
  validateChat,
  normalizePlan,
  normalizeChatReply,
  cleanText,
  GOALS,
  EQUIPMENT,
  SEXES,
  CHAT_ROLES,
  MAX_TEXT,
  MAX_HISTORY,
  PLAN_REJECTED_NOTE,
};
