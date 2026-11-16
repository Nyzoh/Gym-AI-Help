'use strict';

const { buildChatPrompt } = require('./prompt');
const { MOCK_PLAN } = require('./mock');

// Word stems that suggest the user wants the plan changed (English and Swedish).
// A false positive only costs one extra model call, never a forced change.
const CHANGE_INTENT =
  /(?<!\p{L})(?:chang|replac|swap|switch|mak(?:e|es|ing)|increas|decreas|updat|remov|reduc|ändr|byt|öka|minsk)\p{L}*/iu;

function hasChangeIntent(message) {
  return typeof message === 'string' && CHANGE_INTENT.test(message);
}

/**
 * Asks the model for a chat answer. `generate(prompt)` must resolve to an
 * already checked { reply, updatedPlan } (see normalizeChatReply).
 *
 * If the message looks like a change request but no usable updated plan came
 * back, the model is asked once more with an explicit instruction. The retry
 * is only used if it actually contains a valid plan.
 */
async function answerChat(chat, generate) {
  const answer = await generate(buildChatPrompt(chat));
  if (answer.updatedPlan || !hasChangeIntent(chat.message)) return answer;

  try {
    const retry = await generate(buildChatPrompt(chat, { requirePlan: true }));
    if (retry.updatedPlan) return retry;
  } catch {
    /* keep the first answer */
  }
  return answer;
}

// Fixed chat answers for MOCK_AI=1. A change request (e.g. a message containing
// "change") returns the example plan with one day swapped, so the UI can be tested.
function mockChatReply(message) {
  if (!hasChangeIntent(message)) {
    return { reply: 'Mock reply: swap squats for leg press if your knees hurt.', updatedPlan: null };
  }
  const updatedPlan = structuredClone(MOCK_PLAN);
  updatedPlan.summary = 'Mock plan (MOCK_AI=1), updated: Day 2 is now a knee-friendly lower body session.';
  updatedPlan.weeklyPlan[1] = {
    day: 'Day 2',
    focus: 'Lower body (knee-friendly)',
    exercises: [
      { name: 'Leg press (partial range)', sets: '4', reps: '10-12', rest: '120s' },
      { name: 'Hip thrust', sets: '3', reps: '8-10', rest: '120s' },
      { name: 'Seated leg curl', sets: '3', reps: '10-12', rest: '75s' },
      { name: 'Calf raise', sets: '3', reps: '12-15', rest: '60s' },
      { name: 'Plank', sets: '3', reps: '45s', rest: '45s' },
    ],
  };
  return { reply: 'Mock reply: I changed Day 2 to a knee-friendly lower body session.', updatedPlan };
}

module.exports = { hasChangeIntent, answerChat, mockChatReply };
