<?php
ini_set('error_reporting', E_ALL);
ini_set('display_errors', 0);
ini_set('display_startup_errors', 0);
date_default_timezone_set('Europe/Kiev');

require_once __DIR__ . '/../includes/auth.php';
$currentUser = authRequireApi(['admin', 'advertisement', 'client']);
$isClient = authIsClient($currentUser);
$action = isset($_GET['action']) ? $_GET['action'] : (isset($_POST['action']) ? $_POST['action'] : '');

header('Content-Type: application/json; charset=utf-8');

function logDebug($msg, $context = null)
{
   $file = dirname(__DIR__) . '/debug.log';
   $t = date('Y-m-d H:i:s');
   $ctx = '';
   if ($context !== null) {
      if (is_array($context) || is_object($context)) {
         $ctx = ' ' . json_encode($context, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
      } else {
         $ctx = ' ' . $context;
      }
   }
   file_put_contents($file, "[$t] $msg$ctx" . PHP_EOL, FILE_APPEND);
}

if (!$db2) {
   logDebug("ads.php: DB2 (RoutesAndAdvertisement) connection failed");
   echo json_encode(['error' => 'Помилка підключення до бази RoutesAndAdvertisement']);
   exit;
}

logDebug("ads.php called", ['action' => $action, 'method' => $_SERVER['REQUEST_METHOD']]);

// Шлях до папки з файлами реклами
$VIDEOS_DIR = dirname(__DIR__) . '/videos';
$ALLOWED_EXT = ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'jpg', 'jpeg', 'png', 'gif', 'webp'];

function generate_uuid()
{
   $data = random_bytes(16);
   $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
   $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
   return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
}

// Клієнт бачить і змінює лише власну рекламу
$ownerWhere = $isClient ? "owner_user_id = " . (int)$currentUser['id'] : "1";

// Повертає ім'я файлу реклами, доступної поточному користувачу, або null
function adsFindAccessibleFile(mysqli $db2, $id, $ownerWhere)
{
   $file = null;
   $qu = "SELECT file FROM advertisement WHERE id = " . intval($id) . " AND $ownerWhere LIMIT 1";
   if ($res = $db2->query($qu)) {
      if ($r = $res->fetch_assoc()) $file = (string)$r['file'];
      $res->free();
   }
   return $file;
}

// =============================================
// LIST — список реклами (для клієнта — лише власної)
// =============================================
if ($action === 'list') {
   $ads = [];
   $qu = "SELECT id, name, file, created_at FROM advertisement WHERE $ownerWhere ORDER BY created_at DESC, id DESC";
   if ($res = $db2->query($qu)) {
      while ($r = $res->fetch_assoc()) {
         $ads[] = $r;
      }
      $res->free();
   } else {
      logDebug("list: query error", $db2->error);
      echo json_encode(['error' => 'Помилка читання БД']);
      exit;
   }
   echo json_encode(['ads' => $ads]);
   exit;
}

// =============================================
// ADD AD — створити нову рекламу
// =============================================
if ($action === 'add_ad' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $name = isset($_POST['ad_name']) ? trim($_POST['ad_name']) : '';

   $errors = [];
   if ($name === '') $errors[] = 'Введіть назву реклами';

   if (empty($_FILES['video_file']) || $_FILES['video_file']['error'] !== UPLOAD_ERR_OK) {
      $errors[] = 'Файл не завантажено';
   }

   if (!empty($errors)) {
      echo json_encode(['ok' => false, 'errors' => $errors]);
      exit;
   }

   $originalName = isset($_FILES['video_file']['name']) ? $_FILES['video_file']['name'] : '';
   $ext = '';
   if (is_string($originalName) && strpos($originalName, '.') !== false) {
      $ext = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
   }
   if (!in_array($ext, $ALLOWED_EXT, true)) {
      echo json_encode(['ok' => false, 'errors' => ['Непідтримуваний тип файлу']]);
      exit;
   }

   if (!is_dir($VIDEOS_DIR)) {
      @mkdir($VIDEOS_DIR, 0755, true);
   }

   // Генеруємо унікальне ім'я (uuid + оригінальне розширення)
   $targetName = generate_uuid() . '.' . $ext;
   $targetPath = $VIDEOS_DIR . '/' . $targetName;

   if (!move_uploaded_file($_FILES['video_file']['tmp_name'], $targetPath)) {
      logDebug("add_ad: cannot move uploaded file", ['target' => $targetPath]);
      echo json_encode(['ok' => false, 'errors' => ['Неможливо перемістити завантажений файл']]);
      exit;
   }
   @chmod($targetPath, 0644);

   $nameEsc = $db2->real_escape_string($name);
   $fileEsc = $db2->real_escape_string($targetName);
   $ownerId = (int)$currentUser['id'];
   $sql = "INSERT INTO advertisement (name, file, owner_user_id) VALUES ('$nameEsc', '$fileEsc', $ownerId)";

   if ($db2->query($sql)) {
      echo json_encode(['ok' => true, 'id' => $db2->insert_id]);
   } else {
      // Якщо БД не прийняла — прибираємо файл, щоб не лишати сміття
      @unlink($targetPath);
      logDebug("add_ad: DB insert failed", $db2->error);
      echo json_encode(['ok' => false, 'errors' => ['Помилка вставки в БД: ' . $db2->error]]);
   }
   exit;
}

// =============================================
// UPDATE AD — змінити назву та/або файл
// =============================================
if ($action === 'update_ad' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $id = isset($_POST['ad_id']) ? intval($_POST['ad_id']) : 0;
   $name = isset($_POST['ad_name']) ? trim($_POST['ad_name']) : '';

   if ($id <= 0) {
      http_response_code(400);
      echo json_encode(['ok' => false, 'errors' => ['Відсутній ad_id']]);
      exit;
   }

   // Перевіряємо, що такий запис існує й доступний (і дізнаємось старий файл)
   $oldFile = adsFindAccessibleFile($db2, $id, $ownerWhere);
   if ($oldFile === null) {
      http_response_code(404);
      echo json_encode(['ok' => false, 'errors' => ['Рекламу не знайдено']]);
      exit;
   }

   $updates = [];

   if ($name !== '') {
      $updates[] = "name = '" . $db2->real_escape_string($name) . "'";
   }

   // Якщо завантажено новий файл — зберігаємо новий, видаляємо старий
   $newFileName = null;
   if (!empty($_FILES['video_file']) && $_FILES['video_file']['error'] === UPLOAD_ERR_OK) {
      $originalName = isset($_FILES['video_file']['name']) ? $_FILES['video_file']['name'] : '';
      $ext = '';
      if (is_string($originalName) && strpos($originalName, '.') !== false) {
         $ext = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
      }
      if (!in_array($ext, $ALLOWED_EXT, true)) {
         echo json_encode(['ok' => false, 'errors' => ['Непідтримуваний тип файлу']]);
         exit;
      }
      if (!is_dir($VIDEOS_DIR)) {
         @mkdir($VIDEOS_DIR, 0755, true);
      }
      $targetName = generate_uuid() . '.' . $ext;
      $targetPath = $VIDEOS_DIR . '/' . $targetName;
      if (!move_uploaded_file($_FILES['video_file']['tmp_name'], $targetPath)) {
         logDebug("update_ad: cannot move uploaded file", ['target' => $targetPath]);
         echo json_encode(['ok' => false, 'errors' => ['Неможливо перемістити завантажений файл']]);
         exit;
      }
      @chmod($targetPath, 0644);
      $newFileName = $targetName;
      $updates[] = "file = '" . $db2->real_escape_string($targetName) . "'";
   }

   if (empty($updates)) {
      echo json_encode(['ok' => false, 'errors' => ['Нічого не змінено']]);
      exit;
   }

   $updates[] = "created_at = NOW()";

   $sql = "UPDATE advertisement SET " . implode(', ', $updates) . " WHERE id = " . intval($id);
   if (!$db2->query($sql)) {
      logDebug("update_ad: DB update failed", $db2->error);
      // Якщо ми вже встигли зберегти новий файл, а UPDATE впав — приберемо новий, щоб не лишати сміття
      if ($newFileName) {
         @unlink($VIDEOS_DIR . '/' . $newFileName);
      }
      http_response_code(500);
      echo json_encode(['ok' => false, 'errors' => ['Помилка оновлення БД: ' . $db2->error]]);
      exit;
   }

   // Видаляємо старий файл, якщо завантажено новий
   if ($newFileName && !empty($oldFile)) {
      $oldPath = $VIDEOS_DIR . '/' . basename($oldFile);
      if (file_exists($oldPath)) @unlink($oldPath);
   }

   echo json_encode(['ok' => true]);
   exit;
}

// =============================================
// DELETE AD — видалити рекламу + файл
// =============================================
if ($action === 'delete_ad' && $_SERVER['REQUEST_METHOD'] === 'POST') {
   $id = isset($_POST['id']) ? intval($_POST['id']) : 0;

   if ($id <= 0) {
      http_response_code(400);
      echo json_encode(['ok' => false, 'errors' => ['Відсутній id']]);
      exit;
   }

   // Дізнаємось ім'я файлу (і заодно перевіряємо доступ)
   $fileName = adsFindAccessibleFile($db2, $id, $ownerWhere);
   if ($fileName === null) {
      http_response_code(404);
      echo json_encode(['ok' => false, 'errors' => ['Рекламу не знайдено']]);
      exit;
   }

   if (!$db2->query("DELETE FROM advertisement WHERE id = " . intval($id) . " AND $ownerWhere")) {
      logDebug("delete_ad: DB delete failed", $db2->error);
      http_response_code(500);
      echo json_encode(['ok' => false, 'errors' => ['Помилка видалення з БД']]);
      exit;
   }

   if (!empty($fileName)) {
      $path = $VIDEOS_DIR . '/' . basename($fileName);
      if (file_exists($path)) @unlink($path);
   }

   echo json_encode(['ok' => true]);
   exit;
}

logDebug("Unknown action", ['action' => $action]);
echo json_encode(['error' => 'Невідома дія ' . $action]);
