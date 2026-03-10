// ── Ruben default photo ──
const RUBEN = 'image/rub.jpg';

// ── localStorage helpers ──
const $ = id => document.getElementById(id);
const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
};
const LS_PINS = 'rsm-pins-v4';
const LS_PENDING_UPLOADS = 'rsm-pending-uploads-v1';
const loadPins = () => { try { return JSON.parse(ls.get(LS_PINS) || '[]'); } catch (e) { return []; } };
const savePins = p => ls.set(LS_PINS, JSON.stringify(p.map(({ id, lat, lng, name, comment, date, photoUrl }) => ({ id, lat, lng, name: name || '', comment: comment || '', date, photoUrl: photoUrl || null }))));
const loadPendingUploads = () => {
  try {
    const raw = JSON.parse(ls.get(LS_PENDING_UPLOADS) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch (e) {
    return new Set();
  }
};
const savePendingUploads = s => ls.set(LS_PENDING_UPLOADS, JSON.stringify([...s]));
const markPendingUpload = id => {
  const pending = loadPendingUploads();
  pending.add(id);
  savePendingUploads(pending);
};
const clearPendingUpload = id => {
  const pending = loadPendingUploads();
  pending.delete(id);
  savePendingUploads(pending);
};
const loadPhoto = id => ls.get('rsm-p-' + id);
const savePhoto = (id, d) => ls.set('rsm-p-' + id, d);

// ── Cloud sync ──
let db = null, storage = null, cloudEnabled = false;

async function initCloud() {
  // firebaseConfig is defined in firebase-config.js (not committed to version control)
  if (typeof firebaseConfig === 'undefined' || !firebaseConfig.apiKey || !firebaseConfig.projectId) return;
  try {
    const v = '10.11.1', base = `https://www.gstatic.com/firebasejs/${v}`;
    await loadScript(`${base}/firebase-app-compat.js`);
    await loadScript(`${base}/firebase-auth-compat.js`);
    await loadScript(`${base}/firebase-firestore-compat.js`);
    await loadScript(`${base}/firebase-storage-compat.js`);
    firebase.initializeApp(firebaseConfig);
    await firebase.auth().signInAnonymously();
    db = firebase.firestore();
    storage = firebase.storage();
    cloudEnabled = true;
    console.log('☁️ Cloud sync active');
  } catch (e) { console.warn('Cloud sync unavailable:', e.message); }
}

// ── Image validation limits ──
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_NAME_LENGTH = 50;
const MAX_COMMENT_LENGTH = 200;

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
  // ── Set button avatar ──
  $('btn-avatar').src = RUBEN;

  // ── Map ──
  const worldBounds = [[-85, -180], [85, 180]];
  const map = L.map('map', {
    zoomControl: false,
    tap: true,
    tapTolerance: 15,
    minZoom: 2,
    maxBounds: worldBounds,
    maxBoundsViscosity: 1
  }).setView([52.3, 5.3], 8);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
    noWrap: true
  }).addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);

  // ── Icons ──
  const makePin = photo => L.divIcon({
    html: `<div class="photo-pin"><div class="photo-pin-circle"><img src="${photo || RUBEN}" onerror="this.src='${RUBEN}'"></div><div class="photo-pin-tail"></div></div>`,
    iconSize: [48, 58], iconAnchor: [24, 58], className: ''
  });

  const makeCluster = n => {
    const s = n < 10 ? 54 : n < 100 ? 62 : 72;
    return L.divIcon({
      html: `<div style="width:${s}px;height:${s}px;border-radius:50%;border:4px solid #fff;box-shadow:0 0 0 2.5px #1a1a2e,3px 3px 8px rgba(0,0,0,.35);overflow:hidden;position:relative;display:flex;align-items:center;justify-content:center;background:#1a1a2e"><img src="${RUBEN}" style="width:100%;height:100%;object-fit:cover;opacity:.4;position:absolute;inset:0"><span style="position:relative;z-index:1;font-family:'DM Sans',system-ui,sans-serif;color:#FFD600;font-size:${n < 100 ? 16 : 13}px;text-shadow:1px 1px 3px rgba(0,0,0,.9)">${n}</span></div>`,
      iconSize: [s, s], iconAnchor: [s / 2, s / 2], className: ''
    });
  };

  const cg = L.markerClusterGroup({
    maxClusterRadius: 60, spiderfyOnMaxZoom: false, showCoverageOnHover: false, zoomToBoundsOnClick: false,
    iconCreateFunction: c => makeCluster(c.getChildCount())
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
    pins.forEach(pin => {
      const m = L.marker([pin.lat, pin.lng], { icon: makePin(loadPhoto(pin.id) || pin.photoUrl || null), pinData: pin });
      m.on('click', () => openView(pin));
      cg.addLayer(m);
    });
    const countEl = $('counter-num');
    if (countEl) countEl.textContent = pins.length;
  };

  // ── Cloud: save a single pin to Firestore (photo URL from Storage or null) ──
  const saveToCloud = async (pin) => {
    if (!cloudEnabled) return;
    try {
      await db.collection('pins').doc(pin.id).set({
        id: pin.id, lat: pin.lat, lng: pin.lng,
        name: pin.name || '', comment: pin.comment || '',
        date: pin.date,
        photoUrl: pin.photoUrl || null
      });
      clearPendingUpload(pin.id);
    } catch (e) { console.warn('Cloud save failed:', e.message); }
  };

  // ── Upload compressed image data-URL to Firebase Storage ──
  const uploadPhoto = async (pinId, dataUrl) => {
    if (!cloudEnabled || !storage || !dataUrl) return null;
    try {
      const ref = storage.ref('photos/' + pinId + '.jpg');
      await ref.putString(dataUrl, 'data_url');
      return await ref.getDownloadURL();
    } catch (e) { console.warn('Photo upload failed:', e.message); return null; }
  };

  // ── Sheet helpers ──
  const openSheet = (bd, sh) => { bd.classList.add('on'); sh.classList.add('on'); };
  const closeSheet = (bd, sh) => { bd.classList.remove('on'); sh.classList.remove('on'); };

  const ab = $('ab'), as = $('asheet'), vb = $('vb'), vs = $('vsheet');
  const lb = $('lb'), lsh = $('lsheet');
  const ax = $('ax');
  ab.addEventListener('click', closeAdd); if (ax) ax.addEventListener('click', closeAdd);
  vb.addEventListener('click', closeView); $('vclose').addEventListener('click', closeView);
  lb.addEventListener('click', closeList); $('lx').addEventListener('click', closeList);

  function closeAdd() { closeSheet(ab, as); resetForm(); }
  function closeView() { closeSheet(vb, vs); }
  function closeList() { closeSheet(lb, lsh); }

  // ── Add sheet ──
  $('add-pin-btn').addEventListener('click', () => {
    const c = map.getCenter();
    const acoords = $('acoords');
    if (acoords) acoords.textContent = `📍 ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
    resetForm();
    $('name-inp').value = ls.get('rsm-last-name') || '';
    openSheet(ab, as);
    setTimeout(() => { if (!$('name-inp').value) $('name-inp').focus(); }, 400);
  });

  function resetForm() {
    $('name-inp').classList.remove('err'); $('name-err').classList.remove('on');
    $('photo-err').classList.remove('on');
    $('comment-inp').value = ''; $('gal').value = ''; $('cam').value = '';
    pendingPhoto = null; setPreview(null);
  }

  function setPreview(url) {
    const w = $('prevwrap'), i = $('previmg');
    if (url) { i.src = url; w.classList.add('on'); } else { i.src = ''; w.classList.remove('on'); }
  }

  $('rmbtn').addEventListener('click', e => {
    e.stopPropagation(); pendingPhoto = null; setPreview(null); $('gal').value = ''; $('cam').value = '';
    $('photo-err').classList.remove('on');
  });

  const handleFile = inp => {
    const f = inp.files[0]; if (!f) return;
    const photoErr = $('photo-err');
    if (!f.type.startsWith('image/')) {
      photoErr.textContent = '⚠️ Alleen afbeeldingen toegestaan (jpg, png, gif, …)!';
      photoErr.classList.add('on');
      inp.value = '';
      return;
    }
    if (f.size > MAX_FILE_BYTES) {
      photoErr.textContent = '⚠️ Afbeelding is te groot (max 5 MB)!';
      photoErr.classList.add('on');
      inp.value = '';
      return;
    }
    photoErr.classList.remove('on');
    const r = new FileReader();
    r.onload = async e => { const c = await compress(e.target.result); if (c) { pendingPhoto = c; setPreview(c); } };
    r.readAsDataURL(f);
  };
  $('gal').addEventListener('change', function () { handleFile(this); });
  $('cam').addEventListener('change', function () { handleFile(this); });
  $('name-inp').addEventListener('input', function () {
    if (this.value.trim()) { this.classList.remove('err'); $('name-err').classList.remove('on'); }
  });

  $('pinbtn').addEventListener('click', async () => {
    const ne = $('name-inp'), name = ne.value.trim().slice(0, MAX_NAME_LENGTH);
    if (!name) { ne.classList.add('err'); $('name-err').classList.add('on'); ne.focus(); return; }
    const btn = $('pinbtn');
    btn.textContent = '⏳ Opslaan...'; btn.disabled = true;
    ls.set('rsm-last-name', name);
    const c = map.getCenter();
    const comment = $('comment-inp').value.trim().slice(0, MAX_COMMENT_LENGTH);
    const pin = { id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2), lat: c.lat, lng: c.lng, name, comment, date: new Date().toISOString() };
    const capturedPhoto = pendingPhoto;
    if (capturedPhoto) savePhoto(pin.id, capturedPhoto);
    pins.push(pin);
    markPendingUpload(pin.id);
    if (!savePins(pins)) { pins.pop(); btn.textContent = '📌 PLAK'; btn.disabled = false; alert('Opslag vol!'); return; }
    renderPins(); btn.textContent = '📌 PLAK'; btn.disabled = false;
    closeAdd();
    if (capturedPhoto && cloudEnabled) {
      const url = await uploadPhoto(pin.id, capturedPhoto);
      if (url) { pin.photoUrl = url; savePins(pins); }
    }
    saveToCloud(pin);
  });

  // ── View sheet ──
  function openView(pin) {
    const photo = loadPhoto(pin.id) || pin.photoUrl || null;
    const d = new Date(pin.date);
    $('vmeta').textContent = '📅 ' + d.toLocaleDateString('nl-NL', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    const vp = $('vphoto');
    if (photo) { vp.src = photo; vp.classList.add('on'); } else { vp.src = ''; vp.classList.remove('on'); }
    const vn = $('vname');
    if (pin.name) { vn.textContent = pin.name; vn.classList.add('on'); } else { vn.classList.remove('on'); }
    const vc = $('vcomment');
    if (pin.comment) { vc.textContent = '"' + pin.comment + '"'; vc.classList.add('on'); } else { vc.classList.remove('on'); }
    const vno = $('vnone');
    if (!photo && !pin.comment) { vno.textContent = '🌟 Een Ruben Sticker is hier geplaatst!'; vno.style.display = 'block'; } else { vno.style.display = 'none'; }
    openSheet(vb, vs);
  }

  // ── List sheet (multiple stickers at same location) ──
  function openList(pinsArr) {
    const titleEl = $('lsheet-title');
    titleEl.textContent = pinsArr.length + ' stickers op deze plek';
    const body = $('lsheet-body');
    body.innerHTML = '';
    pinsArr.forEach(pin => {
      const photo = loadPhoto(pin.id) || pin.photoUrl || RUBEN;
      const d = new Date(pin.date);
      const dateStr = d.toLocaleDateString('nl-NL', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
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
      dateEl.textContent = '📅 ' + dateStr;
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
      body.appendChild(item);
    });
    openSheet(lb, lsh);
  }

  // ── Init ──
  pins = loadPins();
  renderPins();
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(p => map.setView([p.coords.latitude, p.coords.longitude], 14), () => {}, { timeout: 6000, enableHighAccuracy: true });
  }
  $('loading').style.opacity = '0';
  setTimeout(() => $('loading').style.display = 'none', 400);

  // ── Cloud sync (background — pins appear as soon as Firebase is ready) ──
  initCloud().then(() => {
    if (!cloudEnabled) return;
    db.collection('pins').onSnapshot(snap => {
      const cp = []; snap.forEach(d => cp.push(d.data()));
      const cpIds = new Set(cp.map(c => c.id));
      const pending = loadPendingUploads();
      const unsyncedLocal = pins.filter(p => pending.has(p.id) && !cpIds.has(p.id));

      // Cloud is source of truth; only keep local pins that are still pending upload.
      pins = [...cp, ...unsyncedLocal];
      savePins(pins);
      renderPins();

      // Retry only pending local pins. Deleted cloud pins won't be recreated.
      (async () => {
        for (const pin of unsyncedLocal) {
          if (!pin.photoUrl) {
            const localPhoto = loadPhoto(pin.id);
            if (localPhoto) {
              const url = await uploadPhoto(pin.id, localPhoto);
              if (url) { pin.photoUrl = url; savePins(pins); }
            }
          }
          await saveToCloud(pin);
        }
      })();
    }, err => console.warn('Firestore error:', err));
  });
}

// ── Boot ──
initMap();
