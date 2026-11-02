<?php

/**
 * Створює адміністратора або скидає пароль існуючому користувачу (роль стає admin).
 * Використання: php tools/create_admin.php <login> <password>
 */

if (PHP_SAPI !== 'cli') {
   http_response_code(404);
   exit;
}

if ($argc < 3) {
   fwrite(STDERR, "Використання: php tools/create_admin.php <login> <password>\n");
   exit(1);
}

$login = trim($argv[1]);
$password = $argv[2];

if (!preg_match('/^[A-Za-z0-9._@-]{3,64}$/', $login)) {
   fwrite(STDERR, "Логін: 3-64 символи, латиниця, цифри та . _ @ -\n");
   exit(1);
}
if (strlen($password) < 8) {
   fwrite(STDERR, "Пароль адміністратора має бути не коротшим за 8 символів\n");
   exit(1);
}

require_once __DIR__ . '/../includes/connectDB.php';

$db2 = getDB('routes');
if (!$db2) {
   fwrite(STDERR, "Немає підключення до бази RoutesAndAdvertisement\n");
   exit(1);
}

$loginEsc = $db2->real_escape_string($login);
$hashEsc = $db2->real_escape_string(password_hash($password, PASSWORD_DEFAULT));

$sql = "INSERT INTO users (login, password_hash, role, active)
        VALUES ('$loginEsc', '$hashEsc', 'admin', 1)
        ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = 'admin', active = 1";

if (!$db2->query($sql)) {
   fwrite(STDERR, "Помилка БД: " . $db2->error . "\n");
   exit(1);
}

echo ($db2->affected_rows === 1 ? "Адміністратора створено" : "Пароль оновлено, роль admin") . ": $login\n";
