'use strict';

const $ = (id) => document.getElementById(id);
const errorBox = $('error');
const gate = $('gate');
const profileSection = $('profile');
const result = $('result');
const generateBtn = $('generate');

// The access code is only kept in memory for this page load and sent to the
// server with each request. It is never stored or baked into the frontend.
let accessCode = '';

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

// All dynamic content is inserted via textContent, never innerHTML.
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
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

function showGate() {
  gate.hidden = false;
  profileSection.hidden = true;
  $('code').focus();
}

function showProfile() {
  gate.hidden = true;
  profileSection.hidden = false;
}

async function init() {
  try {
    const health = await api('/api/health');
    $('mock-badge').hidden = !health.mock;
    if (health.needsCode) showGate();
    else showProfile();
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
    showProfile();
  } catch (err) {
    showError(err.message);
  } finally {
    button.disabled = false;
  }
});

$('profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();
  const form = event.target;
  if (!form.reportValidity()) return;

  const data = new FormData(form);
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
  generateBtn.textContent = 'Generating… this can take up to a minute';
  try {
    const plan = await api('/api/plan', { code: accessCode, profile });
    renderPlan(plan);
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

function renderPlan(plan) {
  result.replaceChildren();

  const intro = el('div', null, 'card');
  intro.append(el('h2', 'Your week'));
  if (plan.summary) intro.append(el('p', plan.summary, 'summary'));
  result.append(intro);

  const days = el('div', null, 'days');
  (plan.weeklyPlan || []).forEach((day) => {
    const card = el('article', null, 'card day');
    card.append(el('p', day.day, 'day-name'), el('h3', day.focus || 'Training'));

    const table = el('table');
    const head = el('tr');
    ['Exercise', 'Sets', 'Reps', 'Rest'].forEach((h) => head.append(el('th', h)));
    table.append(head);
    (day.exercises || []).forEach((ex) => {
      const row = el('tr');
      row.append(el('td', ex.name), el('td', ex.sets), el('td', ex.reps), el('td', ex.rest));
      table.append(row);
    });
    card.append(table);
    days.append(card);
  });
  result.append(days);

  const nutrition = plan.nutrition || {};
  const food = el('div', null, 'card');
  food.append(el('h2', 'Nutrition'));
  const stats = el('div', null, 'stats');
  [['Calories', nutrition.calories], ['Protein', nutrition.protein]].forEach(([label, value]) => {
    if (!value) return;
    const stat = el('div', null, 'stat');
    stat.append(el('span', label), el('strong', value));
    stats.append(stat);
  });
  food.append(stats, list(nutrition.tips));
  result.append(food);

  if (plan.safetyNotes && plan.safetyNotes.length) {
    const safety = el('div', null, 'card safety');
    safety.append(el('h2', 'Safety notes'), list(plan.safetyNotes));
    result.append(safety);
  }

  result.hidden = false;
  result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function list(items) {
  const ul = el('ul');
  (items || []).forEach((item) => ul.append(el('li', item)));
  return ul;
}

init();
