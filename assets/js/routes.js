/**
 * Routes Manager — Mapbox GL JS Integration
 * Посегментна побудова маршрутів (завжди авто)
 *
 * Структура:
 *  1. Константи та конфігурація
 *  2. DOM-хелпери
 *  3. Стан додатку
 *  4. API-шар
 *  5. Ініціалізація
 *  6. Шари карти (route / display / zones)
 *  7. Побудова маршруту (edit mode)
 *  8. Маркери
 *  9. UI бокової панелі (edit)
 * 10. Toolbar
 * 11. Sidebar (view)
 * 12. Edit mode lifecycle
 * 13. Збереження маршруту
 * 14. Відображення маршрутів (view)
 * 15. Zones — drawing
 * 16. Zones — display & list
 * 17. Properties panel
 * 18. Modals
 * 19. Утиліти
 */

// ─────────────────────────────────────
// 1. КОНСТАНТИ ТА КОНФІГУРАЦІЯ
// ─────────────────────────────────────

const CONFIG = {
    /** Стиль карти за замовчуванням */
    defaultStyle: 'mapbox://styles/mapbox/streets-v12',
    /** Центр карти (Україна) */
    defaultCenter: [32.0, 49.0],
    /** Початковий зум */
    defaultZoom: 6,
    /** Відступ при fitBounds */
    fitPadding: 80,
    /** Кількість точок для генерації кола */
    circlePoints: 64,
    /** Радіус Землі (м) */
    earthRadius: 6_371_000,
    /** Тривалість тосту (мс) */
    toastDuration: 2500,
    /** Затримка resize після fullscreen (мс) */
    resizeDelay: 100,
};

/** Кеш налаштувань карти в localStorage */
const MapPrefs = {
    _key: 'routesMapPrefs',

    /** @returns {{ mapStyle?: string, show3d?: boolean, showTraffic?: boolean, fullscreen?: boolean, showTransitOnly?: boolean }} */
    load() {
        try {
            return JSON.parse(localStorage.getItem(this._key)) || {};
        } catch { return {}; }
    },

    /** @param {Record<string, any>} partial */
    save(partial) {
        try {
            const cur = this.load();
            Object.assign(cur, partial);
            localStorage.setItem(this._key, JSON.stringify(cur));
        } catch { /* ігноруємо */ }
    },
};

const COLORS = {
    default: '#3388ff',
    origin: '#4CAF50',
    waypoint: '#2196F3',
    destination: '#f44336',
    traffic: {
        low: '#4CAF50',
        moderate: '#FF9800',
        heavy: '#f44336',
        severe: '#9C27B0',
        fallback: '#666',
    },
    buildings: '#aaa',
};

const ZONE_TYPES = {
    advertising: { label: 'Рекламна', color: '#FF9800' },
    info: { label: 'Інформаційна', color: '#2196F3' },
    service: { label: 'Сервісна', color: '#9C27B0' },
    custom: { label: 'Кастомна', color: '#607D8B' },
};

/** Mapbox match-expression для кольору зон */
const ZONE_COLOR_EXPR = [
    'match', ['get', 'zone_type'],
    'advertising', '#FF9800',
    'info', '#2196F3',
    'service', '#9C27B0',
    'custom', '#607D8B',
    COLORS.default,
];

/** SVG-іконки, що повторюються */
const ICONS = {
    close: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2.5">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    save: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
        <polyline points="17 21 17 13 7 13 7 21"/>
        <polyline points="7 3 7 8 15 8"/></svg>`,
    edit: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2">
        <path d="M12 20h9"/>
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
    grip: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/>
        <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
        <circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>`,
};

// ─────────────────────────────────────
// 2. DOM-ХЕЛПЕРИ
// ─────────────────────────────────────

/** @param {string} id @returns {HTMLElement|null} */
const $id = (id) => document.getElementById(id);

/** @param {string} sel @param {HTMLElement} [root=document] @returns {HTMLElement|null} */
const $ = (sel, root = document) => root.querySelector(sel);

/** @param {string} sel @param {HTMLElement} [root=document] @returns {NodeListOf<HTMLElement>} */
const $$ = (sel, root = document) => root.querySelectorAll(sel);

// ─────────────────────────────────────
// 3. СТАН ДОДАТКУ
// ─────────────────────────────────────

let map = null;
let isFullscreen = false;
let isEditMode = false;
let isRouteDrawing = false;
let routeDrawMode = 'roads'; // 'roads' | 'straight'
let showTraffic = false;
let show3d = false;
let showTransitOnly = false;   // true = ховаємо всі POI крім транспортних зупинок
let selectedRoute = null;
let isSaving = false;
let isUndoing = false;

/** Масив точок побудови маршруту (edit mode) */
let waypoints = [];   // [{ lngLat: [lng, lat], marker: mapboxgl.Marker }]

/** Масив сегментів між сусідніми точками */
let segments = [];    // [{ geometry, distance, duration }]

/** Дані маршруту, що редагується */
let editingRoute = {
    id: null,
    groupId: null,
    name: '',
    color: COLORS.default,
    zones: [],
    routePath: [],
};

/** Маркери/попапи на карті (view mode) */
const mapObjects = { markers: [], popups: [] };

// --- Zones drawing state ---
let zoneDrawMode = null; // null | 'circle' | 'circle_radius' | 'polygon' | 'rectangle' | 'rectangle_end'
let zoneDrawState = {
    points: [],
    center: null,
    tempMarkers: [],
    finishedGeom: null,
};

// --- Zone editing (resize) state ---
let zoneEditState = {
    active: false,
    zoneIndex: null,
    handles: [],      // mapboxgl.Marker[]
    centerHandle: null,
};

// --- Stops (edit mode) ---
let isStopPlacing = false;   // true коли чекаємо клік по маршруту для розміщення зупинки
let editStops = [];          // [{ id?, name, lngLat: [lng,lat], radius_m, order_index, marker, _deleted? }]
let deletedStopIds = [];     // id стопів, що потрібно видалити при збереженні
let draggedStopRealIndex = null;
let pendingStopLngLat = null; // координати для нового стопу (до відкриття панелі)

// Стан inline-панелі створення/редагування зупинки (з маркерами радіусу на карті)
let stopEditState = {
    active: false,
    mode: null,          // 'create' | 'edit'
    editIndex: null,     // реальний індекс у editStops (для режиму edit)
    center: null,        // [lng, lat]
    radiusM: 50,
    centerHandle: null,  // mapboxgl.Marker — центр (переміщення вздовж маршруту)
    handles: [],         // радіусні маркери
};

/** Режим лише перегляду (роль client): без створення, редагування та видалення */
const ROUTES_READONLY = window.ROUTES_READONLY === true;

// ─────────────────────────────────────
// 4. API-ШАР
// ─────────────────────────────────────

const API = {
    base: 'api/routes.php',

    /**
     * GET-запит до API.
     * @param {Record<string, string>} params
     * @returns {Promise<any>}
     */
    async get(params) {
        const qs = new URLSearchParams(params).toString();
        const res = await fetch(`${this.base}?${qs}`);
        return res.json();
    },

    /**
     * POST-запит до API через FormData.
     * @param {Record<string, string>} fields
     * @returns {Promise<any>}
     */
    async post(fields) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(fields)) {
            fd.append(k, v);
        }
        const res = await fetch(this.base, { method: 'POST', body: fd });
        return res.json();
    },

    getGroups() { return this.get({ action: 'get_groups' }); },
    getRoutes(groupId) { return this.get({ action: 'get_routes', group_id: groupId }); },
    getRoute(id) { return this.get({ action: 'get_route', id }); },

    saveRoute(fields) { return this.post({ action: 'save_route', ...fields }); },
    deleteRoute(id) { return this.post({ action: 'delete_route', id }); },

    createInverse(routeId, name) { return this.post({ action: 'create_inverse', route_id: String(routeId), name: name || '' }); },
    linkRoute(routeId, otherId, inverse) { return this.post({ action: 'link_route', route_id: String(routeId), other_id: String(otherId), inverse: inverse ? '1' : '0' }); },
    unlinkRoute(routeId, otherId) { return this.post({ action: 'unlink_route', route_id: String(routeId), other_id: String(otherId) }); },

    saveZone(fields) { return this.post({ action: 'save_zone', ...fields }); },
    deleteZone(id) { return this.post({ action: 'delete_zone', id }); },

    saveStop(fields) { return this.post({ action: 'save_stop', ...fields }); },
    deleteStop(id) { return this.post({ action: 'delete_stop', id }); },

    saveGroup(fields) { return this.post({ action: 'save_group', ...fields }); },
    deleteGroup(id) { return this.post({ action: 'delete_group', id }); },

    searchRoutes(q) { return this.get({ action: 'search_routes', q }); },

    /**
     * Запит одного сегменту маршруту через Mapbox Directions API.
     * @param {[number,number]} from  [lng, lat]
     * @param {[number,number]} to    [lng, lat]
     * @returns {Promise<{geometry: object, distance: number, duration: number}|null>}
     */
    async fetchSegment(from, to) {
        const coords = `${from[0]},${from[1]};${to[0]},${to[1]}`;
        const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}`
            + `?geometries=geojson&overview=full&access_token=${mapboxgl.accessToken}`;

        try {
            const res = await fetch(url);
            const data = await res.json();

            if (data.routes?.length > 0) {
                const r = data.routes[0];
                return { geometry: r.geometry, distance: r.distance, duration: r.duration };
            }
            console.warn('No route for segment', from, '→', to);
            return straightSegment(from, to);
        } catch (err) {
            console.error('Segment route error:', err);
            return null;
        }
    },
};

// ─────────────────────────────────────
// 5. ІНІЦІАЛІЗАЦІЯ
// ─────────────────────────────────────

// Реєструємо Ctrl+Z одразу при завантаженні скрипта (до Mapbox) — пріоритет над усіма
initKeyboardShortcuts();

document.addEventListener('DOMContentLoaded', () => {
    if (!window.MAPBOX_API_KEY) {
        console.error('Mapbox API key not set');
        return;
    }

    mapboxgl.accessToken = window.MAPBOX_API_KEY;

    // Відновлюємо збережені налаштування
    const prefs = MapPrefs.load();
    const savedStyleId = prefs.mapStyle || 'streets-v12';
    const initialStyle = `mapbox://styles/mapbox/${savedStyleId}`;

    map = new mapboxgl.Map({
        container: 'routesMap',
        style: initialStyle,
        center: CONFIG.defaultCenter,
        zoom: CONFIG.defaultZoom,
        attributionControl: true,
        hash: false,
    });

    // Синхронізуємо селектор стилю з кешем
    const styleSelect = $id('mapStyleSelect');
    if (styleSelect) styleSelect.value = savedStyleId;

    map.addControl(new mapboxgl.NavigationControl(), 'bottom-right');
    map.addControl(new mapboxgl.ScaleControl({ maxWidth: 200 }), 'bottom-left');

    // Geocoder (пошук місць)
    map.addControl(
        new MapboxGeocoder({
            accessToken: mapboxgl.accessToken,
            mapboxgl,
            placeholder: 'Пошук місця...',
            language: 'uk',
            marker: false,
        }),
        'top-right',
    );

    // Координати курсора + zone preview
    map.on('mousemove', (e) => {
        $id('statusCoords').textContent =
            `${e.lngLat.lat.toFixed(6)}, ${e.lngLat.lng.toFixed(6)}`;

        if (zoneDrawMode) handleZoneMouseMove([e.lngLat.lng, e.lngLat.lat]);
    });

    map.on('zoomend', () => {
        $id('statusZoom').textContent = `Zoom: ${Math.round(map.getZoom() * 10) / 10}`;
    });

    map.on('load', () => {
        $id('statusZoom').textContent = `Zoom: ${Math.round(map.getZoom() * 10) / 10}`;
        addRouteLayer();
        addDisplayLayer();
        addZoneLayers();
        addStopLayers();
        addRouteArrowLayers();

        // Відновлюємо збережені перемикачі
        if (prefs.showTraffic) toggleTraffic();
        if (prefs.show3d) toggle3D();
        if (prefs.fullscreen) toggleFullscreen();
        if (prefs.showTransitOnly) toggleTransit();
    });

    // Клік по карті — додавання точки / малювання зони
    map.on('click', handleMapClick);

    // Подвійний клік — завершення полігону зони
    map.on('dblclick', (e) => {
        if (zoneDrawMode === 'polygon' && zoneDrawState.points.length >= 3) {
            e.preventDefault();
            finishPolygonDraw();
        }
    });

    initToolbar();
    initSidebar();
    initEditMode();
    initModals();

    console.log('Routes Map initialized (Mapbox, segment-based)');
});

// ─────────────────────────────────────
// 6. ШАРИ КАРТИ
// ─────────────────────────────────────

/** @returns {{ type: 'FeatureCollection', features: [] }} */
function emptyFC() {
    return { type: 'FeatureCollection', features: [] };
}

/**
 * Додає GeoJSON-джерело + два лінійних шари (casing + line).
 * @param {string} sourceId
 * @param {{ casingWidth: number, lineWidth: number, lineOpacity: number, casingOpacity: number, dasharray?: number[] }} opts
 */
function addLineLayers(sourceId, {
    casingWidth = 10,
    lineWidth = 5,
    lineOpacity = 0.9,
    casingOpacity = 0.3,
    dasharray = undefined,
} = {}) {
    if (map.getSource(sourceId)) return;

    map.addSource(sourceId, { type: 'geojson', data: emptyFC() });

    const colorExpr = ['coalesce', ['get', 'color'], COLORS.default];
    const layout = { 'line-join': 'round', 'line-cap': 'round' };

    // casing (широка напівпрозора обводка)
    map.addLayer({
        id: `${sourceId}-casing`,
        type: 'line',
        source: sourceId,
        layout,
        paint: {
            'line-color': colorExpr,
            'line-width': casingWidth,
            'line-opacity': casingOpacity,
        },
    });

    // основна лінія
    const linePaint = {
        'line-color': colorExpr,
        'line-width': lineWidth,
        'line-opacity': lineOpacity,
    };
    if (dasharray) linePaint['line-dasharray'] = dasharray;

    map.addLayer({
        id: `${sourceId}-line`,
        type: 'line',
        source: sourceId,
        layout,
        paint: linePaint,
    });
}

/** Шар для побудови маршруту (edit mode) */
function addRouteLayer() {
    addLineLayers('route-segments', { casingWidth: 10, lineWidth: 5, lineOpacity: 0.9 });
}

/** Шари для відображення збережених маршрутів (view mode) */
function addDisplayLayer() {
    addLineLayers('display-route', { casingWidth: 8, lineWidth: 4, lineOpacity: 0.85 });

    // Пунктирний шар для існуючого маршруту при редагуванні
    addLineLayers('edit-existing-route', {
        casingWidth: 0,
        lineWidth: 4,
        lineOpacity: 0.4,
        casingOpacity: 0,
        dasharray: [2, 4],
    });
}

/** Стрілки напрямку на маршрутах — symbol-шари поверх ліній */
function addRouteArrowLayers() {
    function addArrowLayer(sourceId) {
        const layerId = sourceId + '-arrows';
        if (map.getLayer(layerId)) return;
        map.addLayer({
            id: layerId,
            type: 'symbol',
            source: sourceId,
            layout: {
                'symbol-placement': 'line',
                'symbol-spacing': 50,
                'text-field': '→',
                'text-size': 24,
                'text-rotation-alignment': 'map',
                'text-keep-upright': false,
                'text-allow-overlap': true,
                'text-ignore-placement': true,
            },
            paint: { 'text-color': '#3388ff', 'text-opacity': 0.95 },
            minzoom: 4,
        });
    }

    addArrowLayer('display-route');
    addArrowLayer('route-segments');
    addArrowLayer('edit-existing-route');
}

/** Шари для зон (display + edit + preview) */
function addZoneLayers() {
    // ---- Display zones (view mode) ----
    addZoneFillOutline('display-zones', { fillOpacity: 0.15, lineOpacity: 0.7, dasharray: [2, 2] });

    // ---- Edit zones (edit mode) ----
    addZoneFillOutline('edit-zones', { fillOpacity: 0.2, lineOpacity: 0.8 });

    // ---- Zone drawing preview ----
    if (!map.getSource('zone-draw-preview')) {
        map.addSource('zone-draw-preview', { type: 'geojson', data: emptyFC() });

        map.addLayer({
            id: 'zone-draw-preview-fill',
            type: 'fill',
            source: 'zone-draw-preview',
            paint: { 'fill-color': COLORS.waypoint, 'fill-opacity': 0.15 },
        });

        map.addLayer({
            id: 'zone-draw-preview-outline',
            type: 'line',
            source: 'zone-draw-preview',
            paint: {
                'line-color': COLORS.waypoint,
                'line-width': 2,
                'line-opacity': 0.8,
                'line-dasharray': [3, 3],
            },
        });
    }
}

/**
 * Створює fill + outline шари для зон.
 * @param {string} sourceId
 * @param {{ fillOpacity: number, lineOpacity: number, dasharray?: number[] }} opts
 */
function addZoneFillOutline(sourceId, { fillOpacity, lineOpacity, dasharray } = {}) {
    if (map.getSource(sourceId)) return;

    map.addSource(sourceId, { type: 'geojson', data: emptyFC() });

    map.addLayer({
        id: `${sourceId}-fill`,
        type: 'fill',
        source: sourceId,
        paint: { 'fill-color': ZONE_COLOR_EXPR, 'fill-opacity': fillOpacity },
    });

    const linePaint = {
        'line-color': ZONE_COLOR_EXPR,
        'line-width': 2,
        'line-opacity': lineOpacity,
    };
    if (dasharray) linePaint['line-dasharray'] = dasharray;

    map.addLayer({
        id: `${sourceId}-outline`,
        type: 'line',
        source: sourceId,
        paint: linePaint,
    });
}

// ─────────────────────────────────────
// 7. ПОБУДОВА МАРШРУТУ (edit mode)
// ─────────────────────────────────────

/** Обробка кліку по карті */
async function handleMapClick(e) {
    if (!isEditMode) return;

    // Zone drawing — перехоплюємо клік
    if (zoneDrawMode) {
        handleZoneClick([e.lngLat.lng, e.lngLat.lat]);
        return;
    }

    // Stop placement — перехоплюємо клік
    if (isStopPlacing) {
        handleStopClick([e.lngLat.lng, e.lngLat.lat]);
        return;
    }

    // Малювання маршруту тільки коли режим активний
    if (!isRouteDrawing) return;

    const lngLat = [e.lngLat.lng, e.lngLat.lat];

    const el = createMarkerElement(waypoints.length);
    const marker = new mapboxgl.Marker({ element: el, draggable: true })
        .setLngLat(lngLat)
        .addTo(map);

    const wp = { lngLat, marker };
    waypoints.push(wp);

    // Drag — динамічно знаходимо індекс
    marker.on('dragend', () => {
        const idx = waypoints.indexOf(wp);
        if (idx >= 0) onMarkerDragEnd(idx);
    });

    if (waypoints.length >= 2) {
        const from = waypoints[waypoints.length - 2].lngLat;
        let seg;
        if (routeDrawMode === 'straight') {
            seg = straightSegment(from, lngLat);
        } else {
            setStatus('Розрахунок сегменту...');
            seg = await API.fetchSegment(from, lngLat);
        }
        if (seg) {
            segments.push(seg);
            updateRouteOnMap();
            setStatus(`Маршрут: ${segments.length} сегм.`);
        } else {
            setStatus('Помилка побудови сегменту');
        }
    } else {
        setStatus('Клікніть наступну точку');
    }

    updateMarkerStyles();
    updateEditUI();
}

/** Перерахунок сусідніх сегментів після перетягування маркера */
async function onMarkerDragEnd(index) {
    const pos = waypoints[index].marker.getLngLat();
    waypoints[index].lngLat = [pos.lng, pos.lat];

    setStatus('Перерахунок сусідніх сегментів...');

    if (index > 0) {
        const seg = routeDrawMode === 'straight'
            ? straightSegment(waypoints[index - 1].lngLat, waypoints[index].lngLat)
            : await API.fetchSegment(waypoints[index - 1].lngLat, waypoints[index].lngLat);
        if (seg) segments[index - 1] = seg;
    }

    if (index < waypoints.length - 1) {
        const seg = routeDrawMode === 'straight'
            ? straightSegment(waypoints[index].lngLat, waypoints[index + 1].lngLat)
            : await API.fetchSegment(waypoints[index].lngLat, waypoints[index + 1].lngLat);
        if (seg) segments[index] = seg;
    }

    updateRouteOnMap();
    updateEditUI();
    setStatus(`Маршрут оновлено (${segments.length} сегм.)`);
}

/**
 * Видалення точки за індексом і перерахунок маршруту.
 * @param {number} index
 */
async function removeEditWaypoint(index) {
    if (index < 0 || index >= waypoints.length) return;

    waypoints[index].marker.remove();
    waypoints.splice(index, 1);

    if (waypoints.length <= 1) {
        segments = [];
    } else if (index === 0) {
        segments.splice(0, 1);
    } else if (index >= waypoints.length) {
        segments.splice(segments.length - 1, 1);
    } else {
        setStatus("Перерахунок з'єднання...");
        const seg = routeDrawMode === 'straight'
            ? straightSegment(waypoints[index - 1].lngLat, waypoints[index].lngLat)
            : await API.fetchSegment(waypoints[index - 1].lngLat, waypoints[index].lngLat);
        segments.splice(index - 1, 2, seg || straightSegment(
            waypoints[index - 1].lngLat,
            waypoints[index].lngLat,
        ));
    }

    updateMarkerStyles();
    updateRouteOnMap();
    updateEditUI();
    setStatus(segments.length > 0 ? `Маршрут: ${segments.length} сегм.` : 'Клікніть на карту');
    showNotification('Точку видалено');
}

/** Видалення останньої точки (Undo) */
async function undoLastPoint() {
    if (waypoints.length === 0 || isUndoing) return;
    isUndoing = true;
    try {
        await removeEditWaypoint(waypoints.length - 1);
    } finally {
        isUndoing = false;
    }
}

// ─────────────────────────────────────
// 7a. ГЕОМЕТРІЯ СЕГМЕНТІВ
// ─────────────────────────────────────

/**
 * Пряма лінія-заглушка між двома точками (коли API не повертає маршрут).
 * @param {[number,number]} from
 * @param {[number,number]} to
 */
function straightSegment(from, to) {
    return {
        geometry: { type: 'LineString', coordinates: [from, to] },
        distance: haversine(from, to),
        duration: 0,
    };
}

/**
 * Формула гаверсинусів — відстань між двома точками на сфері.
 * @param {[number,number]} a  [lng, lat]
 * @param {[number,number]} b  [lng, lat]
 * @returns {number} метри
 */
function haversine(a, b) {
    const toRad = (deg) => deg * Math.PI / 180;
    const dLat = toRad(b[1] - a[1]);
    const dLon = toRad(b[0] - a[0]);
    const x = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1]))
        * Math.sin(dLon / 2) ** 2;
    return CONFIG.earthRadius * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// ─────────────────────────────────────
// 7b. ОНОВЛЕННЯ ЛІНІЇ МАРШРУТУ НА КАРТІ
// ─────────────────────────────────────

/** Збирає координати з усіх сегментів і оновлює джерело карти */
function updateRouteOnMap() {
    const src = map.getSource('route-segments');
    if (!src) return;

    if (segments.length === 0) {
        src.setData(emptyFC());
        // НЕ скидаємо editingRoute.routePath — він може містити існуючий маршрут з БД
        return;
    }

    const allCoords = buildCombinedCoords();
    const color = editingRoute.color || COLORS.default;

    src.setData({
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            properties: { color },
            geometry: { type: 'LineString', coordinates: allCoords },
        }],
    });

    // Зберігаємо у форматі БД: [[lat, lng], ...]
    editingRoute.routePath = allCoords.map(c => [c[1], c[0]]);
}

/** @returns {number[][]} об'єднаний масив координат усіх сегментів */
function buildCombinedCoords() {
    let allCoords = [];
    segments.forEach((seg, i) => {
        if (!seg?.geometry) return;
        const c = seg.geometry.coordinates;
        allCoords = allCoords.concat(i === 0 ? c : c.slice(1));
    });
    return allCoords;
}

// ─────────────────────────────────────
// 8. МАРКЕРИ
// ─────────────────────────────────────

/**
 * Створює DOM-елемент для маркера-кнопки.
 * @param {number} idx — порядковий номер точки
 * @returns {HTMLElement}
 */
function createMarkerElement(idx) {
    const el = document.createElement('div');
    el.className = 'route-waypoint-pin';
    el.textContent = idx === 0 ? 'A' : String(idx);
    Object.assign(el.style, {
        width: '26px', height: '26px', borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '12px', fontWeight: '700', color: '#fff', cursor: 'grab',
        border: '2px solid #fff', boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
        background: COLORS.waypoint, userSelect: 'none',
    });
    return el;
}

/** Перефарбовує маркери: A (зелений) → проміжні (синій) → B (червоний) */
function updateMarkerStyles() {
    const n = waypoints.length;
    waypoints.forEach((wp, i) => {
        const el = wp.marker.getElement();
        let bg, label;
        if (i === 0) { bg = COLORS.origin; label = 'A'; }
        else if (i === n - 1 && n > 1) { bg = COLORS.destination; label = 'B'; }
        else { bg = COLORS.waypoint; label = String(i); }
        el.style.background = bg;
        el.textContent = label;
    });
}

// ─────────────────────────────────────
// 9. UI БОКОВОЇ ПАНЕЛІ (edit mode)
// ─────────────────────────────────────

function updateEditUI() {
    updateEditRouteInfo();
    updateEditWaypointsList();
}

/** Показує статистику маршруту (відстань, час, точки, сегменти) */
function updateEditRouteInfo() {
    const el = $id('routeInfo');
    if (!el) return;

    // Якщо є намальовані сегменти — показуємо їх статистику
    if (segments.length > 0) {
        const dist = segments.reduce((s, seg) => s + (seg?.distance || 0), 0);
        const dur = segments.reduce((s, seg) => s + (seg?.duration || 0), 0);

        const km = (dist / 1000).toFixed(1);
        const mins = Math.round(dur / 60);
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        const time = h > 0 ? `${h} год ${m} хв` : `${m} хв`;

        el.innerHTML = [
            infoRow('Відстань', `${km} км`),
            infoRow('Час у дорозі', time),
            infoRow('Точок', String(waypoints.length)),
            infoRow('Сегментів', String(segments.length)),
        ].join('');
        return;
    }

    // Якщо є існуючий маршрут з БД (без нових сегментів)
    if (editingRoute.routePath?.length >= 2) {
        const rows = [
            infoRow('Маршрут', 'Існуючий (збережений)'),
            infoRow('Точок маршруту', String(editingRoute.routePath.length)),
        ];
        // Показуємо підказку
        rows.push('<div class="route-info-hint" style="font-size:11px;color:var(--muted);margin-top:6px">' +
            'Увімкніть малювання маршруту на тулбарі для побудови нового</div>');
        el.innerHTML = rows.join('');
        return;
    }

    el.innerHTML = '<div class="route-info-empty">Маршрут ще не побудовано</div>';
}

/** @returns {string} HTML-рядок */
function infoRow(label, value) {
    return `<div class="route-info-row">
        <span class="route-info-label">${label}</span>
        <span class="route-info-value">${value}</span>
    </div>`;
}

/** Список waypoint-ів з кнопками видалення */
function updateEditWaypointsList() {
    const el = $id('waypointsList');
    if (!el) return;

    if (waypoints.length === 0) {
        el.innerHTML = '<div class="route-info-empty">Клікніть на карту для додавання точок</div>';
        return;
    }

    const n = waypoints.length;

    el.innerHTML = waypoints.map((wp, i) => {
        let cls, lbl;
        if (i === 0) { cls = 'origin'; lbl = 'A'; }
        else if (i === n - 1 && n > 1) { cls = 'destination'; lbl = 'B'; }
        else { cls = 'waypoint'; lbl = String(i); }

        return `<div class="waypoint-list-item">
            <span class="waypoint-marker ${cls}">${lbl}</span>
            <span class="waypoint-coords">${wp.lngLat[1].toFixed(5)}, ${wp.lngLat[0].toFixed(5)}</span>
            <button class="btn-icon btn-tiny wp-del" data-i="${i}" title="Видалити точку">
                ${ICONS.close}
            </button>
        </div>`;
    }).join('');

    el.querySelectorAll('.wp-del').forEach(btn => {
        btn.addEventListener('click', () => removeEditWaypoint(parseInt(btn.dataset.i)));
    });
}

// ─────────────────────────────────────
// 10. TOOLBAR
// ─────────────────────────────────────

function initToolbar() {
    $id('toolFitBounds')?.addEventListener('click', toggleFullscreen);
    $id('toolTraffic')?.addEventListener('click', toggleTraffic);
    $id('tool3d')?.addEventListener('click', toggle3D);
    $id('toolTransit')?.addEventListener('click', toggleTransit);
    $id('toolUndo')?.addEventListener('click', undoLastPoint);
    $id('toolRouteDraw')?.addEventListener('change', onRouteDrawChange);
    $id('toolAddStop')?.addEventListener('click', toggleStopPlacing);

    $id('mapStyleSelect')?.addEventListener('change', (e) => {
        MapPrefs.save({ mapStyle: e.target.value });
        map.setStyle(`mapbox://styles/mapbox/${e.target.value}`);

        map.once('style.load', () => {
            addRouteLayer();
            addDisplayLayer();
            addZoneLayers();
            addStopLayers();
            addRouteArrowLayers();
            updateRouteOnMap();

            if (selectedRoute && !isEditMode) {
                displayRouteOnMapInternal(selectedRoute);
                if (selectedRoute.zones?.length) displayZonesOnMap(selectedRoute.zones);
                if (selectedRoute.stops?.length) updateDisplayStopCircles(selectedRoute.stops);
            }
            if (isEditMode) {
                updateEditZonesOnMap();
                updateEditStopCircles();
            }
            if (show3d) add3DBuildings();
            if (showTraffic) addTrafficLayer();
            if (showTransitOnly) applyTransitFilter();
        });
    });
}

/** Обробка зміни режиму малювання маршруту (select) */
function onRouteDrawChange() {
    const sel = $id('toolRouteDraw');
    const value = sel?.value ?? '';

    if (!value) {
        isRouteDrawing = false;
        map.getCanvas().style.cursor = '';
        showNotification('Малювання маршруту вимкнено');
        setStatus('Режим: Редагування');
        return;
    }

    routeDrawMode = value; // 'roads' | 'straight'
    isRouteDrawing = true;

    // Вимикаємо конкуруючі режими
    if (zoneDrawMode) cancelZoneDraw();
    if (zoneEditState.active) { clearZoneEdit(); updateZonesList(); }
    if (isStopPlacing) { isStopPlacing = false; $id('toolAddStop')?.classList.remove('active'); }
    highlightActiveZoneBtn(null);
    map.getCanvas().style.cursor = 'crosshair';

    const label = value === 'straight' ? 'По прямій' : 'По дорогах';
    const hasExisting = editingRoute.id && editingRoute.routePath?.length >= 2 && segments.length === 0;
    if (hasExisting) {
        showNotification(`Малювання (${label}): клікніть по карті — замінить існуючий маршрут`);
    } else {
        showNotification(`Малювання маршруту увімкнено (${label})`);
    }
    setStatus(`Малювання: ${label}`);
}

/** Скидає select режиму малювання і вимикає режим */
function resetRouteDrawSelect() {
    const sel = $id('toolRouteDraw');
    if (sel) sel.value = '';
    isRouteDrawing = false;
}

function toggleFullscreen() {
    isFullscreen = !isFullscreen;
    MapPrefs.save({ fullscreen: isFullscreen });

    const sidebar = $id('routesSidebar');
    const header = $('.main-header');
    const container = $('.routes-container');
    const properties = $id('routesProperties');
    const btn = $id('toolFitBounds');

    if (isFullscreen) {
        sidebar.style.display = 'none';
        if (header) header.style.display = 'none';
        if (properties) properties.style.display = 'none';
        container.style.height = '100vh';
        btn.classList.add('active');
    } else {
        sidebar.style.display = '';
        if (header) header.style.display = '';
        container.style.height = '';
        btn.classList.remove('active');
    }

    setTimeout(() => map.resize(), CONFIG.resizeDelay);
}

function toggleTraffic() {
    showTraffic = !showTraffic;
    MapPrefs.save({ showTraffic });
    $id('toolTraffic')?.classList.toggle('active', showTraffic);

    if (showTraffic) {
        addTrafficLayer();
        showNotification('Трафік увімкнено');
    } else {
        removeTrafficLayer();
        showNotification('Трафік вимкнено');
    }
}

function addTrafficLayer() {
    if (!map.getSource('mapbox-traffic')) {
        map.addSource('mapbox-traffic', { type: 'vector', url: 'mapbox://mapbox.mapbox-traffic-v1' });
    }
    if (!map.getLayer('traffic-layer')) {
        map.addLayer({
            id: 'traffic-layer',
            type: 'line',
            source: 'mapbox-traffic',
            'source-layer': 'traffic',
            paint: {
                'line-width': 2,
                'line-color': [
                    'match', ['get', 'congestion'],
                    'low', COLORS.traffic.low,
                    'moderate', COLORS.traffic.moderate,
                    'heavy', COLORS.traffic.heavy,
                    'severe', COLORS.traffic.severe,
                    COLORS.traffic.fallback,
                ],
                'line-opacity': 0.7,
            },
        });
    }
}

function removeTrafficLayer() {
    if (map.getLayer('traffic-layer')) map.removeLayer('traffic-layer');
    if (map.getSource('mapbox-traffic')) map.removeSource('mapbox-traffic');
}

function toggle3D() {
    show3d = !show3d;
    MapPrefs.save({ show3d });
    $id('tool3d')?.classList.toggle('active', show3d);

    if (show3d) {
        add3DBuildings();
        map.easeTo({ pitch: 45 });
        showNotification('3D будівлі увімкнено');
    } else {
        remove3DBuildings();
        map.easeTo({ pitch: 0 });
        showNotification('3D будівлі вимкнено');
    }
}

// ─── Transit-only filter ────────────────────────────────────────────
function toggleTransit() {
    showTransitOnly = !showTransitOnly;
    MapPrefs.save({ showTransitOnly });
    $id('toolTransit')?.classList.toggle('active', showTransitOnly);
    applyTransitFilter();
    showNotification(showTransitOnly
        ? 'Тільки зупинки транспорту'
        : 'Усі іконки карти');
}

/**
 * Ховає/показує всі POI-шари карти, окрім тих що містять transit/bus/rail/ferry/tram/subway.
 * Працює з будь-яким стилем Mapbox (streets, satellite-streets тощо).
 */
function applyTransitFilter() {
    const style = map.getStyle();
    if (!style || !style.layers) return;

    // Ключові слова, які вказують на транспортний шар
    const transitRe = /transit|bus|rail|ferry|tram|subway|train|station|aerialway|airport/i;

    for (const layer of style.layers) {
        // Цікавлять лише symbol-шари з source-layer "poi_label" або подібні POI
        if (layer.type !== 'symbol') continue;
        const sl = layer['source-layer'] || '';
        // Mapbox v8+ styles: poi_label;  v11+ / standard: poi
        if (!/^poi/.test(sl)) continue;

        // Якщо шар — транспортний, завжди показуємо
        if (transitRe.test(layer.id)) continue;

        // Для решти POI: ховаємо або показуємо
        map.setLayoutProperty(layer.id, 'visibility',
            showTransitOnly ? 'none' : 'visible');
    }
}

function add3DBuildings() {
    if (map.getLayer('3d-buildings')) return;

    const layers = map.getStyle().layers;
    let labelLayerId;
    for (const layer of layers) {
        if (layer.type === 'symbol' && layer.layout['text-field']) {
            labelLayerId = layer.id;
            break;
        }
    }

    map.addLayer({
        id: '3d-buildings',
        source: 'composite',
        'source-layer': 'building',
        filter: ['==', 'extrude', 'true'],
        type: 'fill-extrusion',
        minzoom: 14,
        paint: {
            'fill-extrusion-color': COLORS.buildings,
            'fill-extrusion-height': ['get', 'height'],
            'fill-extrusion-base': ['get', 'min_height'],
            'fill-extrusion-opacity': 0.5,
        },
    }, labelLayerId);
}

function remove3DBuildings() {
    if (map.getLayer('3d-buildings')) map.removeLayer('3d-buildings');
}

// ─────────────────────────────────────
// 11. SIDEBAR (view mode)
// ─────────────────────────────────────

/** Таймер debounce для пошуку */
let _searchTimer = null;
/** Чи зараз відображаються результати пошуку */
let _isSearchActive = false;

function initSidebar() {
    initSidebarHandlers();
    $id('addGroupBtn')?.addEventListener('click', () => openGroupModal());
    $id('createFirstGroup')?.addEventListener('click', () => openGroupModal());

    $id('routeSearch')?.addEventListener('input', (e) => {
        const q = e.target.value.trim();
        clearTimeout(_searchTimer);

        if (!q) {
            restoreGroupsView();
            return;
        }

        _searchTimer = setTimeout(() => searchRoutes(q), 300);
    });
}

function initSidebarHandlers() {
    $$('.tree-group-header').forEach(header => {
        header.addEventListener('click', (e) => {
            if (e.target.closest('.tree-group-actions')) return;
            const group = header.closest('.tree-group');
            const routesDiv = group.querySelector('.tree-routes');
            const isExpanded = group.classList.contains('expanded');

            if (isExpanded) {
                group.classList.remove('expanded');
                routesDiv.style.display = 'none';
            } else {
                group.classList.add('expanded');
                routesDiv.style.display = 'block';
                loadGroupRoutes(group.dataset.groupId);
            }
        });
    });

    $$('.add-route-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            enterEditMode(null, btn.closest('.tree-group').dataset.groupId);
        });
    });

    $$('.edit-group-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const group = btn.closest('.tree-group');
            openGroupModal(group.dataset.groupId, group.querySelector('.tree-group-name').textContent);
        });
    });
}

/** Завантажує маршрути групи через API та відображає в дереві */
async function loadGroupRoutes(groupId) {
    const group = $(`.tree-group[data-group-id="${groupId}"]`);
    const routesDiv = group.querySelector('.tree-routes');

    try {
        const data = await API.getRoutes(groupId);

        if (data.routes?.length > 0) {
            routesDiv.innerHTML = data.routes.map(route => {
                const color = route.additional?.color || COLORS.default;
                const distBadge = route.length_m
                    ? `<span class="tree-route-badge">${formatDistance(route.length_m)}</span>`
                    : '';
                return `<div class="tree-route ${route.active != 1 ? 'inactive' : ''}"
                    data-route-id="${route.id}">
                    <span class="tree-route-color" style="background: ${color}"></span>
                    <span class="tree-route-name">${escapeHtml(route.name)}</span>
                    ${distBadge}
                </div>`;
            }).join('');

            routesDiv.querySelectorAll('.tree-route').forEach(el => {
                el.addEventListener('click', () => selectRoute(el.dataset.routeId));
            });
        } else {
            routesDiv.innerHTML = '<div class="tree-loading">Немає маршрутів</div>';
        }
    } catch {
        routesDiv.innerHTML = '<div class="tree-loading" style="color:#ff6b6b">Помилка</div>';
    }
}

/**
 * Шукає маршрути через API та показує результати у бічній панелі.
 * @param {string} query
 */
async function searchRoutes(query) {
    const tree = $id('routesTree');
    if (!tree) return;

    try {
        const data = await API.searchRoutes(query);
        const routes = data.routes || [];

        _isSearchActive = true;

        if (routes.length === 0) {
            tree.innerHTML = '<div class="tree-loading">Нічого не знайдено</div>';
            return;
        }

        tree.innerHTML = routes.map(route => {
            const color = route.additional?.color || COLORS.default;
            const distBadge = route.length_m
                ? `<span class="tree-route-badge">${formatDistance(route.length_m)}</span>`
                : '';
            const groupLabel = route.group_name
                ? `<span class="tree-route-group-label">${escapeHtml(route.group_name)}</span>`
                : '';
            return `<div class="tree-route search-result ${route.active != 1 ? 'inactive' : ''}"
                data-route-id="${route.id}" style="padding-left:12px">
                <span class="tree-route-color" style="background: ${color}"></span>
                <span class="tree-route-name">${escapeHtml(route.name)}</span>
                ${distBadge}
                ${groupLabel}
            </div>`;
        }).join('');

        tree.querySelectorAll('.tree-route').forEach(el => {
            el.addEventListener('click', () => selectRoute(el.dataset.routeId));
        });
    } catch (err) {
        console.error('Search error:', err);
        tree.innerHTML = '<div class="tree-loading" style="color:#ff6b6b">Помилка пошуку</div>';
    }
}

/** Відновлює звичайний вигляд дерева груп після очищення пошуку */
async function restoreGroupsView() {
    if (!_isSearchActive) return;
    _isSearchActive = false;
    await refreshGroupsList();
}

// ─────────────────────────────────────
// 12. EDIT MODE LIFECYCLE
// ─────────────────────────────────────

function initEditMode() {
    $id('backToListBtn')?.addEventListener('click', exitEditMode);
    $id('cancelRouteFullBtn')?.addEventListener('click', exitEditMode);
    $id('saveRouteFullBtn')?.addEventListener('click', saveFullRoute);

    $id('editRouteColor')?.addEventListener('change', (e) => {
        editingRoute.color = e.target.value;
        updateRouteOnMap();
    });

    // Zone buttons
    $id('addZoneCircleBtn')?.addEventListener('click', () => startZoneDraw('circle'));
    $id('addZonePolygonBtn')?.addEventListener('click', () => startZoneDraw('polygon'));
    $id('addZoneRectBtn')?.addEventListener('click', () => startZoneDraw('rectangle'));
}

/**
 * Входить у режим редагування маршруту.
 * @param {string|null} routeId   — id існуючого маршруту або null для нового
 * @param {string}      groupId   — id групи
 * @param {object}      [routeData] — повні дані маршруту (при редагуванні)
 */
async function enterEditMode(routeId, groupId, routeData) {
    if (ROUTES_READONLY) return;
    isEditMode = true;

    // Показуємо edit-tools на тулбарі
    const editTools = $id('toolbarEditTools');
    if (editTools) editTools.style.display = 'flex';

    // Для нового маршруту — одразу вмикаємо малювання
    // Для існуючого — не вмикаємо, щоб можна було редагувати зони/метадані без перемальовування
    const isNew = !routeId;
    if (isNew) {
        isRouteDrawing = true;
        const drawSel = $id('toolRouteDraw');
        if (drawSel) drawSel.value = routeDrawMode || 'roads';
        map.getCanvas().style.cursor = 'crosshair';
    } else {
        resetRouteDrawSelect();
        map.getCanvas().style.cursor = '';
    }

    // Отримуємо колір групи за замовчуванням
    let defaultColor = COLORS.default;
    try {
        const data = await API.getGroups();
        const group = data.groups?.find(g => g.id == groupId);
        if (group?.additional?.color) defaultColor = group.additional.color;
    } catch { /* ігноруємо */ }

    const routeName = routeData?.name || '';
    const routeColor = routeData?.additional?.color || defaultColor;

    // Зберігаємо існуючі координати маршруту (формат БД: [[lat, lng], ...])
    const existingPath = routeData?.coordinates || [];

    editingRoute = {
        id: routeId,
        groupId,
        name: routeName,
        color: routeColor,
        routeKind: routeData?.route_kind || 'city',
        zones: routeData?.zones || [],
        routePath: existingPath,
    };

    // Очищаємо попередній стан малювання (але НЕ routePath — він вже встановлений вище)
    waypoints.forEach(wp => wp.marker.remove());
    waypoints = [];
    segments = [];
    setSourceData('route-segments', emptyFC());

    clearMapDisplay();
    cancelZoneDraw();
    clearZoneEdit();
    clearEditStops();

    // Перемикаємо сайдбар
    $id('sidebarListMode').style.display = 'none';
    $id('sidebarEditMode').style.display = 'flex';
    $id('editModeTitle').textContent = routeId ? 'Редагувати маршрут' : 'Новий маршрут';

    $id('editRouteId').value = routeId || '';
    $id('editRouteGroupId').value = groupId || '';
    $id('editRouteName').value = routeName;
    $id('editRouteColor').value = routeColor;

    // Показуємо існуючий маршрут (пунктиром) та зберігаємо routePath
    if (existingPath.length >= 2) {
        const coords = existingPath.map(c => [c[1], c[0]]); // [lat,lng] → [lng,lat]
        const src = map.getSource('edit-existing-route');
        if (src) {
            src.setData({
                type: 'FeatureCollection',
                features: [{
                    type: 'Feature',
                    properties: { color: routeColor },
                    geometry: { type: 'LineString', coordinates: coords },
                }],
            });
        }
        fitBoundsToCoords(coords);
    }

    // Завантажуємо існуючі зупинки маршруту
    if (routeData?.stops?.length) {
        for (const s of routeData.stops) {
            if (!s.coordinates || s.coordinates.length < 2) continue;
            const stop = {
                id: s.id,
                name: s.name,
                lngLat: [s.coordinates[1], s.coordinates[0]], // [lat,lng] → [lng,lat]
                radius_m: parseInt(s.radius_m) || 20,
                order_index: parseInt(s.order_index) || 0,
                marker: null,
            };
            stop.marker = createEditStopMarker(stop);
            editStops.push(stop);
        }
        syncStopOrderIndices();
        updateEditStopCircles();
    }

    updateEditUI();
    updateEditZonesOnMap();
    updateZonesList();
    updateStopsList();
    setStatus('Режим: Редагування');
    showNotification(routeId
        ? 'Редагуйте зони, колір чи назву. Увімкніть малювання для нового маршруту'
        : 'Клікніть по карті для додавання точок');
}

/** Вихід з режиму редагування */
function exitEditMode() {
    // Попередження, якщо є незбережені зміни (нові точки, нові зони, нові зупинки)
    const hasNewDrawing = waypoints.length > 0;
    const hasNewZones = editingRoute.zones.some(z => !z.id);
    const hasModifiedZones = editingRoute.zones.some(z => z.id && z._geomForAPI);
    const hasNewStops = editStops.some(s => !s.id);
    const hasDeletedStops = deletedStopIds.length > 0;
    if (isEditMode && (hasNewDrawing || hasNewZones || hasModifiedZones || hasNewStops || hasDeletedStops)) {
        if (!confirm('Ви впевнені? Незбережені зміни будуть втрачені.')) return;
    }

    isEditMode = false;
    isRouteDrawing = false;
    clearEditWaypoints();
    cancelZoneDraw();
    clearZoneEdit();
    clearEditStops();

    // Ховаємо edit-tools на тулбарі та скидаємо стан
    const editTools = $id('toolbarEditTools');
    if (editTools) editTools.style.display = 'none';
    resetRouteDrawSelect();
    map.getCanvas().style.cursor = '';

    setSourceData('edit-existing-route', emptyFC());
    setSourceData('edit-zones', emptyFC());
    setSourceData('edit-stop-circles', emptyFC());

    $id('sidebarListMode').style.display = 'block';
    $id('sidebarEditMode').style.display = 'none';
    setStatus('Режим: Перегляд');
}

/** Очищає всі waypoints і сегменти (не торкається editingRoute.routePath) */
function clearEditWaypoints() {
    waypoints.forEach(wp => wp.marker.remove());
    waypoints = [];
    segments = [];

    setSourceData('route-segments', emptyFC());
    updateEditUI();
}

// ─────────────────────────────────────
// 13. ЗБЕРЕЖЕННЯ МАРШРУТУ
// ─────────────────────────────────────

/** Зберігає маршрут (геометрія + зони) */
async function saveFullRoute() {
    if (isSaving) return;

    const name = $id('editRouteName').value.trim();
    const groupId = $id('editRouteGroupId').value;
    const color = $id('editRouteColor').value;

    if (!name) { alert('Введіть назву'); return; }

    // routePath містить або новий маршрут (якщо малювали), або існуючий з БД
    const routePath = editingRoute.routePath;

    if (!routePath || routePath.length < 2) {
        alert('Побудуйте маршрут (потрібно мінімум 2 точки)');
        return;
    }

    isSaving = true;
    const saveBtn = $id('saveRouteFullBtn');
    if (saveBtn) saveBtn.disabled = true;

    try {
        const saveFields = {
            id: editingRoute.id || '',
            group_id: groupId,
            name,
            route_kind: editingRoute.routeKind || 'city',
            active: '1',
            coordinates: JSON.stringify(routePath),
            additional: JSON.stringify({ color }),
        };

        const data = await API.saveRoute(saveFields);

        if (!data.ok) throw new Error(data.error);

        const routeId = data.id;

        // Зберігаємо нові зони (без id) та оновлені існуючі зони (з _geomForAPI)
        for (const zone of editingRoute.zones) {
            // Нова зона (без id) — створюємо
            if (!zone.id) {
                const fields = {
                    route_id: routeId,
                    name: zone.name,
                    type: zone.type,
                    active: '1',
                };
                if (zone._geomForAPI) {
                    const { displayCoords, ...apiGeom } = zone._geomForAPI;
                    fields.geometry = JSON.stringify(apiGeom);
                }
                await API.saveZone(fields);
            }
            // Існуюча зона, яку змінили (є _geomForAPI) — оновлюємо
            else if (zone._geomForAPI) {
                const { displayCoords, ...apiGeom } = zone._geomForAPI;
                await API.saveZone({
                    id: zone.id,
                    route_id: routeId,
                    name: zone.name,
                    type: zone.type,
                    active: String(zone.active ?? 1),
                    geometry: JSON.stringify(apiGeom),
                });
            }
        }

        // Зберігаємо зупинки
        // Видаляємо позначені для видалення
        for (const stopId of deletedStopIds) {
            try { await API.deleteStop(stopId); } catch (e) { console.error('Delete stop error:', e); }
        }

        // Зберігаємо нові та оновлені зупинки
        for (let i = 0; i < editStops.length; i++) {
            const stop = editStops[i];
            if (stop._deleted) continue;
            try {
                await API.saveStop({
                    id: stop.id || '',
                    route_id: routeId,
                    name: stop.name,
                    lat: String(stop.lngLat[1]),
                    lng: String(stop.lngLat[0]),
                    radius_m: String(stop.radius_m),
                    order_index: String(i),
                    active: '1',
                });
            } catch (e) {
                console.error('Save stop error:', e);
            }
        }

        showNotification(`Маршрут "${name}" збережено!`);

        // Виходимо з edit mode без підтвердження
        isEditMode = false;
        isRouteDrawing = false;
        clearEditWaypoints();
        clearZoneEdit();
        clearEditStops();

        // Ховаємо edit-tools на тулбарі та скидаємо стан
        const editToolsSave = $id('toolbarEditTools');
        if (editToolsSave) editToolsSave.style.display = 'none';
        resetRouteDrawSelect();
        map.getCanvas().style.cursor = '';

        setSourceData('edit-existing-route', emptyFC());
        setSourceData('edit-zones', emptyFC());
        setSourceData('edit-stop-circles', emptyFC());

        $id('sidebarListMode').style.display = 'block';
        $id('sidebarEditMode').style.display = 'none';
        setStatus('Режим: Перегляд');

        await refreshGroupsList();

        const group = $(`.tree-group[data-group-id="${groupId}"]`);
        if (group) {
            group.classList.add('expanded');
            group.querySelector('.tree-routes').style.display = 'block';
            await loadGroupRoutes(groupId);
        }
    } catch (error) {
        alert(`Помилка: ${error.message}`);
    } finally {
        isSaving = false;
        if (saveBtn) saveBtn.disabled = false;
    }
}

// ─────────────────────────────────────
// 14. ВІДОБРАЖЕННЯ МАРШРУТІВ (view mode)
// ─────────────────────────────────────

/** Вибір маршруту в дереві */
async function selectRoute(routeId) {
    $$('.tree-route').forEach(el =>
        el.classList.toggle('active', el.dataset.routeId == routeId),
    );

    try {
        const data = await API.getRoute(routeId);
        if (data.route) {
            selectedRoute = data.route;
            displayRouteOnMap(data.route);
            openRouteProperties(data.route);
        }
    } catch (error) {
        console.error(error);
    }
}

/** Відображає маршрут, зупинки та зони на карті */
function displayRouteOnMap(route) {
    clearMapDisplay();

    if (route.coordinates?.length >= 2) {
        displayRouteOnMapInternal(route);
    }

    route.stops?.forEach(s => addStopToMap(s));
    updateDisplayStopCircles(route.stops);

    if (route.zones?.length > 0) {
        displayZonesOnMap(route.zones);
    }
}

/** Внутрішня функція: відображає лінію маршруту та підлітає до неї */
function displayRouteOnMapInternal(route) {
    const src = map.getSource('display-route');
    if (!src || route.coordinates?.length < 2) return;

    const coords = route.coordinates.map(c => [c[1], c[0]]); // [lat,lng] → [lng,lat]
    const routeColor = route.additional?.color || COLORS.default;

    src.setData({
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            properties: { color: routeColor },
            geometry: { type: 'LineString', coordinates: coords },
        }],
    });

    fitBoundsToCoords(coords);
}

/** Додає маркер зупинки на карту */
function addStopToMap(stop) {
    if (!stop.coordinates || stop.coordinates.length < 2) return;

    const el = document.createElement('div');
    Object.assign(el.style, {
        width: '16px', height: '16px', borderRadius: '50%',
        background: COLORS.origin,
        border: '2px solid #fff', boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
    });

    const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([stop.coordinates[1], stop.coordinates[0]])
        .setPopup(new mapboxgl.Popup({ offset: 12 }).setText(stop.name || 'Зупинка'))
        .addTo(map);

    mapObjects.markers.push(marker);
}

/** Очищає карту від маршрутів, зупинок та зон (view mode) */
function clearMapDisplay() {
    setSourceData('display-route', emptyFC());
    setSourceData('display-zones', emptyFC());
    setSourceData('display-stop-circles', emptyFC());

    mapObjects.markers.forEach(m => m.remove());
    mapObjects.markers = [];

    mapObjects.popups.forEach(p => p.remove());
    mapObjects.popups = [];
}

// ─────────────────────────────────────
// 15. ZONES — DRAWING
// ─────────────────────────────────────

/**
 * Запуск режиму малювання зони.
 * @param {'circle'|'polygon'|'rectangle'} mode
 */
function startZoneDraw(mode) {
    if (!isEditMode) {
        showNotification('Увійдіть в режим редагування', 'warning');
        return;
    }

    if (zoneDrawMode) cancelZoneDraw();
    if (zoneEditState.active) { clearZoneEdit(); updateZonesList(); }

    // Вимикаємо режим малювання маршруту
    if (isRouteDrawing) resetRouteDrawSelect();

    zoneDrawMode = mode;
    zoneDrawState = { points: [], center: null, tempMarkers: [], finishedGeom: null };
    map.getCanvas().style.cursor = 'crosshair';

    // Підсвічуємо активну кнопку зони
    highlightActiveZoneBtn(mode);

    const hints = {
        circle: 'Клікніть на карту для розміщення центру зони',
        polygon: 'Клікніть точки полігону. Подвійний клік для завершення (мін. 3 точки)',
        rectangle: 'Клікніть першу точку прямокутника',
    };

    updateZoneDrawHint(hints[mode] || '');
    setStatus(`Малювання зони: ${mode}`);
}

/** Скасування малювання зони */
function cancelZoneDraw() {
    zoneDrawMode = null;

    zoneDrawState.tempMarkers.forEach(m => m.remove());
    zoneDrawState = { points: [], center: null, tempMarkers: [], finishedGeom: null };

    setSourceData('zone-draw-preview', emptyFC());
    map.getCanvas().style.cursor = isRouteDrawing ? 'crosshair' : '';
    highlightActiveZoneBtn(null);
    updateZoneDrawHint('');
    setStatus(isEditMode ? (isRouteDrawing ? 'Малювання маршруту' : 'Режим: Редагування') : 'Режим: Перегляд');
}

/** Обробка кліку при малюванні зони */
function handleZoneClick(lngLat) {
    switch (zoneDrawMode) {
        case 'circle':
            zoneDrawState.center = lngLat;
            zoneDrawState.tempMarkers.push(createTempMarker(lngLat, COLORS.destination));
            zoneDrawMode = 'circle_radius';
            updateZoneDrawHint('Рухайте мишку і клікніть для встановлення радіусу');
            break;

        case 'circle_radius': {
            const radiusM = haversine(zoneDrawState.center, lngLat);
            const circleCoords = generateCirclePolygon(zoneDrawState.center, radiusM);
            finishZoneDraw({
                type: 'circle',
                center: [zoneDrawState.center[1], zoneDrawState.center[0]], // [lat, lng] for API
                radius: Math.round(radiusM),
                displayCoords: circleCoords,
            });
            break;
        }

        case 'polygon': {
            zoneDrawState.points.push(lngLat);
            zoneDrawState.tempMarkers.push(createTempMarker(lngLat, COLORS.waypoint));
            updatePolygonPreview();

            const count = zoneDrawState.points.length;
            const hint = count >= 3
                ? `Точок: ${count}. Подвійний клік для завершення`
                : `Точок: ${count}. Додайте ще ${3 - count} точ.`;
            updateZoneDrawHint(hint);
            break;
        }

        case 'rectangle':
            zoneDrawState.points.push(lngLat);
            zoneDrawState.tempMarkers.push(createTempMarker(lngLat, ZONE_TYPES.advertising.color));
            zoneDrawMode = 'rectangle_end';
            updateZoneDrawHint('Клікніть протилежний кут прямокутника');
            break;

        case 'rectangle_end': {
            const c1 = zoneDrawState.points[0];
            const c2 = lngLat;

            finishZoneDraw({
                type: 'polygon',
                // API: not closed, [lat, lng]
                coords: [
                    [c1[1], c1[0]], [c1[1], c2[0]],
                    [c2[1], c2[0]], [c2[1], c1[0]],
                ],
                // Map: closed ring, [lng, lat]
                displayCoords: [
                    [c1[0], c1[1]], [c2[0], c1[1]],
                    [c2[0], c2[1]], [c1[0], c2[1]],
                    [c1[0], c1[1]],
                ],
            });
            break;
        }
    }
}

/** Превʼю зони при русі миші */
function handleZoneMouseMove(lngLat) {
    const previewSrc = map.getSource('zone-draw-preview');
    if (!previewSrc) return;

    let coords;

    if (zoneDrawMode === 'circle_radius' && zoneDrawState.center) {
        const radiusM = haversine(zoneDrawState.center, lngLat);
        coords = generateCirclePolygon(zoneDrawState.center, radiusM);
    } else if (zoneDrawMode === 'polygon' && zoneDrawState.points.length > 0) {
        coords = [...zoneDrawState.points, lngLat, zoneDrawState.points[0]];
    } else if (zoneDrawMode === 'rectangle_end' && zoneDrawState.points.length === 1) {
        const c1 = zoneDrawState.points[0];
        coords = [
            [c1[0], c1[1]], [lngLat[0], c1[1]],
            [lngLat[0], lngLat[1]], [c1[0], lngLat[1]],
            [c1[0], c1[1]],
        ];
    }

    if (coords) {
        previewSrc.setData({
            type: 'FeatureCollection',
            features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords] } }],
        });
    }
}

function updatePolygonPreview() {
    const previewSrc = map.getSource('zone-draw-preview');
    if (!previewSrc || zoneDrawState.points.length < 2) return;

    const pts = [...zoneDrawState.points, zoneDrawState.points[0]];
    previewSrc.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [pts] } }],
    });
}

function finishPolygonDraw() {
    if (zoneDrawState.points.length < 3) return;

    finishZoneDraw({
        type: 'polygon',
        coords: zoneDrawState.points.map(c => [c[1], c[0]]),               // API: [lat, lng], not closed
        displayCoords: [...zoneDrawState.points, zoneDrawState.points[0]], // Map: [lng, lat], closed
    });
}

/**
 * Завершує малювання зони — зберігає геометрію та відкриває модалку.
 * @param {object} geom
 */
function finishZoneDraw(geom) {
    zoneDrawState.finishedGeom = geom;
    zoneDrawState.tempMarkers.forEach(m => m.remove());
    zoneDrawState.tempMarkers = [];

    map.getCanvas().style.cursor = isRouteDrawing ? 'crosshair' : '';
    zoneDrawMode = null;
    highlightActiveZoneBtn(null);
    updateZoneDrawHint('');

    openZoneFormModal();
}

/**
 * Створює тимчасовий маркер-точку.
 * @param {[number,number]} lngLat
 * @param {string} color
 * @returns {mapboxgl.Marker}
 */
function createTempMarker(lngLat, color) {
    const el = document.createElement('div');
    Object.assign(el.style, {
        width: '12px', height: '12px', borderRadius: '50%',
        border: '2px solid #fff', boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
        background: color,
    });
    return new mapboxgl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
}

// ─────────────────────────────────────
// 15a. ZONES — CIRCLE GENERATION
// ─────────────────────────────────────

/**
 * Генерує полігональне наближення кола.
 * @param {[number,number]} center  [lng, lat]
 * @param {number} radiusM  радіус у метрах
 * @param {number} [numPoints=64]
 * @returns {[number,number][]}  координати полігону [lng, lat]
 */
function generateCirclePolygon(center, radiusM, numPoints = CONFIG.circlePoints) {
    const coords = [];
    const lat = center[1] * Math.PI / 180;
    const lng = center[0] * Math.PI / 180;
    const d = radiusM / CONFIG.earthRadius; // angular distance

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

// ─────────────────────────────────────
// 16. ZONES — FORM MODAL, DISPLAY, LIST
// ─────────────────────────────────────

function openZoneFormModal() {
    $id('zoneModalTitle').textContent = 'Нова зона';
    $id('zoneName').value = '';
    $id('zoneType').value = 'advertising';
    $id('zoneModal').style.display = 'flex';
    $id('zoneName').focus();
}

function closeZoneFormModal() {
    $id('zoneModal').style.display = 'none';

    if (zoneDrawState.finishedGeom) {
        setSourceData('zone-draw-preview', emptyFC());
        zoneDrawState.finishedGeom = null;
    }
}

/** Зберігає зону з модального вікна до editingRoute */
function saveZoneFromModal() {
    const name = $id('zoneName').value.trim();
    const type = $id('zoneType').value;

    if (!name) { alert('Введіть назву зони'); return; }
    if (!zoneDrawState.finishedGeom) { alert('Геометрія відсутня'); return; }

    const geom = zoneDrawState.finishedGeom;

    const zone = {
        name,
        type,
        active: 1,
        _geomForAPI: geom,
        _displayCoords: geom.displayCoords,
    };

    if (geom.type === 'circle') zone.radius_m = geom.radius;

    editingRoute.zones.push(zone);

    setSourceData('zone-draw-preview', emptyFC());
    zoneDrawState.finishedGeom = null;

    updateEditZonesOnMap();
    updateZonesList();

    $id('zoneModal').style.display = 'none';

    showNotification(`Зону "${name}" додано`);
    setStatus('Режим: Редагування');
}

// --- Zones map display ---

/** Оновлює шар зон у режимі редагування */
function updateEditZonesOnMap() {
    const src = map.getSource('edit-zones');
    if (!src) return;

    const features = editingRoute.zones
        .map((zone, i) => {
            const coords = getZoneDisplayCoords(zone);
            if (!coords) return null;
            return {
                type: 'Feature',
                properties: { zone_type: zone.type, name: zone.name, index: i },
                geometry: { type: 'Polygon', coordinates: [coords] },
            };
        })
        .filter(Boolean);

    src.setData({ type: 'FeatureCollection', features });
}

/**
 * Повертає координати полігону зони для відображення на карті.
 * @param {object} zone
 * @returns {[number,number][]|null}
 */
function getZoneDisplayCoords(zone) {
    // Нова зона (намальована в цій сесії)
    if (zone._displayCoords) return zone._displayCoords;

    // Існуюча зона з БД
    if (zone.geometry) {
        if (zone.geometry.type === 'point' && zone.radius_m) {
            const center = [zone.geometry.coordinates[1], zone.geometry.coordinates[0]]; // [lng, lat]
            return generateCirclePolygon(center, parseInt(zone.radius_m));
        }
        if (zone.geometry.type === 'polygon' && zone.geometry.coordinates) {
            return zone.geometry.coordinates.map(c => [c[1], c[0]]);
        }
    }

    return null;
}

/** Відображає зони збереженого маршруту (view mode) */
function displayZonesOnMap(zones) {
    const src = map.getSource('display-zones');
    if (!src) return;

    const features = zones
        .map(zone => {
            const coords = getZoneDisplayCoords(zone);
            if (!coords) return null;
            return {
                type: 'Feature',
                properties: { zone_type: zone.type, name: zone.name, zone_id: zone.id },
                geometry: { type: 'Polygon', coordinates: [coords] },
            };
        })
        .filter(Boolean);

    src.setData({ type: 'FeatureCollection', features });
}

// --- Zones list UI ---

/** Оновлює список зон у бічній панелі (edit mode) */
function updateZonesList() {
    const el = $id('routeZonesList');
    if (!el) return;

    const { zones } = editingRoute;

    if (!zones?.length) {
        el.innerHTML = '<div class="zones-empty">Немає зон</div>';
        updateZonesCount(0);
        return;
    }

    el.innerHTML = zones.map((zone, i) => {
        const typeInfo = ZONE_TYPES[zone.type] || ZONE_TYPES.custom;
        const isCircle = zone._geomForAPI?.type === 'circle' || (zone.geometry?.type === 'point' && zone.radius_m);
        const radiusInfo = isCircle
            ? `<span class="zone-radius-badge">${formatDistance(zone.radius_m || zone._geomForAPI?.radius || 0)}</span>`
            : '';
        const isEditing = zoneEditState.active && zoneEditState.zoneIndex === i;
        return `<div class="zone-list-item ${isEditing ? 'zone-editing' : ''}" data-zone-i="${i}">
            <span class="zone-type-dot ${zone.type}"></span>
            <span class="zone-name zone-clickable" data-i="${i}" title="Наблизити до зони">${escapeHtml(zone.name)}</span>
            ${radiusInfo}
            <span style="font-size:10px;color:var(--muted)">${typeInfo.label}</span>
            <button class="btn-icon btn-tiny zone-edit" data-i="${i}" title="Редагувати розмір">
                ${ICONS.edit}
            </button>
            <button class="btn-icon btn-tiny zone-del" data-i="${i}" title="Видалити зону">
                ${ICONS.close}
            </button>
        </div>`;
    }).join('');

    el.querySelectorAll('.zone-clickable').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            flyToZone(parseInt(btn.dataset.i));
        });
    });

    el.querySelectorAll('.zone-edit').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleZoneEdit(parseInt(btn.dataset.i));
        });
    });

    el.querySelectorAll('.zone-del').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeEditZone(parseInt(btn.dataset.i));
        });
    });

    updateZonesCount(zones.length);
}

/** @param {number} n */
function updateZonesCount(n) {
    const el = $id('zonesCount');
    if (el) el.textContent = n > 0 ? `(${n})` : '';
}

/** Видаляє зону (з API якщо вона збережена, і з масиву) */
async function removeEditZone(index) {
    const zone = editingRoute.zones[index];
    if (!zone) return;

    if (zone.id) {
        try {
            await API.deleteZone(zone.id);
        } catch (e) {
            console.error('Failed to delete zone:', e);
        }
    }

    editingRoute.zones.splice(index, 1);
    if (zoneEditState.active && zoneEditState.zoneIndex === index) clearZoneEdit();
    updateEditZonesOnMap();
    updateZonesList();
    showNotification('Зону видалено');
}

// ─────────────────────────────────────
// 16a. ZONES — FLY TO & INTERACTIVE EDIT
// ─────────────────────────────────────

/**
 * Наближає карту до зони за індексом (edit mode).
 * @param {number} index
 */
function flyToZone(index) {
    const zone = editingRoute.zones[index];
    if (!zone) return;
    const coords = getZoneDisplayCoords(zone);
    flyToZoneCoords(coords);
}

/**
 * Наближає карту до координат зони.
 * @param {[number,number][]|null} coords
 */
function flyToZoneCoords(coords) {
    if (!coords?.length) return;
    fitBoundsToCoords(coords);
}

/**
 * Перемикає режим редагування розміру зони.
 * @param {number} index
 */
function toggleZoneEdit(index) {
    // Якщо вже редагуємо цю зону — вимикаємо
    if (zoneEditState.active && zoneEditState.zoneIndex === index) {
        clearZoneEdit();
        updateZonesList();
        return;
    }

    clearZoneEdit();

    const zone = editingRoute.zones[index];
    if (!zone) return;

    const coords = getZoneDisplayCoords(zone);
    if (!coords) return;

    // Наближаємо до зони
    flyToZoneCoords(coords);

    zoneEditState.active = true;
    zoneEditState.zoneIndex = index;

    const isCircle = zone._geomForAPI?.type === 'circle' || (zone.geometry?.type === 'point' && zone.radius_m);

    if (isCircle) {
        createCircleEditHandles(zone, index);
    } else {
        createPolygonEditHandles(zone, index);
    }

    updateZonesList();
    showNotification('Перетягуйте маркери для зміни розміру зони');
}

/**
 * Створює хендли для редагування кругової зони (центр + 4 точки на колі).
 */
function createCircleEditHandles(zone, index) {
    // Визначаємо центр та радіус
    let centerLngLat, radiusM;

    if (zone._geomForAPI?.type === 'circle') {
        centerLngLat = [zone._geomForAPI.center[1], zone._geomForAPI.center[0]]; // [lng, lat]
        radiusM = zone._geomForAPI.radius;
    } else if (zone.geometry?.type === 'point' && zone.radius_m) {
        centerLngLat = [zone.geometry.coordinates[1], zone.geometry.coordinates[0]];
        radiusM = parseInt(zone.radius_m);
    } else {
        return;
    }

    // Центральний маркер (перетягування — переміщення зони)
    const centerEl = createEditHandle('move');
    const centerMarker = new mapboxgl.Marker({ element: centerEl, draggable: true })
        .setLngLat(centerLngLat)
        .addTo(map);

    zoneEditState.centerHandle = centerMarker;

    // 4 маркери на колі (N, E, S, W) — зміна радіусу
    const directions = [0, 90, 180, 270]; // bearing degrees
    const radiusHandles = directions.map(bearing => {
        const pt = destinationPoint(centerLngLat, radiusM, bearing);
        const el = createEditHandle('resize');
        const marker = new mapboxgl.Marker({ element: el, draggable: true })
            .setLngLat(pt)
            .addTo(map);

        marker.on('drag', () => {
            const pos = marker.getLngLat();
            const newRadius = haversine(
                [centerMarker.getLngLat().lng, centerMarker.getLngLat().lat],
                [pos.lng, pos.lat],
            );
            updateCircleZone(index, [centerMarker.getLngLat().lng, centerMarker.getLngLat().lat], newRadius);
            // Оновлюємо інші хендли
            repositionCircleHandles(centerMarker, newRadius, zoneEditState.handles, marker);
        });

        marker.on('dragend', () => {
            updateZonesList();
        });

        return marker;
    });

    zoneEditState.handles = radiusHandles;

    // Drag центру — переміщує всю зону
    centerMarker.on('drag', () => {
        const pos = centerMarker.getLngLat();
        const currentRadius = zone._geomForAPI?.radius || zone.radius_m || radiusM;
        updateCircleZone(index, [pos.lng, pos.lat], currentRadius);
        repositionCircleHandles(centerMarker, currentRadius, zoneEditState.handles, null);
    });

    centerMarker.on('dragend', () => {
        updateZonesList();
    });
}

/**
 * Оновлює геометрію кругової зони.
 */
function updateCircleZone(index, centerLngLat, radiusM) {
    const zone = editingRoute.zones[index];
    if (!zone) return;

    radiusM = Math.max(10, Math.round(radiusM)); // мінімум 10м
    const circleCoords = generateCirclePolygon(centerLngLat, radiusM);

    zone._displayCoords = circleCoords;
    zone.radius_m = radiusM;
    zone._geomForAPI = {
        type: 'circle',
        center: [centerLngLat[1], centerLngLat[0]], // [lat, lng] for API
        radius: radiusM,
        displayCoords: circleCoords,
    };

    // Оновлюємо зону з БД
    if (zone.geometry?.type === 'point') {
        zone.geometry.coordinates = [centerLngLat[1], centerLngLat[0]];
    }

    updateEditZonesOnMap();
}

/**
 * Переставляє хендли радіусу при зміні центру або радіусу.
 */
function repositionCircleHandles(centerMarker, radiusM, handles, skipMarker) {
    const center = [centerMarker.getLngLat().lng, centerMarker.getLngLat().lat];
    const directions = [0, 90, 180, 270];

    handles.forEach((h, i) => {
        if (h === skipMarker) return;
        const pt = destinationPoint(center, radiusM, directions[i]);
        h.setLngLat(pt);
    });
}

/**
 * Створює хендли для редагування полігональної зони (вершини).
 */
function createPolygonEditHandles(zone, index) {
    const coords = getZoneDisplayCoords(zone);
    if (!coords || coords.length < 3) return;

    // Не включаємо замикаючу точку
    const pts = coords[coords.length - 1][0] === coords[0][0] && coords[coords.length - 1][1] === coords[0][1]
        ? coords.slice(0, -1)
        : coords;

    const handles = pts.map((pt, ptIdx) => {
        const el = createEditHandle('resize');
        const marker = new mapboxgl.Marker({ element: el, draggable: true })
            .setLngLat(pt)
            .addTo(map);

        marker.on('drag', () => {
            const pos = marker.getLngLat();
            updatePolygonVertex(index, ptIdx, [pos.lng, pos.lat], pts.length);
        });

        marker.on('dragend', () => {
            updateZonesList();
        });

        return marker;
    });

    zoneEditState.handles = handles;
}

/**
 * Оновлює одну вершину полігональної зони.
 */
function updatePolygonVertex(zoneIndex, vertexIndex, newLngLat, totalVertices) {
    const zone = editingRoute.zones[zoneIndex];
    if (!zone) return;

    // Отримуємо поточні координати без замикання
    let coords = getZoneDisplayCoords(zone);
    if (!coords) return;

    const isClosed = coords.length > 1 &&
        coords[coords.length - 1][0] === coords[0][0] &&
        coords[coords.length - 1][1] === coords[0][1];

    const pts = isClosed ? coords.slice(0, -1) : [...coords];
    pts[vertexIndex] = newLngLat;

    // Замикаємо
    const closedCoords = [...pts, pts[0]];

    zone._displayCoords = closedCoords;

    // Оновлюємо _geomForAPI
    zone._geomForAPI = {
        type: 'polygon',
        coords: pts.map(c => [c[1], c[0]]), // [lat, lng] for API
        displayCoords: closedCoords,
    };

    // Оновлюємо зону з БД
    if (zone.geometry?.type === 'polygon') {
        zone.geometry.coordinates = pts.map(c => [c[1], c[0]]);
    }

    updateEditZonesOnMap();
}

/**
 * Очищає стан редагування зони (видаляє хендли).
 */
function clearZoneEdit() {
    zoneEditState.handles.forEach(h => h.remove());
    zoneEditState.handles = [];

    if (zoneEditState.centerHandle) {
        zoneEditState.centerHandle.remove();
        zoneEditState.centerHandle = null;
    }

    zoneEditState.active = false;
    zoneEditState.zoneIndex = null;
}

/**
 * Створює DOM-елемент хендла для редагування зони.
 * @param {'move'|'resize'} type
 * @returns {HTMLElement}
 */
function createEditHandle(type) {
    const el = document.createElement('div');
    el.className = `zone-edit-handle zone-handle-${type}`;

    if (type === 'move') {
        Object.assign(el.style, {
            width: '16px', height: '16px', borderRadius: '50%',
            background: '#fff', border: '3px solid #2196F3',
            boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
            cursor: 'move',
        });
    } else {
        Object.assign(el.style, {
            width: '12px', height: '12px', borderRadius: '2px',
            background: '#fff', border: '2px solid #FF9800',
            boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
            cursor: 'nwse-resize',
        });
    }

    return el;
}

/**
 * Обчислює точку на відстані від центру за напрямком (bearing).
 * @param {[number,number]} center [lng, lat]
 * @param {number} distM  відстань у метрах
 * @param {number} bearingDeg  напрямок у градусах (0=N, 90=E)
 * @returns {[number,number]} [lng, lat]
 */
function destinationPoint(center, distM, bearingDeg) {
    const R = CONFIG.earthRadius;
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

function updateZoneDrawHint(text) {
    const el = $id('zoneDrawHint');
    if (!el) return;

    if (text) {
        el.innerHTML = `${text}<br><span class="cancel-draw" onclick="cancelZoneDraw()">Скасувати</span>`;
        el.style.display = 'block';
    } else {
        el.innerHTML = '';
        el.style.display = 'none';
    }
}

/**
 * Підсвічує кнопку активного типу зони на тулбарі.
 * @param {'circle'|'polygon'|'rectangle'|null} mode
 */
function highlightActiveZoneBtn(mode) {
    const btnMap = {
        circle: 'addZoneCircleBtn',
        polygon: 'addZonePolygonBtn',
        rectangle: 'addZoneRectBtn',
    };

    // Знімаємо active з усіх
    Object.values(btnMap).forEach(id => {
        $id(id)?.classList.remove('active');
    });

    // Встановлюємо active для поточного
    if (mode && btnMap[mode]) {
        $id(btnMap[mode])?.classList.add('active');
    }
}

// ─────────────────────────────────────
// 16b. STOPS — LAYERS, PLACEMENT, DRAG, LIST
// ─────────────────────────────────────

/** Додає GeoJSON-шари для кіл радіусу зупинок (edit + view) */
function addStopLayers() {
    // Edit mode — stop radius circles
    if (!map.getSource('edit-stop-circles')) {
        map.addSource('edit-stop-circles', { type: 'geojson', data: emptyFC() });
        map.addLayer({
            id: 'edit-stop-circles-fill',
            type: 'fill',
            source: 'edit-stop-circles',
            paint: { 'fill-color': '#E91E63', 'fill-opacity': 0.12 },
        });
        map.addLayer({
            id: 'edit-stop-circles-outline',
            type: 'line',
            source: 'edit-stop-circles',
            paint: { 'line-color': '#E91E63', 'line-width': 2, 'line-opacity': 0.6, 'line-dasharray': [3, 2] },
        });
    }

    // View mode — stop radius circles
    if (!map.getSource('display-stop-circles')) {
        map.addSource('display-stop-circles', { type: 'geojson', data: emptyFC() });
        map.addLayer({
            id: 'display-stop-circles-fill',
            type: 'fill',
            source: 'display-stop-circles',
            paint: { 'fill-color': '#4CAF50', 'fill-opacity': 0.1 },
        });
        map.addLayer({
            id: 'display-stop-circles-outline',
            type: 'line',
            source: 'display-stop-circles',
            paint: { 'line-color': '#4CAF50', 'line-width': 1.5, 'line-opacity': 0.5, 'line-dasharray': [2, 2] },
        });
    }

    // Живий контур зупинки, що створюється/редагується (панель)
    if (!map.getSource('stop-edit-preview')) {
        map.addSource('stop-edit-preview', { type: 'geojson', data: emptyFC() });
        map.addLayer({
            id: 'stop-edit-preview-fill',
            type: 'fill',
            source: 'stop-edit-preview',
            paint: { 'fill-color': '#E91E63', 'fill-opacity': 0.18 },
        });
        map.addLayer({
            id: 'stop-edit-preview-outline',
            type: 'line',
            source: 'stop-edit-preview',
            paint: { 'line-color': '#E91E63', 'line-width': 2 },
        });
    }
}

/** Повертає координати лінії маршруту (edit або existing) у форматі [lng, lat] */
function getRouteLineCoords() {
    // Якщо є побудовані сегменти — використовуємо їх
    if (segments.length > 0) {
        return buildCombinedCoords();
    }
    // Інакше — існуючий маршрут з БД
    if (editingRoute.routePath?.length >= 2) {
        return editingRoute.routePath.map(c => [c[1], c[0]]); // [lat,lng] → [lng,lat]
    }
    return [];
}

/**
 * Знаходить найближчу точку на лінії маршруту.
 * @param {[number,number]} lngLat  [lng, lat]
 * @returns {{ lngLat: [number,number], distance: number }|null}
 */
function snapToRouteLine(lngLat) {
    const lineCoords = getRouteLineCoords();
    if (lineCoords.length < 2) return null;

    try {
        const line = turf.lineString(lineCoords);
        const pt = turf.point(lngLat);
        const snapped = turf.nearestPointOnLine(line, pt, { units: 'meters' });
        return {
            lngLat: snapped.geometry.coordinates,
            distance: snapped.properties.dist, // відстань від точки кліку до лінії (м)
        };
    } catch (e) {
        console.warn('snapToRouteLine error:', e);
        return null;
    }
}

/** Перемикає режим розміщення зупинок */
function toggleStopPlacing() {
    isStopPlacing = !isStopPlacing;
    const btn = $id('toolAddStop');
    btn?.classList.toggle('active', isStopPlacing);

    if (isStopPlacing) {
        // Вимикаємо інші режими
        if (isRouteDrawing) resetRouteDrawSelect();
        if (zoneDrawMode) cancelZoneDraw();
        if (zoneEditState.active) { clearZoneEdit(); updateZonesList(); }
        if (stopEditState.active) cancelStopEditPanel();

        map.getCanvas().style.cursor = 'crosshair';
        showNotification('Клікніть на маршрут для додавання зупинки');
        setStatus('Додавання зупинки');
    } else {
        map.getCanvas().style.cursor = '';
        setStatus('Режим: Редагування');
    }
}

/**
 * Обробка кліку по карті у режимі розміщення зупинки.
 * Викликається з handleMapClick.
 */
function handleStopClick(lngLat) {
    const snap = snapToRouteLine(lngLat);
    if (!snap) {
        showNotification('Спочатку побудуйте маршрут', 'warning');
        return;
    }

    // Перевіряємо, чи клік був достатньо близько до маршруту (макс 500м)
    if (snap.distance > 500) {
        showNotification('Клікніть ближче до лінії маршруту', 'warning');
        return;
    }

    pendingStopLngLat = snap.lngLat;
    openStopEditPanel('create', { center: snap.lngLat, radiusM: 50, name: '' });
}

/** Створює маркер зупинки для edit mode з drag-to-snap */
function createEditStopMarker(stop) {
    const orderNum = editStops.filter(s => !s._deleted).length + 1;
    const el = document.createElement('div');
    el.className = 'stop-marker-edit';
    Object.assign(el.style, {
        width: '22px', height: '22px', borderRadius: '4px',
        background: '#E91E63', border: '2px solid #fff',
        boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '10px', fontWeight: '700', color: '#fff',
        cursor: 'grab', userSelect: 'none',
    });
    el.textContent = String(orderNum);
    el.title = stop.name || 'Зупинка';

    const marker = new mapboxgl.Marker({ element: el, draggable: true })
        .setLngLat(stop.lngLat)
        .addTo(map);

    // Snap to line при перетягуванні
    marker.on('drag', () => {
        const pos = marker.getLngLat();
        const snap = snapToRouteLine([pos.lng, pos.lat]);
        if (snap) {
            marker.setLngLat(snap.lngLat);
        }
    });

    marker.on('dragend', () => {
        const pos = marker.getLngLat();
        const snap = snapToRouteLine([pos.lng, pos.lat]);
        if (snap) {
            stop.lngLat = snap.lngLat;
            marker.setLngLat(snap.lngLat);
        } else {
            stop.lngLat = [pos.lng, pos.lat];
        }
        updateEditStopCircles();
        updateStopsList();
    });

    return marker;
}

/** Оновлює GeoJSON з колами радіусів зупинок (edit mode) */
function updateEditStopCircles() {
    const src = map.getSource('edit-stop-circles');
    if (!src) return;

    // Зупинку, що зараз редагується панеллю, малює окремий шар превью
    const editingStop = stopEditState.active && stopEditState.mode === 'edit'
        ? editStops[stopEditState.editIndex]
        : null;

    const features = editStops
        .filter(s => !s._deleted && s !== editingStop)
        .map((stop, i) => {
            const circle = generateCirclePolygon(stop.lngLat, stop.radius_m);
            return {
                type: 'Feature',
                properties: { name: stop.name, index: i },
                geometry: { type: 'Polygon', coordinates: [circle] },
            };
        });

    src.setData({ type: 'FeatureCollection', features });
}

/** Оновлює GeoJSON з колами радіусів зупинок (view mode) */
function updateDisplayStopCircles(stops) {
    const src = map.getSource('display-stop-circles');
    if (!src) return;

    if (!stops?.length) {
        src.setData(emptyFC());
        return;
    }

    const features = stops
        .filter(s => s.coordinates?.length >= 2)
        .map(stop => {
            const center = [stop.coordinates[1], stop.coordinates[0]]; // [lng, lat]
            const circle = generateCirclePolygon(center, parseInt(stop.radius_m) || 20);
            return {
                type: 'Feature',
                properties: { name: stop.name },
                geometry: { type: 'Polygon', coordinates: [circle] },
            };
        });

    src.setData({ type: 'FeatureCollection', features });
}

// --- Stop edit panel (inline, з маркерами радіусу на карті) ---

/**
 * Відкриває inline-панель створення/редагування зупинки та створює
 * маркери на карті (центр + 4 точки радіусу) для зміни радіусу мишею.
 * @param {'create'|'edit'} mode
 * @param {{ center: [number,number], radiusM?: number, name?: string, editIndex?: number }} opts
 */
function openStopEditPanel(mode, opts) {
    // Закриваємо попереднє редагування (з відновленням маркера), якщо було
    if (stopEditState.active) cancelStopEditPanel();

    stopEditState.active = true;
    stopEditState.mode = mode;
    stopEditState.editIndex = opts.editIndex ?? null;
    stopEditState.center = opts.center.slice();
    stopEditState.radiusM = Math.max(10, parseInt(opts.radiusM) || 50);

    // На час редагування ховаємо оригінальний маркер зупинки — його замінює хендл-центр
    if (mode === 'edit') {
        const stop = editStops[stopEditState.editIndex];
        if (stop?.marker) stop.marker.getElement().style.display = 'none';
    }

    createStopEditHandles();
    updateEditStopCircles();
    renderStopEditPreview();

    $id('stopEditPanelTitle').textContent = mode === 'edit' ? 'Редагувати зупинку' : 'Нова зупинка';
    $id('stopEditName').value = opts.name || '';
    $id('stopEditRadius').value = stopEditState.radiusM;
    $id('stopEditPanel').style.display = 'block';
    $id('stopEditName').focus();

    map.flyTo({ center: stopEditState.center, zoom: Math.max(map.getZoom(), 15) });
    setStatus(mode === 'edit' ? 'Редагування зупинки' : 'Нова зупинка');
}

/** Створює центральний маркер (snap до маршруту) + 4 радіусні маркери. */
function createStopEditHandles() {
    // Центр — переміщення зупинки вздовж лінії маршруту
    const centerMarker = new mapboxgl.Marker({ element: createEditHandle('move'), draggable: true })
        .setLngLat(stopEditState.center)
        .addTo(map);
    stopEditState.centerHandle = centerMarker;

    centerMarker.on('drag', () => {
        const pos = centerMarker.getLngLat();
        const snap = snapToRouteLine([pos.lng, pos.lat]);
        const c = snap ? snap.lngLat : [pos.lng, pos.lat];
        if (snap) centerMarker.setLngLat(c);
        stopEditState.center = c;
        repositionStopRadiusHandles(null);
        renderStopEditPreview();
    });

    // 4 маркери на колі (N, E, S, W) — зміна радіусу
    const directions = [0, 90, 180, 270];
    stopEditState.handles = directions.map(bearing => {
        const pt = destinationPoint(stopEditState.center, stopEditState.radiusM, bearing);
        const marker = new mapboxgl.Marker({ element: createEditHandle('resize'), draggable: true })
            .setLngLat(pt)
            .addTo(map);

        marker.on('drag', () => {
            const pos = marker.getLngLat();
            const newRadius = Math.max(10, Math.round(haversine(stopEditState.center, [pos.lng, pos.lat])));
            stopEditState.radiusM = newRadius;
            $id('stopEditRadius').value = newRadius;
            repositionStopRadiusHandles(marker);
            renderStopEditPreview();
        });

        return marker;
    });
}

/** Переставляє радіусні маркери навколо центру. */
function repositionStopRadiusHandles(skipMarker) {
    const directions = [0, 90, 180, 270];
    stopEditState.handles.forEach((h, i) => {
        if (h === skipMarker) return;
        h.setLngLat(destinationPoint(stopEditState.center, stopEditState.radiusM, directions[i]));
    });
}

/** Малює живий контур кола зупинки, що редагується. */
function renderStopEditPreview() {
    const src = map.getSource('stop-edit-preview');
    if (!src) return;

    if (!stopEditState.active || !stopEditState.center) {
        src.setData(emptyFC());
        return;
    }

    const circle = generateCirclePolygon(stopEditState.center, stopEditState.radiusM);
    src.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circle] } }],
    });
}

/** Прибирає маркери редагування зупинки та ховає панель. */
function clearStopEdit() {
    stopEditState.handles.forEach(h => h.remove());
    stopEditState.handles = [];
    if (stopEditState.centerHandle) {
        stopEditState.centerHandle.remove();
        stopEditState.centerHandle = null;
    }
    stopEditState.active = false;
    stopEditState.mode = null;
    stopEditState.editIndex = null;
    stopEditState.center = null;
    pendingStopLngLat = null;

    $id('stopEditPanel').style.display = 'none';
    map.getSource('stop-edit-preview')?.setData(emptyFC());
}

/** Зберігає зупинку з inline-панелі. */
function saveStopEditPanel() {
    if (!stopEditState.active) return;

    const name = $id('stopEditName').value.trim();
    const radius = Math.max(10, parseInt($id('stopEditRadius').value) || 50);

    if (!name) { alert('Введіть назву зупинки'); return; }

    const wasEdit = stopEditState.mode === 'edit';

    if (wasEdit) {
        const stop = editStops[stopEditState.editIndex];
        if (stop) {
            stop.name = name;
            stop.radius_m = radius;
            stop.lngLat = stopEditState.center.slice();
            if (stop.marker) {
                stop.marker.setLngLat(stop.lngLat);
                const el = stop.marker.getElement();
                el.style.display = 'flex';
                el.title = name;
            }
        }
    } else {
        const stop = {
            name,
            lngLat: stopEditState.center.slice(),
            radius_m: radius,
            order_index: editStops.filter(s => !s._deleted).length,
            marker: null,
        };
        stop.marker = createEditStopMarker(stop);
        editStops.push(stop);
        syncStopOrderIndices();
    }

    clearStopEdit();
    updateEditStopCircles();
    updateStopsList();

    // Вимикаємо режим розміщення після додавання
    if (isStopPlacing) {
        isStopPlacing = false;
        $id('toolAddStop')?.classList.remove('active');
        map.getCanvas().style.cursor = '';
    }
    setStatus('Режим: Редагування');

    showNotification(`Зупинку "${name}" ${wasEdit ? 'оновлено' : 'додано'}`);
}

/** Скасовує створення/редагування зупинки без збереження. */
function cancelStopEditPanel() {
    // Відновлюємо оригінальний маркер редагованої зупинки
    if (stopEditState.mode === 'edit') {
        const stop = editStops[stopEditState.editIndex];
        if (stop?.marker) stop.marker.getElement().style.display = 'flex';
    }

    clearStopEdit();
    updateEditStopCircles();
    setStatus('Режим: Редагування');
}

/** Оновлює радіус з поля вводу панелі (жива синхронізація з маркерами). */
function onStopEditRadiusInput() {
    if (!stopEditState.active) return;
    const r = Math.max(10, parseInt($id('stopEditRadius').value) || 10);
    stopEditState.radiusM = r;
    repositionStopRadiusHandles(null);
    renderStopEditPreview();
}

// --- Stops list UI ---

/** Оновлює список зупинок у бічній панелі (edit mode) */
function updateStopsList() {
    const el = $id('routeStopsList');
    if (!el) return;

    const activeStops = editStops.filter(s => !s._deleted);

    if (activeStops.length === 0) {
        el.innerHTML = '<div class="zones-empty">Немає зупинок</div>';
        updateStopsCount(0);
        return;
    }

    el.innerHTML = activeStops.map((stop, i) => {
        const realIndex = editStops.indexOf(stop);
        return `<div class="zone-list-item stop-list-item" data-stop-i="${realIndex}" draggable="true">
            <span class="stop-drag-handle" title="Перетягніть для зміни порядку">${ICONS.grip}</span>
            <span class="stop-order-num">${i + 1}</span>
            <span class="zone-type-dot" style="background:#E91E63"></span>
            <span class="zone-name stop-name-clickable" data-i="${realIndex}" title="Наблизити до зупинки">${escapeHtml(stop.name)}</span>
            <span class="zone-radius-badge">${stop.radius_m} м</span>
            <button class="btn-icon btn-tiny zone-edit" data-i="${realIndex}" title="Редагувати">
                ${ICONS.edit}
            </button>
            <button class="btn-icon btn-tiny zone-del" data-i="${realIndex}" title="Видалити зупинку">
                ${ICONS.close}
            </button>
        </div>`;
    }).join('');

    initStopListDragDrop(el);

    // Fly to stop
    el.querySelectorAll('.stop-name-clickable').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const stop = editStops[parseInt(btn.dataset.i)];
            if (stop) map.flyTo({ center: stop.lngLat, zoom: Math.max(map.getZoom(), 15) });
        });
    });

    // Edit stop
    el.querySelectorAll('.zone-edit').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.i);
            const stop = editStops[idx];
            if (stop) {
                openStopEditPanel('edit', {
                    editIndex: idx,
                    center: stop.lngLat.slice(),
                    radiusM: stop.radius_m || 50,
                    name: stop.name,
                });
            }
        });
    });

    // Delete stop
    el.querySelectorAll('.zone-del').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeEditStop(parseInt(btn.dataset.i));
        });
    });

    updateStopsCount(activeStops.length);
}

/** Синхронізує order_index та номери маркерів після зміни порядку */
function syncStopOrderIndices() {
    editStops.filter(s => !s._deleted).forEach((stop, i) => {
        stop.order_index = i;
    });
    updateEditStopMarkerNumbers();
}

/** Оновлює номери зупинок на маркерах карти */
function updateEditStopMarkerNumbers() {
    editStops.filter(s => !s._deleted).forEach((stop, i) => {
        const el = stop.marker?.getElement();
        if (el) el.textContent = String(i + 1);
    });
}

/** Переміщує зупинку в масиві editStops */
function moveEditStop(fromRealIndex, toRealIndex) {
    if (fromRealIndex === toRealIndex) return;
    const stop = editStops[fromRealIndex];
    if (!stop) return;

    editStops.splice(fromRealIndex, 1);
    editStops.splice(toRealIndex, 0, stop);
    syncStopOrderIndices();
    updateEditStopCircles();
    updateStopsList();
}

/** Drag-and-drop для зміни порядку зупинок у списку */
function initStopListDragDrop(container) {
    container.querySelectorAll('.stop-list-item').forEach(item => {
        item.addEventListener('dragstart', (e) => {
            draggedStopRealIndex = parseInt(item.dataset.stopI, 10);
            item.classList.add('stop-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(draggedStopRealIndex));
        });

        item.addEventListener('dragend', () => {
            item.classList.remove('stop-dragging');
            draggedStopRealIndex = null;
            container.querySelectorAll('.stop-list-item').forEach(el => el.classList.remove('stop-drag-over'));
        });

        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            item.classList.add('stop-drag-over');
        });

        item.addEventListener('dragleave', () => {
            item.classList.remove('stop-drag-over');
        });

        item.addEventListener('drop', (e) => {
            e.preventDefault();
            item.classList.remove('stop-drag-over');
            const targetIndex = parseInt(item.dataset.stopI, 10);
            if (draggedStopRealIndex !== null && !Number.isNaN(targetIndex)) {
                moveEditStop(draggedStopRealIndex, targetIndex);
            }
        });
    });

    // Не запускати drag при кліку на кнопки та назву
    container.querySelectorAll('.zone-edit, .zone-del, .stop-name-clickable').forEach(el => {
        el.addEventListener('mousedown', (e) => e.stopPropagation());
        el.addEventListener('dragstart', (e) => e.preventDefault());
    });
}

/** @param {number} n */
function updateStopsCount(n) {
    const el = $id('stopsCount');
    if (el) el.textContent = n > 0 ? `(${n})` : '';
}

/** Видаляє зупинку */
function removeEditStop(index) {
    const stop = editStops[index];
    if (!stop) return;

    stop.marker?.remove();

    // Якщо це збережена зупинка — запам'ятовуємо для видалення при збереженні
    if (stop.id) {
        deletedStopIds.push(stop.id);
    }

    editStops.splice(index, 1);
    updateEditStopCircles();
    updateStopsList();
    showNotification('Зупинку видалено');
}

/** Очищає всі edit stops */
function clearEditStops() {
    if (stopEditState.active) clearStopEdit();
    editStops.forEach(s => s.marker?.remove());
    editStops = [];
    deletedStopIds = [];
    pendingStopLngLat = null;
    isStopPlacing = false;
    $id('toolAddStop')?.classList.remove('active');
    setSourceData('edit-stop-circles', emptyFC());
}

// ─────────────────────────────────────
// 17. PROPERTIES PANEL
// ─────────────────────────────────────

/** Відкриває панель властивостей маршруту (view mode) */
async function openRouteProperties(route) {
    const panel = $id('routesProperties');
    $id('propertiesTitle').textContent = 'Властивості маршруту';

    // Завантажуємо групи для селектора
    let groupsHtml = '';
    try {
        const data = await API.getGroups();
        if (data.groups) {
            groupsHtml = data.groups.map(g =>
                `<option value="${g.id}"${g.id == route.group_id ? ' selected' : ''}>${escapeHtml(g.name)}</option>`,
            ).join('');
        }
    } catch { /* ігноруємо */ }

    const routeColor = route.additional?.color || COLORS.default;

    // Формуємо список зупинок
    let stopsListHtml = '';
    if (route.stops?.length > 0) {
        const stopsItems = route.stops.map((s, si) => {
            const radiusInfo = s.radius_m ? `<span class="zone-radius-badge">${formatDistance(parseInt(s.radius_m))}</span>` : '';
            return `<div class="prop-zone-item prop-stop-clickable" data-stop-vi="${si}">
                <span class="zone-type-dot" style="background:#E91E63"></span>
                <span class="zone-name">${escapeHtml(s.name)}</span>
                ${radiusInfo}
            </div>`;
        }).join('');

        stopsListHtml = `
            <div class="prop-section">
                <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px">
                    Зупинки (${route.stops.length})
                </div>
                ${stopsItems}
            </div>`;
    }

    // Формуємо список зон
    let zonesListHtml = '';
    if (route.zones?.length > 0) {
        const items = route.zones.map((z, zi) => {
            const typeInfo = ZONE_TYPES[z.type] || ZONE_TYPES.custom;
            const isCircle = z.geometry?.type === 'point' && z.radius_m;
            const radiusInfo = isCircle ? `<span class="zone-radius-badge">${formatDistance(z.radius_m)}</span>` : '';
            return `<div class="prop-zone-item prop-zone-clickable" data-zone-vi="${zi}">
                <span class="zone-type-dot ${z.type}"></span>
                <span class="zone-name">${escapeHtml(z.name)}</span>
                ${radiusInfo}
                <span class="prop-zone-type">${typeInfo.label}</span>
            </div>`;
        }).join('');

        zonesListHtml = `
            <div class="prop-section">
                <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px">
                    Зони (${route.zones.length})
                </div>
                ${items}
            </div>`;
    }

    // Формуємо блок зв'язаних маршрутів
    const inverseRouteId = route.additional?.inverse_route_id ? String(route.additional.inverse_route_id) : '';
    const linkedRoutes = route.linked_routes || [];
    let linkedItemsHtml;
    if (linkedRoutes.length > 0) {
        linkedItemsHtml = linkedRoutes.map(lr => {
            const isInv = String(lr.id) === inverseRouteId;
            const kindLabel = lr.route_kind === 'intercity' ? 'міжміський' : 'міський';
            return `<div class="prop-zone-item prop-linked-item" data-linked-id="${lr.id}">
                <span class="zone-type-dot" style="background:${isInv ? '#9C27B0' : '#607D8B'}"></span>
                <span class="zone-name">${escapeHtml(lr.name)}</span>
                <span class="prop-zone-type">${isInv ? 'зворотний' : kindLabel}</span>
                <button class="btn-icon btn-tiny linked-open-btn" title="Відкрити маршрут" data-open-id="${lr.id}">→</button>
                <button class="btn-icon btn-tiny linked-unlink-btn" title="Відв'язати" data-unlink-id="${lr.id}">×</button>
            </div>`;
        }).join('');
    } else {
        linkedItemsHtml = '<div class="route-info-empty">Немає прив\'язаних маршрутів</div>';
    }

    const avgRoutePassTime = route.additional?.avg_route_pass_time;
    const avgPassTimeAttr = avgRoutePassTime != null && avgRoutePassTime !== ''
        ? ` value="${Number(avgRoutePassTime)}"`
        : '';

    const linkedHtml = `
        <div class="prop-section">
            <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px">
                Зв'язані маршрути
            </div>
            ${linkedItemsHtml}
            ${linkedRoutes.length === 0 ? `
            <div class="prop-buttons" style="margin-top:10px">
                <button class="btn btn-block btn-outline" id="propCreateInverseBtn">↺ Створити зворотний маршрут</button>
                <button class="btn btn-block btn-outline" id="propLinkRouteBtn">+ Прив'язати існуючий маршрут</button>
            </div>
            <div id="propLinkSearchWrap" style="display:none;margin-top:10px">
                <input type="text" id="propLinkSearch" class="input" placeholder="Пошук маршруту за назвою...">
                <div id="propLinkResults" class="link-search-results"></div>
            </div>` : ''}
            <div class="prop-edit-row" style="margin-top:10px">
                <label for="propAvgRoutePassTime">Середній час проїзду одного маршруту</label>
                <input type="number" id="propAvgRoutePassTime" class="input" min="0" step="1" placeholder="хв"${avgPassTimeAttr}>
            </div>
        </div>`;

    $id('propertiesContent').innerHTML = `
        <!-- Статистика -->
        <div class="prop-section">
            <div class="prop-info-row"><span class="prop-label">Довжина:</span><span class="prop-value">${formatDistance(route.length_m)}</span></div>
            <div class="prop-info-row"><span class="prop-label">Зупинок:</span><span class="prop-value">${route.stops?.length || 0}</span></div>
            <div class="prop-info-row"><span class="prop-label">Зон:</span><span class="prop-value">${route.zones?.length || 0}</span></div>
        </div>

        ${stopsListHtml}
        ${zonesListHtml}
        ${linkedHtml}

        <!-- Редаговані поля -->
        <div class="prop-section">
            <div class="prop-edit-row">
                <label for="propRouteName">Назва</label>
                <input type="text" id="propRouteName" class="input" value="${escapeHtml(route.name)}">
            </div>
            <div class="prop-edit-row">
                <label for="propRouteColor">Колір</label>
                <input type="color" id="propRouteColor" value="${routeColor}">
            </div>
            <div class="prop-edit-row">
                <label for="propRouteGroup">Група</label>
                <select id="propRouteGroup" class="input">${groupsHtml}</select>
            </div>
            <div class="prop-edit-row">
                <label for="propRouteKind">Тип маршруту</label>
                <select id="propRouteKind" class="input">
                    <option value="city"${route.route_kind !== 'intercity' ? ' selected' : ''}>Міський</option>
                    <option value="intercity"${route.route_kind === 'intercity' ? ' selected' : ''}>Міжміський</option>
                </select>
            </div>
            <div class="prop-edit-row prop-toggle-row">
                <label for="propRouteActive">Статус</label>
                <label class="toggle-switch">
                    <input type="checkbox" id="propRouteActive"${route.active == 1 ? ' checked' : ''}>
                    <span class="toggle-slider"></span>
                    <span class="toggle-text">${route.active == 1 ? 'Активний' : 'Неактивний'}</span>
                </label>
            </div>
        </div>

        <!-- Кнопки -->
        <div class="prop-buttons">
            <button class="btn btn-block" id="propSaveMetaBtn">
                ${ICONS.save} Зберегти зміни
            </button>
            <button class="btn btn-block btn-outline" id="propEditPointsBtn">
                ${ICONS.edit} Змінити точки маршруту
            </button>
        </div>`;

    // Обробники
    $id('propSaveMetaBtn').addEventListener('click', () => saveRouteMetadata(route));
    $id('propEditPointsBtn').addEventListener('click', () => {
        openEditModeForRoute(route.id, $id('propRouteGroup').value);
    });

    // Клік по зупинці — наближення (view mode)
    $$('.prop-stop-clickable').forEach(el => {
        el.addEventListener('click', () => {
            const si = parseInt(el.dataset.stopVi);
            const stop = route.stops?.[si];
            if (stop?.coordinates?.length >= 2) {
                map.flyTo({ center: [stop.coordinates[1], stop.coordinates[0]], zoom: Math.max(map.getZoom(), 15) });
            }
        });
    });

    // Клік по зоні — наближення до зони (view mode)
    $$('.prop-zone-clickable').forEach(el => {
        el.addEventListener('click', () => {
            const zi = parseInt(el.dataset.zoneVi);
            const zone = route.zones?.[zi];
            if (zone) flyToZoneCoords(getZoneDisplayCoords(zone));
        });
    });

    // ── Зв'язані маршрути ──
    wireLinkedRoutesHandlers(route);

    // Живий перегляд кольору
    $id('propRouteColor').addEventListener('input', (e) => {
        const src = map.getSource('display-route');
        if (src && route.coordinates?.length >= 2) {
            const coords = route.coordinates.map(c => [c[1], c[0]]);
            src.setData({
                type: 'FeatureCollection',
                features: [{
                    type: 'Feature',
                    properties: { color: e.target.value },
                    geometry: { type: 'LineString', coordinates: coords },
                }],
            });
        }
    });

    // Toggle text
    $id('propRouteActive').addEventListener('change', (e) => {
        const txt = e.target.closest('.toggle-switch').querySelector('.toggle-text');
        if (txt) txt.textContent = e.target.checked ? 'Активний' : 'Неактивний';
    });

    // Попередження при зміні типу маршруту, якщо вже є тарифи протилежного типу
    const kindSelect = $id('propRouteKind');
    if (kindSelect) {
        kindSelect.addEventListener('change', async (e) => {
            const newKind = e.target.value;
            try {
                const res = await fetch(`api/tariffs.php?action=get_tariffs&route_id=${route.id}`);
                const data = await res.json();
                const conflicting = (data.tariffs || []).filter(t => {
                    const k = t.prices?.kind;
                    return k && k !== newKind;
                });
                if (conflicting.length > 0) {
                    const names = conflicting.map(t => t.name).join(', ');
                    alert(
                        `Увага! У цього маршруту вже є тарифи, налаштовані як «${newKind === 'intercity' ? 'міський' : 'міжміський'}»: ${names}.\n` +
                        'Після зміни типу маршруту ці тарифи доведеться перебудувати на вкладці «Тарифи маршрутів».',
                    );
                }
            } catch { /* ігноруємо помилки перевірки */ }
        });
    }

    const footer = $id('propertiesFooter');
    if (ROUTES_READONLY) {
        lockRoutePropertiesPanel();
        if (footer) footer.style.display = 'none';
    } else {
        if (footer) footer.style.display = 'flex';
        const deleteBtn = $id('propertiesDeleteBtn');
        if (deleteBtn) deleteBtn.onclick = () => deleteRoute(route.id);
    }
    panel.style.display = 'flex';
}

/** Режим перегляду: прибирає кнопки змін і блокує поля панелі властивостей */
function lockRoutePropertiesPanel() {
    const content = $id('propertiesContent');
    if (!content) return;
    content.querySelectorAll('.prop-buttons, #propLinkSearchWrap, .linked-unlink-btn').forEach(el => el.remove());
    content.querySelectorAll('input, select, textarea').forEach(el => { el.disabled = true; });
}

/**
 * Підключає обробники для блоку "Зв'язані маршрути" в панелі властивостей.
 * @param {any} route
 */
function wireLinkedRoutesHandlers(route) {
    // Створити зворотний (інверсний) маршрут
    $id('propCreateInverseBtn')?.addEventListener('click', async () => {
        if (!route.id) { alert('Спочатку збережіть маршрут'); return; }
        if (!confirm('Створити зворотний маршрут із реверсованим напрямком, тими самими зупинками та зонами?')) return;

        const btn = $id('propCreateInverseBtn');
        if (btn) btn.disabled = true;
        try {
            const data = await API.createInverse(route.id);
            if (!data.ok) throw new Error(data.error || 'Помилка створення');
            showNotification(`Зворотний маршрут "${data.name}" створено`);
            await reloadRouteProperties(route.id);
        } catch (err) {
            alert(`Помилка: ${err.message}`);
            if (btn) btn.disabled = false;
        }
    });

    // Показати/сховати пошук для прив'язки існуючого маршруту
    $id('propLinkRouteBtn')?.addEventListener('click', () => {
        const wrap = $id('propLinkSearchWrap');
        if (!wrap) return;
        const willShow = wrap.style.display === 'none';
        wrap.style.display = willShow ? 'block' : 'none';
        if (willShow) $id('propLinkSearch')?.focus();
    });

    // Пошук маршрутів для прив'язки
    const searchInput = $id('propLinkSearch');
    if (searchInput) {
        let searchTimer = null;
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimer);
            const q = searchInput.value.trim();
            const resultsBox = $id('propLinkResults');
            if (!resultsBox) return;
            if (q.length < 1) { resultsBox.innerHTML = ''; return; }

            searchTimer = setTimeout(async () => {
                try {
                    const data = await API.searchRoutes(q);
                    const linkedIds = new Set((route.linked_routes || []).map(r => String(r.id)));
                    const candidates = (data.routes || []).filter(r =>
                        String(r.id) !== String(route.id) && !linkedIds.has(String(r.id)),
                    );
                    if (candidates.length === 0) {
                        resultsBox.innerHTML = '<div class="route-info-empty">Нічого не знайдено</div>';
                        return;
                    }
                    resultsBox.innerHTML = candidates.map(r => `
                        <div class="link-search-item" data-link-id="${r.id}" data-link-name="${escapeHtml(r.name)}">
                            <span class="zone-name">${escapeHtml(r.name)}</span>
                            ${r.group_name ? `<span class="prop-zone-type">${escapeHtml(r.group_name)}</span>` : ''}
                        </div>`).join('');

                    resultsBox.querySelectorAll('.link-search-item').forEach(item => {
                        item.addEventListener('click', async () => {
                            const otherId = item.dataset.linkId;
                            try {
                                // Єдиний прив'язаний маршрут завжди трактується як зворотний
                                const res = await API.linkRoute(route.id, otherId, true);
                                if (!res.ok) throw new Error(res.error || 'Помилка');
                                showNotification('Маршрут прив\'язано');
                                await reloadRouteProperties(route.id);
                            } catch (err) {
                                alert(`Помилка: ${err.message}`);
                            }
                        });
                    });
                } catch (err) {
                    console.error('Link search error:', err);
                }
            }, 300);
        });
    }

    // Відкрити прив'язаний маршрут
    $$('.linked-open-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const openId = btn.dataset.openId;
            if (openId) await openLinkedRoute(openId);
        });
    });

    // Відв'язати маршрут
    $$('.linked-unlink-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const otherId = btn.dataset.unlinkId;
            if (!otherId) return;
            if (!confirm('Відв\'язати цей маршрут?')) return;
            try {
                const res = await API.unlinkRoute(route.id, otherId);
                if (!res.ok) throw new Error(res.error || 'Помилка');
                showNotification('Маршрут відв\'язано');
                await reloadRouteProperties(route.id);
            } catch (err) {
                alert(`Помилка: ${err.message}`);
            }
        });
    });
}

/** Перезавантажує панель властивостей маршруту з сервера */
async function reloadRouteProperties(routeId) {
    try {
        const data = await API.getRoute(routeId);
        if (data.route) {
            selectedRoute = data.route;
            displayRouteOnMap(data.route);
            openRouteProperties(data.route);
        }
        await refreshGroupsList();
    } catch (err) {
        console.error('reloadRouteProperties error:', err);
    }
}

/** Відкриває прив'язаний маршрут у панелі властивостей */
async function openLinkedRoute(routeId) {
    try {
        const data = await API.getRoute(routeId);
        if (data.route) {
            selectedRoute = data.route;
            displayRouteOnMap(data.route);
            openRouteProperties(data.route);
            if (data.route.coordinates?.length >= 2) {
                fitBoundsToCoords(data.route.coordinates.map(c => [c[1], c[0]]));
            }
        }
    } catch (err) {
        console.error('openLinkedRoute error:', err);
    }
}

/** Зберігає метадані маршруту (без зміни геометрії) */
async function saveRouteMetadata(route) {
    const name = $id('propRouteName').value.trim();
    const color = $id('propRouteColor').value;
    const groupId = $id('propRouteGroup').value;
    const active = $id('propRouteActive').checked ? 1 : 0;
    const routeKind = $id('propRouteKind')?.value || 'city';

    if (!name) { alert('Введіть назву'); return; }

    const additional = { ...(route.additional || {}), color };
    const avgRaw = $id('propAvgRoutePassTime')?.value.trim() ?? '';
    if (avgRaw === '') {
        delete additional.avg_route_pass_time;
    } else {
        const avgMin = parseInt(avgRaw, 10);
        if (!Number.isNaN(avgMin) && avgMin >= 0) additional.avg_route_pass_time = avgMin;
    }

    try {
        const data = await API.saveRoute({
            id: route.id,
            group_id: groupId,
            name,
            route_kind: routeKind,
            active: String(active),
            additional: JSON.stringify(additional),
        });
        if (!data.ok) throw new Error(data.error);

        showNotification('Зміни збережено!');

        const oldGroupId = route.group_id;
        Object.assign(route, { name, active, group_id: groupId, route_kind: routeKind, additional });
        selectedRoute = route;

        displayRouteOnMapInternal(route);
        await refreshGroupsList();

        // Розгортаємо нову групу
        const newGroup = $(`.tree-group[data-group-id="${groupId}"]`);
        if (newGroup) {
            newGroup.classList.add('expanded');
            newGroup.querySelector('.tree-routes').style.display = 'block';
            await loadGroupRoutes(groupId);
        }

        // Оновлюємо стару групу при переміщенні
        if (oldGroupId != groupId) {
            const oldGroup = $(`.tree-group[data-group-id="${oldGroupId}"]`);
            if (oldGroup?.classList.contains('expanded')) {
                await loadGroupRoutes(oldGroupId);
            }
        }
    } catch (err) {
        alert(`Помилка: ${err.message}`);
    }
}

/** Відкриває edit mode для існуючого маршруту */
async function openEditModeForRoute(routeId, groupId) {
    closeProperties();

    try {
        const data = await API.getRoute(routeId);
        if (data.route) {
            enterEditMode(routeId, groupId, data.route);
        }
    } catch (e) {
        console.error(e);
        enterEditMode(routeId, groupId);
    }
}

function closeProperties() {
    $id('routesProperties').style.display = 'none';
}

/** Видаляє маршрут через API */
async function deleteRoute(routeId) {
    if (!confirm('Видалити маршрут?')) return;

    const gidEl = $id('propRouteGroup');
    const gid = gidEl ? gidEl.value : selectedRoute?.group_id;

    const data = await API.deleteRoute(routeId);
    if (data.ok) {
        showNotification('Маршрут видалено');
        closeProperties();
        clearMapDisplay();
        selectedRoute = null;
        if (gid) loadGroupRoutes(gid);
    }
}

// ─────────────────────────────────────
// 18. MODALS
// ─────────────────────────────────────

function initModals() {
    $id('closeGroupModal')?.addEventListener('click', closeGroupModal);
    $id('cancelGroupBtn')?.addEventListener('click', closeGroupModal);
    $id('saveGroupBtn')?.addEventListener('click', saveGroup);
    $id('deleteGroupBtn')?.addEventListener('click', deleteGroup);
    $id('closePropertiesBtn')?.addEventListener('click', closeProperties);

    $id('closeZoneModal')?.addEventListener('click', closeZoneFormModal);
    $id('cancelZoneBtn')?.addEventListener('click', closeZoneFormModal);
    $id('saveZoneBtn')?.addEventListener('click', saveZoneFromModal);

    $id('stopEditSaveBtn')?.addEventListener('click', saveStopEditPanel);
    $id('stopEditCancelBtn')?.addEventListener('click', cancelStopEditPanel);
    $id('stopEditRadius')?.addEventListener('input', onStopEditRadiusInput);
    $id('stopEditName')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); saveStopEditPanel(); }
    });
}

function openGroupModal(id, name) {
    $id('groupModalTitle').textContent = id ? 'Редагувати групу' : 'Нова група';
    $id('groupId').value = id || '';
    $id('groupName').value = name || '';
    // Показуємо кнопку "Видалити" тільки при редагуванні існуючої групи
    const deleteBtn = $id('deleteGroupBtn');
    if (deleteBtn) deleteBtn.style.display = id ? '' : 'none';
    $id('groupModal').style.display = 'flex';
    $id('groupName').focus();
}

function closeGroupModal() {
    $id('groupModal').style.display = 'none';
}

async function saveGroup() {
    const id = $id('groupId').value;
    const name = $id('groupName').value.trim();
    if (!name) { alert('Введіть назву'); return; }

    const data = await API.saveGroup({
        id,
        name,
        color: $id('groupColor').value,
    });

    if (data.ok) {
        closeGroupModal();
        await refreshGroupsList();
        showNotification(id ? 'Оновлено' : 'Створено');
    }
}

async function deleteGroup() {
    const id = $id('groupId').value;
    if (!id) return;

    if (!confirm('Ви впевнені? Буде видалено групу та ВСІ маршрути в ній!')) return;

    try {
        const data = await API.deleteGroup(id);
        if (!data.ok) throw new Error(data.error);

        closeGroupModal();
        // Знімаємо виділення, якщо видалений маршрут був вибраний
        if (selectedRoute && String(selectedRoute.group_id) === String(id)) {
            clearMapDisplay();
            selectedRoute = null;
            closeProperties();
        }
        await refreshGroupsList();
        showNotification('Групу видалено');
    } catch (err) {
        alert(`Помилка видалення: ${err.message}`);
    }
}

/** Перезавантажує дерево груп з сервера */
async function refreshGroupsList() {
    const data = await API.getGroups();
    const tree = $id('routesTree');

    if (!data.groups?.length) {
        tree.innerHTML = ROUTES_READONLY
            ? '<div class="tree-empty"><p>Вам ще не призначено маршрутів</p></div>'
            : `
            <div class="tree-empty">
                <p>Немає груп</p>
                <button class="btn btn-small" id="createFirstGroup">Створити</button>
            </div>`;
        $id('createFirstGroup')?.addEventListener('click', () => openGroupModal());
        return;
    }

    const groupActionsHtml = ROUTES_READONLY ? '' : `
                <div class="tree-group-actions">
                    <button class="btn-icon btn-tiny add-route-btn">+</button>
                    <button class="btn-icon btn-tiny edit-group-btn">✎</button>
                </div>`;

    tree.innerHTML = data.groups.map(g => `
        <div class="tree-group" data-group-id="${g.id}">
            <div class="tree-group-header">
                <span class="tree-toggle">▶</span>
                <span class="tree-group-name">${escapeHtml(g.name)}</span>
                ${groupActionsHtml}
            </div>
            <div class="tree-routes" style="display:none">
                <div class="tree-loading">Завантаження...</div>
            </div>
        </div>`).join('');

    initSidebarHandlers();
}

// ─────────────────────────────────────
// 19. УТИЛІТИ
// ─────────────────────────────────────

function initKeyboardShortcuts() {
    // Слухаємо на window з capture=true — гарантуємо пріоритет перед Mapbox та браузером.
    window.addEventListener('keydown', (e) => {
        console.log('keydown', e.key);
        // Ctrl+Z / Cmd+Z — undo останньої точки маршруту
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
            console.log('Ctrl+Z pressed');
            // Перевіряємо сам елемент та батьків (Geocoder, модалки з input всередині)
            // У режимі редагування завжди перехоплюємо (крім полів вводу), щоб Ctrl+Z працював надійно
            if (isEditMode) {
                console.log('Ctrl+Z pressed');
                e.preventDefault();
                e.stopImmediatePropagation();
                undoLastPoint();
                return;
            }
        }

        // Escape — каскадне закриття
        if (e.key === 'Escape') {
            if (stopEditState.active) { cancelStopEditPanel(); return; }
            if (isStopPlacing) { isStopPlacing = false; $id('toolAddStop')?.classList.remove('active'); map.getCanvas().style.cursor = ''; setStatus('Режим: Редагування'); return; }
            if (zoneDrawMode) { cancelZoneDraw(); return; }
            if (zoneEditState.active) { clearZoneEdit(); updateZonesList(); return; }
            if ($id('zoneModal')?.style.display !== 'none') { closeZoneFormModal(); return; }
            if (isFullscreen) toggleFullscreen();
            else if (isEditMode) exitEditMode();
            else closeProperties();
            return;
        }

        // Решта шорткатів — тільки поза полями вводу
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        if (e.key.toLowerCase() === 'f') toggleFullscreen();

        if (e.key === 'Delete' && isEditMode) {
            clearEditWaypoints();
            showNotification('Маршрут очищено');
        }
    }, true);
}

/** Оновлює текст режиму в статусбарі */
function setStatus(text) {
    $id('statusMode').textContent = text;
}

/**
 * Показує toast-повідомлення.
 * @param {string} msg
 * @param {'success'|'error'|'warning'} [type='success']
 */
function showNotification(msg, type = 'success') {
    const bgColors = { error: '#f44336', warning: '#FF9800', success: COLORS.origin };

    const toast = document.createElement('div');
    Object.assign(toast.style, {
        position: 'fixed', bottom: '80px', left: '50%', transform: 'translateX(-50%)',
        background: bgColors[type] || bgColors.success,
        color: '#fff', padding: '12px 24px', borderRadius: '8px',
        zIndex: '9999', fontSize: '14px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)', pointerEvents: 'none',
    });
    toast.textContent = msg;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.transition = 'opacity 0.3s';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, CONFIG.toastDuration);
}

/**
 * Форматує відстань у людино-зрозумілий рядок.
 * @param {number} m — метри
 * @returns {string}
 */
function formatDistance(m) {
    return m >= 1000 ? `${(m / 1000).toFixed(1)} км` : `${m || 0} м`;
}

/**
 * Екранує HTML (захист від XSS).
 * @param {string} t
 * @returns {string}
 */
function escapeHtml(t) {
    if (!t) return '';
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
}

/**
 * Безпечно оновлює дані GeoJSON-джерела (якщо воно існує).
 * @param {string} sourceId
 * @param {object} data
 */
function setSourceData(sourceId, data) {
    const src = map.getSource(sourceId);
    if (src) src.setData(data);
}

/**
 * Підлітає до масиву координат.
 * @param {[number,number][]} coords — [[lng, lat], ...]
 */
function fitBoundsToCoords(coords) {
    if (!coords?.length) return;
    const bounds = coords.reduce(
        (b, c) => b.extend(c),
        new mapboxgl.LngLatBounds(coords[0], coords[0]),
    );
    map.fitBounds(bounds, { padding: CONFIG.fitPadding });
}

// ─────────────────────────────────────
// GLOBAL EXPORTS (для onclick у HTML)
// ─────────────────────────────────────

window.removeEditWaypoint = removeEditWaypoint;
window.enterEditMode = enterEditMode;
window.openEditModeForRoute = openEditModeForRoute;
window.saveRouteMetadata = saveRouteMetadata;
window.cancelZoneDraw = cancelZoneDraw;
