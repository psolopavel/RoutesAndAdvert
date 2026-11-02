<?php

/**
 * All Car Routes API — довільна кількість маршрутів на одну машину (IMEI).
 * Працює з таблицею: all_car_routes (id, imei, routes_id LONGTEXT JSON, last_change_at).
 * Маршрути беруться з таблиці routes (база RoutesAndAdvertisement / $db2).
 */

ini_set('error_reporting', E_ALL);
ini_set('display_errors', 0);
ini_set('display_startup_errors', 0);
date_default_timezone_set('Europe/Kiev');

require_once __DIR__ . '/../includes/auth.php';
authRequireApi(['admin', 'routes_track']);

header('Content-Type: application/json; charset=utf-8');

function acrLog($msg, $context = null)
{
   $file = dirname(__DIR__) . '/debug.log';
   $t = date('Y-m-d H:i:s');
   $ctx = '';
   if ($context !== null) {
      $ctx = ' ' . (is_scalar($context) ? $context : json_encode($context, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
   }
   @file_put_contents($file, "[$t] all_car_routes: $msg$ctx" . PHP_EOL, FILE_APPEND);
}

if (!$db2) {
   acrLog("DB2 connection failed");
   echo json_encode(['error' => 'Помилка підключення до бази RoutesAndAdvertisement']);
   exit;
}

/**
 * Парсить значення колонки routes_id (LONGTEXT). Підтримує JSON ([1,2,3])
 * та запасний варіант — список через кому ("1,2,3").
 *
 * @return int[]
 */
function acrParseRoutesId($raw)
{
   if ($raw === null || $raw === '') return [];
   $val = trim((string)$raw);
   if ($val === '') return [];

   $arr = json_decode($val, true);
   if (!is_array($arr)) {
      // fallback: csv
      $arr = preg_split('/[,\s;]+/', $val, -1, PREG_SPLIT_NO_EMPTY);
   }

   $ids = [];
   foreach ($arr as $v) {
      $n = (int)$v;
      if ($n > 0) $ids[$n] = true;
   }
   return array_keys($ids);
}

$action = $_GET['action'] ?? $_POST['action'] ?? '';

// =============================================
// list — повний список прив'язок
// =============================================
if ($action === 'list') {
   $sql = "SELECT id, imei, routes_id, zones_id, last_change_at
           FROM all_car_routes
           ORDER BY id DESC";

   $rows = [];
   $allIds = [];
   $allZoneIds = [];
   if ($res = $db2->query($sql)) {
      while ($r = $res->fetch_assoc()) {
         $ids = acrParseRoutesId($r['routes_id']);
         $zids = acrParseRoutesId($r['zones_id']);
         $rows[] = [
            'id'              => (int)$r['id'],
            'imei'            => (string)$r['imei'],
            'route_ids'       => $ids,
            'zone_ids'        => $zids,
            'last_change_at'  => $r['last_change_at'],
         ];
         foreach ($ids as $rid) {
            $allIds[$rid] = true;
         }
         foreach ($zids as $zid) {
            $allZoneIds[$zid] = true;
         }
      }
      $res->free();
   } else {
      acrLog("list query error", $db2->error);
      echo json_encode(['error' => 'Помилка читання БД: ' . $db2->error]);
      exit;
   }

   // Підвантажуємо назви маршрутів одним запитом
   $names = [];
   if (!empty($allIds)) {
      $idsList = implode(',', array_map('intval', array_keys($allIds)));
      if ($nr = $db2->query("SELECT id, name FROM routes WHERE id IN ($idsList)")) {
         while ($nrow = $nr->fetch_assoc()) {
            $names[(int)$nrow['id']] = $nrow['name'];
         }
         $nr->free();
      }
   }

   // Підвантажуємо назви та типи зон (глобальні зони)
   $zoneMeta = [];
   if (!empty($allZoneIds)) {
      $zIdsList = implode(',', array_map('intval', array_keys($allZoneIds)));
      if ($zr = $db2->query("SELECT id, name, type FROM zones WHERE id IN ($zIdsList)")) {
         while ($zrow = $zr->fetch_assoc()) {
            $zoneMeta[(int)$zrow['id']] = [
               'name' => $zrow['name'],
               'type' => $zrow['type'],
            ];
         }
         $zr->free();
      }
   }

   // Назва машини та аккаунт з gps.tracker (перший запис по IMEI)
   $trackers = [];
   $allImeis = array_values(array_unique(array_map(function ($r) {
      return (string)$r['imei'];
   }, $rows)));
   if ($db && !empty($allImeis)) {
      $imeiEscList = [];
      foreach ($allImeis as $imeiVal) {
         if ($imeiVal !== '') {
            $imeiEscList[] = "'" . $db->real_escape_string($imeiVal) . "'";
         }
      }
      if (!empty($imeiEscList)) {
         $imeiIn = implode(',', $imeiEscList);
         $sqlTracker = "SELECT imei, name, owner
                        FROM tracker
                        WHERE imei IN ($imeiIn)
                        ORDER BY id ASC";
         if ($tr = $db->query($sqlTracker)) {
            while ($trow = $tr->fetch_assoc()) {
               $tImei = (string)$trow['imei'];
               if (!isset($trackers[$tImei])) {
                  $trackers[$tImei] = [
                     'car_name' => $trow['name'],
                     'owner'    => $trow['owner'],
                  ];
               }
            }
            $tr->free();
         } else {
            acrLog("tracker query error", $db->error);
         }
      }
   }

   $items = [];
   foreach ($rows as $r) {
      $routes = [];
      foreach ($r['route_ids'] as $rid) {
         $routes[] = [
            'id'   => $rid,
            'name' => isset($names[$rid]) ? $names[$rid] : null,
         ];
      }
      $zones = [];
      foreach ($r['zone_ids'] as $zid) {
         $meta = isset($zoneMeta[$zid]) ? $zoneMeta[$zid] : null;
         $zones[] = [
            'id'   => $zid,
            'name' => $meta ? $meta['name'] : null,
            'type' => $meta ? $meta['type'] : null,
         ];
      }
      $trackerInfo = isset($trackers[$r['imei']]) ? $trackers[$r['imei']] : null;
      $items[] = [
         'id'             => $r['id'],
         'imei'           => $r['imei'],
         'car_name'       => $trackerInfo ? $trackerInfo['car_name'] : null,
         'owner'          => $trackerInfo ? $trackerInfo['owner'] : null,
         'routes'         => $routes,
         'zones'          => $zones,
         'last_change_at' => $r['last_change_at'],
      ];
   }

   echo json_encode(['items' => $items]);
   exit;
}

// =============================================
// available_routes — список усіх маршрутів
// =============================================
if ($action === 'available_routes') {
   $routes = [];
   $sql = "SELECT r.id, r.name, g.name AS group_name
           FROM routes r
           LEFT JOIN route_groups g ON g.id = r.group_id
           ORDER BY g.name, r.name";
   if ($res = $db2->query($sql)) {
      while ($r = $res->fetch_assoc()) {
         $routes[] = [
            'id'         => (int)$r['id'],
            'name'       => $r['name'],
            'group_name' => $r['group_name'],
         ];
      }
      $res->free();
   }
   echo json_encode(['routes' => $routes]);
   exit;
}

// =============================================
// available_zones — глобальні зони (final_stop | counting_ignoring, is_global=1)
// =============================================
if ($action === 'available_zones') {
   $zones = [];
   $sql = "SELECT id, name, type, radius_m
           FROM zones
           WHERE is_global = 1 AND type IN ('final_stop', 'counting_ignoring')
           ORDER BY type, name";
   if ($res = $db2->query($sql)) {
      while ($z = $res->fetch_assoc()) {
         $zones[] = [
            'id'       => (int)$z['id'],
            'name'     => $z['name'],
            'type'     => $z['type'],
            'radius_m' => $z['radius_m'] !== null ? (int)$z['radius_m'] : null,
         ];
      }
      $res->free();
   }
   echo json_encode(['zones' => $zones]);
   exit;
}

// =============================================
// save — створити або оновити прив'язку
// =============================================
if ($action === 'save' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $id = intval($_POST['id'] ?? 0);
   $imei = trim($_POST['imei'] ?? '');
   $routesRaw = $_POST['routes_ids'] ?? '';
   $zonesRaw = $_POST['zones_ids'] ?? '';

   if ($imei === '') {
      echo json_encode(['ok' => false, 'errors' => ['Вкажіть IMEI']]);
      exit;
   }

   $routeIds = acrParseRoutesId($routesRaw);
   $zoneIdsTemp = acrParseRoutesId($zonesRaw);

   if (empty($routeIds) && empty($zoneIdsTemp)) {
      echo json_encode(['ok' => false, 'errors' => ['Оберіть хоча б одну зону або один маршрут']]);
      exit;
   }

   // Перевіримо, що всі маршрути існують
   $idsList = implode(',', array_map('intval', $routeIds));
   $found = [];
   if ($res = $db2->query("SELECT id FROM routes WHERE id IN ($idsList)")) {
      while ($row = $res->fetch_assoc()) {
         $found[(int)$row['id']] = true;
      }
      $res->free();
   }
   $missing = array_values(array_diff($routeIds, array_keys($found)));
   if (!empty($missing)) {
      echo json_encode(['ok' => false, 'errors' => ['Маршрути не знайдено: ' . implode(', ', $missing)]]);
      exit;
   }

   // Зони — необов'язкові. Лише глобальні final_stop або counting_ignoring.
   $zoneIds = acrParseRoutesId($zonesRaw);
   if (!empty($zoneIds)) {
      $zIdsList = implode(',', array_map('intval', $zoneIds));
      $zFound = [];
      if ($zres = $db2->query("SELECT id FROM zones WHERE id IN ($zIdsList) AND is_global = 1 AND type IN ('final_stop', 'counting_ignoring')")) {
         while ($zrow = $zres->fetch_assoc()) {
            $zFound[(int)$zrow['id']] = true;
         }
         $zres->free();
      }
      $zMissing = array_values(array_diff($zoneIds, array_keys($zFound)));
      if (!empty($zMissing)) {
         echo json_encode(['ok' => false, 'errors' => ['Зони не знайдено або вони не є глобальними: ' . implode(', ', $zMissing)]]);
         exit;
      }
      // Залишаємо лише валідні id у вихідному порядку
      $zoneIds = array_values(array_filter($zoneIds, function ($z) use ($zFound) {
         return isset($zFound[$z]);
      }));
   }

   $imeiEsc = $db2->real_escape_string($imei);
   $jsonEsc = $db2->real_escape_string(json_encode(array_values($routeIds), JSON_UNESCAPED_UNICODE));
   $zonesJsonEsc = $db2->real_escape_string(json_encode(array_values($zoneIds), JSON_UNESCAPED_UNICODE));

   // IMEI має бути унікальним — шукаємо існуючий запис
   $existingId = 0;
   if ($chk = $db2->query("SELECT id FROM all_car_routes WHERE imei = '$imeiEsc' LIMIT 1")) {
      if ($row = $chk->fetch_assoc()) $existingId = (int)$row['id'];
      $chk->free();
   }

   if ($id > 0) {
      // редагування конкретного запису
      if ($existingId > 0 && $existingId !== $id) {
         echo json_encode(['ok' => false, 'errors' => ['Інший запис з таким IMEI вже існує']]);
         exit;
      }
      $sql = "UPDATE all_car_routes SET imei = '$imeiEsc', routes_id = '$jsonEsc', zones_id = '$zonesJsonEsc', last_change_at = NOW() WHERE id = $id";
      if ($db2->query($sql)) {
         echo json_encode(['ok' => true, 'id' => $id, 'updated' => true]);
      } else {
         acrLog("save update error", $db2->error);
         echo json_encode(['ok' => false, 'errors' => ['Помилка БД: ' . $db2->error]]);
      }
      exit;
   }

   if ($existingId > 0) {
      // upsert по imei
      $sql = "UPDATE all_car_routes SET routes_id = '$jsonEsc', zones_id = '$zonesJsonEsc', last_change_at = NOW() WHERE id = $existingId";
      if ($db2->query($sql)) {
         echo json_encode(['ok' => true, 'id' => $existingId, 'updated' => true]);
      } else {
         acrLog("save upsert error", $db2->error);
         echo json_encode(['ok' => false, 'errors' => ['Помилка БД: ' . $db2->error]]);
      }
      exit;
   }

   $sql = "INSERT INTO all_car_routes (imei, routes_id, zones_id) VALUES ('$imeiEsc', '$jsonEsc', '$zonesJsonEsc')";
   if ($db2->query($sql)) {
      echo json_encode(['ok' => true, 'id' => $db2->insert_id, 'updated' => false]);
   } else {
      acrLog("save insert error", $db2->error);
      echo json_encode(['ok' => false, 'errors' => ['Помилка БД: ' . $db2->error]]);
   }
   exit;
}

// =============================================
// detach — видалити прив'язку
// =============================================
if ($action === 'detach' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $id = intval($_POST['id'] ?? 0);
   if ($id <= 0) {
      echo json_encode(['ok' => false, 'errors' => ['Невірний id']]);
      exit;
   }
   if ($db2->query("DELETE FROM all_car_routes WHERE id = $id")) {
      echo json_encode(['ok' => true]);
   } else {
      acrLog("detach error", $db2->error);
      echo json_encode(['ok' => false, 'errors' => ['Помилка видалення']]);
   }
   exit;
}

acrLog("Unknown action", ['action' => $action]);
echo json_encode(['error' => 'Невідома дія: ' . $action]);
