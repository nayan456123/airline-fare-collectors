const STAGES = [
  ['browser_ready', 'Browser'], ['homepage_loaded', 'Homepage'],
  ['markets_ready', 'Markets'], ['form_confirmed', 'Route + date'],
  ['search_submitted', 'Submitted'], ['airline_response_verified', 'Airline data'],
  ['results_rendered', 'Results'], ['fare_verified', 'Fare check'],
  ['complete', 'Complete']
];
const OFFSETS = [1, 5, 9, 15, 30, 45];
const DENIALS = new Set(['ACCESS_DENIED', 'CAPTCHA', 'RATE_LIMITED', 'SESSION_EXPIRED', 'SESSION_INVALID']);
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const niceDate = value => value ? new Intl.DateTimeFormat('en-IN', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata'
}).format(new Date(`${value}T00:00:00+05:30`)) : '—';
const niceTime = value => value ? new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata'
}).format(new Date(value)) : '—';
const money = value => value !== null && value !== undefined && Number.isFinite(Number(value)) ?
  `₹${Number(value).toLocaleString('en-IN')}` : '—';
let currentRun = null;
let stream = null;
let retryPending = false;

function dateFor(offset) {
  const india = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = india.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
}

function renderDates() {
  $('#dates').innerHTML = OFFSETS.map(offset => `<label class="date-option"><input type="checkbox" value="${offset}" ${offset === 1 ? 'checked' : ''}><span><b>T+${offset}</b><small>${escapeHtml(niceDate(dateFor(offset)))}</small></span></label>`).join('');
}

function plannedRoutes() {
  return $('#routes').value.split(/[\n,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
}

function planSummary() {
  const count = new Set(plannedRoutes().map(route => route.replace(/\s+/g, ''))).size *
    document.querySelectorAll('#dates input:checked').length;
  $('#plan-summary').textContent = `${count} search${count === 1 ? '' : 'es'} · all flights`;
}

function validate() {
  $('#routes-error').textContent = '';
  $('#form-error').textContent = '';
  const routes = plannedRoutes();
  if (!routes.length || routes.some(route => !/^[A-Z]{3}\s*[-:→]\s*[A-Z]{3}$/.test(route))) {
    $('#routes-error').textContent = 'Enter one route per line, such as DEL-BOM.';
    $('#routes').focus();
    return null;
  }
  const offsets = [...document.querySelectorAll('#dates input:checked')].map(input => Number(input.value));
  if (!offsets.length) { $('#form-error').textContent = 'Choose at least one travel date.'; return null; }
  return { routes, offsets, browserMode: $('#browser-mode').value };
}

function statusLabel(status) {
  return ({ ok: 'Verified', partial: 'Partial', queued: 'Queued', running: 'Searching',
    blocked: 'Blocked', failed: 'Failed', skipped: 'Skipped', interrupted: 'Interrupted',
    complete: 'Complete', cancelled: 'Stopped', stopping: 'Stopping' })[status] || status;
}

function evidenceUrl(run, task, file) {
  return `/api/runs/${encodeURIComponent(run.id)}/evidence/${task.id}/${encodeURIComponent(file)}`;
}

function retryAction(run, task) {
  if (!['failed', 'partial', 'skipped', 'interrupted'].includes(task.status) ||
      DENIALS.has(run.stopReason) || DENIALS.has(task.cause?.code) ||
      task.travelDate <= dateFor(0)) return '';
  const label = task.status === 'skipped' ? 'Run this search' : 'Retry this search';
  const route = `${task.origin} to ${task.destination} on ${niceDate(task.travelDate)}`;
  return `<div class="task-actions"><button class="retry-button" type="button" data-retry-task="${escapeHtml(task.id)}" aria-label="${escapeHtml(`${label}: ${route}`)}">${label} <span aria-hidden="true">↗</span></button><span>Only this route and date · new saved run</span></div>`;
}

function causeSummary(task) {
  if (task.status === 'skipped') return 'This search was not sent to Akasa because the batch stopped.';
  return ({ TIMEOUT: 'The Akasa search form did not respond in time.',
    AIRPORT_PICKER_UNAVAILABLE: 'The airport picker did not show a search field.',
    CALENDAR_NAVIGATION_FAILED: 'Akasa’s calendar did not advance to the travel month.',
    DATE_UNAVAILABLE: 'The travel date did not appear in Akasa’s calendar.',
    TLS_TRUST_FAILURE: 'The browser could not verify an Akasa certificate.',
    SITE_NETWORK_FAILURE: 'The flight request ended before a fare response arrived.',
    BATCH_STOPPED: 'This search was interrupted when the batch stopped.' })[task.cause?.code] ||
    'This search did not produce verified fares.';
}

function taskHtml(run, task) {
  const stageIndex = STAGES.findIndex(([key]) => key === task.stage);
  const progress = task.status === 'ok' ? 100 : Math.max(0, (stageIndex + 1) / STAGES.length * 100);
  const stages = STAGES.map(([key, label], index) => `<div class="stage-item ${index < stageIndex || task.status === 'ok' ? 'done' : index === stageIndex && task.status === 'running' ? 'current' : ''}" title="${escapeHtml(label)}">${escapeHtml(label)}</div>`).join('');
  const sorted = [...task.fares].sort((a, b) => a.price.displayedTotal - b.price.displayedTotal ||
    String(a.departureTime || '').localeCompare(String(b.departureTime || '')));
  const lowest = sorted[0]?.price.displayedTotal;
  const fareRows = sorted.map(fare => `<tr><td class="flight-name">${escapeHtml(fare.flight)}</td><td>${escapeHtml(fare.departureTime || '—')} → ${escapeHtml(fare.arrivalTime || '—')}</td><td>${fare.stops === 0 ? 'Non-stop' : Number.isInteger(fare.stops) ? `${fare.stops} stop${fare.stops === 1 ? '' : 's'}` : '—'}</td><td class="price-cell">${money(fare.price.displayedTotal)}${fare.price.displayedTotal === lowest ? ' <span class="low-tag">Lowest</span>' : ''}</td><td class="breakdown-cell">${money(fare.price.base)} + ${money(fare.price.includedTaxesAndFees)}</td><td>${money(fare.price.additionalWfe)}</td><td>${money(fare.price.fullTotal)}</td><td>${fare.rowFile ? `<a href="${evidenceUrl(run, task, fare.rowFile)}" download>Row ↓</a>` : `<a href="${evidenceUrl(run, task, fare.screenshot)}" target="_blank" rel="noopener">Page ↗</a>`}</td></tr>`).join('');
  const evidence = sorted[0] ? `<div class="fare-evidence"><a href="${evidenceUrl(run, task, sorted[0].screenshot)}" target="_blank" rel="noopener">Result screenshot ↗</a>${sorted[0].resultPage ? `<a href="${evidenceUrl(run, task, sorted[0].resultPage)}" download>Saved page ↓</a>` : ''}<a href="${evidenceUrl(run, task, sorted[0].response)}" download>Airline response ↓</a></div>` : '';
  const fares = sorted.length ? `<div class="fare-list"><div class="fare-list-head"><strong>${task.coverage ? `${task.coverage.captured} of ${task.coverage.expectedJourneys} flights verified` : `${sorted.length} verified flights`}</strong><span>Lowest displayed starting fare: ${money(lowest)}</span></div><div class="flight-table-scroll"><table class="flight-table"><thead><tr><th>Flight</th><th>Time</th><th>Stops</th><th>Starting fare</th><th>Base + taxes</th><th>Additional WFE</th><th>Full total</th><th>Evidence</th></tr></thead><tbody>${fareRows}</tbody></table></div>${evidence}</div>` : '';
  const error = task.cause ? `<div class="task-error"><strong>${escapeHtml(causeSummary(task))}</strong>${task.cause.detail ? `<details><summary>Technical cause</summary><code>${escapeHtml(`${task.cause.code}: ${task.cause.detail}`.replace(/\x1b\[[0-9;]*m/g, ''))}</code></details>` : `<small>${escapeHtml(task.cause.code)}</small>`}</div>` : '';
  const events = task.events.slice(-12).reverse().map(event => `<li><time>${escapeHtml(new Date(event.at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }))}</time><span>${escapeHtml(event.stage ? STAGES.find(([key]) => key === event.stage)?.[1] || event.stage : event.event.replaceAll('_', ' '))}${event.code ? ` · ${escapeHtml(event.code)}` : ''}${event.message ? ` · ${escapeHtml(String(event.message).slice(0, 160))}` : ''}</span></li>`).join('');
  const count = task.status === 'running' && task.expectedJourneys != null ?
    `Checking ${task.observedFareCount || 0} / ${task.expectedJourneys} flights` :
    task.coverage ? `${task.coverage.captured} / ${task.coverage.expectedJourneys} flights` : '';
  return `<article class="task-card ${escapeHtml(task.status)}"><div class="task-top"><div><div class="task-route">${escapeHtml(task.origin)} <span>→</span> ${escapeHtml(task.destination)}</div><div class="task-subtitle">${run.retryOf ? 'Saved date' : `T+${task.offset}`} · ${escapeHtml(niceDate(task.travelDate))}</div></div><span class="status-badge ${escapeHtml(task.status)}">${escapeHtml(statusLabel(task.status))}</span></div><div class="task-progress" role="progressbar" aria-label="${escapeHtml(task.origin)} to ${escapeHtml(task.destination)} progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress)}"><span style="width:${progress}%"></span></div><div class="stage-list">${stages}</div><div class="task-info"><span>${task.status === 'queued' ? 'Waiting in queue' : task.status === 'running' ? 'Searching Akasa' : 'Search finished'}</span><span>Agent ${escapeHtml(task.worker || '—')} · ${escapeHtml(run.browserMode || 'headed')} browser</span><span>${escapeHtml(count)}</span><span>${task.evidenceVerified ? 'Fare evidence verified' : task.status === 'running' ? 'Evidence pending' : task.worker ? 'Attempt saved; no verified fare' : ''}</span></div>${error}${retryAction(run, task)}${fares}<details class="event-toggle" data-task-id="${escapeHtml(task.id)}"><summary>Step log · ${task.events.length} events</summary><ul class="event-list">${events || '<li>Waiting for first event</li>'}</ul></details></article>`;
}

function renderRun(run) {
  currentRun = run;
  $('#run-picker').value = run.id;
  $('#empty').hidden = true;
  $('#run-board').hidden = false;
  const active = ['running', 'stopping'].includes(run.status);
  $('#start').disabled = active;
  $('#cancel').hidden = run.status !== 'running';
  $('#delete-run').hidden = active;
  const retryable = run.tasks.filter(task => ['failed', 'partial', 'skipped', 'interrupted'].includes(task.status) &&
    !DENIALS.has(task.cause?.code) && task.travelDate > dateFor(0));
  $('#retry-all').hidden = active || DENIALS.has(run.stopReason) || !retryable.length;
  $('#retry-all').textContent = `Retry ${retryable.length} failed search${retryable.length === 1 ? '' : 'es'}`;
  const recordedDenial = DENIALS.has(run.stopReason) || run.tasks.some(task => DENIALS.has(task.cause?.code));
  const recoverable = run.tasks.filter(task => ['failed', 'partial', 'skipped', 'interrupted', 'blocked'].includes(task.status) &&
    task.travelDate > dateFor(0));
  $('#recover-run').hidden = active || !recordedDenial || !recoverable.length;
  $('#recover-run').textContent = `Resume ${recoverable.length} unfinished search${recoverable.length === 1 ? '' : 'es'}`;
  $('#run-status').textContent = statusLabel(run.status);
  const finished = run.tasks.filter(task => !['queued', 'running'].includes(task.status)).length;
  $('#run-count').textContent = `${finished} / ${run.tasks.length}`;
  $('#fare-count').textContent = String(run.tasks.reduce((n, task) => n + task.fares.length, 0));
  $('#run-started').textContent = niceTime(run.startedAt);
  $('#retry-origin').hidden = !run.retryOf;
  $('#retry-origin').textContent = run.retryOf ?
    run.retryOf.recovery ? `Recovery of saved run ${run.retryOf.runId}, ${run.retryOf.taskIds.length} future searches. The original run and evidence are preserved.` :
    run.retryOf.taskIds ? `Batch retry of saved run ${run.retryOf.runId}, ${run.retryOf.taskIds.length} searches. The original evidence is preserved.` :
      `Single-search retry of saved run ${run.retryOf.runId}, search ${run.retryOf.taskId}. The original evidence is preserved.` : '';
  $('#run-resource').hidden = !run.resourceNote;
  $('#run-resource').textContent = run.resourceNote || '';
  const openLogs = new Set([...document.querySelectorAll('.event-toggle[open]')]
    .map(item => item.dataset.taskId));
  $('#task-list').innerHTML = run.tasks.map(task => taskHtml(run, task)).join('');
  for (const item of document.querySelectorAll('.event-toggle'))
    if (openLogs.has(item.dataset.taskId)) item.open = true;
  $('#run-notice').hidden = !run.stopReason;
  $('#run-notice').textContent = run.stopReason ? `Run stopped: ${run.stopReason}. Queued searches were not sent to Akasa.` : '';
  if (!active) { stream?.close(); stream = null; $('#connection').textContent = 'Saved run'; $('#connection').className = 'connection'; }
}

function connect(id) {
  stream?.close();
  stream = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
  stream.addEventListener('snapshot', event => {
    renderRun(JSON.parse(event.data));
    if (['running', 'stopping'].includes(currentRun?.status)) {
      $('#connection').textContent = 'Live updates';
      $('#connection').className = 'connection connected';
    }
  });
  stream.onerror = () => {
    if (['running', 'stopping'].includes(currentRun?.status)) {
      $('#connection').textContent = 'Reconnecting';
      $('#connection').className = 'connection reconnecting';
    }
  };
}

async function api(path, options) {
  const response = await fetch(path, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
  return value;
}

async function refreshRecent(selectedId) {
  const { runs } = await api('/api/runs');
  $('#run-picker').innerHTML = runs.length ? runs.map(run =>
    `<option value="${escapeHtml(run.id)}">${escapeHtml(niceTime(run.startedAt))} · ${escapeHtml(run.routes.join(', '))} · ${escapeHtml(statusLabel(run.status))}</option>`).join('') :
    '<option value="">None yet</option>';
  if (selectedId) $('#run-picker').value = selectedId;
  return runs;
}

$('#run-form').addEventListener('submit', async event => {
  event.preventDefault();
  const plan = validate();
  if (!plan) return;
  $('#start').disabled = true;
  $('#form-error').textContent = '';
  try {
    const { run } = await api('/api/runs', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plan) });
    await refreshRecent(run.id);
    renderRun(run);
    connect(run.id);
    $('#run-board').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { $('#form-error').textContent = error.message; $('#start').disabled = false; }
});
$('#cancel').addEventListener('click', async () => {
  if (!currentRun || currentRun.status !== 'running') return;
  $('#cancel').disabled = true;
  try {
    const { run } = await api(`/api/runs/${currentRun.id}/cancel`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{}' });
    renderRun(run);
  } catch (error) { $('#form-error').textContent = error.message; }
  finally { $('#cancel').disabled = false; }
});
$('#retry-all').addEventListener('click', async () => {
  if (!currentRun || retryPending) return;
  retryPending = true;
  const button = $('#retry-all'); button.disabled = true;
  $('#run-action-error').textContent = '';
  try {
    const { run } = await api(`/api/runs/${encodeURIComponent(currentRun.id)}/retry-failed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    await refreshRecent(run.id); renderRun(run); connect(run.id);
  } catch (error) { $('#run-action-error').textContent = error.message; }
  finally { retryPending = false; button.disabled = false; }
});
$('#recover-run').addEventListener('click', async () => {
  if (!currentRun || retryPending) return;
  const count = currentRun.tasks.filter(task => ['failed', 'partial', 'skipped', 'interrupted', 'blocked'].includes(task.status) &&
    task.travelDate > dateFor(0)).length;
  const warning = `This saved run stopped after Akasa denied access. Resume its ${count} unfinished future searches only if access has since been restored. The original run and evidence will remain saved. If Akasa denies access again, the queue will stop. Continue?`;
  if (!window.confirm(warning)) return;
  retryPending = true;
  const button = $('#recover-run'); button.disabled = true;
  $('#run-action-error').textContent = '';
  try {
    const { run } = await api(`/api/runs/${encodeURIComponent(currentRun.id)}/recover-denied`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessRestored: true })
    });
    await refreshRecent(run.id); renderRun(run); connect(run.id);
  } catch (error) { $('#run-action-error').textContent = error.message; }
  finally { retryPending = false; button.disabled = false; }
});
$('#delete-run').addEventListener('click', () => {
  if (!currentRun || ['running', 'stopping'].includes(currentRun.status)) return;
  $('#delete-confirm').hidden = false;
  $('#confirm-delete').focus();
});
$('#cancel-delete').addEventListener('click', () => {
  $('#delete-confirm').hidden = true; $('#delete-run').focus();
});
$('#confirm-delete').addEventListener('click', async () => {
  if (!currentRun || ['running', 'stopping'].includes(currentRun.status)) return;
  const id = currentRun.id; const button = $('#confirm-delete'); button.disabled = true;
  try {
    await api(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    stream?.close(); stream = null; currentRun = null;
    $('#delete-confirm').hidden = true;
    const runs = await refreshRecent();
    if (runs.length) { const { run } = await api(`/api/runs/${encodeURIComponent(runs[0].id)}`); renderRun(run); }
    else { $('#run-board').hidden = true; $('#empty').hidden = false;
      $('#retry-all').hidden = true; $('#delete-run').hidden = true; $('#cancel').hidden = true; }
    $('#recent-message').textContent = 'Saved run and its evidence deleted.';
    $('#run-picker').focus();
  } catch (error) { $('#recent-message').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#task-list').addEventListener('click', async event => {
  const button = event.target.closest('button[data-retry-task]');
  if (!button || !currentRun || retryPending) return;
  retryPending = true;
  const sourceRunId = currentRun.id;
  const taskId = button.dataset.retryTask;
  const label = button.innerHTML;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Starting search…';
  $('#run-action-error').textContent = '';
  try {
    const { run } = await api(`/api/runs/${encodeURIComponent(sourceRunId)}/retry/${encodeURIComponent(taskId)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    await refreshRecent(run.id);
    renderRun(run);
    connect(run.id);
    $('#run-board').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    $('#run-action-error').textContent = error.message;
    if (button.isConnected) { button.disabled = false; button.removeAttribute('aria-busy'); button.innerHTML = label; }
  } finally { retryPending = false; }
});
$('#routes').addEventListener('input', planSummary);
$('#dates').addEventListener('change', planSummary);
$('#run-picker').addEventListener('change', async event => {
  stream?.close(); stream = null;
  $('#delete-confirm').hidden = true;
  if (!event.target.value) return;
  try {
    const { run } = await api(`/api/runs/${encodeURIComponent(event.target.value)}`);
    renderRun(run);
    if (['running', 'stopping'].includes(run.status)) connect(run.id);
  } catch (error) { $('#form-error').textContent = error.message; }
});
document.querySelectorAll('[data-route]').forEach(button => button.addEventListener('click', () => {
  const route = button.dataset.route;
  const routes = plannedRoutes();
  if (!routes.includes(route)) $('#routes').value = [...routes, route].join('\n');
  planSummary();
}));
renderDates();
planSummary();
try {
  await refreshRecent();
  const { run } = await api('/api/runs/latest');
  if (run) { renderRun(run); if (['running', 'stopping'].includes(run.status)) connect(run.id); }
} catch { $('#connection').textContent = 'Server unavailable'; }
