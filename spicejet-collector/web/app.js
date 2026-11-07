const $ = s => document.querySelector(s);
const safe = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const labels = { ok:'Verified fares', empty:'No flights available', failed:'Failed', blocked:'Access blocked', queued:'Queued', running:'Searching', interrupted:'Interrupted', skipped:'Skipped' };
const stages = { browser_ready:'Browser ready', homepage_loaded:'Booking page loaded', form_confirmed:'Route and date confirmed', search_submitted:'Waiting for airline results', evidence_verified:'Evidence verified', retry_wait:'Waiting before one retry' };
const presets = ['DEL-BOM','DEL-BLR','BOM-MAA','DEL-HYD','BLR-CCU','BLR-PNQ','BOM-BLR','DEL-CCU','DEL-MAA'];
$('#offsets').innerHTML = [1,5,9,15,30,45].map(n => `<label><input type="checkbox" value="${n}" checked>+${n}</label>`).join('');
$('#presets').onclick = () => { $('#routes').value = presets.join('\n'); };
let lastRender = '', latestStatus = '';
async function api(url, options) { const r = await fetch(url, options); const d = await r.json(); if (!r.ok) throw Error(d.error || 'Request failed'); return d; }
async function history(selected = $('#history').value) {
  const { runs } = await api('/api/runs');
  $('#history').innerHTML = '<option value="">Latest run</option>' + runs.map(r => `<option value="${safe(r.id)}">${safe(r.id.slice(0,19).replace('T',' '))} · ${safe(r.status)} · ${r.count} searches</option>`).join('');
  $('#history').value = selected;
}
async function refresh() {
  try {
    const selected = $('#history').value;
    const { run:j } = await api('/api/run' + (selected ? '?id=' + encodeURIComponent(selected) : ''));
    if (!j) return;
    const verified = j.tasks.filter(t => ['ok','empty'].includes(t.status)).length;
    $('#status').textContent = `${j.status} · ${verified}/${j.tasks.length} searches checked · ${j.tasks.filter(t => t.status === 'empty').length} with no flights`;
    const latest = selected ? (await api('/api/run')).run : j;
    const busy = ['running','stopping'].includes(latest?.status);
    $('#start').disabled = busy; $('#stop').hidden = !busy;
    if (j.status !== latestStatus) { latestStatus = j.status; await history(selected); }
    const content = JSON.stringify(j);
    if (content === lastRender) return;
    lastRender = content;
    $('#tasks').innerHTML = j.tasks.map(t => `<article class="task"><div class="task-heading"><div><div class="route">${safe(t.query.origin)} → ${safe(t.query.destination)}</div><small>${safe(t.query.travelDate)}</small>${t.stage ? `<small>${safe(stages[t.stage] || t.stage)}</small>` : ''}</div><span class="badge ${safe(t.status)}">${safe(labels[t.status] || t.status)}</span></div>${t.cause ? `<p class="bad">${safe(t.cause.code)}${t.cause.detail ? ': ' + safe(t.cause.detail) : ''}</p>` : ''}${t.status === 'empty' ? '<p>SpiceJet returned no flights and displayed the same result.</p>' : ''}${t.fares?.length ? `<div class="table-wrap"><table><tr><th>Flight</th><th>Departure</th><th>Arrival</th><th>Starting fare</th></tr>${t.fares.map(f => `<tr><td>${safe(f.flight)}</td><td>${safe(f.departureTime)}${f.scheduleDifference ? `<small>Revised from ${safe(f.airlineDepartureTime)}</small>` : ''}</td><td>${safe(f.arrivalTime)}${f.scheduleDifference ? `<small>Revised from ${safe(f.airlineArrivalTime)}</small>` : ''}</td><td><details><summary>₹${safe(f.amount.toLocaleString('en-IN'))}</summary><div>${f.charges.map(c => `<small>${safe(c.code || (c.type === 0 ? 'Base fare' : 'Tax'))}: ₹${safe(c.amount)}</small>`).join('')}</div></details></td></tr>`).join('')}</table></div>` : ''}${t.attempts?.length > 1 ? `<details><summary>${t.attempts.length} recorded attempts</summary>${t.attempts.map(a => `<p>${a.attempt}: ${safe(a.status)} ${safe(a.cause?.code || '')} ${a.runId ? `<a href="/evidence/${encodeURIComponent(a.runId)}/result.json">Saved attempt</a>` : ''}</p>`).join('')}</details>` : ''}${t.runId ? `<div class="evidence"><a href="/evidence/${encodeURIComponent(t.runId)}/result.json">Saved result</a>${['ok','empty'].includes(t.status) ? `<a href="/evidence/${encodeURIComponent(t.runId)}/results.png">Screenshot</a><a href="/evidence/${encodeURIComponent(t.runId)}/availability.json">Airline response</a>` : ''}</div>` : ''}</article>`).join('');
  } catch (e) { $('#error').textContent = e.message; }
}
function searchPlan() {
  const exact = $('#searches').value.trim();
  if (exact) return exact.split('\n').map(s => s.trim().toUpperCase()).filter(Boolean);
  const routes = $('#routes').value.trim().toUpperCase().split(/[\s,]+/).filter(Boolean);
  const offsets = [...$('#offsets').querySelectorAll('input:checked')].map(e => Number(e.value));
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date());
  const part = name => parts.find(p => p.type === name).value;
  const today = `${part('year')}-${part('month')}-${part('day')}`;
  return routes.flatMap(route => offsets.map(n => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return route.replace('-', ':') + ':' + d.toISOString().slice(0,10); }));
}
$('#start').onclick = async () => {
  try { $('#error').textContent = ''; await api('/api/run', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ searches:searchPlan(), mode:$('#mode').value }) }); await history(''); lastRender = ''; await refresh(); }
  catch (e) { $('#error').textContent = e.message; }
};
$('#stop').onclick = async () => { try { await api('/api/stop', { method:'POST', headers:{ 'content-type':'application/json' }, body:'{}' }); await refresh(); } catch (e) { $('#error').textContent = e.message; } };
$('#history').onchange = () => { lastRender = ''; refresh(); };
await history(); await refresh(); setInterval(refresh, 2500);
