# WaitWise

A community-driven crowd and waiting time estimator. People at a place report the crowd anonymously, and everyone else sees a colour-coded live status.

Stack: HTML, CSS, JavaScript (frontend), Node.js + Express (REST API), a JSON file for storage (`data/data.json`), JWT for the optional admin login.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000

On the first run the app fills `data/data.json` with a week of demo history and a few live reports, so every page has something to show. To regenerate fresh demo data at any time (live reports expire after 60 minutes):

```bash
npm run reset
```

Admin page: http://localhost:3000/admin.html
Demo login: `admin@waitwise.com` / `admin123`

## Real-time updates

The server pushes changes to every open browser with Server-Sent Events (`GET /api/stream`). When anyone sends a report, or an admin adds, edits or removes a place or a report, all open pages update within a moment, with no refresh. The "Live" dot under the headline shows the connection state; the browser reconnects by itself if it drops. An open place dialog updates its status board and report list without clearing a half-filled form. A 60-second background refresh remains as a safety net so expired reports age out.

Events: `report` (`{ place_id, status }`) and `places` (`{ action, place_id }`). Try it: open two browser windows, send a report in one, and watch the other.

## Real places and popular times

- **Real places (free, no key):** in the admin page, use "Find real places" (OpenStreetMap search, e.g. `cafe in Bengaluru`) and click Add.
- **Popular times (BestTime):** set your BestTime private key, then click "Get popular times" on a place. The weekly forecast is fetched once and saved in `data/data.json`, so each place costs credits only once. The place dialog then shows today's typical busyness by hour, plus "right now" live busyness when BestTime has it (cached 15 minutes). The free BestTime plan has limited credits, so fetch only places you need.
- Places without BestTime data show a clearly labelled estimate for their category. The Low / Moderate / Heavy status always comes from community reports.

Windows (Command Prompt):

```
set "BESTTIME_API_KEY_PRIVATE=pri_your_key_here"
npm start
```

macOS / Linux: `BESTTIME_API_KEY_PRIVATE=pri_your_key_here npm start`

Keep the private key on the server only. Never put it in front-end files or commit it to GitHub.

## How it maps to the project

| Requirement | Where |
| --- | --- |
| Place directory: search, filter by category, profile with hours | `index.html` + `GET /api/places` |
| Anonymous report: level + optional wait, no account | Place dialog + `POST /api/places/:id/reports` |
| Spam control: one report per device per place every 5 min (hashed device id) | `server.js` (`SPAM_MIN`) |
| Trend calculation: 60 min window, newer reports weigh more, increasing / steady / decreasing | `computeStatus()` in `server.js` |
| Low / Moderate / Heavy with green / yellow / red and wait (5, 20, 45+ min) | `style.css`, `app.js` |
| "No recent reports" message | Place cards and dialog |
| Dashboard: quietest now, most reported, time-of-day chart, best time to visit | `index.html`, `hourlyPattern()` |
| Admin (JWT): add / edit / remove places, remove false reports | `admin.html`, `/api/admin/*` |

## Data model (`data/data.json`)

`categories`, `places`, `reports`, `admins`. The CrowdStatus of each place is calculated from `reports` whenever it is requested, so expired reports drop out automatically.

## Settings

- `PORT` (default 3000)
- `SPAM_MIN` minutes between reports from one device for one place (default 5; set to 0 while testing)
- `BESTTIME_API_KEY_PRIVATE` BestTime private key (optional)
- `JWT_SECRET` set your own before any real use
