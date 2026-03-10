// ── Ruben default photo ──
const RUBEN = 'image/rub.jpg';
const FIREBASE_VERSION = '10.11.1';

// ── localStorage helpers ──
const $ = id => document.getElementById(id);
const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
};
const LS_PINS = 'rsm-pins-v4';
const LS_PENDING_UPLOADS = 'rsm-pending-uploads-v1';
const readJson = (key, fallback) => {
  try {
    const raw = ls.get(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
};
const serializePin = ({ id, lat, lng, name, comment, date, photoUrl }) => ({
  id,
  lat,
  lng,
  name: name || '',
  comment: comment || '',
  date,
  photoUrl: photoUrl || null
});
const loadPins = () => {
  const raw = readJson(LS_PINS, []);
  return Array.isArray(raw) ? raw : [];
};
const savePins = pins => ls.set(LS_PINS, JSON.stringify(pins.map(serializePin)));
const loadPendingUploads = () => {
  const raw = readJson(LS_PENDING_UPLOADS, []);
  return new Set(Array.isArray(raw) ? raw : []);
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
const resolvePinPhoto = pin => pin.localPhotoData || loadPhoto(pin.id) || pin.photoUrl || null;
const createPinId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
const buildPinDocument = (pin, photoUrl = null) => ({
  id: pin.id,
  lat: pin.lat,
  lng: pin.lng,
  name: pin.name || '',
  comment: pin.comment || '',
  date: pin.date,
  photoUrl: photoUrl || null
});
const formatPinDate = value => {
  const d = new Date(value);
  return d.toLocaleDateString('nl-NL', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
    + ' · '
    + d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
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

async function initCloud() {
  // firebaseConfig is defined in firebase-config.js (not committed to version control)
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
    viewSheet: $('vsheet')
  };
  // ── Set button avatar ──
  ui.buttonAvatar.src = RUBEN;

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
      const m = L.marker([pin.lat, pin.lng], { icon: makePin(resolvePinPhoto(pin)), pinData: pin });
      m.on('click', () => openView(pin));
      cg.addLayer(m);
    });
    if (ui.counterNum) ui.counterNum.textContent = pins.length;
  };

  // ── Cloud: save a single pin to Firestore and Storage ──
  const uploadPhoto = async (pinId, dataUrl) => {
    if (!storage || !dataUrl) return null;
    const ref = storage.ref().child(`pins/${pinId}.jpg`);
    await ref.putString(dataUrl, 'data_url', { contentType: 'image/jpeg' });
    return await ref.getDownloadURL();
  };

  const saveToCloud = async (pin, photoData = null) => {
    if (!cloudEnabled) return;
    try {
      let photoUrl = pin.photoUrl || null;
      const localPhoto = photoData || resolvePinPhoto(pin);
      if (!photoUrl && localPhoto) {
        photoUrl = await uploadPhoto(pin.id, localPhoto);
        pin.photoUrl = photoUrl;
        savePins(pins);
      }
      await db.collection('pins').doc(pin.id).set(buildPinDocument(pin, photoUrl));
      clearPendingUpload(pin.id);
      delete pin.localPhotoData;
    } catch (e) { logCloudError('Cloud save failed:', e); }
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
    ui.nameInput.value = ls.get('rsm-last-name') || '';
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
    if (this.value.trim()) { this.classList.remove('err'); ui.nameError.classList.remove('on'); }
  });

  ui.pinButton.addEventListener('click', () => {
    const name = ui.nameInput.value.trim().slice(0, MAX_NAME_LENGTH);
    if (!name) {
      ui.nameInput.classList.add('err');
      ui.nameError.classList.add('on');
      ui.nameInput.focus();
      return;
    }
    ui.pinButton.textContent = '⏳ Opslaan...';
    ui.pinButton.disabled = true;
    ls.set('rsm-last-name', name);
    const center = map.getCenter();
    const comment = ui.commentInput.value.trim().slice(0, MAX_COMMENT_LENGTH);
    const capturedPhoto = pendingPhoto;
    const pin = { id: createPinId(), lat: center.lat, lng: center.lng, name, comment, date: new Date().toISOString(), localPhotoData: capturedPhoto || null };
    if (capturedPhoto && !savePhoto(pin.id, capturedPhoto)) console.warn('Local photo cache failed; continuing with in-memory upload only');
    pins.push(pin);
    markPendingUpload(pin.id);
    if (!savePins(pins)) {
      pins.pop();
      ui.pinButton.textContent = '📌 PLAK';
      ui.pinButton.disabled = false;
      alert('Opslag vol!');
      return;
    }
    renderPins();
    ui.pinButton.textContent = '📌 PLAK';
    ui.pinButton.disabled = false;
    closeAdd();
    void saveToCloud(pin, capturedPhoto);
  });

  // ── View sheet ──
  function openView(pin) {
    const photo = resolvePinPhoto(pin);
    ui.viewMeta.textContent = '📅 ' + formatPinDate(pin.date);
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
      const photo = resolvePinPhoto(pin) || RUBEN;
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
      ui.listBody.appendChild(item);
    });
    openSheet(ui.listBackdrop, ui.listSheet);
  }

  // ── Init ──
  pins = loadPins();
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
      const cpIds = new Set(cp.map(c => c.id));
      const pending = loadPendingUploads();
      const unsyncedLocal = pins.filter(p => pending.has(p.id) && !cpIds.has(p.id));

      // Cloud is source of truth; only keep local pins that are still pending upload.
      pins = [...cp, ...unsyncedLocal];
      savePins(pins);
      renderPins();

      // Retry only pending local pins. Deleted cloud pins won't be recreated.
      unsyncedLocal.forEach(pin => { void saveToCloud(pin); });
    }, err => logCloudError('Firestore error:', err));
  });
}

// ── Boot ──
initMap();
