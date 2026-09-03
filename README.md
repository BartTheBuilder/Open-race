# Race Computer

A free, open-source sailing race computer: race-start analytics (start-line
bias, burn time, countdown) plus session recording, in one screen. Phone-only
for now — no hardware puck required. Long-term goal is a cheap custom
GPS/compass hardware device for more accuracy.

## What it does (current MVP)

Three pages, like a real chartplotter/MFD, switched with the bottom tab bar:

- **Instruments** — SOG, COG, HEEL (from the phone's tilt sensor, zeroable
  since mounting angle varies), the 5-4-1-0 start countdown (with sound
  signals and a "sync to :00" button), and a live line readout (distance to
  line + burn time = time-to-start minus time-to-line) once a line is set on
  the Route page. VMG is deferred until boat-specific polars exist — a
  generic speed*cos(angle) number isn't actually useful without a polar to
  compare it against.
- **Route** — the chart/map, pin-end and boat-end line pings, and session
  recording (start/stop).
- **Settings** — wind direction, either typed in manually, fetched as a
  regional forecast estimate (Open-Meteo, free, no key), or measured directly
  by **sailing both tacks**: hold steady close-hauled on starboard, tack, hold
  steady on port, and the app computes true wind direction (the circular
  bisector of the two headings) and your boat's actual tack angle — no
  compass needed. Below that, **auto wind from tacking** keeps redoing this
  continuously from a rolling window of your recent heading history (default
  4 min, adjustable) so wind keeps correcting itself as conditions change,
  without needing to stop and recalibrate. Also the list of recorded sessions
  with per-session **GPX export** and delete.

Other notes:
- **Header/lifter alerts**: when auto-wind detects the true wind has moved,
  it shows a HEADER or LIFT banner (with a beep) on the Instruments page,
  based on which tack you're currently on.
- **Screen lock**: the lock button (top-right, every page) keeps the screen
  awake and blocks all touches except a hold-to-unlock button, so a wet
  screen can't trigger anything by accident. Readouts stay visible underneath.
- Basic tack detection (logged as events inside a recorded session, with
  hysteresis so boat wobble doesn't get counted as a tack).
- Recording saves raw GPS fixes to `localStorage` as you go; export any past
  session as a standard GPX 1.1 track (with speed/course in the Garmin
  `TrackPointExtension`, so it opens cleanly elsewhere while keeping that
  data) from the Settings page. Nothing is auto-downloaded — sessions stay in
  `localStorage` until you export or delete them.

Not built yet: map replay of a past session, social/leaderboards, native
Android app, custom hardware.

## Running it

This is a plain static web app (no build step, no `node_modules`) — but
**GPS requires a secure context** (HTTPS or `localhost`), or Chrome/Android
will silently refuse to report position. Pick one:

### Option A — quick local test (same wifi)

```
cd race-computer-app
python3 -m http.server 8000
```

Then on your phone, visit `http://<your-computer's-LAN-IP>:8000`. On Android
Chrome this will likely **not** get GPS permission because plain HTTP over a
LAN IP isn't a secure context. To test anyway: on the phone, open
`chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add
`http://<your-computer's-LAN-IP>:8000`, enable the flag, and restart Chrome.

### Option B — real HTTPS tunnel (recommended for actual sailing use)

Use any free HTTPS tunnel (e.g. `ngrok http 8000`) pointed at the same local
server, or deploy the folder to a free static host with HTTPS (GitHub Pages,
Netlify, Cloudflare Pages). Open that HTTPS URL on your phone, then use the
browser menu → **"Add to Home Screen"** — it'll behave like an installed app
(own icon, no browser chrome, works offline via the service worker).

## Notes on the sailing math

- Speed/heading come from GPS course-over-ground, not the phone's compass —
  compass headings near metal/rigging are unreliable and need calibration.
- Wind direction is always manual entry; everything else (bias, burn time,
  tack side) is derived from it, so keep it updated as the wind shifts.
- Line-bias and distance-to-line use a flat-earth (equirectangular) projection
  around the line's own latitude — accurate enough over race-course distances.
