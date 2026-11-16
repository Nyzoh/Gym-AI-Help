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

module.exports = { validateProfile, cleanText, GOALS, EQUIPMENT, SEXES, MAX_TEXT };
