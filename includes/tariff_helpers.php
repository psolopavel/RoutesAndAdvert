<?php

/**
 * Допоміжні функції для тарифів міжміських маршрутів.
 * Пари зберігаються як "<stopIdMin>-<stopIdMax>" => ціна.
 */

/** @return int[]|null */
function parseTariffPairKey($key)
{
   if (!preg_match('/^(\d+)-(\d+)$/', (string)$key, $m)) {
      return null;
   }
   return [intval($m[1]), intval($m[2])];
}

/**
 * Залишає лише пари, де обидві зупинки є в $validStopIds.
 *
 * @param array<string, mixed> $pairs
 * @param int[] $validStopIds
 * @return array<string, float>
 */
function filterTariffPairs(array $pairs, array $validStopIds)
{
   $valid = array_flip(array_map('intval', $validStopIds));
   $filtered = [];

   foreach ($pairs as $key => $val) {
      if ($val === '' || $val === null) {
         continue;
      }
      $ids = parseTariffPairKey($key);
      if (!$ids) {
         continue;
      }
      if (isset($valid[$ids[0]], $valid[$ids[1]])) {
         $filtered[$key] = round(floatval($val), 2);
      }
   }

   return $filtered;
}

/** @return int[] */
function getRouteStopIds($db2, $routeId)
{
   $ids = [];
   $routeId = intval($routeId);
   if ($routeId <= 0) {
      return $ids;
   }

   $res = $db2->query("SELECT id FROM stops WHERE route_id = $routeId");
   if ($res) {
      while ($row = $res->fetch_assoc()) {
         $ids[] = intval($row['id']);
      }
      $res->free();
   }

   return $ids;
}

/**
 * Видаляє з тарифів маршруту всі пари, що містять зупинку $stopId.
 */
function removeStopFromRouteTariffs($db2, $db3, $stopId, $routeId = null)
{
   if (!$db3) {
      return;
   }

   $stopId = intval($stopId);
   if ($stopId <= 0) {
      return;
   }

   if ($routeId === null) {
      $res = $db2->query("SELECT route_id FROM stops WHERE id = $stopId LIMIT 1");
      if (!$res || !($row = $res->fetch_assoc())) {
         return;
      }
      $routeId = intval($row['route_id']);
      $res->free();
   } else {
      $routeId = intval($routeId);
   }

   if ($routeId <= 0) {
      return;
   }

   $validStopIds = getRouteStopIds($db2, $routeId);
   cleanupRouteTariffPairs($db2, $db3, $routeId, $validStopIds);
}

/**
 * Нормалізує пари в усіх тарифах маршруту за актуальним списком зупинок.
 *
 * @param int[]|null $validStopIds якщо null — читає з БД
 */
function cleanupRouteTariffPairs($db2, $db3, $routeId, $validStopIds = null)
{
   if (!$db3) {
      return;
   }

   $routeId = intval($routeId);
   if ($routeId <= 0) {
      return;
   }

   if ($validStopIds === null) {
      $validStopIds = getRouteStopIds($db2, $routeId);
   }

   $stmt = $db3->prepare("SELECT id, prices FROM tariffs WHERE route_id = ?");
   $stmt->bind_param('i', $routeId);
   $stmt->execute();
   $res = $stmt->get_result();

   while ($row = $res->fetch_assoc()) {
      $prices = $row['prices'] ? json_decode($row['prices'], true) : null;
      if (!is_array($prices) || ($prices['kind'] ?? '') !== 'intercity') {
         continue;
      }

      $pairs = isset($prices['pairs']) && is_array($prices['pairs']) ? $prices['pairs'] : [];
      $filtered = filterTariffPairs($pairs, $validStopIds);

      if (count($filtered) === count($pairs)) {
         $same = true;
         foreach ($filtered as $key => $val) {
            if (!isset($pairs[$key]) || round(floatval($pairs[$key]), 2) != $val) {
               $same = false;
               break;
            }
         }
         if ($same) {
            continue;
         }
      }

      $prices['pairs'] = $filtered;
      $pricesJson = json_encode($prices, JSON_UNESCAPED_UNICODE);
      $tariffId = intval($row['id']);

      $upd = $db3->prepare("UPDATE tariffs SET prices = ? WHERE id = ?");
      $upd->bind_param('si', $pricesJson, $tariffId);
      $upd->execute();
      $upd->close();
   }

   $stmt->close();
}
