// Minimal browser/Leaflet stub so app.js can be loaded end-to-end under gjs
// (SpiderMonkey) as a smoke test - no real browser available in this dev
// environment. This is NOT a full DOM: event handlers are attached but never
// invoked (so click/pointer callback bodies aren't exercised), and
// querySelectorAll always returns []. It catches ReferenceErrors, TDZ bugs,
// and missing-method typos in top-level script execution; it does NOT catch
// visual/interaction bugs or anything gated behind a callback. See
// scripts/check.sh.

function makeStyle() {
  return new Proxy({}, { get: () => '', set: () => true });
}

function makeElement(tag) {
  const listeners = {};
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    childNodes: [],
    style: makeStyle(),
    dataset: {},
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, force) { if (force === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else if (force) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    attributes: {},
    _value: '',
    get value() { return this._value; },
    set value(v) { this._value = v; },
    _text: '',
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    get innerHTML() { return this._text; },
    set innerHTML(v) { this._text = String(v); },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; },
    insertBefore(child, ref) {
      const i = this.children.indexOf(ref);
      if (i === -1) this.children.push(child); else this.children.splice(i, 0, child);
      child.parentNode = this;
      return child;
    },
    replaceChild(nu, old) {
      const i = this.children.indexOf(old);
      if (i !== -1) this.children[i] = nu;
      nu.parentNode = this;
      return old;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 300, height: 300, right: 300, bottom: 300 }; },
    setPointerCapture() {},
    releasePointerCapture() {},
    focus() {},
    select() {},
    blur() {},
    click() { (listeners.click || []).forEach((f) => f({ preventDefault() {}, target: this })); },
    parentNode: null,
    clientWidth: 300,
    clientHeight: 300,
  };
  return el;
}

const elementsById = {};
function el(id) {
  if (!elementsById[id]) elementsById[id] = makeElement('div');
  return elementsById[id];
}

globalThis.document = {
  documentElement: makeElement('html'),
  body: makeElement('body'),
  getElementById: (id) => el(id),
  createElement: (tag) => makeElement(tag),
  createTextNode: (text) => ({ textContent: text, nodeType: 3 }),
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener() {},
};

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.navigator = {
  geolocation: { watchPosition: () => 1, clearWatch: () => {} },
  wakeLock: undefined,
};
globalThis.localStorage = (() => {
  const store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
})();
globalThis.fetch = () => Promise.reject(new Error('no network in smoke test'));
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.getComputedStyle = () => ({
  rowGap: '10px',
  getPropertyValue: () => '',
});
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.URL = { createObjectURL: () => '', revokeObjectURL: () => {} };
globalThis.Blob = function Blob() {};

function makePoint(x, y) {
  return { x, y, add: (p) => makePoint(x + p.x, y + p.y) };
}

function makeLeafletLayer() {
  const layer = {
    addTo() { return layer; },
    setStyle() { return layer; },
    setLatLngs() { return layer; },
    addLatLng() { return layer; },
    getLatLng() { return { lat: 0, lng: 0 }; },
    setLatLng() { return layer; },
    getElement() { return makeElement('div'); },
    on() { return layer; },
  };
  return layer;
}

globalThis.L = {
  map: () => {
    const container = makeElement('div');
    const pane = makeElement('div');
    container.appendChild(pane); // real Leaflet's mapPane always has a parent (the container)
    return {
      setView() { return this; },
      getPane: () => pane,
      getContainer: () => container,
      dragging: { disable() {} },
      on() { return this; },
      invalidateSize() {},
      panBy() {},
      latLngToLayerPoint: () => makePoint(0, 0),
      layerPointToLatLng: () => ({ lat: 0, lng: 0 }),
      getCenter: () => ({ lat: 0, lng: 0 }),
      fitBounds() {},
      removeLayer() {},
    };
  },
  tileLayer: () => makeLeafletLayer(),
  marker: () => makeLeafletLayer(),
  circleMarker: () => makeLeafletLayer(),
  polyline: () => makeLeafletLayer(),
  layerGroup: () => makeLeafletLayer(),
  divIcon: () => ({}),
  point: (x, y) => makePoint(x, y),
  latLngBounds: () => ({}),
};
