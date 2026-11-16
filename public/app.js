'use strict';

const $ = (id) => document.getElementById(id);
const errorBox = $('error');
const gate = $('gate');
const app = $('app');
const profileForm = $('profile-form');
const generateBtn = $('generate');
const planSection = $('plan');
const planBody = $('plan-body');
const planEmpty = $('plan-empty');
const planBanner = $('plan-banner');
const toggleDaysBtn = $('toggle-days');
const savedNote = $('saved-note');
const savedText = $('saved-text');
const chatPanel = $('chat');
const chatLog = $('chat-log');
const chatInput = $('chat-input');
const chatSend = $('chat-send');
const chatToggle = $('chat-toggle');

const CHAT_PLACEHOLDER = 'Ask about your plan, or ask for a change, e.g. "Replace squats with something knee-friendly".';
const MAX_HISTORY = 10; // messages sent to the server
const MAX_TEXT = 500;
const MAX_STORED_CHAT = 50;

// The access code is only kept in memory for this page load and sent to the
// server with each request. It is never stored (not in localStorage either).
let accessCode = '';

let currentProfile = null; // the profile the current plan was generated from
let currentPlan = null;
let previousPlan = null; // the plan before the coach's latest change, for Undo
let chatHistory = []; // [{ role: 'user' | 'assistant', text }]
let entered = false;

/* ---------- saving in this browser ---------- */

// Profile, plan and chat are saved in localStorage so they survive a reload.
// Every access is wrapped: the app works the same if storage is blocked.
const STORAGE_KEY = 'gymAiCoach.v1';
const store = {
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const data = raw ? JSON.parse(raw) : null;
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  },
  save(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  },
  clear() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage blocked: nothing to remove */
    }
  },
};

function persist() {
  const ok = store.save({
    form: Object.fromEntries(new FormData(profileForm)),
    profile: currentProfile,
    plan: currentPlan,
    chat: chatHistory.slice(-MAX_STORED_CHAT),
  });
  if (ok && currentPlan) showSavedNote('Saved in this browser.');
  else if (!ok) savedNote.hidden = true;
}

function showSavedNote(text) {
  savedText.textContent = text;
  savedNote.hidden = false;
}

function restore() {
  const saved = store.load();
  if (!saved) return;
  try {
    if (saved.form && typeof saved.form === 'object') {
      for (const [name, value] of Object.entries(saved.form)) {
        const field = profileForm.elements[name];
        if (field && typeof value === 'string') field.value = value;
      }
    }
    if (!saved.plan || !saved.profile || typeof saved.profile !== 'object') return;

    renderPlan(saved.plan); // throws if the saved plan is not usable
    currentProfile = saved.profile;
    const chat = Array.isArray(saved.chat) ? saved.chat : [];
    chatHistory = chat.filter(
      (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text,
    );
    resetChatLog();
    chatHistory.forEach((m) => addBubble(m.role, m.text));
    showSavedNote('Restored from this browser.');
  } catch {
    // Saved data is damaged or from an incompatible version: drop it.
    store.clear();
    clearPlanView();
  }
}

$('clear-saved').addEventListener('click', () => {
  if (!window.confirm('Remove the saved profile, plan and chat from this browser?')) return;
  store.clear();
  profileForm.reset();
  clearPlanView();
  clearError();
});

profileForm.addEventListener('change', persist);

/* ---------- helpers ---------- */

// All dynamic content is inserted via textContent, never innerHTML.
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function showError(message, details) {
  errorBox.replaceChildren();
  errorBox.append(el('strong', message));
  if (details && details.length) {
    const list = el('ul');
    details.forEach((d) => list.append(el('li', d)));
    errorBox.append(list);
  }
  errorBox.hidden = false;
  errorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearError() {
  errorBox.hidden = true;
  errorBox.replaceChildren();
}

async function api(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error('Could not reach the server. Check your connection and try again.'), { status: 0 });
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    /* non-JSON response */
  }
  if (!response.ok) {
    const message = (data && data.error) || `Request failed (${response.status}).`;
    throw Object.assign(new Error(message), { status: response.status, details: data && data.errors });
  }
  return data;
}

/* ---------- access code ---------- */

function showGate() {
  gate.hidden = false;
  app.hidden = true;
  $('code').focus();
}

function enterApp() {
  gate.hidden = true;
  app.hidden = false;
  if (!entered) {
    entered = true;
    restore();
  }
}

async function init() {
  try {
    const health = await api('/api/health');
    $('mock-badge').hidden = !health.mock;
    if (health.needsCode) showGate();
    else enterApp();
    if (!health.mock && !health.hasApiKey) {
      showError('The server has no AI API key configured, so plans cannot be generated yet.');
    }
  } catch (err) {
    showError(err.message);
  }
}

$('code-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();
  const code = $('code').value;
  const button = event.target.querySelector('button');
  button.disabled = true;
  try {
    await api('/api/check-code', { code });
    accessCode = code;
    enterApp();
  } catch (err) {
    showError(err.message);
  } finally {
    button.disabled = false;
  }
});

/* ---------- plan generation ---------- */

profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();
  if (!profileForm.reportValidity()) return;

  const data = new FormData(profileForm);
  const profile = {
    weightKg: Number(data.get('weightKg')),
    heightCm: Number(data.get('heightCm')),
    age: Number(data.get('age')),
    sex: data.get('sex'),
    goal: data.get('goal'),
    trainingDays: Number(data.get('trainingDays')),
    equipment: data.get('equipment'),
    typicalDiet: data.get('typicalDiet'),
    injuries: data.get('injuries'),
  };

  generateBtn.disabled = true;
  generateBtn.textContent = 'Generating… up to a minute';
  try {
    const plan = await api('/api/plan', { code: accessCode, profile });
    renderPlan(plan);
    currentProfile = profile;
    previousPlan = null;
    planBanner.hidden = true;
    chatHistory = [];
    resetChatLog();
    persist();
    planSection.scrollTop = 0;
    planSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    showError(err.message, err.details);
    if (err.status === 401) {
      accessCode = '';
      showGate();
    }
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = 'Generate plan';
  }
});

/* ---------- plan view ---------- */

function isUsablePlan(plan) {
  return (
    plan !== null &&
    typeof plan === 'object' &&
    Array.isArray(plan.weeklyPlan) &&
    plan.weeklyPlan.length > 0 &&
    plan.weeklyPlan.every((day) => day && typeof day === 'object' && Array.isArray(day.exercises))
  );
}

function list(items) {
  const ul = el('ul');
  (items || []).forEach((item) => ul.append(el('li', item)));
  return ul;
}

function dayTitle(day, index) {
  const name = day.day || `Day ${index + 1}`;
  return day.focus ? `${name} – ${day.focus}` : name;
}

/**
 * Renders a plan: summary, nutrition and safety notes first, then one
 * collapsed card per day. Days that differ from `changedFrom` start expanded.
 * The new view is built completely before it replaces the old one, so a plan
 * that cannot be rendered throws and leaves the current plan untouched.
 */
function renderPlan(plan, { changedFrom = null } = {}) {
  if (!isUsablePlan(plan)) throw new Error('This plan cannot be displayed.');
  const view = document.createDocumentFragment();

  if (plan.summary) view.append(el('p', plan.summary, 'summary'));

  const nutrition = plan.nutrition || {};
  const tips = Array.isArray(nutrition.tips) ? nutrition.tips : [];
  if (nutrition.calories || nutrition.protein || tips.length) {
    const food = el('section', null, 'block');
    food.append(el('h3', 'Nutrition'));
    const stats = el('div', null, 'stats');
    [['Calories', nutrition.calories], ['Protein', nutrition.protein]].forEach(([label, value]) => {
      if (!value) return;
      const stat = el('div', null, 'stat');
      stat.append(el('span', label), el('strong', value));
      stats.append(stat);
    });
    food.append(stats);
    if (tips.length) food.append(list(tips));
    view.append(food);
  }

  if (Array.isArray(plan.safetyNotes) && plan.safetyNotes.length) {
    const safety = el('section', null, 'block safety');
    safety.append(el('h3', 'Safety notes'), list(plan.safetyNotes));
    view.append(safety);
  }

  const days = el('div', null, 'days');
  plan.weeklyPlan.forEach((day, index) => {
    const card = el('details', null, 'day');
    const before = changedFrom && changedFrom.weeklyPlan ? changedFrom.weeklyPlan[index] : null;
    const changed = Boolean(changedFrom) && JSON.stringify(before) !== JSON.stringify(day);
    if (changed) {
      card.open = true;
      card.classList.add('changed');
    }

    const header = el('summary');
    header.append(el('span', dayTitle(day, index), 'day-title'));
    if (changed) header.append(el('span', 'Updated', 'tag'));
    header.append(el('span', `${day.exercises.length} exercises`, 'day-count'));
    card.append(header);

    const table = el('table');
    const head = el('tr');
    ['Exercise', 'Sets', 'Reps', 'Rest'].forEach((h) => head.append(el('th', h)));
    table.append(head);
    day.exercises.forEach((ex) => {
      const row = el('tr');
      row.append(el('td', ex.name), el('td', ex.sets), el('td', ex.reps), el('td', ex.rest));
      table.append(row);
    });
    card.append(table);
    days.append(card);
  });
  view.append(days);

  planBody.replaceChildren(view);
  currentPlan = plan;
  planEmpty.hidden = true;
  toggleDaysBtn.hidden = false;
  chatPanel.hidden = false;
  app.classList.add('has-plan');
  updateToggleLabel();
}

function clearPlanView() {
  currentPlan = null;
  currentProfile = null;
  previousPlan = null;
  chatHistory = [];
  planBody.replaceChildren();
  planEmpty.hidden = false;
  planBanner.hidden = true;
  toggleDaysBtn.hidden = true;
  savedNote.hidden = true;
  chatPanel.hidden = true;
  app.classList.remove('has-plan');
  resetChatLog();
}

const dayCards = () => Array.from(planBody.querySelectorAll('details.day'));

function updateToggleLabel() {
  const cards = dayCards();
  toggleDaysBtn.textContent = cards.length && cards.every((card) => card.open) ? 'Collapse all' : 'Expand all';
}

toggleDaysBtn.addEventListener('click', () => {
  const cards = dayCards();
  const open = !cards.every((card) => card.open);
  cards.forEach((card) => {
    card.open = open;
  });
  updateToggleLabel();
});

// "toggle" does not bubble, so listen in the capture phase.
planBody.addEventListener('toggle', updateToggleLabel, true);

/* ---------- plan changes from the coach ---------- */

// A valid updated plan is shown right away, always with a visible note and an
// Undo button. Nothing changes silently.
function applyCoachPlan(newPlan) {
  const before = currentPlan;
  renderPlan(newPlan, { changedFrom: before }); // throws before anything changes if unusable
  previousPlan = before;
  planBanner.hidden = false;
  planSection.scrollTop = 0;
  planBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('undo').addEventListener('click', () => {
  if (!previousPlan) return;
  renderPlan(previousPlan);
  previousPlan = null;
  planBanner.hidden = true;
  addBubble('note', 'Change undone. Your previous plan is back.');
  persist();
});

// Fallback only: shown when an updated plan could not be displayed automatically.
function addApplyButton(bubble, updatedPlan) {
  const button = el('button', 'Apply new plan', 'apply');
  button.type = 'button';
  button.addEventListener('click', () => {
    try {
      applyCoachPlan(updatedPlan);
      button.replaceWith(el('span', 'Plan updated. Use Undo above the plan to go back.', 'bubble-tag'));
      persist();
    } catch {
      addChatError('The new plan could not be displayed. Your current plan is unchanged.');
    }
  });
  bubble.append(button);
}

/* ---------- chat coach ---------- */

function resetChatLog() {
  chatLog.replaceChildren(el('p', CHAT_PLACEHOLDER, 'chat-empty'));
}

function addBubble(role, text) {
  const empty = chatLog.querySelector('.chat-empty');
  if (empty) empty.remove();
  const bubble = el('div', text, `bubble ${role}`);
  chatLog.append(bubble);
  chatLog.scrollTop = chatLog.scrollHeight;
  return bubble;
}

function addChatError(message, details) {
  const text = details && details.length ? `${message} ${details.join(' ')}` : message;
  const bubble = addBubble('chat-error', text);
  bubble.setAttribute('role', 'alert');
}

async function sendChat() {
  const message = chatInput.value.trim();
  if (!message || chatSend.disabled || !currentPlan) return;

  chatLog.querySelectorAll('.chat-error').forEach((node) => node.remove());
  const userBubble = addBubble('user', message);
  const pending = addBubble('assistant pending', 'Thinking…');
  chatInput.value = '';
  chatSend.disabled = true;

  // The server accepts at most 10 history messages of 500 characters each.
  const history = chatHistory.slice(-MAX_HISTORY).map((m) => ({ role: m.role, text: m.text.slice(0, MAX_TEXT) }));

  try {
    const answer = await api('/api/chat', {
      code: accessCode,
      profile: currentProfile,
      plan: currentPlan,
      history,
      message,
    });
    pending.textContent = answer.reply;
    pending.className = 'bubble assistant';
    chatHistory.push({ role: 'user', text: message }, { role: 'assistant', text: answer.reply });

    if (answer.updatedPlan) {
      try {
        applyCoachPlan(answer.updatedPlan);
        pending.append(el('span', 'Plan updated. Use Undo above the plan to go back.', 'bubble-tag'));
      } catch {
        addApplyButton(pending, answer.updatedPlan);
      }
    }
    persist();
  } catch (err) {
    // Put the message back so it can be retried, and show the error in the chat.
    userBubble.remove();
    pending.remove();
    chatInput.value = message;
    addChatError(err.message, err.details);
    if (err.status === 401) {
      accessCode = '';
      showGate();
      showError('Wrong access code. Enter the code again to keep chatting.');
    }
  } finally {
    chatSend.disabled = false;
    chatLog.scrollTop = chatLog.scrollHeight;
  }
}

$('chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  sendChat();
});

chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendChat();
  }
});

// Only visible where the chat floats over the page (medium-width screens).
chatToggle.addEventListener('click', () => {
  const minimized = chatPanel.classList.toggle('min');
  chatToggle.textContent = minimized ? 'Show' : 'Hide';
  chatToggle.setAttribute('aria-expanded', String(!minimized));
});

init();
