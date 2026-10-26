const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let token = sessionStorage.getItem('ww_token');
let places = [], categories = [], reportsFor = null;

async function api(url, opts = {}) {
  opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { logout(); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

function show(loggedIn) {
  $('#loginView').hidden = loggedIn;
  $('#adminView').hidden = !loggedIn;
  $('#logout').hidden = !loggedIn;
}
function logout() {
  token = null;
  sessionStorage.removeItem('ww_token');
  show(false);
}

async function refresh() {
  categories = await api('/api/categories');
  places = await api('/api/places');
  $('#pCat').innerHTML = categories.map((c) => `<option value="${c.category_id}">${esc(c.category_name)}</option>`).join('');
  $('#placeRows').innerHTML = places.map((p) => `
    <tr>
      <td><strong>${esc(p.name)}</strong><br><small>${esc(p.location)}</small></td>
      <td>${esc(p.category_name)}</td>
      <td>${esc(p.opening_hours)}</td>
      <td>${p.total_reports}</td>
      <td class="row-actions">
        <button class="btn ghost small" data-act="reports" data-id="${p.place_id}">Reports</button>
        <button class="btn ghost small" data-act="edit" data-id="${p.place_id}">Edit</button>
        <button class="btn danger small" data-act="delete" data-id="${p.place_id}">Remove</button>
      </td>
    </tr>`).join('');
  if (reportsFor) await loadReports(reportsFor);
}

async function loadReports(placeId) {
  reportsFor = placeId;
  const place = places.find((p) => p.place_id === placeId);
  if (!place) { $('#reportsBox').hidden = true; return; }
  const list = await api('/api/admin/reports/' + placeId);
  $('#reportsBox').hidden = false;
  $('#reportsTitle').textContent = `Latest reports for ${place.name}`;
  $('#reportRows').innerHTML = list.length
    ? list.map((r) => `
      <tr>
        <td>${new Date(r.reported_at).toLocaleString()}</td>
        <td>${r.crowd_level}</td>
        <td>${r.wait_minutes != null ? r.wait_minutes + ' min' : '-'}</td>
        <td><small>${esc(r.device_hash)}</small></td>
        <td><button class="btn danger small" data-act="del-report" data-id="${r.report_id}">Remove report</button></td>
      </tr>`).join('')
    : '<tr><td colspan="5">No reports for this place.</td></tr>';
}

function resetForm() {
  $('#placeForm').reset();
  $('#placeId').value = '';
  $('#formTitle').textContent = 'Add a place';
  $('#saveBtn').textContent = 'Add place';
  $('#cancelEdit').hidden = true;
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#loginMsg');
  msg.className = 'msg';
  try {
    const d = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ email: $('#email').value, password: $('#password').value }) });
    token = d.token;
    sessionStorage.setItem('ww_token', token);
    show(true);
    await refresh();
  } catch (err) { msg.textContent = err.message; msg.classList.add('err'); }
});

$('#placeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#formMsg');
  msg.className = 'msg';
  const id = $('#placeId').value;
  const body = JSON.stringify({ name: $('#pName').value, category_id: $('#pCat').value, location: $('#pLoc').value, opening_hours: $('#pHours').value });
  try {
    await api(id ? '/api/places/' + id : '/api/places', { method: id ? 'PUT' : 'POST', body });
    msg.textContent = id ? 'Place updated.' : 'Place added.';
    msg.classList.add('ok');
    resetForm();
    await refresh();
  } catch (err) { msg.textContent = err.message; msg.classList.add('err'); }
});

$('#cancelEdit').addEventListener('click', resetForm);
$('#logout').addEventListener('click', (e) => { e.preventDefault(); logout(); });

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = Number(b.dataset.id);
  try {
    if (b.dataset.act === 'edit') {
      const p = places.find((x) => x.place_id === id);
      $('#placeId').value = id;
      $('#pName').value = p.name; $('#pCat').value = p.category_id; $('#pLoc').value = p.location; $('#pHours').value = p.opening_hours;
      $('#formTitle').textContent = 'Edit place';
      $('#saveBtn').textContent = 'Save changes';
      $('#cancelEdit').hidden = false;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (b.dataset.act === 'delete') {
      if (!confirm('Remove this place and all of its reports?')) return;
      await api('/api/places/' + id, { method: 'DELETE' });
      if (reportsFor === id) { reportsFor = null; $('#reportsBox').hidden = true; }
      await refresh();
    } else if (b.dataset.act === 'reports') {
      await loadReports(id);
    } else if (b.dataset.act === 'del-report') {
      await api('/api/reports/' + id, { method: 'DELETE' });
      await refresh();
    }
  } catch (err) { alert(err.message); }
});

if (token) { show(true); refresh().catch(logout); } else show(false);
