<?php

ini_set('error_reporting', E_ALL);
ini_set('display_errors', 0);
ini_set('display_startup_errors', 0);
date_default_timezone_set('Europe/Kiev');

// Перевірка авторизації (також підключає БД)
require_once __DIR__ . '/includes/auth.php';
$currentUser = authRequirePage();
$accessLevel = $currentUser['role'];

// Визначити доступні сторінки для кожної ролі
$availablePages = [];
switch ($accessLevel) {
  case 'admin':
    $availablePages = ['advertisement', 'advert_to_route', 'car_to_route', 'routes', 'track', 'all_car_routes', 'tariffs', 'final_stops', 'users'];
    break;
  case 'routes_track':
    $availablePages = ['routes', 'track', 'all_car_routes', 'tariffs', 'final_stops'];
    break;
  case 'client':
    // Маршрути — лише перегляд призначених
    $availablePages = ['advertisement', 'advert_to_route', 'car_to_route', 'routes'];
    break;
  case 'viewer':
    // Посилання з платформи підрахунку: трек і маршрути однієї машини, лише перегляд
    $availablePages = ['track', 'routes'];
    break;
  case 'advertisement':
  default:
    $availablePages = ['advertisement', 'advert_to_route', 'car_to_route'];
    break;
}

// Визначити поточну сторінку
$currentPage = $_GET['page'] ?? $availablePages[0];

// Перевірити чи користувач має доступ до запитаної сторінки
if (!in_array($currentPage, $availablePages)) {
  $currentPage = $availablePages[0];
}

// Назви сторінок для відображення
$pageNames = [
  'advertisement' => 'Реклама',
  'routes' => 'Маршрути',
  'track' => 'Трек',
  'advert_to_route' => 'Реклама до маршруту',
  'car_to_route' => 'Транспорт до маршруту',
  'all_car_routes' => 'Усі маршрути і глобальні зони машини',
  'tariffs' => 'Тарифи маршрутів',
  'final_stops' => 'Глобальні зони',
  'users' => 'Користувачі',
];

// Групи навігації: два селекти замість кнопок
$navGroups = [
  'display' => [
    'label' => 'Робота з дисплеєм',
    'pages' => ['advertisement', 'advert_to_route', 'car_to_route'],
  ],
  'routes' => [
    'label' => 'Робота з маршрутами',
    'pages' => ['routes', 'track', 'all_car_routes', 'tariffs', 'final_stops'],
  ],
  'admin' => [
    'label' => 'Адміністрування',
    'pages' => ['users'],
  ],
];

$userLabel = $currentUser['display_name'] ?: $currentUser['login'];

// Глядач з підрахунку: при перемиканні на «Трек» не губити IMEI і день з панелі.
$viewerNavTrackQs = '';
if ($accessLevel === 'viewer') {
   $vim = authUserImeis($currentUser);
   $vimei = (string)($vim[0] ?? '');
   $vdate = trim((string)($_GET['date'] ?? ''));
   if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $vdate)) $vdate = viewerTrackDayFromCookie();
   if ($vimei !== '') {
      $viewerNavTrackQs = '&imei=' . rawurlencode($vimei);
      if ($vdate !== '') $viewerNavTrackQs .= '&date=' . rawurlencode($vdate);
   }
}
?>
<!doctype html>
<html lang="uk">

<head>
  <meta charset="utf-8">
  <title><?= htmlspecialchars($pageNames[$currentPage] ?? 'Консоль', ENT_QUOTES, 'UTF-8') ?> - Консоль управління</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="assets/css/styles.css">
  <script>
    window.CURRENT_USER = <?= json_encode([
                            'id' => $currentUser['id'],
                            'login' => $currentUser['login'],
                            'role' => $currentUser['role'],
                          ], JSON_UNESCAPED_UNICODE | JSON_HEX_TAG) ?>;
    window.RAM_VIEWER_TRACK_QS = <?= json_encode($viewerNavTrackQs, JSON_UNESCAPED_UNICODE) ?>;
    function ramNavTo(sel) {
      if (!sel || !sel.value) return;
      var href = '?page=' + encodeURIComponent(sel.value);
      if (sel.value === 'track' && window.RAM_VIEWER_TRACK_QS) href += window.RAM_VIEWER_TRACK_QS;
      window.location.href = href;
    }
  </script>
</head>

<body>
  <!-- Header з навігацією -->
  <header class="main-header">
    <div class="header-container">
      <div class="header-nav">
        <?php foreach ($navGroups as $groupKey => $group):
          // Залишаємо тільки сторінки, до яких користувач має доступ
          $groupPages = array_values(array_intersect($group['pages'], $availablePages));
          if (empty($groupPages)) continue;
          $groupHasCurrent = in_array($currentPage, $groupPages, true);
        ?>
          <select
            class="nav-select nav-group-<?= htmlspecialchars($groupKey, ENT_QUOTES, 'UTF-8') ?> <?= $groupHasCurrent ? 'active' : '' ?>"
            data-nav-group="<?= htmlspecialchars($groupKey, ENT_QUOTES, 'UTF-8') ?>"
            onchange="ramNavTo(this)">
            <option value="" <?= $groupHasCurrent ? '' : 'selected' ?>>
              <?= htmlspecialchars($group['label'], ENT_QUOTES, 'UTF-8') ?>
            </option>
            <?php foreach ($groupPages as $page): ?>
              <option value="<?= htmlspecialchars($page, ENT_QUOTES, 'UTF-8') ?>"
                <?= $currentPage === $page ? 'selected' : '' ?>>
                <?= htmlspecialchars($pageNames[$page] ?? $page, ENT_QUOTES, 'UTF-8') ?>
              </option>
            <?php endforeach; ?>
          </select>
        <?php endforeach; ?>
      </div>
      <div class="header-user">
        <span class="header-user-name" title="<?= htmlspecialchars(authRoleLabel($accessLevel), ENT_QUOTES, 'UTF-8') ?>">
          <?= htmlspecialchars($userLabel, ENT_QUOTES, 'UTF-8') ?>
        </span>
        <a href="auth/logout.php" class="nav-btn nav-btn-logout">Вихід</a>
      </div>
    </div>
  </header>

  <!-- Контент сторінки -->
  <main class="main-content">
    <?php
    // Підключити відповідну сторінку
    $pageFile = __DIR__ . '/pages/' . $currentPage . '.php';
    if (file_exists($pageFile)) {
      include $pageFile;
    } else {
      echo '<div class="wrap"><div class="block"><p>Сторінку не знайдено</p></div></div>';
    }
    ?>
  </main>
</body>

</html>