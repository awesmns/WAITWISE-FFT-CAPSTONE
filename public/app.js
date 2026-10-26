const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CLS = { Low: 'low', Moderate: 'mod', Heavy: 'high' };
const TREND = { increasing: 'Getting busier', steady: 'Holding steady', decreasing: 'Getting quieter' };
const state = { places: [], categories: [], category: 'all', q: '', openId: null };

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ago`;
}
function waitText(s) {
  if (!s.crowd_level) return '';
  const w = Math.max(0, s.estimated_wait);
  return s.crowd_level === 'Heavy' ? `${Math.max(w, 45)}+ min` : `about ${w} min`;
}
function badge(s) {
  if (!s.crowd_level) return '<span class="badge none">No recent reports</span>';
  return `<span class="badge ${CLS[s.crowd_level]}"><span class="dot"></span>${s.crowd_level} - ${waitText(s)}</span>`;
}

// ---------- load + render ----------
async function loadPlaces() {
  const params = new URLSearchParams({ category: state.category, q: state.q });
  state.places = await api('/api/places?' + params);
  renderGrid();
  renderDashboard();
}

function renderChips() {
  const all = [{ category_id: 'all', category_name: 'All' }, ...state.categories];
  $('#chips').innerHTML = all.map((c) =>
    `<button class="chip" data-id="${c.category_id}" aria-pressed="${String(c.category_id) === String(state.category)}">${esc(c.category_name)}</button>`).join('');
}

function renderGrid() {
  const g = $('#grid');
  if (!state.places.length) {
    g.innerHTML = '<p class="empty">No places match. Try another name or choose All.</p>';
    return;
  }
  g.innerHTML = state.places.map((p) => {
    const s = p.status;
    return `<button class="card ${s.crowd_level ? CLS[s.crowd_level] : ''}" data-id="${p.place_id}">
      <h3>${esc(p.name)}</h3>
      <div class="meta">${esc(p.category_name)} - ${esc(p.location)}</div>
      ${badge(s)}
      <div class="tiny">${s.last_updated ? `Last report ${ago(s.last_updated)} - ${s.report_count} in the last hour` : 'Be the first to report when you are there'}</div>
    </button>`;
  }).join('');
}

function renderDashboard() {
  const live = state.places.filter((p) => p.status.crowd_level);
  const lastHour = state.places.reduce((n, p) => n + p.status.report_count, 0);
  const score = { Low: 1, Moderate: 2, Heavy: 3 };
  const quiet = live.filter((p) => p.status.crowd_level !== 'Heavy')
    .sort((a, b) => score[a.status.crowd_level] - score[b.status.crowd_level] || a.status.estimated_wait - b.status.estimated_wait).slice(0, 5);
  const popular = state.places.slice().sort((a, b) => b.total_reports - a.total_reports).slice(0, 5);

  $('#stats').innerHTML = `
    <div class="stat"><b>${state.places.length}</b><span>places tracked</span></div>
    <div class="stat"><b>${live.length}</b><span>with live status</span></div>
    <div class="stat"><b>${lastHour}</b><span>reports in the last hour</span></div>
    <div class="stat"><b>${live.filter((p) => p.status.crowd_level === 'Low').length}</b><span>quiet places right now</span></div>`;

  const li = (p, right) => `<li data-id="${p.place_id}"><div><strong>${esc(p.name)}</strong><small>${esc(p.category_name)}</small></div>${right}</li>`;
  $('#quietList').innerHTML = quiet.length
    ? quiet.map((p) => li(p, badge(p.status))).join('')
    : '<li class="empty">No quiet places reported right now.</li>';
  $('#popularList').innerHTML = popular.length
    ? popular.map((p) => li(p, `<small>${p.total_reports} reports</small>`)).join('')
    : '<li class="empty">No reports yet.</li>';
}

// ---------- place detail dialog ----------
function boardHtml(s) {
  return s.crowd_level
    ? `<div id="liveBoard" class="status-board ${CLS[s.crowd_level]}">
         <div class="level">${s.crowd_level} crowd</div>
         <div class="wait">Estimated wait: ${waitText(s)}</div>
         <div class="sub">${TREND[s.trend]} - last report ${ago(s.last_updated)} - based on ${s.report_count} report${s.report_count === 1 ? '' : 's'} in the last hour</div>
       </div>`
    : `<div id="liveBoard" class="status-board"><div class="level">No recent reports</div>
         <div class="sub">Nobody has reported in the last hour. If you are there now, add the first report below.</div></div>`;
}
function recentHtml(list) {
  return '<h3>Reports in the last hour</h3>' + (list.length
    ? `<ul class="recent">${list.slice(0, 6).map((r) =>
        `<li><span class="badge ${CLS[r.crowd_level]}"><span class="dot"></span>${r.crowd_level}${r.wait_minutes != null ? ' - ' + r.wait_minutes + ' min' : ''}</span><small>${ago(r.reported_at)}</small></li>`).join('')}</ul>`
    : '<p class="empty">No reports in the last hour.</p>');
}
// update only the live parts of an open dialog so a half-filled report form is never wiped
async function refreshOpenPlace() {
  if (!$('#placeModal').open || !$('#liveBoard')) return;
  const d = await api('/api/places/' + state.openId);
  $('#liveBoard').outerHTML = boardHtml(d.place.status);
  $('#liveRecent').innerHTML = recentHtml(d.recent_reports);
}

async function openPlace(id) {
  state.openId = id;
  const d = await api('/api/places/' + id);
  const p = d.place, s = p.status;
  const nowH = new Date().getHours();

  const board = boardHtml(s);

  const bars = d.pattern.map((h) => {
    const c = h.avg === null ? '' : h.avg < 1.67 ? 'low' : h.avg < 2.34 ? 'mod' : 'high';
    const ht = h.avg === null ? 4 : Math.round((h.avg / 3) * 100);
    return `<div class="bar ${c} ${h.hour === nowH ? 'now' : ''}" style="height:${ht}%" title="${h.hour}:00 - ${h.avg === null ? 'no data' : h.avg.toFixed(1) + ' / 3'}"></div>`;
  }).join('');
  const axis = d.pattern.map((h) => `<span>${h.hour % 3 === 0 ? h.hour : ''}</span>`).join('');
  const best = d.best_time
    ? `Usually quietest around <strong>${fmtHour(d.best_time.hour)}</strong> while open (${esc(p.opening_hours)}).`
    : 'Not enough history yet to suggest a quiet time.';

  const pop = d.popular;
  const popBars = pop.hours.map((v, h) =>
    `<div class="bar ${v < 34 ? 'low' : v < 67 ? 'mod' : 'high'} ${h === nowH ? 'now' : ''}" style="height:${Math.max(4, v)}%" title="${fmtHour(h)} - ${v}% busy"></div>`).join('');
  const popNote = pop.source === 'besttime'
    ? 'Typical busyness for today from BestTime popular-times data.'
    : 'Estimate for this type of place. Real popular times can be added by an admin; community reports improve the status above.';
  const popBest = pop.best_hour != null ? `Typically quietest around <strong>${fmtHour(pop.best_hour)}</strong> while open.` : '';

  const recent = recentHtml(d.recent_reports);

  $('#modalBody').innerHTML = `
    <div class="m-head">
      <div><h2 id="mTitle">${esc(p.name)}</h2><p>${esc(p.category_name)} - ${esc(p.location)} - Open ${esc(p.opening_hours)}</p></div>
      <button class="close" id="closeModal" aria-label="Close">&times;</button>
    </div>
    <div class="m-body">
      ${board}
      <div class="box">
        <h3>Are you here? Report the crowd</h3>
        <form id="reportForm">
          <div class="picker" role="radiogroup" aria-label="Crowd level">
            <input type="radio" name="level" id="lv1" value="Low"><label class="low" for="lv1">Low</label>
            <input type="radio" name="level" id="lv2" value="Moderate"><label class="mod" for="lv2">Moderate</label>
            <input type="radio" name="level" id="lv3" value="Heavy"><label class="high" for="lv3">Heavy</label>
          </div>
          <div class="field"><label for="wait">Waiting time in minutes (optional)</label>
            <input id="wait" type="number" min="0" max="300" inputmode="numeric" placeholder="e.g. 15"></div>
          <button class="btn" type="submit">Send anonymous report</button>
          <p class="msg" id="reportMsg" role="status"></p>
        </form>
      </div>
      <div class="box">
        <h3>Typical busyness today</h3>
        <p class="tiny" id="liveExtra"></p>
        <div class="chart">${popBars}</div>
        <div class="axis">${axis}</div>
        <p class="best">${popBest}</p>
        <p class="tiny">${popNote}</p>
      </div>
      <div class="box">
        <h3>Crowd by time of day (community reports)</h3>
        <div class="chart">${bars}</div>
        <div class="axis">${axis}</div>
        <p class="best">${best}</p>
      </div>
      <div class="box" id="liveRecent">${recent}</div>
    </div>`;

  const dlg = $('#placeModal');
  if (!dlg.open) dlg.showModal();

  if (p.has_popular) {          // live busyness from BestTime, fetched after the dialog is shown
    api(`/api/places/${id}/live`).then((l) => {
      const el = $('#liveExtra');
      if (el && l.available && l.live != null && state.openId === id) el.innerHTML = `Right now: <strong>${l.live}%</strong> busy (usual for this hour: ${l.forecasted}%).`;
    }).catch(() => {});
  }
}
const fmtHour = (h) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'AM' : 'PM'}`;

async function submitReport(e) {
  e.preventDefault();
  const level = document.querySelector('input[name="level"]:checked');
  const msg = $('#reportMsg');
  msg.className = 'msg';
  if (!level) { msg.textContent = 'Choose Low, Moderate or Heavy first.'; msg.classList.add('err'); return; }
  try {
    await api(`/api/places/${state.openId}/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ crowd_level: level.value, wait_minutes: $('#wait').value })
    });
    await loadPlaces();
    await openPlace(state.openId);
    const m2 = $('#reportMsg');
    m2.textContent = 'Report sent. Thanks for helping others.';
    m2.className = 'msg ok';
  } catch (err) {
    msg.textContent = err.message;
    msg.classList.add('err');
  }
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) { state.category = chip.dataset.id; renderChips(); loadPlaces(); return; }
  const item = e.target.closest('[data-id].card, .ranked li[data-id]');
  if (item) { openPlace(item.dataset.id); return; }
  if (e.target.closest('#closeModal') || e.target === $('#placeModal')) $('#placeModal').close();
});
document.addEventListener('submit', (e) => { if (e.target.id === 'reportForm') submitReport(e); });
$('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); $('#places').scrollIntoView(); });
let t;
$('#q').addEventListener('input', (e) => {
  clearTimeout(t);
  t = setTimeout(() => { state.q = e.target.value; loadPlaces(); }, 200);
});

// ---------- real-time updates (Server-Sent Events) ----------
function setLive(on) {
  const el = $('#liveStatus');
  if (!el) return;
  el.classList.toggle('on', on);
  el.querySelector('span:last-child').textContent = on ? 'Live' : 'Reconnecting...';
}
let liveTimer;
function connectLive() {
  if (!window.EventSource) return;
  const es = new EventSource('/api/stream');
  es.addEventListener('hello', () => setLive(true));
  es.onerror = () => setLive(false);   // the browser reconnects by itself
  const onChange = (e) => {
    const msg = JSON.parse(e.data);
    clearTimeout(liveTimer);           // bursts of reports trigger one refresh
    liveTimer = setTimeout(() => {
      loadPlaces().catch(() => {});
      if (e.type === 'places' && msg.action === 'deleted' && String(msg.place_id) === String(state.openId)) $('#placeModal').close();
      else if (!msg.place_id || String(msg.place_id) === String(state.openId)) refreshOpenPlace().catch(() => {});
    }, 250);
  };
  es.addEventListener('report', onChange);
  es.addEventListener('places', onChange);
}

(async function init() {
  state.categories = await api('/api/categories');
  renderChips();
  await loadPlaces();
  connectLive();
  setInterval(() => { loadPlaces().catch(() => {}); refreshOpenPlace().catch(() => {}); }, 60000);   // safety net + ages out expired reports
})().catch((err) => { $('#grid').innerHTML = `<p class="empty">${esc(err.message)}</p>`; });
