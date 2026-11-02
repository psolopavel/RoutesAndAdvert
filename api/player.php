<?php

/**
 * Player API — реклама для player.js (нова схема)
 *
 * Структура БД (RoutesAndAdvertisement):
 *   - advertisement       (id, name, file, created_at)
 *   - adverts_to_routes   (id, route_id, advert_id, display_per_event, zone_id, time_utc)
 *   - routes_to_cars      (imei, first_route_id, second_route_id, ...)
 *   - zones               (id, geom, radius_m, active)
 *   - ad_play_log         (id, imei, advert_id, route_id, event_start, status, error, played_at)
 *
 * Логіка:
 *   - manifest: всі файли реклам, прив'язані до 2-х маршрутів IMEI (для попереднього кешування).
 *   - now:      обирає одну активну рекламу зараз (зона > час, потім по id).
 *               Сервер не веде лічильник повторів — клієнт сам обмежує по display_per_event.
 *   - ack:      пише результат відтворення в ad_play_log.
 *
 * Семантика часу:
 *   - time_utc — час доби UTC. Реклама вважається активною від time_utc до
 *     time_utc + AD_TIME_WINDOW_SEC (3 хв) щодня.
 */

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
   http_response_code(200);
   exit();
}

// ─── Налаштування помилок ───
// Помилки НЕ потрапляють у тіло JSON-відповіді (display_errors=0), але:
//   - усі помилки/винятки → логуються через logToFile() в /tmp/AdvertismentManager/logs/debug.log
//   - якщо ?debug=1 — також додаємо опис помилки в JSON
error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');
date_default_timezone_set('Europe/Kiev');

require_once __DIR__ . "/../includes/connectDB.php";
require_once __DIR__ . "/services/GeoUtils.php";

const AD_TIME_WINDOW_SEC = 60; // 3 хвилини — окно активності time_utc

$DEBUG = !empty($_REQUEST['debug']);

function ad_log($msg, $ctx = null)
{
   if (function_exists('logToFile')) {
      logToFile('[player.php] ' . $msg, $ctx);
   } else {
      error_log('[player.php] ' . $msg . ' ' . json_encode($ctx, JSON_UNESCAPED_UNICODE));
   }
}

function ad_fail($where, Throwable $e)
{
   global $DEBUG;
   ad_log("FAIL @ {$where}", [
      'msg'   => $e->getMessage(),
      'file'  => $e->getFile(),
      'line'  => $e->getLine(),
      'trace' => explode("\n", $e->getTraceAsString()),
   ]);
   $resp = ["play" => false, "error" => "internal"];
   if ($DEBUG) {
      $resp['debug'] = [
         'where' => $where,
         'msg'   => $e->getMessage(),
         'file'  => basename($e->getFile()),
         'line'  => $e->getLine(),
      ];
   }
   if (!headers_sent()) http_response_code(500);
   echo json_encode($resp, JSON_UNESCAPED_UNICODE);
}

set_error_handler(function ($severity, $message, $file, $line) {
   if (!(error_reporting() & $severity)) return false;
   throw new ErrorException($message, 0, $severity, $file, $line);
});

set_exception_handler(function (Throwable $e) {
   ad_fail('uncaught', $e);
});

register_shutdown_function(function () {
   $err = error_get_last();
   if ($err && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
      ad_log('FATAL', $err);
      if (!headers_sent()) {
         http_response_code(500);
         header('Content-Type: application/json; charset=utf-8');
      }
      $resp = ["play" => false, "error" => "fatal"];
      global $DEBUG;
      if (!empty($DEBUG)) $resp['debug'] = $err;
      echo json_encode($resp, JSON_UNESCAPED_UNICODE);
   }
});

$action = $_GET['action'] ?? $_REQUEST['action'] ?? '';
$imeiRaw = $_REQUEST['imei'] ?? null;

if ($imeiRaw === null || $imeiRaw === '') {
   echo json_encode(["play" => false, "error" => "imei is required"]);
   exit;
}
if (!$db2) {
   echo json_encode(["play" => false, "error" => "RoutesAndAdvertisement DB not connected"]);
   exit;
}

// Вмикаємо режим винятків для mysqli — щоб SQL-помилки потрапляли у глобальний хендлер
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$imeiEscAd  = $db2->real_escape_string($imeiRaw);
$imeiEscGps = $db->real_escape_string($imeiRaw);

// ─── Маршрути IMEI з routes_to_cars ───
function fetchRouteIds(mysqli $db2, $imeiEsc)
{
   $sql = "SELECT first_route_id, second_route_id
           FROM routes_to_cars
           WHERE imei = '{$imeiEsc}'
           ORDER BY id DESC
           LIMIT 1";
   $res = $db2->query($sql);
   if (!$res || !($row = $res->fetch_assoc())) {
      if ($res) $res->free();
      return [];
   }
   $res->free();
   $ids = [];
   if (!empty($row['first_route_id']))  $ids[] = (int)$row['first_route_id'];
   if (!empty($row['second_route_id'])) $ids[] = (int)$row['second_route_id'];
   return array_values(array_unique($ids));
}

// ─── Усі прив'язки реклам для маршрутів + JOIN advertisement ───
function fetchAdverts(mysqli $db2, array $routeIds)
{
   if (empty($routeIds)) return [];
   $idsList = implode(',', array_map('intval', $routeIds));
   $sql = "SELECT a2r.id              AS link_id,
                  a2r.route_id        AS route_id,
                  a2r.advert_id       AS advert_id,
                  a2r.display_per_event,
                  a2r.zone_id,
                  a2r.time_utc,
                  ad.file             AS file_name,
                  ad.name             AS ad_name,
                  ad.created_at       AS created_at
           FROM adverts_to_routes a2r
           INNER JOIN advertisement ad ON ad.id = a2r.advert_id
           WHERE a2r.route_id IN ($idsList)";
   $res = $db2->query($sql);
   if (!$res) return [];
   $rows = [];
   while ($r = $res->fetch_assoc()) $rows[] = $r;
   $res->free();
   return $rows;
}

// ─── Зони ───
function fetchZones(mysqli $db2, array $zoneIds)
{
   if (empty($zoneIds)) return [];
   $ids = implode(',', array_map('intval', array_unique($zoneIds)));
   $sql = "SELECT id, ST_AsText(geom) AS geom_wkt, radius_m
           FROM zones
           WHERE id IN ($ids) AND active = 1";
   $res = $db2->query($sql);
   if (!$res) return [];
   $zones = [];
   while ($z = $res->fetch_assoc()) {
      $geom = parseZoneGeometry($z['geom_wkt'], (float)($z['radius_m'] ?? 0));
      if ($geom) $zones[(int)$z['id']] = $geom;
   }
   $res->free();
   return $zones;
}

function parseZoneGeometry($wkt, $radiusM)
{
   if (empty($wkt)) return null;
   if (preg_match('/POINT\s*\(([^\)]+)\)/i', $wkt, $m)) {
      $parts = preg_split('/\s+/', trim($m[1]));
      if (count($parts) >= 2) {
         return ['type' => 'circle', 'lat' => (float)$parts[1], 'lon' => (float)$parts[0], 'radius' => $radiusM];
      }
   }
   if (preg_match('/POLYGON\s*\(\((.+)\)\)/i', $wkt, $m)) {
      $coords = [];
      foreach (explode(',', $m[1]) as $pair) {
         $parts = preg_split('/\s+/', trim($pair));
         if (count($parts) >= 2) $coords[] = [(float)$parts[1], (float)$parts[0]];
      }
      if (count($coords) >= 3) return ['type' => 'polygon', 'coords' => $coords];
   }
   return null;
}

function pointInZone($lat, $lon, $zone)
{
   if ($zone['type'] === 'circle' && $zone['radius'] > 0) {
      return GeoUtils::haversineDistance($lat, $lon, $zone['lat'], $zone['lon']) <= $zone['radius'];
   }
   if ($zone['type'] === 'polygon' && !empty($zone['coords'])) {
      return pointInPolygon([$lat, $lon], $zone['coords']);
   }
   return false;
}

function pointInPolygon($point, $polygon)
{
   $x = $point[1];
   $y = $point[0];
   $inside = false;
   $n = count($polygon);
   if ($n < 3) return false;
   for ($i = 0, $j = $n - 1; $i < $n; $j = $i++) {
      $xi = $polygon[$i][1];
      $yi = $polygon[$i][0];
      $xj = $polygon[$j][1];
      $yj = $polygon[$j][0];
      $cond1 = ($yi > $y) != ($yj > $y);
      $den   = ($yj - $yi) ?: 0.0000001;
      $intersect = $cond1 && ($x < ($xj - $xi) * ($y - $yi) / $den + $xi);
      if ($intersect) $inside = !$inside;
   }
   return $inside;
}

// ─── Координати трекера ───
function fetchTrackerCoord(mysqli $db, $imeiEsc)
{
   $sql = "SELECT speed, satellites, latitude, longtitude, tracker_table, id
           FROM trackers WHERE imei = '{$imeiEsc}' LIMIT 1";
   $res = $db->query($sql);
   if (!$res || !($t = $res->fetch_assoc())) {
      if ($res) $res->free();
      return null;
   }
   $res->free();

   $coord = null;
   if (!empty($t['tracker_table']) && !empty($t['id'])) {
      $tbl = $db->real_escape_string($t['tracker_table']);
      $tid = (int)$t['id'];
      $threshold = time() - 50;
      $r2 = $db->query("SELECT latitude, longtitude FROM `{$tbl}`
                        WHERE imei = {$tid} AND epochtime >= {$threshold}
                        ORDER BY epochtime DESC LIMIT 1");
      if ($r2 && ($row = $r2->fetch_assoc())) {
         $coord = [GeoUtils::nmeaToDecimal((float)$row['latitude']), GeoUtils::nmeaToDecimal((float)$row['longtitude'])];
      }
      if ($r2) $r2->free();
   }
   if (!$coord && !empty($t['latitude']) && !empty($t['longtitude'])) {
      $coord = [GeoUtils::nmeaToDecimal((float)$t['latitude']), GeoUtils::nmeaToDecimal((float)$t['longtitude'])];
   }
   return $coord;
}

// ─── Активність по часу: time_utc + AD_TIME_WINDOW_SEC ───
// Повертає event_start (unix ts) якщо активна, інакше null.
function timeWindowEventStart($timeUtcStr)
{
   if (!$timeUtcStr) return null;
   if (!preg_match('/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/', $timeUtcStr, $m)) return null;
   $h = (int)$m[1];
   $i = (int)$m[2];
   $s = isset($m[3]) ? (int)$m[3] : 0;
   if ($h > 23 || $i > 59 || $s > 59) return null;

   $now = time();
   foreach ([0, -1] as $dayOffset) { // сьогодні UTC і вчора (для випадку трохи після UTC-півночі)
      $start = gmmktime($h, $i, $s, (int)gmdate('n'), (int)gmdate('j') + $dayOffset, (int)gmdate('Y'));
      if ($now >= $start && $now < $start + AD_TIME_WINDOW_SEC) {
         return $start;
      }
   }
   return null;
}

/* ─────────────────────────────────────
 * action = manifest
 *   {
 *     version: "<sha1>",
 *     routeIds: [..],
 *     ads: [ { id, fileName, url, createdAt } ]
 *   }
 * ─────────────────────────────────────*/
if ($action === 'manifest') {
   $routeIds = fetchRouteIds($db2, $imeiEscAd);
   $rows = fetchAdverts($db2, $routeIds);

   // Унікалізуємо по advert_id (один файл — одна позиція в кеші).
   $byAd = [];
   foreach ($rows as $r) {
      $aid = (int)$r['advert_id'];
      if (!isset($byAd[$aid])) {
         $byAd[$aid] = [
            'id'        => $aid,
            'fileName'  => $r['file_name'],
            'url'       => '/videos/' . rawurlencode($r['file_name']),
            'createdAt' => $r['created_at'],
         ];
      }
   }
   $ads = array_values($byAd);
   usort($ads, function ($a, $b) {
      return $a['id'] <=> $b['id'];
   });

   $sigSrc = '';
   foreach ($ads as $a) $sigSrc .= $a['fileName'] . '|' . $a['createdAt'] . ';';
   $version = sha1($sigSrc);

   echo json_encode([
      'version'  => $version,
      'routeIds' => $routeIds,
      'ads'      => $ads,
   ], JSON_UNESCAPED_UNICODE);
   exit;
}

/* ─────────────────────────────────────
 * action = now (за замовчуванням, для зворотної сумісності з player.js)
 *   { play: true, adId, eventStart, perEvent, url, fileName }
 *     або { play: false }
 * ─────────────────────────────────────*/
if ($action === '' || $action === 'now') {
   $routeIds = fetchRouteIds($db2, $imeiEscAd);
   if (empty($routeIds)) {
      echo json_encode(["play" => false]);
      exit;
   }

   $rows = fetchAdverts($db2, $routeIds);
   if (empty($rows)) {
      echo json_encode(["play" => false]);
      exit;
   }

   // Завантажуємо потрібні зони лише якщо є зональні рядки.
   $zoneIds = [];
   foreach ($rows as $r) if (!empty($r['zone_id'])) $zoneIds[] = (int)$r['zone_id'];
   $zones = fetchZones($db2, $zoneIds);

   // Координати трекера потрібні лише якщо є зональні реклами.
   $coord = !empty($zoneIds) ? fetchTrackerCoord($db, $imeiEscGps) : null;

   // Шукаємо активних кандидатів: зона > час; в межах рівних — по link_id.
   $zoneCands = [];
   $timeCands = [];
   foreach ($rows as $r) {
      $zid = !empty($r['zone_id']) ? (int)$r['zone_id'] : 0;
      if ($zid > 0) {
         if (!$coord || !isset($zones[$zid])) continue;
         if (pointInZone($coord[0], $coord[1], $zones[$zid])) {
            $zoneCands[] = $r;
         }
         continue;
      }
      // Часова реклама
      $eventStart = timeWindowEventStart($r['time_utc']);
      if ($eventStart !== null) {
         $r['_event_start'] = $eventStart;
         $timeCands[] = $r;
      }
   }

   $sortByLinkId = function ($a, $b) {
      return (int)$a['link_id'] <=> (int)$b['link_id'];
   };
   usort($zoneCands, $sortByLinkId);
   usort($timeCands, $sortByLinkId);

   $picked = $zoneCands[0] ?? $timeCands[0] ?? null;
   if (!$picked) {
      echo json_encode(["play" => false]);
      exit;
   }

   // event_start: для зональної — момент входу не знаємо, використовуємо «сесію»
   // прив'язану до link_id+поточної години (щоб клієнт міг розрізняти події).
   if (isset($picked['_event_start'])) {
      $eventStart = (int)$picked['_event_start'];
   } else {
      // Зональна: подія = «поки в зоні». Як ідентифікатор беремо link_id,
      // округлений час до 10 хв, щоб після виходу/повернення вважалось новою подією.
      $eventStart = (int)floor(time() / 600) * 600;
   }

   $fileName = $picked['file_name'];
   $filePath = "/var/www/RoutesAndAdvert/videos/" . $fileName;
   if (!is_file($filePath)) {
      echo json_encode(["play" => false]);
      exit;
   }

   echo json_encode([
      "play"       => true,
      "adId"       => (int)$picked['advert_id'],
      "linkId"     => (int)$picked['link_id'],
      "routeId"    => (int)$picked['route_id'],
      "eventStart" => $eventStart,
      "perEvent"   => max(1, (int)$picked['display_per_event']),
      "fileName"   => $fileName,
      "url"        => '/videos/' . rawurlencode($fileName),
      // Поле ad залишене для зворотної сумісності з player.js (старий формат).
      "ad"         => '/videos/' . rawurlencode($fileName),
   ], JSON_UNESCAPED_UNICODE);
   exit;
}

/* ─────────────────────────────────────
 * action = ack (POST)
 * body: imei, advert_id, route_id, event_start, status (played|failed), error?
 * ─────────────────────────────────────*/
if ($action === 'ack' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $payload = json_decode(file_get_contents('php://input'), true) ?: $_POST;

   $advertId   = (int)($payload['advert_id'] ?? 0);
   $routeId    = isset($payload['route_id']) ? (int)$payload['route_id'] : null;
   $eventStart = isset($payload['event_start']) ? (int)$payload['event_start'] : null;
   $status     = (string)($payload['status'] ?? '');
   $error      = isset($payload['error']) ? substr((string)$payload['error'], 0, 64) : null;

   if ($advertId <= 0 || !in_array($status, ['played', 'failed'], true)) {
      http_response_code(400);
      echo json_encode(["ok" => false, "error" => "invalid payload"]);
      exit;
   }

   $stmt = $db2->prepare("INSERT INTO ad_play_log
       (imei, advert_id, route_id, event_start, status, error, played_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())");
   if (!$stmt) {
      ad_log('ack: prepare failed', ['err' => $db2->error]);
      echo json_encode(["ok" => false, "error" => "prepare failed"]);
      exit;
   }
   // mysqli не дозволяє null через bind_param('i') — використовуємо bind_param по референсу
   // зі змінними; null → передаємо як null через посилання + тип 'i' це підтримує.
   $stmt->bind_param('siiiss', $imeiRaw, $advertId, $routeId, $eventStart, $status, $error);
   if (!$stmt->execute()) {
      ad_log('ack: execute failed', ['err' => $stmt->error]);
      $stmt->close();
      echo json_encode(["ok" => false, "error" => "execute failed"]);
      exit;
   }
   $stmt->close();

   echo json_encode(["ok" => true]);
   exit;
}

http_response_code(400);
echo json_encode([
   "play" => false,
   "error" => "Unknown action: $action",
   "available" => ["manifest", "now", "ack (POST)"]
]);
