<?php

/**
 * Перегляд маршрутів і треку однієї машини за підписаним посиланням
 * з платформи підрахунку пасажирів (PassengersFlowCounting).
 *
 * Токен: base64url(json payload) . "." . base64url(HMAC-SHA256(secret, payload_b64)),
 * payload: {"v":1, "imei":"...", "exp":unix, "sub":"pfc:<user_id>"}.
 * Генерує app/services/routes_viewer_service.py — формат має збігатися.
 *
 * Секрет — /etc/AdvertismentManager/viewer_secret.json: {"secret": "..."}.
 * Обліковий запис у users не створюється: глядач — тимчасова роль 'viewer',
 * токен лежить у cookie до закінчення строку дії.
 */

define('VIEWER_COOKIE_NAME', 'ram_viewer');
define('VIEWER_SECRET_FILE', '/etc/AdvertismentManager/viewer_secret.json');
define('VIEWER_ROLE_LABEL', 'Перегляд маршрутів і треку');

function viewerSecret()
{
   static $secret = null;
   if ($secret !== null) return $secret;
   $secret = '';
   if (is_readable(VIEWER_SECRET_FILE)) {
      $data = json_decode((string)file_get_contents(VIEWER_SECRET_FILE), true);
      $secret = trim((string)($data['secret'] ?? ''));
   }
   return $secret;
}

function viewerB64UrlEncode($raw)
{
   return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
}

function viewerB64UrlDecode($text)
{
   $text = strtr((string)$text, '-_', '+/');
   $pad = strlen($text) % 4;
   if ($pad) $text .= str_repeat('=', 4 - $pad);
   return base64_decode($text, true);
}

/**
 * Перевіряє підпис і строк дії.
 * @return array|null ['imei' => string, 'exp' => int, 'sub' => string]
 */
function viewerVerifyToken($token)
{
   if (!is_string($token) || $token === '' || strlen($token) > 2048) return null;
   $parts = explode('.', $token);
   if (count($parts) !== 2) return null;
   list($payloadB64, $sigB64) = $parts;

   $secret = viewerSecret();
   if ($secret === '') return null;
   $expected = viewerB64UrlEncode(hash_hmac('sha256', $payloadB64, $secret, true));
   if (!hash_equals($expected, $sigB64)) return null;

   $json = viewerB64UrlDecode($payloadB64);
   $payload = $json === false ? null : json_decode($json, true);
   if (!is_array($payload) || (int)($payload['v'] ?? 0) !== 1) return null;

   $exp = (int)($payload['exp'] ?? 0);
   if ($exp < time()) return null;

   $imei = trim((string)($payload['imei'] ?? ''));
   if (!preg_match('/^[0-9A-Za-z_-]{1,32}$/', $imei)) return null;

   return ['imei' => $imei, 'exp' => $exp, 'sub' => (string)($payload['sub'] ?? '')];
}

function viewerSetCookie($token, $expires)
{
   if (headers_sent()) return false;
   if (PHP_VERSION_ID >= 70300) {
      return setcookie(VIEWER_COOKIE_NAME, $token, [
         'expires'  => $expires,
         'path'     => '/',
         'secure'   => authCookieSecure(),
         'httponly' => true,
         'samesite' => 'Lax',
      ]);
   }
   return setcookie(VIEWER_COOKIE_NAME, $token, $expires, '/; samesite=Lax', '', authCookieSecure(), true);
}

function viewerClearCookie()
{
   if (isset($_COOKIE[VIEWER_COOKIE_NAME])) viewerSetCookie('', time() - 3600);
}

/** ID маршрутів, прив'язаних до IMEI у all_car_routes (як у платформі підрахунку). */
function viewerRouteIdsForImei($imei)
{
   $db2 = getDB('routes');
   if (!$db2) return [];
   $imeiEsc = $db2->real_escape_string((string)$imei);
   $ids = [];
   if ($res = $db2->query("SELECT routes_id FROM all_car_routes WHERE imei = '$imeiEsc'")) {
      while ($row = $res->fetch_assoc()) {
         $arr = json_decode((string)$row['routes_id'], true);
         if (!is_array($arr)) continue;
         foreach ($arr as $rid) {
            $rid = (int)$rid;
            if ($rid > 0) $ids[$rid] = $rid;
         }
      }
      $res->free();
   }
   return array_values($ids);
}

/**
 * Глядач із cookie або null. Формат як у authCurrentUser() + imeis / route_ids.
 * @return array|null
 */
function viewerCurrentUser()
{
   $claims = viewerVerifyToken($_COOKIE[VIEWER_COOKIE_NAME] ?? '');
   if ($claims === null) return null;
   return [
      'id'           => 0,
      'login'        => 'viewer',
      'role'         => 'viewer',
      'display_name' => 'Перегляд · IMEI ' . $claims['imei'],
      'imeis'        => [$claims['imei']],
      'route_ids'    => viewerRouteIdsForImei($claims['imei']),
   ];
}
