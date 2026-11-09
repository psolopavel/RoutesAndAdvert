<?php

/**
 * Track API — дані для сторінки перегляду треку (track.php)
 * 
 * Ендпоінти:
 *   - get_track   — GPS-точки трекера за вказаний день
 *   - get_routes  — всі активні маршрути з зупинками та геометрією
 *
 * Вся логіка snap-to-line / визначення маршруту / статусів зупинок
 * виконується на клієнті (JavaScript), тому API просто віддає "сирі" дані.
 */

header('Content-Type: application/json; charset=utf-8');

ini_set('error_reporting', E_ALL);
ini_set('display_errors', 0);
date_default_timezone_set('Europe/Kiev');

// Перевірка авторизації (також підключає БД); viewer — лише своя машина і її маршрути
require_once __DIR__ . '/../includes/auth.php';
$currentUser = authRequireApi(['admin', 'routes_track', 'viewer']);
$isRestricted = authIsRestricted($currentUser);

require_once __DIR__ . "/services/TrackerService.php";
require_once __DIR__ . "/services/GeoUtils.php";

// $db  — GPS база (trackers, tracker tables)
// $db2 — RoutesAndAdvertisement (routes, stops)

$action = $_GET['action'] ?? '';

if (in_array($action, ['get_track', 'get_ads'], true)
   && !authCanAccessImei($currentUser, trim($_GET['imei'] ?? ''))) {
   authDenyApi('Немає доступу до цієї машини');
}

// ─────────────────────────────────────
// get_track — GPS-трек за один день
// Параметри: imei, date (YYYY-MM-DD)
// ─────────────────────────────────────
if ($action === 'get_track') {
   $imei = trim($_GET['imei'] ?? '');
   $date = trim($_GET['date'] ?? '');

   if ($imei === '') {
      http_response_code(400);
      echo json_encode(['error' => 'imei is required']);
      exit;
   }
   if ($date === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
      http_response_code(400);
      echo json_encode(['error' => 'date is required (YYYY-MM-DD)']);
      exit;
   }

   if (!$db) {
      http_response_code(500);
      echo json_encode(['error' => 'GPS DB not connected']);
      exit;
   }

   $trackerService = new TrackerService($db);
   $tracker = $trackerService->getTrackerByImei($imei);

   if (!$tracker) {
      http_response_code(404);
      echo json_encode([
         'error' => 'Tracker not found',
         'debug' => $trackerService->lastError,
      ]);
      exit;
   }

   // Обчислюємо діапазон unix timestamps для заданої дати
   $dayStart = strtotime($date . ' 00:00:00');
   $dayEnd   = strtotime($date . ' 23:59:59');

   if ($dayStart === false || $dayEnd === false) {
      http_response_code(400);
      echo json_encode(['error' => 'Invalid date']);
      exit;
   }

   $points = $trackerService->getTrack(
      $tracker['tracker_table'],
      $tracker['id'],
      $dayStart,
      $dayEnd,
      'ASC'
   );

   // Конвертуємо NMEA → десяткові координати
   $result = [];
   foreach ($points as $pt) {
      $lat = GeoUtils::nmeaToDecimal($pt['latitude']);
      $lng = GeoUtils::nmeaToDecimal($pt['longtitude']);

      // Пропускаємо нульові координати
      if ($lat == 0 && $lng == 0) continue;

      $result[] = [
         'lat'   => round($lat, 6),
         'lng'   => round($lng, 6),
         'speed' => round($pt['speed'], 1),
         'dir'   => $pt['direction'],
         'time'  => $pt['epochtime'],
      ];
   }

   echo json_encode([
      'imei'   => $imei,
      'date'   => $date,
      'points' => $result,
      'count'  => count($result),
   ], JSON_UNESCAPED_UNICODE);
   exit;
}

// ─────────────────────────────────────
// get_routes — всі активні маршрути з зупинками
// Завантажується один раз при ініціалізації track.js
// ─────────────────────────────────────
if ($action === 'get_routes') {
   if (!$db2) {
      http_response_code(500);
      echo json_encode(['error' => 'RoutesAndAdvertisement DB not connected']);
      exit;
   }

   // Завантажуємо маршрути
   $routesWhere = $isRestricted ? " AND r.id IN (" . authSqlIntList(authUserRouteIds($currentUser)) . ")" : "";
   $sqlRoutes = "SELECT r.id, r.group_id, r.name, ST_AsText(r.geom) AS geom_wkt, r.length_m
                 FROM routes r
                 WHERE r.active = 1{$routesWhere}
                 ORDER BY r.id";

   $resRoutes = $db2->query($sqlRoutes);
   $routes = [];

   if ($resRoutes) {
      while ($row = $resRoutes->fetch_assoc()) {
         $routeId = (int)$row['id'];

         // Парсимо геометрію маршруту → [[lat, lng], ...]
         $coords = GeoUtils::parseLineStringWKT($row['geom_wkt']);

         // Завантажуємо зупинки для цього маршруту
         $sqlStops = "SELECT s.id, s.name, ST_AsText(s.geom) AS stop_wkt,
                             s.radius_m, s.order_index
                      FROM stops s
                      WHERE s.route_id = {$routeId} AND s.active = 1
                      ORDER BY s.order_index ASC";

         $resStops = $db2->query($sqlStops);
         $stops = [];

         if ($resStops) {
            while ($stopRow = $resStops->fetch_assoc()) {
               $stopCoords = GeoUtils::parsePointWKT($stopRow['stop_wkt']);
               $lat = $stopCoords ? $stopCoords[0] : 0;
               $lng = $stopCoords ? $stopCoords[1] : 0;

               // Snap зупинки на маршрут (progress 0..1)
               $stopProgress = 0.0;
               if ($lat != 0 && $lng != 0 && count($coords) >= 2) {
                  $snap = GeoUtils::snapToLine($lat, $lng, $coords);
                  $stopProgress = $snap['progress'];
               }

               $stops[] = [
                  'id'       => (int)$stopRow['id'],
                  'name'     => $stopRow['name'],
                  'order'    => (int)$stopRow['order_index'],
                  'lat'      => round($lat, 6),
                  'lng'      => round($lng, 6),
                  'radius'   => (int)($stopRow['radius_m'] ?: 30),
                  'progress' => round($stopProgress, 6),
               ];
            }
            $resStops->free();
         }

         // Перетворюємо координати для фронту — [[lat, lng], ...]
         $coordsForFront = [];
         foreach ($coords as $c) {
            $coordsForFront[] = [round($c[0], 6), round($c[1], 6)];
         }

         $routes[] = [
            'id'       => $routeId,
            'group_id' => $row['group_id'] ? (int)$row['group_id'] : null,
            'name'     => $row['name'],
            'length_m' => (float)$row['length_m'],
            'coords'   => $coordsForFront,
            'stops'    => $stops,
         ];
      }
      $resRoutes->free();
   }

   echo json_encode([
      'routes' => $routes,
      'count'  => count($routes),
   ], JSON_UNESCAPED_UNICODE);
   exit;
}

// ─────────────────────────────────────
// get_ads — реклама для машини (type 1, 2) + зони
// Параметри: imei
// Для track.js: завантажити рекламу та зони, щоб перевіряти по кожній точці треку
// ─────────────────────────────────────
if ($action === 'get_ads') {
   function parseZoneGeometryForTrack($wkt, $radiusM)
   {
      if (empty($wkt)) return null;
      if (preg_match('/POINT\s*\(([^\)]+)\)/i', $wkt, $m)) {
         $parts = preg_split('/\s+/', trim($m[1]));
         if (count($parts) >= 2) {
            return [
               'type'   => 'circle',
               'lat'    => (float)$parts[1],
               'lon'    => (float)$parts[0],
               'radius' => $radiusM,
            ];
         }
      }
      if (preg_match('/POLYGON\s*\(\((.+)\)\)/i', $wkt, $m)) {
         $coords = [];
         $pairs = explode(',', $m[1]);
         foreach ($pairs as $pair) {
            $parts = preg_split('/\s+/', trim($pair));
            if (count($parts) >= 2) {
               $coords[] = [(float)$parts[1], (float)$parts[0]];
            }
         }
         if (count($coords) >= 3) {
            return ['type' => 'polygon', 'coords' => $coords];
         }
      }
      return null;
   }

   $imei = trim($_GET['imei'] ?? '');

   if ($imei === '') {
      http_response_code(400);
      echo json_encode(['error' => 'imei is required']);
      exit;
   }

   if (!$db2) {
      http_response_code(500);
      echo json_encode(['error' => 'RoutesAndAdvertisement DB not connected']);
      exit;
   }

   $imeiEsc = $db2->real_escape_string($imei);

   // Реклама type 1 (зони) та type 2 (час)
   $qu = "SELECT id, file_name, `type`, priority, params
          FROM `advertisement_list`
          WHERE `imei` = '{$imeiEsc}' AND `type` IN (1, 2)
          ORDER BY `priority` ASC, `id` ASC";

   $ads = [];
   $zoneIds = [];

   if ($res = $db2->query($qu)) {
      while ($r = $res->fetch_assoc()) {
         $params = json_decode($r['params'], true);
         if ($params === null && json_last_error() !== JSON_ERROR_NONE) continue;
         if (!is_array($params)) $params = [];

         $ads[] = [
            'id'       => (int)$r['id'],
            'file'     => $r['file_name'],
            'type'     => (int)$r['type'],
            'priority' => (int)$r['priority'],
            'params'   => $params,
         ];

         if ((int)$r['type'] === 1 && isset($params['zoneId'])) {
            $zoneIds[] = (int)$params['zoneId'];
         }
      }
      $res->free();
   }

   // Зони для type 1
   $zones = [];
   if (!empty($zoneIds)) {
      $ids = implode(',', array_unique($zoneIds));
      $zoneQu = "SELECT `id`, ST_AsText(`geom`) AS geom_wkt, `radius_m`
                 FROM `zones`
                 WHERE `id` IN ($ids) AND `active` = 1";

      if ($zoneRes = $db2->query($zoneQu)) {
         while ($z = $zoneRes->fetch_assoc()) {
            $geom = parseZoneGeometryForTrack($z['geom_wkt'], (float)($z['radius_m'] ?? 0));
            if ($geom) {
               $zones[(int)$z['id']] = $geom;
            }
         }
         $zoneRes->free();
      }
   }

   echo json_encode([
      'ads'   => $ads,
      'zones' => $zones,
   ], JSON_UNESCAPED_UNICODE);
   exit;
}

// ─────────────────────────────────────
// Невідома дія
// ─────────────────────────────────────
http_response_code(400);
echo json_encode([
   'error' => 'Unknown action: ' . $action,
   'available' => ['get_track', 'get_routes', 'get_ads'],
]);
