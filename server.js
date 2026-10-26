const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { base, generateReports, sha256, DB_FILE } = require('./seed');
const providers = require('./providers');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'waitwise-dev-secret-change-me';
const WINDOW_MIN = 60;                                   // reports older than this are ignored
const SPAM_MIN = Number(process.env.SPAM_MIN || 5);      // one report per device per place in this many minutes
const SCORE = { Low: 1, Moderate: 2, Heavy: 3 };
const DEFAULT_WAIT = { Low: 5, Moderate: 20, Heavy: 45 };
const LEVELS = Object.keys(SCORE);

// ---------- JSON file storage ----------
function ensureDb() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(base(), null, 2));
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!db.reports || db.reports.length === 0) {         // first run: fill with demo reports
    db.reports = generateReports(db.places);
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }
}
const load = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const save = (db) => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const nextId = (arr, key) => arr.reduce((m, x) => Math.max(m, x[key]), 0) + 1;

// ---------- Crowd trend calculation ----------
function computeStatus(placeId, reports, now = Date.now()) {
  const recent = reports.filter((r) => r.place_id === placeId && now - new Date(r.reported_at) <= WINDOW_MIN * 60000);
  if (!recent.length) {
    return { place_id: placeId, crowd_level: null, estimated_wait: null, trend: null, last_updated: null, report_count: 0 };
  }
  let sumW = 0, sumScore = 0, sumWait = 0, latest = 0;
  recent.forEach((r) => {
    const age = (now - new Date(r.reported_at)) / 60000;
    const w = Math.max(0.1, 1 - age / WINDOW_MIN);       // newer reports weigh more
    sumW += w;
    sumScore += w * SCORE[r.crowd_level];
    sumWait += w * (r.wait_minutes != null ? r.wait_minutes : DEFAULT_WAIT[r.crowd_level]);
    latest = Math.max(latest, new Date(r.reported_at).getTime());
  });
  const avg = sumScore / sumW;
  const crowd_level = avg < 1.67 ? 'Low' : avg < 2.34 ? 'Moderate' : 'Heavy';

  // trend: last 20 minutes vs the 40 minutes before that
  const mean = (list) => list.reduce((s, r) => s + SCORE[r.crowd_level], 0) / list.length;
  const newer = recent.filter((r) => now - new Date(r.reported_at) <= 20 * 60000);
  const older = recent.filter((r) => now - new Date(r.reported_at) > 20 * 60000);
  let trend = 'steady';
  if (newer.length && older.length) {
    const d = mean(newer) - mean(older);
    trend = d > 0.4 ? 'increasing' : d < -0.4 ? 'decreasing' : 'steady';
  }
  return {
    place_id: placeId, crowd_level, estimated_wait: Math.round(sumWait / sumW), trend,
    last_updated: new Date(latest).toISOString(), report_count: recent.length
  };
}

// average crowd score by hour of day, from every stored report
function hourlyPattern(placeId, reports) {
  const b = Array.from({ length: 24 }, () => ({ s: 0, n: 0 }));
  reports.filter((r) => r.place_id === placeId).forEach((r) => {
    const h = new Date(r.reported_at).getHours();
    b[h].s += SCORE[r.crowd_level];
    b[h].n++;
  });
  return b.map((x, hour) => ({ hour, avg: x.n ? +(x.s / x.n).toFixed(2) : null, count: x.n }));
}

function bestTime(place, pattern) {
  const m = /(\d{1,2}):\d{2}\s*-\s*(\d{1,2}):\d{2}/.exec(place.opening_hours || '');
  const open = m ? +m[1] : 0, close = m ? +m[2] : 24;
  const c = pattern.filter((p) => p.avg !== null && p.count >= 2 && p.hour >= open && p.hour < close);
  if (!c.length) return null;
  return c.slice().sort((a, b) => a.avg - b.avg)[0];
}

// typical busyness for today by hour: BestTime data when saved, otherwise a labelled category estimate
function popularFor(place, db) {
  const today = new Date().getDay();
  const cat = db.categories.find((c) => c.category_id === place.category_id);
  const real = place.popular_times && place.popular_times.by_day && place.popular_times.by_day[today];
  const hours = real || providers.estimateHours(cat ? cat.category_name : '');
  const m = /(\d{1,2}):\d{2}\s*-\s*(\d{1,2}):\d{2}/.exec(place.opening_hours || '');
  const open = m ? +m[1] : 0, close = m ? +m[2] : 24;
  const cand = hours.map((v, hour) => ({ hour, v })).filter((x) => x.hour >= open && x.hour < close);
  const best = cand.length ? cand.sort((a, b) => a.v - b.v)[0].hour : null;
  return { source: real ? 'besttime' : 'estimate', hours, best_hour: best };
}

function decorate(p, db) {
  const cat = db.categories.find((c) => c.category_id === p.category_id);
  const { popular_times, ...rest } = p;
  return {
    ...rest,
    has_popular: !!popular_times,
    category_name: cat ? cat.category_name : '',
    status: computeStatus(p.place_id, db.reports),
    total_reports: db.reports.filter((r) => r.place_id === p.place_id).length
  };
}

// ---------- App ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const auth = (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try { req.admin = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Please log in as admin.' }); }
};

// ---------- Real-time updates (Server-Sent Events) ----------
const clients = new Set();
let eventId = 0;
function broadcast(type, data) {
  const msg = `id: ${++eventId}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ clients: clients.size + 1 })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

app.get('/api/categories', (req, res) => res.json(load().categories));

app.get('/api/places', (req, res) => {
  const db = load();
  const q = (req.query.q || '').toLowerCase().trim();
  const cat = req.query.category;
  const list = db.places.filter((p) =>
    (!q || p.name.toLowerCase().includes(q) || p.location.toLowerCase().includes(q)) &&
    (!cat || cat === 'all' || p.category_id === Number(cat)));
  res.json(list.map((p) => decorate(p, db)));
});

app.get('/api/places/:id', (req, res) => {
  const db = load();
  const place = db.places.find((p) => p.place_id === Number(req.params.id));
  if (!place) return res.status(404).json({ error: 'Place not found.' });
  const pattern = hourlyPattern(place.place_id, db.reports);
  const now = Date.now();
  const recent = db.reports
    .filter((r) => r.place_id === place.place_id && now - new Date(r.reported_at) <= WINDOW_MIN * 60000)
    .sort((a, b) => new Date(b.reported_at) - new Date(a.reported_at))
    .map(({ report_id, crowd_level, wait_minutes, reported_at }) => ({ report_id, crowd_level, wait_minutes, reported_at }));
  res.json({ place: decorate(place, db), pattern, best_time: bestTime(place, pattern), recent_reports: recent, popular: popularFor(place, db) });
});

// Anonymous report with simple spam control (hashed device id)
app.post('/api/places/:id/reports', (req, res) => {
  const db = load();
  const place = db.places.find((p) => p.place_id === Number(req.params.id));
  if (!place) return res.status(404).json({ error: 'Place not found.' });

  const { crowd_level } = req.body;
  let { wait_minutes } = req.body;
  if (!LEVELS.includes(crowd_level)) return res.status(400).json({ error: 'Choose Low, Moderate or Heavy.' });
  if (wait_minutes === '' || wait_minutes === undefined || wait_minutes === null) wait_minutes = null;
  else {
    wait_minutes = Number(wait_minutes);
    if (!Number.isFinite(wait_minutes) || wait_minutes < 0 || wait_minutes > 300) {
      return res.status(400).json({ error: 'Waiting time must be between 0 and 300 minutes.' });
    }
    wait_minutes = Math.round(wait_minutes);
  }

  const device_hash = sha256((req.ip || '') + (req.headers['user-agent'] || '')).slice(0, 16);
  const now = Date.now();
  const last = db.reports
    .filter((r) => r.place_id === place.place_id && r.device_hash === device_hash)
    .reduce((m, r) => Math.max(m, new Date(r.reported_at).getTime()), 0);
  if (now - last < SPAM_MIN * 60000) {
    const left = Math.ceil((SPAM_MIN * 60000 - (now - last)) / 60000);
    return res.status(429).json({ error: `You already reported this place. Try again in ${left} min.` });
  }

  db.reports.push({
    report_id: nextId(db.reports, 'report_id'), place_id: place.place_id, crowd_level, wait_minutes,
    device_hash, reported_at: new Date(now).toISOString()
  });
  save(db);
  const status = computeStatus(place.place_id, db.reports);
  broadcast('report', { place_id: place.place_id, status });
  res.status(201).json({ ok: true, status });
});

// ---------- Real places + popular times (free OpenStreetMap, BestTime forecasts) ----------
app.get('/api/config', (req, res) => res.json({ besttime: providers.hasBestTime() }));

app.get('/api/admin/discover', auth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.status(400).json({ error: 'Type at least 3 characters, for example "cafe in Bengaluru".' });
  try {
    const list = await providers.searchPlaces(q);
    const db = load();
    res.json(list.map((r) => ({ ...r, already_added: db.places.some((p) => p.osm_id === r.osm_id) })));
  } catch (err) { res.status(502).json({ error: 'Place search failed: ' + err.message }); }
});

app.post('/api/admin/import', auth, (req, res) => {
  const db = load();
  const b = req.body || {};
  if (b.osm_id && db.places.some((p) => p.osm_id === b.osm_id)) return res.status(409).json({ error: 'That place is already added.' });
  const cat = db.categories.find((c) => c.category_name === b.category_name) || db.categories[db.categories.length - 1];
  const f = { name: String(b.name || '').trim(), category_id: cat.category_id, location: String(b.address || '').trim().slice(0, 200), opening_hours: String(b.opening_hours || '').trim() };
  if (!validPlace(f, db)) return res.status(400).json({ error: PLACE_ERR });
  const place = { place_id: nextId(db.places, 'place_id'), ...f, osm_id: b.osm_id || null, lat: Number(b.lat) || null, lon: Number(b.lon) || null, admin_id: req.admin.admin_id, created_at: new Date().toISOString() };
  db.places.push(place);
  save(db);
  broadcast('places', { action: 'created', place_id: place.place_id });
  res.status(201).json(place);
});

// fetch the weekly popular-times forecast once and store it (uses BestTime credits)
app.post('/api/admin/places/:id/popular-times', auth, async (req, res) => {
  const place = load().places.find((p) => p.place_id === Number(req.params.id));
  if (!place) return res.status(404).json({ error: 'Place not found.' });
  try {
    const f = await providers.forecastVenue(place.name, place.location);
    const db = load();                                   // reload: the file may have changed during the request
    const p = db.places.find((x) => x.place_id === place.place_id);
    if (!p) return res.status(404).json({ error: 'Place not found.' });
    p.popular_times = { venue_id: f.venue_id, by_day: f.by_day, fetched_at: new Date().toISOString() };
    save(db);
    broadcast('places', { action: 'updated', place_id: p.place_id });
    res.json({ ok: true });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// live busyness right now (BestTime), cached 15 minutes per place to save credits
const liveCache = new Map();
app.get('/api/places/:id/live', async (req, res) => {
  const place = load().places.find((p) => p.place_id === Number(req.params.id));
  const venueId = place && place.popular_times && place.popular_times.venue_id;
  if (!venueId || !providers.hasBestTime()) return res.json({ available: false });
  const hit = liveCache.get(place.place_id);
  if (hit && Date.now() - hit.at < 15 * 60000) return res.json(hit.data);
  try {
    const data = await providers.liveNow(venueId);
    liveCache.set(place.place_id, { at: Date.now(), data });
    res.json(data);
  } catch { res.json({ available: false }); }
});

// ---------- Admin (JWT) ----------
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  const admin = load().admins.find((a) => a.email === email && a.password === sha256(password || ''));
  if (!admin) return res.status(401).json({ error: 'Wrong email or password.' });
  const token = jwt.sign({ admin_id: admin.admin_id, name: admin.name }, JWT_SECRET, { expiresIn: '4h' });
  res.json({ token, name: admin.name });
});

const placeFields = (b) => ({
  name: String(b.name || '').trim(),
  category_id: Number(b.category_id),
  location: String(b.location || '').trim(),
  opening_hours: String(b.opening_hours || '').trim()
});
const validPlace = (f, db) =>
  f.name && f.location && /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(f.opening_hours) &&
  db.categories.some((c) => c.category_id === f.category_id);
const PLACE_ERR = 'Fill in all fields. Opening hours look like 09:00 - 18:00.';

app.post('/api/places', auth, (req, res) => {
  const db = load();
  const f = placeFields(req.body);
  if (!validPlace(f, db)) return res.status(400).json({ error: PLACE_ERR });
  const place = { place_id: nextId(db.places, 'place_id'), ...f, admin_id: req.admin.admin_id, created_at: new Date().toISOString() };
  db.places.push(place);
  save(db);
  broadcast('places', { action: 'created', place_id: place.place_id });
  res.status(201).json(place);
});

app.put('/api/places/:id', auth, (req, res) => {
  const db = load();
  const place = db.places.find((p) => p.place_id === Number(req.params.id));
  if (!place) return res.status(404).json({ error: 'Place not found.' });
  const f = placeFields(req.body);
  if (!validPlace(f, db)) return res.status(400).json({ error: PLACE_ERR });
  Object.assign(place, f);
  save(db);
  broadcast('places', { action: 'updated', place_id: place.place_id });
  res.json(place);
});

app.delete('/api/places/:id', auth, (req, res) => {
  const db = load();
  const id = Number(req.params.id);
  if (!db.places.some((p) => p.place_id === id)) return res.status(404).json({ error: 'Place not found.' });
  db.places = db.places.filter((p) => p.place_id !== id);
  db.reports = db.reports.filter((r) => r.place_id !== id);
  save(db);
  broadcast('places', { action: 'deleted', place_id: id });
  res.json({ ok: true });
});

app.get('/api/admin/reports/:placeId', auth, (req, res) => {
  const list = load().reports
    .filter((r) => r.place_id === Number(req.params.placeId))
    .sort((a, b) => new Date(b.reported_at) - new Date(a.reported_at))
    .slice(0, 30);
  res.json(list);
});

app.delete('/api/reports/:id', auth, (req, res) => {
  const db = load();
  const removed = db.reports.find((r) => r.report_id === Number(req.params.id));
  if (!removed) return res.status(404).json({ error: 'Report not found.' });
  db.reports = db.reports.filter((r) => r !== removed);
  save(db);
  broadcast('report', { place_id: removed.place_id, status: computeStatus(removed.place_id, db.reports) });
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

ensureDb();
app.listen(PORT, () => console.log(`WaitWise running at http://localhost:${PORT}`));
