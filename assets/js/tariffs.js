/**
 * Tariffs Manager — тарифи маршрутів (Mapbox GL JS).
 *
 * Ліва половина: список маршрутів + редактор тарифів.
 * Права половина: карта маршруту з підсвіткою активного відрізка тарифу.
 *
 * Формат prices:
 *   місто:    { kind: 'city', price: 20 }
 *   міжмісто: { kind: 'intercity', pairs: { '<stopIdMin>-<stopIdMax>': 25, ... } }
 */

// ─────────────────────────────────────
// Константи / хелпери
// ─────────────────────────────────────

const CONFIG = {
    defaultCenter: [32.0, 49.0],
    defaultZoom: 6,
    fitPadding: 70,
    routeColor: '#3388ff',
    highlightColor: '#f39c12',
};

const $id = (id) => document.getElementById(id);

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

const API = {
    base: 'api/tariffs.php',
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
    getRoutesWithTariffs() { return this.get({ action: 'get_routes_with_tariffs' }); },
    getRoute(id) { return this.get({ action: 'get_route', id }); },
    getTariffs(routeId) { return this.get({ action: 'get_tariffs', route_id: routeId }); },
    saveTariff(fields) { return this.post({ action: 'save_tariff', ...fields }); },
    deleteTariff(id) { return this.post({ action: 'delete_tariff', id }); },
};

// ─────────────────────────────────────
// Стан
// ─────────────────────────────────────

let map = null;
let mapReady = false;
let allRoutes = [];
let currentRoute = null;       // { id, name, route_kind, coordinates:[[lat,lng]], stops:[{id,name,coordinates}] }
let currentTariffs = [];
let editingTariffId = null;
let workingPairs = {};          // { 'idMin-idMax': number } — тимчасові значення форми міжміста
let stopMarkers = [];
let jsonExportTariff = null;     // тариф, обраний для експорту JSON
let currentTariffJsonText = '';  // текст JSON у модальному вікні (для завантаження)
let currentTariffTxtText = '';   // текст TXT у модальному вікні (для завантаження)
let tariffFileFormat = 'json';   // поточний формат перегляду/завантаження: 'json' | 'txt'

// Автозбереження форми
let tariffDirty = false;        // чи змінювалась форма з моменту останнього збереження
let isSavingTariff = false;     // блокування одночасних збережень (ручного та авто)
const AUTOSAVE_INTERVAL = 5000; // мс

/** Кількість пар цін, потрібних для повного міжміського тарифу */
function expectedPairs(stopsCount) {
    return stopsCount >= 2 ? (stopsCount * (stopsCount - 1)) / 2 : 0;
}

/** Кількість заповнених (>0) пар у наборі; враховує лише актуальні зупинки */
function filledPairs(pairs, validStopIds = null) {
    if (!pairs) return 0;
    const valid = validStopIds ? new Set(validStopIds.map(Number)) : null;
    return Object.entries(pairs).filter(([key, val]) => {
        if (typeof val !== 'number' || val <= 0) return false;
        if (!valid) return true;
        const ids = key.split('-').map(Number);
        return ids.length === 2 && valid.has(ids[0]) && valid.has(ids[1]);
    }).length;
}

/** Залишає лише пари між існуючими зупинками маршруту */
function filterValidPairs(pairs, stopIds) {
    if (!pairs || !stopIds?.length) return {};
    const valid = new Set(stopIds.map(Number));
    const result = {};
    for (const [key, val] of Object.entries(pairs)) {
        const ids = key.split('-').map(Number);
        if (ids.length === 2 && valid.has(ids[0]) && valid.has(ids[1])
            && typeof val === 'number' && val > 0) {
            result[key] = val;
        }
    }
    return result;
}

function currentStopIds() {
    return (currentRoute?.stops || []).map(s => s.id).filter(Boolean);
}

/** Пари без ціни (відсутня або ≤ 0) у порядку маршруту */
function getUnfilledPairs(pairs, route) {
    const stops = route?.stops || [];
    const unfilled = [];

    for (let i = 0; i < stops.length - 1; i++) {
        for (let j = i + 1; j < stops.length; j++) {
            const key = pairKey(stops[i].id, stops[j].id);
            const val = pairs?.[key];
            if (typeof val !== 'number' || val <= 0) {
                unfilled.push(
                    `${i + 1}. ${stops[i].name || 'Зупинка'} → ${j + 1}. ${stops[j].name || 'Зупинка'}`,
                );
            }
        }
    }

    return unfilled;
}

function formatUnfilledPairsSuffix(pairs, route) {
    const unfilled = getUnfilledPairs(pairs, route);
    if (!unfilled.length) return '';
    return `: ${unfilled.join('; ')}`;
}

/**
 * Повертає текст попередження для тарифу або null, якщо все гаразд.
 * @param {object} tariff
 * @param {string} routeKind
 * @param {number} stopsCount
 * @param {number[]|null} stopIds
 * @param {object|null} route маршрут зі зупинками (для списку незаповнених пар)
 */
function tariffWarning(tariff, routeKind, stopsCount, stopIds = null, route = null) {
    const kind = tariff.prices?.kind || 'city';
    if (kind !== routeKind) {
        return 'Тариф налаштований під інший тип маршруту — перебудуйте';
    }
    if (kind === 'city') {
        const p = tariff.prices?.price;
        if (!p || p <= 0) return 'Не вказано ціну проїзду';
        return null;
    }
    const expected = expectedPairs(stopsCount);
    const pairs = tariff.prices?.pairs;
    const rawFilled = filledPairs(pairs);
    const filled = stopIds ? filledPairs(pairs, stopIds) : rawFilled;

    if (rawFilled > filled) {
        return `Є застарілі пари (${rawFilled - filled}) — відкрийте тариф для очищення`;
    }
    if (rawFilled > expected) {
        return `Заповнено ${rawFilled} з ${expected} пар — є зайві дані`;
    }
    if (filled < expected) {
        return `Заповнено ${filled} з ${expected} пар — тариф неповний${formatUnfilledPairsSuffix(pairs, route)}`;
    }
    return null;
}

// ─────────────────────────────────────
// Ініціалізація
// ─────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    if (!window.MAPBOX_API_KEY) {
        console.error('Mapbox API key not set');
        return;
    }
    mapboxgl.accessToken = window.MAPBOX_API_KEY;

    map = new mapboxgl.Map({
        container: 'tariffsMap',
        style: 'mapbox://styles/mapbox/streets-v12',
        center: CONFIG.defaultCenter,
        zoom: CONFIG.defaultZoom,
    });

    map.addControl(new mapboxgl.NavigationControl(), 'bottom-right');

    map.on('load', () => {
        mapReady = true;
        addMapLayers();
        // Якщо маршрут уже вибрали до готовності карти
        if (currentRoute) displayRouteOnMap(currentRoute);
    });

    initSidebar();
    loadRoutesList();
});

function emptyFC() {
    return { type: 'FeatureCollection', features: [] };
}

function addMapLayers() {
    // Базова лінія маршруту
    map.addSource('tariff-route', { type: 'geojson', data: emptyFC() });
    map.addLayer({
        id: 'tariff-route-line',
        type: 'line',
        source: 'tariff-route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
            'line-color': ['coalesce', ['get', 'color'], CONFIG.routeColor],
            'line-width': 4,
            'line-opacity': 0.55,
        },
    });

    // Підсвічений відрізок
    map.addSource('tariff-highlight', { type: 'geojson', data: emptyFC() });
    map.addLayer({
        id: 'tariff-highlight-line',
        type: 'line',
        source: 'tariff-highlight',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
            'line-color': CONFIG.highlightColor,
            'line-width': 7,
            'line-opacity': 0.95,
        },
    });
}

function setSourceData(id, data) {
    const src = map?.getSource(id);
    if (src) src.setData(data);
}

// ─────────────────────────────────────
// Список маршрутів (ліва панель, режим списку)
// ─────────────────────────────────────

function initSidebar() {
    $id('tariffBackBtn').addEventListener('click', showListMode);

    $id('tariffRouteSearch').addEventListener('input', (e) => {
        renderRoutesList(e.target.value.trim().toLowerCase());
    });

    $id('addTariffBtn').addEventListener('click', () => openTariffForm(null));
    $id('uploadTariffBtn')?.addEventListener('click', () => $id('tariffFileInput')?.click());
    $id('tariffFileInput')?.addEventListener('change', handleTariffFileUpload);
    $id('tariffJsonViewBtn')?.addEventListener('click', openTariffJsonModal);
    $id('tariffJsonDownloadBtn')?.addEventListener('click', downloadTariffJsonFile);
    document.querySelectorAll('#tariffFormatToggle .fmt-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            tariffFileFormat = btn.dataset.fmt === 'txt' ? 'txt' : 'json';
            renderTariffModalView();
        });
    });
    $id('closeTariffJsonModal')?.addEventListener('click', closeTariffJsonModal);
    $id('tariffJsonModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'tariffJsonModal') closeTariffJsonModal();
    });
    $id('cancelTariffBtn').addEventListener('click', closeTariffForm);
    $id('saveTariffBtn').addEventListener('click', saveTariff);
    $id('deleteTariffBtn').addEventListener('click', deleteCurrentTariff);

    // Позначаємо форму як змінену для автозбереження
    $id('tariffName').addEventListener('input', () => { tariffDirty = true; });
    $id('cityPrice').addEventListener('input', () => { tariffDirty = true; });

    // Автозбереження форми раз на 5 секунд
    setInterval(autosaveTariff, AUTOSAVE_INTERVAL);
}

async function loadRoutesList() {
    try {
        const data = await API.getRoutesWithTariffs();
        allRoutes = data.routes || [];
        renderRoutesList('');
    } catch (e) {
        $id('tariffsRoutesList').innerHTML = '<div class="tariffs-empty">Помилка завантаження</div>';
        console.error(e);
    }
}

function renderRoutesList(filter) {
    const list = $id('tariffsRoutesList');
    const routes = filter
        ? allRoutes.filter(r => r.name.toLowerCase().includes(filter))
        : allRoutes;

    if (routes.length === 0) {
        list.innerHTML = '<div class="tariffs-empty">Маршрутів не знайдено</div>';
        return;
    }

    list.innerHTML = routes.map(r => {
        const kindLabel = r.route_kind === 'intercity' ? 'Міжміський' : 'Міський';
        const kindClass = r.route_kind === 'intercity' ? 'kind-intercity' : 'kind-city';
        const count = r.tariffs?.length || 0;
        const countLabel = count > 0 ? `${count} тариф(ів)` : 'без тарифів';

        // Позначка проблем: невірний тип або неповний тариф
        const problems = (r.tariffs || [])
            .map(t => tariffWarning(t, r.route_kind, r.stops_count || 0))
            .filter(Boolean);
        const warn = problems.length
            ? `<span class="tariff-warn" title="${escapeHtml(problems.join('; '))}">⚠</span>`
            : '';

        return `<div class="tariff-route-item" data-route-id="${r.id}">
            <div class="tariff-route-main">
                <span class="tariff-route-name">${escapeHtml(r.name)}</span>
                <span class="kind-badge ${kindClass}">${kindLabel}</span>
            </div>
            <div class="tariff-route-sub">
                <span class="tariff-count ${count > 0 ? 'has' : ''}">${countLabel}</span>${warn}
            </div>
        </div>`;
    }).join('');

    list.querySelectorAll('.tariff-route-item').forEach(el => {
        el.addEventListener('click', () => openRoute(parseInt(el.dataset.routeId)));
    });
}

function showListMode() {
    $id('tariffsEditMode').style.display = 'none';
    $id('tariffsListMode').style.display = 'block';
    closeTariffForm();
    closeTariffJsonModal();
    jsonExportTariff = null;
    clearHighlight();
}

// ─────────────────────────────────────
// Відкриття маршруту (режим редагування)
// ─────────────────────────────────────

async function openRoute(routeId) {
    try {
        const [routeData, tariffsData] = await Promise.all([
            API.getRoute(routeId),
            API.getTariffs(routeId),
        ]);

        if (!routeData.route) {
            alert('Маршрут не знайдено');
            return;
        }

        currentRoute = routeData.route;
        currentTariffs = tariffsData.tariffs || [];

        $id('tariffsListMode').style.display = 'none';
        $id('tariffsEditMode').style.display = 'flex';
        $id('tariffEditTitle').textContent = currentRoute.name;

        renderRouteMeta();
        renderTariffItems();
        closeTariffForm();
        updateIntercityJsonControls();

        displayRouteOnMap(currentRoute);
    } catch (e) {
        console.error(e);
        alert('Помилка завантаження маршруту');
    }
}

function renderRouteMeta() {
    const r = currentRoute;
    const kindLabel = r.route_kind === 'intercity' ? 'Міжміський' : 'Міський';
    const kindClass = r.route_kind === 'intercity' ? 'kind-intercity' : 'kind-city';
    $id('tariffRouteMeta').innerHTML = `
        <span class="kind-badge ${kindClass}">${kindLabel}</span>
        <span class="meta-stops">${r.stops?.length || 0} зупинок</span>`;
}

/** Показує/ховає елементи JSON лише для міжміських маршрутів */
function updateIntercityJsonControls() {
    const isIntercity = currentRoute?.route_kind === 'intercity';
    const viewBtn = $id('tariffJsonViewBtn');
    const uploadBtn = $id('uploadTariffBtn');
    if (viewBtn) viewBtn.style.display = isIntercity ? '' : 'none';
    if (uploadBtn) uploadBtn.style.display = isIntercity ? '' : 'none';
}

// ─────────────────────────────────────
// Список тарифів маршруту
// ─────────────────────────────────────

function renderTariffItems() {
    const list = $id('tariffItemsList');
    if (!currentTariffs.length) {
        list.innerHTML = '<div class="tariffs-empty">Тарифів ще немає</div>';
        return;
    }

    const stopsCount = currentRoute.stops?.length || 0;
    const stopIds = currentStopIds();

    list.innerHTML = currentTariffs.map(t => {
        const kind = t.prices?.kind || 'city';
        let summary = '';
        if (kind === 'city') {
            summary = `${t.prices?.price ?? 0} грн`;
        } else {
            summary = `${filledPairs(t.prices?.pairs, stopIds)}/${expectedPairs(stopsCount)} пар`;
        }
        const problem = tariffWarning(t, currentRoute.route_kind, stopsCount, stopIds, currentRoute);
        const warn = problem
            ? `<span class="tariff-warn" title="${escapeHtml(problem)}">⚠</span>`
            : '';

        return `<div class="tariff-item" data-tariff-id="${t.id}">
            <span class="tariff-item-name">${escapeHtml(t.name)}</span>
            <span class="tariff-item-summary">${summary}</span>${warn}
        </div>`;
    }).join('');

    list.querySelectorAll('.tariff-item').forEach(el => {
        el.addEventListener('click', () => {
            const t = currentTariffs.find(x => x.id == el.dataset.tariffId);
            if (t) openTariffForm(t);
        });
    });
}

// ─────────────────────────────────────
// Форма тарифу
// ─────────────────────────────────────

function openTariffForm(tariff) {
    editingTariffId = tariff?.id || null;
    jsonExportTariff = tariff || null;
    workingPairs = {};
    tariffDirty = false;
    setAutosaveStatus('');

    $id('tariffFormSection').style.display = 'block';
    $id('tariffFormTitle').textContent = tariff ? 'Редагування тарифу' : 'Новий тариф';
    $id('tariffId').value = editingTariffId || '';
    $id('tariffName').value = tariff?.name || '';
    $id('deleteTariffBtn').style.display = tariff ? 'block' : 'none';

    const kind = currentRoute.route_kind;

    if (kind === 'city') {
        $id('cityTariffBlock').style.display = 'block';
        $id('intercityTariffBlock').style.display = 'none';
        $id('cityPrice').value = (tariff?.prices?.kind === 'city') ? (tariff.prices.price ?? '') : '';
    } else {
        $id('cityTariffBlock').style.display = 'none';
        $id('intercityTariffBlock').style.display = 'block';

        // Наповнюємо робочі пари з наявного тарифу (лише актуальні зупинки, 0 — валідна ціна)
        if (tariff?.prices?.kind === 'intercity' && tariff.prices.pairs) {
            const merged = mergePairsForRoute(currentRoute, tariff.prices.pairs);
            const cleaned = filterValidPairs(tariff.prices.pairs, currentStopIds());
            workingPairs = merged;
            const hadStalePairs = Object.keys(tariff.prices.pairs).length !== Object.keys(cleaned).length;
            if (hadStalePairs) tariffDirty = true;
        }
        buildFromSelector();
    }

    $id('tariffFormSection').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeTariffForm() {
    $id('tariffFormSection').style.display = 'none';
    editingTariffId = null;
    workingPairs = {};
    tariffDirty = false;
    setAutosaveStatus('');
    clearHighlight();
}

function isTariffFormOpen() {
    const section = $id('tariffFormSection');
    return section && section.style.display !== 'none';
}

// --- Міжмісто: селектор "від" + список "до" ---

function buildFromSelector() {
    const sel = $id('intercityFromStop');
    const stops = currentRoute.stops || [];

    if (stops.length < 2) {
        sel.innerHTML = '<option value="">Недостатньо зупинок</option>';
        $id('intercityPairsList').innerHTML =
            '<div class="tariffs-empty">У маршруту має бути щонайменше 2 зупинки</div>';
        return;
    }

    // "Від" — усі зупинки, крім останньої (від неї немає наступних)
    sel.innerHTML = stops.slice(0, -1).map((s, i) =>
        `<option value="${i}">${i + 1}. ${escapeHtml(s.name || 'Зупинка')}</option>`,
    ).join('');

    sel.onchange = () => renderPairsForFrom(parseInt(sel.value));
    renderPairsForFrom(0);
    updateIntercityProgress();
}

/** Оновлює лічильник «Заповнено X з Y пар» у формі міжміста */
function updateIntercityProgress() {
    const el = $id('intercityProgress');
    if (!el) return;
    const stopsCount = currentRoute?.stops?.length || 0;
    const expected = expectedPairs(stopsCount);
    const filled = filledPairs(workingPairs, currentStopIds());
    const incomplete = filled < expected;

    if (!incomplete) {
        el.textContent = `Заповнено ${filled} з ${expected} пар ✓`;
        el.classList.remove('incomplete');
        return;
    }

    const unfilled = getUnfilledPairs(workingPairs, currentRoute);
    const listHtml = unfilled.length
        ? `<div class="intercity-missing-list">${unfilled.map(p => escapeHtml(p)).join('<br>')}</div>`
        : '';

    el.innerHTML = `Заповнено ${filled} з ${expected} пар — тариф неповний${listHtml}`;
    el.classList.add('incomplete');
}

function renderPairsForFrom(fromIndex) {
    const stops = currentRoute.stops || [];
    const fromStop = stops[fromIndex];
    const container = $id('intercityPairsList');

    if (!fromStop) { container.innerHTML = ''; return; }

    let html = '';
    for (let j = fromIndex + 1; j < stops.length; j++) {
        const toStop = stops[j];
        const key = pairKey(fromStop.id, toStop.id);
        const val = workingPairs[key] ?? '';
        html += `<div class="intercity-pair-row" data-from="${fromIndex}" data-to="${j}">
            <span class="pair-label">→ ${j + 1}. ${escapeHtml(toStop.name || 'Зупинка')}</span>
            <input type="number" class="input pair-input" data-key="${key}"
                data-from="${fromIndex}" data-to="${j}"
                min="0" step="0.5" placeholder="грн" value="${val}">
        </div>`;
    }
    container.innerHTML = html;

    container.querySelectorAll('.pair-input').forEach(inp => {
        inp.addEventListener('input', () => {
            const key = inp.dataset.key;
            if (inp.value === '') delete workingPairs[key];
            else workingPairs[key] = parseFloat(inp.value);
            tariffDirty = true;
            updateIntercityProgress();
        });
        inp.addEventListener('focus', () => {
            highlightBetweenStops(parseInt(inp.dataset.from), parseInt(inp.dataset.to));
            inp.closest('.intercity-pair-row').classList.add('active');
        });
        inp.addEventListener('blur', () => {
            inp.closest('.intercity-pair-row').classList.remove('active');
        });
    });

    // Підсвічуємо перший відрізок для наочності
    if (stops.length > fromIndex + 1) {
        highlightBetweenStops(fromIndex, fromIndex + 1);
    }
}

function pairKey(idA, idB) {
    const a = parseInt(idA), b = parseInt(idB);
    return `${Math.min(a, b)}-${Math.max(a, b)}`;
}

// ─────────────────────────────────────
// JSON імпорт / експорт тарифів
// ─────────────────────────────────────

/** Компактний JSON об'єкт зупинки для файлу */
function compactStopJson(stop) {
    return `{"id": ${stop.id},"name": ${JSON.stringify(stop.name || '')}}`;
}

/** Будує об'єкт JSON-файлу тарифів для маршруту */
function buildTariffFileObject(route, pairs = {}) {
    const stops = route.stops || [];
    const items = [];

    for (let i = 0; i < stops.length - 1; i++) {
        for (let j = i + 1; j < stops.length; j++) {
            const from = stops[i];
            const to = stops[j];
            const key = pairKey(from.id, to.id);
            const price = pairs[key];
            items.push({
                stop_from: { id: from.id, name: from.name || '' },
                stop_to: { id: to.id, name: to.name || '' },
                price: typeof price === 'number' && !isNaN(price) ? price : 0,
            });
        }
    }

    return { route_id: route.id, stops: items };
}

/** Форматує JSON у зручному для редагування вигляді (stop_from і stop_to в один рядок) */
function formatTariffFileJson(data) {
    const lines = ['{'];
    lines.push(`   "route_id": ${data.route_id},`);
    lines.push('   "stops": [');

    (data.stops || []).forEach((item, i) => {
        const comma = i < data.stops.length - 1 ? ',' : '';
        lines.push('      {');
        lines.push(`         "stop_from": ${compactStopJson(item.stop_from)},"stop_to": ${compactStopJson(item.stop_to)},`);
        lines.push(`         "price": ${item.price}`);
        lines.push(`      }${comma}`);
    });

    lines.push('   ]');
    lines.push('}');
    return lines.join('\n');
}

/** Нормалізує назву зупинки для зіставлення (TXT-формат зіставляється за назвами) */
function normalizeStopName(name) {
    return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Будує TXT-файл тарифів: кожен рядок — «зупинка1,зупинка2,ціна».
 * Ціна відсутньої пари → 0.
 */
function buildTariffTxtLines(route, pairs = {}) {
    const stops = route.stops || [];
    const lines = [];

    for (let i = 0; i < stops.length - 1; i++) {
        for (let j = i + 1; j < stops.length; j++) {
            const from = stops[i];
            const to = stops[j];
            const price = pairs[pairKey(from.id, to.id)];
            const p = typeof price === 'number' && !isNaN(price) ? price : 0;
            lines.push(`${from.name || ''},${to.name || ''},${p}`);
        }
    }

    return lines.join('\n');
}

/**
 * Парсить TXT-файл тарифів (рядки «зупинка1,зупинка2,ціна»).
 * Пари зіставляються за назвами зупинок маршруту.
 * Повертає повний набір пар маршруту (відсутні → 0).
 */
function parseTariffTxtToPairs(text, route) {
    const warnings = [];
    const stops = route.stops || [];

    // Мапа нормалізована назва → id зупинки; неоднозначні назви позначаємо
    const nameToId = new Map();
    const ambiguous = new Set();
    for (const s of stops) {
        const key = normalizeStopName(s.name);
        if (!key) continue;
        if (nameToId.has(key)) ambiguous.add(key);
        else nameToId.set(key, Number(s.id));
    }

    const pairs = buildEmptyRoutePairs(route);
    const notFound = new Set();
    let matched = 0;

    text.split(/\r?\n/).forEach((rawLine, idx) => {
        const line = rawLine.trim();
        if (!line) return;

        const parts = line.split(',');
        if (parts.length < 3) {
            warnings.push(`Рядок #${idx + 1}: очікується «зупинка1,зупинка2,ціна» — пропущено`);
            return;
        }

        const fromName = parts[0].trim();
        const priceStr = parts[parts.length - 1].trim();
        const toName = parts.slice(1, -1).join(',').trim();

        const fromKey = normalizeStopName(fromName);
        const toKey = normalizeStopName(toName);

        if (ambiguous.has(fromKey) || ambiguous.has(toKey)) {
            warnings.push(`Рядок #${idx + 1}: неоднозначна назва зупинки (повторюється в маршруті) — пропущено`);
            return;
        }

        const fromId = nameToId.get(fromKey);
        const toId = nameToId.get(toKey);

        if (fromId == null) notFound.add(fromName);
        if (toId == null) notFound.add(toName);
        if (fromId == null || toId == null) return;

        if (fromId === toId) {
            warnings.push(`Рядок #${idx + 1}: однакові зупинки — пропущено`);
            return;
        }

        const price = parseFloat(priceStr.replace(',', '.'));
        pairs[pairKey(fromId, toId)] = isNaN(price) ? 0 : price;
        matched++;
    });

    if (notFound.size) {
        warnings.push(`Зупинки не знайдено в маршруті за назвою (пропущено): ${[...notFound].join(', ')}`);
    }
    if (!matched) {
        throw new Error('Не вдалося зіставити жодної пари зупинок за назвами');
    }

    return { pairs, warnings };
}

/** Витягує масив пар з JSON (новий формат stops[] або старий "0","1",…) */
function extractTariffFileItems(json) {
    if (Array.isArray(json.stops)) return json.stops;
    return Object.keys(json)
        .filter(k => /^\d+$/.test(k))
        .sort((a, b) => Number(a) - Number(b))
        .map(k => json[k]);
}

/** Усі пари маршруту з нульовими значеннями за замовчуванням */
function buildEmptyRoutePairs(route) {
    const pairs = {};
    const stops = route.stops || [];
    for (let i = 0; i < stops.length - 1; i++) {
        for (let j = i + 1; j < stops.length; j++) {
            pairs[pairKey(stops[i].id, stops[j].id)] = 0;
        }
    }
    return pairs;
}

/** Накладає збережені пари на повну матрицю маршруту (0 — теж валідна ціна) */
function mergePairsForRoute(route, sourcePairs) {
    const pairs = buildEmptyRoutePairs(route);
    if (!sourcePairs) return pairs;
    const valid = new Set((route.stops || []).map(s => Number(s.id)));
    for (const [key, val] of Object.entries(sourcePairs)) {
        const ids = key.split('-').map(Number);
        if (ids.length === 2 && valid.has(ids[0]) && valid.has(ids[1]) && typeof val === 'number') {
            pairs[pairKey(ids[0], ids[1])] = val;
        }
    }
    return pairs;
}

/** Підсвічування JSON у модальному вікні */
function highlightTariffJson(text) {
    let html = '';
    const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|(\{|\})|(,)|(:)|(-?\d+\.?\d*)/g;
    let lastIndex = 0;
    let m;

    while ((m = re.exec(text)) !== null) {
        html += escapeHtml(text.slice(lastIndex, m.index));
        lastIndex = re.lastIndex;

        if (m[1] !== undefined) {
            const isKey = /^\s*:/.test(text.slice(re.lastIndex));
            const inner = escapeHtml(m[1]);
            if (isKey) {
                html += `<span class="json-quote">"</span><span class="json-key">${inner}</span><span class="json-quote">"</span>`;
            } else {
                html += `<span class="json-quote">"</span><span class="json-value">${inner}</span><span class="json-quote">"</span>`;
            }
        } else if (m[2]) {
            html += `<span class="json-brace">${m[2]}</span>`;
        } else if (m[3] || m[4]) {
            html += `<span class="json-punct">${m[3] || m[4]}</span>`;
        } else if (m[5] !== undefined) {
            const cls = Number(m[5]) === 0 ? 'json-zero' : 'json-number';
            html += `<span class="${cls}">${m[5]}</span>`;
        }
    }

    html += escapeHtml(text.slice(lastIndex));
    return html;
}

/** Пари для експорту: відкритий тариф або нулі */
function getPairsForJsonExport() {
    if (isTariffFormOpen() && currentRoute?.route_kind === 'intercity') {
        return mergePairsForRoute(currentRoute, workingPairs);
    }
    if (jsonExportTariff?.prices?.kind === 'intercity') {
        return mergePairsForRoute(currentRoute, jsonExportTariff.prices.pairs);
    }
    return {};
}

function sanitizeFilename(name) {
    return String(name ?? 'маршрут').replace(/[<>:"/\\|?*]/g, '_').trim() || 'маршрут';
}

function openTariffJsonModal() {
    if (!currentRoute || currentRoute.route_kind !== 'intercity') return;
    renderTariffModalView();
    $id('tariffJsonModal').style.display = 'flex';
}

/** Перемальовує вміст модального вікна відповідно до обраного формату */
function renderTariffModalView() {
    if (!currentRoute) return;

    const pairs = getPairsForJsonExport();
    const view = $id('tariffJsonView');
    const hint = $id('tariffFormatHint');

    if (tariffFileFormat === 'txt') {
        currentTariffTxtText = buildTariffTxtLines(currentRoute, pairs);
        if (view) view.textContent = currentTariffTxtText;
        if (hint) {
            hint.innerHTML = 'Кожен рядок — <code>зупинка1,зупинка2,ціна</code> (0 — без ціни). '
                + 'При завантаженні пари зіставляються за назвами зупинок. Приймаються лише файли <code>.txt</code>.';
        }
    } else {
        const data = buildTariffFileObject(currentRoute, pairs);
        currentTariffJsonText = formatTariffFileJson(data);
        if (view) view.innerHTML = highlightTariffJson(currentTariffJsonText);
        if (hint) {
            hint.innerHTML = 'Заповніть поле <code>price</code> для кожної пари зупинок. '
                + 'Після редагування збережіть файл і завантажте через «Новий тариф (файл)».';
        }
    }

    document.querySelectorAll('#tariffFormatToggle .fmt-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.fmt === tariffFileFormat);
    });
}

function closeTariffJsonModal() {
    const modal = $id('tariffJsonModal');
    if (modal) modal.style.display = 'none';
}

function downloadTariffJsonFile() {
    if (!currentRoute) return;

    const isTxt = tariffFileFormat === 'txt';
    const content = isTxt ? currentTariffTxtText : currentTariffJsonText;
    if (!content) return;

    const mime = isTxt ? 'text/plain;charset=utf-8' : 'application/json;charset=utf-8';
    const ext = isTxt ? 'txt' : 'json';

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Тарифи Маршруту - ${sanitizeFilename(currentRoute.name)}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

/**
 * Парсить завантажений JSON-файл.
 * Повертає повний набір пар маршруту (відсутні в файлі → 0).
 * Чужі ID пропускаються, але не блокують збереження.
 */
function parseTariffFileToPairs(json, route) {
    const warnings = [];

    if (!json || typeof json !== 'object') {
        throw new Error('Невірний формат JSON');
    }
    if (json.route_id && Number(json.route_id) !== Number(route.id)) {
        throw new Error(`route_id у файлі (${json.route_id}) не збігається з маршрутом (${route.id})`);
    }

    const validIds = new Set((route.stops || []).map(s => Number(s.id)));
    const pairs = buildEmptyRoutePairs(route);
    const items = extractTariffFileItems(json);

    if (!items.length) throw new Error('У файлі немає пар зупинок');

    const foreignIds = new Set();

    items.forEach((item, i) => {
        if (!item?.stop_from?.id || !item?.stop_to?.id) {
            warnings.push(`Пара #${i + 1}: неповні дані stop_from / stop_to — пропущено`);
            return;
        }

        const fromId = Number(item.stop_from.id);
        const toId = Number(item.stop_to.id);

        if (fromId === toId) {
            warnings.push(`Пара #${i + 1}: однакові зупинки — пропущено`);
            return;
        }

        const fromValid = validIds.has(fromId);
        const toValid = validIds.has(toId);

        if (!fromValid || !toValid) {
            if (!fromValid) foreignIds.add(fromId);
            if (!toValid) foreignIds.add(toId);
            return;
        }

        const price = parseFloat(item.price);
        pairs[pairKey(fromId, toId)] = isNaN(price) ? 0 : price;
    });

    if (foreignIds.size) {
        warnings.push(`Зупинки не з цього маршруту (пропущено): ${[...foreignIds].join(', ')}`);
    }

    return { pairs, warnings };
}

async function handleTariffFileUpload(e) {
    const input = e.target;
    const file = input.files?.[0];
    input.value = '';

    if (!file || !currentRoute) return;
    if (currentRoute.route_kind !== 'intercity') {
        alert('Завантаження файлу доступне лише для міжміських маршрутів');
        return;
    }

    const isTxt = /\.txt$/i.test(file.name);

    try {
        const text = await file.text();
        let pairs, warnings, name;

        if (isTxt) {
            ({ pairs, warnings } = parseTariffTxtToPairs(text, currentRoute));
            name = prompt('Введіть назву тарифу:', file.name.replace(/\.txt$/i, ''));
            if (!name?.trim()) return;
            name = name.trim();
        } else {
            const json = JSON.parse(text);
            ({ pairs, warnings } = parseTariffFileToPairs(json, currentRoute));
            name = (json.tariff_name || json.name || '').trim();
            if (!name) {
                name = prompt('Введіть назву тарифу:', file.name.replace(/\.json$/i, ''));
                if (!name?.trim()) return;
                name = name.trim();
            }
        }

        const prices = { kind: 'intercity', pairs };
        const data = await API.saveTariff({
            route_id: currentRoute.id,
            name,
            prices: JSON.stringify(prices),
        });
        if (!data.ok) throw new Error(data.error || 'Помилка збереження');

        const refreshed = await API.getTariffs(currentRoute.id);
        currentTariffs = refreshed.tariffs || [];
        renderTariffItems();
        syncRouteTariffsInList();

        const saved = currentTariffs.find(t => t.id == data.id);
        if (saved) openTariffForm(saved);

        const total = Object.keys(pairs).length;
        const withPrice = Object.values(pairs).filter(v => v > 0).length;
        let msg = `Тариф «${name}» завантажено.\nПар з ціною > 0: ${withPrice} з ${total}`;
        if (warnings.length) {
            msg += `\n\nПопередження:\n${warnings.join('\n')}`;
        }
        alert(msg);
    } catch (err) {
        alert(`Помилка завантаження: ${err.message}`);
        console.error(err);
    }
}

// ─────────────────────────────────────
// Збереження / видалення тарифу
// ─────────────────────────────────────

/**
 * Збирає об'єкт prices з форми.
 * @param {{ strict?: boolean }} opts strict — кидає помилку при некоректних даних (ручне збереження)
 */
function buildPricesFromForm({ strict = false } = {}) {
    if (currentRoute.route_kind === 'city') {
        let price = parseFloat($id('cityPrice').value);
        if (isNaN(price) || price < 0) {
            if (strict) throw new Error('Введіть коректну ціну');
            price = 0;
        }
        return { kind: 'city', price };
    }
    return { kind: 'intercity', pairs: filterValidPairs(workingPairs, currentStopIds()) };
}

/**
 * Зберігає тариф на сервері (спільна логіка для ручного та авто-збереження).
 * @param {{ silent?: boolean, closeAfter?: boolean }} opts
 * @returns {Promise<boolean>} успіх
 */
async function persistTariff({ silent = false, closeAfter = false } = {}) {
    if (isSavingTariff) return false;

    const name = $id('tariffName').value.trim();
    if (!name) {
        if (!silent) alert('Введіть назву тарифу');
        return false;
    }

    let prices;
    try {
        prices = buildPricesFromForm({ strict: !silent });
    } catch (e) {
        if (!silent) alert(e.message);
        return false;
    }

    isSavingTariff = true;
    const btn = $id('saveTariffBtn');
    if (!silent) btn.disabled = true;
    if (silent) setAutosaveStatus('Збереження…');

    try {
        const data = await API.saveTariff({
            id: editingTariffId || '',
            route_id: currentRoute.id,
            name,
            prices: JSON.stringify(prices),
        });
        if (!data.ok) throw new Error(data.error || 'Помилка');

        // Новий тариф отримав id — далі редагуємо його ж
        if (!editingTariffId && data.id) {
            editingTariffId = data.id;
            $id('tariffId').value = data.id;
            $id('deleteTariffBtn').style.display = 'block';
        }

        tariffDirty = false;

        // Оновлюємо локальний стан списку
        const refreshed = await API.getTariffs(currentRoute.id);
        currentTariffs = refreshed.tariffs || [];
        renderTariffItems();
        syncRouteTariffsInList();

        if (closeAfter) {
            closeTariffForm();
        } else if (silent) {
            setAutosaveStatus(`Автозбережено о ${new Date().toLocaleTimeString()}`);
        }
        return true;
    } catch (e) {
        if (!silent) alert(`Помилка: ${e.message}`);
        else setAutosaveStatus('Помилка автозбереження');
        console.warn('Tariff save error:', e.message);
        return false;
    } finally {
        isSavingTariff = false;
        if (!silent) btn.disabled = false;
    }
}

/** Ручне збереження тарифу (кнопка) */
function saveTariff() {
    return persistTariff({ silent: false, closeAfter: true });
}

/** Автозбереження форми — викликається за таймером кожні 5 с */
function autosaveTariff() {
    if (!isTariffFormOpen()) return;
    if (!tariffDirty || isSavingTariff) return;
    // Без назви не зберігаємо (щоб не плодити порожні записи)
    if (!$id('tariffName').value.trim()) return;
    persistTariff({ silent: true, closeAfter: false });
}

function setAutosaveStatus(text) {
    const el = $id('tariffAutosaveStatus');
    if (el) el.textContent = text;
}

async function deleteCurrentTariff() {
    if (!editingTariffId) return;
    if (!confirm('Видалити цей тариф?')) return;

    try {
        const data = await API.deleteTariff(editingTariffId);
        if (!data.ok) throw new Error(data.error || 'Помилка');

        currentTariffs = currentTariffs.filter(t => t.id != editingTariffId);
        renderTariffItems();
        closeTariffForm();
        syncRouteTariffsInList();
    } catch (e) {
        alert(`Помилка: ${e.message}`);
    }
}

/** Оновлює лічильник тарифів у загальному списку маршрутів */
function syncRouteTariffsInList() {
    const r = allRoutes.find(x => x.id == currentRoute.id);
    if (r) r.tariffs = currentTariffs;
}

// ─────────────────────────────────────
// Карта
// ─────────────────────────────────────

function displayRouteOnMap(route) {
    clearHighlight();
    stopMarkers.forEach(m => m.remove());
    stopMarkers = [];

    if (!mapReady) return; // відкладеться до map load

    const color = route.additional?.color || CONFIG.routeColor;

    if (route.coordinates?.length >= 2) {
        const coords = route.coordinates.map(c => [c[1], c[0]]); // [lat,lng] → [lng,lat]
        setSourceData('tariff-route', {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                properties: { color },
                geometry: { type: 'LineString', coordinates: coords },
            }],
        });
        fitBounds(coords);
    } else {
        setSourceData('tariff-route', emptyFC());
    }

    // Маркери зупинок з номерами
    (route.stops || []).forEach((s, i) => {
        if (!s.coordinates || s.coordinates.length < 2) return;
        const el = document.createElement('div');
        el.className = 'tariff-stop-marker';
        el.textContent = String(i + 1);
        const marker = new mapboxgl.Marker({ element: el })
            .setLngLat([s.coordinates[1], s.coordinates[0]])
            .setPopup(new mapboxgl.Popup({ offset: 14 }).setText(s.name || 'Зупинка'))
            .addTo(map);
        stopMarkers.push(marker);
    });
}

function fitBounds(coords) {
    if (!coords.length) return;
    const bounds = coords.reduce(
        (b, c) => b.extend(c),
        new mapboxgl.LngLatBounds(coords[0], coords[0]),
    );
    map.fitBounds(bounds, { padding: CONFIG.fitPadding, duration: 500 });
}

/** Підсвічує ділянку маршруту між двома зупинками (за індексами в списку зупинок) */
function highlightBetweenStops(fromIndex, toIndex) {
    if (!mapReady || !currentRoute?.coordinates?.length) return;

    const stops = currentRoute.stops || [];
    const fromStop = stops[fromIndex];
    const toStop = stops[toIndex];
    if (!fromStop?.coordinates || !toStop?.coordinates) return;

    const line = currentRoute.coordinates; // [[lat,lng], ...]
    let iFrom = nearestVertexIndex(line, fromStop.coordinates);
    let iTo = nearestVertexIndex(line, toStop.coordinates);
    if (iFrom > iTo) [iFrom, iTo] = [iTo, iFrom];

    const slice = line.slice(iFrom, iTo + 1).map(c => [c[1], c[0]]); // → [lng,lat]
    if (slice.length < 2) { clearHighlight(); return; }

    setSourceData('tariff-highlight', {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: slice },
        }],
    });
    $id('tariffsMapLegend').style.display = 'flex';
}

function clearHighlight() {
    setSourceData('tariff-highlight', emptyFC());
    const legend = $id('tariffsMapLegend');
    if (legend) legend.style.display = 'none';
}

/** Індекс найближчої вершини лінії до точки [lat,lng] */
function nearestVertexIndex(line, point) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < line.length; i++) {
        const dLat = line[i][0] - point[0];
        const dLng = line[i][1] - point[1];
        const d = dLat * dLat + dLng * dLng;
        if (d < bestD) { bestD = d; best = i; }
    }
    return best;
}
