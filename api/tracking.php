<?php

/**
 * Tracking API — мінімальний API для player.js
 *
 * Демон (tracker_daemon.py) робить ВСІ обчислення і пише в tracking_sessions:
 *   - route_id               — поточний маршрут (один з пари в routes_to_cars)
 *   - current_stop_id        — на якій зупинці зараз (або NULL)
 *   - prev_stop_id           — попередня зупинка за order_index (або NULL)
 *   - next_stop_id           — наступна зупинка за order_index (або NULL)
 *   - progress_between_stops — доля пройденого відрізка між prev і next (0..1)
 *   - current_region_id      — FK alert_regions.id, громада де зараз машина (або NULL)
 *   - active (1/0)           — чи машина зараз їде по маршруту
 *
 * Загальний vehicle_progress по маршруту тут не зберігається — він локально
 * відновлюється з prev/next/progress_between_stops для побудови listOfPoints
 * та curPoint (формат відповіді для player.js не змінюється).
 *
 * active_displays — таблиця з IMEI, які зараз відображаються на player.js.
 * Кожен виклик get_player_data оновлює last_ping.
 * Демон обробляє ТІЛЬКИ IMEI з active_displays.
 *
 * Ендпоінти:
 *   - get_player_data      — дані для player.js (listOfPoints + curPoint) + пінг active_displays
 *   - stop_session         — деактивувати сесію (POST)
 *   - unregister_display   — видалити IMEI з active_displays (POST)
 */

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
   http_response_code(200);
   exit();
}

ini_set('error_reporting', E_ALL);
ini_set('display_errors', 0);
date_default_timezone_set('Europe/Kiev');

require_once __DIR__ . "/../includes/connectDB.php";
require_once __DIR__ . "/services/GeoUtils.php";

$action = $_GET['action'] ?? '';
$imei = trim($_GET['imei'] ?? '');

if ($imei === '') {
   http_response_code(400);
   echo json_encode(['error' => 'imei is required']);
   exit;
}

// ─────────────────────────────────────
// get_player_data — дані для player.js
// Читає tracking_sessions (нові поля), відновлює vehicle_progress з prev/next/pbs.
// Будує listOfPoints з геометрії маршруту + зупинок.
// ─────────────────────────────────────
if ($action === 'get_player_data') {
   if (!$db2) {
      http_response_code(500);
      echo json_encode(['error' => 'RoutesAndAdvertisement DB not connected']);
      exit;
   }

   $imeiEsc = $db2->real_escape_string($imei);

   // ─── Пінг active_displays — повідомляємо демону що цей IMEI активний ───
   $db2->query("INSERT INTO active_displays (imei, last_ping)
                VALUES ('{$imeiEsc}', NOW())
                ON DUPLICATE KEY UPDATE last_ping = NOW()");

   // Читаємо дані з tracking_sessions (тільки активні сесії)
   $sql = "SELECT id, route_id, progress_between_stops,
                  current_stop_id, prev_stop_id, next_stop_id,
                  current_region_id
           FROM tracking_sessions
           WHERE imei = '{$imeiEsc}' AND active = 1
           LIMIT 1";

   $res = $db2->query($sql);
   if (!$res || $res->num_rows === 0) {
      echo json_encode([
         'listOfPoints'  => [],
         'curPoint'      => 0,
         'routeId'       => null,
         'currentRegion' => null,
         'alertStatus'   => null,
      ], JSON_UNESCAPED_UNICODE);
      exit;
   }

   $session = $res->fetch_assoc();
   $res->free();
   $routeId = (int)$session['route_id'];
   $pbs = (float)$session['progress_between_stops'];
   if ($pbs < 0) $pbs = 0;
   if ($pbs > 1) $pbs = 1;
   $currentStopId = $session['current_stop_id'] ? (int)$session['current_stop_id'] : null;
   $prevStopId    = $session['prev_stop_id']    ? (int)$session['prev_stop_id']    : null;
   $nextStopId    = $session['next_stop_id']    ? (int)$session['next_stop_id']    : null;

   // Завантажуємо геометрію маршруту
   $sqlRoute = "SELECT ST_AsText(geom) AS geom_wkt FROM routes WHERE id = " . intval($routeId);
   $resRoute = $db2->query($sqlRoute);
   $routeCoords = [];
   if ($resRoute && $routeRow = $resRoute->fetch_assoc()) {
      $routeCoords = GeoUtils::parseLineStringWKT($routeRow['geom_wkt']);
      $resRoute->free();
   }

   if (empty($routeCoords)) {
      echo json_encode([
         'listOfPoints'  => [],
         'curPoint'      => 0,
         'routeId'       => $routeId,
         'currentRegion' => null,
         'alertStatus'   => null,
      ], JSON_UNESCAPED_UNICODE);
      exit;
   }

   // Завантажуємо зупинки маршруту
   $sqlStops = "SELECT s.id, s.name, ST_AsText(s.geom) AS stop_geom_wkt,
                       s.radius_m, s.order_index
                FROM stops s
                WHERE s.route_id = " . intval($routeId) . " AND s.active = 1
                ORDER BY s.order_index ASC";

   $resStops = $db2->query($sqlStops);
   $stops = [];
   if ($resStops) {
      while ($row = $resStops->fetch_assoc()) {
         $coords = null;
         if (!empty($row['stop_geom_wkt'])) {
            $coords = GeoUtils::parsePointWKT($row['stop_geom_wkt']);
         }

         $lat = $coords ? $coords[0] : 0;
         $lng = $coords ? $coords[1] : 0;

         // Snap зупинки на маршрут для позиціонування
         $stopProgress = 0.0;
         if ($lat != 0 && $lng != 0 && count($routeCoords) >= 2) {
            $snap = GeoUtils::snapToLine($lat, $lng, $routeCoords);
            $stopProgress = $snap['progress'];
         }

         $stops[] = [
            'id'          => (int)$row['id'],
            'name'        => $row['name'],
            'order_index' => (int)$row['order_index'],
            'lat'         => $lat,
            'lng'         => $lng,
            'progress'    => round($stopProgress, 6),
         ];
      }
      $resStops->free();
   }

   // ─── Відновлюємо vehicle_progress (0..1) з prev/next/pbs ───
   // Демон більше не зберігає загальний progress; локально реконструюємо
   // його з progress сусідніх зупинок та частки pbs.
   $prevProgress = null;
   $nextProgress = null;
   $currentProgress = null;
   foreach ($stops as $s) {
      if ($prevStopId !== null && $s['id'] === $prevStopId)       $prevProgress    = $s['progress'];
      if ($nextStopId !== null && $s['id'] === $nextStopId)       $nextProgress    = $s['progress'];
      if ($currentStopId !== null && $s['id'] === $currentStopId) $currentProgress = $s['progress'];
   }

   if ($currentProgress !== null) {
      $progress = $currentProgress;
   } elseif ($prevProgress !== null && $nextProgress !== null && $nextProgress > $prevProgress) {
      $progress = $prevProgress + $pbs * ($nextProgress - $prevProgress);
   } elseif ($prevProgress !== null) {
      $progress = $prevProgress;
   } elseif ($nextProgress !== null) {
      $progress = 0.0; // ще не доїхали до першої зупинки
   } else {
      $progress = 0.0;
   }
   if ($progress < 0) $progress = 0.0;
   if ($progress > 1) $progress = 1.0;

   // ─── Розставляємо статуси зупинок (current/passed/upcoming) ───
   foreach ($stops as &$s) {
      if ($currentStopId !== null && $s['id'] === $currentStopId) {
         $s['status'] = 'current';
      } elseif ($s['progress'] <= $progress && $progress > 0) {
         $s['status'] = 'passed';
      } else {
         $s['status'] = 'upcoming';
      }
   }
   unset($s);

   // Будуємо listOfPoints: точки маршруту + зупинки
   $listOfPoints = [];
   $totalRoutePoints = count($routeCoords);

   // ─── Обчислюємо реальний progress кожної точки маршруту по довжині ───
   $segLengths = [];
   $totalLength = 0;
   for ($i = 0; $i < $totalRoutePoints - 1; $i++) {
      $len = GeoUtils::haversineDistance(
         $routeCoords[$i][0],
         $routeCoords[$i][1],
         $routeCoords[$i + 1][0],
         $routeCoords[$i + 1][1]
      );
      $segLengths[] = $len;
      $totalLength += $len;
   }

   // Накопичений progress для кожної точки (0.0 … 1.0)
   $pointProgress = [];
   $accumulated = 0;
   for ($i = 0; $i < $totalRoutePoints; $i++) {
      $pointProgress[$i] = ($totalLength > 0) ? ($accumulated / $totalLength) : 0;
      if ($i < $totalRoutePoints - 1) {
         $accumulated += $segLengths[$i];
      }
   }

   // Позиції вставки зупинок
   $stopInsertPositions = [];
   foreach ($stops as $stop) {
      if ($stop['lat'] == 0 && $stop['lng'] == 0) continue;
      $snap = GeoUtils::snapToLine($stop['lat'], $stop['lng'], $routeCoords);
      $stopInsertPositions[] = [
         'insertAfter' => $snap['segment'],
         'progress'    => $snap['progress'],
         'stop'        => $stop,
      ];
   }

   usort($stopInsertPositions, function ($a, $b) {
      return $a['progress'] <=> $b['progress'];
   });

   // Будуємо список точок і визначаємо curPoint
   $stopIdx = 0;
   $curPoint = 0;
   $bestCurDist = 999999999;

   for ($i = 0; $i < $totalRoutePoints; $i++) {
      $pt = [
         'type' => 'route',
         'lat'  => $routeCoords[$i][0],
         'lng'  => $routeCoords[$i][1],
      ];
      $listOfPoints[] = $pt;

      // curPoint — найближча точка до progress (по реальній довжині маршруту)
      $ptProgress = $pointProgress[$i];
      $dist = abs($ptProgress - $progress);
      if ($dist < $bestCurDist) {
         $bestCurDist = $dist;
         $curPoint = count($listOfPoints) - 1;
      }

      // Вставляємо зупинки після відповідного сегмента
      while (
         $stopIdx < count($stopInsertPositions) &&
         $stopInsertPositions[$stopIdx]['insertAfter'] <= $i
      ) {
         $s = $stopInsertPositions[$stopIdx]['stop'];
         $listOfPoints[] = [
            'type'   => 'stop',
            'name'   => $s['name'],
            'idx'    => $s['id'],
            'lat'    => $s['lat'],
            'lng'    => $s['lng'],
            'status' => $s['status'],
         ];
         $stopIdx++;
      }
   }

   // Зупинки що залишились
   while ($stopIdx < count($stopInsertPositions)) {
      $s = $stopInsertPositions[$stopIdx]['stop'];
      $listOfPoints[] = [
         'type'   => 'stop',
         'name'   => $s['name'],
         'idx'    => $s['id'],
         'lat'    => $s['lat'],
         'lng'    => $s['lng'],
         'status' => $s['status'],
      ];
      $stopIdx++;
   }

   // ─── Визначаємо поточну громаду та статус тривоги ───
   $regionId = $session['current_region_id'] ? (int)$session['current_region_id'] : null;
   $currentRegion = null;
   $alertStatus = null;

   if ($regionId) {
      $rRes = $db2->query(
         "SELECT name_uk, oblast_name, centroid_lat, centroid_lon
          FROM alert_regions WHERE id = " . intval($regionId)
      );
      if ($rRes && $rRow = $rRes->fetch_assoc()) {
         $currentRegion = [
            'id'     => $regionId,
            'name'   => $rRow['name_uk'],
            'oblast' => $rRow['oblast_name'],
         ];
         $rRes->free();

         $cLat = floatval($rRow['centroid_lat']);
         $cLon = floatval($rRow['centroid_lon']);
         if ($cLat != 0 && $cLon != 0) {
            $aRes = $db2->query(
               "SELECT aa.id, aa.alert_type, aa.location_title, ar2.alert_level
                FROM active_alerts aa
                JOIN alert_regions ar2 ON aa.region_id = ar2.id
                WHERE ST_Contains(ar2.geom,
                      ST_GeomFromText(CONCAT('POINT(', " . $cLon . ", ' ', " . $cLat . ", ')')))
                ORDER BY ar2.admin_level DESC"
            );
            if ($aRes && $aRes->num_rows > 0) {
               $alertStatus = [];
               while ($aRow = $aRes->fetch_assoc()) {
                  $alertStatus[] = [
                     'id'             => (int)$aRow['id'],
                     'alert_type'     => $aRow['alert_type'],
                     'location_title' => $aRow['location_title'],
                     'level'          => $aRow['alert_level'],
                  ];
               }
               $aRes->free();
            }
         }
      }
   }

   echo json_encode([
      'listOfPoints'  => $listOfPoints,
      'curPoint'      => $curPoint,
      'routeId'       => $routeId,
      'currentRegion' => $currentRegion,
      'alertStatus'   => $alertStatus,
   ], JSON_UNESCAPED_UNICODE);
   exit;
}

// ─────────────────────────────────────
// stop_session — деактивувати сесію (POST)
// Примітка: start_session видалено — демон автоматично створює сесії
//           для IMEI з active_displays
// ─────────────────────────────────────
if ($action === 'stop_session' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   if (!$db2) {
      http_response_code(500);
      echo json_encode(['error' => 'RoutesAndAdvertisement DB not connected']);
      exit;
   }

   $imeiEsc = $db2->real_escape_string($imei);

   $db2->query("UPDATE tracking_sessions SET active = 0 WHERE imei = '{$imeiEsc}' AND active = 1");

   echo json_encode([
      'success' => true,
      'deactivated' => $db2->affected_rows,
   ], JSON_UNESCAPED_UNICODE);
   exit;
}

// ─────────────────────────────────────
// unregister_display — видалити IMEI з active_displays (POST)
// player.js може викликати при закритті або зміні IMEI
// ─────────────────────────────────────
if ($action === 'unregister_display' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   if (!$db2) {
      http_response_code(500);
      echo json_encode(['error' => 'RoutesAndAdvertisement DB not connected']);
      exit;
   }

   $imeiEsc = $db2->real_escape_string($imei);

   $db2->query("DELETE FROM active_displays WHERE imei = '{$imeiEsc}'");
   $db2->query("UPDATE tracking_sessions SET active = 0 WHERE imei = '{$imeiEsc}' AND active = 1");

   echo json_encode([
      'success' => true,
      'deleted_display' => $db2->affected_rows >= 0,
   ], JSON_UNESCAPED_UNICODE);
   exit;
}

// ─────────────────────────────────────
// Невідома дія
// ─────────────────────────────────────
http_response_code(400);
echo json_encode([
   'error' => 'Unknown action: ' . $action,
   'available' => [
      'get_player_data',
      'stop_session (POST)',
      'unregister_display (POST)',
   ]
]);
