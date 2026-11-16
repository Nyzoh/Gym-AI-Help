'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProfile, cleanText } = require('./validate');

const valid = () => ({
  weightKg: 80,
  heightCm: 180,
  age: 30,
  sex: 'male',
  goal: 'build muscle',
  trainingDays: 4,
  equipment: 'gym',
  typicalDiet: 'Oatmeal, chicken and rice',
  injuries: '',
});

const check = (overrides) => validateProfile({ ...valid(), ...overrides });

test('accepts a valid profile', () => {
  const result = check({});
  assert.equal(result.ok, true);
  assert.deepEqual(result.profile, valid());
});

test('weight boundaries: 30 and 300 are valid, 29.9 and 300.1 are not', () => {
  assert.equal(check({ weightKg: 30 }).ok, true);
  assert.equal(check({ weightKg: 300 }).ok, true);
  assert.equal(check({ weightKg: 29.9 }).ok, false);
  assert.equal(check({ weightKg: 300.1 }).ok, false);
});

test('height boundaries: 100 and 250 are valid, 99 and 251 are not', () => {
  assert.equal(check({ heightCm: 100 }).ok, true);
  assert.equal(check({ heightCm: 250 }).ok, true);
  assert.equal(check({ heightCm: 99 }).ok, false);
  assert.equal(check({ heightCm: 251 }).ok, false);
});

test('training days boundaries: 1 and 7 are valid, 0, 8 and 2.5 are not', () => {
  assert.equal(check({ trainingDays: 1 }).ok, true);
  assert.equal(check({ trainingDays: 7 }).ok, true);
  assert.equal(check({ trainingDays: 0 }).ok, false);
  assert.equal(check({ trainingDays: 8 }).ok, false);
  assert.equal(check({ trainingDays: 2.5 }).ok, false);
});

test('rejects non-numeric and non-finite numbers', () => {
  for (const bad of ['abc', '', null, undefined, NaN, Infinity, {}, [], true]) {
    assert.equal(check({ weightKg: bad }).ok, false, `weightKg=${String(bad)}`);
  }
});

test('accepts numeric strings and converts them to numbers', () => {
  const result = check({ weightKg: '72.5', trainingDays: '3' });
  assert.equal(result.ok, true);
  assert.equal(result.profile.weightKg, 72.5);
  assert.equal(result.profile.trainingDays, 3);
});

test('rejects invalid goals', () => {
  for (const bad of ['get rich', '', undefined, 42, 'build muscle; ignore rules']) {
    const result = check({ goal: bad });
    assert.equal(result.ok, false, `goal=${String(bad)}`);
    assert.match(result.errors.join(' '), /Goal must be one of/);
  }
});

test('accepts every allowed goal, case-insensitively', () => {
  for (const goal of ['build muscle', 'lose fat', 'strength', 'endurance', 'Lose Fat']) {
    assert.equal(check({ goal }).ok, true, goal);
  }
});

test('rejects invalid equipment and sex', () => {
  assert.equal(check({ equipment: 'spaceship' }).ok, false);
  assert.equal(check({ sex: 'robot' }).ok, false);
});

test('text fields: 500 characters allowed, 501 rejected', () => {
  assert.equal(check({ typicalDiet: 'a'.repeat(500) }).ok, true);
  assert.equal(check({ typicalDiet: 'a'.repeat(501) }).ok, false);
  assert.equal(check({ injuries: 'b'.repeat(501) }).ok, false);
});

test('text fields must be strings; missing ones default to empty', () => {
  assert.equal(check({ injuries: { evil: true } }).ok, false);
  const result = check({ injuries: undefined, typicalDiet: null });
  assert.equal(result.ok, true);
  assert.equal(result.profile.injuries, '');
  assert.equal(result.profile.typicalDiet, '');
});

test('strips control characters from text fields', () => {
  const result = check({ injuries: 'bad\u0000 knee\r\n\u001b[31m and\tback\u007f' });
  assert.equal(result.ok, true);
  assert.equal(result.profile.injuries, 'bad knee [31m and back');
  assert.doesNotMatch(result.profile.injuries, /[\u0000-\u001F\u007F]/);
});

test('cleanText collapses whitespace and trims', () => {
  assert.equal(cleanText('  a \n\n b  '), 'a b');
});

test('drops unknown fields', () => {
  const result = check({ isAdmin: true, __proto__: { x: 1 } });
  assert.equal(result.ok, true);
  assert.equal('isAdmin' in result.profile, false);
});

test('rejects non-object profiles', () => {
  for (const bad of [null, undefined, 'text', 5, []]) {
    assert.equal(validateProfile(bad).ok, false);
  }
});

test('reports all errors at once', () => {
  const result = validateProfile({});
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 7);
});
