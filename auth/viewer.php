<?php

/**
 * Вхід за підписаним посиланням з платформи підрахунку пасажирів:
 * ?t=<token>&date=YYYY-MM-DD → cookie глядача → сторінка треку машини.
 */

ini_set('display_errors', 0);
date_default_timezone_set('Europe/Kiev');

require_once __DIR__ . '/../includes/auth.php';

$date = (string)($_GET['date'] ?? '');
if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) $date = '';

$claims = viewerVerifyToken((string)($_GET['t'] ?? ''));
if ($claims === null) {
   http_response_code(403);
   header('Content-Type: text/html; charset=utf-8');
   echo '<!doctype html><html lang="uk"><head><meta charset="utf-8"><title>Посилання недійсне</title></head><body style="font-family:sans-serif;padding:2rem">'
      . '<h2>Посилання недійсне або застаріле</h2>'
      . '<p>Відкрийте перегляд маршрутів і треку ще раз з панелі підрахунку.</p></body></html>';
   exit;
}

$query = ['page' => 'track', 'imei' => $claims['imei']];
if ($date !== '') $query['date'] = $date;
$target = '../Manager.php?' . http_build_query($query);

// Користувач, що вже бачить усі треки, лишається у своєму обліковому записі
$user = authCurrentUser();
if ($user && in_array($user['role'], ['admin', 'routes_track'], true)) {
   header('Location: ' . $target);
   exit;
}

// Інша сесія консолі (клієнт / реклама) перекрила б глядача — завершуємо її
if (authCookieToken() !== null) authLogout();

viewerSetCookie($_GET['t'], $claims['exp']);
header('Location: ' . $target);
exit;
