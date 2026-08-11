// ── Ruben default photo ──
const RUBEN = 'image/rub.jpg';
const ALLOWED_STORAGE_HOST = 'https://firebasestorage.googleapis.com';
const sanitizePhotoUrl = url => {
  if (!url) return null;
  if (url.startsWith('data:image/')) return url;
  if (url.startsWith(ALLOWED_STORAGE_HOST)) return url;
  return null;
};
const FIREBASE_VERSION = '10.11.1';

// ── Legacy local cleanup ──
const $ = id => document.getElementById(id);
const LS_SAVED_NAME = 'rsm-last-name';
const LEGACY_STORAGE_KEYS = ['rsm-pins-v4', 'rsm-pending-uploads-v1', 'rsm-rate-v1'];
const LEGACY_PHOTO_PREFIX = 'rsm-p-';
const loadSavedName = () => {
  try {
    return localStorage.getItem(LS_SAVED_NAME) || '';
  } catch {
    return '';
  }
};
const saveSavedName = name => {
  try {
    localStorage.setItem(LS_SAVED_NAME, name);
  } catch {}
};
let lastUsedName = loadSavedName();
const clearLegacyLocalState = () => {
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (LEGACY_STORAGE_KEYS.includes(key) || key.startsWith(LEGACY_PHOTO_PREFIX)) keysToRemove.push(key);
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
  } catch {}
};
const resolvePinPhoto = pin => pin.localPhotoData || pin.photoUrl || null;
const createPinId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
const buildPinDocument = (pin, photoUrl = null) => ({
  id: pin.id,
  lat: pin.lat,
  lng: pin.lng,
  name: pin.name || '',
  comment: pin.comment || '',
  date: pin.date,
  photoUrl: photoUrl || null,
  views: pin.views || 0
});
const formatPinDate = value => {
  const d = new Date(value);
  return d.toLocaleDateString('nl-NL', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
    + ' · '
    + d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
};
const formatDayKey = value => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};
const readFileAsDataUrl = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = e => resolve(e.target.result);
  reader.onerror = () => reject(new Error('file-read-failed'));
  reader.readAsDataURL(file);
});
const logCloudError = (label, error) => console.warn(label, error.code || error.message || error);

// ── Cloud sync ──
let db = null, storage = null, cloudEnabled = false;

// ── Mock Firestore for local/offline testing (js/test.html) ──
// Implements only the subset of the Firestore API app.js actually calls.
// Everything is stored under one localStorage key, isolated from any real
// Firebase project — nothing here ever touches the network.
const MOCK_STORE_KEY = 'rsm-test-pins-v1';
function createMockFirestore(seedPins = []) {
  let store = {};
  try { store = JSON.parse(localStorage.getItem(MOCK_STORE_KEY) || '{}'); } catch { store = {}; }
  // Real stickers are seeded UNDER whatever's already local, so a previous
  // test session's local edits (e.g. a bumped view count) always win and
  // don't get reset back to the live snapshot on every reload.
  let seeded = false;
  seedPins.forEach(p => { if (p && p.id && !(p.id in store)) { store[p.id] = { ...p }; seeded = true; } });
  const listeners = new Set();
  const persist = () => { try { localStorage.setItem(MOCK_STORE_KEY, JSON.stringify(store)); } catch {} };
  if (seeded) persist();
  const notify = () => {
    const docs = Object.values(store).map(data => ({ data: () => data }));
    listeners.forEach(cb => cb({ forEach: fn => docs.forEach(fn) }));
  };
  const docRef = id => ({
    set: async data => { store[id] = { ...data }; persist(); notify(); },
    update: async patch => {
      const current = store[id] || {};
      const next = { ...current };
      Object.entries(patch).forEach(([k, v]) => {
        next[k] = (v && v.__isIncrement) ? (Number(current[k]) || 0) + v.delta : v;
      });
      store[id] = next; persist(); notify();
    }
  });
  return {
    collection: () => ({
      doc: id => docRef(id),
      onSnapshot: (cb) => { listeners.add(cb); notify(); return () => listeners.delete(cb); }
    })
  };
}

// Reads the real `pins` collection via the plain Firestore REST API — no
// Firebase SDK is loaded for this, so there is no write-capable client in
// memory at all in test mode. This is a one-time, read-only snapshot.
function firestoreRestValue(v) {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined) return null;
  if (v.mapValue !== undefined) return firestoreRestToPlain(v.mapValue.fields || {});
  if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(firestoreRestValue);
  if (v.timestampValue !== undefined) return v.timestampValue;
  return null;
}
function firestoreRestToPlain(fields) {
  const out = {};
  Object.entries(fields || {}).forEach(([k, v]) => { out[k] = firestoreRestValue(v); });
  return out;
}
async function fetchRealPinsReadOnly(cfg) {
  // Anonymous sign-in via the Identity Toolkit REST API (mirrors
  // firebase.auth().signInAnonymously(), no Auth SDK needed).
  const signUpRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(cfg.apiKey)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) }
  );
  if (!signUpRes.ok) throw new Error('Anonymous auth failed: HTTP ' + signUpRes.status);
  const { idToken } = await signUpRes.json();

  const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/databases/(default)/documents/pins`;
  const pins = [];
  let pageToken = '';
  do {
    const url = base + (pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : '');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
    if (!res.ok) throw new Error('Firestore read failed: HTTP ' + res.status);
    const body = await res.json();
    (body.documents || []).forEach(doc => pins.push(firestoreRestToPlain(doc.fields)));
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return pins;
}

async function initCloud() {
  // Test mode: skip real Firebase entirely, use an in-browser mock instead.
  if (window.RSM_MOCK_CLOUD) {
    window.firebase = window.firebase || {};
    firebase.firestore = firebase.firestore || {};
    firebase.firestore.FieldValue = firebase.firestore.FieldValue || { increment: delta => ({ __isIncrement: true, delta }) };

    let seedPins = [];
    if (window.RSM_SEED_FROM_REAL && window.RSM_CONFIG_OR_SKIP) {
      try {
        await window.RSM_CONFIG_OR_SKIP; // resolves on real code entry OR explicit skip
        if (typeof firebaseConfig !== 'undefined' && firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId) {
          seedPins = await fetchRealPinsReadOnly(firebaseConfig);
          console.log(`🧪 Loaded ${seedPins.length} real stickers as a read-only snapshot — nothing is written back to Firebase`);
        } else {
          console.log('🧪 Testing fully offline (no real stickers loaded)');
        }
      } catch (e) {
        console.warn('Could not load real stickers for test seed — continuing offline:', e);
      }
    }
    db = createMockFirestore(seedPins);
    cloudEnabled = true;
    console.log('🧪 Mock cloud active — writes stay in this browser only');
    return;
  }
  if (window.firebaseConfigReady) await window.firebaseConfigReady;
  if (typeof firebaseConfig === 'undefined' || !firebaseConfig.apiKey || !firebaseConfig.projectId) return;
  try {
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
    await loadScript(`${base}/firebase-app-compat.js`);
    await loadScript(`${base}/firebase-auth-compat.js`);
    await loadScript(`${base}/firebase-firestore-compat.js`);
    await loadScript(`${base}/firebase-storage-compat.js`);
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    await firebase.auth().signInAnonymously();
    db = firebase.firestore();
    storage = firebase.storage();
    cloudEnabled = true;
    console.log('☁️ Cloud sync active');
  } catch (e) { logCloudError('Cloud sync unavailable:', e); }
}

// ── Image validation limits ──
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_NAME_LENGTH = 50;
const MAX_COMMENT_LENGTH = 200;

// ── Rate limiting (1 pin per 15 seconds) ──
const PIN_COOLDOWN_MS = 15 * 1000; // 15 seconds
let lastPinTime = 0;

/** Returns {allowed, reason} */
const checkRateLimit = () => {
  const now = Date.now();
  const elapsed = now - lastPinTime;
  if (elapsed < PIN_COOLDOWN_MS) {
    const wait = Math.ceil((PIN_COOLDOWN_MS - elapsed) / 1000);
    return { allowed: false, reason: `⏳ Wacht nog ${wait} seconde${wait !== 1 ? 'n' : ''} voor je een nieuwe sticker plaatst.` };
  }
  return { allowed: true };
};

const recordPinRate = () => { lastPinTime = Date.now(); };

// ── World coverage (countries with at least one sticker) ──
// Fully offline: uses a bundled, simplified country-boundaries file and a
// small point-in-polygon test. No external geocoding API, no rate limits.
const WORLD_COUNTRY_COUNT = 195; // 193 UN member states + 2 UN observer states
let countryFeatures = null;
const pinCountryCache = new Map(); // pinId -> country name | null

const pointInRing = (pt, ring) => {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
};

const pointInGeometry = (pt, geometry) => {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const rings of polys) {
    if (!rings.length) continue;
    if (pointInRing(pt, rings[0]) && !rings.slice(1).some(hole => pointInRing(pt, hole))) return true;
  }
  return false;
};

const bboxOf = geometry => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = coords => {
    if (typeof coords[0] === 'number') {
      const [x, y] = coords;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    } else coords.forEach(walk);
  };
  walk(geometry.coordinates);
  return [minX, minY, maxX, maxY];
};

const loadCountryFeatures = async () => {
  if (countryFeatures) return countryFeatures;
  const res = await fetch('geo/countries.min.json');
  const data = await res.json();
  countryFeatures = data.features.map(f => ({ ...f, bbox: bboxOf(f.geometry) }));
  return countryFeatures;
};

const findCountryName = (lat, lng, features) => {
  const pt = [lng, lat];
  for (const f of features) {
    const [minX, minY, maxX, maxY] = f.bbox;
    if (lng < minX || lng > maxX || lat < minY || lat > maxY) continue;
    if (pointInGeometry(pt, f.geometry)) return f.properties.name;
  }
  return null;
};

const updateWorldCoverage = async (pinsSnapshot, ui, onCountryCount) => {
  if (!ui.worldBadge || !ui.worldBadgeCount) return;
  try {
    const features = await loadCountryFeatures();
    const countries = new Set();
    pinsSnapshot.forEach(pin => {
      let name = pinCountryCache.get(pin.id);
      if (name === undefined) {
        name = findCountryName(pin.lat, pin.lng, features);
        pinCountryCache.set(pin.id, name);
      }
      if (name) countries.add(name);
    });
    if (window.RSM_MOCK_CLOUD) {
      const countryList = [...countries].sort((a, b) => a.localeCompare(b));
      console.log(`🧪 Country count check (${countries.size}/${WORLD_COUNTRY_COUNT}): ${countryList.join(', ') || 'none'}`);
    }
    ui.worldBadgeCount.textContent = countries.size;
    if (ui.worldBadgeLabel) ui.worldBadgeLabel.textContent = countries.size === 1 ? 'land' : 'landen';
    ui.worldBadge.title = `${countries.size} van de ${WORLD_COUNTRY_COUNT} landen`;
    onCountryCount(countries.size);
  } catch (e) { logCloudError('World coverage calc failed:', e); }
};

// ── View-count cooldown (1 counted view per sticker per device per 30 min) ──
const VIEW_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const LS_VIEW_PREFIX = 'rsm-view-';

const getLastViewed = pinId => {
  try {
    const raw = localStorage.getItem(LS_VIEW_PREFIX + pinId);
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch { return 0; }
};

const setLastViewed = pinId => {
  try { localStorage.setItem(LS_VIEW_PREFIX + pinId, String(Date.now())); } catch {}
};

// Sweeps out expired view-cooldown entries so localStorage doesn't grow forever.
const pruneViewCooldowns = () => {
  try {
    const now = Date.now();
    const stale = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(LS_VIEW_PREFIX)) continue;
      const ts = parseInt(localStorage.getItem(key), 10) || 0;
      if (now - ts >= VIEW_COOLDOWN_MS) stale.push(key);
    }
    stale.forEach(key => localStorage.removeItem(key));
  } catch {}
};

/**
 * Counts a view of a sticker, at most once per device per VIEW_COOLDOWN_MS.
 * Returns the view count to show immediately (optimistic — Firestore sync
 * will confirm it shortly after for everyone, including this device).
 */
const registerView = pin => {
  const baseViews = pin.views || 0;
  const onCooldown = Date.now() - getLastViewed(pin.id) < VIEW_COOLDOWN_MS;
  if (onCooldown) return baseViews;
  setLastViewed(pin.id);
  if (cloudEnabled && db) {
    db.collection('pins').doc(pin.id).update({
      views: firebase.firestore.FieldValue.increment(1)
    }).catch(e => logCloudError('View count update failed:', e));
  }
  return baseViews + 1;
};

// ── Image compression ──
const compress = (url, maxW = 900, q = .65) => new Promise(res => {
  const i = new Image(); i.onload = () => {
    const c = document.createElement('canvas');
    let w = i.width, h = i.height;
    if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
    c.width = w; c.height = h; c.getContext('2d').drawImage(i, 0, 0, w, h);
    res(c.toDataURL('image/jpeg', q));
  }; i.onerror = () => res(null); i.src = url;
});

// ── App state ──
let pins = [], pendingPhoto = null;

// ── Load scripts dynamically ──
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

async function initMap() {
  try {
    $('loading-msg').textContent = 'Kaart laden...';
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/leaflet.markercluster.min.js');
    $('loading-msg').textContent = 'Bijna klaar...';
    startApp();
  } catch (e) {
    $('loading-msg').style.display = 'none';
    $('loading-err').style.display = 'block';
    setTimeout(() => { $('loading').style.opacity = 0; setTimeout(() => $('loading').style.display = 'none', 400); }, 5000);
  }
}

function startApp() {
  const ui = {
    addBackdrop: $('ab'),
    addCoords: $('acoords'),
    addPinButton: $('add-pin-btn'),
    addSheet: $('asheet'),
    buttonAvatar: $('btn-avatar'),
    cameraInput: $('cam'),
    closeAddButton: $('ax'),
    closeListButton: $('lx'),
    closeViewButton: $('vclose'),
    commentInput: $('comment-inp'),
    counterNum: $('counter-num'),
    dailyPrincess: $('daily-princess'),
    dailyPrincessMeta: $('daily-princess-meta'),
    galleryInput: $('gal'),
    listBackdrop: $('lb'),
    listBody: $('lsheet-body'),
    listSheet: $('lsheet'),
    listTitle: $('lsheet-title'),
    loading: $('loading'),
    nameError: $('name-err'),
    nameInput: $('name-inp'),
    photoError: $('photo-err'),
    pinButton: $('pinbtn'),
    previewImage: $('previmg'),
    previewWrap: $('prevwrap'),
    removePhotoButton: $('rmbtn'),
    viewBackdrop: $('vb'),
    viewComment: $('vcomment'),
    viewEmpty: $('vnone'),
    viewMeta: $('vmeta'),
    viewName: $('vname'),
    viewPhoto: $('vphoto'),
    viewSheet: $('vsheet'),
    viewViews: $('vviews'),
    worldBadge: $('world-badge'),
    worldBadgeCount: $('world-badge-count'),
    worldBadgeLabel: $('world-badge-label')
  };

  // ── Set button avatar ──
  ui.buttonAvatar.src = RUBEN;

  // ── Rotate country count and daily princess ──
  const badgeState = {
    countryCountReady: false,
    dailyPrincessAvailable: false,
    showDailyPrincess: false,
    timer: null
  };

  const applyRotatingBadgeVisibility = () => {
    if (!badgeState.countryCountReady) {
      ui.worldBadge.hidden = true;
      ui.dailyPrincess.hidden = true;
      return;
    }
    const showDaily = badgeState.dailyPrincessAvailable && badgeState.showDailyPrincess;
    ui.dailyPrincess.hidden = !showDaily;
    ui.worldBadge.hidden = showDaily;
  };

  const restartBadgeRotation = () => {
    if (badgeState.timer) window.clearInterval(badgeState.timer);
    badgeState.timer = null;
    badgeState.showDailyPrincess = false;
    applyRotatingBadgeVisibility();
    if (!badgeState.countryCountReady || !badgeState.dailyPrincessAvailable) return;
    badgeState.timer = window.setInterval(() => {
      badgeState.showDailyPrincess = !badgeState.showDailyPrincess;
      applyRotatingBadgeVisibility();
    }, 5000);
  };

  const setDailyPrincessAvailable = available => {
    if (badgeState.dailyPrincessAvailable === available) return;
    badgeState.dailyPrincessAvailable = available;
    restartBadgeRotation();
  };

  const setCountryCountReady = () => {
    if (badgeState.countryCountReady) {
      applyRotatingBadgeVisibility();
      return;
    }
    badgeState.countryCountReady = true;
    restartBadgeRotation();
  };

  // ── Map ──
  const map = L.map('map', {
    zoomControl: false,
    tap: true,
    tapTolerance: 15,
    minZoom: 2,
    maxBounds: [[-85, -180], [85, 180]],
    maxBoundsViscosity: 1
  }).setView([52.3, 5.3], 8);
  
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
    noWrap: true
  }).addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);
  
  // ── Latest pin id (kept in scope so iconCreateFunction can read it) ──
  let latestId = null;
  let recentIds = new Set();

  // ── Icons ──
  const makePin = (photo, isLatest = false) => L.divIcon({
  html: `<div class="photo-pin${isLatest ? ' photo-pin--latest' : ''}"><div class="photo-pin-circle${isLatest ? ' photo-pin-circle--latest' : ''}"><img src="${photo || RUBEN}" onerror="this.src='${RUBEN}'"></div><div class="photo-pin-tail${isLatest ? ' photo-pin-tail--latest' : ''}"></div></div>`,
  iconSize: [48, 58], iconAnchor: [24, 58], className: ''
});

  const makeCluster = (n, isLatest = false) => {
    const s = n < 10 ? 54 : n < 100 ? 62 : 72;
    const border = isLatest ? '#1E88E5' : '#fff';
    const ring   = isLatest ? '#1E88E5' : '#1a1a2e';
    const glow   = isLatest ? ',0 0 0 5px rgba(30,136,229,.25)' : '';
    return L.divIcon({
      html: `<div style="width:${s}px;height:${s}px;border-radius:50%;border:4px solid ${border};box-shadow:0 0 0 2.5px ${ring},3px 3px 8px rgba(0,0,0,.35)${glow};overflow:hidden;position:relative;display:flex;align-items:center;justify-content:center;background:#1a1a2e"><img src="${RUBEN}" style="width:100%;height:100%;object-fit:cover;opacity:.4;position:absolute;inset:0"><span style="position:relative;z-index:1;font-family:'DM Sans',system-ui,sans-serif;color:#FFD600;font-size:${n < 100 ? 16 : 13}px;text-shadow:1px 1px 3px rgba(0,0,0,.9)">${n}</span></div>`,
      iconSize: [s, s], iconAnchor: [s / 2, s / 2], className: isLatest ? 'cluster-latest' : ''
    });
  };

  const cg = L.markerClusterGroup({
    maxClusterRadius: 60, spiderfyOnMaxZoom: false, showCoverageOnHover: false, zoomToBoundsOnClick: false,
    iconCreateFunction: c => {
      const hasLatest = recentIds.size > 0 && c.getAllChildMarkers().some(m => recentIds.has(m.options.pinData?.id));
      return makeCluster(c.getChildCount(), hasLatest);
    }
  });
  map.addLayer(cg);

  cg.on('clusterclick', e => {
    const cluster = e.layer;
    if (map.getZoom() >= map.getMaxZoom()) {
      const clusterPins = cluster.getAllChildMarkers().map(m => m.options.pinData).filter(Boolean);
      if (clusterPins.length > 0) openList(clusterPins);
    } else {
      cluster.zoomToBounds({ padding: [20, 20] });
    }
  });

  const renderPins = () => {
  cg.clearLayers();
  // Highlight all pins placed in the last 14 hours
  const cutoff = Date.now() - 14 * 60 * 60 * 1000;
  latestId = null; // unused now but keep var clean
  recentIds = new Set(pins.filter(pin => new Date(pin.date).getTime() >= cutoff).map(pin => pin.id));
  pins.forEach(pin => {
    const isLatest = recentIds.has(pin.id);
    const m = L.marker([pin.lat, pin.lng], { icon: makePin(sanitizePhotoUrl(resolvePinPhoto(pin)), isLatest), pinData: pin });
    m.on('click', () => openView(pin));
    cg.addLayer(m);
  });
  if (ui.counterNum) ui.counterNum.textContent = pins.length;
  renderDailyPrincess();
  updateWorldCoverage(pins, ui, setCountryCountReady);
};

  const renderDailyPrincess = () => {
    if (!ui.dailyPrincess || !ui.dailyPrincessMeta) return;
    const todayKey = formatDayKey(new Date());
    const counts = new Map();
    pins.forEach(pin => {
      if (formatDayKey(pin.date) !== todayKey) return;
      const name = (pin.name || '').trim();
      if (!name) return;
      const key = name.toLocaleLowerCase('nl-NL');
      const current = counts.get(key);
      if (current) {
        current.count += 1;
      } else {
        counts.set(key, { name, count: 1 });
      }
    });

    if (!counts.size) {
      ui.dailyPrincessMeta.textContent = '';
      setDailyPrincessAvailable(false);
      return;
    }

    const leaders = Array.from(counts.values())
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'nl-NL'));
    const topCount = leaders[0].count;
    const winners = leaders
      .filter(entry => entry.count === topCount)
      .map(entry => entry.name);

    ui.dailyPrincessMeta.textContent = `${winners.join(' & ')} · ${topCount}`;
    setDailyPrincessAvailable(true);
  };

  // ── Cloud: save a single pin to Firestore and Storage ──
  const uploadPhoto = async (pinId, dataUrl) => {
    if (!storage || !dataUrl) return null;
    const ref = storage.ref().child(`pins/${pinId}.jpg`);
    await ref.putString(dataUrl, 'data_url', { contentType: 'image/jpeg' });
    return await ref.getDownloadURL();
  };

  const saveToCloud = async (pin, photoData = null) => {
    if (!cloudEnabled || !db) throw new Error('cloud-unavailable');
    let photoUrl = pin.photoUrl || null;
    const localPhoto = photoData || resolvePinPhoto(pin);
    if (!photoUrl && localPhoto) photoUrl = await uploadPhoto(pin.id, localPhoto);
    await db.collection('pins').doc(pin.id).set(buildPinDocument(pin, photoUrl));
    return { ...pin, photoUrl };
  };

  // ── Sheet helpers ──
  const setSheetOpen = (backdrop, sheet, isOpen) => {
    backdrop.classList.toggle('on', isOpen);
    sheet.classList.toggle('on', isOpen);
  };
  const openSheet = (backdrop, sheet) => setSheetOpen(backdrop, sheet, true);
  const closeSheet = (backdrop, sheet) => setSheetOpen(backdrop, sheet, false);

  ui.addBackdrop.addEventListener('click', closeAdd);
  if (ui.closeAddButton) ui.closeAddButton.addEventListener('click', closeAdd);
  ui.viewBackdrop.addEventListener('click', closeView);
  ui.closeViewButton.addEventListener('click', closeView);
  ui.listBackdrop.addEventListener('click', closeList);
  ui.closeListButton.addEventListener('click', closeList);

  function closeAdd() { closeSheet(ui.addBackdrop, ui.addSheet); resetForm(); }
  function closeView() { closeSheet(ui.viewBackdrop, ui.viewSheet); }
  function closeList() { closeSheet(ui.listBackdrop, ui.listSheet); }

  // ── Add sheet ──
  ui.addPinButton.addEventListener('click', () => {
    const center = map.getCenter();
    const acoords = ui.addCoords;
    if (acoords) acoords.textContent = `📍 ${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`;
    resetForm();
    ui.nameInput.value = lastUsedName;
    openSheet(ui.addBackdrop, ui.addSheet);
    setTimeout(() => { if (!ui.nameInput.value) ui.nameInput.focus(); }, 400);
  });

  function resetForm() {
    ui.nameInput.classList.remove('err');
    ui.nameError.classList.remove('on');
    ui.photoError.classList.remove('on');
    ui.photoError.textContent = '';
    ui.commentInput.value = '';
    ui.galleryInput.value = '';
    ui.cameraInput.value = '';
    pendingPhoto = null;
    setPreview(null);
  }

  function setPreview(url) {
    if (url) {
      ui.previewImage.src = url;
      ui.previewWrap.classList.add('on');
    } else {
      ui.previewImage.src = '';
      ui.previewWrap.classList.remove('on');
    }
  }

  ui.removePhotoButton.addEventListener('click', e => {
    e.stopPropagation();
    pendingPhoto = null;
    setPreview(null);
    ui.galleryInput.value = '';
    ui.cameraInput.value = '';
    ui.photoError.classList.remove('on');
    ui.photoError.textContent = '';
  });

  const handleFile = async input => {
    const file = input.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      ui.photoError.textContent = '⚠️ Alleen afbeeldingen toegestaan (jpg, png, gif, …)!';
      ui.photoError.classList.add('on');
      input.value = '';
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      ui.photoError.textContent = '⚠️ Afbeelding is te groot (max 5 MB)!';
      ui.photoError.classList.add('on');
      input.value = '';
      return;
    }
    try {
      ui.photoError.classList.remove('on');
      ui.photoError.textContent = '';
      const compressedPhoto = await compress(await readFileAsDataUrl(file));
      if (!compressedPhoto) {
        ui.photoError.textContent = '⚠️ Afbeelding kon niet worden verwerkt.';
        ui.photoError.classList.add('on');
        input.value = '';
        return;
      }
      pendingPhoto = compressedPhoto;
      setPreview(compressedPhoto);
    } catch (e) {
      ui.photoError.textContent = '⚠️ Afbeelding kon niet worden gelezen.';
      ui.photoError.classList.add('on');
      input.value = '';
    }
  };
  ui.galleryInput.addEventListener('change', function () { handleFile(this); });
  ui.cameraInput.addEventListener('change', function () { handleFile(this); });
  ui.nameInput.addEventListener('input', function () {
    lastUsedName = this.value.trim().slice(0, MAX_NAME_LENGTH);
    saveSavedName(lastUsedName);
    if (this.value.trim()) { this.classList.remove('err'); ui.nameError.classList.remove('on'); }
  });

  ui.pinButton.addEventListener('click', async () => {
    const name = ui.nameInput.value.trim().slice(0, MAX_NAME_LENGTH);
    if (!name) {
      ui.nameInput.classList.add('err');
      ui.nameError.classList.add('on');
      ui.nameInput.focus();
      return;
    }
    if (!cloudEnabled || !db) {
      ui.photoError.textContent = 'Database niet beschikbaar. Probeer het opnieuw zodra Firebase is verbonden.';
      ui.photoError.classList.add('on');
      return;
    }
    const capturedPhoto = pendingPhoto;
    const rl = checkRateLimit();
    if (!rl.allowed) {
      ui.photoError.textContent = rl.reason;
      ui.photoError.classList.add('on');
      return;
    }
    ui.photoError.classList.remove('on');
    ui.photoError.textContent = '';
    ui.pinButton.textContent = '⏳ Opslaan...';
    ui.pinButton.disabled = true;
    lastUsedName = name;
    saveSavedName(name);
    const center = map.getCenter();
    const comment = ui.commentInput.value.trim().slice(0, MAX_COMMENT_LENGTH);
    const pin = { id: createPinId(), lat: center.lat, lng: center.lng, name, comment, date: new Date().toISOString() };
    try {
      await saveToCloud(pin, capturedPhoto);
      recordPinRate();
      closeAdd();
    } catch (e) {
      logCloudError('Cloud save failed:', e);
      ui.photoError.textContent = 'Opslaan mislukt. Probeer opnieuw.';
      ui.photoError.classList.add('on');
    } finally {
      ui.pinButton.textContent = '📌 PLAK';
      ui.pinButton.disabled = false;
    }
  });

  // ── View sheet ──
  function openView(pin) {
    const photo = sanitizePhotoUrl(resolvePinPhoto(pin));
    const viewCount = registerView(pin);
    ui.viewMeta.textContent = '📅 ' + formatPinDate(pin.date);
    if (ui.viewViews) ui.viewViews.textContent = '👁️ ' + viewCount + ' keer bekeken';
    if (photo) { ui.viewPhoto.src = photo; ui.viewPhoto.classList.add('on'); } else { ui.viewPhoto.src = ''; ui.viewPhoto.classList.remove('on'); }
    if (pin.name) { ui.viewName.textContent = pin.name; ui.viewName.classList.add('on'); } else { ui.viewName.classList.remove('on'); }
    if (pin.comment) { ui.viewComment.textContent = '"' + pin.comment + '"'; ui.viewComment.classList.add('on'); } else { ui.viewComment.classList.remove('on'); }
    if (!photo && !pin.comment) { ui.viewEmpty.textContent = '🌟 Een Ruben Sticker is hier geplaatst!'; ui.viewEmpty.style.display = 'block'; } else { ui.viewEmpty.style.display = 'none'; }
    openSheet(ui.viewBackdrop, ui.viewSheet);
  }

  // ── List sheet (multiple stickers at same location) ──
  function openList(pinsArr) {
    ui.listTitle.textContent = pinsArr.length + ' stickers op deze plek';
    ui.listBody.innerHTML = '';
    pinsArr.forEach(pin => {
      const photo = sanitizePhotoUrl(resolvePinPhoto(pin)) || RUBEN;
      const dateStr = formatPinDate(pin.date);
      const item = document.createElement('div');
      item.className = 'list-item';
      const avatar = document.createElement('img');
      avatar.className = 'list-item-avatar';
      avatar.src = photo;
      avatar.alt = '';
      avatar.onerror = () => { avatar.src = RUBEN; };
      const info = document.createElement('div');
      info.className = 'list-item-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'list-item-name';
      nameEl.textContent = pin.name || 'Onbekend';
      const dateEl = document.createElement('div');
      dateEl.className = 'list-item-date';
      dateEl.textContent = '📅 ' + dateStr + '  ·  👁️ ' + (pin.views || 0);
      info.appendChild(nameEl);
      info.appendChild(dateEl);
      if (pin.comment) {
        const commentEl = document.createElement('div');
        commentEl.className = 'list-item-comment';
        commentEl.textContent = '"' + pin.comment + '"';
        info.appendChild(commentEl);
      }
      const arrow = document.createElement('span');
      arrow.className = 'list-item-arrow';
      arrow.textContent = '›';
      item.appendChild(avatar);
      item.appendChild(info);
      item.appendChild(arrow);
      item.addEventListener('click', () => { closeList(); openView(pin); });
      ui.listBody.appendChild(item);
    });
    openSheet(ui.listBackdrop, ui.listSheet);
  }

  // ── Init ──
  clearLegacyLocalState();
  pruneViewCooldowns();
  renderPins();
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(p => map.setView([p.coords.latitude, p.coords.longitude], 14), () => {}, { timeout: 6000, enableHighAccuracy: true });
  }
  ui.loading.style.opacity = '0';
  setTimeout(() => { ui.loading.style.display = 'none'; }, 400);

  // ── Cloud sync (background — pins appear as soon as Firebase is ready) ──
  initCloud().then(() => {
    if (!cloudEnabled) return;
    db.collection('pins').onSnapshot(snap => {
      const cp = []; snap.forEach(d => cp.push(d.data()));
      pins = cp;
      renderPins();
    }, err => logCloudError('Firestore error:', err));
  });
}

// ── Boot ──
initMap();
