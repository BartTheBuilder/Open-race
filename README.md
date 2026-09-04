# Race Computer

A free, open-source sailing race computer: race-start analytics (start-line
bias, burn time, countdown) plus session recording, in one screen. Phone-only
for now — no hardware puck required. Long-term goal is a cheap custom
GPS/compass hardware device for more accuracy.

## What it does (current MVP)

Four pages, like a real chartplotter/MFD, switched with the bottom tab bar:

- **Instruments** — SOG, COG, HEEL (from the phone's tilt sensor, zeroable
  since mounting angle varies), the 5-4-1-0 start countdown (with sound
  signals and a "sync to :00" button), and a live line readout (distance to
  line + burn time = time-to-start minus time-to-line) once a line is set on
  the Route page. VMG is deferred until boat-specific polars exist — a
  generic speed*cos(angle) number isn't actually useful without a polar to
  compare it against. Two more tiles exist but are off by default - a
  **HEADING** compass dial and **TWA** (true wind angle, signed port/
  starboard) - turn them on from Settings ("Instrument tiles") or the
  edit-mode "Add tile" list below. Tiles are rearrangeable: tap **Edit** to
  drag them around a 4-column grid and resize via a corner handle (each tile
  has its own minimum size, e.g. the timer can't shrink below 4x4); dragging
  one tile more than 40% onto another same-size tile swaps them instead of
  just rejecting the drop, and each tile gets a remove (✕) button while in
  edit mode. The layout is saved and restored automatically, with a per-tile
  fallback to its default position/visibility if nothing's been customized
  yet. Settings has a reset button to put wind/tack/unit/theme settings and
  the tile layout back to defaults (recorded sessions are untouched).
- **Route** — the chart/map, pin-end and boat-end line pings, and session
  recording (start/stop). Both line-end markers are draggable, so a GPS ping
  can be nudged to the actual position afterward. The map rotates heading-up
  by default, like a chartplotter (a "Lock map to North" setting turns this
  off), rotating off a smoothed heading rather than raw GPS course so it
  doesn't swing with normal low-speed COG jitter. Map panning and marker
  dragging stay correct at any rotation - both are custom pointer-driven
  (not Leaflet's native dragging), since a raw screen drag has to be rotated
  into the map's own coordinate space once it isn't sitting north-up. A
  recenter button (bottom-right of the map) jumps back to the boat's current
  position at the current zoom level.
- **Races** — early, deliberately basic scaffold for multi-boat racing: create
  a race (name + start time) or join one by code, see your races listed, and
  "Start Sequence" jumps the countdown timer straight to that race's start
  time (genuinely functional - useful today for one device running several
  rounds back to back). Everything else - joining from another phone, seeing
  other boats' routes after the race - needs a real backend that doesn't
  exist yet, and the page says so rather than faking it.
- **Settings** — wind direction, either typed in manually, fetched as a
  regional forecast estimate (Open-Meteo, free, no key), or measured directly
  by **sailing both tacks**: hold steady close-hauled on starboard, tack, hold
  steady on port, and the app computes true wind direction (the circular
  bisector of the two headings) and your boat's actual tack angle — no
  compass needed. Below that, **auto wind from tacking** keeps redoing this
  continuously from a rolling window of your recent heading history (default
  4 min, adjustable) so wind keeps correcting itself as conditions change,
  without needing to stop and recalibrate. Also an experimental **compass-
  assisted COG** toggle (default off) that fuses the phone's compass into the
  COG display at low speed, where GPS heading is noisiest and a good heading
  matters most (e.g. pre-start maneuvering) - GPS stays the sole source for
  tack/wind detection and GPX export regardless. Speed, wind speed, and
  distance each have their own unit picker (knots/km/h/mph, km/nautical
  miles/miles) so e.g. knots + kilometers is fine if that's what you want.
  COG/HEEL display update rate is adjustable down to 0.25s. GPS
  auto-retries on a configurable interval if it errors out (permission
  denials are the one exception - those need you, not a retry, so the app
  says so instead of looping). Also a **color theme** picker (Default,
  Monochrome, Vintage Amber, Night Vision Red, Ocean Blue, Daylight - the map
  track/line colors switch with it too) and the list of recorded sessions,
  each renameable (pencil icon) with per-session **View** (shows the track on
  the Route map), **GPX export**, and delete.

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

Not built yet: a real backend for multi-device race sync (Races page is a
local-only scaffold so far), map replay of a past session, leaderboards,
native Android app, custom hardware.

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

## Local backups

`scripts/backup.sh` writes a full tar.gz snapshot (including `.git` history)
to `~/backups/race-computer-app/`, rotating so only the 3 most recent are
kept. Run it manually any time, or run `scripts/install-hooks.sh` once to
install a git `post-commit` hook that runs it automatically after every
commit (hooks aren't versioned by git, so this is a one-time local setup step
per machine).

## Development checks

There's no build/test toolchain (this is deliberately a no-dependency static
app), but `scripts/check.sh` catches the mistakes that actually came up while
building it by hand: leftover merge-conflict markers, an id referenced in
`app.js` with no matching element in `index.html` (or vice versa), and
load-time JS errors (typos, undefined references) via a real parse+execute of
`app.js` under `gjs` against a small DOM/Leaflet stub
(`scripts/dom-stub.js`) - not a full browser, so it can't catch visual or
interaction bugs, only "does the script even run." `scripts/install-hooks.sh`
also wires this in as a `pre-commit` hook that blocks a commit if it fails.

## Notes on the sailing math

- Navigation math (tack detection, auto wind, GPX export) always uses GPS
  course-over-ground, never the compass — compass headings near metal/rigging
  are unreliable and drift from actual course due to leeway/current. The
  optional compass fusion (Settings) only ever touches the COG *display* and
  map rotation, and only kicks in below the boat-speed threshold where GPS
  heading itself is the less trustworthy of the two.
- Wind direction is always manual entry; everything else (bias, burn time,
  tack side) is derived from it, so keep it updated as the wind shifts.
- Line-bias and distance-to-line use a flat-earth (equirectangular) projection
  around the line's own latitude — accurate enough over race-course distances.
