// Seed data for WaitWise.
//   node seed.js        -> base data only (categories, places, admin), no reports
//   node seed.js reset  -> base data + fresh demo reports (history + live)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const DB_FILE = path.join(__dirname, 'data', 'data.json');

function base() {
  return {
    categories: [
      { category_id: 1, category_name: 'Canteen', description: 'Canteens, food courts and mess halls' },
      { category_id: 2, category_name: 'Salon', description: 'Hair and beauty salons' },
      { category_id: 3, category_name: 'Gym', description: 'Gyms and fitness studios' },
      { category_id: 4, category_name: 'Government Office', description: 'Municipal and government service offices' },
      { category_id: 5, category_name: 'College Office', description: 'Admission, fee and exam offices' },
      { category_id: 6, category_name: 'Clinic', description: 'Clinics and health centres' },
      { category_id: 7, category_name: 'Local Store', description: 'Popular local stores and bakeries' }
    ],
    places: [
      { place_id: 1, category_id: 1, admin_id: 1, name: 'Main Campus Canteen', location: 'Block A, Ground Floor', opening_hours: '08:00 - 18:00', created_at: new Date().toISOString() },
      { place_id: 2, category_id: 1, admin_id: 1, name: 'Green Leaf Food Court', location: 'Near Library Gate', opening_hours: '09:00 - 20:00', created_at: new Date().toISOString() },
      { place_id: 3, category_id: 2, admin_id: 1, name: 'Style Studio Salon', location: 'Market Road, Shop 14', opening_hours: '10:00 - 20:00', created_at: new Date().toISOString() },
      { place_id: 4, category_id: 3, admin_id: 1, name: 'FitZone Gym', location: 'Sector 5 Main Road', opening_hours: '05:00 - 22:00', created_at: new Date().toISOString() },
      { place_id: 5, category_id: 4, admin_id: 1, name: 'Municipal Service Centre', location: 'Civil Lines', opening_hours: '09:00 - 17:00', created_at: new Date().toISOString() },
      { place_id: 6, category_id: 5, admin_id: 1, name: 'College Fee Office', location: 'Admin Block, Room 102', opening_hours: '09:30 - 16:30', created_at: new Date().toISOString() },
      { place_id: 7, category_id: 5, admin_id: 1, name: 'Examination Cell', location: 'Admin Block, First Floor', opening_hours: '10:00 - 16:00', created_at: new Date().toISOString() },
      { place_id: 8, category_id: 6, admin_id: 1, name: 'Sunrise Health Clinic', location: 'Gandhi Nagar', opening_hours: '08:00 - 19:00', created_at: new Date().toISOString() },
      { place_id: 9, category_id: 7, admin_id: 1, name: 'Sharma Sweets & Bakery', location: 'Chowk Bazaar', opening_hours: '08:00 - 21:00', created_at: new Date().toISOString() },
      { place_id: 10, category_id: 7, admin_id: 1, name: 'Campus Stationery Store', location: 'Behind Hostel 2', opening_hours: '09:00 - 18:00', created_at: new Date().toISOString() }
    ],
    reports: [],
    // Demo admin login: admin@waitwise.com / admin123
    admins: [{ admin_id: 1, name: 'WaitWise Admin', email: 'admin@waitwise.com', password: sha256('admin123') }]
  };
}

// How busy a category usually is at a given hour (0 = empty, 1 = packed)
const PROFILES = {
  1: [[8, 10, 0.5], [12, 14, 0.92], [16, 17, 0.4]],
  2: [[11, 13, 0.5], [17, 20, 0.85]],
  3: [[5, 8, 0.8], [18, 21, 0.92]],
  4: [[10, 13, 0.9], [14, 15, 0.5]],
  5: [[11, 14, 0.85], [15, 16, 0.5]],
  6: [[9, 12, 0.88], [17, 19, 0.6]],
  7: [[11, 12, 0.4], [17, 20, 0.78]]
};
const WAIT = { Low: 5, Moderate: 20, Heavy: 50 };
const profile = (cat, h) => {
  const hit = (PROFILES[cat] || []).find(([a, b]) => h >= a && h < b);
  return hit ? hit[2] : 0.18;
};
const levelFrom = (v) => (v < 0.35 ? 'Low' : v < 0.65 ? 'Moderate' : 'Heavy');
const pad = (n) => String(n).padStart(2, '0');

function generateReports(places) {
  const now = Date.now();
  const out = [];
  let id = 1;
  const push = (place, t, v) => {
    const level = levelFrom(Math.min(1, Math.max(0, v)));
    const wait = Math.random() < 0.7 ? Math.max(0, Math.round((WAIT[level] + (Math.random() - 0.5) * 12) / 5) * 5) : null;
    out.push({
      report_id: id++, place_id: place.place_id, crowd_level: level, wait_minutes: wait,
      device_hash: Math.random().toString(16).slice(2, 18), reported_at: new Date(t).toISOString()
    });
  };
  places.forEach((p) => {
    const m = /(\d{1,2}):\d{2}\s*-\s*(\d{1,2}):\d{2}/.exec(p.opening_hours);
    const open = +m[1], close = +m[2];
    // 7 days of history, ~2 reports per open hour
    for (let day = 1; day <= 7; day++) {
      for (let h = open; h < close; h++) {
        for (let k = 0; k < 2; k++) {
          const d = new Date(now);
          d.setDate(d.getDate() - day);
          d.setHours(h, Math.floor(Math.random() * 59), 0, 0);
          push(p, d.getTime(), profile(p.category_id, h) + (Math.random() - 0.5) * 0.3);
        }
      }
    }
    // A few live reports in the last 45 minutes so the demo is not empty
    const hourNow = new Date(now).getHours();
    if (hourNow >= open && hourNow < close) {
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        push(p, now - Math.random() * 45 * 60000, profile(p.category_id, hourNow) + (Math.random() - 0.5) * 0.25);
      }
    }
  });
  return out.sort((a, b) => new Date(a.reported_at) - new Date(b.reported_at));
}

module.exports = { base, generateReports, sha256, DB_FILE };

if (require.main === module) {
  const db = base();
  if (process.argv[2] === 'reset') db.reports = generateReports(db.places);
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  console.log(`Wrote ${DB_FILE} (${db.places.length} places, ${db.reports.length} reports)`);
}
