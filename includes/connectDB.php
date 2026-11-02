<?php
$config = parse_ini_file("/etc/AdvertismentManager/DB_config.conf");

// Функція для логування помилок та дій у файл /var/www/RoutesAndAdvert/logs/debug.log
function logToFile($message, $context = null)
{
   $logDir = '/tmp/AdvertismentManager/logs';
   if (!is_dir($logDir)) {
      // Спроба створити каталог, якщо не існує
      @mkdir($logDir, 0777, true);
   }
   $logFile = $logDir . '/debug.log';
   $time = date('Y-m-d H:i:s');
   $msg = "[$time] $message";
   if ($context !== null) {
      $msg .= ' ' . json_encode($context, JSON_UNESCAPED_UNICODE);
   }
   $msg .= PHP_EOL;
   // Додаємо до лог-файлу
   @file_put_contents($logFile, $msg, FILE_APPEND);
}

// Підключення до основної бази GPS
$db = new mysqli(
   $config['DB_HOST'],
   $config['DB_USER'],
   $config['DB_PASS'],
   $config['DB_NAME'],
   $config['DB_PORT']
);

if ($db->connect_error) {
   logToFile('DB Connection Error GPS', ['error' => $db->connect_error]);
   die("Помилка підключення до GPS: " . $db->connect_error);
}
$db->set_charset("utf8mb4");

// Підключення до бази RoutesAndAdvertisement
$db2 = null;
if (!empty($config['DB2_NAME'])) {
   $db2 = new mysqli(
      $config['DB2_HOST'] ?? $config['DB_HOST'],
      $config['DB2_USER'] ?? $config['DB_USER'],
      $config['DB2_PASS'] ?? $config['DB_PASS'],
      $config['DB2_NAME'],
      $config['DB2_PORT'] ?? $config['DB_PORT']
   );

   if ($db2->connect_error) {
      logToFile('DB Connection Error RoutesAndAdvertisement', ['error' => $db2->connect_error]);
      error_log("Помилка підключення до RoutesAndAdvertisement: " . $db2->connect_error);
      $db2 = null;
   } else {
      $db2->set_charset("utf8mb4");
   }
}

// Підключення до бази PassengersFlowCounting (тарифи маршрутів)
$db3 = null;
if (!empty($config['DB3_NAME'])) {
   $db3 = new mysqli(
      $config['DB3_HOST'] ?? $config['DB_HOST'],
      $config['DB3_USER'] ?? $config['DB_USER'],
      $config['DB3_PASS'] ?? $config['DB_PASS'],
      $config['DB3_NAME'],
      $config['DB3_PORT'] ?? $config['DB_PORT']
   );

   if ($db3->connect_error) {
      logToFile('DB Connection Error PassengersFlowCounting', ['error' => $db3->connect_error]);
      error_log("Помилка підключення до PassengersFlowCounting: " . $db3->connect_error);
      $db3 = null;
   } else {
      $db3->set_charset("utf8mb4");
   }
}

/**
 * Отримати підключення до потрібної бази
 * @param string $database - 'gps', 'routes' або 'passengers'
 * @return mysqli|null
 */
function getDB($database = 'gps')
{
   global $db, $db2, $db3;

   switch ($database) {
      case 'routes':
      case 'RoutesAndAdvertisement':
         return $db2;
      case 'passengers':
      case 'PassengersFlowCounting':
         return $db3;
      case 'gps':
      default:
         return $db;
   }
}
