// External data sources: OpenStreetMap (real places, free, no key) and BestTime (popular times).
const UA = 'WaitWise/1.0 (student project)';
const btKey = () => process.env.BESTTIME_API_KEY_PRIVATE || '';
const hasBestTime = () => !!btKey();

async function getJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    const msg = data && (data.message || data.error) ? (data.message || data.error) : text.slice(0, 160);
    throw new Error(`${new URL(url).hostname} answered ${res.status}: ${msg}`);
  }
  return data;
}

// ---------- OpenStreetMap (Nominatim) ----------
function guessCategory(cls, type) {
  const t = `${cls}:${type}`;
  if (/amenity:(cafe|restaurant|fast_food|food_court|canteen|ice_cream|bar|pub)/.test(t)) return 'Canteen';
  if (/amenity:(clinic|hospital|doctors|dentist|pharmacy)|healthcare/.test(t)) return 'Clinic';
  if (/leisure:(fitness_centre|sports_centre|fitness_station)/.test(t)) return 'Gym';
  if (/shop:(hairdresser|beauty|barber)|amenity:(spa)/.test(t)) return 'Salon';
  if (/office:government|amenity:(townhall|courthouse|post_office|police)/.test(t)) return 'Government Office';
  if (/amenity:(college|university|school)/.test(t)) return 'College Office';
  return 'Local Store';
}
function parseHours(oh) {
  const m = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/.exec(oh || '');
  return m ? `${m[1].padStart(5, '0')} - ${m[2].padStart(5, '0')}` : '09:00 - 21:00';
}

async function searchPlaces(q) {
  const params = new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', extratags: '1', limit: '15' });
  const rows = await getJson('https://nominatim.openstreetmap.org/search?' + params);
  return rows
    .filter((r) => r.name)
    .map((r) => ({
      osm_id: `${r.osm_type}${r.osm_id}`,
      name: r.name,
      address: r.display_name,
      lat: Number(r.lat),
      lon: Number(r.lon),
      category_name: guessCategory(r.category, r.type),
      opening_hours: parseHours(r.extratags && r.extratags.opening_hours)
    }));
}

// ---------- BestTime ----------
function needKey() {
  if (!hasBestTime()) throw new Error('BestTime key not set. Start the server with BESTTIME_API_KEY_PRIVATE set.');
}
function btCheck(d) {
  if (!d || d.status !== 'OK') throw new Error('BestTime: ' + ((d && d.message) || 'could not forecast this place.'));
}

// returns { venue_id, by_day } where by_day[0] is Sunday (JS getDay) and each day has 24 values 0-100
async function forecastVenue(name, address) {
  needKey();
  const params = new URLSearchParams({ api_key_private: btKey(), venue_name: name, venue_address: address });
  const d = await getJson('https://besttime.app/api/v1/forecasts?' + params, { method: 'POST' });
  btCheck(d);
  const by_day = Array.from({ length: 7 }, () => null);
  (d.analysis || []).forEach((day) => {
    const js = (Number(day.day_info && day.day_info.day_int) + 1) % 7;   // BestTime: 0 = Monday
    const hours = Array(24).fill(0);
    if (Array.isArray(day.day_raw) && day.day_raw.length === 24) {
      day.day_raw.forEach((v, i) => { hours[(i + 6) % 24] = Math.max(0, Math.min(100, Number(v) || 0)); }); // list starts at 06:00
    } else if (Array.isArray(day.hour_analysis)) {
      day.hour_analysis.forEach((h) => { if (h.intensity_nr >= -2 && h.intensity_nr <= 2) hours[h.hour] = (h.intensity_nr + 2) * 25; });
    }
    by_day[js] = hours;
  });
  const venue_id = d.venue_info && d.venue_info.venue_id;
  if (!venue_id || by_day.some((x) => !x)) throw new Error('BestTime: the forecast came back incomplete for this place.');
  return { venue_id, by_day };
}

async function liveNow(venueId) {
  needKey();
  const params = new URLSearchParams({ api_key_private: btKey(), venue_id: venueId });
  let d;
  try { d = await getJson('https://besttime.app/api/v1/forecasts/now?' + params); }
  catch { d = await getJson('https://besttime.app/api/v1/forecasts/now?' + params, { method: 'POST' }); }
  btCheck(d);
  const a = d.analysis || {};
  return {
    available: !!a.venue_live_busyness_available,
    live: a.venue_live_busyness_available ? a.venue_live_busyness : null,
    forecasted: a.venue_forecasted_busyness != null ? a.venue_forecasted_busyness : null
  };
}

// ---------- Typical busyness estimate (used until real data exists) ----------
const PEAKS = {
  Canteen: [[8, 55], [13, 100], [19, 70]], Salon: [[11, 60], [17, 100]], Gym: [[7, 80], [18, 100]],
  'Government Office': [[11, 100], [15, 55]], 'College Office': [[11, 100], [15, 70]],
  Clinic: [[10, 100], [18, 75]], 'Local Store': [[11, 55], [18, 100]]
};
function estimateHours(categoryName) {
  const peaks = PEAKS[categoryName] || PEAKS['Local Store'];
  return Array.from({ length: 24 }, (_, h) =>
    Math.round(Math.min(100, 5 + peaks.reduce((s, [c, a]) => s + a * Math.exp(-((h - c) ** 2) / (2 * 1.8 ** 2)), 0))));
}

module.exports = { hasBestTime, searchPlaces, forecastVenue, liveNow, estimateHours };
