<?php

/**
 * Tariffs API — тарифи маршрутів (БД PassengersFlowCounting).
 *
 * Маршрути та зупинки читаються з БД RoutesAndAdvertisement ($db2),
 * тарифи зберігаються у БД PassengersFlowCounting ($db3, таблиця tariffs).
 *
 * Формат поля prices (JSON):
 *   - місто:     {"kind":"city","price":20}
 *   - міжмісто:  {"kind":"intercity","pairs":{"<stopIdMin>-<stopIdMax>":25, ...}}
 */

ini_set('error_reporting', E_ALL);
ini_set('display_errors', 0);
ini_set('display_startup_errors', 0);
date_default_timezone_set('Europe/Kiev');

require_once __DIR__ . '/../includes/auth.php';
authRequireApi(['admin', 'routes_track']);

require_once __DIR__ . "/../includes/tariff_helpers.php";

header('Content-Type: application/json; charset=utf-8');

function logTariff($msg, $context = null)
{
   $file = dirname(__DIR__) . '/debug.log';
   $t = date('Y-m-d H:i:s');
   $ctx = $context !== null ? ' ' . json_encode($context, JSON_UNESCAPED_UNICODE) : '';
   file_put_contents($file, "[$t] tariffs_api: $msg$ctx" . PHP_EOL, FILE_APPEND);
}

$action = $_GET['action'] ?? $_POST['action'] ?? '';

if (!$db2) {
   logTariff("DB2 connection failed");
   echo json_encode(['error' => 'Помилка підключення до бази RoutesAndAdvertisement']);
   exit;
}
if (!$db3) {
   logTariff("DB3 connection failed");
   echo json_encode(['error' => 'Помилка підключення до бази PassengersFlowCounting']);
   exit;
}

// =====================================
// LIST: всі маршрути + їхні тарифи
// =====================================

if ($action === 'get_routes_with_tariffs') {
   // Тарифи згруповані за route_id
   $tariffsByRoute = [];
   $tRes = $db3->query("SELECT id, route_id, name, prices FROM tariffs ORDER BY name");
   if ($tRes) {
      while ($t = $tRes->fetch_assoc()) {
         $rid = intval($t['route_id']);
         $tariffsByRoute[$rid][] = [
            'id' => intval($t['id']),
            'route_id' => $rid,
            'name' => $t['name'],
            'prices' => $t['prices'] ? json_decode($t['prices'], true) : null,
         ];
      }
      $tRes->free();
   }

   $routes = [];
   $rRes = $db2->query(
      "SELECT r.id, r.name, r.route_kind, r.length_m, r.active, g.name AS group_name,
              (SELECT COUNT(*) FROM stops s WHERE s.route_id = r.id) AS stops_count
       FROM routes r
       LEFT JOIN route_groups g ON r.group_id = g.id
       ORDER BY g.name, r.name"
   );
   if ($rRes) {
      while ($row = $rRes->fetch_assoc()) {
         $rid = intval($row['id']);
         $routes[] = [
            'id' => $rid,
            'name' => $row['name'],
            'route_kind' => $row['route_kind'] ?: 'city',
            'length_m' => intval($row['length_m']),
            'active' => intval($row['active']),
            'group_name' => $row['group_name'],
            'stops_count' => intval($row['stops_count']),
            'tariffs' => $tariffsByRoute[$rid] ?? [],
         ];
      }
      $rRes->free();
   }

   echo json_encode(['routes' => $routes]);
   exit;
}

// =====================================
// Деталі маршруту: геометрія + зупинки
// =====================================

if ($action === 'get_route') {
   $id = intval($_GET['id'] ?? 0);
   if ($id <= 0) {
      echo json_encode(['error' => 'Невірний ID']);
      exit;
   }

   $sql = "SELECT r.id, r.name, r.route_kind, ST_AsText(r.geom) AS geom_wkt, r.length_m, r.active,
                  r.additional, g.name AS group_name
           FROM routes r
           LEFT JOIN route_groups g ON r.group_id = g.id
           WHERE r.id = $id";
   $res = $db2->query($sql);
   if (!$res || !($row = $res->fetch_assoc())) {
      echo json_encode(['error' => 'Маршрут не знайдено']);
      exit;
   }

   $row['route_kind'] = $row['route_kind'] ?: 'city';
   $row['coordinates'] = parseLineStringWKT_t($row['geom_wkt']);
   unset($row['geom_wkt']);
   $row['additional'] = $row['additional'] ? json_decode($row['additional'], true) : null;

   // Зупинки в порядку проходження
   $stops = [];
   $stopsRes = $db2->query(
      "SELECT id, name, ST_AsText(geom) AS geom_wkt, radius_m, order_index, active
       FROM stops WHERE route_id = $id ORDER BY order_index"
   );
   if ($stopsRes) {
      while ($stop = $stopsRes->fetch_assoc()) {
         $stop['id'] = intval($stop['id']);
         $stop['coordinates'] = parsePointWKT_t($stop['geom_wkt']);
         unset($stop['geom_wkt']);
         $stops[] = $stop;
      }
      $stopsRes->free();
   }
   $row['stops'] = $stops;

   echo json_encode(['route' => $row]);
   exit;
}

// =====================================
// Тарифи одного маршруту
// =====================================

if ($action === 'get_tariffs') {
   $routeId = intval($_GET['route_id'] ?? 0);
   if ($routeId <= 0) {
      echo json_encode(['tariffs' => []]);
      exit;
   }

   $tariffs = [];
   $stmt = $db3->prepare("SELECT id, route_id, name, prices, created_at, updated_at FROM tariffs WHERE route_id = ? ORDER BY name");
   $stmt->bind_param('i', $routeId);
   $stmt->execute();
   $res = $stmt->get_result();
   while ($row = $res->fetch_assoc()) {
      $row['id'] = intval($row['id']);
      $row['route_id'] = intval($row['route_id']);
      $row['prices'] = $row['prices'] ? json_decode($row['prices'], true) : null;
      $tariffs[] = $row;
   }
   $stmt->close();

   echo json_encode(['tariffs' => $tariffs]);
   exit;
}

// =====================================
// Збереження тарифу
// =====================================

if ($action === 'save_tariff' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $id = intval($_POST['id'] ?? 0);
   $routeId = intval($_POST['route_id'] ?? 0);
   $name = trim($_POST['name'] ?? '');
   $pricesRaw = $_POST['prices'] ?? '';

   if ($routeId <= 0) {
      echo json_encode(['ok' => false, 'error' => 'Невірний маршрут']);
      exit;
   }
   if ($name === '') {
      echo json_encode(['ok' => false, 'error' => 'Назва тарифу обов\'язкова']);
      exit;
   }

   $prices = json_decode($pricesRaw, true);
   if (!is_array($prices) || !isset($prices['kind']) || !in_array($prices['kind'], ['city', 'intercity'], true)) {
      echo json_encode(['ok' => false, 'error' => 'Невірний формат тарифів']);
      exit;
   }

   // Нормалізація структури prices
   if ($prices['kind'] === 'city') {
      $prices = ['kind' => 'city', 'price' => round(floatval($prices['price'] ?? 0), 2)];
   } else {
      $rawPairs = isset($prices['pairs']) && is_array($prices['pairs']) ? $prices['pairs'] : [];
      $validStopIds = getRouteStopIds($db2, $routeId);
      $pairs = filterTariffPairs($rawPairs, $validStopIds);
      $prices = ['kind' => 'intercity', 'pairs' => $pairs];
   }

   $pricesJson = json_encode($prices, JSON_UNESCAPED_UNICODE);

   if ($id > 0) {
      $stmt = $db3->prepare("UPDATE tariffs SET name = ?, prices = ? WHERE id = ?");
      $stmt->bind_param('ssi', $name, $pricesJson, $id);
   } else {
      $stmt = $db3->prepare("INSERT INTO tariffs (route_id, name, prices) VALUES (?, ?, ?)");
      $stmt->bind_param('iss', $routeId, $name, $pricesJson);
   }

   if ($stmt->execute()) {
      $newId = $id > 0 ? $id : $db3->insert_id;
      $stmt->close();
      echo json_encode(['ok' => true, 'id' => $newId]);
   } else {
      $err = $stmt->error;
      $stmt->close();
      logTariff("save_tariff error", $err);
      echo json_encode(['ok' => false, 'error' => 'Помилка збереження: ' . $err]);
   }
   exit;
}

// =====================================
// Видалення тарифу
// =====================================

if ($action === 'delete_tariff' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $id = intval($_POST['id'] ?? 0);
   if ($id <= 0) {
      echo json_encode(['ok' => false, 'error' => 'Невірний ID']);
      exit;
   }

   $stmt = $db3->prepare("DELETE FROM tariffs WHERE id = ?");
   $stmt->bind_param('i', $id);
   if ($stmt->execute()) {
      $stmt->close();
      echo json_encode(['ok' => true]);
   } else {
      $err = $stmt->error;
      $stmt->close();
      echo json_encode(['ok' => false, 'error' => $err]);
   }
   exit;
}

// =====================================
// HELPERS (WKT parsing)
// =====================================

function parseLineStringWKT_t($wkt)
{
   if (empty($wkt)) return [];
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

function parsePointWKT_t($wkt)
{
   if (empty($wkt)) return null;
   if (preg_match('/POINT\s*\(([^\)]+)\)/i', $wkt, $matches)) {
      $parts = preg_split('/\s+/', trim($matches[1]));
      if (count($parts) >= 2) {
         return [floatval($parts[1]), floatval($parts[0])]; // [lat, lng]
      }
   }
   return null;
}

logTariff("Unknown action", ['action' => $action]);
echo json_encode(['error' => 'Невідома дія: ' . $action]);
