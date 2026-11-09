<?php

/**
 * Авторизація користувачів консолі.
 * Таблиці (база RoutesAndAdvertisement): users, user_sessions, user_imeis, user_routes.
 * Сесія живе 7 днів від останньої активності; у cookie зберігається токен, у БД — його sha256.
 */

require_once __DIR__ . '/connectDB.php';
require_once __DIR__ . '/viewer_token.php';

define('AUTH_SESSION_LIFETIME', 7 * 24 * 60 * 60);
define('AUTH_COOKIE_NAME', 'ram_session');
// Як часто (сек) продовжувати сесію в БД, щоб не писати на кожен запит
define('AUTH_TOUCH_INTERVAL', 300);

const AUTH_ROLES = ['admin', 'routes_track', 'advertisement', 'client'];

const AUTH_ROLE_LABELS = [
   'admin'         => 'Адміністратор',
   'routes_track'  => 'Маршрути і трек',
   'advertisement' => 'Реклама',
   'client'        => 'Клієнт',
];

function authCookieSecure()
{
   return isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
}

function authSetCookie($token, $expires)
{
   if (headers_sent($file, $line)) {
      logToFile('authSetCookie: headers already sent', ['file' => $file, 'line' => $line]);
      return false;
   }

   if (PHP_VERSION_ID >= 70300) {
      $ok = setcookie(AUTH_COOKIE_NAME, $token, [
         'expires'  => $expires,
         'path'     => '/',
         'secure'   => authCookieSecure(),
         'httponly' => true,
         'samesite' => 'Lax',
      ]);
   } else {
      // До PHP 7.3 масив опцій не підтримується; SameSite передаємо через path
      $ok = setcookie(AUTH_COOKIE_NAME, $token, $expires, '/; samesite=Lax', '', authCookieSecure(), true);
   }

   if (!$ok) {
      logToFile('authSetCookie: setcookie failed', ['php' => PHP_VERSION]);
   }
   return $ok;
}

function authTokenHash($token)
{
   return hash('sha256', $token);
}

function authCookieToken()
{
   $token = $_COOKIE[AUTH_COOKIE_NAME] ?? '';
   return is_string($token) && preg_match('/^[a-f0-9]{64}$/', $token) ? $token : null;
}

/**
 * Поточний користувач або null. Роль і статус active читаються з БД на кожен запит,
 * тому блокування / зміна ролі діють одразу.
 * @return array|null ['id','login','role','display_name']
 */
function authCurrentUser()
{
   static $resolved = false;
   static $user = null;
   if ($resolved) return $user;
   $resolved = true;

   $token = authCookieToken();
   $db2 = getDB('routes');
   if ($token === null || !$db2) return $user = viewerCurrentUser();

   $hash = authTokenHash($token);
   $sql = "SELECT u.id, u.login, u.role, u.display_name,
                  TIMESTAMPDIFF(SECOND, s.last_seen_at, NOW()) AS idle_sec
           FROM user_sessions s
           JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = '$hash' AND s.expires_at > NOW() AND u.active = 1
           LIMIT 1";
   $res = $db2->query($sql);
   if (!$res || !($row = $res->fetch_assoc())) return $user = viewerCurrentUser();
   $res->free();

   if ((int)$row['idle_sec'] >= AUTH_TOUCH_INTERVAL) {
      $lifetime = AUTH_SESSION_LIFETIME;
      $db2->query("UPDATE user_sessions
                   SET last_seen_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL $lifetime SECOND)
                   WHERE token_hash = '$hash'");
      authSetCookie($token, time() + AUTH_SESSION_LIFETIME);
   }

   $user = [
      'id'           => (int)$row['id'],
      'login'        => $row['login'],
      'role'         => $row['role'],
      'display_name' => $row['display_name'],
   ];
   return $user;
}

/**
 * Перевіряє логін/пароль, створює сесію та ставить cookie.
 * @return bool
 */
function authLogin($login, $password)
{
   $db2 = getDB('routes');
   if (!$db2) return false;

   $loginEsc = $db2->real_escape_string($login);
   $row = null;
   if ($res = $db2->query("SELECT id, password_hash, active FROM users WHERE login = '$loginEsc' LIMIT 1")) {
      $row = $res->fetch_assoc();
      $res->free();
   }

   if (!$row) {
      // Вирівнюємо час відповіді, щоб не можна було перебирати існуючі логіни
      password_hash($password, PASSWORD_DEFAULT);
      usleep(400000);
      return false;
   }
   if (!password_verify($password, $row['password_hash']) || (int)$row['active'] !== 1) {
      usleep(400000);
      return false;
   }

   $userId = (int)$row['id'];
   if (password_needs_rehash($row['password_hash'], PASSWORD_DEFAULT)) {
      $newHash = $db2->real_escape_string(password_hash($password, PASSWORD_DEFAULT));
      $db2->query("UPDATE users SET password_hash = '$newHash' WHERE id = $userId");
   }

   $token = bin2hex(random_bytes(32));
   $hash = authTokenHash($token);
   $lifetime = AUTH_SESSION_LIFETIME;
   $ip = $db2->real_escape_string(substr((string)($_SERVER['REMOTE_ADDR'] ?? ''), 0, 45));
   $ua = $db2->real_escape_string(mb_substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255));

   $ok = $db2->query("INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
                      VALUES ('$hash', $userId, NOW(), DATE_ADD(NOW(), INTERVAL $lifetime SECOND), NOW(), '$ip', '$ua')");
   if (!$ok) {
      logToFile('authLogin: session insert failed', ['error' => $db2->error]);
      return false;
   }

   $db2->query("UPDATE users SET last_login_at = NOW() WHERE id = $userId");
   $db2->query("DELETE FROM user_sessions WHERE expires_at < NOW()");

   authSetCookie($token, time() + AUTH_SESSION_LIFETIME);
   return true;
}

function authLogout()
{
   $token = authCookieToken();
   $db2 = getDB('routes');
   if ($token !== null && $db2) {
      $hash = authTokenHash($token);
      $db2->query("DELETE FROM user_sessions WHERE token_hash = '$hash'");
   }
   authSetCookie('', time() - 3600);
   viewerClearCookie();
}

/**
 * Завершує всі сесії користувача (крім поточної, якщо $keepCurrent).
 */
function authDestroyUserSessions($userId, $keepCurrent = false)
{
   $db2 = getDB('routes');
   if (!$db2) return;
   $userId = (int)$userId;
   $sql = "DELETE FROM user_sessions WHERE user_id = $userId";
   $token = authCookieToken();
   if ($keepCurrent && $token !== null) {
      $sql .= " AND token_hash <> '" . authTokenHash($token) . "'";
   }
   $db2->query($sql);
}

/**
 * Для API: 401 без сесії, 403 якщо роль не входить у $roles.
 * @return array поточний користувач
 */
function authRequireApi(array $roles)
{
   $user = authCurrentUser();
   if (!$user) {
      http_response_code(401);
      header('Content-Type: application/json; charset=utf-8');
      echo json_encode(['error' => 'Не авторизовано']);
      exit;
   }
   if (!in_array($user['role'], $roles, true)) {
      authDenyApi('Недостатньо прав доступу');
   }
   return $user;
}

function authDenyApi($message = 'Немає доступу')
{
   http_response_code(403);
   header('Content-Type: application/json; charset=utf-8');
   echo json_encode(['ok' => false, 'error' => $message, 'errors' => [$message]]);
   exit;
}

/**
 * Для сторінок: редірект на форму входу без сесії.
 * @param string $loginUrl
 * @return array
 */
function authRequirePage($loginUrl = 'auth/login.php')
{
   $user = authCurrentUser();
   if (!$user) {
      header('Location: ' . $loginUrl);
      exit;
   }
   return $user;
}

function authIsClient(array $user)
{
   return $user['role'] === 'client';
}

/** Глядач за підписаним посиланням з платформи підрахунку (одна машина, лише перегляд). */
function authIsViewer(array $user)
{
   return $user['role'] === 'viewer';
}

/** Бачить лише призначені маршрути / IMEI і нічого не змінює. */
function authIsRestricted(array $user)
{
   return authIsClient($user) || authIsViewer($user);
}

function authRoleLabel($role)
{
   if ($role === 'viewer') return VIEWER_ROLE_LABEL;
   return AUTH_ROLE_LABELS[$role] ?? $role;
}

/**
 * ID маршрутів, призначених користувачу.
 * @return int[]
 */
function authUserRouteIds(array $user)
{
   if (authIsViewer($user)) return $user['route_ids'];
   static $cache = [];
   $uid = (int)$user['id'];
   if (isset($cache[$uid])) return $cache[$uid];

   $ids = [];
   $db2 = getDB('routes');
   if ($db2 && ($res = $db2->query("SELECT route_id FROM user_routes WHERE user_id = $uid"))) {
      while ($r = $res->fetch_assoc()) $ids[] = (int)$r['route_id'];
      $res->free();
   }
   $cache[$uid] = $ids;
   return $ids;
}

/**
 * IMEI, призначені користувачу.
 * @return string[]
 */
function authUserImeis(array $user)
{
   if (authIsViewer($user)) return $user['imeis'];
   static $cache = [];
   $uid = (int)$user['id'];
   if (isset($cache[$uid])) return $cache[$uid];

   $imeis = [];
   $db2 = getDB('routes');
   if ($db2 && ($res = $db2->query("SELECT imei FROM user_imeis WHERE user_id = $uid ORDER BY imei"))) {
      while ($r = $res->fetch_assoc()) $imeis[] = (string)$r['imei'];
      $res->free();
   }
   $cache[$uid] = $imeis;
   return $imeis;
}

/** Чи має користувач доступ до маршруту (без обмежень — до всіх). */
function authCanAccessRoute(array $user, $routeId)
{
   return !authIsRestricted($user) || in_array((int)$routeId, authUserRouteIds($user), true);
}

/** Чи має користувач доступ до IMEI (без обмежень — до всіх). */
function authCanAccessImei(array $user, $imei)
{
   return !authIsRestricted($user) || in_array((string)$imei, authUserImeis($user), true);
}

/** "1,2,3" для SQL IN (...); для порожнього списку — "0", щоб умова нічого не знаходила. */
function authSqlIntList(array $ids)
{
   $ids = array_values(array_unique(array_map('intval', $ids)));
   return $ids ? implode(',', $ids) : '0';
}

/** "'a','b'" для SQL IN (...); для порожнього списку — "''". */
function authSqlStrList(mysqli $db, array $values)
{
   if (!$values) return "''";
   return implode(',', array_map(function ($v) use ($db) {
      return "'" . $db->real_escape_string((string)$v) . "'";
   }, $values));
}
