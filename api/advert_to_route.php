<?php

/**
 * Advert to Route API — прив'язка реклами до маршрутів
 * Працює з таблицями: adverts_to_routes, zones, route_groups, advertisement, routes
 */

ini_set('error_reporting', E_ALL);
ini_set('display_errors', 0);
ini_set('display_startup_errors', 0);
date_default_timezone_set('Europe/Kiev');

require_once __DIR__ . '/../includes/auth.php';
$currentUser = authRequireApi(['admin', 'advertisement', 'client']);
$isClient = authIsClient($currentUser);

header('Content-Type: application/json; charset=utf-8');

// Клієнт працює лише з призначеними йому маршрутами
function a2rRequireRoute($routeId)
{
   global $currentUser;
   if (!authCanAccessRoute($currentUser, $routeId)) {
      authDenyApi('Немає доступу до маршруту');
   }
}

// Умова для вибору реклами, яку користувач може прив'язувати (клієнт — лише власну)
function a2rOwnAdsWhere($alias = '')
{
   global $currentUser, $isClient;
   $col = ($alias !== '' ? $alias . '.' : '') . 'owner_user_id';
   return $isClient ? "$col = " . (int)$currentUser['id'] : '1';
}

function a2rLog($msg, $context = null)
{
   $file = dirname(__DIR__) . '/debug.log';
   $t = date('Y-m-d H:i:s');
   $ctx = '';
   if ($context !== null) {
      $ctx = ' ' . (is_scalar($context) ? $context : json_encode($context, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
   }
   @file_put_contents($file, "[$t] advert_to_route: $msg$ctx" . PHP_EOL, FILE_APPEND);
}

if (!$db2) {
   a2rLog("DB2 connection failed");
   echo json_encode(['error' => 'Помилка підключення до бази RoutesAndAdvertisement']);
   exit;
}

// =============================================
// Схема для розкладу за часом (створюється за потреби)
//   - route_time_schedule   — налаштування часового блоку на маршрут
//   - route_time_rotation   — цикл ротації (впорядковані позиції)
//   - adverts_to_routes.auto_generated — прапорець: 1 = згенеровано ротацією,
//     0 = ручна правка / зона / старі записи (регенерація їх не чіпає під час читання)
// =============================================
function a2rEnsureScheduleSchema(mysqli $db2)
{
   $db2->query("CREATE TABLE IF NOT EXISTS route_time_schedule (
      route_id     INT PRIMARY KEY,
      start_min    SMALLINT NOT NULL,
      end_min      SMALLINT NOT NULL,
      interval_min TINYINT  NOT NULL,
      updated_at   DATETIME
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

   $db2->query("CREATE TABLE IF NOT EXISTS route_time_rotation (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      route_id          INT NOT NULL,
      advert_id         INT NOT NULL,
      position          INT NOT NULL,
      display_per_event INT NOT NULL DEFAULT 1,
      KEY route_idx (route_id, position)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

   $chk = $db2->query("SHOW COLUMNS FROM adverts_to_routes LIKE 'auto_generated'");
   if ($chk && $chk->num_rows === 0) {
      $db2->query("ALTER TABLE adverts_to_routes ADD COLUMN auto_generated TINYINT(1) NOT NULL DEFAULT 0");
   }
   if ($chk) $chk->free();
}

// Локальні хвилини доби (UTC+3) -> час доби UTC у форматі '1970-01-01 HH:MM:00'
function a2rLocalMinToUtcTime($localMin)
{
   $t = (($localMin - 3 * 60) % (24 * 60) + (24 * 60)) % (24 * 60);
   return sprintf('1970-01-01 %02d:%02d:00', intdiv($t, 60), $t % 60);
}

// Час доби UTC ('HH:MM[:SS]' або дата) -> локальні хвилини доби (UTC+3)
function a2rUtcTimeToLocalMin($utcStr)
{
   if (!$utcStr) return null;
   $s = (string)$utcStr;
   if (preg_match('/(\d{1,2}):(\d{2})(?::\d{2})?$/', $s, $m)) {
      $h = (int)$m[1];
      $i = (int)$m[2];
      return (($h * 60 + $i + 3 * 60) % (24 * 60) + (24 * 60)) % (24 * 60);
   }
   return null;
}

const A2R_ALLOWED_INTERVALS = [2, 3, 4, 5, 7, 10];
const A2R_MAX_SLOTS = 2000;

$action = $_GET['action'] ?? $_POST['action'] ?? '';

// =============================================
// list_groups_with_routes — групи + всі маршрути
// =============================================
if ($action === 'list_groups_with_routes') {
   $groups = [];
   $byId = [];
   $res = $db2->query("SELECT id, name FROM route_groups ORDER BY name");
   if ($res) {
      while ($r = $res->fetch_assoc()) {
         $r['id'] = (int)$r['id'];
         $r['routes'] = [];
         $byId[$r['id']] = count($groups);
         $groups[] = $r;
      }
      $res->free();
   }

   // Підрахунок прив'язаних реклам по маршрутам
   $advertCounts = [];
   if ($cntRes = $db2->query("SELECT route_id, COUNT(*) AS cnt FROM adverts_to_routes GROUP BY route_id")) {
      while ($cr = $cntRes->fetch_assoc()) {
         $advertCounts[(int)$cr['route_id']] = (int)$cr['cnt'];
      }
      $cntRes->free();
   }

   $routesWhere = $isClient ? "WHERE id IN (" . authSqlIntList(authUserRouteIds($currentUser)) . ")" : "";
   $res = $db2->query("SELECT id, group_id, name, length_m, active FROM routes $routesWhere ORDER BY name");
   if ($res) {
      while ($r = $res->fetch_assoc()) {
         $gid = (int)$r['group_id'];
         $r['id'] = (int)$r['id'];
         $r['group_id'] = $gid;
         $r['length_m'] = (int)$r['length_m'];
         $r['active'] = (int)$r['active'];
         $r['adverts_count'] = isset($advertCounts[$r['id']]) ? $advertCounts[$r['id']] : 0;
         if (isset($byId[$gid])) {
            $groups[$byId[$gid]]['routes'][] = $r;
         }
      }
      $res->free();
   }

   // Клієнту не показуємо групи без його маршрутів
   if ($isClient) {
      $groups = array_values(array_filter($groups, function ($g) {
         return !empty($g['routes']);
      }));
   }

   echo json_encode(['groups' => $groups]);
   exit;
}

// =============================================
// route_adverts — реклама прив'язана до маршруту
// =============================================
if ($action === 'route_adverts') {
   $routeId = intval($_GET['route_id'] ?? 0);
   if ($routeId <= 0) {
      echo json_encode(['error' => 'Невірний route_id']);
      exit;
   }
   a2rRequireRoute($routeId);

   $sql = "SELECT atr.id, atr.route_id, atr.advert_id, atr.display_per_event,
                  atr.zone_id, atr.time_utc,
                  a.name AS advert_name, a.file AS advert_file, a.created_at AS advert_created,
                  z.name AS zone_name, z.type AS zone_type
           FROM adverts_to_routes atr
           LEFT JOIN advertisement a ON a.id = atr.advert_id
           LEFT JOIN zones z ON z.id = atr.zone_id
           WHERE atr.route_id = $routeId
           ORDER BY atr.id DESC";

   $items = [];
   if ($res = $db2->query($sql)) {
      while ($r = $res->fetch_assoc()) {
         $r['id'] = (int)$r['id'];
         $r['route_id'] = (int)$r['route_id'];
         $r['advert_id'] = (int)$r['advert_id'];
         $r['display_per_event'] = (int)$r['display_per_event'];
         $r['zone_id'] = $r['zone_id'] !== null ? (int)$r['zone_id'] : null;
         // визначаємо тип прив'язки
         if ($r['zone_id']) {
            $r['binding_type'] = 'zone';
         } elseif (!empty($r['time_utc'])) {
            $r['binding_type'] = 'time';
         } else {
            $r['binding_type'] = 'none';
         }
         $items[] = $r;
      }
      $res->free();
   } else {
      a2rLog("route_adverts query error", $db2->error);
      echo json_encode(['error' => 'Помилка читання БД']);
      exit;
   }

   echo json_encode(['items' => $items]);
   exit;
}

// =============================================
// route_zones — рекламні зони маршруту (для випадку binding=zone)
// =============================================
if ($action === 'route_zones') {
   $routeId = intval($_GET['route_id'] ?? 0);
   if ($routeId <= 0) {
      echo json_encode(['error' => 'Невірний route_id']);
      exit;
   }
   a2rRequireRoute($routeId);

   $sql = "SELECT id, name, type, radius_m, active
           FROM zones
           WHERE route_id = $routeId AND type = 'advertising'
           ORDER BY name";
   $zones = [];
   if ($res = $db2->query($sql)) {
      while ($r = $res->fetch_assoc()) {
         $r['id'] = (int)$r['id'];
         $zones[] = $r;
      }
      $res->free();
   }
   echo json_encode(['zones' => $zones]);
   exit;
}

// =============================================
// available_ads — список реклами для додавання (клієнту — лише власна)
// =============================================
if ($action === 'available_ads') {
   $ads = [];
   $sql = "SELECT id, name, file, created_at FROM advertisement WHERE " . a2rOwnAdsWhere() . " ORDER BY created_at DESC, id DESC";
   if ($res = $db2->query($sql)) {
      while ($r = $res->fetch_assoc()) {
         $r['id'] = (int)$r['id'];
         $ads[] = $r;
      }
      $res->free();
   }
   echo json_encode(['ads' => $ads]);
   exit;
}

// =============================================
// attach — прив'язати рекламу до маршруту
// =============================================
if ($action === 'attach' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $routeId = intval($_POST['route_id'] ?? 0);
   $advertId = intval($_POST['advert_id'] ?? 0);
   $bindingType = $_POST['binding_type'] ?? '';
   $displayPerEvent = max(1, intval($_POST['display_per_event'] ?? 1));
   $zoneId = !empty($_POST['zone_id']) ? intval($_POST['zone_id']) : null;
   $timeLocal = trim($_POST['time_local'] ?? ''); // "YYYY-MM-DD HH:MM" в UTC+3

   if ($routeId <= 0 || $advertId <= 0) {
      echo json_encode(['ok' => false, 'errors' => ['Невірний route_id або advert_id']]);
      exit;
   }
   a2rRequireRoute($routeId);

   // Перевірка існування (і доступності) реклами
   $r = $db2->query("SELECT id FROM advertisement WHERE id = $advertId AND " . a2rOwnAdsWhere() . " LIMIT 1");
   if (!$r || !$r->fetch_assoc()) {
      echo json_encode(['ok' => false, 'errors' => ['Рекламу не знайдено']]);
      exit;
   }
   $r->free();

   $r = $db2->query("SELECT id FROM routes WHERE id = $routeId LIMIT 1");
   if (!$r || !$r->fetch_assoc()) {
      echo json_encode(['ok' => false, 'errors' => ['Маршрут не знайдено']]);
      exit;
   }
   $r->free();

   $zoneSql = 'NULL';
   $timeSql = 'NULL';

   if ($bindingType === 'zone') {
      if (!$zoneId) {
         echo json_encode(['ok' => false, 'errors' => ['Виберіть зону']]);
         exit;
      }
      // Зона має належати маршруту і мати тип advertising
      $chk = $db2->query("SELECT id FROM zones WHERE id = $zoneId AND route_id = $routeId AND type = 'advertising' LIMIT 1");
      if (!$chk || !$chk->fetch_assoc()) {
         echo json_encode(['ok' => false, 'errors' => ['Зона не належить маршруту або не є рекламною']]);
         exit;
      }
      $chk->free();
      $zoneSql = (int)$zoneId;
   } elseif ($bindingType === 'time') {
      if ($timeLocal === '') {
         echo json_encode(['ok' => false, 'errors' => ['Вкажіть час']]);
         exit;
      }
      // Очікуємо "HH:MM" (UTC+3) — конвертуємо в UTC, дата фіксована (1970-01-01)
      if (!preg_match('/^(\d{1,2}):(\d{2})$/', $timeLocal, $m)) {
         echo json_encode(['ok' => false, 'errors' => ['Невірний формат часу. Очікується HH:MM']]);
         exit;
      }
      $h = (int)$m[1];
      $mi = (int)$m[2];
      if ($h < 0 || $h > 23 || $mi < 0 || $mi > 59) {
         echo json_encode(['ok' => false, 'errors' => ['Невірний час']]);
         exit;
      }
      // UTC+3 -> UTC: віднімаємо 3 години (за модулем доби)
      $totalMin = (($h * 60 + $mi) - 3 * 60) % (24 * 60);
      if ($totalMin < 0) $totalMin += 24 * 60;
      $hUtc = intdiv($totalMin, 60);
      $miUtc = $totalMin % 60;
      $timeUtc = sprintf('1970-01-01 %02d:%02d:00', $hUtc, $miUtc);
      $timeSql = "'" . $db2->real_escape_string($timeUtc) . "'";
   } else {
      echo json_encode(['ok' => false, 'errors' => ['Виберіть тип прив\'язки (час або зона)']]);
      exit;
   }

   $sql = "INSERT INTO adverts_to_routes (route_id, advert_id, display_per_event, zone_id, time_utc)
           VALUES ($routeId, $advertId, $displayPerEvent, $zoneSql, $timeSql)";

   if ($db2->query($sql)) {
      echo json_encode(['ok' => true, 'id' => $db2->insert_id]);
   } else {
      a2rLog("attach error", $db2->error);
      echo json_encode(['ok' => false, 'errors' => ['Помилка БД: ' . $db2->error]]);
   }
   exit;
}

// =============================================
// update — оновити існуючу прив'язку реклами до маршруту
// =============================================
if ($action === 'update' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $id = intval($_POST['id'] ?? 0);
   $bindingType = $_POST['binding_type'] ?? '';
   $displayPerEvent = max(1, intval($_POST['display_per_event'] ?? 1));
   $zoneId = !empty($_POST['zone_id']) ? intval($_POST['zone_id']) : null;
   $timeLocal = trim($_POST['time_local'] ?? '');
   $advertId = !empty($_POST['advert_id']) ? intval($_POST['advert_id']) : 0;

   if ($id <= 0) {
      echo json_encode(['ok' => false, 'errors' => ['Невірний id']]);
      exit;
   }

   // Отримуємо поточний route_id (щоб не змінювати) та перевіряємо існування
   $curRouteId = 0;
   $curAdvertId = 0;
   if ($cur = $db2->query("SELECT route_id, advert_id FROM adverts_to_routes WHERE id = $id LIMIT 1")) {
      if ($row = $cur->fetch_assoc()) {
         $curRouteId = (int)$row['route_id'];
         $curAdvertId = (int)$row['advert_id'];
      }
      $cur->free();
   }
   if ($curRouteId <= 0) {
      echo json_encode(['ok' => false, 'errors' => ['Запис не знайдено']]);
      exit;
   }
   a2rRequireRoute($curRouteId);

   // Залишити вже прив'язану рекламу можна завжди, обрати нову — лише з доступних
   if ($advertId > 0 && $advertId !== $curAdvertId) {
      $r = $db2->query("SELECT id FROM advertisement WHERE id = $advertId AND " . a2rOwnAdsWhere() . " LIMIT 1");
      if (!$r || !$r->fetch_assoc()) {
         echo json_encode(['ok' => false, 'errors' => ['Рекламу не знайдено']]);
         exit;
      }
      $r->free();
   }

   $zoneSql = 'NULL';
   $timeSql = 'NULL';

   if ($bindingType === 'zone') {
      if (!$zoneId) {
         echo json_encode(['ok' => false, 'errors' => ['Виберіть зону']]);
         exit;
      }
      $chk = $db2->query("SELECT id FROM zones WHERE id = $zoneId AND route_id = $curRouteId AND type = 'advertising' LIMIT 1");
      if (!$chk || !$chk->fetch_assoc()) {
         echo json_encode(['ok' => false, 'errors' => ['Зона не належить маршруту або не є рекламною']]);
         exit;
      }
      $chk->free();
      $zoneSql = (int)$zoneId;
   } elseif ($bindingType === 'time') {
      if ($timeLocal === '') {
         echo json_encode(['ok' => false, 'errors' => ['Вкажіть час']]);
         exit;
      }
      if (!preg_match('/^(\d{1,2}):(\d{2})$/', $timeLocal, $m)) {
         echo json_encode(['ok' => false, 'errors' => ['Невірний формат часу. Очікується HH:MM']]);
         exit;
      }
      $h = (int)$m[1];
      $mi = (int)$m[2];
      if ($h < 0 || $h > 23 || $mi < 0 || $mi > 59) {
         echo json_encode(['ok' => false, 'errors' => ['Невірний час']]);
         exit;
      }
      $totalMin = (($h * 60 + $mi) - 3 * 60) % (24 * 60);
      if ($totalMin < 0) $totalMin += 24 * 60;
      $hUtc = intdiv($totalMin, 60);
      $miUtc = $totalMin % 60;
      $timeUtc = sprintf('1970-01-01 %02d:%02d:00', $hUtc, $miUtc);
      $timeSql = "'" . $db2->real_escape_string($timeUtc) . "'";
   } else {
      echo json_encode(['ok' => false, 'errors' => ['Виберіть тип прив\'язки (час або зона)']]);
      exit;
   }

   $setParts = [
      "display_per_event = $displayPerEvent",
      "zone_id = $zoneSql",
      "time_utc = $timeSql",
   ];
   if ($advertId > 0) {
      $setParts[] = "advert_id = $advertId";
   }
   $sql = "UPDATE adverts_to_routes SET " . implode(', ', $setParts) . " WHERE id = $id";

   if ($db2->query($sql)) {
      echo json_encode(['ok' => true, 'id' => $id]);
   } else {
      a2rLog("update error", $db2->error);
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
   $bindRouteId = 0;
   if ($cur = $db2->query("SELECT route_id FROM adverts_to_routes WHERE id = $id LIMIT 1")) {
      if ($row = $cur->fetch_assoc()) $bindRouteId = (int)$row['route_id'];
      $cur->free();
   }
   if ($bindRouteId <= 0) {
      echo json_encode(['ok' => false, 'errors' => ['Запис не знайдено']]);
      exit;
   }
   a2rRequireRoute($bindRouteId);

   if ($db2->query("DELETE FROM adverts_to_routes WHERE id = $id")) {
      echo json_encode(['ok' => true]);
   } else {
      a2rLog("detach error", $db2->error);
      echo json_encode(['ok' => false, 'errors' => ['Помилка видалення']]);
   }
   exit;
}

// =============================================
// sync_from_route — скопіювати всю рекламу з source_route_id в target_route_id,
// попередньо повністю видаливши існуючу рекламу target-маршруту.
// Виконується двома батчевими запитами: DELETE + multi-row INSERT.
// =============================================
if ($action === 'sync_from_route' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $targetRouteId = intval($_POST['target_route_id'] ?? 0);
   $sourceRouteId = intval($_POST['source_route_id'] ?? 0);

   if ($targetRouteId <= 0 || $sourceRouteId <= 0) {
      echo json_encode(['ok' => false, 'errors' => ['Невірні route_id']]);
      exit;
   }
   if ($targetRouteId === $sourceRouteId) {
      echo json_encode(['ok' => false, 'errors' => ['Маршрути збігаються']]);
      exit;
   }
   a2rRequireRoute($targetRouteId);
   a2rRequireRoute($sourceRouteId);

   // Перевірка існування обох маршрутів
   $chk = $db2->query("SELECT id FROM routes WHERE id IN ($targetRouteId, $sourceRouteId)");
   $foundIds = [];
   if ($chk) {
      while ($row = $chk->fetch_assoc()) $foundIds[] = (int)$row['id'];
      $chk->free();
   }
   if (count($foundIds) < 2) {
      echo json_encode(['ok' => false, 'errors' => ['Один або обидва маршрути не знайдено']]);
      exit;
   }

   // Завантажуємо всю рекламу source-маршруту
   $rows = [];
   $sel = $db2->query("SELECT advert_id, display_per_event, zone_id, time_utc
                       FROM adverts_to_routes
                       WHERE route_id = $sourceRouteId");
   if (!$sel) {
      a2rLog("sync_from_route select error", $db2->error);
      echo json_encode(['ok' => false, 'errors' => ['Помилка читання реклам джерела']]);
      exit;
   }
   while ($r = $sel->fetch_assoc()) $rows[] = $r;
   $sel->free();

   // Якщо у source є зональні прив'язки — потрібно мапити зони на цільовий маршрут.
   // Мапінг: за іменем зони (тип advertising). Якщо для якоїсь зони з source
   // у target немає однойменної — пропускаємо такий запис (з повідомленням).
   $zoneMap = []; // sourceZoneId => targetZoneId
   $skippedZoneNames = [];
   $sourceZoneIds = [];
   foreach ($rows as $r) {
      if (!empty($r['zone_id'])) $sourceZoneIds[(int)$r['zone_id']] = true;
   }
   if (!empty($sourceZoneIds)) {
      $idsList = implode(',', array_map('intval', array_keys($sourceZoneIds)));
      $zRes = $db2->query("SELECT id, name FROM zones WHERE id IN ($idsList) AND type = 'advertising'");
      $sourceZones = [];
      if ($zRes) {
         while ($zr = $zRes->fetch_assoc()) $sourceZones[(int)$zr['id']] = $zr['name'];
         $zRes->free();
      }
      // Зони цільового маршруту за ім'ям
      $tRes = $db2->query("SELECT id, name FROM zones WHERE route_id = $targetRouteId AND type = 'advertising'");
      $targetByName = [];
      if ($tRes) {
         while ($tr = $tRes->fetch_assoc()) $targetByName[$tr['name']] = (int)$tr['id'];
         $tRes->free();
      }
      foreach ($sourceZones as $sId => $sName) {
         if (isset($targetByName[$sName])) {
            $zoneMap[$sId] = $targetByName[$sName];
         } else {
            $skippedZoneNames[] = $sName;
         }
      }
   }

   // Будуємо values для batch INSERT
   $values = [];
   $skippedCount = 0;
   foreach ($rows as $r) {
      $advertId = (int)$r['advert_id'];
      $dpe = max(1, (int)$r['display_per_event']);
      $zoneId = $r['zone_id'] !== null ? (int)$r['zone_id'] : null;
      $timeUtc = $r['time_utc'];

      $zoneSql = 'NULL';
      if ($zoneId) {
         if (isset($zoneMap[$zoneId])) {
            $zoneSql = (int)$zoneMap[$zoneId];
         } else {
            $skippedCount++;
            continue;
         }
      }
      $timeSql = $timeUtc !== null && $timeUtc !== '' ? "'" . $db2->real_escape_string($timeUtc) . "'" : 'NULL';

      $values[] = "($targetRouteId, $advertId, $dpe, $zoneSql, $timeSql)";
   }

   // Запит 1: видалити всю рекламу цільового маршруту (батч)
   if (!$db2->query("DELETE FROM adverts_to_routes WHERE route_id = $targetRouteId")) {
      a2rLog("sync_from_route delete error", $db2->error);
      echo json_encode(['ok' => false, 'errors' => ['Помилка видалення: ' . $db2->error]]);
      exit;
   }

   // Запит 2: один INSERT з усіма рядками (батч)
   $inserted = 0;
   if (!empty($values)) {
      $sql = "INSERT INTO adverts_to_routes (route_id, advert_id, display_per_event, zone_id, time_utc) VALUES "
         . implode(', ', $values);
      if (!$db2->query($sql)) {
         a2rLog("sync_from_route insert error", $db2->error);
         echo json_encode(['ok' => false, 'errors' => ['Помилка вставки: ' . $db2->error]]);
         exit;
      }
      $inserted = $db2->affected_rows;
   }

   echo json_encode([
      'ok' => true,
      'inserted' => $inserted,
      'skipped' => $skippedCount,
      'skipped_zones' => array_values(array_unique($skippedZoneNames)),
   ]);
   exit;
}

// =============================================
// get_time_schedule — налаштування часового блоку маршруту:
//   { schedule: {start_min,end_min,interval_min} | null,
//     rotation: [ {advert_id, display_per_event, advert_name, advert_file} ],  // по position
//     overrides: [ {slot_min, advert_id, display_per_event, advert_name, advert_file} ] }
// overrides повертаються лише якщо для маршруту вже налаштовано розклад.
// =============================================
if ($action === 'get_time_schedule') {
   $routeId = intval($_GET['route_id'] ?? 0);
   if ($routeId <= 0) {
      echo json_encode(['error' => 'Невірний route_id']);
      exit;
   }
   a2rRequireRoute($routeId);
   a2rEnsureScheduleSchema($db2);

   $schedule = null;
   if ($res = $db2->query("SELECT start_min, end_min, interval_min FROM route_time_schedule WHERE route_id = $routeId LIMIT 1")) {
      if ($row = $res->fetch_assoc()) {
         $schedule = [
            'start_min'    => (int)$row['start_min'],
            'end_min'      => (int)$row['end_min'],
            'interval_min' => (int)$row['interval_min'],
         ];
      }
      $res->free();
   }

   $rotation = [];
   $sql = "SELECT r.advert_id, r.display_per_event, a.name AS advert_name, a.file AS advert_file
           FROM route_time_rotation r
           LEFT JOIN advertisement a ON a.id = r.advert_id
           WHERE r.route_id = $routeId
           ORDER BY r.position ASC, r.id ASC";
   if ($res = $db2->query($sql)) {
      while ($row = $res->fetch_assoc()) {
         $rotation[] = [
            'advert_id'         => (int)$row['advert_id'],
            'display_per_event' => (int)$row['display_per_event'],
            'advert_name'       => $row['advert_name'],
            'advert_file'       => $row['advert_file'],
         ];
      }
      $res->free();
   }

   $overrides = [];
   if ($schedule !== null) {
      $sql = "SELECT atr.advert_id, atr.display_per_event, atr.time_utc,
                     a.name AS advert_name, a.file AS advert_file
              FROM adverts_to_routes atr
              LEFT JOIN advertisement a ON a.id = atr.advert_id
              WHERE atr.route_id = $routeId
                AND atr.zone_id IS NULL
                AND atr.time_utc IS NOT NULL
                AND atr.auto_generated = 0";
      if ($res = $db2->query($sql)) {
         while ($row = $res->fetch_assoc()) {
            $slotMin = a2rUtcTimeToLocalMin($row['time_utc']);
            if ($slotMin === null) continue;
            $overrides[] = [
               'slot_min'          => $slotMin,
               'advert_id'         => (int)$row['advert_id'],
               'display_per_event' => (int)$row['display_per_event'],
               'advert_name'       => $row['advert_name'],
               'advert_file'       => $row['advert_file'],
            ];
         }
         $res->free();
      }
   }

   echo json_encode([
      'schedule'  => $schedule,
      'rotation'  => $rotation,
      'overrides' => $overrides,
   ], JSON_UNESCAPED_UNICODE);
   exit;
}

// =============================================
// save_time_schedule (POST, JSON body) — зберегти правила та пересоздати
// часові рядки в adverts_to_routes.
//   body: { route_id, start_min, end_min, interval_min,
//           rotation: [{advert_id, display_per_event}],   // порядок = position
//           overrides: [{slot_min, advert_id, display_per_event}] }
// =============================================
if ($action === 'save_time_schedule' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   a2rEnsureScheduleSchema($db2);

   $payload = json_decode(file_get_contents('php://input'), true);
   if (!is_array($payload)) $payload = $_POST;

   $routeId     = intval($payload['route_id'] ?? 0);
   $startMin    = intval($payload['start_min'] ?? -1);
   $endMin      = intval($payload['end_min'] ?? -1);
   $intervalMin = intval($payload['interval_min'] ?? 0);
   $rotation    = isset($payload['rotation']) && is_array($payload['rotation']) ? $payload['rotation'] : [];
   $overrides   = isset($payload['overrides']) && is_array($payload['overrides']) ? $payload['overrides'] : [];

   $errors = [];
   if ($routeId <= 0) $errors[] = 'Невірний route_id';
   if ($startMin < 0 || $startMin > 1439) $errors[] = 'Невірний час початку';
   if ($endMin < 0 || $endMin > 1439) $errors[] = 'Невірний час завершення';
   if ($endMin <= $startMin) $errors[] = 'Час завершення має бути пізніше за початок';
   if (!in_array($intervalMin, A2R_ALLOWED_INTERVALS, true)) $errors[] = 'Невірний інтервал';
   if ($errors) {
      echo json_encode(['ok' => false, 'errors' => $errors]);
      exit;
   }
   a2rRequireRoute($routeId);

   $chk = $db2->query("SELECT id FROM routes WHERE id = $routeId LIMIT 1");
   if (!$chk || !$chk->fetch_assoc()) {
      echo json_encode(['ok' => false, 'errors' => ['Маршрут не знайдено']]);
      exit;
   }
   $chk->free();

   // Слоти (локальні хвилини UTC+3)
   $slotMins = [];
   for ($m = $startMin; $m <= $endMin; $m += $intervalMin) {
      $slotMins[] = $m;
      if (count($slotMins) > A2R_MAX_SLOTS) break;
   }
   $slotSet = array_flip($slotMins);

   // Збираємо всі advert_id для перевірки існування
   $wantedIds = [];
   foreach ($rotation as $r) {
      $aid = intval($r['advert_id'] ?? 0);
      if ($aid > 0) $wantedIds[$aid] = true;
   }
   foreach ($overrides as $o) {
      $aid = intval($o['advert_id'] ?? 0);
      if ($aid > 0) $wantedIds[$aid] = true;
   }
   $existingIds = [];
   if (!empty($wantedIds)) {
      $idsList = implode(',', array_map('intval', array_keys($wantedIds)));
      // Клієнт може використати власну рекламу або ту, що вже стоїть на цьому маршруті
      $accessWhere = $isClient
         ? "AND (" . a2rOwnAdsWhere() . "
                 OR id IN (SELECT advert_id FROM adverts_to_routes WHERE route_id = $routeId)
                 OR id IN (SELECT advert_id FROM route_time_rotation WHERE route_id = $routeId))"
         : "";
      if ($res = $db2->query("SELECT id FROM advertisement WHERE id IN ($idsList) $accessWhere")) {
         while ($row = $res->fetch_assoc()) $existingIds[(int)$row['id']] = true;
         $res->free();
      }
   }

   // Нормалізуємо цикл (лише існуючі реклами, зберігаючи порядок)
   $cycle = [];
   foreach ($rotation as $r) {
      $aid = intval($r['advert_id'] ?? 0);
      if ($aid <= 0 || empty($existingIds[$aid])) continue;
      $cycle[] = [
         'advert_id'         => $aid,
         'display_per_event' => max(1, intval($r['display_per_event'] ?? 1)),
      ];
   }

   // Мапа overrides по slot_min (лише валідні слоти й існуючі реклами)
   $overrideMap = [];
   foreach ($overrides as $o) {
      $slotMin = intval($o['slot_min'] ?? -1);
      $aid = intval($o['advert_id'] ?? 0);
      if ($aid <= 0 || empty($existingIds[$aid])) continue;
      if (!isset($slotSet[$slotMin])) continue;
      $overrideMap[$slotMin] = [
         'advert_id'         => $aid,
         'display_per_event' => max(1, intval($o['display_per_event'] ?? 1)),
      ];
   }

   $cycleLen = count($cycle);

   // Будуємо рядки для батч-INSERT
   $values = [];
   foreach ($slotMins as $i => $slotMin) {
      $timeUtc = a2rLocalMinToUtcTime($slotMin);
      $timeSql = "'" . $db2->real_escape_string($timeUtc) . "'";
      if (isset($overrideMap[$slotMin])) {
         $ov = $overrideMap[$slotMin];
         $values[] = "($routeId, {$ov['advert_id']}, {$ov['display_per_event']}, NULL, $timeSql, 0)";
      } elseif ($cycleLen > 0) {
         $c = $cycle[$i % $cycleLen];
         $values[] = "($routeId, {$c['advert_id']}, {$c['display_per_event']}, NULL, $timeSql, 1)";
      }
   }

   // 1) Видаляємо ВСІ часові рядки маршруту (і автоген, і старі ручні) — повне перестворення
   if (!$db2->query("DELETE FROM adverts_to_routes WHERE route_id = $routeId AND zone_id IS NULL AND time_utc IS NOT NULL")) {
      a2rLog("save_time_schedule delete error", $db2->error);
      echo json_encode(['ok' => false, 'errors' => ['Помилка видалення старих записів: ' . $db2->error]]);
      exit;
   }

   // 2) Батч-INSERT згенерованих рядків
   $inserted = 0;
   if (!empty($values)) {
      $sql = "INSERT INTO adverts_to_routes (route_id, advert_id, display_per_event, zone_id, time_utc, auto_generated) VALUES "
         . implode(', ', $values);
      if (!$db2->query($sql)) {
         a2rLog("save_time_schedule insert error", $db2->error);
         echo json_encode(['ok' => false, 'errors' => ['Помилка вставки: ' . $db2->error]]);
         exit;
      }
      $inserted = $db2->affected_rows;
   }

   // 3) Зберігаємо налаштування розкладу
   $now = date('Y-m-d H:i:s');
   $db2->query("INSERT INTO route_time_schedule (route_id, start_min, end_min, interval_min, updated_at)
                VALUES ($routeId, $startMin, $endMin, $intervalMin, '$now')
                ON DUPLICATE KEY UPDATE start_min=$startMin, end_min=$endMin, interval_min=$intervalMin, updated_at='$now'");

   // 4) Перезаписуємо цикл ротації
   $db2->query("DELETE FROM route_time_rotation WHERE route_id = $routeId");
   if ($cycleLen > 0) {
      $rotVals = [];
      foreach ($cycle as $pos => $c) {
         $rotVals[] = "($routeId, {$c['advert_id']}, $pos, {$c['display_per_event']})";
      }
      $db2->query("INSERT INTO route_time_rotation (route_id, advert_id, position, display_per_event) VALUES "
         . implode(', ', $rotVals));
   }

   echo json_encode([
      'ok'       => true,
      'inserted' => $inserted,
      'slots'    => count($slotMins),
   ], JSON_UNESCAPED_UNICODE);
   exit;
}

a2rLog("Unknown action", ['action' => $action]);
echo json_encode(['error' => 'Невідома дія: ' . $action]);
