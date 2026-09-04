"use strict";

/* ---------- color theme ----------
   Applied as the very first thing the script does (before anything renders
   or reads settings) so there's no flash of the wrong theme on load. The
   theme lives in the same rc_settings blob as everything else - see
   saveSettings()/loadSettings() - this early read just short-circuits
   straight to localStorage since loadSettings() itself runs much later. */
const VALID_THEMES = ['default', 'mono', 'amber', 'red', 'ocean', 'daylight'];
const THEME_MAP_COLORS = {
  // Leaflet draws the track/boat marker with an actual color, not CSS - keep
  // these roughly matching each theme's --accent/--amber so the map doesn't
  // stay teal/amber while the rest of the UI goes monochrome.
  default: { track: '#39ffb0', line: '#ffb020' },
  mono: { track: '#e0e0e0', line: '#b5b5b5' },
  amber: { track: '#ffb020', line: '#ffe08a' },
  red: { track: '#ff3b3b', line: '#ff8080' },
  ocean: { track: '#4fd6ff', line: '#ffd24f' },
  daylight: { track: '#0a7a5a', line: '#b36b00' },
};
let currentTheme = 'default';
(function initThemeEarly() {
  try {
    const raw = localStorage.getItem('rc_settings');
    if (raw) {
      const s = JSON.parse(raw);
      if (VALID_THEMES.includes(s.theme)) currentTheme = s.theme;
    }
  } catch (e) { /* storage unavailable, fall back to default */ }
  document.documentElement.setAttribute('data-theme', currentTheme);
})();

/* ---------- constants ---------- */
const MS_TO_KNOTS = 1.943844;
const EARTH_R = 6371000; // meters
const TACK_HYSTERESIS_DEG = 20;   // COG must move this far past the wind axis...
const TACK_MIN_INTERVAL_MS = 8000; // ...and stay there this long to count as a real tack
const MOVING_MIN_SPEED_KN = 1.5;  // below this, heading is noise (drifting/stopped), ignore for wind/tack math
const SHIFT_NOTICE_MIN_DEG = 4;   // ignore wind-shift jitter smaller than this
const AUTO_WIND_MIN_SAMPLES = 8;  // per tack, within the rolling window, before trusting the average heading
const HEADING_LOG_MAX_AGE_MS = 10 * 60 * 1000; // prune anything older than the largest allowed window
const COMPASS_OFFSET_ALPHA = 0.03; // slow low-pass on (GPS cog - compass heading), only learned while moving fast
const HEADING_EMA_ALPHA = 0.15;    // smooths raw GPS COG for display/map-rotation use only - never for state.cog
const COMPASS_TIMEOUT_MS = 8000;   // how long to wait for an absolute orientation sample before giving up

/* ---------- state ---------- */
const state = {
  lastFix: null,        // {lat, lon, t}
  speedKn: null,
  cog: null,             // course over ground, degrees true - GPS ONLY, feeds tack/wind detection + GPX export
  heading: null,         // smoothed display/rotation heading - compass-fused at low speed when enabled, else smoothed GPS COG
  windDir: 0,
  windSource: 'auto',       // 'manual' locks windDir - auto-wind won't overwrite it
  tackAngleDeg: null,
  tackAngleSource: 'auto',  // 'manual' locks tackAngleDeg - auto-wind won't overwrite it
  pin: null,             // {lat, lon}
  boat: null,            // {lat, lon}
  timerEndAt: null,      // epoch ms when the countdown hits 0
  timerInterval: null,
  recording: false,
  track: [],             // [{lat, lon, t, speedKn, cog}] plus {event:'tack', ...} markers
  sessionStart: null,
  lastTackSide: null,    // 'port' | 'stbd' relative to wind axis
  lastTackAt: 0,
  autoWindEnabled: true,
  autoWindWindowMin: 4,
  headingLog: [],        // rolling {t, cog} samples while moving, for auto wind + header/lift detection
  locked: false,
  speedUnit: 'kn',       // 'kn' | 'kmh' | 'mph' - SOG display only, internal speedKn stays knots
  windSpeedUnit: 'kn',   // 'kn' | 'kmh' | 'mph' - forecast wind speed display only
  distanceUnit: 'km',    // 'km' | 'nm' | 'mi' - recorded-track distance displays only
};

/* ---------- unit conversion (display only - internal values stay knots/meters) ---------- */
const KN_TO_UNIT = { kn: 1, kmh: 1.852, mph: 1.150779 };
const UNIT_LABEL = { kn: 'kn', kmh: 'km/h', mph: 'mph' };
const KM_TO_UNIT = { km: 1, nm: 1 / 1.852, mi: 1 / 1.609344 };
const DIST_UNIT_LABEL = { km: 'km', nm: 'nm', mi: 'mi' };

function formatSpeed(kn) {
  const factor = KN_TO_UNIT[state.speedUnit] || 1;
  return { text: (kn * factor).toFixed(1), unit: UNIT_LABEL[state.speedUnit] || 'kn' };
}

function formatDistanceKm(km) {
  const factor = KM_TO_UNIT[state.distanceUnit] || 1;
  return { text: (km * factor).toFixed(2), unit: DIST_UNIT_LABEL[state.distanceUnit] || 'km' };
}

/* ---------- page navigation ---------- */
document.querySelectorAll('#tabbar .tab').forEach((btn) => {
  btn.addEventListener('click', () => switchPage(btn.dataset.page));
});

function switchPage(name) {
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
  document.querySelectorAll('#tabbar .tab').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  if (name === 'route') {
    // Leaflet mis-sizes a map that was initialized while its container was
    // display:none - fix it up whenever the Route page becomes visible.
    // sizeRotatedMap() must run first: it sets #map's oversized pixel
    // dimensions that invalidateSize() then reads.
    setTimeout(() => { sizeRotatedMap(); map.invalidateSize(); applyMapRotation(); }, 50);
  }
  if (name === 'instruments') {
    // The grid's real height is 0 while its page is display:none, so the
    // row ceiling has to be (re)measured once it's actually visible.
    setTimeout(updateMaxRows, 50);
  }
}

/* ---------- geo helpers ---------- */
function toRad(d) { return d * Math.PI / 180; }
function toDeg(r) { return r * 180 / Math.PI; }

// Local flat-earth projection (meters), good enough over race-course distances.
function project(lat, lon, refLat) {
  const x = toRad(lon) * EARTH_R * Math.cos(toRad(refLat));
  const y = toRad(lat) * EARTH_R;
  return { x, y };
}

function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

function bearing(a, b) {
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function angleDiff(a, b) {
  let d = (a - b + 540) % 360 - 180;
  return d; // signed, -180..180
}

/* ---------- map ---------- */
const map = L.map('map', { zoomControl: false, attributionControl: false }).setView([52.0, 5.0], 14);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

// Heading-up rotation, done cheaply without the leaflet-rotate plugin (which
// would need a CDN this app's offline service worker doesn't cache). We
// oversize #map so rotating it never reveals empty corners.
//
// We do NOT rotate Leaflet's own map pane (.leaflet-map-pane) directly, nor
// set a `rotate` alongside Leaflet's `transform` on that same element: per
// the CSS individual-transform-properties spec, `rotate` composes *inside*
// `transform` (translate applied first, then rotate, then the `transform`
// property last) - the opposite of what we need. Leaflet's pan offset is
// computed assuming the container's own center pixel always shows
// map.getCenter(); rotating the whole thing correctly around that fixed
// screen point requires the rotation to be the OUTER transform, applied
// after Leaflet's pan. So instead we insert a plain wrapper div as the new
// parent of the map pane and rotate the wrapper - DOM nesting always applies
// a child's transform before its parent's, which gives exactly the order we
// need, and Leaflet reaches its panes through stored references (not DOM
// traversal), so reparenting the pane element is safe.
const mapViewportEl = document.getElementById('map-viewport');
const mapEl = document.getElementById('map');
const mapPaneEl = map.getPane('mapPane');
const mapRotateWrapperEl = document.createElement('div');
mapRotateWrapperEl.id = 'map-rotate-wrapper';
mapPaneEl.parentNode.insertBefore(mapRotateWrapperEl, mapPaneEl);
mapRotateWrapperEl.appendChild(mapPaneEl);
let mapNorthLock = false; // persisted setting - true forces north-up

function sizeRotatedMap() {
  const w = mapViewportEl.clientWidth, h = mapViewportEl.clientHeight;
  if (w === 0 || h === 0) return; // page hidden (display:none) - nothing to size yet
  const size = Math.ceil(Math.hypot(w, h) * 1.45);
  mapEl.style.width = size + 'px';
  mapEl.style.height = size + 'px';
}

function applyMapRotation() {
  const angle = currentMapRotationDeg();
  mapRotateWrapperEl.style.transform = angle === 0 ? '' : `rotate(${angle}deg)`;
  // The pin/boat "P"/"CB" labels rotate along with everything else in the
  // pane (correct for their position, wrong for their text - a label
  // shouldn't go sideways/upside-down as heading changes), so counter-
  // rotate each one back to upright.
  [pinMarker, boatEndMarker].forEach((m) => {
    const el = m && m.getElement && m.getElement();
    const circle = el && el.querySelector('.line-end-circle');
    if (circle) circle.style.transform = angle === 0 ? '' : `rotate(${-angle}deg)`;
  });
}

window.addEventListener('resize', () => {
  if (document.getElementById('page-route').classList.contains('active')) {
    sizeRotatedMap();
    map.invalidateSize();
  }
});

document.getElementById('map-north-lock').addEventListener('change', (e) => {
  mapNorthLock = e.target.checked;
  applyMapRotation();
  saveSettings();
});

/* ---------- rotation-aware dragging (map pan + line-end markers) ---------- */
// Leaflet's built-in dragging (map panning, marker dragging) computes screen
// deltas assuming an unrotated container - but the heading-up rotation above
// is applied via CSS to a wrapper around Leaflet's own pane, which Leaflet
// has no knowledge of. A raw screen-space drag delta has to be rotated into
// the pane's own (unrotated) coordinate space before it means anything to
// Leaflet, or dragging visually goes the wrong direction the moment the map
// isn't north-up. Rather than only patching the rotated case, native
// dragging (map panning, and line-end marker dragging further below) is
// replaced entirely with one shared pointer-based implementation - a single
// code path, where the rotation angle is just 0 when unrotated/north-locked.
function rotateVector(dx, dy, angleDeg) {
  const rad = angleDeg * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

// The angle actually applied to mapRotateWrapperEl right now (see
// applyMapRotation) - a screen-space delta needs the INVERSE of this to
// land correctly in the pane's own coordinate space.
function currentMapRotationDeg() {
  return (mapNorthLock || state.heading == null) ? 0 : -state.heading;
}

map.dragging.disable();

let mapActivePointers = 0;
let mapPanState = null; // {x, y, pointerId, remX, remY}

function onMapPointerDown(ev) {
  mapActivePointers++;
  if (mapActivePointers > 1) {
    // A second finger means the user is pinch-zooming, not panning - abort
    // any in-flight pan and let Leaflet's own touch-zoom handler (still
    // enabled; only .dragging is disabled) take the gesture from here.
    if (mapPanState) {
      mapViewportEl.releasePointerCapture(mapPanState.pointerId);
      mapPanState = null;
    }
    return;
  }
  if (!ev.isPrimary) return;
  mapPanState = { x: ev.clientX, y: ev.clientY, pointerId: ev.pointerId, remX: 0, remY: 0 };
  mapViewportEl.setPointerCapture(ev.pointerId);
}

function onMapPointerMove(ev) {
  if (!mapPanState || ev.pointerId !== mapPanState.pointerId) return;
  const dx = ev.clientX - mapPanState.x;
  const dy = ev.clientY - mapPanState.y;
  mapPanState.x = ev.clientX;
  mapPanState.y = ev.clientY;
  const rotated = rotateVector(dx, dy, -currentMapRotationDeg());
  // panBy() rounds its offset to whole pixels internally and does nothing at
  // all if that rounds to (0,0) - a slow drag fires many small per-event
  // deltas that round away to zero individually, so without carrying the
  // fractional remainder forward, most of a slow drag just gets silently
  // dropped (the map barely moves). Accumulate the leftover here instead.
  const totalX = rotated.x + mapPanState.remX;
  const totalY = rotated.y + mapPanState.remY;
  const applyX = Math.round(totalX);
  const applyY = Math.round(totalY);
  mapPanState.remX = totalX - applyX;
  mapPanState.remY = totalY - applyY;
  // panBy(offset) moves the pane by -offset (panning the "view" right shifts
  // content left) - negate so the content actually follows the finger.
  if (applyX || applyY) map.panBy([-applyX, -applyY], { animate: false });
}

function onMapPointerEnd(ev) {
  mapActivePointers = Math.max(0, mapActivePointers - 1);
  if (mapPanState && ev.pointerId === mapPanState.pointerId) mapPanState = null;
}

mapViewportEl.addEventListener('pointerdown', onMapPointerDown);
mapViewportEl.addEventListener('pointermove', onMapPointerMove);
mapViewportEl.addEventListener('pointerup', onMapPointerEnd);
mapViewportEl.addEventListener('pointercancel', onMapPointerEnd);

let boatMarker = null;
let pinMarker = null;
let boatEndMarker = null;
let lineLayer = null;
let viewedSessionLayer = null; // a past recorded session's track, shown via the session list's "View" button
let trackLayer = L.polyline([], { color: THEME_MAP_COLORS[currentTheme].track, weight: 3 }).addTo(map);
let firstFix = true;

function updateBoatMarker(lat, lon) {
  if (!boatMarker) {
    const c = THEME_MAP_COLORS[currentTheme].track;
    boatMarker = L.circleMarker([lat, lon], { radius: 7, color: c, fillColor: c, fillOpacity: 1 }).addTo(map);
  } else {
    boatMarker.setLatLng([lat, lon]);
  }
  if (firstFix) {
    map.setView([lat, lon], 16);
    firstFix = false;
  }
}

document.getElementById('map-recenter').addEventListener('click', () => {
  if (!state.lastFix) return;
  map.setView([state.lastFix.lat, state.lastFix.lon], map.getZoom());
});

// Circle-in-a-div markers instead of Leaflet's default pin icon: the default
// pulls PNGs from unpkg, which breaks offline (exactly when this matters
// most, mid-race with no signal) and doesn't give a precise center point the
// way a plain circle does.
let LINE_COLOR = THEME_MAP_COLORS[currentTheme].line;
function lineEndIcon(label) {
  return L.divIcon({
    className: 'line-end-icon',
    html: `<div class="line-end-circle">${label}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function redrawLine() {
  if (lineLayer) { map.removeLayer(lineLayer); lineLayer = null; }
  if (state.pin && state.boat) {
    lineLayer = L.polyline([[state.pin.lat, state.pin.lon], [state.boat.lat, state.boat.lon]],
      { color: LINE_COLOR, weight: 3, dashArray: '6 6' }).addTo(map);
  }
}

/* ---------- GPS ---------- */
const gpsStatusEl = document.getElementById('gps-status');
const speedEl = document.getElementById('speed-value');
const speedUnitEl = document.getElementById('speed-unit');
const cogEl = document.getElementById('cog-value');
const heelEl = document.getElementById('heel-value');
const compassRingGroupEl = document.getElementById('compass-ring-group');
const windNeedleEl = document.getElementById('wind-needle');

// Optional WIND instrument tile (hidden by default - see DEFAULT_LAYOUT):
// a compass ring (rotates with heading, like a gyrocompass repeater card),
// a fixed boat icon (the "bow up" reference the ring and needle both read
// against), and a wind needle (rotates with TWA, boat-relative and
// independent of heading).
function updateCompassDial(headingDeg) {
  compassRingGroupEl.style.transform = `rotate(${-headingDeg}deg)`;
}

function updateWindNeedle(cog) {
  const rel = angleDiff(state.windDir, cog); // wind's bearing relative to the bow - 0 = dead ahead, +/- = starboard/port
  windNeedleEl.style.transform = `rotate(${rel}deg)`;
}

let cogUpdateMs = 0; // 0 = render every fix ("Instant") - display-only, does not affect nav math
let cogDisplaySamples = [];
let cogDisplayLastRender = 0;

function renderCog(cog, t) {
  cogDisplaySamples.push(cog);
  if (cogUpdateMs > 0 && t - cogDisplayLastRender < cogUpdateMs) return;
  const avg = circularMeanDeg(cogDisplaySamples);
  cogEl.textContent = Math.round(avg);
  cogDisplaySamples = [];
  cogDisplayLastRender = t;
}

// ---- compass/GPS heading fusion (Settings toggle, default off) ----
// GPS course-over-ground is ground truth once actually sailing - compass
// reads magnetic heading, which differs from COG by leeway/current and is
// unreliable near rigging/metal. But GPS heading gets noisy/unreliable right
// where a good heading matters most: pre-start maneuvering at low speed.
// So: learn the (GPS cog - compass heading) offset only while moving at real
// speed, then below that speed, use compass + learned offset instead.
// Never feeds back into state.cog - see state.heading.
let compassFusionEnabled = false;   // persisted setting
let compassAvailable = null;        // null = waiting for a sample, true = active, false = unavailable
let compassRawHeading = null;       // degrees clockwise from true/magnetic north, latest sample
let compassOffset = null;           // slow EMA of angleDiff(gpsCog, compassRawHeading)
let headingEma = null;              // smoothed GPS COG, used for display fallback + map rotation always

function updateFusedHeading(cog, speedKn) {
  if (!Number.isFinite(cog)) return; // guard against a NaN ever permanently poisoning the EMA/rotation
  if (headingEma == null) headingEma = cog;
  else headingEma = (headingEma + HEADING_EMA_ALPHA * angleDiff(cog, headingEma) + 360) % 360;

  if (compassFusionEnabled && compassAvailable === true && speedKn > MOVING_MIN_SPEED_KN && compassRawHeading != null) {
    const diff = angleDiff(cog, compassRawHeading);
    compassOffset = (compassOffset == null) ? diff : compassOffset + COMPASS_OFFSET_ALPHA * angleDiff(diff, compassOffset);
  }

  if (compassFusionEnabled && compassAvailable === true && speedKn <= MOVING_MIN_SPEED_KN
      && compassRawHeading != null && compassOffset != null) {
    state.heading = ((compassRawHeading + compassOffset) % 360 + 360) % 360;
  } else {
    state.heading = headingEma;
  }
}

function onPosition(pos) {
  if (gpsRetryTimer) { clearTimeout(gpsRetryTimer); gpsRetryTimer = null; }
  const { latitude: lat, longitude: lon, speed, heading } = pos.coords;
  const t = pos.timestamp;
  gpsStatusEl.textContent = 'locked (±' + Math.round(pos.coords.accuracy) + 'm)';

  let speedKn, cog;

  if (state.lastFix) {
    const dt = (t - state.lastFix.t) / 1000; // seconds
    if (dt > 0.2) {
      const distM = haversine(state.lastFix, { lat, lon });
      // Prefer the GPS-reported speed/heading when present; derive as fallback.
      speedKn = (speed != null && !Number.isNaN(speed)) ? speed * MS_TO_KNOTS : (distM / dt) * MS_TO_KNOTS;
      cog = (heading != null && !Number.isNaN(heading)) ? heading : bearing(state.lastFix, { lat, lon });
    } else {
      speedKn = state.speedKn;
      cog = state.cog;
    }
  } else {
    speedKn = (speed != null && !Number.isNaN(speed)) ? speed * MS_TO_KNOTS : 0;
    cog = heading != null && !Number.isNaN(heading) ? heading : 0;
  }

  state.speedKn = speedKn;
  state.cog = cog; // GPS-only - detectTack/recordHeadingSample/toGPX all depend on this staying pure GPS
  state.lastFix = { lat, lon, t };
  updateFusedHeading(cog, speedKn);

  const speedFmt = formatSpeed(speedKn);
  speedEl.textContent = speedFmt.text;
  speedUnitEl.textContent = speedFmt.unit;
  const dispHeading = (compassFusionEnabled && state.heading != null) ? state.heading : cog;
  renderCog(dispHeading, t);
  updateCompassDial(dispHeading);
  updateWindNeedle(cog); // GPS cog, not the display heading - stays consistent with wind/tack detection elsewhere

  updateBoatMarker(lat, lon);
  updateLineReadout();
  detectTack(cog);
  recordHeadingSample(t, cog, speedKn);
  updateAutoWind();
  applyMapRotation();

  if (state.recording) {
    state.track.push({ lat, lon, t, speedKn, cog });
    trackLayer.addLatLng([lat, lon]);
    updateRecordReadout();
  }
}

// watchPosition doesn't reliably keep retrying on its own once it errors out
// on some browsers/devices - explicitly tear down and restart the watch
// after a configurable delay so a lost GPS fix recovers on its own instead
// of needing the page reloaded mid-race.
let gpsWatchId = null;
let gpsRetryTimer = null;
let gpsRetryS = 10;

function startGpsWatch() {
  if (!('geolocation' in navigator)) { gpsStatusEl.textContent = 'not supported'; return; }
  if (gpsWatchId != null) navigator.geolocation.clearWatch(gpsWatchId);
  gpsWatchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 15000,
  });
}

function onPositionError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    // Retrying won't help - only the user re-granting permission will, and
    // repeatedly re-requesting a denied permission is exactly the kind of
    // thing that gets a site flagged as abusive by the browser.
    gpsStatusEl.textContent = 'location permission denied - enable it in browser settings';
    return;
  }
  gpsStatusEl.textContent = `error: ${err.message} - retrying in ${gpsRetryS}s`;
  if (gpsRetryTimer) clearTimeout(gpsRetryTimer);
  gpsRetryTimer = setTimeout(startGpsWatch, gpsRetryS * 1000);
}

startGpsWatch();

document.getElementById('gps-retry-input').addEventListener('change', (e) => {
  gpsRetryS = Math.min(60, Math.max(5, parseInt(e.target.value, 10) || 10));
  e.target.value = gpsRetryS;
  saveSettings();
});
document.querySelectorAll('[data-gps-retry-nudge]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = document.getElementById('gps-retry-input');
    gpsRetryS = Math.min(60, Math.max(5, gpsRetryS + parseInt(btn.dataset.gpsRetryNudge, 10)));
    input.value = gpsRetryS;
    saveSettings();
  });
});

/* ---------- heel (from the phone's accelerometer) ---------- */
// Derived from the raw gravity vector (devicemotion) rather than the
// deviceorientation beta/gamma Euler angles - those hit gimbal lock as beta
// approaches +-90 degrees, which is exactly the case when the phone is
// mounted standing upright rather than lying flat (a normal bracket mount).
// heel = angle of gravity in a plane through the device's Z axis, via
// atan2(g?, gz): this stays correct at any mounting PITCH (flat, angled, or
// standing vertical) as long as the phone isn't rotated 90 degrees from the
// assumed portrait orientation - which axis pairs with Z for that (Y for
// portrait, X for landscape) is the one thing gravity alone can't infer, so
// it's a Settings choice (heelAxis) rather than auto-detected. Zeroable
// (heelZeroOffset) since the mount itself won't be exactly plumb either way.
let heelZeroOffset = 0;
let heelAxis = 'yz'; // 'yz' (portrait, default) | 'xz' (landscape)
let heelUpdateMs = 0; // 0 = render every sample ("Instant")
let heelSamples = [];
let heelLastRender = 0;

function onDeviceMotion(evt) {
  const g = evt.accelerationIncludingGravity;
  if (!g || g.x == null || g.y == null || g.z == null) return;
  const raw = (heelAxis === 'xz' ? Math.atan2(g.x, g.z) : Math.atan2(g.y, g.z)) * 180 / Math.PI;
  heelEl.dataset.raw = raw;
  heelSamples.push(raw);

  const now = Date.now();
  if (heelUpdateMs > 0 && now - heelLastRender < heelUpdateMs) return;
  // Average whatever samples arrived since the last render rather than just
  // picking the latest one - a slower rate then reads smoother, not laggier.
  const avg = heelSamples.reduce((a, b) => a + b, 0) / heelSamples.length;
  heelEl.textContent = Math.round(avg - heelZeroOffset);
  heelSamples = [];
  heelLastRender = now;
}

/* ---------- compass (deviceorientation) for COG fusion ---------- */
const compassStatusEl = document.getElementById('compass-fusion-status');
const compassEnabledEl = document.getElementById('compass-fusion-enabled');
let sawAbsoluteOrientationEvent = false; // true once deviceorientationabsolute fires at least once

function updateCompassStatus() {
  if (compassAvailable === false) {
    // Grey out rather than silently fuse garbage - unreliable heading feeding
    // into COG/map-rotation would be worse than no fusion at all.
    compassFusionEnabled = false;
    compassEnabledEl.checked = false;
    compassEnabledEl.disabled = true;
    compassStatusEl.textContent = 'Compass fusion: unavailable on this device (no absolute orientation data)';
    return;
  }
  compassEnabledEl.disabled = false;
  if (compassAvailable === null) {
    compassStatusEl.textContent = 'Compass fusion: waiting for absolute orientation data...';
    return;
  }
  compassStatusEl.textContent = compassFusionEnabled
    ? `Compass fusion: active (used below ${MOVING_MIN_SPEED_KN}kn)`
    : 'Compass fusion: available - enable above to use it';
}

function handleCompassHeading(headingDeg) {
  compassRawHeading = ((headingDeg % 360) + 360) % 360;
  if (compassAvailable !== true) { compassAvailable = true; updateCompassStatus(); }
}

// Android: alpha is only earth-referenced ("absolute") on deviceorientationabsolute,
// or on deviceorientation when evt.absolute === true - plain deviceorientation
// alpha can otherwise be relative to whatever heading the device booted at.
function onDeviceOrientationAbsolute(evt) {
  sawAbsoluteOrientationEvent = true;
  if (evt.alpha == null) return;
  handleCompassHeading((360 - evt.alpha) % 360); // alpha is counterclockwise
}

function onDeviceOrientation(evt) {
  if (typeof evt.webkitCompassHeading === 'number') {
    // iOS: already clockwise-from-north, no conversion. Negative accuracy
    // means the compass hasn't been calibrated yet - don't trust it.
    if (evt.webkitCompassAccuracy != null && evt.webkitCompassAccuracy < 0) return;
    handleCompassHeading(evt.webkitCompassHeading);
    return;
  }
  if (sawAbsoluteOrientationEvent) return; // deviceorientationabsolute already covers this device
  if (evt.absolute === true && evt.alpha != null) handleCompassHeading((360 - evt.alpha) % 360);
}

function attachOrientationListeners() {
  window.addEventListener('deviceorientationabsolute', onDeviceOrientationAbsolute);
  window.addEventListener('deviceorientation', onDeviceOrientation);
  setTimeout(() => {
    if (compassAvailable !== true) { compassAvailable = false; updateCompassStatus(); }
  }, COMPASS_TIMEOUT_MS);
}

function markCompassUnavailable() { compassAvailable = false; updateCompassStatus(); }

compassEnabledEl.addEventListener('change', (e) => {
  compassFusionEnabled = e.target.checked;
  updateCompassStatus();
  saveSettings();
});

updateCompassStatus();

/* ---------- sensor permission gate (devicemotion + deviceorientation) ---------- */
// iOS gates both behind a user gesture via *Event.requestPermission(). Request
// both on the same first tap rather than two separate {once:true} listeners,
// which would race/duplicate the prompt.
const motionNeedsPermission = !!window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function';
const orientationNeedsPermission = !!window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function';

if (motionNeedsPermission || orientationNeedsPermission) {
  document.body.addEventListener('click', function requestSensorsOnce() {
    document.body.removeEventListener('click', requestSensorsOnce);
    if (motionNeedsPermission) {
      DeviceMotionEvent.requestPermission().then((res) => {
        if (res === 'granted') window.addEventListener('devicemotion', onDeviceMotion);
      }).catch(() => {});
    } else if (window.DeviceMotionEvent) {
      window.addEventListener('devicemotion', onDeviceMotion);
    }
    if (orientationNeedsPermission) {
      DeviceOrientationEvent.requestPermission().then((res) => {
        if (res === 'granted') attachOrientationListeners();
        else markCompassUnavailable();
      }).catch(markCompassUnavailable);
    } else if (window.DeviceOrientationEvent) {
      attachOrientationListeners();
    } else {
      markCompassUnavailable();
    }
  }, { once: true });
} else {
  if (window.DeviceMotionEvent) window.addEventListener('devicemotion', onDeviceMotion);
  else heelEl.textContent = 'n/a';
  if (window.DeviceOrientationEvent) attachOrientationListeners();
  else markCompassUnavailable();
}

document.getElementById('heel-zero').addEventListener('click', () => {
  const raw = parseFloat(heelEl.dataset.raw);
  if (!Number.isNaN(raw)) heelZeroOffset = raw;
  saveSettings();
});

document.getElementById('heel-rate').addEventListener('change', (e) => {
  heelUpdateMs = parseInt(e.target.value, 10) || 0;
  saveSettings();
});

document.getElementById('heel-axis-select').addEventListener('change', (e) => {
  heelAxis = e.target.value === 'xz' ? 'xz' : 'yz';
  saveSettings();
});

document.getElementById('cog-rate').addEventListener('change', (e) => {
  cogUpdateMs = parseInt(e.target.value, 10) || 0;
  saveSettings();
});

document.getElementById('speed-unit-select').addEventListener('change', (e) => {
  state.speedUnit = e.target.value;
  const fmt = formatSpeed(state.speedKn != null ? state.speedKn : 0);
  speedUnitEl.textContent = fmt.unit;
  if (state.speedKn != null) speedEl.textContent = fmt.text;
  saveSettings();
});

document.getElementById('wind-speed-unit-select').addEventListener('change', (e) => {
  state.windSpeedUnit = e.target.value;
  saveSettings();
});

document.getElementById('distance-unit-select').addEventListener('change', (e) => {
  state.distanceUnit = e.target.value;
  if (state.recording) updateRecordReadout();
  renderSessionsList();
  saveSettings();
});

/* ---------- wind ---------- */
const windInput = document.getElementById('wind-input');
windInput.addEventListener('change', () => {
  state.windDir = ((parseInt(windInput.value, 10) || 0) % 360 + 360) % 360;
  state.windSource = 'manual';
  updateLineReadout();
  updateWindStatus();
  saveSettings();
});
document.querySelectorAll('[data-nudge]').forEach(btn => {
  btn.addEventListener('click', () => {
    const delta = parseInt(btn.dataset.nudge, 10);
    state.windDir = ((state.windDir + delta) % 360 + 360) % 360;
    state.windSource = 'manual';
    windInput.value = state.windDir;
    updateLineReadout();
    updateWindStatus();
    saveSettings();
  });
});

// Free, no-key forecast as a starting estimate - not live local wind, just a
// regional model value. The tack-angle calibration below is what actually
// measures your true wind on the day.
document.getElementById('fetch-wind').addEventListener('click', async () => {
  const statusEl = document.getElementById('wind-forecast-status');
  if (!state.lastFix) { statusEl.textContent = 'No GPS fix yet - wait for a lock first'; return; }
  statusEl.textContent = 'Fetching...';
  try {
    const { lat, lon } = state.lastFix;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=wind_direction_10m,wind_speed_10m&wind_speed_unit=${state.windSpeedUnit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const dir = Math.round(data.current.wind_direction_10m);
    const spd = data.current.wind_speed_10m;
    state.windDir = ((dir % 360) + 360) % 360;
    state.windSource = 'manual';
    windInput.value = state.windDir;
    updateLineReadout();
    updateWindStatus();
    saveSettings();
    statusEl.textContent = `Forecast: ${state.windDir}° @ ${spd.toFixed(1)}${UNIT_LABEL[state.windSpeedUnit] || 'kn'} - regional estimate, refine with calibration`;
  } catch (e) {
    statusEl.textContent = 'Fetch failed (no signal?): ' + e.message;
  }
});

const tackAngleInput = document.getElementById('tack-angle-input');
function setTackAngleManual(value) {
  state.tackAngleDeg = Math.min(160, Math.max(20, value));
  state.tackAngleSource = 'manual';
  tackAngleInput.value = state.tackAngleDeg;
  updateWindStatus();
  saveSettings();
}
tackAngleInput.addEventListener('change', () => {
  const v = parseInt(tackAngleInput.value, 10);
  if (!Number.isNaN(v)) setTackAngleManual(v);
});
document.querySelectorAll('[data-tack-nudge]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const current = state.tackAngleDeg != null ? state.tackAngleDeg : 90;
    setTackAngleManual(current + parseInt(btn.dataset.tackNudge, 10));
  });
});

/* ---------- wind & tack-angle calibration ---------- */
// Sail steady close-hauled on starboard, then tack and hold steady on port.
// The wind's FROM direction is the circular bisector of the two headings;
// the tack angle is the angular difference between them - no compass needed,
// just GPS heading held steady on each tack.
const calib = { active: false, phase: null, samples: [], endAt: null, duration: null, hstbd: null, interval: null };
const calibStatusEl = document.getElementById('calib-status');
const calibDetailEl = document.getElementById('calib-detail');
const calibStartBtn = document.getElementById('calib-start');

function circularMeanDeg(angles) {
  if (angles.length === 0) return null;
  let sx = 0, sy = 0;
  angles.forEach((a) => { sx += Math.cos(toRad(a)); sy += Math.sin(toRad(a)); });
  return (toDeg(Math.atan2(sy, sx)) + 360) % 360;
}

function startCalibration() {
  const duration = (parseInt(document.getElementById('calib-duration').value, 10) || 45) * 1000;
  Object.assign(calib, { active: true, phase: 'stbd', samples: [], duration, endAt: Date.now() + duration, hstbd: null });
  calibStartBtn.textContent = 'Cancel Calibration';
  calibDetailEl.textContent = '';
  if (calib.interval) clearInterval(calib.interval);
  calib.interval = setInterval(tickCalibration, 250);
  tickCalibration();
}

function cancelCalibration(message) {
  if (calib.interval) clearInterval(calib.interval);
  calib.active = false;
  calibStartBtn.textContent = 'Calibrate: Sail Both Tacks';
  calibStatusEl.textContent = message || 'Calibration cancelled';
}

function tickCalibration() {
  if (!calib.active) return;
  if (state.speedKn > MOVING_MIN_SPEED_KN && state.cog != null) calib.samples.push(state.cog);

  const remainingS = Math.max(0, Math.ceil((calib.endAt - Date.now()) / 1000));
  calibStatusEl.textContent = `Hold steady on ${calib.phase === 'stbd' ? 'STARBOARD' : 'PORT'} tack - ${remainingS}s`;

  if (remainingS > 0) return;

  if (calib.phase === 'stbd') {
    calib.hstbd = circularMeanDeg(calib.samples);
    if (calib.hstbd == null) { cancelCalibration('No GPS samples above 1.5kn - were you sailing? Try again.'); return; }
    calib.phase = 'port';
    calib.samples = [];
    calib.endAt = Date.now() + calib.duration;
    calibDetailEl.textContent = `Starboard heading: ${Math.round(calib.hstbd)}°. Tack now, then hold steady on port.`;
    beep(660, 300);
    return;
  }

  const hport = circularMeanDeg(calib.samples);
  clearInterval(calib.interval);
  calib.active = false;
  calibStartBtn.textContent = 'Calibrate: Sail Both Tacks';
  if (hport == null) { calibStatusEl.textContent = 'No GPS samples on port tack - were you sailing? Try again.'; return; }

  const tackAngleDeg = Math.round(Math.abs(angleDiff(calib.hstbd, hport)));
  const windDir = Math.round(circularMeanDeg([calib.hstbd, hport]));
  state.windDir = windDir;
  state.windSource = 'auto';
  state.tackAngleDeg = tackAngleDeg;
  state.tackAngleSource = 'auto';
  windInput.value = windDir;
  updateLineReadout();
  lastNotifiedWindDir = windDir;
  updateWindStatus();
  calibStatusEl.textContent = 'Calibration complete';
  calibDetailEl.textContent = `Tack angle ${tackAngleDeg}° | Wind set to ${windDir}° (stbd ${Math.round(calib.hstbd)}°, port ${Math.round(hport)}°)`;
  saveSettings();
}

calibStartBtn.addEventListener('click', () => {
  if (calib.active) cancelCalibration();
  else startCalibration();
});

document.querySelectorAll('[data-calib-nudge]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const durationInput = document.getElementById('calib-duration');
    const delta = parseInt(btn.dataset.calibNudge, 10);
    const next = Math.min(180, Math.max(15, (parseInt(durationInput.value, 10) || 45) + delta));
    durationInput.value = next;
    saveSettings();
  });
});

/* ---------- start line ---------- */
const lineReadoutEl = document.getElementById('line-readout');
const burnValueEl = document.getElementById('burn-value');

// Line-end markers are draggable so a GPS ping can be nudged to the actual
// pin/boat position afterward (GPS accuracy at the moment of pinging isn't
// always exact). Custom pointer-based drag rather than Leaflet's native
// `draggable: true` - for the same reason map panning is custom above: a
// raw screen delta needs rotating into the pane's own coordinate space
// before it means anything, once the map is rotated off north-up.
function wireLineEndDrag(marker, applyPosition) {
  const el = marker.getElement();
  if (!el) return;
  el.style.cursor = 'grab';
  let dragState = null; // {x, y, pointerId}

  el.addEventListener('pointerdown', (ev) => {
    if (!ev.isPrimary) return;
    ev.stopPropagation(); // don't also start a map pan on the same touch
    dragState = { x: ev.clientX, y: ev.clientY, pointerId: ev.pointerId };
    el.setPointerCapture(ev.pointerId);
    el.style.cursor = 'grabbing';
  });

  el.addEventListener('pointermove', (ev) => {
    if (!dragState || ev.pointerId !== dragState.pointerId) return;
    const dx = ev.clientX - dragState.x;
    const dy = ev.clientY - dragState.y;
    dragState.x = ev.clientX;
    dragState.y = ev.clientY;
    const rotated = rotateVector(dx, dy, -currentMapRotationDeg());
    const layerPoint = map.latLngToLayerPoint(marker.getLatLng()).add(L.point(rotated.x, rotated.y));
    marker.setLatLng(map.layerPointToLatLng(layerPoint));
  });

  function endDrag(ev) {
    if (!dragState || ev.pointerId !== dragState.pointerId) return;
    dragState = null;
    el.style.cursor = 'grab';
    const { lat, lng } = marker.getLatLng();
    applyPosition({ lat, lon: lng });
    redrawLine();
    updateLineReadout();
  }
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
}

document.getElementById('ping-pin').addEventListener('click', () => {
  if (!state.lastFix) return;
  state.pin = { lat: state.lastFix.lat, lon: state.lastFix.lon };
  if (pinMarker) map.removeLayer(pinMarker);
  pinMarker = L.marker([state.pin.lat, state.pin.lon], { icon: lineEndIcon('P'), title: 'Pin' }).addTo(map);
  wireLineEndDrag(pinMarker, (p) => { state.pin = p; });
  redrawLine();
  updateLineReadout();
});

document.getElementById('ping-boat').addEventListener('click', () => {
  if (!state.lastFix) return;
  state.boat = { lat: state.lastFix.lat, lon: state.lastFix.lon };
  if (boatEndMarker) map.removeLayer(boatEndMarker);
  boatEndMarker = L.marker([state.boat.lat, state.boat.lon], { icon: lineEndIcon('CB'), title: 'Committee Boat' }).addTo(map);
  wireLineEndDrag(boatEndMarker, (p) => { state.boat = p; });
  redrawLine();
  updateLineReadout();
});

document.getElementById('clear-line').addEventListener('click', () => {
  state.pin = null;
  state.boat = null;
  if (pinMarker) { map.removeLayer(pinMarker); pinMarker = null; }
  if (boatEndMarker) { map.removeLayer(boatEndMarker); boatEndMarker = null; }
  redrawLine();
  lineReadoutEl.textContent = 'No line set';
  burnValueEl.textContent = '--';
  if (viewedSessionLayer) { map.removeLayer(viewedSessionLayer); viewedSessionLayer = null; }
});

// Shows a past recorded session's track on the Route map (its own layer,
// separate from the live track/line so it can't be mistaken for either) -
// not a replay, just a static overview of where that session went.
function viewSession(session) {
  switchPage('route');
  if (viewedSessionLayer) { map.removeLayer(viewedSessionLayer); viewedSessionLayer = null; }
  const pts = session.points.filter((p) => p.lat != null).map((p) => [p.lat, p.lon]);
  if (pts.length === 0) return;
  const layers = [L.polyline(pts, { color: LINE_COLOR, weight: 3 })];
  if (session.line) {
    layers.push(L.polyline(
      [[session.line.pin.lat, session.line.pin.lon], [session.line.boat.lat, session.line.boat.lon]],
      { color: LINE_COLOR, weight: 2, dashArray: '4 4', opacity: 0.6 },
    ));
  }
  viewedSessionLayer = L.layerGroup(layers).addTo(map);
  map.fitBounds(L.latLngBounds(pts), { padding: [20, 20] });
}

// Perpendicular distance (m) from `p` to the line pin->boat, and whether
// p is on the pre-start (line) side. Positive = short of the line.
function distanceToLine(p) {
  const refLat = state.pin.lat;
  const P = project(p.lat, p.lon, refLat);
  const A = project(state.pin.lat, state.pin.lon, refLat);
  const B = project(state.boat.lat, state.boat.lon, refLat);
  const ABx = B.x - A.x, ABy = B.y - A.y;
  const APx = P.x - A.x, APy = P.y - A.y;
  const lenSq = ABx * ABx + ABy * ABy || 1;
  const cross = ABx * APy - ABy * APx; // signed area *2
  const dist = Math.abs(cross) / Math.sqrt(lenSq);
  const side = Math.sign(cross); // consistent sign convention for "which side"
  return { dist, side };
}

function lineBias() {
  const lineBearing = bearing(state.pin, state.boat); // pin -> boat
  // The end further upwind (more into the wind) is favoured.
  // Perpendicular-to-wind bearing defines a "square" line; bias = how far
  // the actual line deviates from square, signed toward the favoured end.
  const squareBearing = (state.windDir + 90) % 360;
  let diff = angleDiff(lineBearing, squareBearing); // deg off square
  return diff; // + favors boat end, - favors pin end (roughly)
}

function updateLineReadout() {
  if (!state.pin || !state.boat) return;
  const lineLenM = haversine(state.pin, state.boat);
  const bias = lineBias();
  const favored = Math.abs(bias) < 2 ? 'square' : (bias > 0 ? 'boat end favored' : 'pin end favored');
  lineReadoutEl.textContent =
    `${lineLenM.toFixed(0)}m | bias ${Math.abs(bias).toFixed(0)}° (${favored})`;

  if (state.lastFix) {
    const { dist } = distanceToLine(state.lastFix);
    let burnText = `dist ${dist.toFixed(0)}m`;
    if (state.timerEndAt && state.speedKn > 0.3) {
      const closingSpeedMs = state.speedKn / MS_TO_KNOTS;
      const timeToLineS = dist / closingSpeedMs;
      const timeToStartS = (state.timerEndAt - Date.now()) / 1000;
      const burnS = timeToStartS - timeToLineS;
      burnText = (burnS >= 0 ? '+' : '') + burnS.toFixed(0) + 's';
    }
    burnValueEl.textContent = burnText;
  }
}

/* ---------- tack detection ---------- */
function detectTack(cog) {
  if (state.speedKn < MOVING_MIN_SPEED_KN) return; // ignore noise while stopped/drifting
  const rel = angleDiff(cog, state.windDir); // -180..180, sign = side of wind axis
  const side = rel > 0 ? 'stbd' : 'port';
  if (state.lastTackSide === null) {
    state.lastTackSide = side;
    return;
  }
  const now = Date.now();
  if (side !== state.lastTackSide && Math.abs(rel) > TACK_HYSTERESIS_DEG && (now - state.lastTackAt) > TACK_MIN_INTERVAL_MS) {
    state.lastTackSide = side;
    state.lastTackAt = now;
    if (state.recording) {
      state.track.push({ event: 'tack', t: now, cog, windDir: state.windDir });
    }
  }
}

/* ---------- auto wind from tacking + header/lifter alerts ---------- */
// Continuously re-derives true wind direction from the average heading held
// on each tack within a rolling window (same bisector math as the manual
// calibration flow), so wind keeps correcting itself as you sail without
// needing to stop and recalibrate every shift.
const windStatusEl = document.getElementById('wind-status');
const shiftBannerEl = document.getElementById('shift-banner');
let shiftBannerTimeout = null;
let lastNotifiedWindDir = null;

function recordHeadingSample(t, cog, speedKn) {
  if (speedKn < MOVING_MIN_SPEED_KN) return;
  state.headingLog.push({ t, cog });
  const cutoff = t - HEADING_LOG_MAX_AGE_MS;
  while (state.headingLog.length && state.headingLog[0].t < cutoff) state.headingLog.shift();
}

function updateAutoWind() {
  if (!state.autoWindEnabled || calib.active) { updateWindStatus(); return; }

  const cutoff = Date.now() - state.autoWindWindowMin * 60 * 1000;
  const stbd = [];
  const port = [];
  for (const sample of state.headingLog) {
    if (sample.t < cutoff) continue;
    const rel = angleDiff(sample.cog, state.windDir);
    (rel > 0 ? stbd : port).push(sample.cog);
  }
  if (stbd.length < AUTO_WIND_MIN_SAMPLES || port.length < AUTO_WIND_MIN_SAMPLES) { updateWindStatus(); return; }

  const meanStbd = circularMeanDeg(stbd);
  const meanPort = circularMeanDeg(port);
  const newWindDir = Math.round(circularMeanDeg([meanStbd, meanPort]));
  const newTackAngle = Math.round(Math.abs(angleDiff(meanStbd, meanPort)));

  // Manual overrides (typed wind or tack angle) are locked independently -
  // auto-wind keeps computing in the background but won't write over a
  // locked field, so a typed value doesn't get silently clobbered.
  if (state.windSource !== 'manual') {
    if (lastNotifiedWindDir === null) lastNotifiedWindDir = state.windDir;
    checkForShift(newWindDir);
    state.windDir = newWindDir;
    windInput.value = newWindDir;
  }
  if (state.tackAngleSource !== 'manual') {
    state.tackAngleDeg = newTackAngle;
  }
  updateLineReadout();
  updateWindStatus();
}

function checkForShift(newWindDir) {
  const shift = angleDiff(newWindDir, lastNotifiedWindDir);
  if (Math.abs(shift) < SHIFT_NOTICE_MIN_DEG || !state.lastTackSide) return;
  const isLift = (state.lastTackSide === 'stbd') ? (shift > 0) : (shift < 0);
  showShiftBanner(isLift, Math.round(Math.abs(shift)));
  lastNotifiedWindDir = newWindDir;
}

function showShiftBanner(isLift, degrees) {
  shiftBannerEl.textContent = `${isLift ? 'LIFT' : 'HEADER'} ${degrees}°`;
  shiftBannerEl.className = 'shift-banner ' + (isLift ? 'lift' : 'header');
  shiftBannerEl.hidden = false;
  beep(isLift ? 1000 : 500, 250);
  if (shiftBannerTimeout) clearTimeout(shiftBannerTimeout);
  shiftBannerTimeout = setTimeout(() => { shiftBannerEl.hidden = true; }, 8000);
}

function updateWindStatus() {
  const tackTxt = state.tackAngleDeg != null
    ? `${state.tackAngleDeg}°${state.tackAngleSource === 'manual' ? ' (manual)' : ''}`
    : '--';
  const windTxt = `${Math.round(state.windDir)}°${state.windSource === 'manual' ? ' (manual)' : ''}`;
  windStatusEl.textContent = `Wind: ${windTxt} | Tack: ${tackTxt}`;

  if (state.tackAngleDeg != null && document.activeElement !== tackAngleInput) {
    tackAngleInput.value = state.tackAngleDeg;
  }
  if (state.cog != null) updateWindNeedle(state.cog);
}

updateWindStatus();

document.getElementById('auto-wind-enabled').addEventListener('change', (e) => {
  state.autoWindEnabled = e.target.checked;
  if (e.target.checked) {
    // Re-enabling auto-wind is an explicit "trust it again" action - release
    // any manual locks so it actually resumes updating.
    state.windSource = 'auto';
    state.tackAngleSource = 'auto';
  }
  updateWindStatus();
  saveSettings();
});

function setAutoWindWindow(minutes) {
  state.autoWindWindowMin = Math.min(10, Math.max(1, minutes));
  document.getElementById('auto-wind-window').value = state.autoWindWindowMin;
  saveSettings();
}
document.getElementById('auto-wind-window').addEventListener('change', (e) => {
  setAutoWindWindow(parseInt(e.target.value, 10) || 4);
});
document.querySelectorAll('[data-window-nudge]').forEach((btn) => {
  btn.addEventListener('click', () => {
    setAutoWindWindow(state.autoWindWindowMin + parseInt(btn.dataset.windowNudge, 10));
  });
});

/* ---------- countdown timer ---------- */
const timerEl = document.getElementById('timer-value');
let beepCtx = null;

function beep(freq = 880, durationMs = 200) {
  try {
    beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = beepCtx.createOscillator();
    const gain = beepCtx.createGain();
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(beepCtx.destination);
    osc.start();
    gain.gain.setValueAtTime(0.3, beepCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, beepCtx.currentTime + durationMs / 1000);
    osc.stop(beepCtx.currentTime + durationMs / 1000);
  } catch (e) { /* audio unavailable, ignore */ }
}

// RRS start-sequence sound signals at 5/4/1/0 minutes to go. Sync (below) can
// jump `timerEndAt` forwards or backwards at any time, so marks are fired by
// detecting a downward crossing against the previous tick's remaining time
// rather than exact-equality against a mark - that way a sync backward
// re-arms a mark that already fired, and a sync forward past a mark simply
// skips it (correct - that signal's moment has passed), with no separate
// "already fired" bookkeeping to keep in sync with the jump.
const START_MARKS_S = [300, 240, 60, 0];
let prevRemainingS = null;

function tickTimer() {
  if (!state.timerEndAt) return;
  const remainingMs = state.timerEndAt - Date.now();
  const remainingS = Math.max(0, Math.ceil(remainingMs / 1000));
  const m = Math.floor(remainingS / 60);
  const s = remainingS % 60;
  timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
  timerEl.classList.toggle('warn', remainingS <= 60 && remainingS > 0);
  timerEl.classList.toggle('go', remainingS === 0);

  if (prevRemainingS != null) {
    START_MARKS_S.forEach((mark) => {
      if (prevRemainingS > mark && remainingS <= mark) {
        beep(mark === 0 ? 1200 : 880, mark === 0 ? 400 : 200);
      }
    });
  }
  prevRemainingS = remainingS;

  updateLineReadout();

  if (remainingMs <= 0) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}

const startSyncBtn = document.getElementById('timer-startsync');

function startTimer() {
  state.timerEndAt = Date.now() + 5 * 60 * 1000;
  prevRemainingS = 301; // guarantees the 5:00 mark fires on the first tick
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = setInterval(tickTimer, 250);
  startSyncBtn.textContent = 'Sync';
  tickTimer();
}

function syncTimer() {
  // Snap the countdown to whichever of the 5/4/1-minute marks is nearest -
  // computed in remaining-time space, not wall-clock, so it means the same
  // thing regardless of when it's pressed.
  if (!state.timerEndAt) return;
  const remainingS = (state.timerEndAt - Date.now()) / 1000;
  const marks = [300, 240, 60];
  const nearest = marks.reduce((best, m) =>
    Math.abs(remainingS - m) < Math.abs(remainingS - best) ? m : best, marks[0]);
  state.timerEndAt = Date.now() + nearest * 1000;
  tickTimer();
}

startSyncBtn.addEventListener('click', () => {
  if (!state.timerEndAt) startTimer();
  else syncTimer();
});

// Generic hold-to-confirm wiring (same mechanic as the screen-lock unlock
// button): a fill bar animates over `holdMs`, and `onConfirm` fires only if
// the hold completes - used anywhere a stray tap must not trigger something
// destructive (timer reset, deleting a recorded session, ...). `btn` must
// contain a `.fill` element as its animated bar.
function wireHoldToConfirm(btn, holdMs, onConfirm) {
  const fill = btn.querySelector('.fill');
  let holdTimer = null;

  function fillIdle() {
    fill.style.transition = 'none';
    fill.style.width = '0%';
  }

  function start(e) {
    e.preventDefault();
    fill.style.transition = `width ${holdMs}ms linear`;
    requestAnimationFrame(() => { fill.style.width = '100%'; });
    holdTimer = setTimeout(() => { fillIdle(); onConfirm(); }, holdMs);
  }

  function cancel() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    fillIdle();
  }

  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', cancel);
  btn.addEventListener('pointerleave', cancel);
  btn.addEventListener('pointercancel', cancel);
}

const resetBtn = document.getElementById('timer-reset');
wireHoldToConfirm(resetBtn, 1200, () => {
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = null;
  state.timerEndAt = null;
  prevRemainingS = null;
  timerEl.textContent = '5:00';
  timerEl.classList.remove('warn', 'go');
  burnValueEl.textContent = '--';
  startSyncBtn.textContent = 'Start 5:00';
});

/* ---------- recording ---------- */
const recordBtn = document.getElementById('record-toggle');
const recordReadoutEl = document.getElementById('record-readout');
let wakeLock = null;

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* not supported / denied, ignore */ }
}
document.addEventListener('visibilitychange', async () => {
  if ((state.recording || state.locked) && document.visibilityState === 'visible') await acquireWakeLock();
});

/* ---------- screen lock ---------- */
// Keeps the display on and blocks all touches except a hold-to-unlock
// button, so spray/rain on the screen during a race can't trigger buttons.
const LOCK_HOLD_MS = 1200;
const lockToggleBtn = document.getElementById('lock-toggle');
const lockOverlay = document.getElementById('lock-overlay');
const unlockBtn = document.getElementById('unlock-btn');
const unlockFill = unlockBtn.querySelector('.fill');
let unlockTimer = null;

function enterLock() {
  state.locked = true;
  lockOverlay.hidden = false;
  acquireWakeLock();
}

function exitLock() {
  state.locked = false;
  lockOverlay.hidden = true;
  resetUnlockHold();
  if (!state.recording && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

function resetUnlockHold() {
  unlockFill.style.transition = 'none';
  unlockFill.style.width = '0%';
}

function startUnlockHold(e) {
  e.preventDefault();
  unlockFill.style.transition = `width ${LOCK_HOLD_MS}ms linear`;
  requestAnimationFrame(() => { unlockFill.style.width = '100%'; });
  unlockTimer = setTimeout(exitLock, LOCK_HOLD_MS);
}

function cancelUnlockHold() {
  if (unlockTimer) { clearTimeout(unlockTimer); unlockTimer = null; }
  resetUnlockHold();
}

lockToggleBtn.addEventListener('click', enterLock);
unlockBtn.addEventListener('pointerdown', startUnlockHold);
unlockBtn.addEventListener('pointerup', cancelUnlockHold);
unlockBtn.addEventListener('pointerleave', cancelUnlockHold);
unlockBtn.addEventListener('pointercancel', cancelUnlockHold);

/* ---------- instruments layout (edit mode) ---------- */
// "Android home screen" style block layout: each instrument tile is a block
// on a 4-column grid at {x, y, w, h} (0-indexed cells). Positioning is done
// entirely via inline grid-column/grid-row on the existing .tile elements -
// their inner markup/IDs are never touched, so app.js's live GPS/timer/heel
// wiring elsewhere (which queries those IDs directly) is unaffected by
// anything in this section.
const LAYOUT_COLS = 4;
// Real ceiling, not a generous placeholder: the Instruments page doesn't
// scroll (see #page-instruments/#instr-grid in style.css), so only as many
// rows as actually fit the visible grid height can ever be placed - anything
// that doesn't fit stays in the tray until something else is removed.
// Recomputed by updateMaxRows() since it depends on live viewport height.
let LAYOUT_MAX_ROWS = 6;
const MAX_BLOCK_H = 6;

// Per-block minimum size in cells. Not a uniform 2x2 - the timer block has a
// big numeric readout plus two full-width buttons and the line block needs
// full width for its distance/bias text, so both need more room than a
// single-readout tile like SOG/COG/HEEL.
const BLOCK_MIN = {
  sog: { w: 2, h: 2 },
  cog: { w: 2, h: 2 },
  heel: { w: 2, h: 2 },
  timer: { w: 4, h: 4 },
  line: { w: 4, h: 2 },
  compass: { w: 2, h: 2 },
};

const BLOCK_LABELS = {
  sog: 'SOG', cog: 'COG', heel: 'HEEL', timer: 'START TIMER', line: 'LINE',
  compass: 'WIND',
};

// Recreates today's fixed arrangement: SOG wide, COG+HEEL side by side,
// START TIMER wide, LINE wide. Compass is an opt-in extra (drag it in from
// the tray in edit mode) - hidden by default so it doesn't suddenly appear
// on an existing saved layout.
const DEFAULT_LAYOUT = [
  { id: 'sog', x: 0, y: 0, w: 4, h: 2, hidden: false },
  { id: 'cog', x: 0, y: 2, w: 2, h: 2, hidden: false },
  { id: 'heel', x: 2, y: 2, w: 2, h: 2, hidden: false },
  { id: 'timer', x: 0, y: 4, w: 4, h: 4, hidden: false },
  { id: 'line', x: 0, y: 8, w: 4, h: 2, hidden: false },
  { id: 'compass', x: 0, y: 10, w: 2, h: 2, hidden: true },
];

const LAYOUT_KEY = 'rc_layout';
let layout = DEFAULT_LAYOUT.map((b) => ({ ...b }));

const instrGrid = document.getElementById('instr-grid');
const layoutEditToggle = document.getElementById('layout-edit-toggle');
let editMode = false;

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// Would `candidate` (a block's proposed new x/y/w/h) fit on the grid without
// overlapping any other visible block? No reflow/compaction - a blocked drop
// is simply rejected and the caller snaps the block back (except the narrow
// same-size swap case handled separately in startBlockMove). Hidden blocks
// are excluded entirely - their cells are free for anything else, otherwise
// hiding a tile would leave an invisible collision nobody can see or debug.
function fits(candidate, excludeId) {
  if (candidate.x < 0 || candidate.y < 0) return false;
  if (candidate.x + candidate.w > LAYOUT_COLS) return false;
  if (candidate.y + candidate.h > LAYOUT_MAX_ROWS) return false;
  return !layout.some((b) => b.id !== excludeId && !b.hidden && rectsOverlap(candidate, b));
}

// Cell-area of the overlap between two {x,y,w,h} rects (0 if they don't touch).
function overlapArea(a, b) {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return w * h;
}

// "Hover over more than 40% of one tile and it moves out of the way": a
// narrow, deterministic special case, not a general reflow solver. Only
// swaps when the drop overlaps exactly one other same-size visible block by
// at least 40% of that block's area - anything else (different sizes,
// multiple tiles overlapped, out of bounds) falls through to reject-and-
// revert, same as any other blocked drop.
function findSwapTarget(candidate, excludeId) {
  const overlapped = layout.filter((b) => b.id !== excludeId && !b.hidden && rectsOverlap(candidate, b));
  if (overlapped.length !== 1) return null;
  const target = overlapped[0];
  if (target.w !== candidate.w || target.h !== candidate.h) return null;
  if (overlapArea(candidate, target) / (target.w * target.h) < 0.4) return null;
  return target;
}

// Bigger blocks get bigger readouts, smaller blocks get smaller ones: scale
// is 1 at a block's *default* size (so the stock layout renders exactly like
// today's fixed one) and moves with the square root of the area ratio -
// clamped so a huge block doesn't blow past its container and a tiny one
// doesn't shrink to nothing.
function scaleFor(block) {
  const base = DEFAULT_LAYOUT.find((d) => d.id === block.id);
  const ratio = (block.w * block.h) / (base.w * base.h);
  return clamp(Math.sqrt(ratio), 0.6, 1.6);
}

function applyLayout() {
  layout.forEach((b) => {
    const el = instrGrid.querySelector(`.tile[data-block="${b.id}"]`);
    if (!el) return;
    el.style.display = b.hidden ? 'none' : '';
    if (b.hidden) return;
    el.style.gridColumn = `${b.x + 1} / span ${b.w}`;
    el.style.gridRow = `${b.y + 1} / span ${b.h}`;
    el.style.setProperty('--tile-scale', scaleFor(b).toFixed(2));
  });
}

function saveLayout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (e) { /* storage unavailable, ignore */ }
}

function loadLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Merge per-block rather than all-or-nothing: a block id missing
        // from the stored layout (an older save from before it existed, or
        // corrupt data for just that entry) falls back to its own default
        // instead of discarding every other block's saved position too.
        layout = DEFAULT_LAYOUT.map((d) => {
          const stored = parsed.find((p) => p && p.id === d.id);
          if (!stored) return { ...d };
          const min = BLOCK_MIN[d.id];
          const w = clamp(Math.round(stored.w) || d.w, min.w, LAYOUT_COLS);
          const h = clamp(Math.round(stored.h) || d.h, min.h, MAX_BLOCK_H);
          return {
            id: d.id,
            x: clamp(Math.round(stored.x) || 0, 0, LAYOUT_COLS - w),
            y: clamp(Math.round(stored.y) || 0, 0, LAYOUT_MAX_ROWS - h),
            w, h,
            hidden: !!stored.hidden,
          };
        });
      }
    }
  } catch (e) { /* corrupt storage, keep default */ }
  applyLayout();
  renderTray();
}

// Scans row-by-row for the first free spot a w x h block would fit in - used
// when un-hiding a block whose old/default position is now occupied by
// something else. No reflow of anything already placed, same as a normal
// blocked drag: this only searches for empty space, it never displaces
// another block to make room.
function findFreeSpot(w, h, excludeId) {
  for (let y = 0; y <= LAYOUT_MAX_ROWS - h; y++) {
    for (let x = 0; x <= LAYOUT_COLS - w; x++) {
      const candidate = { x, y, w, h };
      if (fits(candidate, excludeId)) return candidate;
    }
  }
  return null;
}

// Un-hides a block at its default position/size, falling back to the first
// free spot if that's occupied. Used only as the tap fallback for a tray
// chip (a real drag targets a specific cell instead - see wireTrayChipDrag).
function unhideBlockAtDefault(id) {
  const block = layout.find((b) => b.id === id);
  const def = DEFAULT_LAYOUT.find((d) => d.id === id);
  if (!block || !def) return;
  block.w = def.w;
  block.h = def.h;
  const atDefault = { x: def.x, y: def.y, w: block.w, h: block.h };
  const spot = fits(atDefault, id) ? atDefault : findFreeSpot(block.w, block.h, id);
  if (!spot) return; // no room anywhere right now - stays in the tray
  block.x = spot.x;
  block.y = spot.y;
  block.hidden = false;
  applyLayout();
  saveLayout();
  renderTray();
}

const instrumentTrayEl = document.getElementById('instrument-tray');
const hiddenTilesListEl = document.getElementById('hidden-tiles-list');
const DRAG_THRESHOLD_PX = 8; // below this, a tray-chip pointer sequence counts as a tap, not a drag

function renderTray() {
  const hidden = layout.filter((b) => b.hidden);
  instrumentTrayEl.hidden = !editMode || hidden.length === 0;
  hiddenTilesListEl.innerHTML = '';
  hidden.forEach((b) => {
    const chip = document.createElement('div');
    chip.className = 'tray-chip';
    chip.textContent = BLOCK_LABELS[b.id] || b.id;
    wireTrayChipDrag(chip, b.id);
    hiddenTilesListEl.appendChild(chip);
  });
}

// Drags a tray chip up onto the grid to place it at the dropped cell; a tap
// (movement under DRAG_THRESHOLD_PX) falls back to unhideBlockAtDefault.
function wireTrayChipDrag(chip, id) {
  let dragState = null; // {startX, startY, moved, ghost}

  chip.addEventListener('pointerdown', (ev) => {
    dragState = { startX: ev.clientX, startY: ev.clientY, moved: false, pointerId: ev.pointerId };
    chip.setPointerCapture(ev.pointerId);
  });

  chip.addEventListener('pointermove', (ev) => {
    if (!dragState || ev.pointerId !== dragState.pointerId) return;
    const dx = ev.clientX - dragState.startX;
    const dy = ev.clientY - dragState.startY;
    if (!dragState.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      dragState.moved = true;
      dragState.ghost = createDragGhost(id);
    }
    if (dragState.ghost) {
      dragState.ghost.style.left = `${ev.clientX}px`;
      dragState.ghost.style.top = `${ev.clientY}px`;
    }
  });

  function endDrag(ev) {
    if (!dragState || ev.pointerId !== dragState.pointerId) return;
    if (dragState.ghost) {
      dragState.ghost.remove();
      tryDropTrayChip(id, ev.clientX, ev.clientY);
    } else if (!dragState.moved) {
      unhideBlockAtDefault(id);
    }
    dragState = null;
  }
  chip.addEventListener('pointerup', endDrag);
  chip.addEventListener('pointercancel', endDrag);
}

function createDragGhost(id) {
  const def = DEFAULT_LAYOUT.find((d) => d.id === id);
  const { gap, cellW, cellH } = gridMetrics();
  const ghost = document.createElement('div');
  ghost.className = 'tile drag-ghost';
  ghost.style.width = `${def.w * cellW + (def.w - 1) * gap}px`;
  ghost.style.height = `${def.h * cellH + (def.h - 1) * gap}px`;
  ghost.innerHTML = `<div class="tile-label">${BLOCK_LABELS[id] || id}</div>`;
  document.body.appendChild(ghost);
  return ghost;
}

function tryDropTrayChip(id, clientX, clientY) {
  const rect = instrGrid.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return; // dropped outside the grid - stays in the tray
  }
  const def = DEFAULT_LAYOUT.find((d) => d.id === id);
  const { gap, cellW, cellH } = gridMetrics();
  // Pointer = the dropped block's center.
  const localX = clientX - rect.left - (def.w * cellW + (def.w - 1) * gap) / 2;
  const localY = clientY - rect.top - (def.h * cellH + (def.h - 1) * gap) / 2;
  const candidate = {
    x: clamp(Math.round(localX / (cellW + gap)), 0, LAYOUT_COLS - def.w),
    y: clamp(Math.round(localY / (cellH + gap)), 0, LAYOUT_MAX_ROWS - def.h),
    w: def.w, h: def.h,
  };
  if (!fits(candidate, id)) return; // occupied/out of bounds - stays in the tray

  const block = layout.find((b) => b.id === id);
  block.w = def.w;
  block.h = def.h;
  block.x = candidate.x;
  block.y = candidate.y;
  block.hidden = false;
  applyLayout();
  saveLayout();
  renderTray();
}

// Real ceiling for how many grid rows actually fit without the (deliberately
// non-scrolling) Instruments page overflowing - depends on live viewport
// height, so it's recomputed rather than a fixed constant.
function updateMaxRows() {
  const { gap, cellH } = gridMetrics();
  const rect = instrGrid.getBoundingClientRect();
  if (rect.height === 0) return; // page hidden - nothing to measure yet
  LAYOUT_MAX_ROWS = Math.max(1, Math.floor((rect.height + gap) / (cellH + gap)));
}

layoutEditToggle.addEventListener('click', () => {
  editMode = !editMode;
  instrGrid.classList.toggle('edit-mode', editMode);
  layoutEditToggle.textContent = editMode ? 'Done' : 'Edit';
  updateMaxRows();
  renderTray();
});

window.addEventListener('resize', () => {
  if (document.getElementById('page-instruments').classList.contains('active')) updateMaxRows();
});

// Cell geometry, measured live (not hardcoded) so it stays correct across
// orientation changes / different phones. Row height comes from the same
// --cell-h custom property the CSS grid itself uses, so JS's drag math and
// the actual rendered grid can never drift apart.
function gridMetrics() {
  const rect = instrGrid.getBoundingClientRect();
  const style = getComputedStyle(instrGrid);
  const gap = parseFloat(style.rowGap) || 10;
  const cellW = (rect.width - gap * (LAYOUT_COLS - 1)) / LAYOUT_COLS;
  const cellH = parseFloat(style.getPropertyValue('--cell-h')) || 56;
  return { gap, cellW, cellH };
}

function flashReject(tile) {
  tile.classList.remove('reject'); // restart the animation if triggered twice quickly
  void tile.offsetWidth; // force reflow so removing+re-adding the class replays the keyframes
  tile.classList.add('reject');
}

function startBlockMove(tile, block, downEvent) {
  downEvent.preventDefault();
  const { gap, cellW, cellH } = gridMetrics();
  const gridRect = instrGrid.getBoundingClientRect();
  const startX = downEvent.clientX, startY = downEvent.clientY;
  const orig = { x: block.x, y: block.y };
  let dCellsX = 0, dCellsY = 0;
  let overRemoveZone = false;

  tile.classList.add('dragging');
  tile.setPointerCapture(downEvent.pointerId);

  function onMove(ev) {
    const dxPx = ev.clientX - startX;
    const dyPx = ev.clientY - startY;
    dCellsX = Math.round(dxPx / (cellW + gap));
    dCellsY = Math.round(dyPx / (cellH + gap));
    tile.style.transform = `translate(${dxPx}px, ${dyPx}px)`;
    // Drag a tile above the grid's own top edge to remove it - same idea as
    // dragging an app icon to "Remove" on a phone home screen.
    overRemoveZone = ev.clientY < gridRect.top;
    tile.classList.toggle('will-remove', overRemoveZone);
  }

  function onUp() {
    tile.removeEventListener('pointermove', onMove);
    tile.removeEventListener('pointerup', onUp);
    tile.removeEventListener('pointercancel', onUp);
    tile.classList.remove('dragging', 'will-remove');
    tile.style.transform = '';

    if (overRemoveZone) {
      block.hidden = true;
      applyLayout();
      saveLayout();
      renderTray();
      return;
    }

    const candidate = {
      x: clamp(orig.x + dCellsX, 0, LAYOUT_COLS - block.w),
      y: clamp(orig.y + dCellsY, 0, LAYOUT_MAX_ROWS - block.h),
      w: block.w, h: block.h,
    };
    const moved = candidate.x !== orig.x || candidate.y !== orig.y;
    if (!moved) return;

    if (fits(candidate, block.id)) {
      block.x = candidate.x;
      block.y = candidate.y;
      applyLayout();
      saveLayout();
      return;
    }

    const swapTarget = findSwapTarget(candidate, block.id);
    if (swapTarget) {
      const swapOrig = { x: swapTarget.x, y: swapTarget.y };
      swapTarget.x = orig.x;
      swapTarget.y = orig.y;
      block.x = swapOrig.x;
      block.y = swapOrig.y;
      applyLayout();
      saveLayout();
      return;
    }

    flashReject(tile); // blocked by another tile or the grid edge - snap back (no auto-reflow)
  }

  tile.addEventListener('pointermove', onMove);
  tile.addEventListener('pointerup', onUp);
  tile.addEventListener('pointercancel', onUp);
}

function startBlockResize(tile, block, downEvent) {
  downEvent.preventDefault();
  downEvent.stopPropagation(); // don't also trigger startBlockMove on the parent tile
  const min = BLOCK_MIN[block.id];
  const { gap, cellW, cellH } = gridMetrics();
  const startX = downEvent.clientX, startY = downEvent.clientY;
  const orig = { w: block.w, h: block.h };
  let w = orig.w, h = orig.h;

  const handleEl = downEvent.target; // capture once - onMove/onUp must (de)register on this exact element
  tile.classList.add('dragging');
  tile.style.zIndex = 10;
  handleEl.setPointerCapture(downEvent.pointerId);

  function onMove(ev) {
    const dxPx = ev.clientX - startX;
    const dyPx = ev.clientY - startY;
    w = clamp(orig.w + Math.round(dxPx / (cellW + gap)), min.w, LAYOUT_COLS - block.x);
    h = clamp(orig.h + Math.round(dyPx / (cellH + gap)), min.h, MAX_BLOCK_H);
    // Live preview in px, independent of the block's actual grid track, so
    // growing the block visually overlaps neighbours during the drag itself
    // (purely cosmetic feedback) - final placement is only decided on release.
    tile.style.width = `${w * cellW + (w - 1) * gap}px`;
    tile.style.height = `${h * cellH + (h - 1) * gap}px`;
  }

  function onUp() {
    handleEl.removeEventListener('pointermove', onMove);
    handleEl.removeEventListener('pointerup', onUp);
    handleEl.removeEventListener('pointercancel', onUp);
    tile.classList.remove('dragging');
    tile.style.zIndex = '';
    tile.style.width = '';
    tile.style.height = '';

    const candidate = { x: block.x, y: block.y, w, h };
    const resized = w !== orig.w || h !== orig.h;
    if (resized && fits(candidate, block.id)) {
      block.w = w;
      block.h = h;
      applyLayout();
      saveLayout();
    } else if (resized) {
      flashReject(tile);
    }
  }

  handleEl.addEventListener('pointermove', onMove);
  handleEl.addEventListener('pointerup', onUp);
  handleEl.addEventListener('pointercancel', onUp);
}

instrGrid.querySelectorAll('.tile[data-block]').forEach((tile) => {
  const id = tile.dataset.block;
  const handle = tile.querySelector('.resize-handle');

  tile.addEventListener('pointerdown', (e) => {
    if (!editMode || e.target.closest('.resize-handle') || e.target.closest('.tile-remove-btn')) return;
    const block = layout.find((b) => b.id === id);
    startBlockMove(tile, block, e);
  });

  handle.addEventListener('pointerdown', (e) => {
    if (!editMode) return;
    const block = layout.find((b) => b.id === id);
    startBlockResize(tile, block, e);
  });

  // Injected in JS rather than added to each tile's HTML individually - that
  // markup is hand-duplicated per instrument and easy to get subtly wrong
  // (or, worse, to accidentally clobber one of the live-readout ids nested
  // inside it) across 5 near-identical blocks.
  const removeBtn = document.createElement('button');
  removeBtn.className = 'tile-remove-btn';
  removeBtn.type = 'button';
  removeBtn.textContent = '✕'; // multiplication-x
  removeBtn.title = `Remove ${BLOCK_LABELS[id] || id}`;
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const block = layout.find((b) => b.id === id);
    if (!block) return;
    block.hidden = true;
    applyLayout();
    saveLayout();
    renderTray();
  });
  tile.appendChild(removeBtn);
});

function trackDistanceM(points) {
  let d = 0;
  const pts = points.filter(p => p.lat != null);
  for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1], pts[i]);
  return d;
}

function updateRecordReadout() {
  const elapsedS = Math.round((Date.now() - state.sessionStart) / 1000);
  const m = Math.floor(elapsedS / 60), s = elapsedS % 60;
  const distM = trackDistanceM(state.track);
  const distFmt = formatDistanceKm(distM / 1000);
  recordReadoutEl.textContent =
    `Recording: ${m}:${String(s).padStart(2, '0')} | ${distFmt.text} ${distFmt.unit}`;
}

recordBtn.addEventListener('click', () => {
  if (!state.recording) {
    state.recording = true;
    state.track = [];
    state.sessionStart = Date.now();
    trackLayer.setLatLngs([]);
    recordBtn.textContent = 'Stop Recording';
    recordBtn.classList.add('recording');
    acquireWakeLock();
  } else {
    state.recording = false;
    recordBtn.textContent = 'Start Recording';
    recordBtn.classList.remove('recording');
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
    saveSession();
  }
});

/* ---------- session storage ---------- */
function saveSession() {
  if (state.track.length === 0) return;
  const session = {
    id: state.sessionStart,
    startedAt: state.sessionStart,
    endedAt: Date.now(),
    windDir: state.windDir,
    line: (state.pin && state.boat) ? { pin: state.pin, boat: state.boat } : null,
    distanceM: trackDistanceM(state.track),
    points: state.track,
  };
  try {
    const key = 'rc_session_' + session.id;
    localStorage.setItem(key, JSON.stringify(session));
    const index = JSON.parse(localStorage.getItem('rc_sessions') || '[]');
    index.push(key);
    localStorage.setItem('rc_sessions', JSON.stringify(index));
  } catch (e) {
    console.warn('Could not save session (storage full?)', e);
  }
  const savedFmt = formatDistanceKm(session.distanceM / 1000);
  recordReadoutEl.textContent = `Saved: ${savedFmt.text} ${savedFmt.unit}`;
  renderSessionsList();
}

function loadSession(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch (e) {
    return null;
  }
}

function deleteSession(key) {
  localStorage.removeItem(key);
  const index = JSON.parse(localStorage.getItem('rc_sessions') || '[]').filter((k) => k !== key);
  localStorage.setItem('rc_sessions', JSON.stringify(index));
  renderSessionsList();
}

function renameSession(key, name) {
  const session = loadSession(key);
  if (!session) return;
  session.name = name.trim() || undefined; // empty name reverts to the default date-based label
  try { localStorage.setItem(key, JSON.stringify(session)); } catch (e) { /* storage unavailable, ignore */ }
  renderSessionsList();
}

function downloadFile(filename, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// GPX 1.1 track, with speed/course carried in the standard Garmin
// TrackPointExtension so the file stays a valid, widely-readable GPX while
// not losing the data most GPX viewers don't otherwise show.
function toGPX(session) {
  const points = session.points.filter((p) => p.lat != null);
  const trkpts = points.map((p) => {
    const time = new Date(p.t).toISOString();
    const speedMs = p.speedKn != null ? (p.speedKn / MS_TO_KNOTS).toFixed(2) : null;
    const course = p.cog != null ? Math.round(p.cog) : null;
    const ext = (speedMs != null || course != null)
      ? `<extensions><gpxtpx:TrackPointExtension>${speedMs != null ? `<gpxtpx:speed>${speedMs}</gpxtpx:speed>` : ''}${course != null ? `<gpxtpx:course>${course}</gpxtpx:course>` : ''}</gpxtpx:TrackPointExtension></extensions>`
      : '';
    return `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><time>${time}</time>${ext}</trkpt>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Race Computer" xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata><time>${new Date(session.startedAt).toISOString()}</time></metadata>
  <trk>
    <name>Race ${new Date(session.startedAt).toLocaleString()}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

function renderSessionsList() {
  const listEl = document.getElementById('sessions-list');
  const index = JSON.parse(localStorage.getItem('rc_sessions') || '[]');
  if (index.length === 0) {
    listEl.innerHTML = '<div class="sub-readout">No sessions recorded yet</div>';
    return;
  }
  listEl.innerHTML = '';
  index.slice().reverse().forEach((key) => {
    const session = loadSession(key);
    if (!session) return;
    const row = document.createElement('div');
    row.className = 'session-row';

    const info = document.createElement('div');
    info.className = 'session-info';
    const durationMin = Math.round((session.endedAt - session.startedAt) / 60000);
    const rowDistFmt = formatDistanceKm(session.distanceM / 1000);
    const defaultLabel = new Date(session.startedAt).toLocaleString();

    const titleRow = document.createElement('div');
    titleRow.className = 'session-title-row';
    const titleText = document.createElement('span');
    titleText.textContent = session.name || defaultLabel;
    const renameBtn = document.createElement('button');
    renameBtn.className = 'small-btn secondary session-rename-btn';
    renameBtn.textContent = '✎'; // pencil
    renameBtn.title = 'Rename';
    renameBtn.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'session-rename-input';
      input.value = session.name || '';
      input.placeholder = defaultLabel;
      const commit = () => renameSession(key, input.value);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = session.name || ''; input.blur(); }
      });
      input.addEventListener('blur', commit, { once: true });
      titleRow.replaceChild(input, titleText);
      input.focus();
      input.select();
    });
    titleRow.appendChild(titleText);
    titleRow.appendChild(renameBtn);

    const subLine = document.createElement('div');
    subLine.className = 'muted';
    subLine.textContent = `${rowDistFmt.text} ${rowDistFmt.unit} · ${durationMin} min`;

    info.appendChild(titleRow);
    info.appendChild(subLine);

    const actions = document.createElement('div');
    actions.className = 'session-actions';

    const viewBtn = document.createElement('button');
    viewBtn.className = 'small-btn secondary';
    viewBtn.textContent = 'View';
    viewBtn.addEventListener('click', () => viewSession(session));

    const gpxBtn = document.createElement('button');
    gpxBtn.className = 'small-btn';
    gpxBtn.textContent = 'GPX';
    gpxBtn.addEventListener('click', () => {
      const name = `race-${new Date(session.startedAt).toISOString().replace(/[:.]/g, '-')}.gpx`;
      downloadFile(name, 'application/gpx+xml', toGPX(session));
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'small-btn secondary hold-btn';
    delBtn.innerHTML = '<span class="fill"></span><span class="label">Delete</span>';
    wireHoldToConfirm(delBtn, 1200, () => deleteSession(key));

    actions.appendChild(viewBtn);
    actions.appendChild(gpxBtn);
    actions.appendChild(delBtn);
    row.appendChild(info);
    row.appendChild(actions);
    listEl.appendChild(row);
  });
}

renderSessionsList();

/* ---------- theme switching (UI + map colors) ---------- */
const themeSelect = document.getElementById('theme-select');
themeSelect.value = currentTheme; // sync the already-applied (early-init) choice into the control

function updateMapTheme() {
  const colors = THEME_MAP_COLORS[currentTheme] || THEME_MAP_COLORS.default;
  LINE_COLOR = colors.line;
  trackLayer.setStyle({ color: colors.track });
  if (boatMarker) boatMarker.setStyle({ color: colors.track, fillColor: colors.track });
  redrawLine(); // re-draw pin/boat line, if any, in the new color
}

function setTheme(theme) {
  currentTheme = VALID_THEMES.includes(theme) ? theme : 'default';
  document.documentElement.setAttribute('data-theme', currentTheme);
  themeSelect.value = currentTheme;
  updateMapTheme();
}

themeSelect.addEventListener('change', () => {
  setTheme(themeSelect.value);
  saveSettings();
});

/* ---------- settings persistence ---------- */
// Everything the user configures (as opposed to live/derived values like the
// continuously-drifting auto-wind direction) survives a reload - a setting
// that resets every launch is useless on a boat. New settings added later
// should be folded into this one save/load pair rather than growing their
// own ad hoc storage keys.
const SETTINGS_KEY = 'rc_settings';

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      windDir: state.windDir,
      windSource: state.windSource,
      autoWindEnabled: state.autoWindEnabled,
      autoWindWindowMin: state.autoWindWindowMin,
      tackAngleDeg: state.tackAngleDeg,
      tackAngleSource: state.tackAngleSource,
      cogUpdateMs,
      heelUpdateMs,
      heelZeroOffset,
      heelAxis,
      calibDurationS: parseInt(document.getElementById('calib-duration').value, 10) || 45,
      gpsRetryS,
      theme: currentTheme,
      compassFusionEnabled,
      mapNorthLock,
      speedUnit: state.speedUnit,
      windSpeedUnit: state.windSpeedUnit,
      distanceUnit: state.distanceUnit,
    }));
  } catch (e) { /* storage unavailable, ignore */ }
}

function loadSettings() {
  let s;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    s = JSON.parse(raw);
  } catch (e) { return; }

  if (typeof s.windDir === 'number') { state.windDir = s.windDir; windInput.value = s.windDir; }
  if (s.windSource === 'manual' || s.windSource === 'auto') state.windSource = s.windSource;
  if (typeof s.autoWindEnabled === 'boolean') {
    state.autoWindEnabled = s.autoWindEnabled;
    document.getElementById('auto-wind-enabled').checked = s.autoWindEnabled;
  }
  if (typeof s.autoWindWindowMin === 'number') {
    state.autoWindWindowMin = s.autoWindWindowMin;
    document.getElementById('auto-wind-window').value = s.autoWindWindowMin;
  }
  if (typeof s.tackAngleDeg === 'number') state.tackAngleDeg = s.tackAngleDeg;
  if (s.tackAngleSource === 'manual' || s.tackAngleSource === 'auto') state.tackAngleSource = s.tackAngleSource;
  if (typeof s.cogUpdateMs === 'number') {
    cogUpdateMs = s.cogUpdateMs;
    document.getElementById('cog-rate').value = String(s.cogUpdateMs);
  }
  if (typeof s.heelUpdateMs === 'number') {
    heelUpdateMs = s.heelUpdateMs;
    document.getElementById('heel-rate').value = String(s.heelUpdateMs);
  }
  if (typeof s.heelZeroOffset === 'number') heelZeroOffset = s.heelZeroOffset;
  if (s.heelAxis === 'xz' || s.heelAxis === 'yz') {
    heelAxis = s.heelAxis;
    document.getElementById('heel-axis-select').value = s.heelAxis;
  }
  if (typeof s.calibDurationS === 'number') document.getElementById('calib-duration').value = s.calibDurationS;
  if (typeof s.gpsRetryS === 'number') {
    gpsRetryS = Math.min(60, Math.max(5, s.gpsRetryS));
    document.getElementById('gps-retry-input').value = gpsRetryS;
  }
  // Theme was already applied at script start (initThemeEarly) to avoid a
  // flash of the wrong theme; this just syncs the map colors/select now that
  // the map and control actually exist, and re-applies in case initThemeEarly
  // couldn't read localStorage for some reason.
  if (VALID_THEMES.includes(s.theme)) setTheme(s.theme);
  if (typeof s.compassFusionEnabled === 'boolean') {
    compassFusionEnabled = s.compassFusionEnabled;
    compassEnabledEl.checked = s.compassFusionEnabled;
  }
  if (typeof s.mapNorthLock === 'boolean') {
    mapNorthLock = s.mapNorthLock;
    document.getElementById('map-north-lock').checked = s.mapNorthLock;
  }
  if (KN_TO_UNIT[s.speedUnit]) {
    state.speedUnit = s.speedUnit;
    document.getElementById('speed-unit-select').value = s.speedUnit;
    speedUnitEl.textContent = UNIT_LABEL[s.speedUnit];
  }
  if (KN_TO_UNIT[s.windSpeedUnit]) {
    state.windSpeedUnit = s.windSpeedUnit;
    document.getElementById('wind-speed-unit-select').value = s.windSpeedUnit;
  }
  if (KM_TO_UNIT[s.distanceUnit]) {
    state.distanceUnit = s.distanceUnit;
    document.getElementById('distance-unit-select').value = s.distanceUnit;
    renderSessionsList(); // re-render: it already ran once at startup using the pre-load default unit
  }

  updateWindStatus();
  updateCompassStatus();
}

/* ---------- races (local-only preview - no multi-device sync yet) ---------- */
// A basic scaffold: create/join races and list them, all stored on-device.
// "Join" only works today for a race already created on THIS phone (there's
// no server, so a code from someone else's phone won't resolve to anything) -
// this exists to shape the UI/data model for later, not as working
// multiplayer. Say so plainly rather than let it look broken.
const RACES_KEY = 'rc_races';

function loadRaces() {
  try { return JSON.parse(localStorage.getItem(RACES_KEY) || '[]'); } catch (e) { return []; }
}

function saveRaces(races) {
  try { localStorage.setItem(RACES_KEY, JSON.stringify(races)); } catch (e) { /* storage unavailable, ignore */ }
}

function setRacesStatus(msg) {
  const el = document.getElementById('races-status');
  if (el) el.textContent = msg;
}

// Genuinely functional even without sync: jumps the existing countdown timer
// straight to this race's declared start time and switches to Instruments -
// the "multiple individual rounds" idea just means creating one race per
// round and starting each one's sequence in turn.
function startRaceSequence(race) {
  if (!race.startAt) { setRacesStatus('This race has no start time set.'); return; }
  const startMs = new Date(race.startAt).getTime();
  if (Number.isNaN(startMs)) { setRacesStatus('That race has an invalid start time.'); return; }
  state.timerEndAt = startMs;
  prevRemainingS = null;
  startSyncBtn.textContent = 'Sync';
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = setInterval(tickTimer, 250);
  tickTimer();
  switchPage('instruments');
  setRacesStatus(`Countdown synced to "${race.name}".`);
}

function renderRacesList() {
  const races = loadRaces();
  const listEl = document.getElementById('races-list');
  if (races.length === 0) {
    listEl.innerHTML = '<div class="sub-readout">No races yet</div>';
    return;
  }
  listEl.innerHTML = '';
  races.slice().reverse().forEach((race) => {
    const row = document.createElement('div');
    row.className = 'session-row';

    const info = document.createElement('div');
    info.className = 'session-info';
    const startTxt = race.startAt ? new Date(race.startAt).toLocaleString() : 'No start time set';
    const boatTxt = `${race.boats.length} boat${race.boats.length === 1 ? '' : 's'}`;
    info.innerHTML = `<div style="font-weight:600;">${race.name}</div>` +
      `<span class="muted">${startTxt} · code ${race.id} · ${boatTxt}</span>`;

    const actions = document.createElement('div');
    actions.className = 'session-actions';

    const startBtn = document.createElement('button');
    startBtn.className = 'small-btn';
    startBtn.textContent = 'Start Sequence';
    startBtn.addEventListener('click', () => startRaceSequence(race));

    const routesBtn = document.createElement('button');
    routesBtn.className = 'small-btn secondary';
    routesBtn.textContent = 'View Routes';
    routesBtn.addEventListener('click', () => {
      setRacesStatus('Route sharing between boats needs multi-device sync, which isn\'t built yet - each joined boat\'s track will show here once it is.');
    });

    actions.appendChild(startBtn);
    actions.appendChild(routesBtn);
    row.appendChild(info);
    row.appendChild(actions);
    listEl.appendChild(row);
  });
}

document.getElementById('race-create-btn').addEventListener('click', () => {
  const nameInput = document.getElementById('race-name-input');
  const startInput = document.getElementById('race-start-input');
  const name = nameInput.value.trim();
  if (!name) { setRacesStatus('Give the race a name first.'); return; }
  const race = {
    id: Math.random().toString(36).slice(2, 8).toUpperCase(),
    name,
    startAt: startInput.value ? new Date(startInput.value).toISOString() : null,
    createdAt: Date.now(),
    boats: [{ name: 'You', isMe: true }],
  };
  const races = loadRaces();
  races.push(race);
  saveRaces(races);
  nameInput.value = '';
  startInput.value = '';
  renderRacesList();
  setRacesStatus(`Race created - code is ${race.id}.`);
});

document.getElementById('race-join-btn').addEventListener('click', () => {
  const codeInput = document.getElementById('race-join-input');
  const code = codeInput.value.trim().toUpperCase();
  if (!code) return;
  const race = loadRaces().find((r) => r.id === code);
  if (!race) {
    setRacesStatus('No local race found with that code - multi-device sync isn\'t implemented yet.');
    return;
  }
  setRacesStatus(`You're already set for "${race.name}" on this device.`);
  codeInput.value = '';
});

renderRacesList();

loadSettings();
updateMaxRows(); // Instruments starts as the active page, so this never goes through switchPage()
loadLayout();

wireHoldToConfirm(document.getElementById('reset-settings'), 1200, () => {
  // A full reload is the simplest reliable way to get every setting back to
  // its default - most of them are read into top-level `let`s once at
  // startup (loadSettings/loadLayout), and resetting each one by hand here
  // would just be a second, easily-drifting copy of that same logic.
  localStorage.removeItem(SETTINGS_KEY);
  localStorage.removeItem(LAYOUT_KEY);
  location.reload();
});

/* ---------- service worker ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
