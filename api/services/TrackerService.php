<?php

/**
 * TrackerService — запити до бази GPS для роботи з трекерами
 * 
 * Використовує підключення $db (GPS database) з connectDB.php
 * 
 * Таблиці:
 *   - trackers — основна інформація про трекер (imei, id, tracker_table, координати, швидкість)
 *   - {tracker_table} — таблиця з історією руху конкретного трекера (напр. _car_926)
 */

class TrackerService
{
   /** @var mysqli */
   private $db;

   /** @var string — остання помилка для діагностики */
   public $lastError = '';

   /**
    * @param mysqli $db — підключення до GPS бази
    */
   public function __construct($db)
   {
      $this->db = $db;
   }

    // ─────────────────────────────────────
    // Отримання інформації про трекер
    // ─────────────────────────────────────

   /**
    * Отримати поточні дані трекера за IMEI.
    * 
    * Повертає: id, tracker_table, latitude, longtitude, speed, satellites, 
    *           direction, heading, last_seen (epochtime останнього пакету)
    *
    * @param string $imei — IMEI трекера
    * @return array|null — дані трекера або null якщо не знайдено
    */
   public function getTrackerByImei($imei)
   {
      $result = $this->getTrackersByImeis([$imei]);
      if (!isset($result[(string)$imei])) {
         if ($this->lastError === '') {
            $this->lastError = 'No rows found for imei=' . $imei;
         }
         return null;
      }
      return $result[(string)$imei];
   }

   /**
    * Batch-варіант: отримати дані для масиву IMEI одним запитом.
    *
    * @param array $imeis — масив IMEI (string|int)
    * @return array — асоціативний масив [imei => trackerData]; відсутні IMEI просто не присутні в результаті
    */
   public function getTrackersByImeis(array $imeis)
   {
      if (!$this->db) {
         $this->lastError = 'DB connection is null';
         return [];
      }
      if ($this->db->connect_error) {
         $this->lastError = 'DB connect_error: ' . $this->db->connect_error;
         return [];
      }

      // Дедуплікація + видалення порожніх
      $clean = [];
      foreach ($imeis as $im) {
         $im = trim((string)$im);
         if ($im !== '') $clean[$im] = true;
      }
      if (empty($clean)) {
         return [];
      }

      $escaped = [];
      foreach (array_keys($clean) as $im) {
         $escaped[] = "'" . $this->db->real_escape_string($im) . "'";
      }
      $inList = implode(',', $escaped);

      $sql = "SELECT 
                    `id`, 
                    `imei`,
                    `name`,
                    `tracker_table`, 
                    `latitude`, 
                    `longtitude`, 
                    `speed`, 
                    `satellites`, 
                    `direction`,
                    `last_seen`
                FROM `trackers` 
                WHERE `imei` IN ({$inList})";

      $res = $this->db->query($sql);
      if (!$res) {
         $this->lastError = 'Query failed: ' . $this->db->error;
         return [];
      }

      $out = [];
      while ($row = $res->fetch_assoc()) {
         $out[(string)$row['imei']] = [
            'id'            => (int)$row['id'],
            'imei'          => $row['imei'],
            'name'          => $row['name'],
            'tracker_table' => $row['tracker_table'],
            'latitude'      => (float)$row['latitude'],
            'longtitude'    => (float)$row['longtitude'],
            'speed'         => (float)$row['speed'],
            'satellites'    => (int)$row['satellites'],
            'direction'     => (int)$row['direction'],
            'last_seen'     => (int)$row['last_seen'],
         ];
      }
      $res->free();

      return $out;
   }

    // ─────────────────────────────────────
    // Отримання треку (історії руху)
    // ─────────────────────────────────────

   /**
    * Отримати трек машини за період часу.
    * 
    * Використовує tracker_table (напр. _car_926) та id трекера.
    * Повертає масив точок з полями: speed, epochtime, latitude, longtitude, direction
    *
    * @param string $trackerTable — назва таблиці (з поля tracker_table)
    * @param int    $trackerId    — id трекера (з таблиці trackers)
    * @param int    $timeFrom     — початок періоду (unix timestamp)
    * @param int    $timeTo       — кінець періоду (unix timestamp)
    * @param string $order        — порядок сортування: 'ASC' або 'DESC'
    * @return array — масив точок
    */
   public function getTrack($trackerTable, $trackerId, $timeFrom, $timeTo, $order = 'ASC')
   {
      // Захист від SQL injection в назві таблиці
      $table = $this->sanitizeTableName($trackerTable);
      if ($table === null) {
         return [];
      }

      $trackerId = (int)$trackerId;
      $timeFrom = (int)$timeFrom;
      $timeTo = (int)$timeTo;
      $order = strtoupper($order) === 'DESC' ? 'DESC' : 'ASC';

      $sql = "SELECT 
                    `speed`, 
                    `epochtime`, 
                    `latitude`, 
                    `longtitude`, 
                    `direction`
                FROM `{$table}` 
                WHERE `imei` = {$trackerId} 
                  AND `epochtime` BETWEEN {$timeFrom} AND {$timeTo}
                ORDER BY `epochtime` {$order}";

      $res = $this->db->query($sql);
      if (!$res) {
         return [];
      }

      $points = [];
      while ($row = $res->fetch_assoc()) {
         $points[] = [
            'speed'      => (float)$row['speed'],
            'epochtime'  => (int)$row['epochtime'],
            'latitude'   => (float)$row['latitude'],
            'longtitude' => (float)$row['longtitude'],
            'direction'  => (int)$row['direction'],
         ];
      }
      $res->free();

      return $points;
   }

   /**
    * Отримати останні N точок руху трекера.
    * 
    * Корисно для визначення поточного напрямку та позиції.
    *
    * @param string $trackerTable — назва таблиці
    * @param int    $trackerId    — id трекера
    * @param int    $limit        — кількість останніх точок (за замовчуванням 10)
    * @param int    $maxAge       — максимальний вік точок у секундах (за замовчуванням 300 = 5 хв)
    * @return array — масив точок (від найновішої до найстарішої)
    */
   public function getRecentPoints($trackerTable, $trackerId, $limit = 10, $maxAge = 300)
   {
      $table = $this->sanitizeTableName($trackerTable);
      if ($table === null) {
         return [];
      }

      $trackerId = (int)$trackerId;
      $limit = max(1, min((int)$limit, 1000)); // обмеження 1..1000
      $minTime = time() - (int)$maxAge;

      $sql = "SELECT 
                    `speed`, 
                    `epochtime`, 
                    `latitude`, 
                    `longtitude`, 
                    `direction`
                FROM `{$table}` 
                WHERE `imei` = {$trackerId} 
                  AND `epochtime` >= {$minTime}
                ORDER BY `epochtime` DESC
                LIMIT {$limit}";

      $res = $this->db->query($sql);
      if (!$res) {
         return [];
      }

      $points = [];
      while ($row = $res->fetch_assoc()) {
         $points[] = [
            'speed'      => (float)$row['speed'],
            'epochtime'  => (int)$row['epochtime'],
            'latitude'   => (float)$row['latitude'],
            'longtitude' => (float)$row['longtitude'],
            'direction'  => (int)$row['direction'],
         ];
      }
      $res->free();

      return $points;
   }

   /**
    * Отримати останню відому позицію трекера з таблиці руху.
    * 
    * Якщо в таблиці руху немає свіжих даних — повертає координати з trackers.
    *
    * @param string $trackerTable — назва таблиці
    * @param int    $trackerId    — id трекера
    * @param float  $fallbackLat  — запасна широта (з таблиці trackers)
    * @param float  $fallbackLng  — запасна довгота (з таблиці trackers)
    * @return array
    */
   public function getLastPosition($trackerTable, $trackerId, $fallbackLat = 0, $fallbackLng = 0)
   {
      $table = $this->sanitizeTableName($trackerTable);
      if ($table === null) {
         return [
            'latitude'   => (float)$fallbackLat,
            'longtitude' => (float)$fallbackLng,
            'epochtime'  => 0,
            'speed'      => 0.0,
            'direction'  => 0,
         ];
      }

      $trackerId = (int)$trackerId;

      $sql = "SELECT 
                    `speed`, 
                    `epochtime`, 
                    `latitude`, 
                    `longtitude`, 
                    `direction`
                FROM `{$table}` 
                WHERE `imei` = {$trackerId}
                ORDER BY `epochtime` DESC
                LIMIT 1";

      $res = $this->db->query($sql);
      if ($res && $row = $res->fetch_assoc()) {
         $res->free();
         return [
            'latitude'   => (float)$row['latitude'],
            'longtitude' => (float)$row['longtitude'],
            'epochtime'  => (int)$row['epochtime'],
            'speed'      => (float)$row['speed'],
            'direction'  => (int)$row['direction'],
         ];
      }

      // Якщо в таблиці руху нічого немає — повертаємо дані з trackers
      return [
         'latitude'   => (float)$fallbackLat,
         'longtitude' => (float)$fallbackLng,
         'epochtime'  => 0,
         'speed'      => 0.0,
         'direction'  => 0,
      ];
   }

    // ─────────────────────────────────────
    // Утиліти
    // ─────────────────────────────────────

   /**
    * Захист від SQL injection у назві таблиці.
    * Дозволяє тільки [a-zA-Z0-9_] — формат _car_926, _bus_123 тощо.
    *
    * @param string $tableName
    * @return string|null — очищена назва або null якщо невалідна
    */
   private function sanitizeTableName($tableName)
   {
      $clean = preg_replace('/[^a-zA-Z0-9_]/', '', $tableName);
      if ($clean === '' || $clean !== $tableName) {
         return null;
      }
      return $clean;
   }
}
