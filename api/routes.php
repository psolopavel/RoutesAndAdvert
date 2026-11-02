<?php

/**
 * Routes API - CRUD операції для маршрутів, зупинок та зон
 */

ini_set('error_reporting', E_ALL);
ini_set('display_errors', 0);
ini_set('display_startup_errors', 0);
date_default_timezone_set('Europe/Kiev');

// Перевірка авторизації (routes_track, admin; client — лише перегляд своїх маршрутів)
require_once __DIR__ . '/../includes/auth.php';
$currentUser = authRequireApi(['admin', 'routes_track', 'client']);
$isClient = authIsClient($currentUser);

require_once __DIR__ . "/../includes/tariff_helpers.php";

header('Content-Type: application/json; charset=utf-8');

// Логування
function logDebug($msg, $context = null)
{
   $file = dirname(__DIR__) . '/debug.log';
   $t = date('Y-m-d H:i:s');
   $ctx = $context !== null ? ' ' . json_encode($context, JSON_UNESCAPED_UNICODE) : '';
   file_put_contents($file, "[$t] routes_api: $msg$ctx" . PHP_EOL, FILE_APPEND);
}

$action = $_GET['action'] ?? $_POST['action'] ?? '';

// Клієнту доступні лише дії читання і лише по призначених маршрутах
$clientRouteList = $isClient ? authSqlIntList(authUserRouteIds($currentUser)) : null;
if ($isClient && !in_array($action, ['get_groups', 'search_routes', 'get_routes', 'get_route', 'get_zones'], true)) {
   authDenyApi('Маршрути доступні лише для перегляду');
}

// Перевіряємо підключення до БД RoutesAndAdvertisement
if (!$db2) {
   logDebug("DB2 connection failed");
   echo json_encode(['error' => 'Помилка підключення до бази RoutesAndAdvertisement']);
   exit;
}

// =====================================
// ROUTE GROUPS
// =====================================

if ($action === 'get_groups') {
   $groups = [];
   $groupsWhere = $isClient ? "WHERE id IN (SELECT group_id FROM routes WHERE id IN ($clientRouteList))" : "";
   $res = $db2->query("SELECT id, name, additional, created_at FROM route_groups $groupsWhere ORDER BY name");
   if ($res) {
      while ($row = $res->fetch_assoc()) {
         $row['additional'] = $row['additional'] ? json_decode($row['additional'], true) : null;
         $groups[] = $row;
      }
      $res->free();
   }
   echo json_encode(['groups' => $groups]);
   exit;
}

if ($action === 'save_group' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $id = isset($_POST['id']) ? intval($_POST['id']) : 0;
   $name = trim($_POST['name'] ?? '');
   $color = $_POST['color'] ?? '#3388ff';

   if ($name === '') {
      echo json_encode(['ok' => false, 'error' => 'Назва групи обов\'язкова']);
      exit;
   }

   $additional = json_encode(['color' => $color]);
   $nameEsc = $db2->real_escape_string($name);
   $additionalEsc = $db2->real_escape_string($additional);

   if ($id > 0) {
      // Update
      $sql = "UPDATE route_groups SET name = '$nameEsc', additional = '$additionalEsc' WHERE id = $id";
   } else {
      // Insert
      $sql = "INSERT INTO route_groups (name, additional) VALUES ('$nameEsc', '$additionalEsc')";
   }

   if ($db2->query($sql)) {
      $newId = $id > 0 ? $id : $db2->insert_id;
      echo json_encode(['ok' => true, 'id' => $newId]);
   } else {
      logDebug("save_group error", $db2->error);
      echo json_encode(['ok' => false, 'error' => 'Помилка збереження: ' . $db2->error]);
   }
   exit;
}

if ($action === 'delete_group' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $id = intval($_POST['id'] ?? 0);

   if ($id <= 0) {
      echo json_encode(['ok' => false, 'error' => 'Невірний ID']);
      exit;
   }

   // Каскадне видалення відбувається автоматично через FK
   if ($db2->query("DELETE FROM route_groups WHERE id = $id")) {
      echo json_encode(['ok' => true]);
   } else {
      echo json_encode(['ok' => false, 'error' => $db2->error]);
   }
   exit;
}

// =====================================
// ROUTES
// =====================================

if ($action === 'search_routes') {
   $query = trim($_GET['q'] ?? '');

   if (mb_strlen($query) < 1) {
      echo json_encode(['routes' => []]);
      exit;
   }

   $escaped = $db2->real_escape_string($query);

   $sql = "SELECT r.id, r.group_id, r.name, r.route_kind, r.length_m, r.active, r.additional,
                  g.name as group_name
           FROM routes r
           LEFT JOIN route_groups g ON r.group_id = g.id
           WHERE r.name LIKE '%{$escaped}%'" . ($isClient ? " AND r.id IN ($clientRouteList)" : "") . "
           ORDER BY r.name
           LIMIT 50";

   $routes = [];
   $res = $db2->query($sql);
   if ($res) {
      while ($row = $res->fetch_assoc()) {
         $row['additional'] = $row['additional'] ? json_decode($row['additional'], true) : null;
         $routes[] = $row;
      }
      $res->free();
   }

   echo json_encode(['routes' => $routes]);
   exit;
}

if ($action === 'get_routes') {
   $groupId = intval($_GET['group_id'] ?? 0);

   $routes = [];
   $conds = [];
   if ($groupId > 0) $conds[] = "group_id = $groupId";
   if ($isClient) $conds[] = "id IN ($clientRouteList)";
   $where = $conds ? "WHERE " . implode(' AND ', $conds) : "";

   $sql = "SELECT id, group_id, name, route_kind, ST_AsText(geom) as geom_wkt, length_m, active, additional, created_at 
            FROM routes $where ORDER BY name";

   $res = $db2->query($sql);
   if ($res) {
      while ($row = $res->fetch_assoc()) {
         // Парсимо LINESTRING WKT в масив координат
         $row['coordinates'] = parseLineStringWKT($row['geom_wkt']);
         unset($row['geom_wkt']);
         $row['additional'] = $row['additional'] ? json_decode($row['additional'], true) : null;
         $routes[] = $row;
      }
      $res->free();
   }

   echo json_encode(['routes' => $routes]);
   exit;
}

if ($action === 'get_route') {
   $id = intval($_GET['id'] ?? 0);

   if ($id <= 0) {
      echo json_encode(['error' => 'Невірний ID']);
      exit;
   }
   if (!authCanAccessRoute($currentUser, $id)) {
      echo json_encode(['error' => 'Маршрут не знайдено']);
      exit;
   }

   $sql = "SELECT r.id, r.group_id, r.name, r.route_kind, ST_AsText(r.geom) as geom_wkt, r.length_m, r.active, r.additional, r.created_at,
                   g.name as group_name
            FROM routes r
            LEFT JOIN route_groups g ON r.group_id = g.id
            WHERE r.id = $id";

   $res = $db2->query($sql);
   if ($res && $row = $res->fetch_assoc()) {
      $row['coordinates'] = parseLineStringWKT($row['geom_wkt']);
      unset($row['geom_wkt']);
      $row['additional'] = $row['additional'] ? json_decode($row['additional'], true) : null;

      // Отримуємо зупинки маршруту
      $stops = [];
      $stopsRes = $db2->query("SELECT id, name, ST_AsText(geom) as geom_wkt, radius_m, order_index, active 
                                  FROM stops WHERE route_id = $id ORDER BY order_index");
      if ($stopsRes) {
         while ($stop = $stopsRes->fetch_assoc()) {
            $stop['coordinates'] = parsePointWKT($stop['geom_wkt']);
            unset($stop['geom_wkt']);
            $stops[] = $stop;
         }
         $stopsRes->free();
      }
      $row['stops'] = $stops;

      // Отримуємо зони маршруту
      $zones = [];
      $zonesRes = $db2->query("SELECT id, type, name, ST_AsText(geom) as geom_wkt, radius_m, active 
                                  FROM zones WHERE route_id = $id");
      if ($zonesRes) {
         while ($zone = $zonesRes->fetch_assoc()) {
            $zone['geometry'] = parseGeometryWKT($zone['geom_wkt']);
            unset($zone['geom_wkt']);
            $zones[] = $zone;
         }
         $zonesRes->free();
      }
      $row['zones'] = $zones;

      // Отримуємо інформацію про прив'язані маршрути (для панелі властивостей)
      $linkedRoutes = [];
      $linkedIds = [];
      if (is_array($row['additional']) && !empty($row['additional']['linked_route_ids']) && is_array($row['additional']['linked_route_ids'])) {
         foreach ($row['additional']['linked_route_ids'] as $lid) {
            $lid = intval($lid);
            if ($lid > 0 && $lid !== intval($id) && authCanAccessRoute($currentUser, $lid)) $linkedIds[$lid] = $lid;
         }
      }
      if (!empty($linkedIds)) {
         $inClause = implode(',', array_map('intval', $linkedIds));
         $lRes = $db2->query("SELECT id, name, route_kind, active FROM routes WHERE id IN ($inClause)");
         if ($lRes) {
            while ($lRow = $lRes->fetch_assoc()) {
               $linkedRoutes[] = $lRow;
            }
            $lRes->free();
         }
      }
      $row['linked_routes'] = $linkedRoutes;

      echo json_encode(['route' => $row]);
   } else {
      echo json_encode(['error' => 'Маршрут не знайдено']);
   }
   exit;
}

if ($action === 'save_route' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $id = intval($_POST['id'] ?? 0);
   $groupId = intval($_POST['group_id'] ?? 0);
   $name = trim($_POST['name'] ?? '');
   $active = intval($_POST['active'] ?? 1);
   $coordinates = $_POST['coordinates'] ?? ''; // JSON масив [[lat, lng], ...]
   $additional = $_POST['additional'] ?? ''; // JSON з кольором та іншими даними
   $routeKind = $_POST['route_kind'] ?? 'city';
   if (!in_array($routeKind, ['city', 'intercity'], true)) {
      $routeKind = 'city';
   }

   if ($name === '' || $groupId <= 0) {
      echo json_encode(['ok' => false, 'error' => 'Назва та група обов\'язкові']);
      exit;
   }

   $nameEsc = $db2->real_escape_string($name);

   // Зберігаємо зв'язки маршрутів (linked_route_ids / inverse_route_id) при оновленні,
   // навіть якщо клієнт передав лише {color}
   $incomingAdd = json_decode($additional ?: '{}', true);
   if (!is_array($incomingAdd)) $incomingAdd = [];
   if ($id > 0) {
      $existRes = $db2->query("SELECT additional FROM routes WHERE id = $id LIMIT 1");
      if ($existRes && $existRow = $existRes->fetch_assoc()) {
         $existAdd = json_decode($existRow['additional'] ?? '', true);
         if (is_array($existAdd)) {
            foreach (['linked_route_ids', 'inverse_route_id'] as $linkKey) {
               if (!array_key_exists($linkKey, $incomingAdd) && array_key_exists($linkKey, $existAdd)) {
                  $incomingAdd[$linkKey] = $existAdd[$linkKey];
               }
            }
         }
      }
   }
   $additional = json_encode($incomingAdd, JSON_UNESCAPED_UNICODE);
   $additionalEsc = $db2->real_escape_string($additional);
   $routeKindEsc = $db2->real_escape_string($routeKind);

   // Конвертуємо координати в LINESTRING (якщо передані)
   $coords = json_decode($coordinates, true);
   $hasGeometry = is_array($coords) && count($coords) >= 2;
   $geomSql = 'NULL';
   $lengthM = 0;

   if ($hasGeometry) {
      $points = [];
      for ($i = 0; $i < count($coords); $i++) {
         $lat = floatval($coords[$i][0]);
         $lng = floatval($coords[$i][1]);
         $points[] = "$lng $lat"; // WKT формат: lng lat

         // Обчислюємо довжину
         if ($i > 0) {
            $lengthM += haversineDistance(
               floatval($coords[$i - 1][0]),
               floatval($coords[$i - 1][1]),
               $lat,
               $lng
            );
         }
      }
      $wkt = "LINESTRING(" . implode(", ", $points) . ")";
      $geomSql = "ST_GeomFromText('$wkt')";
      $lengthM = round($lengthM);
   }

   if ($id > 0) {
      // Update — метадані завжди, геометрію тільки якщо передані координати
      $setParts = [
         "group_id = $groupId",
         "name = '$nameEsc'",
         "route_kind = '$routeKindEsc'",
         "active = $active",
         "additional = '$additionalEsc'"
      ];

      if ($hasGeometry) {
         $setParts[] = "geom = $geomSql";
         $setParts[] = "length_m = $lengthM";
      }

      $sql = "UPDATE routes SET " . implode(', ', $setParts) . " WHERE id = $id";
   } else {
      // Insert
      $sql = "INSERT INTO routes (group_id, name, route_kind, geom, length_m, active, additional) 
                VALUES ($groupId, '$nameEsc', '$routeKindEsc', $geomSql, $lengthM, $active, '$additionalEsc')";
   }

   if ($db2->query($sql)) {
      $newId = $id > 0 ? $id : $db2->insert_id;
      echo json_encode(['ok' => true, 'id' => $newId, 'length_m' => $lengthM]);
   } else {
      logDebug("save_route error", $db2->error);
      echo json_encode(['ok' => false, 'error' => 'Помилка збереження: ' . $db2->error]);
   }
   exit;
}

if ($action === 'delete_route' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $id = intval($_POST['id'] ?? 0);

   if ($id <= 0) {
      echo json_encode(['ok' => false, 'error' => 'Невірний ID']);
      exit;
   }

   // Знімаємо посилання на цей маршрут у пов'язаних маршрутів (inverse_route_id, linked_route_ids)
   routeUnlinkBeforeDelete($db2, $id);

   // Видаляємо пов'язані зони та зупинки
   $db2->query("DELETE FROM zones WHERE route_id = $id");
   $db2->query("DELETE FROM stops WHERE route_id = $id");

   if ($db2->query("DELETE FROM routes WHERE id = $id")) {
      echo json_encode(['ok' => true]);
   } else {
      echo json_encode(['ok' => false, 'error' => $db2->error]);
   }
   exit;
}

// =====================================
// ROUTE LINKING / INVERSE
// =====================================

// Створює інверсний (зворотний) маршрут: реверс геометрії, зупинок; копіює зони;
// взаємно прив'язує новий та вихідний маршрут.
if ($action === 'create_inverse' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $srcId = intval($_POST['route_id'] ?? 0);
   $customName = trim($_POST['name'] ?? '');

   if ($srcId <= 0) {
      echo json_encode(['ok' => false, 'error' => 'Невірний ID маршруту']);
      exit;
   }

   $srcRes = $db2->query(
      "SELECT id, group_id, name, route_kind, ST_AsText(geom) as geom_wkt, active, additional
       FROM routes WHERE id = $srcId LIMIT 1"
   );
   if (!$srcRes || !($src = $srcRes->fetch_assoc())) {
      echo json_encode(['ok' => false, 'error' => 'Маршрут не знайдено']);
      exit;
   }

   // У маршруту може бути лише один прив'язаний (зворотний) маршрут
   $srcAddCheck = json_decode($src['additional'] ?? '', true);
   if (is_array($srcAddCheck)
      && ((isset($srcAddCheck['linked_route_ids']) && is_array($srcAddCheck['linked_route_ids']) && !empty(array_filter($srcAddCheck['linked_route_ids'])))
         || !empty($srcAddCheck['inverse_route_id']))) {
      echo json_encode(['ok' => false, 'error' => 'У цього маршруту вже є зворотний маршрут']);
      exit;
   }

   $srcCoords = parseLineStringWKT($src['geom_wkt']); // [[lat,lng], ...]
   if (count($srcCoords) < 2) {
      echo json_encode(['ok' => false, 'error' => 'У вихідного маршруту немає геометрії']);
      exit;
   }

   // Реверс геометрії
   $revCoords = array_reverse($srcCoords);
   $lengthM = 0;
   $wkt = buildLineStringWKT($revCoords, $lengthM);
   $geomSql = "ST_GeomFromText('$wkt')";

   $newName = $customName !== '' ? $customName : ($src['name'] . ' (зворотний)');
   $newNameEsc = $db2->real_escape_string($newName);

   $groupId = intval($src['group_id']);
   $routeKind = $src['route_kind'] === 'intercity' ? 'intercity' : 'city';
   $routeKindEsc = $db2->real_escape_string($routeKind);
   $active = intval($src['active']);

   // additional нового маршруту: копіюємо кольори тощо, встановлюємо зв'язки
   $srcAdd = json_decode($src['additional'] ?? '', true);
   if (!is_array($srcAdd)) $srcAdd = [];
   $newAdd = $srcAdd;
   $newAdd['inverse_route_id'] = $srcId;
   $newAdd['linked_route_ids'] = [$srcId];
   $newAddJson = $db2->real_escape_string(json_encode($newAdd, JSON_UNESCAPED_UNICODE));

   $insSql = "INSERT INTO routes (group_id, name, route_kind, geom, length_m, active, additional)
              VALUES ($groupId, '$newNameEsc', '$routeKindEsc', $geomSql, $lengthM, $active, '$newAddJson')";
   if (!$db2->query($insSql)) {
      logDebug("create_inverse insert error", $db2->error);
      echo json_encode(['ok' => false, 'error' => 'Помилка створення маршруту: ' . $db2->error]);
      exit;
   }
   $newId = $db2->insert_id;

   // Копіюємо зупинки у зворотному порядку
   $stopRows = [];
   $stopsRes = $db2->query(
      "SELECT name, ST_AsText(geom) as geom_wkt, radius_m, active
       FROM stops WHERE route_id = $srcId ORDER BY order_index ASC"
   );
   if ($stopsRes) {
      while ($s = $stopsRes->fetch_assoc()) $stopRows[] = $s;
      $stopsRes->free();
   }
   $stopRows = array_reverse($stopRows);
   $orderIndex = 1;
   foreach ($stopRows as $s) {
      $pt = parsePointWKT($s['geom_wkt']); // [lat, lng]
      if (!$pt) continue;
      $lat = floatval($pt[0]);
      $lng = floatval($pt[1]);
      $sNameEsc = $db2->real_escape_string($s['name']);
      $sRadius = intval($s['radius_m']);
      $sActive = intval($s['active']);
      $sGeom = "ST_GeomFromText('POINT($lng $lat)', 4326)";
      $db2->query(
         "INSERT INTO stops (route_id, name, geom, radius_m, order_index, active)
          VALUES ($newId, '$sNameEsc', $sGeom, $sRadius, $orderIndex, $sActive)"
      );
      $orderIndex++;
   }

   // Копіюємо зони (геометрія без змін)
   $zonesRes = $db2->query(
      "SELECT type, name, ST_AsText(geom) as geom_wkt, radius_m, active
       FROM zones WHERE route_id = $srcId"
   );
   if ($zonesRes) {
      while ($z = $zonesRes->fetch_assoc()) {
         $zTypeEsc = $db2->real_escape_string($z['type']);
         $zNameEsc = $db2->real_escape_string($z['name']);
         $zActive = intval($z['active']);
         $zRadiusSql = ($z['radius_m'] === null || $z['radius_m'] === '') ? 'NULL' : intval($z['radius_m']);
         $zGeomSql = $z['geom_wkt'] ? "ST_GeomFromText('" . $db2->real_escape_string($z['geom_wkt']) . "', 4326)" : 'NULL';
         $db2->query(
            "INSERT INTO zones (type, name, route_id, geom, radius_m, active)
             VALUES ('$zTypeEsc', '$zNameEsc', $newId, $zGeomSql, $zRadiusSql, $zActive)"
         );
      }
      $zonesRes->free();
   }

   // Взаємно прив'язуємо вихідний маршрут до нового (як інверсний)
   $srcAddUpd = json_decode($src['additional'] ?? '', true);
   if (!is_array($srcAddUpd)) $srcAddUpd = [];
   $srcAddUpd['inverse_route_id'] = $newId;
   $srcLinked = isset($srcAddUpd['linked_route_ids']) && is_array($srcAddUpd['linked_route_ids'])
      ? $srcAddUpd['linked_route_ids'] : [];
   $srcLinked[] = $newId;
   $srcAddUpd['linked_route_ids'] = linkUniqueInts($srcLinked);
   routeSaveAdditional($db2, $srcId, $srcAddUpd);

   echo json_encode(['ok' => true, 'id' => $newId, 'name' => $newName, 'length_m' => $lengthM]);
   exit;
}

// Взаємно прив'язує два маршрути (опційно як інверсні один до одного)
if ($action === 'link_route' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $aId = intval($_POST['route_id'] ?? 0);
   $bId = intval($_POST['other_id'] ?? 0);
   $inverse = ($_POST['inverse'] ?? '') === '1';

   if ($aId <= 0 || $bId <= 0 || $aId === $bId) {
      echo json_encode(['ok' => false, 'error' => 'Невірні ID маршрутів']);
      exit;
   }

   $aAdd = routeGetAdditional($db2, $aId);
   $bAdd = routeGetAdditional($db2, $bId);
   if ($aAdd === null || $bAdd === null) {
      echo json_encode(['ok' => false, 'error' => 'Маршрут не знайдено']);
      exit;
   }

   // У маршруту може бути лише один прив'язаний маршрут
   $aExisting = isset($aAdd['linked_route_ids']) && is_array($aAdd['linked_route_ids']) ? array_values(array_filter($aAdd['linked_route_ids'])) : [];
   $bExisting = isset($bAdd['linked_route_ids']) && is_array($bAdd['linked_route_ids']) ? array_values(array_filter($bAdd['linked_route_ids'])) : [];
   if (!empty($aExisting) && !in_array($bId, array_map('intval', $aExisting), true)) {
      echo json_encode(['ok' => false, 'error' => 'У цього маршруту вже є прив\'язаний маршрут']);
      exit;
   }
   if (!empty($bExisting) && !in_array($aId, array_map('intval', $bExisting), true)) {
      echo json_encode(['ok' => false, 'error' => 'У обраного маршруту вже є прив\'язаний маршрут']);
      exit;
   }

   $aLinked = isset($aAdd['linked_route_ids']) && is_array($aAdd['linked_route_ids']) ? $aAdd['linked_route_ids'] : [];
   $aLinked[] = $bId;
   $aAdd['linked_route_ids'] = linkUniqueInts($aLinked);

   $bLinked = isset($bAdd['linked_route_ids']) && is_array($bAdd['linked_route_ids']) ? $bAdd['linked_route_ids'] : [];
   $bLinked[] = $aId;
   $bAdd['linked_route_ids'] = linkUniqueInts($bLinked);

   if ($inverse) {
      $aAdd['inverse_route_id'] = $bId;
      $bAdd['inverse_route_id'] = $aId;
   }

   routeSaveAdditional($db2, $aId, $aAdd);
   routeSaveAdditional($db2, $bId, $bAdd);

   echo json_encode(['ok' => true]);
   exit;
}

// Взаємно відв'язує два маршрути
if ($action === 'unlink_route' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $aId = intval($_POST['route_id'] ?? 0);
   $bId = intval($_POST['other_id'] ?? 0);

   if ($aId <= 0 || $bId <= 0) {
      echo json_encode(['ok' => false, 'error' => 'Невірні ID маршрутів']);
      exit;
   }

   $aAdd = routeGetAdditional($db2, $aId);
   if ($aAdd !== null) {
      if (isset($aAdd['linked_route_ids']) && is_array($aAdd['linked_route_ids'])) {
         $aAdd['linked_route_ids'] = linkRemoveInt($aAdd['linked_route_ids'], $bId);
      }
      if (isset($aAdd['inverse_route_id']) && intval($aAdd['inverse_route_id']) === $bId) {
         unset($aAdd['inverse_route_id']);
      }
      routeSaveAdditional($db2, $aId, $aAdd);
   }

   $bAdd = routeGetAdditional($db2, $bId);
   if ($bAdd !== null) {
      if (isset($bAdd['linked_route_ids']) && is_array($bAdd['linked_route_ids'])) {
         $bAdd['linked_route_ids'] = linkRemoveInt($bAdd['linked_route_ids'], $aId);
      }
      if (isset($bAdd['inverse_route_id']) && intval($bAdd['inverse_route_id']) === $aId) {
         unset($bAdd['inverse_route_id']);
      }
      routeSaveAdditional($db2, $bId, $bAdd);
   }

   echo json_encode(['ok' => true]);
   exit;
}

// =====================================
// STOPS
// =====================================

if ($action === 'save_stop' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $id = intval($_POST['id'] ?? 0);
   $routeId = intval($_POST['route_id'] ?? 0);
   $name = trim($_POST['name'] ?? '');
   $lat = floatval($_POST['lat'] ?? 0);
   $lng = floatval($_POST['lng'] ?? 0);
   $radiusM = intval($_POST['radius_m'] ?? 20);
   $orderIndex = intval($_POST['order_index'] ?? 0);
   $active = isset($_POST['active']) ? 1 : 0;

   if ($routeId <= 0 || $name === '' || $lat == 0 || $lng == 0) {
      echo json_encode(['ok' => false, 'error' => 'Всі поля обов\'язкові']);
      exit;
   }

   $nameEsc = $db2->real_escape_string($name);
   $geomSql = "ST_GeomFromText('POINT($lng $lat)', 4326)";

   if ($id > 0) {
      $sql = "UPDATE stops SET 
                    name = '$nameEsc', 
                    geom = $geomSql,
                    radius_m = $radiusM,
                    order_index = $orderIndex,
                    active = $active 
                WHERE id = $id";
   } else {
      // Автоматично визначаємо order_index
      if ($orderIndex == 0) {
         $maxRes = $db2->query("SELECT MAX(order_index) as max_order FROM stops WHERE route_id = $routeId");
         if ($maxRes && $maxRow = $maxRes->fetch_assoc()) {
            $orderIndex = intval($maxRow['max_order']) + 1;
         }
      }

      $sql = "INSERT INTO stops (route_id, name, geom, radius_m, order_index, active) 
                VALUES ($routeId, '$nameEsc', $geomSql, $radiusM, $orderIndex, $active)";
   }

   if ($db2->query($sql)) {
      $newId = $id > 0 ? $id : $db2->insert_id;
      echo json_encode(['ok' => true, 'id' => $newId, 'order_index' => $orderIndex]);
   } else {
      echo json_encode(['ok' => false, 'error' => $db2->error]);
   }
   exit;
}

if ($action === 'delete_stop' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $id = intval($_POST['id'] ?? 0);

   $routeId = null;
   $routeRes = $db2->query("SELECT route_id FROM stops WHERE id = $id LIMIT 1");
   if ($routeRes && ($routeRow = $routeRes->fetch_assoc())) {
      $routeId = intval($routeRow['route_id']);
      $routeRes->free();
   }

   if ($db2->query("DELETE FROM stops WHERE id = $id")) {
      if ($routeId) {
         cleanupRouteTariffPairs($db2, $db3, $routeId);
      }
      echo json_encode(['ok' => true]);
   } else {
      echo json_encode(['ok' => false, 'error' => $db2->error]);
   }
   exit;
}

// =====================================
// ZONES
// =====================================

if ($action === 'get_zones') {
   $routeId = isset($_GET['route_id']) ? intval($_GET['route_id']) : null;
   $type = $_GET['type'] ?? null;
   $typesRaw = $_GET['types'] ?? null;
   $isGlobal = isset($_GET['is_global']) ? intval($_GET['is_global']) : null;

   $where = [];
   if ($routeId !== null) $where[] = "route_id = $routeId";
   if ($isClient) $where[] = "route_id IN ($clientRouteList)";
   if ($typesRaw !== null && $typesRaw !== '') {
      $typeParts = array_filter(array_map('trim', explode(',', $typesRaw)));
      $typeEscList = [];
      foreach ($typeParts as $tp) {
         $typeEscList[] = "'" . $db2->real_escape_string($tp) . "'";
      }
      if (!empty($typeEscList)) {
         $where[] = 'type IN (' . implode(', ', $typeEscList) . ')';
      }
   } elseif ($type !== null) {
      $where[] = "type = '" . $db2->real_escape_string($type) . "'";
   }
   if ($isGlobal !== null) $where[] = "is_global = " . ($isGlobal ? 1 : 0);

   $whereClause = !empty($where) ? "WHERE " . implode(" AND ", $where) : "";

   $zones = [];
   $res = $db2->query("SELECT id, type, name, route_id, ST_AsText(geom) as geom_wkt, radius_m, active, is_global 
                         FROM zones $whereClause ORDER BY name");
   if ($res) {
      while ($row = $res->fetch_assoc()) {
         $row['geometry'] = parseGeometryWKT($row['geom_wkt']);
         unset($row['geom_wkt']);
         $zones[] = $row;
      }
      $res->free();
   }

   echo json_encode(['zones' => $zones]);
   exit;
}

if ($action === 'save_zone' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $id = intval($_POST['id'] ?? 0);
   $type = $_POST['type'] ?? 'custom';
   $name = trim($_POST['name'] ?? '');
   $routeId = !empty($_POST['route_id']) ? intval($_POST['route_id']) : null;
   $geometry = $_POST['geometry'] ?? ''; // JSON: {type: 'circle'|'polygon', coords: [...], radius?: n}
   $active = intval($_POST['active'] ?? 1);
   $isGlobal = isset($_POST['is_global']) ? (intval($_POST['is_global']) ? 1 : 0) : 0;

   // Глобальні зони не прив'язуються до маршруту
   if ($isGlobal) {
      $routeId = null;
   }

   if ($name === '' || $geometry === '') {
      echo json_encode(['ok' => false, 'error' => 'Назва та геометрія обов\'язкові']);
      exit;
   }

   $geomData = json_decode($geometry, true);
   $geomSql = 'NULL';
   $radiusM = null;

   if ($geomData['type'] === 'circle') {
      // Зберігаємо як POINT з радіусом
      $lat = floatval($geomData['center'][0]);
      $lng = floatval($geomData['center'][1]);
      $radiusM = intval($geomData['radius']);
      $geomSql = "ST_GeomFromText('POINT($lng $lat)', 4326)";
   } elseif ($geomData['type'] === 'polygon') {
      // Зберігаємо як POLYGON
      $coords = $geomData['coords'];
      if (is_array($coords) && count($coords) >= 3) {
         $points = [];
         foreach ($coords as $c) {
            $points[] = floatval($c[1]) . " " . floatval($c[0]); // lng lat
         }
         // Замикаємо полігон
         $points[] = $points[0];
         $wkt = "POLYGON((" . implode(", ", $points) . "))";
         $geomSql = "ST_GeomFromText('$wkt', 4326)";
      }
   }

   $nameEsc = $db2->real_escape_string($name);
   $typeEsc = $db2->real_escape_string($type);
   $routeIdSql = $routeId ? $routeId : 'NULL';
   $radiusSql = $radiusM !== null ? $radiusM : 'NULL';

   if ($id > 0) {
      $sql = "UPDATE zones SET 
                    type = '$typeEsc',
                    name = '$nameEsc',
                    route_id = $routeIdSql,
                    geom = $geomSql,
                    radius_m = $radiusSql,
                    active = $active,
                    is_global = $isGlobal 
                WHERE id = $id";
   } else {
      $sql = "INSERT INTO zones (type, name, route_id, geom, radius_m, active, is_global) 
                VALUES ('$typeEsc', '$nameEsc', $routeIdSql, $geomSql, $radiusSql, $active, $isGlobal)";
   }

   if ($db2->query($sql)) {
      $newId = $id > 0 ? $id : $db2->insert_id;
      echo json_encode(['ok' => true, 'id' => $newId]);
   } else {
      echo json_encode(['ok' => false, 'error' => $db2->error]);
   }
   exit;
}

if ($action === 'delete_zone' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $id = intval($_POST['id'] ?? 0);

   if ($db2->query("DELETE FROM zones WHERE id = $id")) {
      echo json_encode(['ok' => true]);
   } else {
      echo json_encode(['ok' => false, 'error' => $db2->error]);
   }
   exit;
}

// =====================================
// HELPER FUNCTIONS
// =====================================

/**
 * Парсинг LINESTRING WKT в масив координат
 */
function parseLineStringWKT($wkt)
{
   if (empty($wkt)) return [];

   // LINESTRING(lng1 lat1, lng2 lat2, ...)
   if (preg_match('/LINESTRING\s*\((.+)\)/i', $wkt, $matches)) {
      $coords = [];
      $pairs = explode(',', $matches[1]);
      foreach ($pairs as $pair) {
         $parts = preg_split('/\s+/', trim($pair));
         if (count($parts) >= 2) {
            $coords[] = [floatval($parts[1]), floatval($parts[0])]; // [lat, lng]
         }
      }
      return $coords;
   }
   return [];
}

/**
 * Парсинг POINT WKT в координати
 */
function parsePointWKT($wkt)
{
   if (empty($wkt)) return null;

   // POINT(lng lat)
   if (preg_match('/POINT\s*\(([^\)]+)\)/i', $wkt, $matches)) {
      $parts = preg_split('/\s+/', trim($matches[1]));
      if (count($parts) >= 2) {
         return [floatval($parts[1]), floatval($parts[0])]; // [lat, lng]
      }
   }
   return null;
}

/**
 * Парсинг будь-якої геометрії WKT
 */
function parseGeometryWKT($wkt)
{
   if (empty($wkt)) return null;

   if (strpos($wkt, 'POINT') === 0) {
      return ['type' => 'point', 'coordinates' => parsePointWKT($wkt)];
   }
   if (strpos($wkt, 'POLYGON') === 0) {
      // POLYGON((lng1 lat1, lng2 lat2, ...))
      if (preg_match('/POLYGON\s*\(\((.+)\)\)/i', $wkt, $matches)) {
         $coords = [];
         $pairs = explode(',', $matches[1]);
         foreach ($pairs as $pair) {
            $parts = preg_split('/\s+/', trim($pair));
            if (count($parts) >= 2) {
               $coords[] = [floatval($parts[1]), floatval($parts[0])];
            }
         }
         return ['type' => 'polygon', 'coordinates' => $coords];
      }
   }
   return null;
}

/**
 * Будує LINESTRING WKT з масиву координат [[lat,lng], ...] та рахує довжину (метри).
 */
function buildLineStringWKT($coords, &$lengthM)
{
   $points = [];
   $lengthM = 0;
   $count = count($coords);
   for ($i = 0; $i < $count; $i++) {
      $lat = floatval($coords[$i][0]);
      $lng = floatval($coords[$i][1]);
      $points[] = "$lng $lat"; // WKT: lng lat
      if ($i > 0) {
         $lengthM += haversineDistance(
            floatval($coords[$i - 1][0]),
            floatval($coords[$i - 1][1]),
            $lat,
            $lng
         );
      }
   }
   $lengthM = round($lengthM);
   return "LINESTRING(" . implode(", ", $points) . ")";
}

/**
 * Перед видаленням маршруту знімає з пов'язаних маршрутів посилання на нього.
 */
function routeUnlinkBeforeDelete($db2, $deletedId)
{
   $deletedId = intval($deletedId);
   $add = routeGetAdditional($db2, $deletedId);
   if ($add === null) {
      return;
   }

   $related = [];
   if (isset($add['linked_route_ids']) && is_array($add['linked_route_ids'])) {
      foreach ($add['linked_route_ids'] as $lid) {
         $lid = intval($lid);
         if ($lid > 0 && $lid !== $deletedId) {
            $related[$lid] = true;
         }
      }
   }
   if (!empty($add['inverse_route_id'])) {
      $inv = intval($add['inverse_route_id']);
      if ($inv > 0 && $inv !== $deletedId) {
         $related[$inv] = true;
      }
   }

   foreach (array_keys($related) as $otherId) {
      $otherAdd = routeGetAdditional($db2, $otherId);
      if ($otherAdd === null) {
         continue;
      }

      if (isset($otherAdd['linked_route_ids']) && is_array($otherAdd['linked_route_ids'])) {
         $otherAdd['linked_route_ids'] = linkRemoveInt($otherAdd['linked_route_ids'], $deletedId);
      }
      if (isset($otherAdd['inverse_route_id']) && intval($otherAdd['inverse_route_id']) === $deletedId) {
         unset($otherAdd['inverse_route_id']);
      }
      routeSaveAdditional($db2, $otherId, $otherAdd);
   }
}

/**
 * Повертає масив 'additional' маршруту або null, якщо маршрут не знайдено.
 */
function routeGetAdditional($db2, $id)
{
   $id = intval($id);
   $res = $db2->query("SELECT additional FROM routes WHERE id = $id LIMIT 1");
   if ($res && ($row = $res->fetch_assoc())) {
      $add = json_decode($row['additional'] ?? '', true);
      return is_array($add) ? $add : [];
   }
   return null;
}

/**
 * Зберігає масив 'additional' маршруту.
 */
function routeSaveAdditional($db2, $id, $add)
{
   $id = intval($id);
   $json = $db2->real_escape_string(json_encode($add, JSON_UNESCAPED_UNICODE));
   return $db2->query("UPDATE routes SET additional = '$json' WHERE id = $id");
}

/**
 * Повертає масив унікальних цілих (для linked_route_ids).
 */
function linkUniqueInts($arr)
{
   $seen = [];
   $out = [];
   foreach ($arr as $v) {
      $v = intval($v);
      if ($v > 0 && !isset($seen[$v])) {
         $seen[$v] = true;
         $out[] = $v;
      }
   }
   return $out;
}

/**
 * Видаляє ціле значення з масиву id.
 */
function linkRemoveInt($arr, $remove)
{
   $remove = intval($remove);
   $out = [];
   foreach ($arr as $v) {
      if (intval($v) !== $remove) $out[] = intval($v);
   }
   return $out;
}

/**
 * Haversine distance між двома точками (в метрах)
 */
function haversineDistance($lat1, $lon1, $lat2, $lon2)
{
   $R = 6371000; // Earth radius in meters
   $dLat = deg2rad($lat2 - $lat1);
   $dLon = deg2rad($lon2 - $lon1);
   $a = sin($dLat / 2) * sin($dLat / 2) +
      cos(deg2rad($lat1)) * cos(deg2rad($lat2)) *
      sin($dLon / 2) * sin($dLon / 2);
   $c = 2 * atan2(sqrt($a), sqrt(1 - $a));
   return $R * $c;
}

// Unknown action
logDebug("Unknown action", ['action' => $action]);
echo json_encode(['error' => 'Невідома дія: ' . $action]);
