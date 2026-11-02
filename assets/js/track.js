/**
 * Track page — відтворення треку + визначення маршруту + табло
 *
 * Архітектура:
 *   1. API: /api/track.php?action=get_routes  — всі маршрути (один раз)
 *   2. API: /api/track.php?action=get_track   — GPS-точки за день
 *   3. На клієнті: snap-to-line, визначення маршруту, статуси зупинок, табло
 *
 * Логіка повторює daemon/tracker_daemon.py:
 *   - Для кожної GPS-точки знаходимо найближчий маршрут (snap-to-line)
 *   - Якщо маршрут змінився — шукаємо новий найкращий
 *   - Визначаємо progress, current stop, статуси зупинок
 *   - Відображаємо на карті та в табло (як player.js)
 */

// ═══════════════════════════════════════
// GEO UTILS — порт з GeoUtils.php / geo_utils.py
// ═══════════════════════════════════════

const GEO = (() => {
   const R = 6371000; // Earth radius, meters

   /** Haversine — відстань між двома точками (метри) */
   function haversine(lat1, lon1, lat2, lon2) {
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 +
         Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
         Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
   }

   /** Азимут від A до B (0..360) */
   function bearing(lat1, lon1, lat2, lon2) {
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const la1 = lat1 * Math.PI / 180;
      const la2 = lat2 * Math.PI / 180;
      const x = Math.sin(dLon) * Math.cos(la2);
      const y = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
      return ((Math.atan2(x, y) * 180 / Math.PI) + 360) % 360;
   }

   /** Різниця кутів (0..180) */
   function angleDiff(a, b) {
      const d = Math.abs(a - b);
      return d > 180 ? 360 - d : d;
   }

   /** Проекція точки P на відрізок AB */
   function projectOnSegment(pLat, pLon, aLat, aLon, bLat, bLon) {
      const dx = bLon - aLon;
      const dy = bLat - aLat;
      if (dx === 0 && dy === 0) {
         return { fraction: 0, distance: haversine(pLat, pLon, aLat, aLon), lat: aLat, lng: aLon };
      }
      let t = ((pLon - aLon) * dx + (pLat - aLat) * dy) / (dx * dx + dy * dy);
      t = Math.max(0, Math.min(1, t));
      const pjLat = aLat + t * dy;
      const pjLon = aLon + t * dx;
      return { fraction: t, distance: haversine(pLat, pLon, pjLat, pjLon), lat: pjLat, lng: pjLon };
   }

   /**
    * Snap-to-line: найближча точка на LINESTRING
    * coords = [[lat, lng], ...]
    * segFrom/segTo — обмеження діапазону сегментів (опціонально)
    * Повертає: { distance, segment, fraction, progress, lat, lng }
    */
   function snapToLine(lat, lon, coords, segFrom, segTo) {
      const n = coords.length;
      if (n === 0) return { distance: 1e9, segment: 0, fraction: 0, progress: 0, lat, lng: lon };
      if (n === 1) return { distance: haversine(lat, lon, coords[0][0], coords[0][1]), segment: 0, fraction: 0, progress: 0, lat: coords[0][0], lng: coords[0][1] };

      // Довжини сегментів
      const segLen = [];
      let totalLen = 0;
      for (let i = 0; i < n - 1; i++) {
         const l = haversine(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
         segLen.push(l);
         totalLen += l;
      }

      const from = (segFrom !== undefined && segFrom !== null) ? Math.max(0, segFrom) : 0;
      const to = (segTo !== undefined && segTo !== null) ? Math.min(n - 2, segTo) : n - 2;

      let minDist = 1e9, bestSeg = 0, bestFrac = 0, bestProg = 0, bestLat = coords[0][0], bestLng = coords[0][1];

      // Попередньо обчислюємо accumulated length до from
      let accToFrom = 0;
      for (let i = 0; i < from; i++) accToFrom += segLen[i];

      let acc = accToFrom;
      for (let i = from; i <= to; i++) {
         const p = projectOnSegment(lat, lon, coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
         if (p.distance < minDist) {
            minDist = p.distance;
            bestSeg = i;
            bestFrac = p.fraction;
            bestLat = p.lat;
            bestLng = p.lng;
            if (totalLen > 0) bestProg = (acc + segLen[i] * p.fraction) / totalLen;
         }
         acc += segLen[i];
      }

      return { distance: minDist, segment: bestSeg, fraction: bestFrac, progress: bestProg, lat: bestLat, lng: bestLng };
   }

   return { haversine, bearing, angleDiff, projectOnSegment, snapToLine };
})();


// ═══════════════════════════════════════
// CONSTANTS (повторюють daemon config)
// ═══════════════════════════════════════
const MAX_SNAP_DISTANCE = 150;       // метрів
const MAX_DIRECTION_DIFF = 90;       // градусів
const LAST_ROUTE_BONUS = 15;         // бонус для поточного маршруту
const REVERSE_BEARING_THRESHOLD = 120; // градусів — кут між напрямком руху і сегментом маршруту, вище якого вважаємо рух назад
const REVERSE_PROGRESS_DROP = 0.05;  // мінімальне падіння progress від максимуму для детекції реверсу
const REVERSE_FRAMES_NEEDED = 3;     // кількість послідовних "реверсних" кадрів для підтвердження
const CONFIRMED_ROUTE_BONUS = 30;    // бонус для підтвердженого маршруту (машина вже проїхала його повністю)
const ROUTE_CONFIRM_PROGRESS = 0.95; // мінімальний progress для підтвердження маршруту
const ROUTE_CONFIRM_ACCURACY = 0.90; // мінімальна частка точок в межах snap distance для підтвердження
const STOPS_PER_COLUMN = 8;          // зупинок на колонку табло
const VISIBLE_COLUMNS = 4;           // видимих колонок


// ═══════════════════════════════════════
// DOM Elements
// ═══════════════════════════════════════
const els = {
   imeiInput: document.getElementById('trackImei'),
   dateInput: document.getElementById('trackDate'),
   loadBtn: document.getElementById('trackLoadBtn'),

   map: document.getElementById('trackMap'),

   playBtn: document.getElementById('trackPlayBtn'),
   playIcon: document.getElementById('trackPlayIcon'),
   pauseIcon: document.getElementById('trackPauseIcon'),

   progressWrapper: document.getElementById('trackProgressWrapper'),
   progressFill: document.getElementById('trackProgressFill'),
   progressHandle: document.getElementById('trackProgressHandle'),
   playerStops: document.getElementById('trackPlayerStops'),

   timeStart: document.getElementById('trackPlayerTimeStart'),
   timeEnd: document.getElementById('trackPlayerTimeEnd'),

   speedBtn: document.getElementById('trackSpeedBtn'),

   displayBtn: document.getElementById('trackDisplayBtn'),
   displayPanel: document.getElementById('trackDisplayPanel'),
   displayClose: document.getElementById('trackDisplayClose'),

   mapStyleSelect: document.getElementById('trackMapStyle'),

   infoTime: document.getElementById('trackInfoTime'),
   infoSpeed: document.getElementById('trackInfoSpeed'),
   infoCoords: document.getElementById('trackInfoCoords'),

   // Табло
   displayTitle: document.getElementById('trackDisplayTitle'),
   displayTime: document.getElementById('displayTimeNow'),
   displayRoute: document.getElementById('displayRouteContainer'),
   displayLogFuture: document.getElementById('displayLogFuture'),

   // Реклама в табло
   displayAdContainer: document.getElementById('displayAdContainer'),
   displayAdVideo: document.getElementById('displayAdVideo'),
   displayAdImage: document.getElementById('displayAdImage'),
};


// ═══════════════════════════════════════
// STATE
// ═══════════════════════════════════════
let isPlaying = false;
let playSpeed = 1;
const speeds = [1, 2, 4, 8, 16, 32];
let speedIdx = 0;
let playTimer = null;

// Дані
let allRoutes = [];          // маршрути з API
let trackPoints = [];        // GPS-точки за день
let currentPointIdx = 0;     // поточний індекс в trackPoints

// Маршрут
let currentRoute = null;     // поточний визначений маршрут
let currentRouteId = null;   // id маршруту
let routeProgress = 0;       // progress (0..1) вздовж маршруту
let maxRouteProgress = 0;    // максимальний досягнутий progress на поточному маршруті
let currentSegment = 0;      // поточний сегмент маршруту (для forward-only snap)
let reverseFrames = 0;       // лічильник послідовних "реверсних" кадрів
let currentStopId = null;    // id зупинки в якій машина зараз
let routeStops = [];         // зупинки поточного маршруту

// Підтверджені маршрути — машина вже проїхала їх повністю з високою точністю
// Map: routeId → { count: N } (скільки разів підтверджено)
let confirmedRoutes = new Map();
// Лічильники точності поточної поїздки по маршруту
let routeSnapCount = 0;      // скільки точок були в межах snap distance
let routeTotalCount = 0;     // загальна кількість точок поки машина на маршруті

// Mapbox
let map = null;
let trackMarker = null;
let trackLine = null;

// Реклама для поточного IMEI (type 1 — зони, type 2 — час)
let vehicleAds = [];
let vehicleZones = {};


// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════

// Дата по замовчуванню: сьогодні
(function setDefaultDate() {
   const d = new Date();
   els.dateInput.value = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
})();


// ═══════════════════════════════════════
// MAPBOX
// ═══════════════════════════════════════
function initMap() {
   if (!window.MAPBOX_API_KEY || !window.mapboxgl) return;

   mapboxgl.accessToken = window.MAPBOX_API_KEY;

   map = new mapboxgl.Map({
      container: 'trackMap',
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [30.524, 50.450],
      zoom: 12,
   });

   map.addControl(new mapboxgl.NavigationControl(), 'top-right');

   // Вимикаємо навігацію клавіатурою на карті (стрілки використовуються для треку)
   map.keyboard.disable();

   // Зміна стилю карти
   els.mapStyleSelect.addEventListener('change', () => {
      const style = els.mapStyleSelect.value;
      map.setStyle('mapbox://styles/mapbox/' + style);

      // Після зміни стилю перемальовуємо шари
      map.once('style.load', () => {
         if (trackPoints.length > 0) {
            drawTrackOnMap();
            updateMarkerPosition();
         }
      });
   });
}

/** Малюємо лінію треку + маршруту на карті */
function drawTrackOnMap() {
   if (!map) return;

   // Видаляємо старі шари
   if (map.getLayer('track-line')) map.removeLayer('track-line');
   if (map.getSource('track-line')) map.removeSource('track-line');
   if (map.getLayer('route-line')) map.removeLayer('route-line');
   if (map.getSource('route-line')) map.removeSource('route-line');
   if (map.getLayer('stop-points')) map.removeLayer('stop-points');
   if (map.getSource('stop-points')) map.removeSource('stop-points');

   // Лінія треку (GPS-точки)
   const trackCoords = trackPoints.map(p => [p.lng, p.lat]);
   if (trackCoords.length >= 2) {
      map.addSource('track-line', {
         type: 'geojson',
         data: {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: trackCoords },
         }
      });
      map.addLayer({
         id: 'track-line',
         type: 'line',
         source: 'track-line',
         paint: {
            'line-color': '#58a6ff',
            'line-width': 3,
            'line-opacity': 0.7,
         }
      });
   }

   // Маршрут (якщо визначений)
   if (currentRoute && currentRoute.coords.length >= 2) {
      const routeCoords = currentRoute.coords.map(c => [c[1], c[0]]); // [lng, lat]
      map.addSource('route-line', {
         type: 'geojson',
         data: {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: routeCoords },
         }
      });
      map.addLayer({
         id: 'route-line',
         type: 'line',
         source: 'route-line',
         paint: {
            'line-color': '#4CAF50',
            'line-width': 4,
            'line-opacity': 0.5,
            'line-dasharray': [4, 2],
         }
      });

      // Зупинки маршруту
      const stopFeatures = currentRoute.stops.map(s => ({
         type: 'Feature',
         geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
         properties: { name: s.name, id: s.id },
      }));

      map.addSource('stop-points', {
         type: 'geojson',
         data: { type: 'FeatureCollection', features: stopFeatures },
      });
      map.addLayer({
         id: 'stop-points',
         type: 'circle',
         source: 'stop-points',
         paint: {
            'circle-radius': 6,
            'circle-color': '#4CAF50',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#fff',
         }
      });
   }

   // Вписуємо трек у видиму область
   if (trackCoords.length >= 2) {
      const bounds = trackCoords.reduce(
         (b, c) => b.extend(c),
         new mapboxgl.LngLatBounds(trackCoords[0], trackCoords[0])
      );
      map.fitBounds(bounds, { padding: 60, maxZoom: 15 });
   }
}

/** Плавно зсунути карту до поточної точки (без зміни zoom) */
function panMapToCurrentPoint() {
   if (!map || trackPoints.length === 0) return;
   const pt = trackPoints[currentPointIdx];
   if (!pt) return;

   // Перевіряємо: чи маркер видимий у поточному viewport?
   const bounds = map.getBounds();
   const lngLat = [pt.lng, pt.lat];

   // Якщо маркер поза видимою областю — зсуваємо
   if (!bounds.contains(lngLat)) {
      map.panTo(lngLat, { duration: 300 });
   }
}

/** Маркер поточної позиції */
function updateMarkerPosition() {
   if (!map || trackPoints.length === 0) return;

   const pt = trackPoints[currentPointIdx];
   if (!pt) return;

   const lngLat = [pt.lng, pt.lat];

   if (!trackMarker) {
      // Створюємо HTML-маркер
      const el = document.createElement('div');
      el.style.cssText = 'width:18px;height:18px;border-radius:50%;background:#ff4444;border:3px solid #fff;box-shadow:0 0 8px rgba(255,68,68,0.6);';
      trackMarker = new mapboxgl.Marker({ element: el })
         .setLngLat(lngLat)
         .addTo(map);
   } else {
      trackMarker.setLngLat(lngLat);
   }
}


// ═══════════════════════════════════════
// API — завантаження даних
// ═══════════════════════════════════════

/** Завантажити всі маршрути (один раз) */
async function loadRoutes() {
   try {
      const res = await fetch('/api/track.php?action=get_routes');
      const data = await res.json();
      if (data.routes) {
         allRoutes = data.routes;
         console.log(`Завантажено ${allRoutes.length} маршрутів`);
      }
   } catch (e) {
      console.error('Помилка завантаження маршрутів:', e);
   }
}

/** Завантажити трек за день */
async function loadTrack(imei, date) {
   try {
      const res = await fetch(`/api/track.php?action=get_track&imei=${encodeURIComponent(imei)}&date=${encodeURIComponent(date)}`);
      const data = await res.json();

      if (data.error) {
         alert('Помилка: ' + data.error);
         return false;
      }

      trackPoints = data.points || [];
      console.log(`Завантажено ${trackPoints.length} точок`);

      if (trackPoints.length === 0) {
         alert('За вказану дату немає даних GPS для цього IMEI.');
         return false;
      }

      return true;
   } catch (e) {
      console.error('Помилка завантаження треку:', e);
      alert('Помилка з\'єднання з сервером');
      return false;
   }
}

/** Завантажити рекламу та зони для машини (type 1, 2) */
async function loadAds(imei) {
   try {
      const res = await fetch(`/api/track.php?action=get_ads&imei=${encodeURIComponent(imei)}`, { cache: 'no-store' });
      const data = await res.json();

      if (data.error) {
         console.warn('Помилка завантаження реклами:', data.error);
         vehicleAds = [];
         vehicleZones = {};
         return;
      }

      vehicleAds = data.ads || [];
      vehicleZones = data.zones || {};
      console.log(`Завантажено ${vehicleAds.length} рекламних оголошень, ${Object.keys(vehicleZones).length} зон`);
   } catch (e) {
      console.warn('Помилка завантаження реклами:', e);
      vehicleAds = [];
      vehicleZones = {};
   }
}

// ═══════════════════════════════════════
// AD LOGIC — перевірка зон та часу (як player.php)
// ═══════════════════════════════════════

/** Чи точка (lat, lng) всередині зони */
function pointInZone(lat, lon, zone) {
   if (!zone) return false;

   if (zone.type === 'circle' && zone.radius > 0) {
      return GEO.haversine(lat, lon, zone.lat, zone.lon) <= zone.radius;
   }

   if (zone.type === 'polygon' && zone.coords && zone.coords.length >= 3) {
      return pointInPolygon([lat, lon], zone.coords);
   }

   return false;
}

/** Ray casting — точка всередині полігону */
function pointInPolygon(point, polygon) {
   const x = point[1]; // lon
   const y = point[0]; // lat
   let inside = false;
   const n = polygon.length;

   for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[i][1];
      const yi = polygon[i][0];
      const xj = polygon[j][1];
      const yj = polygon[j][0];
      const cond1 = (yi > y) !== (yj > y);
      const den = (yj - yi) || 0.0000001;
      const intersect = cond1 && (x < (xj - xi) * (y - yi) / den + xi);
      if (intersect) inside = !inside;
   }
   return inside;
}

/** Чи URL — зображення */
function isImageUrl(url) {
   if (!url) return false;
   const ext = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
   const lower = url.toLowerCase();
   return ext.some(e => lower.includes(e));
}

/**
 * Визначити активну рекламу для точки треку.
 * @param {Object} pt — { lat, lng, time }
 * @returns {{ ad, url } | null}
 */
function getActiveAdForPoint(pt) {
   if (!pt || vehicleAds.length === 0) return null;

   for (const ad of vehicleAds) {
      const params = ad.params || {};

      // TYPE 1 — зона (машина в зоні)
      if (ad.type === 1 && params.zoneId != null) {
         const zone = vehicleZones[params.zoneId];
         if (zone && pointInZone(pt.lat, pt.lng, zone)) {
            const url = '/videos/' + encodeURIComponent(ad.file);
            return { ad, url };
         }
      }

      // TYPE 2 — час (start/end)
      if (ad.type === 2 && params.start && params.end) {
         const repeat = params.repeat;
         let startTs, endTs;

         if (repeat === 'daily') {
            const startStr = params.start;
            const endStr = params.end;
            const startM = startStr.match(/(\d{1,2}):(\d{2})/);
            const endM = endStr.match(/(\d{1,2}):(\d{2})/);
            if (!startM || !endM) continue;

            const d = new Date(pt.time * 1000);
            const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
            startTs = new Date(y, m, day, parseInt(startM[1], 10), parseInt(startM[2], 10), 0).getTime() / 1000;
            endTs = new Date(y, m, day, parseInt(endM[1], 10), parseInt(endM[2], 10), 59).getTime() / 1000;
            if (endTs < startTs) endTs += 86400;
         } else {
            startTs = new Date(params.start).getTime() / 1000;
            endTs = new Date(params.end).getTime() / 1000;
            if (isNaN(startTs) || isNaN(endTs)) continue;
         }

         if (pt.time >= startTs && pt.time <= endTs) {
            const url = '/videos/' + encodeURIComponent(ad.file);
            return { ad, url };
         }
      }
   }

   return null;
}

/** Показати рекламу в табло */
function showDisplayAd(url) {
   if (!els.displayAdContainer || !els.displayRoute) return;

   els.displayRoute.style.display = 'none';
   els.displayAdContainer.style.display = 'block';

   if (isImageUrl(url)) {
      els.displayAdVideo.pause();
      els.displayAdVideo.src = '';
      els.displayAdVideo.style.display = 'none';
      els.displayAdImage.style.display = 'block';
      els.displayAdImage.src = url;
   } else {
      els.displayAdImage.src = '';
      els.displayAdImage.style.display = 'none';
      els.displayAdVideo.style.display = 'block';
      els.displayAdVideo.src = url;
      els.displayAdVideo.muted = true;
      els.displayAdVideo.loop = true;
      els.displayAdVideo.play().catch(() => {});
   }
}

/** Сховати рекламу в табло */
function hideDisplayAd() {
   if (!els.displayAdContainer || !els.displayRoute) return;

   els.displayAdContainer.style.display = 'none';
   els.displayRoute.style.display = '';
   els.displayAdVideo.pause();
   els.displayAdVideo.src = '';
   els.displayAdImage.src = '';
}


// ═══════════════════════════════════════
// ROUTE MATCHING — логіка визначення маршруту
// Повторює TrackerDaemon._auto_create_session
// ═══════════════════════════════════════

/**
 * Перевірити чи поточний маршрут був завершений з високою точністю.
 * Якщо так — додати його до підтверджених маршрутів.
 * Викликається перед зміною маршруту.
 */
function checkRouteCompletion() {
   if (!currentRoute || !currentRouteId) return;
   if (routeTotalCount < 5) return; // надто мало точок

   const accuracy = routeSnapCount / routeTotalCount;

   if (maxRouteProgress >= ROUTE_CONFIRM_PROGRESS && accuracy >= ROUTE_CONFIRM_ACCURACY) {
      const existing = confirmedRoutes.get(currentRouteId);
      const count = existing ? existing.count + 1 : 1;
      confirmedRoutes.set(currentRouteId, { count });
      console.log(`★ Маршрут "${currentRoute.name}" (id=${currentRouteId}) ПІДТВЕРДЖЕНО! ` +
         `progress=${(maxRouteProgress * 100).toFixed(1)}%, accuracy=${(accuracy * 100).toFixed(1)}%, ` +
         `points=${routeSnapCount}/${routeTotalCount}, confirmations=${count}, ` +
         `всього підтверджених: ${confirmedRoutes.size}`);
   }
}

/**
 * Знайти найкращий маршрут для точки.
 * @param {number} lat
 * @param {number} lng
 * @param {number} direction — напрямок руху (0..360)
 * @param {number|null} lastRouteId — id попереднього маршруту (бонус)
 * @param {number|null} excludeRouteId — id маршруту який виключити з пошуку (при реверсі)
 * @returns {{ route, snap, score } | null}
 */
function findBestRoute(lat, lng, direction, lastRouteId, excludeRouteId) {
   let best = null;
   let bestScore = MAX_SNAP_DISTANCE;

   for (const route of allRoutes) {
      // Пропускаємо виключений маршрут (реверс)
      if (excludeRouteId !== null && excludeRouteId !== undefined && route.id === excludeRouteId) continue;

      const coords = route.coords;
      if (!coords || coords.length < 2) continue;

      const snap = GEO.snapToLine(lat, lng, coords);
      if (snap.distance > MAX_SNAP_DISTANCE) continue;

      let score = snap.distance;

      // Перевірка напрямку
      const seg = snap.segment;
      if (seg < coords.length - 1) {
         const segBearing = GEO.bearing(coords[seg][0], coords[seg][1], coords[seg + 1][0], coords[seg + 1][1]);
         const dirDiff = GEO.angleDiff(direction, segBearing);
         if (dirDiff > MAX_DIRECTION_DIFF) {
            score += 50; // штраф за неправильний напрямок
         }
      }

      // Бонус для останнього маршруту
      if (lastRouteId !== null && lastRouteId !== undefined && route.id === lastRouteId) {
         score -= LAST_ROUTE_BONUS;
         score = Math.max(score, 0);
      }

      // Бонус для підтверджених маршрутів (машина вже проїхала їх повністю)
      if (confirmedRoutes.has(route.id)) {
         score -= CONFIRMED_ROUTE_BONUS;
         score = Math.max(score, 0);
      }

      if (score < bestScore) {
         bestScore = score;
         best = { route, snap, score };
      }
   }

   return best;
}

/**
 * Визначити статуси зупинок маршруту для заданого progress та позиції.
 * Повертає масив зупинок з полем status: 'passed' | 'current' | 'upcoming'
 */
function computeStopStatuses(route, vehicleLat, vehicleLng, vehicleProgress) {
   if (!route || !route.stops) return [];

   return route.stops.map(stop => {
      const distToVehicle = GEO.haversine(vehicleLat, vehicleLng, stop.lat, stop.lng);
      let status;

      if (distToVehicle <= stop.radius) {
         status = 'current';
      } else if (stop.progress <= vehicleProgress && vehicleProgress > 0.001) {
         status = 'passed';
      } else {
         status = 'upcoming';
      }

      return { ...stop, status };
   });
}


// ═══════════════════════════════════════
// PLAYBACK ENGINE — рух по точках
// ═══════════════════════════════════════

/**
 * Обробити поточну точку:
 * - snap до маршруту
 * - визначити зміну маршруту
 * - обчислити статуси зупинок
 * - оновити UI
 */
function processCurrentPoint() {
   if (trackPoints.length === 0) return;

   const pt = trackPoints[currentPointIdx];
   if (!pt) return;

   // ── Оновити інфо-бар ──
   updateInfoBar(pt);

   // ── Оновити маркер на карті ──
   updateMarkerPosition();

   // ── Snap до поточного маршруту ──
   // Використовуємо forward-only snap: шукаємо від (currentSegment - невелике вікно)
   // до кінця маршруту. Це запобігає "перестрибуванню" на ранній сегмент,
   // коли маршрут проходить по тій же дорозі двічі (петля / кільце).
   let snap = null;
   if (currentRoute && currentRoute.coords.length >= 2) {
      const LOOKBACK_SEGMENTS = 3; // дозволяємо трохи назад (GPS шум)
      const segFrom = Math.max(0, currentSegment - LOOKBACK_SEGMENTS);
      snap = GEO.snapToLine(pt.lat, pt.lng, currentRoute.coords, segFrom);
   }

   // Перевірка чи потрібно змінити маршрут
   let needNewRoute = false;
   let excludeCurrentRoute = false; // якщо реверс — виключаємо поточний маршрут з пошуку

   if (!currentRoute) {
      needNewRoute = true;
   } else if (snap && snap.distance > MAX_SNAP_DISTANCE) {
      // Машина далеко від поточного маршруту
      needNewRoute = true;
   } else if (snap && currentRoute) {
      // ── Детекція руху у зворотному напрямку ──
      // Перевіряємо два сигнали:
      //   A) Кут між напрямком руху і напрямком сегменту > порогу
      //   B) Progress впав відносно максимального досягнутого
      // Обидва разом — надійна детекція. Але навіть одне лише значне
      // падіння progress (без bearing) — теж детектуємо як реверс.

      let isReverseFrame = false;

      // A) Перевірка bearing (якщо є direction у GPS-точці)
      const hasDirection = pt.dir !== undefined && pt.dir !== null && pt.speed > 2;
      const seg = snap.segment;
      let dirDiff = 0;

      if (hasDirection && seg < currentRoute.coords.length - 1) {
         const segBearing = GEO.bearing(
            currentRoute.coords[seg][0], currentRoute.coords[seg][1],
            currentRoute.coords[seg + 1][0], currentRoute.coords[seg + 1][1]
         );
         dirDiff = GEO.angleDiff(pt.dir, segBearing);
      }

      // B) Перевірка падіння progress відносно максимуму
      const progressDrop = maxRouteProgress - snap.progress;

      // Сигнал реверсу: bearing протилежний + progress падає
      if (hasDirection && dirDiff > REVERSE_BEARING_THRESHOLD && progressDrop > 0.005) {
         isReverseFrame = true;
      }

      // Або: значне падіння progress від максимуму (навіть без bearing)
      if (maxRouteProgress > 0.02 && progressDrop > REVERSE_PROGRESS_DROP) {
         isReverseFrame = true;
      }

      if (isReverseFrame) {
         reverseFrames++;
         if (reverseFrames >= REVERSE_FRAMES_NEEDED) {
            console.log(`⚠ Реверс на маршруті "${currentRoute.name}": bearing diff=${dirDiff.toFixed(0)}°, maxProgress=${maxRouteProgress.toFixed(3)} → current=${snap.progress.toFixed(3)}, drop=${progressDrop.toFixed(3)}, frames=${reverseFrames}`);
            needNewRoute = true;
            excludeCurrentRoute = true;
         }
      } else {
         // Скидаємо лічильник — рух нормальний
         reverseFrames = 0;
      }
   }

   if (needNewRoute) {
      // ── Перед зміною маршруту: перевіряємо чи попередній маршрут завершено ──
      checkRouteCompletion();

      const result = findBestRoute(pt.lat, pt.lng, pt.dir, excludeCurrentRoute ? null : currentRouteId, excludeCurrentRoute ? currentRouteId : null);
      if (result) {
         currentRoute = result.route;
         currentRouteId = result.route.id;
         snap = result.snap;
         // Скидаємо progress-трекінг для нового маршруту
         routeProgress = snap.progress;
         maxRouteProgress = snap.progress;
         currentSegment = snap.segment;
         reverseFrames = 0;
         routeSnapCount = 0;
         routeTotalCount = 0;
         console.log(`Маршрут змінено → ${result.route.name} (id=${result.route.id}, dist=${result.snap.distance.toFixed(0)}м, progress=${snap.progress.toFixed(3)})` +
            (confirmedRoutes.has(result.route.id) ? ' ★ підтверджений' : ''));

         // Назва маршруту в табло
         if (els.displayTitle) {
            els.displayTitle.textContent = 'Табло — ' + (result.route.name || 'маршрут');
         }

         // Перемальовуємо карту з новим маршрутом
         if (map && map.isStyleLoaded()) {
            drawTrackOnMap();
         }
      } else {
         // Не знайдено маршрут — машина поза маршрутами
         currentRoute = null;
         currentRouteId = null;
         snap = null;
         routeProgress = 0;
         maxRouteProgress = 0;
         currentSegment = 0;
         reverseFrames = 0;
         routeSnapCount = 0;
         routeTotalCount = 0;
         if (els.displayTitle) {
            els.displayTitle.textContent = 'Табло — поза маршрутом';
         }
      }
   }

   // ── Оновити progress та зупинки ──
   if (snap && !needNewRoute) {
      routeProgress = snap.progress;
      // Оновлюємо сегмент та максимум тільки коли progress зростає (рух вперед)
      if (snap.segment >= currentSegment) {
         currentSegment = snap.segment;
      }
      if (snap.progress > maxRouteProgress) {
         maxRouteProgress = snap.progress;
      }
      // ── Лічильники точності для підтвердження маршруту ──
      routeTotalCount++;
      if (snap.distance <= MAX_SNAP_DISTANCE) {
         routeSnapCount++;
      }
   }

   if (currentRoute) {
      routeStops = computeStopStatuses(currentRoute, pt.lat, pt.lng, routeProgress);

      // Визначаємо current stop
      const curStop = routeStops.find(s => s.status === 'current');
      currentStopId = curStop ? curStop.id : null;
   } else {
      routeStops = [];
      currentStopId = null;
   }

   // ── Оновити прогрес-бар ──
   const progressRatio = trackPoints.length > 1
      ? currentPointIdx / (trackPoints.length - 1)
      : 0;
   updateProgressBar(progressRatio);

   // ── Оновити табло ──
   updateDashboard(pt);
}


// ═══════════════════════════════════════
// UI UPDATES
// ═══════════════════════════════════════

/** Оновити інфо-бар (час, швидкість, координати) */
function updateInfoBar(pt) {
   // Час
   const d = new Date(pt.time * 1000);
   const h = String(d.getHours()).padStart(2, '0');
   const m = String(d.getMinutes()).padStart(2, '0');
   const s = String(d.getSeconds()).padStart(2, '0');
   const timeStr = `${h}:${m}:${s}`;

   els.infoTime.innerHTML = els.infoTime.querySelector('svg').outerHTML + ' ' + timeStr;
   els.infoSpeed.innerHTML = els.infoSpeed.querySelector('svg').outerHTML + ' ' + pt.speed.toFixed(0) + ' км/г';
   els.infoCoords.innerHTML = els.infoCoords.querySelector('svg').outerHTML + ' ' + pt.lat.toFixed(5) + ', ' + pt.lng.toFixed(5);

   // Час на плеєрі
   els.timeStart.textContent = timeStr;
}

/** Оновити прогрес-бар */
function updateProgressBar(ratio) {
   const pct = Math.max(0, Math.min(100, ratio * 100));
   els.progressFill.style.width = pct + '%';
   els.progressHandle.style.left = pct + '%';
}

/** Побудувати мітки зупинок на шкалі прогресу */
function buildPlayerStopMarks() {
   els.playerStops.innerHTML = '';

   if (!currentRoute || !currentRoute.stops || trackPoints.length === 0) return;

   // Для кожної зупинки знаходимо найближчу GPS-точку за часом
   const trackStartTime = trackPoints[0].time;
   const trackEndTime = trackPoints[trackPoints.length - 1].time;
   const trackDuration = trackEndTime - trackStartTime;

   if (trackDuration <= 0) return;

   currentRoute.stops.forEach(stop => {
      // Використовуємо progress зупинки на маршруті для позиціонування
      // Конвертуємо в позицію на шкалі треку
      // Знаходимо найближчу GPS-точку до зупинки
      let minDist = Infinity;
      let closestIdx = 0;
      for (let i = 0; i < trackPoints.length; i++) {
         const d = GEO.haversine(trackPoints[i].lat, trackPoints[i].lng, stop.lat, stop.lng);
         if (d < minDist) {
            minDist = d;
            closestIdx = i;
         }
      }

      // Позиція на шкалі
      const ratio = closestIdx / (trackPoints.length - 1);
      const mark = document.createElement('div');
      mark.className = 'track-stop-mark';
      mark.style.left = (ratio * 100) + '%';
      mark.dataset.name = stop.name;
      mark.title = stop.name;

      // Клік — перейти до цієї точки
      mark.addEventListener('click', (e) => {
         e.stopPropagation();
         currentPointIdx = closestIdx;
         processCurrentPoint();
      });

      els.playerStops.appendChild(mark);
   });
}


// ═══════════════════════════════════════
// ТАБЛО (Dashboard) — як player.js
// ═══════════════════════════════════════

/** Оновити табло */
function updateDashboard(pt) {
   if (!els.displayPanel || els.displayPanel.style.display === 'none') return;

   // Час
   const d = new Date(pt.time * 1000);
   const h = String(d.getHours()).padStart(2, '0');
   const m = String(d.getMinutes()).padStart(2, '0');
   els.displayTime.textContent = `${h}:${m}`;

   // Перевірка реклами: зона (type 1) або час (type 2)
   const activeAd = getActiveAdForPoint(pt);
   if (activeAd) {
      showDisplayAd(activeAd.url);
      els.displayLogFuture.innerHTML = '';
      return;
   }

   hideDisplayAd();

   if (routeStops.length === 0) {
      els.displayRoute.innerHTML = '<div class="display-empty-hint">Маршрут не визначено</div>';
      els.displayLogFuture.innerHTML = '';
      return;
   }

   // ── Побудувати колонки зупинок ──
   const colsCount = Math.ceil(routeStops.length / STOPS_PER_COLUMN);

   // Визначаємо активну зупинку
   let activeStopIdx = routeStops.findIndex(s => s.status === 'current');
   if (activeStopIdx < 0) {
      // Остання passed
      const lastPassed = routeStops.map((s, i) => s.status === 'passed' ? i : -1).filter(i => i >= 0);
      activeStopIdx = lastPassed.length > 0 ? lastPassed[lastPassed.length - 1] : 0;
   }

   const activeCol = Math.floor(activeStopIdx / STOPS_PER_COLUMN);
   let showFrom = activeCol - Math.floor(VISIBLE_COLUMNS / 2);
   showFrom = Math.max(0, Math.min(showFrom, colsCount - VISIBLE_COLUMNS));
   const showTo = Math.min(colsCount - 1, showFrom + VISIBLE_COLUMNS - 1);

   // Побудувати HTML
   let html = '';
   for (let col = showFrom; col <= showTo; col++) {
      html += '<div class="display-column">';
      html += '<div class="display-fill-line" data-col="' + col + '"></div>';

      const base = col * STOPS_PER_COLUMN;
      for (let i = 0; i < STOPS_PER_COLUMN; i++) {
         const idx = base + i;
         if (idx >= routeStops.length) break;

         const stop = routeStops[idx];
         const cls = stop.status === 'current' ? 'active'
            : stop.status === 'passed' ? 'past'
               : '';

         html += `<div class="display-stop ${cls}" data-stop-index="${idx}">${escapeHtml(stop.name || 'Зупинка ' + (idx + 1))}</div>`;
      }
      html += '</div>';
   }

   els.displayRoute.innerHTML = html;

   // Оновити лінії прогресу (fill lines)
   requestAnimationFrame(() => updateDisplayFillLines(showFrom, showTo, activeStopIdx, routeProgress));

   // Оновити лог майбутніх зупинок
   updateDisplayLog(showTo);
}

/** Оновити fill lines в табло (з інтерполяцією між зупинками) */
function updateDisplayFillLines(showFrom, showTo, activeStopIdx, vehicleProgress) {
   const columns = els.displayRoute.querySelectorAll('.display-column');
   let colIndex = 0;

   for (let c = showFrom; c <= showTo; c++) {
      const colEl = columns[colIndex];
      colIndex++;
      if (!colEl) continue;

      const fillEl = colEl.querySelector('.display-fill-line');
      if (!fillEl) continue;

      const colRect = colEl.getBoundingClientRect();
      const stopEls = colEl.querySelectorAll('.display-stop');
      if (stopEls.length === 0) { fillEl.style.height = '0'; continue; }

      const colStart = c * STOPS_PER_COLUMN;
      const colEnd = colStart + stopEls.length - 1; // останній глобальний індекс у колонці

      let targetStopEl = null;
      let hasActive = false;
      let allInColPassed = true; // всі зупинки в колонці пройдені?

      for (let i = 0; i < stopEls.length; i++) {
         const globalIdx = colStart + i;
         const s = routeStops[globalIdx];
         if (!s) { allInColPassed = false; break; }

         if (s.status === 'current') {
            targetStopEl = stopEls[i];
            hasActive = true;
            allInColPassed = false;
            break;
         } else if (s.status === 'passed') {
            targetStopEl = stopEls[i];
         } else {
            // upcoming — далі не заповнюємо
            allInColPassed = false;
            break;
         }
      }

      if (!targetStopEl) {
         fillEl.style.height = '0';
         continue;
      }

      // Якщо ВСІ зупинки в колонці пройдені і прогрес продовжується в наступній —
      // заповнюємо колонку до 100%
      const nextGlobalIdx = colEnd + 1;
      if (allInColPassed && nextGlobalIdx < routeStops.length) {
         const nextStop = routeStops[nextGlobalIdx];
         if (nextStop && (nextStop.status === 'passed' || nextStop.status === 'current')) {
            fillEl.style.height = '100%';
            continue;
         }
      }

      // Базова висота — до центру цільової зупинки
      const stopRect = targetStopEl.getBoundingClientRect();
      const targetY = stopRect.top + stopRect.height / 2 - colRect.top;

      // ── Інтерполяція між зупинками ──
      // Якщо машина між зупинками (немає 'current') і відомий vehicleProgress:
      // використовуємо stop.progress (0..1 вздовж маршруту) для плавного руху лінії.
      let extraPx = 0;
      if (!hasActive && vehicleProgress !== undefined) {
         const targetGlobalIdx = parseInt(targetStopEl.dataset.stopIndex);
         const nextIdx = targetGlobalIdx + 1;

         if (nextIdx < routeStops.length) {
            const stopObj = routeStops[targetGlobalIdx];
            const nextStopObj = routeStops[nextIdx];

            if (stopObj && nextStopObj &&
               stopObj.progress !== undefined && nextStopObj.progress !== undefined) {
               const p1 = stopObj.progress;
               const p2 = nextStopObj.progress;

               if (p2 > p1 && vehicleProgress > p1) {
                  const frac = Math.max(0, Math.min(1, (vehicleProgress - p1) / (p2 - p1)));

                  // Наступна зупинка в тій самій колонці?
                  const nextStopInCol = colEl.querySelector(`.display-stop[data-stop-index="${nextIdx}"]`);
                  if (nextStopInCol) {
                     const nextRect = nextStopInCol.getBoundingClientRect();
                     const nextY = nextRect.top + nextRect.height / 2 - colRect.top;
                     extraPx = (nextY - targetY) * frac;
                  } else {
                     // Наступна зупинка в наступній колонці — інтерполюємо до кінця поточної
                     extraPx = (colRect.height - targetY) * frac;
                  }
               }
            }
         }
      }

      fillEl.style.height = (targetY + extraPx) + 'px';
   }
}

/** Лог майбутніх зупинок */
function updateDisplayLog(showTo) {
   const visEnd = Math.min(routeStops.length, (showTo + 1) * STOPS_PER_COLUMN);
   const rightHidden = routeStops.slice(visEnd);
   const futureNames = rightHidden.map(s => s.name || '—');

   els.displayLogFuture.innerHTML = futureNames.length
      ? futureNames.map(n => `<div class="log-item">${escapeHtml(n)}</div>`).join('')
      : '<div class="log-item">— немає</div>';
}

/** HTML escape */
function escapeHtml(s) {
   if (!s) return '';
   return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}


// ═══════════════════════════════════════
// PLAYBACK CONTROLS
// ═══════════════════════════════════════

function togglePlay() {
   if (trackPoints.length === 0) return;

   isPlaying = !isPlaying;
   els.playIcon.style.display = isPlaying ? 'none' : '';
   els.pauseIcon.style.display = isPlaying ? '' : 'none';

   if (isPlaying) {
      startPlayback();
   } else {
      stopPlayback();
   }
}

function startPlayback() {
   if (playTimer) clearInterval(playTimer);

   // Інтервал залежить від швидкості
   // Базовий: 100ms між точками, ділимо на playSpeed
   const interval = Math.max(10, 100 / playSpeed);

   playTimer = setInterval(() => {
      currentPointIdx++;
      if (currentPointIdx >= trackPoints.length) {
         currentPointIdx = trackPoints.length - 1;
         isPlaying = false;
         els.playIcon.style.display = '';
         els.pauseIcon.style.display = 'none';
         clearInterval(playTimer);
         playTimer = null;
         return;
      }
      processCurrentPoint();
   }, interval);
}

function stopPlayback() {
   if (playTimer) clearInterval(playTimer);
   playTimer = null;
}

// Progress bar — drag & click
function getProgressFromEvent(e) {
   const rect = els.progressWrapper.getBoundingClientRect();
   let x = (e.clientX || (e.touches && e.touches[0].clientX) || 0) - rect.left;
   return Math.max(0, Math.min(1, x / rect.width));
}

function seekToProgress(ratio) {
   if (trackPoints.length === 0) return;
   currentPointIdx = Math.round(ratio * (trackPoints.length - 1));
   currentPointIdx = Math.max(0, Math.min(trackPoints.length - 1, currentPointIdx));

   // При seek скидаємо маршрут — нехай перевизначиться
   currentRoute = null;
   currentRouteId = null;
   routeProgress = 0;
   maxRouteProgress = 0;
   currentSegment = 0;
   reverseFrames = 0;

   processCurrentPoint();
}

els.progressWrapper.addEventListener('mousedown', (e) => {
   seekToProgress(getProgressFromEvent(e));

   const onMove = (ev) => seekToProgress(getProgressFromEvent(ev));
   const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
   };
   document.addEventListener('mousemove', onMove);
   document.addEventListener('mouseup', onUp);
});

els.progressWrapper.addEventListener('touchstart', (e) => {
   seekToProgress(getProgressFromEvent(e));

   const onMove = (ev) => {
      ev.preventDefault();
      seekToProgress(getProgressFromEvent(ev));
   };
   const onEnd = () => {
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
   };
   document.addEventListener('touchmove', onMove, { passive: false });
   document.addEventListener('touchend', onEnd);
}, { passive: false });


// Speed control
els.speedBtn.addEventListener('click', () => {
   speedIdx = (speedIdx + 1) % speeds.length;
   playSpeed = speeds[speedIdx];
   els.speedBtn.textContent = playSpeed + 'x';

   if (isPlaying) {
      stopPlayback();
      startPlayback();
   }
});


// ═══════════════════════════════════════
// ТАБЛО — показати / сховати
// ═══════════════════════════════════════
function toggleDisplay() {
   const isVisible = els.displayPanel.style.display !== 'none';
   els.displayPanel.style.display = isVisible ? 'none' : '';
   els.displayBtn.classList.toggle('active', !isVisible);

   // Ресайз карти
   if (map) {
      setTimeout(() => map.resize(), 300);
   }

   // Оновити вміст якщо показуємо
   if (!isVisible && trackPoints.length > 0) {
      const pt = trackPoints[currentPointIdx];
      if (pt) updateDashboard(pt);
   }
}

function hideDisplay() {
   els.displayPanel.style.display = 'none';
   els.displayBtn.classList.remove('active');
   if (map) {
      setTimeout(() => map.resize(), 300);
   }
}

els.displayBtn.addEventListener('click', toggleDisplay);
if (els.displayClose) {
   els.displayClose.addEventListener('click', hideDisplay);
}

// Play/Pause
els.playBtn.addEventListener('click', togglePlay);


// ═══════════════════════════════════════
// LOAD TRACK — кнопка "Завантажити"
// ═══════════════════════════════════════
els.loadBtn.addEventListener('click', async () => {
   const imei = els.imeiInput.value.trim();
   const date = els.dateInput.value;

   if (!imei) {
      els.imeiInput.focus();
      els.imeiInput.style.borderColor = '#ff6b6b';
      setTimeout(() => els.imeiInput.style.borderColor = '', 1500);
      return;
   }
   if (!date) {
      els.dateInput.focus();
      els.dateInput.style.borderColor = '#ff6b6b';
      setTimeout(() => els.dateInput.style.borderColor = '', 1500);
      return;
   }

   // Зупинити відтворення
   if (isPlaying) togglePlay();

   // Скинути стан
   currentPointIdx = 0;
   currentRoute = null;
   currentRouteId = null;
   routeProgress = 0;
   maxRouteProgress = 0;
   currentSegment = 0;
   reverseFrames = 0;
   currentStopId = null;
   routeStops = [];
   confirmedRoutes = new Map();
   routeSnapCount = 0;
   routeTotalCount = 0;

   // Видалити маркер
   if (trackMarker) {
      trackMarker.remove();
      trackMarker = null;
   }

   // Показати loading
   els.loadBtn.disabled = true;
   els.loadBtn.textContent = 'Завантаження...';

   try {
      // Завантажити маршрути якщо ще не завантажені
      if (allRoutes.length === 0) {
         await loadRoutes();
      }

      // Завантажити трек
      const ok = await loadTrack(imei, date);
      if (!ok) return;

      // Завантажити рекламу та зони для цієї машини
      await loadAds(imei);

      // Показати час початку та кінця
      if (trackPoints.length > 0) {
         const first = trackPoints[0];
         const last = trackPoints[trackPoints.length - 1];

         els.timeStart.textContent = formatTime(first.time);
         els.timeEnd.textContent = formatTime(last.time);
      }

      // Ініціалізація — обробити першу точку
      processCurrentPoint();

      // Побудувати мітки зупинок
      buildPlayerStopMarks();

      // Малюємо трек на карті
      if (map && map.isStyleLoaded()) {
         drawTrackOnMap();
      } else if (map) {
         map.once('style.load', drawTrackOnMap);
      }

      // Прибрати placeholder
      const placeholder = document.querySelector('.track-map-placeholder');
      if (placeholder) placeholder.style.display = 'none';

   } finally {
      els.loadBtn.disabled = false;
      els.loadBtn.innerHTML = `
         <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
         </svg>
         Завантажити
      `;
   }
});


// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════

function formatTime(epochtime) {
   const d = new Date(epochtime * 1000);
   return String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0') + ':' +
      String(d.getSeconds()).padStart(2, '0');
}


// ═══════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═══════════════════════════════════════
document.addEventListener('keydown', (e) => {
   // Ігноруємо якщо фокус в інпуті
   if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

   switch (e.key) {
      case ' ':
         e.preventDefault();
         togglePlay();
         break;
      case 'ArrowRight':
         e.preventDefault();
         if (trackPoints.length > 0) {
            const step = e.shiftKey ? 10 : 1;
            currentPointIdx = Math.min(trackPoints.length - 1, currentPointIdx + step);
            processCurrentPoint();
            // Центруємо карту на маркері (без зміни zoom)
            panMapToCurrentPoint();
         }
         break;
      case 'ArrowLeft':
         e.preventDefault();
         if (trackPoints.length > 0) {
            const step = e.shiftKey ? 10 : 1;
            currentPointIdx = Math.max(0, currentPointIdx - step);
            // Відкочуємо segment-трекер назад щоб snap працював коректно
            if (currentRoute) {
               currentSegment = Math.max(0, currentSegment - step * 2);
               // maxRouteProgress теж відкочуємо, щоб не спрацьовувала детекція реверсу
               maxRouteProgress = routeProgress;
            }
            processCurrentPoint();
            // Центруємо карту на маркері (без зміни zoom)
            panMapToCurrentPoint();
         }
         break;
      case 'ArrowUp':
         e.preventDefault();
         if (speedIdx < speeds.length - 1) {
            speedIdx++;
            playSpeed = speeds[speedIdx];
            els.speedBtn.textContent = playSpeed + 'x';
            if (isPlaying) { stopPlayback(); startPlayback(); }
         }
         break;
      case 'ArrowDown':
         e.preventDefault();
         if (speedIdx > 0) {
            speedIdx--;
            playSpeed = speeds[speedIdx];
            els.speedBtn.textContent = playSpeed + 'x';
            if (isPlaying) { stopPlayback(); startPlayback(); }
         }
         break;
      case 'd':
      case 'D':
      case 'т':
      case 'Т':
         toggleDisplay();
         break;
   }
});


// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
   initMap();
   updateProgressBar(0);

   // Предзавантаження маршрутів
   loadRoutes();
});

// Fallback
if (document.readyState !== 'loading') {
   initMap();
   updateProgressBar(0);
   loadRoutes();
}
