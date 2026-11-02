/**
 * Final Stops — глобальні зони (final_stop | counting_ignoring, is_global = 1)
 *
 * Проста сторінка для створення зон, не прив'язаних до маршруту:
 *  - малювання кругових та полігональних зон на карті Mapbox;
 *  - збереження через api/routes.php (action=save_zone) з is_global=1;
 *  - перегляд, перейменування та видалення існуючих глобальних зон.
 */

// ─────────────────────────────────────
// Конфіг та стан
// ─────────────────────────────────────

const FS_CONFIG = {
    defaultCenter: [32.0, 49.0], // Україна [lng, lat]
    defaultZoom: 6,
    circlePoints: 64,
    earthRadius: 6_371_000,
    zoneColor: '#E91E63',
    zoneColorIgnore: '#3d1520',
    trackColor: '#58a6ff',
    fitPadding: 80,
};

let fsMap = null;

/** @type {Array<object>} завантажені зони з БД */
let fsZones = [];

/** @type {Array<{lat:number,lng:number,speed:number,dir:number,time:number}>} GPS-точки треку */
let fsTrackPoints = [];

/** @type {mapboxgl.Marker[]} маркери початку/кінця треку */
let fsTrackMarkers = [];

/** Стан малювання: null | 'circle' | 'circle_radius' | 'polygon' */
let fsDrawMode = null;
let fsDrawState = { center: null, points: [], tempMarkers: [], finishedGeom: null };

/**
 * Стан редагування геометрії існуючої зони.
 * @type {{active: boolean, zoneId: (number|null), isCircle: boolean,
 *         center: ([number,number]|null), radiusM: number, points: [number,number][],
 *         centerHandle: (object|null), handles: object[]}}
 */
let fsEditState = {
    active: false,
    zoneId: null,
    isCircle: false,
    center: null,   // [lng, lat]
    radiusM: 0,
    points: [],     // [[lng, lat], ...] без замикання (полігон)
    centerHandle: null,
    handles: [],
};

const FS_GLOBAL_ZONE_TYPES = {
    final_stop: 'Кінцева зупинка',
    counting_ignoring: 'Ігнорування підрахунку',
};

function fsNormalizeZoneType(type) {
    return type === 'counting_ignoring' ? 'counting_ignoring' : 'final_stop';
}

function fsZoneTypeLabel(type) {
    return FS_GLOBAL_ZONE_TYPES[fsNormalizeZoneType(type)] || FS_GLOBAL_ZONE_TYPES.final_stop;
}

function fsZoneColor(type) {
    return fsNormalizeZoneType(type) === 'counting_ignoring'
        ? FS_CONFIG.zoneColorIgnore
        : FS_CONFIG.zoneColor;
}

/** Mapbox paint expression: колір зони за властивістю zoneType. */
function fsZoneColorMatchExpr() {
    return [
        'match',
        ['get', 'zoneType'],
        'counting_ignoring',
        FS_CONFIG.zoneColorIgnore,
        FS_CONFIG.zoneColor,
    ];
}

function fsPreviewFeatureProps() {
    if (fsEditState.active) {
        return { zoneType: fsReadZoneTypeSelect('fsEditType') };
    }
    const modal = $fs('fsZoneModal');
    if (modal && modal.style.display === 'flex') {
        return { zoneType: fsReadZoneTypeSelect('fsZoneType') };
    }
    return { zoneType: 'final_stop' };
}

function fsPreviewFeature(geometry) {
    return {
        type: 'Feature',
        properties: fsPreviewFeatureProps(),
        geometry,
    };
}

function fsOnZoneTypeSelectChange() {
    if (fsEditState.active) {
        fsRenderEditPreview();
        return;
    }
    if (fsDrawState.finishedGeom?.displayCoords) {
        fsMap.getSource('fs-preview')?.setData({
            type: 'FeatureCollection',
            features: [fsPreviewFeature({
                type: 'Polygon',
                coordinates: [fsDrawState.finishedGeom.displayCoords],
            })],
        });
    }
}

function fsReadZoneTypeSelect(selectId) {
    const el = $fs(selectId);
    if (!el) return 'final_stop';
    return fsNormalizeZoneType(el.value);
}

function fsSetZoneTypeSelect(selectId, type) {
    const el = $fs(selectId);
    if (!el) return;
    el.value = fsNormalizeZoneType(type);
}

const $fs = (id) => document.getElementById(id);

// ─────────────────────────────────────
// API
// ─────────────────────────────────────

const FS_API = {
    base: 'api/routes.php',

    async get(params) {
        const qs = new URLSearchParams(params).toString();
        const res = await fetch(`${this.base}?${qs}`);
        return res.json();
    },

    async post(fields) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(fields)) fd.append(k, v);
        const res = await fetch(this.base, { method: 'POST', body: fd });
        return res.json();
    },

    getZones() {
        return this.get({
            action: 'get_zones',
            types: 'final_stop,counting_ignoring',
            is_global: '1',
        });
    },
    getTrack(imei, date) {
        const qs = new URLSearchParams({ action: 'get_track', imei, date }).toString();
        return fetch(`api/track.php?${qs}`).then(r => r.json());
    },
    saveZone(fields) {
        return this.post({ action: 'save_zone', ...fields });
    },
    deleteZone(id) {
        return this.post({ action: 'delete_zone', id: String(id) });
    },
};

// ─────────────────────────────────────
// Геометрія
// ─────────────────────────────────────

/**
 * Полігональне наближення кола.
 * @param {[number,number]} center [lng, lat]
 * @param {number} radiusM
 * @returns {[number,number][]} [lng, lat]
 */
function fsCirclePolygon(center, radiusM, numPoints = FS_CONFIG.circlePoints) {
    const coords = [];
    const lat = center[1] * Math.PI / 180;
    const lng = center[0] * Math.PI / 180;
    const d = radiusM / FS_CONFIG.earthRadius;

    for (let i = 0; i <= numPoints; i++) {
        const brng = (2 * Math.PI * i) / numPoints;
        const latR = Math.asin(
            Math.sin(lat) * Math.cos(d) +
            Math.cos(lat) * Math.sin(d) * Math.cos(brng),
        );
        const lngR = lng + Math.atan2(
            Math.sin(brng) * Math.sin(d) * Math.cos(lat),
            Math.cos(d) - Math.sin(lat) * Math.sin(latR),
        );
        coords.push([lngR * 180 / Math.PI, latR * 180 / Math.PI]);
    }
    return coords;
}

/**
 * Відстань між двома точками у метрах.
 * @param {[number,number]} a [lng, lat]
 * @param {[number,number]} b [lng, lat]
 */
function fsHaversine(a, b) {
    const R = FS_CONFIG.earthRadius;
    const dLat = (b[1] - a[1]) * Math.PI / 180;
    const dLng = (b[0] - a[0]) * Math.PI / 180;
    const lat1 = a[1] * Math.PI / 180;
    const lat2 = b[1] * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 +
        Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
    return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Точка на відстані distM від центру за напрямком bearingDeg (0=N, 90=E).
 * @param {[number,number]} center [lng, lat]
 * @param {number} distM
 * @param {number} bearingDeg
 * @returns {[number,number]} [lng, lat]
 */
function fsDestinationPoint(center, distM, bearingDeg) {
    const R = FS_CONFIG.earthRadius;
    const lat1 = center[1] * Math.PI / 180;
    const lng1 = center[0] * Math.PI / 180;
    const brng = bearingDeg * Math.PI / 180;
    const d = distM / R;

    const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(d) +
        Math.cos(lat1) * Math.sin(d) * Math.cos(brng),
    );
    const lng2 = lng1 + Math.atan2(
        Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
    return [lng2 * 180 / Math.PI, lat2 * 180 / Math.PI];
}

/**
 * Координати полігону зони для відображення на карті ([lng, lat], замкнене кільце).
 * @param {object} zone
 * @returns {[number,number][]|null}
 */
function fsZoneDisplayCoords(zone) {
    if (!zone.geometry) return null;

    if (zone.geometry.type === 'point' && zone.radius_m) {
        const center = [zone.geometry.coordinates[1], zone.geometry.coordinates[0]]; // [lng, lat]
        return fsCirclePolygon(center, parseInt(zone.radius_m, 10));
    }
    if (zone.geometry.type === 'polygon' && zone.geometry.coordinates) {
        const ring = zone.geometry.coordinates.map(c => [c[1], c[0]]); // [lat,lng] → [lng,lat]
        if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
            ring.push(ring[0]); // замикаємо
        }
        return ring;
    }
    return null;
}

// ─────────────────────────────────────
// Ініціалізація карти
// ─────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    if (!window.MAPBOX_API_KEY) {
        console.error('Mapbox API key not set');
        return;
    }

    mapboxgl.accessToken = window.MAPBOX_API_KEY;

    fsMap = new mapboxgl.Map({
        container: 'fsMap',
        style: 'mapbox://styles/mapbox/streets-v12',
        center: FS_CONFIG.defaultCenter,
        zoom: FS_CONFIG.defaultZoom,
        attributionControl: true,
    });

    fsMap.addControl(new mapboxgl.NavigationControl(), 'bottom-right');
    fsMap.addControl(new mapboxgl.ScaleControl({ maxWidth: 200 }), 'bottom-left');

    if (typeof MapboxGeocoder !== 'undefined') {
        fsMap.addControl(new MapboxGeocoder({
            accessToken: mapboxgl.accessToken,
            mapboxgl,
            placeholder: 'Пошук місця...',
            language: 'uk',
            marker: false,
        }), 'top-left');
    }

    fsMap.on('load', () => {
        fsSetupLayers();
        fsLoadZones();
    });

    // Клік/рух миші для малювання
    fsMap.on('click', (e) => {
        if (fsDrawMode) fsHandleDrawClick([e.lngLat.lng, e.lngLat.lat]);
    });
    fsMap.on('mousemove', (e) => {
        $fs('fsStatusCoords').textContent =
            `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}`;
        if (fsDrawMode) fsHandleDrawMove([e.lngLat.lng, e.lngLat.lat]);
    });
    fsMap.on('dblclick', (e) => {
        if (fsDrawMode === 'polygon') {
            e.preventDefault();
            fsFinishPolygon();
        }
    });

    fsBindUI();
});

/** Створює джерела/шари для зон та превʼю. */
function fsSetupLayers() {
    fsMap.addSource('fs-zones', { type: 'geojson', data: fsEmptyFC() });
    fsMap.addLayer({
        id: 'fs-zones-fill',
        type: 'fill',
        source: 'fs-zones',
        paint: { 'fill-color': fsZoneColorMatchExpr(), 'fill-opacity': 0.2 },
    });
    fsMap.addLayer({
        id: 'fs-zones-outline',
        type: 'line',
        source: 'fs-zones',
        paint: { 'line-color': fsZoneColorMatchExpr(), 'line-width': 2 },
    });

    // Лінія треку машини (під зонами, щоб зони було зручно малювати поверх)
    fsMap.addSource('fs-track', { type: 'geojson', data: fsEmptyFC() });
    fsMap.addLayer({
        id: 'fs-track-line',
        type: 'line',
        source: 'fs-track',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': FS_CONFIG.trackColor, 'line-width': 3, 'line-opacity': 0.8 },
    }, 'fs-zones-fill');

    fsMap.addSource('fs-preview', { type: 'geojson', data: fsEmptyFC() });
    fsMap.addLayer({
        id: 'fs-preview-fill',
        type: 'fill',
        source: 'fs-preview',
        paint: { 'fill-color': fsZoneColorMatchExpr(), 'fill-opacity': 0.15 },
    });
    fsMap.addLayer({
        id: 'fs-preview-line',
        type: 'line',
        source: 'fs-preview',
        paint: { 'line-color': fsZoneColorMatchExpr(), 'line-width': 2, 'line-dasharray': [2, 1] },
    });

    // Клік по збереженій зоні — виділити у списку
    fsMap.on('click', 'fs-zones-fill', (e) => {
        const id = e.features?.[0]?.properties?.id;
        if (id != null) fsHighlightListItem(id);
    });
    fsMap.on('mouseenter', 'fs-zones-fill', () => { fsMap.getCanvas().style.cursor = 'pointer'; });
    fsMap.on('mouseleave', 'fs-zones-fill', () => {
        fsMap.getCanvas().style.cursor = fsDrawMode ? 'crosshair' : '';
    });
}

function fsEmptyFC() {
    return { type: 'FeatureCollection', features: [] };
}

// ─────────────────────────────────────
// Завантаження та відображення зон
// ─────────────────────────────────────

async function fsLoadZones() {
    try {
        const data = await FS_API.getZones();
        fsZones = Array.isArray(data.zones) ? data.zones : [];
    } catch (err) {
        console.error('Load zones error:', err);
        fsZones = [];
    }
    fsRenderZonesOnMap();
    fsRenderZonesList();
}

/** Оновлює шар зон на карті. */
function fsRenderZonesOnMap() {
    const src = fsMap.getSource('fs-zones');
    if (!src) return;

    const features = fsZones.map(zone => {
        // Зону, що редагується, показуємо живим контуром у шарі превʼю, не тут
        if (fsEditState.active && String(zone.id) === String(fsEditState.zoneId)) return null;
        const coords = fsZoneDisplayCoords(zone);
        if (!coords) return null;
        return {
            type: 'Feature',
            properties: {
                id: zone.id,
                name: zone.name,
                zoneType: fsNormalizeZoneType(zone.type),
            },
            geometry: { type: 'Polygon', coordinates: [coords] },
        };
    }).filter(Boolean);

    src.setData({ type: 'FeatureCollection', features });
}

/** Рендерить список зон у боковій панелі. */
function fsRenderZonesList(filter = '') {
    const container = $fs('fsZonesList');
    if (!container) return;

    const q = filter.trim().toLowerCase();
    const list = q
        ? fsZones.filter(z => (z.name || '').toLowerCase().includes(q))
        : fsZones;

    if (!list.length) {
        container.innerHTML = `<div class="fs-empty">${q ? 'Нічого не знайдено' : 'Немає збережених зон'}</div>`;
        return;
    }

    container.innerHTML = list.map(zone => {
        const isCircle = zone.geometry?.type === 'point';
        const meta = isCircle
            ? `Коло · радіус ${zone.radius_m || '?'} м`
            : 'Полігон';
        const inactive = String(zone.active) === '0' ? ' inactive' : '';
        const typeLabel = fsZoneTypeLabel(zone.type);
        const ignoreCls = fsNormalizeZoneType(zone.type) === 'counting_ignoring' ? ' fs-zone-item--ignore' : '';
        return `
            <div class="fs-zone-item${inactive}${ignoreCls}" data-zone-id="${zone.id}">
                <span class="fs-zone-dot"></span>
                <div class="fs-zone-info">
                    <div class="fs-zone-name">${fsEsc(zone.name)}</div>
                    <div class="fs-zone-meta">${fsEsc(typeLabel)} · ${meta}${inactive ? ' · вимкнена' : ''}</div>
                </div>
                <div class="fs-zone-actions">
                    <button class="btn-icon fs-edit-btn" title="Перейменувати">✎</button>
                    <button class="btn-icon fs-del-btn" title="Видалити">🗑</button>
                </div>
            </div>`;
    }).join('');

    // Обробники
    container.querySelectorAll('.fs-zone-item').forEach(item => {
        const id = parseInt(item.dataset.zoneId, 10);
        item.addEventListener('click', (e) => {
            if (e.target.closest('.fs-edit-btn')) { fsStartEdit(id); return; }
            if (e.target.closest('.fs-del-btn')) { fsDeleteZone(id); return; }
            fsFlyToZone(id);
        });
    });
}

function fsHighlightListItem(id) {
    const item = document.querySelector(`.fs-zone-item[data-zone-id="${id}"]`);
    const zone = fsZones.find(z => String(z.id) === String(id));
    if (!item) return;
    item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    item.style.borderColor = zone ? fsZoneColor(zone.type) : FS_CONFIG.zoneColor;
    setTimeout(() => { item.style.borderColor = ''; }, 1200);
    fsFlyToZone(id);
}

/** Наближає карту до зони. */
function fsFlyToZone(id) {
    const zone = fsZones.find(z => String(z.id) === String(id));
    if (!zone) return;
    const coords = fsZoneDisplayCoords(zone);
    if (!coords || !coords.length) return;

    const bounds = coords.reduce(
        (b, c) => b.extend(c),
        new mapboxgl.LngLatBounds(coords[0], coords[0]),
    );
    fsMap.fitBounds(bounds, { padding: 120, maxZoom: 16, duration: 600 });
}

// ─────────────────────────────────────
// Малювання зон
// ─────────────────────────────────────

function fsStartDraw(mode) {
    fsCancelDraw();
    if (fsEditState.active) fsCancelEdit();
    fsDrawMode = mode;
    fsDrawState = { center: null, points: [], tempMarkers: [], finishedGeom: null };
    fsMap.getCanvas().style.cursor = 'crosshair';
    fsMap.doubleClickZoom.disable();
    fsHighlightDrawBtn(mode);

    const hints = {
        circle: 'Клікніть на карту, щоб поставити центр зони',
        polygon: 'Клікайте, щоб додати точки. Подвійний клік — завершити (мін. 3 точки)',
    };
    fsShowHint(hints[mode] || '');
    $fs('fsStatusMode').textContent = 'Режим: Малювання';
}

function fsCancelDraw() {
    fsDrawMode = null;
    fsDrawState.tempMarkers.forEach(m => m.remove());
    fsDrawState = { center: null, points: [], tempMarkers: [], finishedGeom: null };
    fsMap.getSource('fs-preview')?.setData(fsEmptyFC());
    fsMap.getCanvas().style.cursor = '';
    fsMap.doubleClickZoom.enable();
    fsHighlightDrawBtn(null);
    fsShowHint('');
    $fs('fsStatusMode').textContent = 'Режим: Перегляд';
}

function fsHandleDrawClick(lngLat) {
    switch (fsDrawMode) {
        case 'circle':
            fsDrawState.center = lngLat;
            fsDrawState.tempMarkers.push(fsTempMarker(lngLat));
            fsDrawMode = 'circle_radius';
            fsShowHint('Рухайте мишку і клікніть, щоб задати радіус');
            break;

        case 'circle_radius': {
            const radiusM = Math.round(fsHaversine(fsDrawState.center, lngLat));
            if (radiusM < 1) return;
            fsFinishDraw({
                type: 'circle',
                center: [fsDrawState.center[1], fsDrawState.center[0]], // [lat, lng] для API
                radius: radiusM,
                displayCoords: fsCirclePolygon(fsDrawState.center, radiusM),
            });
            break;
        }

        case 'polygon':
            fsDrawState.points.push(lngLat);
            fsDrawState.tempMarkers.push(fsTempMarker(lngLat));
            fsUpdatePolygonPreview();
            fsShowHint(fsDrawState.points.length >= 3
                ? `Точок: ${fsDrawState.points.length}. Подвійний клік — завершити`
                : `Точок: ${fsDrawState.points.length}. Додайте ще ${3 - fsDrawState.points.length}`);
            break;
    }
}

function fsHandleDrawMove(lngLat) {
    const src = fsMap.getSource('fs-preview');
    if (!src) return;

    let coords = null;
    if (fsDrawMode === 'circle_radius' && fsDrawState.center) {
        coords = fsCirclePolygon(fsDrawState.center, fsHaversine(fsDrawState.center, lngLat));
    } else if (fsDrawMode === 'polygon' && fsDrawState.points.length > 0) {
        coords = [...fsDrawState.points, lngLat, fsDrawState.points[0]];
    }

    if (coords) {
        src.setData({
            type: 'FeatureCollection',
            features: [fsPreviewFeature({ type: 'Polygon', coordinates: [coords] })],
        });
    }
}

function fsUpdatePolygonPreview() {
    const src = fsMap.getSource('fs-preview');
    if (!src || fsDrawState.points.length < 2) return;
    const pts = [...fsDrawState.points, fsDrawState.points[0]];
    src.setData({
        type: 'FeatureCollection',
        features: [fsPreviewFeature({ type: 'Polygon', coordinates: [pts] })],
    });
}

function fsFinishPolygon() {
    if (fsDrawState.points.length < 3) {
        fsShowHint('Потрібно мінімум 3 точки');
        return;
    }
    fsFinishDraw({
        type: 'polygon',
        coords: fsDrawState.points.map(c => [c[1], c[0]]),               // API: [lat, lng]
        displayCoords: [...fsDrawState.points, fsDrawState.points[0]],   // карта: замкнене [lng, lat]
    });
}

/** Завершує малювання: зберігає геометрію, показує превʼю та відкриває модалку. */
function fsFinishDraw(geom) {
    fsDrawState.finishedGeom = geom;
    fsDrawState.tempMarkers.forEach(m => m.remove());
    fsDrawState.tempMarkers = [];
    fsDrawMode = null;
    fsMap.getCanvas().style.cursor = '';
    fsMap.doubleClickZoom.enable();
    fsHighlightDrawBtn(null);
    fsShowHint('');

    // Превʼю готової геометрії
    fsMap.getSource('fs-preview')?.setData({
        type: 'FeatureCollection',
        features: [fsPreviewFeature({ type: 'Polygon', coordinates: [geom.displayCoords] })],
    });

    fsOpenSaveModal();
}

function fsTempMarker(lngLat) {
    const el = document.createElement('div');
    Object.assign(el.style, {
        width: '12px', height: '12px', borderRadius: '50%',
        border: '2px solid #fff', boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
        background: FS_CONFIG.zoneColor,
    });
    return new mapboxgl.Marker({ element: el }).setLngLat(lngLat).addTo(fsMap);
}

// ─────────────────────────────────────
// Редагування геометрії існуючої зони
// ─────────────────────────────────────

/** Запускає режим редагування зони на карті. */
function fsStartEdit(id) {
    const zone = fsZones.find(z => String(z.id) === String(id));
    if (!zone) return;

    // Скидаємо інші режими
    fsCancelDraw();
    fsClearEditHandles();

    fsEditState = {
        active: true,
        zoneId: zone.id,
        isCircle: zone.geometry?.type === 'point',
        center: null,
        radiusM: 0,
        points: [],
        centerHandle: null,
        handles: [],
    };

    if (fsEditState.isCircle) {
        fsEditState.center = [zone.geometry.coordinates[1], zone.geometry.coordinates[0]]; // [lng, lat]
        fsEditState.radiusM = parseInt(zone.radius_m, 10) || 50;
        fsCreateCircleHandles();
    } else {
        const coords = fsZoneDisplayCoords(zone) || [];
        // прибираємо замикаючу точку
        const pts = coords.length > 1 &&
            coords[coords.length - 1][0] === coords[0][0] &&
            coords[coords.length - 1][1] === coords[0][1]
            ? coords.slice(0, -1) : coords.slice();
        fsEditState.points = pts;
        fsCreatePolygonHandles();
    }

    // Ховаємо зону в основному шарі та показуємо живий контур
    fsRenderZonesOnMap();
    fsRenderEditPreview();
    fsFlyToZone(zone.id);

    // Заповнюємо та показуємо панель
    $fs('fsEditName').value = zone.name || '';
    fsSetZoneTypeSelect('fsEditType', zone.type);
    $fs('fsEditActive').checked = String(zone.active) !== '0';
    $fs('fsEditPanel').style.display = 'block';
    $fs('fsStatusMode').textContent = 'Режим: Редагування';

    // Виділяємо активний елемент у списку
    document.querySelectorAll('.fs-zone-item').forEach(el => {
        el.style.borderColor = String(el.dataset.zoneId) === String(zone.id) ? fsZoneColor(zone.type) : '';
    });
}

/** Створює маркери для кола: центр (переміщення) + 4 точки (радіус). */
function fsCreateCircleHandles() {
    const centerEl = fsEditHandleEl('move');
    const centerMarker = new mapboxgl.Marker({ element: centerEl, draggable: true })
        .setLngLat(fsEditState.center)
        .addTo(fsMap);
    fsEditState.centerHandle = centerMarker;

    const directions = [0, 90, 180, 270];
    fsEditState.handles = directions.map(bearing => {
        const pt = fsDestinationPoint(fsEditState.center, fsEditState.radiusM, bearing);
        const marker = new mapboxgl.Marker({ element: fsEditHandleEl('resize'), draggable: true })
            .setLngLat(pt)
            .addTo(fsMap);

        marker.on('drag', () => {
            const pos = marker.getLngLat();
            const newRadius = Math.max(5, Math.round(fsHaversine(fsEditState.center, [pos.lng, pos.lat])));
            fsEditState.radiusM = newRadius;
            fsRepositionCircleHandles(marker);
            fsRenderEditPreview();
        });
        return marker;
    });

    centerMarker.on('drag', () => {
        const pos = centerMarker.getLngLat();
        fsEditState.center = [pos.lng, pos.lat];
        fsRepositionCircleHandles(null);
        fsRenderEditPreview();
    });
}

/** Переставляє радіусні маркери навколо центру. */
function fsRepositionCircleHandles(skipMarker) {
    const directions = [0, 90, 180, 270];
    fsEditState.handles.forEach((h, i) => {
        if (h === skipMarker) return;
        h.setLngLat(fsDestinationPoint(fsEditState.center, fsEditState.radiusM, directions[i]));
    });
}

/** Створює маркери для вершин полігону. */
function fsCreatePolygonHandles() {
    fsEditState.handles = fsEditState.points.map((pt, idx) => {
        const marker = new mapboxgl.Marker({ element: fsEditHandleEl('resize'), draggable: true })
            .setLngLat(pt)
            .addTo(fsMap);

        marker.on('drag', () => {
            const pos = marker.getLngLat();
            fsEditState.points[idx] = [pos.lng, pos.lat];
            fsRenderEditPreview();
        });
        return marker;
    });
}

/** Малює поточний (живий) контур зони, що редагується, у шарі превʼю. */
function fsRenderEditPreview() {
    const src = fsMap.getSource('fs-preview');
    if (!src) return;

    let ring;
    if (fsEditState.isCircle) {
        ring = fsCirclePolygon(fsEditState.center, fsEditState.radiusM);
    } else {
        if (fsEditState.points.length < 3) { src.setData(fsEmptyFC()); return; }
        ring = [...fsEditState.points, fsEditState.points[0]];
    }
    src.setData({
        type: 'FeatureCollection',
        features: [fsPreviewFeature({ type: 'Polygon', coordinates: [ring] })],
    });
}

/** Зберігає відредаговану зону в БД. */
async function fsSaveEdit() {
    if (!fsEditState.active) return;

    const name = $fs('fsEditName').value.trim();
    if (!name) { alert('Введіть назву зони'); return; }

    let apiGeom;
    if (fsEditState.isCircle) {
        apiGeom = {
            type: 'circle',
            center: [fsEditState.center[1], fsEditState.center[0]], // [lat, lng]
            radius: fsEditState.radiusM,
        };
    } else {
        if (fsEditState.points.length < 3) { alert('Полігон потребує мінімум 3 точки'); return; }
        apiGeom = { type: 'polygon', coords: fsEditState.points.map(c => [c[1], c[0]]) }; // [lat, lng]
    }

    const fields = {
        id: String(fsEditState.zoneId),
        type: fsReadZoneTypeSelect('fsEditType'),
        name,
        is_global: '1',
        active: $fs('fsEditActive').checked ? '1' : '0',
        geometry: JSON.stringify(apiGeom),
    };

    const saveBtn = $fs('fsEditSaveBtn');
    saveBtn.disabled = true;
    try {
        const data = await FS_API.saveZone(fields);
        if (!data.ok) throw new Error(data.error || 'Помилка збереження');
        fsCancelEdit();
        await fsLoadZones();
        fsToast(`Зону "${name}" оновлено`);
    } catch (err) {
        console.error('Save edit error:', err);
        alert('Помилка: ' + err.message);
    } finally {
        saveBtn.disabled = false;
    }
}

/** Виходить з режиму редагування без збереження. */
function fsCancelEdit() {
    fsClearEditHandles();
    fsEditState.active = false;
    fsEditState.zoneId = null;
    $fs('fsEditPanel').style.display = 'none';
    $fs('fsStatusMode').textContent = 'Режим: Перегляд';
    fsMap.getSource('fs-preview')?.setData(fsEmptyFC());
    document.querySelectorAll('.fs-zone-item').forEach(el => { el.style.borderColor = ''; });
    fsRenderZonesOnMap();
}

/** Прибирає маркери редагування з карти. */
function fsClearEditHandles() {
    fsEditState.handles.forEach(h => h.remove());
    fsEditState.handles = [];
    if (fsEditState.centerHandle) {
        fsEditState.centerHandle.remove();
        fsEditState.centerHandle = null;
    }
}

/** DOM-елемент маркера редагування. */
function fsEditHandleEl(type) {
    const el = document.createElement('div');
    el.className = `fs-edit-handle fs-handle-${type}`;
    return el;
}

// ─────────────────────────────────────
// Модалка збереження / перейменування
// ─────────────────────────────────────

function fsOpenSaveModal() {
    $fs('fsZoneModalTitle').textContent = 'Нова глобальна зона';
    $fs('fsZoneId').value = '';
    $fs('fsZoneName').value = '';
    fsSetZoneTypeSelect('fsZoneType', 'final_stop');
    $fs('fsZoneActive').checked = true;
    $fs('fsZoneModal').style.display = 'flex';
    $fs('fsZoneName').focus();
}

function fsCloseModal() {
    $fs('fsZoneModal').style.display = 'none';
    // Прибираємо превʼю недозбереженої геометрії
    if (fsDrawState.finishedGeom) {
        fsMap.getSource('fs-preview')?.setData(fsEmptyFC());
        fsDrawState.finishedGeom = null;
    }
}

async function fsSaveZone() {
    const id = $fs('fsZoneId').value;
    const name = $fs('fsZoneName').value.trim();
    const active = $fs('fsZoneActive').checked ? '1' : '0';

    if (!name) { alert('Введіть назву зони'); return; }

    const fields = {
        id: id || '',
        type: fsReadZoneTypeSelect('fsZoneType'),
        name,
        is_global: '1',
        active,
    };

    // Нова зона — додаємо намальовану геометрію.
    // Редагування існуючої без нової геометрії — надсилаємо збережену геометрію повторно.
    if (fsDrawState.finishedGeom) {
        const { displayCoords, ...apiGeom } = fsDrawState.finishedGeom;
        fields.geometry = JSON.stringify(apiGeom);
    } else if (id) {
        const zone = fsZones.find(z => String(z.id) === String(id));
        const apiGeom = fsZoneToApiGeom(zone);
        if (!apiGeom) { alert('Не вдалося визначити геометрію зони'); return; }
        fields.geometry = JSON.stringify(apiGeom);
    } else {
        alert('Геометрія відсутня');
        return;
    }

    const saveBtn = $fs('fsSaveZoneBtn');
    saveBtn.disabled = true;
    try {
        const data = await FS_API.saveZone(fields);
        if (!data.ok) throw new Error(data.error || 'Помилка збереження');
        fsCloseModal();
        fsMap.getSource('fs-preview')?.setData(fsEmptyFC());
        fsDrawState.finishedGeom = null;
        await fsLoadZones();
        fsToast(id ? `Зону "${name}" оновлено` : `Зону "${name}" створено`);
    } catch (err) {
        console.error('Save zone error:', err);
        alert('Помилка: ' + err.message);
    } finally {
        saveBtn.disabled = false;
    }
}

/** Перетворює збережену зону назад у формат геометрії для API. */
function fsZoneToApiGeom(zone) {
    if (!zone?.geometry) return null;
    if (zone.geometry.type === 'point' && zone.radius_m) {
        return {
            type: 'circle',
            center: [zone.geometry.coordinates[0], zone.geometry.coordinates[1]], // [lat, lng]
            radius: parseInt(zone.radius_m, 10),
        };
    }
    if (zone.geometry.type === 'polygon' && zone.geometry.coordinates) {
        return { type: 'polygon', coords: zone.geometry.coordinates }; // вже [lat, lng]
    }
    return null;
}

async function fsDeleteZone(id) {
    const zone = fsZones.find(z => String(z.id) === String(id));
    if (!confirm(`Видалити зону "${zone?.name || id}"?`)) return;
    try {
        const data = await FS_API.deleteZone(id);
        if (!data.ok) throw new Error(data.error || 'Помилка');
        await fsLoadZones();
        fsToast('Зону видалено');
    } catch (err) {
        console.error('Delete zone error:', err);
        alert('Помилка видалення: ' + err.message);
    }
}

// ─────────────────────────────────────
// Трек машини (перегляд GPS-треку для орієнтування)
// Логіка відображення повторює assets/js/track.js (без детекції маршруту)
// ─────────────────────────────────────

/** Завантажує та показує трек машини за IMEI + дату. */
async function fsLoadTrack() {
    const imei = $fs('fsTrackImei').value.trim();
    const date = $fs('fsTrackDate').value;

    if (!imei) {
        fsSetTrackStatus('Введіть IMEI', true);
        $fs('fsTrackImei').focus();
        return;
    }
    if (!date) {
        fsSetTrackStatus('Оберіть дату', true);
        $fs('fsTrackDate').focus();
        return;
    }

    const btn = $fs('fsTrackLoadBtn');
    btn.disabled = true;
    const prevLabel = btn.textContent;
    btn.textContent = 'Завантаження...';
    fsSetTrackStatus('Завантаження треку...');

    try {
        const data = await FS_API.getTrack(imei, date);
        if (data.error) {
            fsSetTrackStatus('Помилка: ' + data.error, true);
            fsClearTrack();
            return;
        }

        fsTrackPoints = Array.isArray(data.points) ? data.points : [];
        if (!fsTrackPoints.length) {
            fsSetTrackStatus('За цю дату немає GPS-даних для цього IMEI', true);
            fsClearTrack(false);
            return;
        }

        fsRenderTrack(true);
        $fs('fsTrackClearBtn').style.display = '';
        fsSetTrackStatus(`Показано точок: ${fsTrackPoints.length}`);
    } catch (err) {
        console.error('Load track error:', err);
        fsSetTrackStatus('Помилка з\'єднання з сервером', true);
    } finally {
        btn.disabled = false;
        btn.textContent = prevLabel;
    }
}

/** Малює лінію треку + маркери початку/кінця на карті. */
function fsRenderTrack(fit = false) {
    const src = fsMap.getSource('fs-track');
    if (!src) return;

    const coords = fsTrackPoints.map(p => [p.lng, p.lat]);

    src.setData(coords.length >= 2
        ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }
        : fsEmptyFC());

    // Маркери початку (зелений) та кінця (червоний)
    fsClearTrackMarkers();
    if (fsTrackPoints.length) {
        const start = fsTrackPoints[0];
        const end = fsTrackPoints[fsTrackPoints.length - 1];
        fsTrackMarkers.push(fsTrackEndpointMarker([start.lng, start.lat], '#4CAF50', 'Початок треку'));
        fsTrackMarkers.push(fsTrackEndpointMarker([end.lng, end.lat], '#ff4444', 'Кінець треку'));
    }

    if (fit && coords.length) {
        const bounds = coords.reduce(
            (b, c) => b.extend(c),
            new mapboxgl.LngLatBounds(coords[0], coords[0]),
        );
        fsMap.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 600 });
    }
}

/** Створює маркер-крапку для точки треку. */
function fsTrackEndpointMarker(lngLat, color, title) {
    const el = document.createElement('div');
    Object.assign(el.style, {
        width: '14px', height: '14px', borderRadius: '50%',
        background: color, border: '3px solid #fff',
        boxShadow: '0 0 6px rgba(0,0,0,0.5)',
    });
    el.title = title || '';
    return new mapboxgl.Marker({ element: el }).setLngLat(lngLat).addTo(fsMap);
}

/** Прибирає маркери треку. */
function fsClearTrackMarkers() {
    fsTrackMarkers.forEach(m => m.remove());
    fsTrackMarkers = [];
}

/** Прибирає трек з карти. */
function fsClearTrack(resetStatus = true) {
    fsTrackPoints = [];
    fsMap.getSource('fs-track')?.setData(fsEmptyFC());
    fsClearTrackMarkers();
    $fs('fsTrackClearBtn').style.display = 'none';
    if (resetStatus) fsSetTrackStatus('');
}

/** Показує статус завантаження треку. */
function fsSetTrackStatus(text, isError = false) {
    const el = $fs('fsTrackStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('error', !!isError && !!text);
}

// ─────────────────────────────────────
// UI: кнопки, підказки, тости
// ─────────────────────────────────────

function fsBindUI() {
    $fs('fsAddCircleBtn')?.addEventListener('click', () => fsToggleDraw('circle'));
    $fs('fsAddPolygonBtn')?.addEventListener('click', () => fsToggleDraw('polygon'));
    $fs('fsFitBounds')?.addEventListener('click', fsFitAllZones);

    $fs('fsMapStyleSelect')?.addEventListener('change', (e) => {
        fsMap.setStyle(`mapbox://styles/mapbox/${e.target.value}`);
        fsMap.once('style.load', () => {
            fsSetupLayers();
            fsRenderZonesOnMap();
            if (fsTrackPoints.length) fsRenderTrack(false);
        });
    });

    $fs('fsSearch')?.addEventListener('input', (e) => fsRenderZonesList(e.target.value));

    // Трек машини
    $fs('fsTrackLoadBtn')?.addEventListener('click', fsLoadTrack);
    $fs('fsTrackClearBtn')?.addEventListener('click', () => fsClearTrack());
    $fs('fsTrackImei')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') fsLoadTrack(); });

    // Дата за замовчуванням — сьогодні
    const dateInput = $fs('fsTrackDate');
    if (dateInput && !dateInput.value) {
        const d = new Date();
        dateInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    $fs('fsSaveZoneBtn')?.addEventListener('click', fsSaveZone);
    $fs('fsCancelZoneBtn')?.addEventListener('click', fsCloseModal);
    $fs('fsCloseZoneModal')?.addEventListener('click', fsCloseModal);
    $fs('fsZoneForm')?.addEventListener('submit', (e) => { e.preventDefault(); fsSaveZone(); });
    $fs('fsZoneType')?.addEventListener('change', fsOnZoneTypeSelectChange);
    $fs('fsEditType')?.addEventListener('change', fsOnZoneTypeSelectChange);

    // Панель редагування геометрії
    $fs('fsEditSaveBtn')?.addEventListener('click', fsSaveEdit);
    $fs('fsEditCancelBtn')?.addEventListener('click', fsCancelEdit);

    // Esc — скасувати малювання / редагування
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if ($fs('fsZoneModal').style.display === 'flex') fsCloseModal();
            else if (fsDrawMode) fsCancelDraw();
            else if (fsEditState.active) fsCancelEdit();
        }
    });
}

function fsToggleDraw(mode) {
    if (fsDrawMode === mode || (fsDrawMode === 'circle_radius' && mode === 'circle')) {
        fsCancelDraw();
    } else {
        fsStartDraw(mode);
    }
}

function fsHighlightDrawBtn(mode) {
    $fs('fsAddCircleBtn')?.classList.toggle('active', mode === 'circle' || mode === 'circle_radius');
    $fs('fsAddPolygonBtn')?.classList.toggle('active', mode === 'polygon');
}

function fsFitAllZones() {
    const all = [];
    fsZones.forEach(z => {
        const coords = fsZoneDisplayCoords(z);
        if (coords) all.push(...coords);
    });
    if (!all.length) return;
    const bounds = all.reduce(
        (b, c) => b.extend(c),
        new mapboxgl.LngLatBounds(all[0], all[0]),
    );
    fsMap.fitBounds(bounds, { padding: FS_CONFIG.fitPadding, maxZoom: 15, duration: 600 });
}

function fsShowHint(text) {
    const el = $fs('fsDrawHint');
    if (!el) return;
    if (text) {
        el.textContent = text;
        el.style.display = 'block';
    } else {
        el.style.display = 'none';
    }
}

function fsToast(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
        position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
        background: '#1f6feb', color: '#fff', padding: '10px 18px', borderRadius: '8px',
        fontSize: '14px', boxShadow: '0 4px 16px rgba(0,0,0,0.4)', zIndex: 9999,
        opacity: '0', transition: 'opacity 0.2s',
    });
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 250);
    }, 2500);
}

function fsEsc(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}
