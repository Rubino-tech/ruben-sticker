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
  photoUrl: photoUrl || null
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

async function initCloud() {
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
    viewSheet: $('vsheet')
  };
  // ── Counter toggle: count ↔ locatie uit foto ──
let counterMode = 'count';
const counterEl = document.getElementById('counter');
const exifInput = document.getElementById('exif-input');

counterEl.addEventListener('click', () => {
  if (counterMode === 'count') {
    counterMode = 'exif';
    counterEl.innerHTML = `<span style="font-size:12px;font-weight:700">📍 Locatie<br>uit foto</span>`;
    setTimeout(() => exifInput.click(), 50);
  } else {
    counterMode = 'count';
    counterEl.innerHTML = `<span id="counter-num">${pins.length}</span><img id="counter-avatar" src="image/rub.jpg" alt="Ruben">`;
  }
});

exifInput.addEventListener('change', async function () {
  const file = this.files[0];
  this.value = '';
  counterMode = 'count';
  counterEl.innerHTML = `<span id="counter-num">${pins.length}</span><img id="counter-avatar" src="image/rub.jpg" alt="Ruben">`;
  if (!file) return;

  try {
    const buf = await file.arrayBuffer();
    const view = new DataView(buf);
    if (view.getUint16(0) !== 0xFFD8) throw new Error('geen jpeg');

    let offset = 2;
    let gps = null;
    while (offset < view.byteLength - 4) {
      const marker = view.getUint16(offset);
      const len = view.getUint16(offset + 2);
      if (marker === 0xFFE1) {
        const exifHeader = new Uint8Array(buf, offset + 4, 4);
        if (String.fromCharCode(...exifHeader) === 'Exif') {
          const tiff = new DataView(buf, offset + 10);
          const little = tiff.getUint16(0) === 0x4949;
          const ifdOffset = tiff.getUint32(4, little);
          const entries = tiff.getUint16(ifdOffset, little);
          for (let i = 0; i < entries; i++) {
            const tag = tiff.getUint16(ifdOffset + 2 + i * 12, little);
            if (tag === 0x8825) {
              const gpsIfdOffset = tiff.getUint32(ifdOffset + 2 + i * 12 + 8, little);
              const gpsEntries = tiff.getUint16(gpsIfdOffset, little);
              const gpsData = {};
              for (let j = 0; j < gpsEntries; j++) {
                const gTag = tiff.getUint16(gpsIfdOffset + 2 + j * 12, little);
                const gOff = tiff.getUint32(gpsIfdOffset + 2 + j * 12 + 8, little);
                if (gTag === 1 || gTag === 3) {
                  gpsData[gTag] = String.fromCharCode(tiff.getUint8(gpsIfdOffset + 2 + j * 12 + 8));
                } else if (gTag === 2 || gTag === 4) {
                  const toDecimal = o => tiff.getUint32(o, little) / tiff.getUint32(o + 4, little);
                  gpsData[gTag] = toDecimal(gOff) + toDecimal(gOff + 8) / 60 + toDecimal(gOff + 16) / 3600;
                }
              }
              if (gpsData[2] && gpsData[4]) {
                gps = {
                  lat: gpsData[1] === 'S' ? -gpsData[2] : gpsData[2],
                  lng: gpsData[3] === 'W' ? -gpsData[4] : gpsData[4]
                };
              }
            }
          }
        }
      }
      if (marker === 0xFFDA) break;
      offset += 2 + len;
    }

    if (gps) {
      map.setView([gps.lat, gps.lng], 16);
    } else {
      alert('Geen locatiedata gevonden in deze foto.');
    }
  } catch (e) {
    alert('Kon de foto niet lezen.');
  }
});
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
      const m = L.marker([pin.lat, pin.lng], { icon: makePin(sanitizePhotoUrl(resolvePinPhoto(pin))), pinData: pin });
      m.on('click', () => openView(pin));
      cg.addLayer(m);
    });
    if (ui.counterNum) ui.counterNum.textContent = pins.length;
    renderDailyPrincess();
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
      ui.dailyPrincess.hidden = true;
      ui.dailyPrincessMeta.textContent = '';
      return;
    }

    const leaders = Array.from(counts.values())
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'nl-NL'));
    const topCount = leaders[0].count;
    const winners = leaders
      .filter(entry => entry.count === topCount)
      .map(entry => entry.name);

    ui.dailyPrincessMeta.textContent = `${winners.join(' & ')} · ${topCount}`;
    ui.dailyPrincess.hidden = false;
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
  clearLegacyLocalState();
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
