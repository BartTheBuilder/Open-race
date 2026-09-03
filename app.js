"use strict";

/* ---------- constants ---------- */
const MS_TO_KNOTS = 1.943844;
const EARTH_R = 6371000; // meters
const TACK_HYSTERESIS_DEG = 20;   // COG must move this far past the wind axis...
const TACK_MIN_INTERVAL_MS = 8000; // ...and stay there this long to count as a real tack
const MOVING_MIN_SPEED_KN = 1.5;  // below this, heading is noise (drifting/stopped), ignore for wind/tack math
const SHIFT_NOTICE_MIN_DEG = 4;   // ignore wind-shift jitter smaller than this
const AUTO_WIND_MIN_SAMPLES = 8;  // per tack, within the rolling window, before trusting the average heading
const HEADING_LOG_MAX_AGE_MS = 10 * 60 * 1000; // prune anything older than the largest allowed window

/* ---------- state ---------- */
const state = {
  lastFix: null,        // {lat, lon, t}
  speedKn: null,
  cog: null,             // course over ground, degrees true
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
};

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
    setTimeout(() => map.invalidateSize(), 50);
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

let boatMarker = null;
let pinMarker = null;
let boatEndMarker = null;
let lineLayer = null;
let trackLayer = L.polyline([], { color: '#39ffb0', weight: 3 }).addTo(map);
let firstFix = true;

function updateBoatMarker(lat, lon) {
  if (!boatMarker) {
    boatMarker = L.circleMarker([lat, lon], { radius: 7, color: '#39ffb0', fillColor: '#39ffb0', fillOpacity: 1 }).addTo(map);
  } else {
    boatMarker.setLatLng([lat, lon]);
  }
  if (firstFix) {
    map.setView([lat, lon], 16);
    firstFix = false;
  }
}

// Circle-in-a-div markers instead of Leaflet's default pin icon: the default
// pulls PNGs from unpkg, which breaks offline (exactly when this matters
// most, mid-race with no signal) and doesn't give a precise center point the
// way a plain circle does.
const LINE_COLOR = '#ffb020';
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
const cogEl = document.getElementById('cog-value');
const heelEl = document.getElementById('heel-value');

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

function onPosition(pos) {
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
  state.cog = cog;
  state.lastFix = { lat, lon, t };

  speedEl.textContent = speedKn.toFixed(1);
  renderCog(cog, t);

  updateBoatMarker(lat, lon);
  updateLineReadout();
  detectTack(cog);
  recordHeadingSample(t, cog, speedKn);
  updateAutoWind();

  if (state.recording) {
    state.track.push({ lat, lon, t, speedKn, cog });
    trackLayer.addLatLng([lat, lon]);
    updateRecordReadout();
  }
}

function onPositionError(err) {
  gpsStatusEl.textContent = 'error: ' + err.message;
}

if ('geolocation' in navigator) {
  navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 15000,
  });
} else {
  gpsStatusEl.textContent = 'not supported';
}

/* ---------- heel (from the phone's accelerometer) ---------- */
// Derived from the raw gravity vector (devicemotion) rather than the
// deviceorientation beta/gamma Euler angles - those hit gimbal lock as beta
// approaches +-90 degrees, which is exactly the case when the phone is
// mounted standing upright rather than lying flat (a normal bracket mount).
// heel = angle of gravity in the device's Y-Z plane, via atan2(gy, gz): this
// stays correct at any mounting pitch (flat, angled, or standing vertical)
// as long as the phone's left/right axis is aligned athwartships, which is
// the natural way to mount it either way. Zeroable since the mount itself
// won't be exactly plumb.
let heelZeroOffset = 0;
let heelUpdateMs = 0; // 0 = render every sample ("Instant")
let heelSamples = [];
let heelLastRender = 0;

function onDeviceMotion(evt) {
  const g = evt.accelerationIncludingGravity;
  if (!g || g.y == null || g.z == null) return;
  const raw = Math.atan2(g.y, g.z) * 180 / Math.PI;
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

if (window.DeviceMotionEvent) {
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    // iOS-style permission gate; harmless no-op path on Android.
    document.body.addEventListener('click', function requestOnce() {
      DeviceMotionEvent.requestPermission().then((res) => {
        if (res === 'granted') window.addEventListener('devicemotion', onDeviceMotion);
      }).catch(() => {});
      document.body.removeEventListener('click', requestOnce);
    }, { once: true });
  } else {
    window.addEventListener('devicemotion', onDeviceMotion);
  }
} else {
  heelEl.textContent = 'n/a';
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

document.getElementById('cog-rate').addEventListener('change', (e) => {
  cogUpdateMs = parseInt(e.target.value, 10) || 0;
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
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=wind_direction_10m,wind_speed_10m&wind_speed_unit=kn`;
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
    statusEl.textContent = `Forecast: ${state.windDir}° @ ${spd.toFixed(1)}kn - regional estimate, refine with calibration`;
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

document.getElementById('ping-pin').addEventListener('click', () => {
  if (!state.lastFix) return;
  state.pin = { lat: state.lastFix.lat, lon: state.lastFix.lon };
  if (pinMarker) map.removeLayer(pinMarker);
  pinMarker = L.marker([state.pin.lat, state.pin.lon], { icon: lineEndIcon('P'), title: 'Pin' }).addTo(map);
  redrawLine();
  updateLineReadout();
});

document.getElementById('ping-boat').addEventListener('click', () => {
  if (!state.lastFix) return;
  state.boat = { lat: state.lastFix.lat, lon: state.lastFix.lon };
  if (boatEndMarker) map.removeLayer(boatEndMarker);
  boatEndMarker = L.marker([state.boat.lat, state.boat.lon], { icon: lineEndIcon('CB'), title: 'Committee Boat' }).addTo(map);
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
});

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

// Reset is hold-to-confirm (same mechanic as the screen-lock unlock button)
// so a stray tap mid-race can't wipe the countdown.
const RESET_HOLD_MS = 1200;
const resetBtn = document.getElementById('timer-reset');
const resetFill = resetBtn.querySelector('.fill');
let resetHoldTimer = null;

function resetFillIdle() {
  resetFill.style.transition = 'none';
  resetFill.style.width = '0%';
}

function doTimerReset() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = null;
  state.timerEndAt = null;
  prevRemainingS = null;
  timerEl.textContent = '5:00';
  timerEl.classList.remove('warn', 'go');
  burnValueEl.textContent = '--';
  startSyncBtn.textContent = 'Start 5:00';
  resetFillIdle();
}

function startResetHold(e) {
  e.preventDefault();
  resetFill.style.transition = `width ${RESET_HOLD_MS}ms linear`;
  requestAnimationFrame(() => { resetFill.style.width = '100%'; });
  resetHoldTimer = setTimeout(doTimerReset, RESET_HOLD_MS);
}

function cancelResetHold() {
  if (resetHoldTimer) { clearTimeout(resetHoldTimer); resetHoldTimer = null; }
  resetFillIdle();
}

resetBtn.addEventListener('pointerdown', startResetHold);
resetBtn.addEventListener('pointerup', cancelResetHold);
resetBtn.addEventListener('pointerleave', cancelResetHold);
resetBtn.addEventListener('pointercancel', cancelResetHold);

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
const LAYOUT_MAX_ROWS = 24; // generous ceiling for moves/resizes, not a real UI limit
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
};

// Recreates today's fixed arrangement: SOG wide, COG+HEEL side by side,
// START TIMER wide, LINE wide.
const DEFAULT_LAYOUT = [
  { id: 'sog', x: 0, y: 0, w: 4, h: 2 },
  { id: 'cog', x: 0, y: 2, w: 2, h: 2 },
  { id: 'heel', x: 2, y: 2, w: 2, h: 2 },
  { id: 'timer', x: 0, y: 4, w: 4, h: 4 },
  { id: 'line', x: 0, y: 8, w: 4, h: 2 },
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
// overlapping any other block? No reflow/compaction - a blocked drop is
// simply rejected and the caller snaps the block back.
function fits(candidate, excludeId) {
  if (candidate.x < 0 || candidate.y < 0) return false;
  if (candidate.x + candidate.w > LAYOUT_COLS) return false;
  if (candidate.y + candidate.h > LAYOUT_MAX_ROWS) return false;
  return !layout.some((b) => b.id !== excludeId && rectsOverlap(candidate, b));
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
      // Only trust the stored layout if it covers every block id we know
      // about today - otherwise (older/newer app version, corrupt data)
      // fall back to the default rather than rendering a partial layout.
      if (Array.isArray(parsed) && DEFAULT_LAYOUT.every((d) => parsed.some((p) => p && p.id === d.id))) {
        layout = DEFAULT_LAYOUT.map((d) => {
          const stored = parsed.find((p) => p.id === d.id);
          const min = BLOCK_MIN[d.id];
          const w = clamp(Math.round(stored.w), min.w, LAYOUT_COLS);
          const h = clamp(Math.round(stored.h), min.h, MAX_BLOCK_H);
          return {
            id: d.id,
            x: clamp(Math.round(stored.x), 0, LAYOUT_COLS - w),
            y: clamp(Math.round(stored.y), 0, LAYOUT_MAX_ROWS - h),
            w, h,
          };
        });
      }
    }
  } catch (e) { /* corrupt storage, keep default */ }
  applyLayout();
}

layoutEditToggle.addEventListener('click', () => {
  editMode = !editMode;
  instrGrid.classList.toggle('edit-mode', editMode);
  layoutEditToggle.textContent = editMode ? 'Done' : 'Edit';
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
  const startX = downEvent.clientX, startY = downEvent.clientY;
  const orig = { x: block.x, y: block.y };
  let dCellsX = 0, dCellsY = 0;

  tile.classList.add('dragging');
  tile.setPointerCapture(downEvent.pointerId);

  function onMove(ev) {
    const dxPx = ev.clientX - startX;
    const dyPx = ev.clientY - startY;
    dCellsX = Math.round(dxPx / (cellW + gap));
    dCellsY = Math.round(dyPx / (cellH + gap));
    tile.style.transform = `translate(${dxPx}px, ${dyPx}px)`;
  }

  function onUp() {
    tile.removeEventListener('pointermove', onMove);
    tile.removeEventListener('pointerup', onUp);
    tile.removeEventListener('pointercancel', onUp);
    tile.classList.remove('dragging');
    tile.style.transform = '';

    const candidate = {
      x: clamp(orig.x + dCellsX, 0, LAYOUT_COLS - block.w),
      y: clamp(orig.y + dCellsY, 0, LAYOUT_MAX_ROWS - block.h),
      w: block.w, h: block.h,
    };
    const moved = candidate.x !== orig.x || candidate.y !== orig.y;
    if (moved && fits(candidate, block.id)) {
      block.x = candidate.x;
      block.y = candidate.y;
      applyLayout();
      saveLayout();
    } else if (moved) {
      flashReject(tile); // blocked by another tile or the grid edge - snap back (no auto-reflow)
    }
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
    if (!editMode || e.target.closest('.resize-handle')) return;
    const block = layout.find((b) => b.id === id);
    startBlockMove(tile, block, e);
  });

  handle.addEventListener('pointerdown', (e) => {
    if (!editMode) return;
    const block = layout.find((b) => b.id === id);
    startBlockResize(tile, block, e);
  });
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
  recordReadoutEl.textContent =
    `Recording: ${m}:${String(s).padStart(2, '0')} | ${(distM / 1000).toFixed(2)} km`;
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
  recordReadoutEl.textContent = `Saved: ${(session.distanceM / 1000).toFixed(2)} km`;
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
    info.innerHTML = `${new Date(session.startedAt).toLocaleString()}<br>` +
      `<span class="muted">${(session.distanceM / 1000).toFixed(2)} km &middot; ${durationMin} min</span>`;

    const actions = document.createElement('div');
    actions.className = 'session-actions';

    const gpxBtn = document.createElement('button');
    gpxBtn.className = 'small-btn';
    gpxBtn.textContent = 'GPX';
    gpxBtn.addEventListener('click', () => {
      const name = `race-${new Date(session.startedAt).toISOString().replace(/[:.]/g, '-')}.gpx`;
      downloadFile(name, 'application/gpx+xml', toGPX(session));
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'small-btn secondary';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => deleteSession(key));

    actions.appendChild(gpxBtn);
    actions.appendChild(delBtn);
    row.appendChild(info);
    row.appendChild(actions);
    listEl.appendChild(row);
  });
}

renderSessionsList();

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
      calibDurationS: parseInt(document.getElementById('calib-duration').value, 10) || 45,
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
  if (typeof s.calibDurationS === 'number') document.getElementById('calib-duration').value = s.calibDurationS;

  updateWindStatus();
}

loadSettings();
loadLayout();

/* ---------- service worker ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
