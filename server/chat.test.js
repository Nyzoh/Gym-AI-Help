'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasChangeIntent, answerChat, mockChatReply } = require('./chat');
const { normalizeChatReply, normalizePlan, PLAN_REJECTED_NOTE } = require('./validate');
const { MOCK_PLAN } = require('./mock');

const plan = () => ({
  summary: 'A simple plan',
  weeklyPlan: [{ day: 'Day 1', focus: 'Full body', exercises: [{ name: 'Squat', sets: '3', reps: '8-10', rest: '90s' }] }],
  nutrition: { calories: '2400 kcal', protein: '150 g', tips: ['Eat protein'] },
  safetyNotes: ['Warm up'],
});

const chat = (message) => ({
  profile: { weightKg: 80, heightCm: 180, age: 30, sex: 'male', goal: 'strength', trainingDays: 3, equipment: 'gym', typicalDiet: '', injuries: '' },
  plan: plan(),
  history: [],
  message,
});

// A fake model: returns the given raw answers in order, checked the same way as real model output.
function fakeModel(rawAnswers) {
  const prompts = [];
  const generate = async (prompt) => {
    prompts.push(prompt);
    const raw = rawAnswers[Math.min(prompts.length, rawAnswers.length) - 1];
    if (raw instanceof Error) throw raw;
    return normalizeChatReply(raw);
  };
  return { generate, prompts };
}

/* ---------- change intent ---------- */

test('change intent: detects change requests in English and Swedish', () => {
  const requests = [
    'change the calorie intake to 3000+',
    'Replace squats with something knee-friendly',
    'can you swap day 1 and day 2',
    'Make leg day shorter',
    'increase protein',
    'Decrease the volume a bit',
    'update my plan please',
    'Ändra dag 2',
    'byt ut knäböj',
    'Changing the rest times would help',
  ];
  for (const message of requests) assert.equal(hasChangeIntent(message), true, message);
});

test('change intent: plain questions are not change requests', () => {
  for (const message of ['Is this enough volume?', 'How long should I rest?', 'Why deadlifts on day 4?', '', undefined]) {
    assert.equal(hasChangeIntent(message), false, String(message));
  }
});

/* ---------- mock mode ---------- */

test('mock mode: a change request sets updatedPlan with one day changed', () => {
  const answer = mockChatReply('Please change leg day');
  assert.ok(answer.updatedPlan, 'updatedPlan should be set');
  assert.deepEqual(normalizePlan(answer.updatedPlan), answer.updatedPlan, 'updatedPlan follows the plan format');

  const changed = answer.updatedPlan.weeklyPlan.filter(
    (day, i) => JSON.stringify(day) !== JSON.stringify(MOCK_PLAN.weeklyPlan[i]),
  );
  assert.equal(answer.updatedPlan.weeklyPlan.length, MOCK_PLAN.weeklyPlan.length);
  assert.equal(changed.length, 1, 'exactly one day differs from the example plan');
  assert.match(answer.reply, /changed Day 2/);
});

test('mock mode: a question leaves updatedPlan null', () => {
  const answer = mockChatReply('Is this enough volume?');
  assert.equal(answer.updatedPlan, null);
  assert.match(answer.reply, /^Mock reply/);
});

test('mock mode: POST /api/chat returns an updated plan for a change request', async (t) => {
  process.env.MOCK_AI = '1';
  process.env.ACCESS_CODE = 'test-code';
  process.env.RATE_LIMIT_PER_HOUR = '50';
  const { server } = require('./index');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/api/chat`;
  const post = (body) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const base = { code: 'test-code', profile: chat('').profile, plan: MOCK_PLAN, history: [] };

  const change = await post({ ...base, message: 'change the calorie intake to 3000+' });
  assert.equal(change.status, 200);
  const changeBody = await change.json();
  assert.ok(changeBody.updatedPlan);
  assert.equal(changeBody.updatedPlan.weeklyPlan[1].focus, 'Lower body (knee-friendly)');

  const question = await post({ ...base, message: 'Is this enough volume?' });
  assert.equal(question.status, 200);
  assert.equal((await question.json()).updatedPlan, null);

  assert.equal((await post({ ...base, message: '   ' })).status, 400);
  assert.equal((await post({ ...base, code: 'wrong', message: 'hi' })).status, 401);
});

/* ---------- retry and validation of model answers ---------- */

test('question: the model is asked once and updatedPlan stays null', async () => {
  const model = fakeModel([{ reply: 'Yes, that is enough.', updatedPlan: null }]);
  const answer = await answerChat(chat('Is this enough volume?'), model.generate);
  assert.equal(model.prompts.length, 1);
  assert.deepEqual(answer, { reply: 'Yes, that is enough.', updatedPlan: null });
});

test('change request answered with a plan: no retry', async () => {
  const model = fakeModel([{ reply: 'Done.', updatedPlan: plan() }]);
  const answer = await answerChat(chat('change squats to leg press'), model.generate);
  assert.equal(model.prompts.length, 1);
  assert.deepEqual(answer.updatedPlan, normalizePlan(plan()));
});

test('change request answered without a plan: retried once with an explicit instruction', async () => {
  const updated = plan();
  updated.nutrition.calories = '3000 kcal';
  const model = fakeModel([
    { reply: 'Sure, aim for 3000 kcal.', updatedPlan: null },
    { reply: 'I raised your calories to 3000 kcal.', updatedPlan: updated },
  ]);
  const answer = await answerChat(chat('change the calorie intake to 3000+'), model.generate);

  assert.equal(model.prompts.length, 2);
  assert.doesNotMatch(model.prompts[0], /Your previous answer/);
  assert.match(model.prompts[1], /MUST return the COMPLETE updated plan in "updatedPlan" this time/);
  assert.equal(answer.updatedPlan.nutrition.calories, '3000 kcal');
  assert.equal(answer.reply, 'I raised your calories to 3000 kcal.');
});

test('change request: gives up after one retry and keeps the first reply', async () => {
  const model = fakeModel([{ reply: 'Sure, aim for 3000 kcal.', updatedPlan: null }]);
  const answer = await answerChat(chat('increase calories'), model.generate);
  assert.equal(model.prompts.length, 2);
  assert.deepEqual(answer, { reply: 'Sure, aim for 3000 kcal.', updatedPlan: null });
});

test('change request: a failing retry does not lose the first answer', async () => {
  const model = fakeModel([{ reply: 'Sure.', updatedPlan: null }, new Error('HTTP 503')]);
  const answer = await answerChat(chat('swap day 1 and 2'), model.generate);
  assert.equal(model.prompts.length, 2);
  assert.deepEqual(answer, { reply: 'Sure.', updatedPlan: null });
});

test('an invalid updatedPlan from the model is rejected: null, and the reply gets a note', async () => {
  const invalidPlans = [{ weeklyPlan: [] }, { summary: 'no days' }, 'new plan', { weeklyPlan: [{ day: 'Day 1', exercises: [] }] }];
  for (const invalid of invalidPlans) {
    const model = fakeModel([{ reply: 'I updated your plan.', updatedPlan: invalid }]);
    const answer = await answerChat(chat('replace squats'), model.generate);
    assert.equal(answer.updatedPlan, null, JSON.stringify(invalid));
    assert.ok(answer.reply.startsWith('I updated your plan.'));
    assert.ok(answer.reply.includes(PLAN_REJECTED_NOTE));
    assert.equal(model.prompts.length, 2, 'a rejected plan is retried once');
  }
});

test('an invalid updatedPlan followed by a valid one on retry is accepted', async () => {
  const model = fakeModel([
    { reply: 'I updated your plan.', updatedPlan: { weeklyPlan: [] } },
    { reply: 'Squats replaced with leg press.', updatedPlan: plan() },
  ]);
  const answer = await answerChat(chat('replace squats'), model.generate);
  assert.deepEqual(answer.updatedPlan, normalizePlan(plan()));
  assert.ok(!answer.reply.includes(PLAN_REJECTED_NOTE));
});
