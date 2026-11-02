<?php

/**
 * Users API — керування користувачами консолі (лише admin).
 * Таблиці: users, user_imeis, user_routes, user_sessions; маршрути — routes, route_groups.
 * Маршрут і IMEI можуть належати лише одному користувачу.
 */

ini_set('error_reporting', E_ALL);
ini_set('display_errors', 0);
ini_set('display_startup_errors', 0);
date_default_timezone_set('Europe/Kiev');

require_once __DIR__ . '/../includes/auth.php';
$currentUser = authRequireApi(['admin']);

header('Content-Type: application/json; charset=utf-8');

function usersLog($msg, $context = null)
{
   $file = dirname(__DIR__) . '/debug.log';
   $t = date('Y-m-d H:i:s');
   $ctx = '';
   if ($context !== null) {
      $ctx = ' ' . (is_scalar($context) ? $context : json_encode($context, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
   }
   @file_put_contents($file, "[$t] users: $msg$ctx" . PHP_EOL, FILE_APPEND);
}

function usersFail($error)
{
   echo json_encode(['ok' => false, 'error' => $error], JSON_UNESCAPED_UNICODE);
   exit;
}

if (!$db2) {
   usersLog("DB2 connection failed");
   echo json_encode(['error' => 'Помилка підключення до бази RoutesAndAdvertisement']);
   exit;
}

$action = $_GET['action'] ?? $_POST['action'] ?? '';
$isPost = $_SERVER['REQUEST_METHOD'] === 'POST';

/** Повертає рядок користувача або null */
function usersFind(mysqli $db2, $id)
{
   $id = (int)$id;
   $row = null;
   if ($res = $db2->query("SELECT id, login, role, display_name, active FROM users WHERE id = $id LIMIT 1")) {
      $row = $res->fetch_assoc();
      $res->free();
   }
   return $row ?: null;
}

function usersRequire(mysqli $db2, $id)
{
   $user = usersFind($db2, $id);
   if (!$user) usersFail('Користувача не знайдено');
   return $user;
}

/** Маршрут + усі пов'язані з ним (зворотний / linked_route_ids), які існують у БД */
function usersRouteWithLinked(mysqli $db2, $routeId)
{
   $routeId = (int)$routeId;
   $res = $db2->query("SELECT id, additional FROM routes WHERE id = $routeId LIMIT 1");
   if (!$res || !($row = $res->fetch_assoc())) return [];
   $res->free();

   $ids = [$routeId => true];
   $add = json_decode($row['additional'] ?? '', true);
   if (is_array($add)) {
      if (!empty($add['linked_route_ids']) && is_array($add['linked_route_ids'])) {
         foreach ($add['linked_route_ids'] as $lid) {
            if ((int)$lid > 0) $ids[(int)$lid] = true;
         }
      }
      if (!empty($add['inverse_route_id'])) $ids[(int)$add['inverse_route_id']] = true;
   }

   $existing = [];
   $list = authSqlIntList(array_keys($ids));
   if ($res = $db2->query("SELECT id FROM routes WHERE id IN ($list)")) {
      while ($r = $res->fetch_assoc()) $existing[] = (int)$r['id'];
      $res->free();
   }
   return $existing;
}

// =============================================
// list — усі користувачі з кількістю IMEI / маршрутів
// =============================================
if ($action === 'list') {
   $users = [];
   $sql = "SELECT u.id, u.login, u.role, u.display_name, u.active, u.created_at, u.last_login_at,
                  (SELECT COUNT(*) FROM user_imeis i WHERE i.user_id = u.id) AS imeis_count,
                  (SELECT COUNT(*) FROM user_routes r WHERE r.user_id = u.id) AS routes_count
           FROM users u
           ORDER BY u.login";
   if ($res = $db2->query($sql)) {
      while ($r = $res->fetch_assoc()) {
         $r['id'] = (int)$r['id'];
         $r['active'] = (int)$r['active'];
         $r['imeis_count'] = (int)$r['imeis_count'];
         $r['routes_count'] = (int)$r['routes_count'];
         $users[] = $r;
      }
      $res->free();
   } else {
      usersLog("list query error", $db2->error);
      echo json_encode(['error' => 'Помилка читання БД']);
      exit;
   }
   echo json_encode(['users' => $users, 'roles' => AUTH_ROLE_LABELS, 'current_user_id' => $currentUser['id']], JSON_UNESCAPED_UNICODE);
   exit;
}

// =============================================
// get — користувач + його IMEI та маршрути
// =============================================
if ($action === 'get') {
   $user = usersRequire($db2, $_GET['id'] ?? 0);
   $uid = (int)$user['id'];
   $user['id'] = $uid;
   $user['active'] = (int)$user['active'];

   $imeis = [];
   if ($res = $db2->query("SELECT imei FROM user_imeis WHERE user_id = $uid ORDER BY imei")) {
      while ($r = $res->fetch_assoc()) $imeis[] = (string)$r['imei'];
      $res->free();
   }

   $routes = [];
   $sql = "SELECT r.id, r.name, g.name AS group_name
           FROM user_routes ur
           JOIN routes r ON r.id = ur.route_id
           LEFT JOIN route_groups g ON g.id = r.group_id
           WHERE ur.user_id = $uid
           ORDER BY g.name, r.name";
   if ($res = $db2->query($sql)) {
      while ($r = $res->fetch_assoc()) {
         $r['id'] = (int)$r['id'];
         $routes[] = $r;
      }
      $res->free();
   }

   echo json_encode(['user' => $user, 'imeis' => $imeis, 'routes' => $routes], JSON_UNESCAPED_UNICODE);
   exit;
}

// =============================================
// routes_catalog — усі маршрути з поточним власником (для вибору)
// =============================================
if ($action === 'routes_catalog') {
   $routes = [];
   $sql = "SELECT r.id, r.name, g.name AS group_name, ur.user_id AS owner_id, u.login AS owner_login
           FROM routes r
           LEFT JOIN route_groups g ON g.id = r.group_id
           LEFT JOIN user_routes ur ON ur.route_id = r.id
           LEFT JOIN users u ON u.id = ur.user_id
           ORDER BY g.name, r.name";
   if ($res = $db2->query($sql)) {
      while ($r = $res->fetch_assoc()) {
         $r['id'] = (int)$r['id'];
         $r['owner_id'] = $r['owner_id'] !== null ? (int)$r['owner_id'] : null;
         $routes[] = $r;
      }
      $res->free();
   }
   echo json_encode(['routes' => $routes], JSON_UNESCAPED_UNICODE);
   exit;
}

// =============================================
// save — створити / оновити користувача
// =============================================
if ($action === 'save' && $isPost) {
   $id = (int)($_POST['id'] ?? 0);
   $login = trim((string)($_POST['login'] ?? ''));
   $displayName = trim((string)($_POST['display_name'] ?? ''));
   $role = (string)($_POST['role'] ?? 'client');
   $active = !empty($_POST['active']) ? 1 : 0;
   $password = (string)($_POST['password'] ?? '');

   if (!preg_match('/^[A-Za-z0-9._@-]{3,64}$/', $login)) {
      usersFail('Логін: 3-64 символи, латиниця, цифри та . _ @ -');
   }
   if (!in_array($role, AUTH_ROLES, true)) usersFail('Невірна роль');
   if (mb_strlen($displayName) > 128) usersFail('Ім\'я задовге (макс. 128 символів)');
   if ($id <= 0 && $password === '') usersFail('Вкажіть пароль');
   if ($password !== '' && strlen($password) < 6) usersFail('Пароль має бути не коротшим за 6 символів');

   if ($id > 0) {
      usersRequire($db2, $id);
      if ($id === $currentUser['id'] && ($role !== 'admin' || !$active)) {
         usersFail('Не можна зняти роль адміністратора або заблокувати самого себе');
      }
   }

   $loginEsc = $db2->real_escape_string($login);
   if ($res = $db2->query("SELECT id FROM users WHERE login = '$loginEsc' AND id <> $id LIMIT 1")) {
      $taken = $res->fetch_assoc();
      $res->free();
      if ($taken) usersFail('Такий логін вже існує');
   }

   $nameSql = $displayName !== '' ? "'" . $db2->real_escape_string($displayName) . "'" : 'NULL';
   $roleEsc = $db2->real_escape_string($role);
   $hashSql = $password !== '' ? "'" . $db2->real_escape_string(password_hash($password, PASSWORD_DEFAULT)) . "'" : null;

   if ($id > 0) {
      $set = ["login = '$loginEsc'", "display_name = $nameSql", "role = '$roleEsc'", "active = $active"];
      if ($hashSql !== null) $set[] = "password_hash = $hashSql";
      if (!$db2->query("UPDATE users SET " . implode(', ', $set) . " WHERE id = $id")) {
         usersLog("save update error", $db2->error);
         usersFail('Помилка БД: ' . $db2->error);
      }
      // Після зміни пароля або блокування — завершуємо сесії (свою поточну залишаємо)
      if ($hashSql !== null || !$active) {
         authDestroyUserSessions($id, $id === $currentUser['id']);
      }
   } else {
      $sql = "INSERT INTO users (login, password_hash, role, display_name, active)
              VALUES ('$loginEsc', $hashSql, '$roleEsc', $nameSql, $active)";
      if (!$db2->query($sql)) {
         usersLog("save insert error", $db2->error);
         usersFail('Помилка БД: ' . $db2->error);
      }
      $id = (int)$db2->insert_id;
   }

   echo json_encode(['ok' => true, 'id' => $id]);
   exit;
}

// =============================================
// delete — видалити користувача (IMEI, маршрути, сесії — каскадно)
// =============================================
if ($action === 'delete' && $isPost) {
   $id = (int)($_POST['id'] ?? 0);
   usersRequire($db2, $id);
   if ($id === $currentUser['id']) usersFail('Не можна видалити самого себе');

   // Реклама користувача залишається, але стає спільною (без власника)
   $db2->query("UPDATE advertisement SET owner_user_id = NULL WHERE owner_user_id = $id");
   if (!$db2->query("DELETE FROM users WHERE id = $id")) {
      usersLog("delete error", $db2->error);
      usersFail('Помилка видалення: ' . $db2->error);
   }
   echo json_encode(['ok' => true]);
   exit;
}

// =============================================
// add_imeis — додати IMEI (по одному або списком через кому / пробіл / новий рядок)
// =============================================
if ($action === 'add_imeis' && $isPost) {
   $uid = (int)($_POST['user_id'] ?? 0);
   usersRequire($db2, $uid);

   $parts = preg_split('/[\s,;]+/u', (string)($_POST['imeis'] ?? ''), -1, PREG_SPLIT_NO_EMPTY);
   $parts = array_values(array_unique($parts));
   if (!$parts) usersFail('Вкажіть хоча б один IMEI');

   $invalid = [];
   $valid = [];
   foreach ($parts as $p) {
      if (preg_match('/^[A-Za-z0-9]{1,20}$/', $p)) $valid[] = $p;
      else $invalid[] = $p;
   }

   // Хто вже володіє цими IMEI
   $owners = [];
   if ($valid) {
      $sql = "SELECT i.imei, i.user_id, u.login
              FROM user_imeis i JOIN users u ON u.id = i.user_id
              WHERE i.imei IN (" . authSqlStrList($db2, $valid) . ")";
      if ($res = $db2->query($sql)) {
         while ($r = $res->fetch_assoc()) $owners[strtolower($r['imei'])] = $r;
         $res->free();
      }
   }

   $added = [];
   $already = [];
   $taken = [];
   foreach ($valid as $imei) {
      $owner = $owners[strtolower($imei)] ?? null;
      if ($owner) {
         if ((int)$owner['user_id'] === $uid) $already[] = $imei;
         else $taken[] = ['imei' => $imei, 'login' => $owner['login']];
         continue;
      }
      $imeiEsc = $db2->real_escape_string($imei);
      if ($db2->query("INSERT INTO user_imeis (user_id, imei) VALUES ($uid, '$imeiEsc')")) {
         $added[] = $imei;
      } else {
         usersLog("add_imeis insert error", ['imei' => $imei, 'error' => $db2->error]);
         $taken[] = ['imei' => $imei, 'login' => null];
      }
   }

   echo json_encode([
      'ok'      => true,
      'added'   => $added,
      'already' => $already,
      'taken'   => $taken,
      'invalid' => $invalid,
   ], JSON_UNESCAPED_UNICODE);
   exit;
}

// =============================================
// remove_imei
// =============================================
if ($action === 'remove_imei' && $isPost) {
   $uid = (int)($_POST['user_id'] ?? 0);
   $imeiEsc = $db2->real_escape_string(trim((string)($_POST['imei'] ?? '')));
   if (!$db2->query("DELETE FROM user_imeis WHERE user_id = $uid AND imei = '$imeiEsc'")) {
      usersFail('Помилка видалення: ' . $db2->error);
   }
   echo json_encode(['ok' => true]);
   exit;
}

// =============================================
// add_route — призначити маршрут разом із пов'язаним зворотним
// =============================================
if ($action === 'add_route' && $isPost) {
   $uid = (int)($_POST['user_id'] ?? 0);
   usersRequire($db2, $uid);
   $routeIds = usersRouteWithLinked($db2, (int)($_POST['route_id'] ?? 0));
   if (!$routeIds) usersFail('Маршрут не знайдено');

   $list = authSqlIntList($routeIds);
   $conflicts = [];
   $ownIds = [];
   $sql = "SELECT ur.route_id, ur.user_id, r.name, u.login
           FROM user_routes ur
           JOIN routes r ON r.id = ur.route_id
           JOIN users u ON u.id = ur.user_id
           WHERE ur.route_id IN ($list)";
   if ($res = $db2->query($sql)) {
      while ($r = $res->fetch_assoc()) {
         if ((int)$r['user_id'] === $uid) $ownIds[] = (int)$r['route_id'];
         else $conflicts[] = '«' . $r['name'] . '» — ' . $r['login'];
      }
      $res->free();
   }
   if ($conflicts) {
      usersFail('Маршрут уже призначено іншому користувачу: ' . implode('; ', $conflicts));
   }

   $toAdd = array_values(array_diff($routeIds, $ownIds));
   if ($toAdd) {
      $values = implode(', ', array_map(function ($rid) use ($uid) {
         return "($uid, " . (int)$rid . ")";
      }, $toAdd));
      if (!$db2->query("INSERT INTO user_routes (user_id, route_id) VALUES $values")) {
         usersLog("add_route insert error", $db2->error);
         usersFail('Помилка БД: ' . $db2->error);
      }
   }

   echo json_encode(['ok' => true, 'added' => $toAdd]);
   exit;
}

// =============================================
// remove_route — зняти маршрут разом із пов'язаним зворотним
// =============================================
if ($action === 'remove_route' && $isPost) {
   $uid = (int)($_POST['user_id'] ?? 0);
   $routeId = (int)($_POST['route_id'] ?? 0);
   $routeIds = usersRouteWithLinked($db2, $routeId);
   if (!$routeIds) $routeIds = [$routeId];

   $list = authSqlIntList($routeIds);
   if (!$db2->query("DELETE FROM user_routes WHERE user_id = $uid AND route_id IN ($list)")) {
      usersFail('Помилка видалення: ' . $db2->error);
   }
   echo json_encode(['ok' => true, 'removed' => $db2->affected_rows]);
   exit;
}

usersLog("Unknown action", ['action' => $action]);
echo json_encode(['error' => 'Невідома дія: ' . $action]);
