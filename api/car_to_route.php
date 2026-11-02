<?php

/**
 * Car to Route API — список зв'язків транспорту з маршрутами.
 * Працює з таблицями: routes_to_cars (first_route_id, second_route_id), routes, adverts_to_routes.
 * Імена машин підтягуються одним batch-запитом через TrackerService (база GPS).
 */

ini_set('error_reporting', E_ALL);
ini_set('display_errors', 0);
ini_set('display_startup_errors', 0);
date_default_timezone_set('Europe/Kiev');

require_once __DIR__ . '/../includes/auth.php';
$currentUser = authRequireApi(['admin', 'advertisement', 'client']);
$isClient = authIsClient($currentUser);

header('Content-Type: application/json; charset=utf-8');

function c2rLog($msg, $context = null)
{
   $file = dirname(__DIR__) . '/debug.log';
   $t = date('Y-m-d H:i:s');
   $ctx = '';
   if ($context !== null) {
      $ctx = ' ' . (is_scalar($context) ? $context : json_encode($context, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
   }
   @file_put_contents($file, "[$t] car_to_route: $msg$ctx" . PHP_EOL, FILE_APPEND);
}

if (!$db2) {
   c2rLog("DB2 connection failed");
   echo json_encode(['error' => 'Помилка підключення до бази RoutesAndAdvertisement']);
   exit;
}

$action = $_GET['action'] ?? $_POST['action'] ?? '';

// =============================================
// list — повний список прив'язок транспорт → маршрут
// =============================================
if ($action === 'list') {
   // 1) Прив'язки: два маршрути (A→B та B→A) на один IMEI (клієнту — лише його IMEI)
   $imeiWhere = $isClient ? "WHERE rtc.imei IN (" . authSqlStrList($db2, authUserImeis($currentUser)) . ")" : "";
   $sql = "SELECT rtc.id, rtc.imei, rtc.first_route_id, rtc.second_route_id, rtc.date,
                  r1.name AS first_route_name,
                  r2.name AS second_route_name
           FROM routes_to_cars rtc
           LEFT JOIN routes r1 ON r1.id = rtc.first_route_id
           LEFT JOIN routes r2 ON r2.id = rtc.second_route_id
           $imeiWhere
           ORDER BY rtc.id DESC";

   $rows = [];
   $routeIds = [];
   if ($res = $db2->query($sql)) {
      while ($r = $res->fetch_assoc()) {
         $r['id'] = (int)$r['id'];
         $r['first_route_id'] = (int)($r['first_route_id'] ?? 0);
         $r['second_route_id'] = (int)($r['second_route_id'] ?? 0);
         $r['imei'] = (string)$r['imei'];
         $rows[] = $r;
         if ($r['first_route_id'] > 0) {
            $routeIds[$r['first_route_id']] = true;
         }
         if ($r['second_route_id'] > 0) {
            $routeIds[$r['second_route_id']] = true;
         }
      }
      $res->free();
   } else {
      c2rLog("list query error", $db2->error);
      echo json_encode(['error' => 'Помилка читання БД']);
      exit;
   }

   // 2) Кількість реклам по маршрутах (сума по обох маршрутах рядка)
   $advertCounts = [];
   if (!empty($routeIds)) {
      $idsList = implode(',', array_map('intval', array_keys($routeIds)));
      if ($cntRes = $db2->query("SELECT route_id, COUNT(*) AS cnt FROM adverts_to_routes WHERE route_id IN ($idsList) GROUP BY route_id")) {
         while ($cr = $cntRes->fetch_assoc()) {
            $advertCounts[(int)$cr['route_id']] = (int)$cr['cnt'];
         }
         $cntRes->free();
      }
   }

   // 3) Збираємо результат
   $items = [];
   foreach ($rows as $r) {
      $a1 = $r['first_route_id'] > 0 && isset($advertCounts[$r['first_route_id']]) ? $advertCounts[$r['first_route_id']] : 0;
      $a2 = $r['second_route_id'] > 0 && isset($advertCounts[$r['second_route_id']]) ? $advertCounts[$r['second_route_id']] : 0;
      $items[] = [
         'id'                 => $r['id'],
         'imei'               => $r['imei'],
         'first_route_id'     => $r['first_route_id'],
         'second_route_id'    => $r['second_route_id'],
         'first_route_name'   => $r['first_route_name'],
         'second_route_name'  => $r['second_route_name'],
         'adverts_count'      => $a1 + $a2,
         'date'               => $r['date'],
      ];
   }

   echo json_encode(['items' => $items]);
   exit;
}

// =============================================
// available_routes — список маршрутів для select (клієнту — лише призначені)
// =============================================
if ($action === 'available_routes') {
   $routes = [];
   $routesWhere = $isClient ? "WHERE r.id IN (" . authSqlIntList(authUserRouteIds($currentUser)) . ")" : "";
   $sql = "SELECT r.id, r.name, g.name AS group_name
           FROM routes r
           LEFT JOIN route_groups g ON g.id = r.group_id
           $routesWhere
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
// attach — прив'язати машину до маршруту
// =============================================
if ($action === 'attach' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $imei = trim($_POST['imei'] ?? '');
   $firstRouteId = intval($_POST['first_route_id'] ?? 0);
   $secondRouteId = intval($_POST['second_route_id'] ?? 0);

   if ($imei === '' || $firstRouteId <= 0 || $secondRouteId <= 0) {
      echo json_encode(['ok' => false, 'errors' => ['Вкажіть IMEI та обидва маршрути (A→B і B→A)']]);
      exit;
   }

   if ($firstRouteId === $secondRouteId) {
      echo json_encode(['ok' => false, 'errors' => ['Потрібні два різні маршрути для прямого та зворотного напрямку']]);
      exit;
   }

   if (!authCanAccessImei($currentUser, $imei)) {
      authDenyApi('Цей IMEI вам не призначено');
   }
   if (!authCanAccessRoute($currentUser, $firstRouteId) || !authCanAccessRoute($currentUser, $secondRouteId)) {
      authDenyApi('Немає доступу до вибраного маршруту');
   }

   $chk = $db2->query("SELECT id FROM routes WHERE id IN ($firstRouteId, $secondRouteId)");
   $found = 0;
   if ($chk) {
      while ($chk->fetch_assoc()) {
         $found++;
      }
      $chk->free();
   }
   if ($found !== 2) {
      echo json_encode(['ok' => false, 'errors' => ['Один або обидва маршрути не знайдено']]);
      exit;
   }

   $imeiEsc = $db2->real_escape_string($imei);

   $existingId = 0;
   $existingFirst = 0;
   $existingSecond = 0;
   if ($chk = $db2->query("SELECT id, first_route_id, second_route_id FROM routes_to_cars WHERE imei = '$imeiEsc' LIMIT 1")) {
      if ($row = $chk->fetch_assoc()) {
         $existingId = (int)$row['id'];
         $existingFirst = (int)($row['first_route_id'] ?? 0);
         $existingSecond = (int)($row['second_route_id'] ?? 0);
      }
      $chk->free();
   }

   if ($existingId > 0) {
      if ($existingFirst === $firstRouteId && $existingSecond === $secondRouteId) {
         echo json_encode(['ok' => false, 'errors' => ['Для цього IMEI вже збережені саме ці два маршрути']]);
         exit;
      }
      $sql = "UPDATE routes_to_cars SET first_route_id = $firstRouteId, second_route_id = $secondRouteId, date = NOW() WHERE id = $existingId";
      if ($db2->query($sql)) {
         echo json_encode(['ok' => true, 'id' => $existingId, 'updated' => true]);
      } else {
         c2rLog("attach update error", $db2->error);
         echo json_encode(['ok' => false, 'errors' => ['Помилка БД: ' . $db2->error]]);
      }
      exit;
   }

   $sql = "INSERT INTO routes_to_cars (imei, first_route_id, second_route_id) VALUES ('$imeiEsc', $firstRouteId, $secondRouteId)";
   if ($db2->query($sql)) {
      echo json_encode(['ok' => true, 'id' => $db2->insert_id, 'updated' => false]);
   } else {
      c2rLog("attach error", $db2->error);
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
   if ($isClient) {
      $rowImei = null;
      if ($chk = $db2->query("SELECT imei FROM routes_to_cars WHERE id = $id LIMIT 1")) {
         if ($row = $chk->fetch_assoc()) $rowImei = (string)$row['imei'];
         $chk->free();
      }
      if ($rowImei === null || !authCanAccessImei($currentUser, $rowImei)) {
         authDenyApi('Немає доступу до цієї прив\'язки');
      }
   }
   if ($db2->query("DELETE FROM routes_to_cars WHERE id = $id")) {
      echo json_encode(['ok' => true]);
   } else {
      c2rLog("detach error", $db2->error);
      echo json_encode(['ok' => false, 'errors' => ['Помилка видалення']]);
   }
   exit;
}

c2rLog("Unknown action", ['action' => $action]);
echo json_encode(['error' => 'Невідома дія: ' . $action]);
