/* ---------------------------
        Настройки
----------------------------*/
const maxStopsPerColumn = 3;      // максимум остановок в колонке
const refreshMs = 2000;           // обновление curPoint

// Адаптивна кількість видимих колонок: 4 → 3 (≤1100px) → 2 (≤850px)
function getVisibleColumns() {
   const w = window.innerWidth;
   if (w <= 850) return 2;
   if (w <= 1100) return 3;
   return 4;
}

// Коли зупинок мало — зменшуємо stopsPerColumn, щоб колонки заповнювались рівномірніше
function getStopsPerColumn() {
   const n = allStops.length;
   if (n <= 0) return maxStopsPerColumn;
   const visCols = getVisibleColumns();
   const ideal = Math.ceil(n / visCols);  // щоб не було колонок з 1 зупинкою
   return Math.min(maxStopsPerColumn, Math.max(2, ideal));
}

/* --------------------------- */

const listOfPoints = [];

const stopToListIndex = new Map();

const stopPositions = []

const allStops = []

let curPoint = 0;
let currentRouteId = null;

let activeStopIndex = 0;

let latNow = 50.450539;
let lonNow = 30.524091;

/* ─── Налаштування реклами ─── */
const AD_MANIFEST_REFRESH_MS = 3 * 60 * 1000;     // оновлювати manifest раз на 3 хв
const AD_MAX_VIDEO_DURATION_MS = 3 * 60 * 1000;   // ліміт одного програвання
const AD_CACHE_NAME = 'ads-v1';
const AD_CACHE_META_KEY = 'ad_cache_meta_v1';
const AD_CACHE_SOFT_CAP_BYTES = 40 * 1024 * 1024 * 1024; // 40 ГБ
const AD_CACHE_RESERVE_BYTES = 200 * 1024 * 1024;        // запас 200 МБ

// ─── API URLs ───
// Новий API на базі демона (tracking_sessions)
const SERVER_ORIGIN = 'http://138.201.226.159:8082';
const API_BASE = SERVER_ORIGIN + '/api/tracking.php';

/** Робить URL абсолютним (для випадку, коли HTML відкритий через file:// чи з іншого origin). */
function toAbsoluteMediaUrl(url) {
   if (!url) return url;
   if (/^https?:\/\//i.test(url)) return url;
   if (url.startsWith('//')) return 'http:' + url;
   if (url.startsWith('/')) return SERVER_ORIGIN + url;
   return SERVER_ORIGIN + '/' + url;
}

async function fetchData() {
   try {
      const res = await fetch(API_BASE + "?action=get_player_data&imei=" + imei, { cache: "no-store" });
      const data = await res.json();
      return data;
   } catch (e) {
      console.log("Ошибка fetch:", e);
      return null;
   }
}

function buildStopIndexMap() {
   for (const [i, p] of listOfPoints.entries()) {
      if (p.type !== 'stop') continue;

      if (p.idx != null) stopToListIndex.set(p.idx, i);
      if (p.name) stopToListIndex.set(p.name, i);
   }
}

let _lastFetchedData = null;

// Повертає true, якщо маршрут змінився і потрібен reloadRoute()
async function updateCurPoint() {
   const data = await fetchData();
   if (!data) return false;
   _lastFetchedData = data;

   const newRouteId = data.routeId ?? null;
   if (newRouteId !== currentRouteId) {
      return true;
   }
   if (typeof data.curPoint === 'number') {
      curPoint = data.curPoint;
   }
   return false;
}

// Оновлює статуси зупинок з останніх отриманих даних API
function refreshStopStatuses() {
   if (!_lastFetchedData || !Array.isArray(_lastFetchedData.listOfPoints)) return;
   const apiStops = _lastFetchedData.listOfPoints.filter(p => p.type === 'stop');
   for (let i = 0; i < allStops.length && i < apiStops.length; i++) {
      allStops[i].status = apiStops[i].status;
   }
   // Також оновити в listOfPoints
   let si = 0;
   for (const p of listOfPoints) {
      if (p.type === 'stop' && si < apiStops.length) {
         p.status = apiStops[si].status;
         si++;
      }
   }
}

let _reloadInflight = null;

async function reloadRoute() {
   if (_reloadInflight) return _reloadInflight;
   _reloadInflight = (async () => {
      const data = await fetchData();
      if (!data || !Array.isArray(data.listOfPoints)) return;

      _lastFetchedData = data;

      if (typeof data.curPoint === 'number') {
         curPoint = data.curPoint;
      }
      currentRouteId = data.routeId ?? null;

      listOfPoints.length = 0;
      listOfPoints.push(...data.listOfPoints);

      if (listOfPoints.length === 0) {
         console.log("reloadRoute: listOfPoints пуст, пропускаем отрисовку");
         return;
      }

      const cp = listOfPoints[curPoint] || listOfPoints[0];
      latNow = cp.lat;
      lonNow = cp.lng;

      stopToListIndex.clear();
      buildStopIndexMap();

      stopPositions.length = 0;
      stopPositions.push(
         ...listOfPoints.map((p, i) => p.type === 'stop' ? i : null).filter(i => i !== null)
      );

      allStops.length = 0;
      allStops.push(...listOfPoints.filter(p => p.type === 'stop'));

      activeStopIndex = calcActiveStopIndex();

      initColumns();
      updateVisibleWindow(activeStopIndex);
      updateStopStates(activeStopIndex);
      updateNextStop();
   })().finally(() => {
      _reloadInflight = null;
   });
   return _reloadInflight;
}

/* состояние */

function initColumns() {
   routeContainer.innerHTML = '';
   const spc = getStopsPerColumn();
   const colsCount = Math.ceil(allStops.length / spc);

   for (let col = 0; col < colsCount; col++) {
      const colEl = document.createElement('div');
      colEl.className = 'column';

      const fill = document.createElement('div');
      fill.className = 'fillLine';
      colEl.appendChild(fill);

      const base = col * spc;
      for (let i = 0; i < spc; i++) {
         const idx = base + i;
         if (idx >= allStops.length) break;

         const stopEl = document.createElement('div');
         stopEl.className = 'stop';
         stopEl.dataset.stopIndex = idx;
         stopEl.textContent = ' ' + (allStops[idx].name || `Зупинка ${idx + 1}`);
         colEl.appendChild(stopEl);
      }
      routeContainer.appendChild(colEl);
   }
}

// ==== ОПРЕДЕЛЕНИЕ АКТИВНОЙ ОСТАНОВКИ ====
// active = машина НА остановке (status === 'current')
// fallback = последняя пройденная, или 0
function calcActiveStopIndex() {
   let idx = allStops.findIndex(s => s.status === 'current');
   if (idx < 0) {
      const lastPassed = allStops.map((s, i) => s.status === 'passed' ? i : -1).filter(i => i >= 0);
      idx = lastPassed.length > 0 ? lastPassed[lastPassed.length - 1] : 0;
   }
   return idx;
}

// ==== ПОКАЗЫВАЕМ ТОЛЬКО НУЖНЫЕ КОЛОНКИ ====
function updateVisibleWindow(activeStopIndex) {
   const visibleColumns = getVisibleColumns();
   const colsCount = Math.ceil(allStops.length / getStopsPerColumn());
   const activeCol = Math.floor(activeStopIndex / getStopsPerColumn());

   let showFrom = activeCol - Math.floor(visibleColumns / 2);
   showFrom = Math.max(0, Math.min(showFrom, colsCount - visibleColumns));
   const showTo = showFrom + visibleColumns - 1;

   const columns = routeContainer.children;
   for (let col = 0; col < columns.length; col++) {
      columns[col].style.display = (col >= showFrom && col <= showTo) ? '' : 'none';
   }

   // Кількість треків = кількості видимих колонок — займаємо весь простір
   const numVisible = Math.max(1, Math.min(showTo, colsCount - 1) - showFrom + 1);
   routeContainer.style.gridTemplateColumns = `repeat(${numVisible}, 1fr)`;

   return { showFrom, showTo };
}


// ==== ОБНОВЛЕНИЕ СОСТОЯНИЙ ОСТАНОВОК ====
function updateStopStates(activeIndex) {
   document.querySelectorAll('.stop').forEach(stop => {
      const idx = +stop.dataset.stopIndex;
      const s = allStops[idx];
      if (!s) return;
      // active = машина НА остановке (status === 'current')
      // past   = остановка пройдена  (status === 'passed')
      // иначе  = будущая остановка
      const cls = s.status === 'current' ? 'active'
         : s.status === 'passed' ? 'past'
            : '';
      stop.className = `stop ${cls}`;
   });
}


// ==== ОБНОВЛЕНИЕ ЛИНИЙ ПРОГРЕССА ====
// Линия заполняется до центра каждого кружка остановки,
// используя реальные позиции DOM-элементов.
// На стыке колонок: если вся колонка пройдена — линия идёт до низа,
// чтобы визуально перетекать в следующую колонку.
function updateFillLines(showFrom, showTo, activeStopIndex, curPoint) {
   const columns = Array.from(document.querySelectorAll('.column'));
   const spc = getStopsPerColumn();

   for (let c = showFrom; c <= showTo; c++) {
      const colEl = columns[c];
      if (!colEl) continue;
      const fillEl = colEl.querySelector('.fillLine');
      if (!fillEl) continue;

      const stopEls = Array.from(colEl.querySelectorAll('.stop'));
      if (stopEls.length === 0) { fillEl.style.height = '0'; continue; }

      const colRect = colEl.getBoundingClientRect();
      const colStart = c * spc;
      const colEnd = colStart + stopEls.length - 1;

      // Шукаємо ціль для заливки: останню passed або current зупинку у колонці.
      let targetLocalIdx = -1;
      let hasActive = false;
      let allInColPassed = true;
      for (let i = 0; i < stopEls.length; i++) {
         const s = allStops[colStart + i];
         if (!s) { allInColPassed = false; break; }
         if (s.status === 'current') {
            targetLocalIdx = colStart + i;
            hasActive = true;
            allInColPassed = false;
            break;
         }
         if (s.status === 'passed') {
            targetLocalIdx = colStart + i;
         } else {
            allInColPassed = false;
            break;
         }
      }
      if (targetLocalIdx < 0) { fillEl.style.height = '0'; continue; }

      // Якщо вся колонка пройдена і далі теж є прогрес — заливаємо повністю.
      const nextStop = allStops[colEnd + 1];
      if (allInColPassed && nextStop && (nextStop.status === 'passed' || nextStop.status === 'current')) {
         fillEl.style.height = '100%';
         continue;
      }

      const targetEl = colEl.querySelector(`.stop[data-stop-index="${targetLocalIdx}"]`);
      const targetRect = targetEl.getBoundingClientRect();
      const targetY = targetRect.top + targetRect.height / 2 - colRect.top;

      // Інтерполяція між target і наступною зупинкою (у тій самій або наступній колонці).
      let extraPx = 0;
      if (!hasActive && targetLocalIdx + 1 < allStops.length) {
         const nextElInCol = colEl.querySelector(`.stop[data-stop-index="${targetLocalIdx + 1}"]`);
         let gap;
         if (nextElInCol) {
            const r = nextElInCol.getBoundingClientRect();
            gap = (r.top + r.height / 2 - colRect.top) - targetY;
         } else {
            gap = colRect.height - targetY;
         }
         const i1 = findListIndexByStop(allStops[targetLocalIdx]);
         const i2 = findListIndexByStop(allStops[targetLocalIdx + 1]);
         if (i1 !== -1 && i2 !== -1 && i2 > i1) {
            const frac = Math.max(0, Math.min(1, (curPoint - i1) / (i2 - i1)));
            extraPx = gap * frac;
         }
      }

      fillEl.style.height = (targetY + extraPx) + 'px';
   }
}

function escapeHtml(s) {
   return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function findListIndexByStop(stop) {
   if (!stop) return -1;
   const key = stop.idx ?? stop.name;
   if (key == null) return -1;
   return stopToListIndex.get(key) ?? -1;
}

// ==== ЛОГИ ОСТАНОВОК ====
// «Майбутні» — зупинки з колонок праворуч від видимого вікна (не показані на сітці маршруту).
function updateLog(showTo) {
   const visEnd = Math.min(allStops.length, (showTo + 1) * getStopsPerColumn());

   const rightHidden = allStops.slice(visEnd);

   const futureHidden = rightHidden.map(s => s.name || '—');

   if (!futureHidden.length) {
      if (logContainerEl) logContainerEl.style.display = 'none';
      logFutureEl.innerHTML = '';
      return;
   }
   if (logContainerEl) logContainerEl.style.removeProperty('display');
   logFutureEl.innerHTML = futureHidden.map(n => `<div class="log-item">${escapeHtml(n)}</div>`).join('');
}
function isContentOverflowing(log) {
   const logRect = log.getBoundingClientRect();
   const children = Array.from(log.children);

   return children.some(child => {
      const rect = child.getBoundingClientRect();
      return rect.right > logRect.right; // вылезает ли вправо
   });
}

function isOverflowingX(el) {
   return el.scrollWidth > el.clientWidth + 0.5; // +0.5 чтобы игнорировать дробные погрешности
}

// Запуск анимации: pxPerSecond — скорость в пикселях/сек
function startPingPongScroll(element, pxPerSecond = 30) {
   element.style.scrollBehavior = "auto";
   if (element._pp && element._pp.running) return;

   element._pp = {
      running: true,
      rafId: null,
      direction: (element.scrollLeft <= 0) ? 1 : -1,
      lastTime: performance.now(),
      pxPerSecond,
      pauseUntil: 0 // <-- добавили
   };

   function step(now) {
      if (!element._pp || !element._pp.running) return;

      // если сейчас пауза — просто ждём
      if (element._pp.pauseUntil > now) {
         element._pp.rafId = requestAnimationFrame(step);
         return;
      }

      const maxScroll = Math.max(0, element.scrollWidth - element.clientWidth);
      if (maxScroll <= 0.5) { stopPingPongScroll(element); return; }

      const dt = Math.min(100, now - element._pp.lastTime);
      const delta = (element._pp.pxPerSecond * dt) / 1000;
      let next = element.scrollLeft + element._pp.direction * delta;

      if (next >= maxScroll) {
         next = maxScroll;
         element.scrollLeft = next;
         element._pp.direction = -1;

         // *** ПАУЗА 5 секунд ***
         element._pp.pauseUntil = now + 5000;

         element._pp.lastTime = now;
         element._pp.rafId = requestAnimationFrame(step);
         return;
      }

      if (next <= 0) {
         next = 0;
         element.scrollLeft = next;
         element._pp.direction = 1;

         // *** ПАУЗА 5 секунд ***
         element._pp.pauseUntil = now + 5000;

         element._pp.lastTime = now;
         element._pp.rafId = requestAnimationFrame(step);
         return;
      }

      element.scrollLeft = next;
      element._pp.lastTime = now;
      element._pp.rafId = requestAnimationFrame(step);
   }

   element._pp.lastTime = performance.now();
   element._pp.rafId = requestAnimationFrame(step);
}


// Остановка анимации
function stopPingPongScroll(element) {
   if (!element._pp) return;
   if (element._pp.rafId) cancelAnimationFrame(element._pp.rafId);
   element._pp.running = false;
   element._pp.rafId = null;
   // (не удаляем элемент._pp полностью — можно перезапустить)
}

// Авто-менеджер: следит за изменениями и старт/стопит анимацию
function attachAutoPingPong(element, pxPerSecond = 30) {
   // наблюдатель за DOM (добавление/удаление/текст)
   const mo = new MutationObserver(() => check());
   mo.observe(element, { childList: true, subtree: true, characterData: true });

   // наблюдатель за размером контейнера или содержимого
   const ro = new ResizeObserver(() => check());
   ro.observe(element);
   // также наблюдаем за первым прямым потомком (часто содержимое резайзится)
   if (element.firstElementChild) ro.observe(element.firstElementChild);

   function check() {
      if (isOverflowingX(element)) {
         startPingPongScroll(element, pxPerSecond);
      } else {
         stopPingPongScroll(element);
      }
   }

   // начальная проверка
   check();

   // возвращаем функцию для отключения наблюдателей (если нужно)
   return () => {
      mo.disconnect();
      ro.disconnect();
      stopPingPongScroll(element);
   };
}

// ==== Aditional Info ====
function updateClock() {
   const now = new Date();
   const hours = String(now.getHours()).padStart(2, '0');
   const minutes = String(now.getMinutes()).padStart(2, '0');
   document.getElementById('TimeNow').textContent = `${hours}:${minutes}`;
}

updateClock(); // показать сразу

// ==== Weather ====

const weatherDescription = {
   0: "http://138.201.226.159:8082/assets/images/sun.svg",
   1: "http://138.201.226.159:8082/assets/images/cloud+sun.svg",
   2: "http://138.201.226.159:8082/assets/images/cloud+sun.svg",
   3: "http://138.201.226.159:8082/assets/images/cloud.svg",
   45: "http://138.201.226.159:8082/assets/images/wind.svg",
   48: "http://138.201.226.159:8082/assets/images/wind.svg",
   51: "http://138.201.226.159:8082/assets/images/drizzle.png",
   53: "http://138.201.226.159:8082/assets/images/drizzle.png",
   55: "http://138.201.226.159:8082/assets/images/drizzle.png",
   61: "http://138.201.226.159:8082/assets/images/drizzle.png",
   63: "http://138.201.226.159:8082/assets/images/LitleSnow.png",
   65: "http://138.201.226.159:8082/assets/images/LitleSnow.png",
   71: "http://138.201.226.159:8082/assets/images/LitleSnow.png",
   73: "http://138.201.226.159:8082/assets/images/snowy.png",
   75: "http://138.201.226.159:8082/assets/images/snowy.png",
   95: "http://138.201.226.159:8082/assets/images/storm.png",
   96: "http://138.201.226.159:8082/assets/images/storm.png",
   99: "http://138.201.226.159:8082/assets/images/hardStorm.png"
};

// Функція отримання погоди
async function getWeather(lat, lon) {
   const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;
   const response = await fetch(url);
   const data = await response.json();
   if (!data || !data.current_weather) return false;
   return data.current_weather;
}

async function showWeather() {
   try {
      const weather = await getWeather(latNow, lonNow);
      const desc = weather ? weatherDescription[weather.weathercode] : false;

      const weatherCode = desc
         ? `<div class="imagesAndText"><img src="${desc}"> ${weather.temperature}°C</div>`
         : '';

      document.getElementById('weather').innerHTML = weatherCode;

   } catch (err) {
      document.getElementById('weather').textContent = '';
      console.error(err);
   }
}

function updateNextStop() {
   const el = document.getElementById('nextStop');
   if (!el) return;
   const nextIdx = activeStopIndex + 1;
   if (nextIdx < allStops.length) {
      const name = escapeHtml(allStops[nextIdx].name || '—');
      el.innerHTML = `<span class="nextStop-label">Наступна зупинка: </span>${name}`;
   } else {
      el.innerHTML = '';
   }
}


/* ====================================================================
 *  AD SUBSYSTEM
 *  ─ AdCache      — Cache Storage + localStorage реєстр + LRU
 *  ─ AdScheduler  — manifest sync + лічильники display_per_event
 *  ─ AdPlayer     — state machine відтворення з blob URL
 * ==================================================================== */

function isImageUrl(url) {
   if (!url) return false;
   const u = url.toLowerCase();
   return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].some(ext => u.includes(ext));
}

/* ─── AdCache ─── */
const AdCache = (() => {
   /** meta: { [adId]: { fileName, createdAt, size, mime, status, error, lastUsed } } */
   let meta = loadMeta();

   function loadMeta() {
      try { return JSON.parse(localStorage.getItem(AD_CACHE_META_KEY)) || {}; }
      catch { return {}; }
   }
   function saveMeta() {
      try { localStorage.setItem(AD_CACHE_META_KEY, JSON.stringify(meta)); }
      catch (e) { console.log('AdCache: saveMeta failed', e); }
   }

   async function openCache() { return await caches.open(AD_CACHE_NAME); }

   function cacheUrl(ad) {
      // Унікальний ключ кешу включає createdAt — при оновленні файла кеш «протухає».
      // toAbsoluteMediaUrl нормалізує '/videos/...' до повного URL,
      // інакше при HTML через file:// шлях резолвиться у file:///D:/videos/...
      return toAbsoluteMediaUrl(ad.url) + '?v=' + encodeURIComponent(ad.createdAt || '');
   }

   async function getEstimate() {
      try {
         if (navigator.storage && navigator.storage.estimate) {
            return await navigator.storage.estimate();
         }
      } catch { }
      return { quota: AD_CACHE_SOFT_CAP_BYTES, usage: 0 };
   }

   async function freeSpaceFor(needBytes, keepIds) {
      const est = await getEstimate();
      const cap = Math.min(AD_CACHE_SOFT_CAP_BYTES, (est.quota || AD_CACHE_SOFT_CAP_BYTES) - AD_CACHE_RESERVE_BYTES);
      let used = est.usage || 0;
      if (used + needBytes <= cap) return true;

      const keep = new Set(keepIds);
      const candidates = Object.entries(meta)
         .filter(([id]) => !keep.has(+id))
         .sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));

      const cache = await openCache();
      for (const [id, info] of candidates) {
         if (used + needBytes <= cap) break;
         try {
            const ad = { url: '/videos/' + encodeURIComponent(info.fileName), createdAt: info.createdAt };
            await cache.delete(cacheUrl(ad));
         } catch { }
         used -= info.size || 0;
         delete meta[id];
      }
      saveMeta();
      return used + needBytes <= cap;
   }

   /** Перевіряємо, що файл реально програється/декодується. */
   function probePlayability(blobUrl, mime) {
      return new Promise(resolve => {
         const isImg = mime.startsWith('image/');
         const el = isImg ? new Image() : document.createElement('video');
         const timer = setTimeout(() => { cleanup(); resolve({ ok: false, error: 'probe-timeout' }); }, 10000);
         function cleanup() {
            clearTimeout(timer);
            if (isImg) { el.onload = el.onerror = null; }
            else { el.onloadedmetadata = el.onerror = null; el.src = ''; el.removeAttribute('src'); }
         }
         if (isImg) {
            el.onload = () => { cleanup(); resolve({ ok: true }); };
            el.onerror = () => { cleanup(); resolve({ ok: false, error: 'decode-failed' }); };
            el.src = blobUrl;
         } else {
            el.preload = 'metadata';
            el.muted = true;
            el.onloadedmetadata = () => { cleanup(); resolve({ ok: true }); };
            el.onerror = () => { cleanup(); resolve({ ok: false, error: 'decode-failed' }); };
            el.src = blobUrl;
         }
      });
   }

   async function downloadAndStore(ad) {
      const cache = await openCache();
      const key = cacheUrl(ad);
      const fetchUrl = toAbsoluteMediaUrl(ad.url);
      try {
         const resp = await fetch(fetchUrl, { cache: 'no-store' });
         if (!resp.ok) throw new Error('http ' + resp.status);
         const blob = await resp.blob();
         const size = blob.size;
         const mime = blob.type || (isImageUrl(ad.url) ? 'image/jpeg' : 'video/mp4');

         const enough = await freeSpaceFor(size, [ad.id]);
         if (!enough) {
            return { id: ad.id, status: 'failed', error: 'no-space', size, mime };
         }

         await cache.put(key, new Response(blob, { headers: { 'Content-Type': mime, 'Content-Length': String(size) } }));

         // Probe з тимчасового blob URL
         const blobUrl = URL.createObjectURL(blob);
         const probe = await probePlayability(blobUrl, mime);
         URL.revokeObjectURL(blobUrl);

         if (!probe.ok) {
            await cache.delete(key);
            return { id: ad.id, status: 'failed', error: probe.error, size, mime };
         }
         return { id: ad.id, status: 'ready', size, mime };
      } catch (e) {
         return { id: ad.id, status: 'failed', error: 'network', mime: '' };
      }
   }

   /** Синхронізує кеш з manifest: качає нове, видаляє зайве. */
   async function sync(ads) {
      if (!('caches' in window)) {
         console.log('AdCache: Cache Storage недоступний');
         return;
      }
      const wantedIds = new Set(ads.map(a => a.id));
      const cache = await openCache();

      // 1. Видаляємо все, що не в manifest або застаріло (інший createdAt)
      for (const idStr of Object.keys(meta)) {
         const id = +idStr;
         const info = meta[idStr];
         const stillWanted = ads.find(a => a.id === id && a.createdAt === info.createdAt);
         if (!stillWanted) {
            try {
               const oldAd = { url: '/videos/' + encodeURIComponent(info.fileName), createdAt: info.createdAt };
               await cache.delete(cacheUrl(oldAd));
            } catch { }
            delete meta[idStr];
         }
      }
      saveMeta();

      // 2. Качаємо ті, яких немає або змінився createdAt
      for (const ad of ads) {
         const existing = meta[ad.id];
         if (existing && existing.createdAt === ad.createdAt && existing.status === 'ready') {
            // Перевіряємо, що в Cache Storage реально лежить
            const hit = await cache.match(cacheUrl(ad));
            if (hit) continue;
         }
         const result = await downloadAndStore(ad);
         meta[ad.id] = {
            fileName: ad.fileName,
            createdAt: ad.createdAt,
            size: result.size || 0,
            mime: result.mime || '',
            status: result.status,
            error: result.error || null,
            lastUsed: Date.now()
         };
         saveMeta();
         if (result.status === 'failed') {
            console.log(`AdCache: ${ad.fileName} → failed (${result.error})`);
         }
      }
   }

   /** Повертає {blobUrl, mime} або null, якщо не готово. */
   async function get(adId) {
      const info = meta[adId];
      if (!info || info.status !== 'ready') return null;
      try {
         const cache = await openCache();
         const ad = { url: '/videos/' + encodeURIComponent(info.fileName), createdAt: info.createdAt };
         const resp = await cache.match(cacheUrl(ad));
         if (!resp) {
            // Зник з кешу — перепомітити
            info.status = 'failed';
            info.error = 'missing';
            saveMeta();
            return null;
         }
         const blob = await resp.blob();
         info.lastUsed = Date.now();
         saveMeta();
         return { blobUrl: URL.createObjectURL(blob), mime: info.mime || blob.type };
      } catch (e) {
         return null;
      }
   }

   function isReady(adId) {
      const info = meta[adId];
      return !!(info && info.status === 'ready');
   }

   return { sync, get, isReady };
})();

/* ─── AdScheduler: лічильник display_per_event ─── */
const AdScheduler = (() => {
   /** Map<eventKey, playedCount>; eventKey = `${adId}@${eventStart}` */
   const playCounts = new Map();
   let lastManifestVersion = null;
   let lastManifestAt = 0;

   async function fetchManifest() {
      try {
         const r = await fetch('http://138.201.226.159:8082/api/player.php?action=manifest&imei=' + imei + '&debug=1', { cache: 'no-store' });
         return await r.json();
      } catch (e) { return null; }
   }

   async function fetchNow() {
      try {
         const r = await fetch('http://138.201.226.159:8082/api/player.php?action=now&imei=' + imei + '&debug=1', { cache: 'no-store' });
         return await r.json();
      } catch (e) { return { play: false }; }
   }

   async function ack(payload) {
      try {
         await fetch('http://138.201.226.159:8082/api/player.php?action=ack&imei=' + imei + '&debug=1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            cache: 'no-store'
         });
      } catch (e) { /* лог-only, не критично */ }
   }

   async function maybeRefreshManifest() {
      const now = Date.now();
      if (now - lastManifestAt < AD_MANIFEST_REFRESH_MS && lastManifestVersion) return;
      lastManifestAt = now;
      const m = await fetchManifest();
      if (!m || !Array.isArray(m.ads)) return;
      if (m.version === lastManifestVersion) return;
      lastManifestVersion = m.version;
      console.log('AdScheduler: manifest updated, ads=', m.ads.length);
      await AdCache.sync(m.ads);
   }

   /** Чи можна показати: лічильник < perEvent і файл готовий у кеші. */
   function canPlay(adData) {
      if (!adData || !adData.play || !adData.adId) return false;
      if (!AdCache.isReady(adData.adId)) return false;
      const key = adData.adId + '@' + adData.eventStart;
      const played = playCounts.get(key) || 0;
      return played < (adData.perEvent || 1);
   }

   function markPlayed(adData) {
      const key = adData.adId + '@' + adData.eventStart;
      playCounts.set(key, (playCounts.get(key) || 0) + 1);
      // Прибираємо старі ключі (>1 год), щоб Map не ріс нескінченно.
      const cutoff = Math.floor(Date.now() / 1000) - 3600;
      for (const k of playCounts.keys()) {
         const ts = +k.split('@')[1];
         if (Number.isFinite(ts) && ts < cutoff) playCounts.delete(k);
      }
   }

   return { maybeRefreshManifest, fetchNow, ack, canPlay, markPlayed };
})();

/* ─── AdPlayer: state machine відтворення ─── */
const AdPlayer = (() => {
   let state = 'idle'; // 'idle' | 'playing'
   let current = null; // { adData, blobUrl, mime, startedAt, maxTimer }

   function showContainer(show) {
      adContainer.style.display = show ? 'block' : 'none';
      routeContainer.style.display = show ? 'none' : 'grid';
      logElem.style.display = show ? 'none' : 'flex';
      const ai = document.getElementById('AdditionalInfo');
      if (ai) ai.style.display = show ? 'none' : 'flex';
      if (adLoadingIndicator) adLoadingIndicator.style.display = 'none';
   }

   function clearMedia() {
      adImage.onload = adImage.onerror = null;
      adVideo.onloadedmetadata = adVideo.oncanplay = adVideo.onerror = adVideo.onended = null;
      try { adVideo.pause(); } catch { }
      adVideo.removeAttribute('src');
      try { adVideo.load(); } catch { }
      adVideo.style.display = 'none';
      adImage.removeAttribute('src');
      adImage.style.display = 'none';
   }

   function finish(status, error) {
      if (state !== 'playing' || !current) return;
      const finished = current;
      state = 'idle';
      current = null;

      if (finished.maxTimer) clearTimeout(finished.maxTimer);
      clearMedia();
      if (finished.blobUrl) URL.revokeObjectURL(finished.blobUrl);
      showContainer(false);

      AdScheduler.ack({
         advert_id: finished.adData.adId,
         route_id: finished.adData.routeId || null,
         event_start: finished.adData.eventStart || null,
         status,
         error: error || null
      });
   }

   async function play(adData) {
      if (state !== 'idle') return false;

      const cached = await AdCache.get(adData.adId);
      if (!cached) return false;

      state = 'playing';
      current = { adData, blobUrl: cached.blobUrl, mime: cached.mime, startedAt: Date.now(), maxTimer: null };
      AdScheduler.markPlayed(adData);
      showContainer(true);

      const isImage = (cached.mime || '').startsWith('image/') || isImageUrl(adData.url || adData.fileName || '');

      if (isImage) {
         adImage.style.display = 'block';
         adVideo.style.display = 'none';
         adImage.onload = () => {
            // Картинка показується perEvent-разів означає 1 показ ~ X секунд?
            // За домовленістю: одне «програвання» картинки = ціле вікно 3 хв НЕ потрібне.
            // Показуємо protected період (наприклад 8с) і завершуємо.
            current.maxTimer = setTimeout(() => finish('played'), 8000);
         };
         adImage.onerror = () => finish('failed', 'image-load');
         adImage.src = cached.blobUrl;
      } else {
         adVideo.style.display = 'block';
         adVideo.muted = false;
         adVideo.volume = 1;
         adVideo.playsInline = true;
         adVideo.preload = 'auto';
         adVideo.loop = false;
         adVideo.onended = () => finish('played');
         adVideo.onerror = () => finish('failed', 'video-error');
         adVideo.oncanplay = () => { adVideo.play().catch(err => console.warn('AdPlayer: video play failed', err)); };
         adVideo.src = cached.blobUrl;
         current.maxTimer = setTimeout(() => finish('failed', 'max-duration'), AD_MAX_VIDEO_DURATION_MS);
      }
      return true;
   }

   function isPlaying() { return state === 'playing'; }
   function currentAdId() { return current ? current.adData.adId : null; }

   return { play, isPlaying, currentAdId, finish };
})();

/* ====================================================================
 *  ALERT NOTIFIER
 *  Сповіщення про тривогу: червоний банер знизу + іконка зверху-ліворуч
 *  + дві аудіо-доріжки по черзі. Пріоритет вищий за рекламу.
 *  Одне сповіщення показується не частіше ніж раз на 5 хв.
 * ==================================================================== */
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;   // не частіше 1 разу на 5 хв
const ALERT_DISPLAY_MS = 15 * 1000;        // тривалість показу банера

const ALERT_TYPE_MESSAGES = {
   air_raid: 'Існує загроза повітряного удару',
   artillery_shelling: 'Існує загроза артобстрілу',
   urban_fights: 'Вуличні бої',
   nuclear: 'Ядерна небезпека',
   chemical: 'Хімічна небезпека',
};

const AlertNotifier = (() => {
   let lastShownAt = 0;
   let active = false;
   let hideTimer = null;

   const bannerEl = document.getElementById('alertBanner');
   const bannerTextEl = document.getElementById('alertBannerText');
   const cornerEl = document.getElementById('alertCorner');

   const soundNotify = document.getElementById('alertSoundNotify') || new Audio('media/notification_sound.mp3');
   const soundAlert = document.getElementById('alertSoundAlert') || new Audio('media/AirSafetyAlert.mp3');
   soundNotify.preload = 'auto';
   soundAlert.preload = 'auto';

   let audioBlocked = false;
   let soundPending = false;
   const SOUND_TEST_ON_CLICK = new URLSearchParams(location.search).get('soundTest') === '1';

   function logAudioBlocked(label, err) {
      audioBlocked = true;
      console.warn(
         'AlertNotifier: ' + label + ' play blocked:',
         err && err.name,
         err && err.message,
         '\n→ Запускайте player через launch_player.bat (Chrome/Edge з --autoplay-policy=no-user-gesture-required).',
         '\n→ Або клікніть по екрану (локальна перевірка звуку).',
         '\n→ Для тесту без тривоги: додайте &soundTest=1 до URL.'
      );
   }

   function onAudioUnlocked() {
      if (soundPending) {
         soundPending = false;
         playSequence();
      } else if (SOUND_TEST_ON_CLICK) {
         console.log('AlertNotifier: soundTest — програвання тестової послідовності');
         playSequence();
      }
   }

   function unlockAudioOnGesture() {
      if (SOUND_TEST_ON_CLICK && !audioBlocked) {
         console.log('AlertNotifier: soundTest — програвання тестової послідовності');
         playSequence();
         return;
      }
      if (!audioBlocked) return;
      try {
         const probe = soundNotify.cloneNode ? soundNotify.cloneNode(true) : new Audio(soundNotify.src);
         probe.volume = 0.01;
         const p = probe.play();
         if (!p || !p.then) {
            audioBlocked = false;
            onAudioUnlocked();
            return;
         }
         p.then(() => {
            probe.pause();
            probe.currentTime = 0;
            audioBlocked = false;
            console.log('AlertNotifier: audio розблоковано кліком');
            onAudioUnlocked();
         }).catch(err => logAudioBlocked('unlock gesture', err));
      } catch (e) {
         console.warn('AlertNotifier: unlock gesture error', e);
      }
   }

   document.addEventListener('click', unlockAudioOnGesture);
   document.addEventListener('touchstart', unlockAudioOnGesture, { passive: true });

   soundNotify.addEventListener('error', () =>
      console.warn('AlertNotifier: notification_sound.mp3 load error', soundNotify.error));
   soundAlert.addEventListener('error', () =>
      console.warn('AlertNotifier: AirSafetyAlert.mp3 load error', soundAlert.error));

   // Перевірка при старті: чи дозволено автовідтворення зі звуком
   (function probeAutoplay() {
      const probe = soundNotify.cloneNode ? soundNotify.cloneNode(true) : new Audio(soundNotify.src);
      probe.volume = 0.01;
      const p = probe.play();
      if (!p || !p.then) return;
      p.then(() => {
         probe.pause();
         probe.currentTime = 0;
         audioBlocked = false;
         console.log('AlertNotifier: autoplay audio OK');
      }).catch(err => logAudioBlocked('autoplay probe', err));
   })();

   function pickAlert(alertStatus) {
      if (!Array.isArray(alertStatus) || alertStatus.length === 0) return null;
      // API повертає тривоги відсортовані admin_level DESC — беремо найдетальнішу
      return alertStatus[0];
   }

   function messageFor(alert) {
      const base = ALERT_TYPE_MESSAGES[alert.alert_type] || 'Небезпека';
      const title = alert.location_title || '';
      return title ? `${title} — ${base}.` : `${base}.`;
   }

   // notification_sound.mp3 → AirSafetyAlert.mp3 (×2)
   const ALERT_SOUND_REPEAT = 2;

   function playAlertSound(playsLeft = ALERT_SOUND_REPEAT) {
      if (typeof playsLeft !== 'number') playsLeft = ALERT_SOUND_REPEAT;
      try {
         soundAlert.pause();
         soundAlert.currentTime = 0;
         soundAlert.onended = playsLeft > 1 ? () => playAlertSound(playsLeft - 1) : null;
         const pa = soundAlert.play();
         if (pa && pa.catch) pa.catch(err => logAudioBlocked('AirSafetyAlert.mp3', err));
      } catch (e) {
         console.warn('AlertNotifier: alert sound error', e);
      }
   }

   function playSequence() {
      if (audioBlocked) {
         soundPending = true;
         console.warn('AlertNotifier: звук пропущено (autoplay заблоковано). Клікніть по екрану або launch_player.bat');
         return;
      }
      soundPending = false;
      try {
         soundNotify.pause();
         soundNotify.currentTime = 0;
         soundNotify.onended = () => playAlertSound();
         const p = soundNotify.play();
         if (p && p.catch) {
            p.catch(err => {
               logAudioBlocked('notification_sound.mp3', err);
               playAlertSound();
            });
         }
      } catch (e) {
         console.warn('AlertNotifier: playSequence error', e);
      }
   }

   function show(alert) {
      active = true;
      lastShownAt = Date.now();

      if (bannerTextEl) bannerTextEl.textContent = messageFor(alert);
      if (bannerEl) bannerEl.classList.add('show');
      if (cornerEl) cornerEl.classList.add('show');

      playSequence();

      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, ALERT_DISPLAY_MS);
   }

   function hide() {
      active = false;
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      if (bannerEl) bannerEl.classList.remove('show');
      if (cornerEl) cornerEl.classList.remove('show');
   }

   // Викликається щотіку зі свіжим alertStatus
   function evaluate(alertStatus) {
      const alert = pickAlert(alertStatus);
      if (!alert) return;
      if (active) return;
      if (Date.now() - lastShownAt < ALERT_COOLDOWN_MS) return;
      show(alert);
   }

   function isActive() { return active; }

   return { evaluate, isActive, hide };
})();

async function refreshUiFromApi() {
   const routeChanged = await updateCurPoint();
   if (routeChanged) {
      await reloadRoute();
      // після reloadRoute UI вже перемальовано — далі нічого не робимо
      return;
   }
   refreshStopStatuses();
   activeStopIndex = calcActiveStopIndex();
   const { showFrom, showTo } = updateVisibleWindow(activeStopIndex);
   updateStopStates(activeStopIndex);
   updateNextStop();
   updateLog(showTo);
   updateFillLines(showFrom, showTo, activeStopIndex, curPoint);
}

async function tickAd() {
   // Не лізем у API, поки відео реклама грає — нехай дограє.
   if (AdPlayer.isPlaying()) return;
   await AdScheduler.maybeRefreshManifest();
   const adData = await AdScheduler.fetchNow();
   if (AdScheduler.canPlay(adData)) {
      await AdPlayer.play(adData);
   }
}

async function tick() {
   try {
      if (listOfPoints.length === 0) {
         console.log("tick: маршрут пуст, пробуем загрузить...");
         await reloadRoute();
      }

      // Тривога має вищий пріоритет за рекламу
      AlertNotifier.evaluate(_lastFetchedData ? _lastFetchedData.alertStatus : null);

      // Рекламу не запускаємо, поки показується сповіщення про тривогу
      if (!AlertNotifier.isActive()) {
         await tickAd();
      }

      // Оновлюємо інтерфейс зупинок тільки якщо реклама не показується.
      if (!AdPlayer.isPlaying() && listOfPoints.length > 0) {
         await refreshUiFromApi();
      }
   } catch (e) {
      console.log("tick: ошибка", e);
   } finally {
      setTimeout(tick, refreshMs);
   }
}


async function start() {
   await reloadRoute();   // ждём загрузки маршрута
   tick();                // теперь можем запускать обновления
   showWeather();         // теперь latNow / lonNow правильные
}

const routeContainer = document.getElementById('routeContainer');
const logElem = document.getElementById("log");
const logContainerEl = document.getElementById('log_container');
const logFutureEl = document.getElementById('log-future');
const adContainer = document.getElementById('adContainer');
const adVideo = document.getElementById('adVideo');
const adImage = document.getElementById('adImage');
const adLoadingIndicator = document.getElementById('adLoadingIndicator');
const detach = attachAutoPingPong(logElem, 50); // 20 px/sec — медленно

start();

/* ---------------------------
        Полноэкранный режим
----------------------------*/
const FULLSCREEN_CHECK_MS = 5000;

function isFullscreenActive() {
   return !!(document.fullscreenElement
      || document.webkitFullscreenElement
      || document.mozFullScreenElement
      || document.msFullscreenElement);
}

function requestAppFullscreen() {
   const el = document.documentElement;
   const req = el.requestFullscreen
      || el.webkitRequestFullscreen
      || el.mozRequestFullScreen
      || el.msRequestFullscreen;
   if (!req) {
      return Promise.reject(new Error('Fullscreen API недоступен'));
   }
   return Promise.resolve(req.call(el));
}

function ensureFullscreen() {
   if (isFullscreenActive()) return;
   console.log('Fullscreen: не в полноэкранном режиме — пробуем включить...');
   requestAppFullscreen()
      .then(() => {
         console.log('Fullscreen: включён успешно');
      })
      .catch(err => {
         console.warn('Fullscreen: не удалось включить:', err && err.name, err && err.message);
      });
}

setInterval(ensureFullscreen, FULLSCREEN_CHECK_MS);
ensureFullscreen();

// Интервали

setInterval(function () {
   if (listOfPoints.length === 0 || !listOfPoints[curPoint]) return;
   latNow = listOfPoints[curPoint]['lat'];
   lonNow = listOfPoints[curPoint]['lng'];

   showWeather();
}, 3600000);


setInterval(updateClock, 1000);

setInterval(reloadRoute, 5 * 60 * 1000);

// Обработка offline/online событий
const noSignalOverlay = document.getElementById('noSignalOverlay');

function showNoSignal() {
   if (noSignalOverlay) {
      noSignalOverlay.classList.add('show');
   }
}

function hideNoSignal() {
   if (noSignalOverlay) {
      noSignalOverlay.classList.remove('show');
   }
}

window.addEventListener('offline', function () {
   showNoSignal();
});

window.addEventListener('online', function () {
   hideNoSignal();
   // Перезагружаем данные после восстановления интернета
   reloadRoute().then(() => {
      showWeather();
   });
});

// При зміні ширини екрана — перебудовуємо колонки (getStopsPerColumn залежить від ширини) і оновлюємо
window.addEventListener('resize', function () {
   if (listOfPoints.length === 0) return;
   initColumns();
   activeStopIndex = calcActiveStopIndex();
   const { showFrom, showTo } = updateVisibleWindow(activeStopIndex);
   updateStopStates(activeStopIndex);
   updateNextStop();
   updateLog(showTo);
   updateFillLines(showFrom, showTo, activeStopIndex, curPoint);
});

// Проверка начального состояния
if (!navigator.onLine) {
   showNoSignal();
}
