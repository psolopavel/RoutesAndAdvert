<?php

/**
 * GeoUtils — геометричні утиліти для роботи з координатами
 * 
 * Всі координати у форматі десяткових градусів (decimal degrees).
 * Lat/Lng порядок: latitude першим, longitude другим (як у БД).
 */

class GeoUtils
{
   /** Радіус Землі в метрах */
   const EARTH_RADIUS = 6371000;

    // ─────────────────────────────────────
    // Відстань між точками
    // ─────────────────────────────────────

   /**
    * Haversine — відстань між двома точками на сфері (в метрах).
    *
    * @param float $lat1
    * @param float $lon1
    * @param float $lat2
    * @param float $lon2
    * @return float — відстань у метрах
    */
   public static function haversineDistance($lat1, $lon1, $lat2, $lon2)
   {
      $dLat = deg2rad($lat2 - $lat1);
      $dLon = deg2rad($lon2 - $lon1);

      $a = sin($dLat / 2) * sin($dLat / 2) +
         cos(deg2rad($lat1)) * cos(deg2rad($lat2)) *
         sin($dLon / 2) * sin($dLon / 2);

      $c = 2 * atan2(sqrt($a), sqrt(1 - $a));

      return self::EARTH_RADIUS * $c;
   }

    // ─────────────────────────────────────
    // Bearing (азимут)
    // ─────────────────────────────────────

   /**
    * Обчислити початковий азимут (bearing) від точки A до точки B.
    *
    * @param float $lat1 — широта A
    * @param float $lon1 — довгота A
    * @param float $lat2 — широта B
    * @param float $lon2 — довгота B
    * @return float — азимут у градусах 0..360
    */
   public static function bearing($lat1, $lon1, $lat2, $lon2)
   {
      $dLon = deg2rad($lon2 - $lon1);
      $lat1r = deg2rad($lat1);
      $lat2r = deg2rad($lat2);

      $x = sin($dLon) * cos($lat2r);
      $y = cos($lat1r) * sin($lat2r) - sin($lat1r) * cos($lat2r) * cos($dLon);

      $bearing = rad2deg(atan2($x, $y));
      return fmod($bearing + 360, 360);
   }

   /**
    * Різниця між двома кутами (0..180).
    *
    * @param float $a — кут у градусах
    * @param float $b — кут у градусах
    * @return float — різниця 0..180
    */
   public static function angleDifference($a, $b)
   {
      $diff = abs($a - $b);
      return $diff > 180 ? 360 - $diff : $diff;
   }

    // ─────────────────────────────────────
    // Проекція точки на лінію (snap-to-line)
    // ─────────────────────────────────────

   /**
    * Проекція точки на відрізок AB.
    * 
    * Повертає долю (0..1) вздовж відрізка та відстань від точки до проекції.
    *
    * @param float $pLat — широта точки
    * @param float $pLon — довгота точки
    * @param float $aLat — широта початку відрізка
    * @param float $aLon — довгота початку відрізка
    * @param float $bLat — широта кінця відрізка
    * @param float $bLon — довгота кінця відрізка
    * @return array — ['fraction' => float 0..1, 'distance' => float метри, 'projLat' => float, 'projLon' => float]
    */
   public static function projectPointOnSegment($pLat, $pLon, $aLat, $aLon, $bLat, $bLon)
   {
      $dx = $bLon - $aLon;
      $dy = $bLat - $aLat;

      if ($dx == 0 && $dy == 0) {
         // Вироджений сегмент (точка)
         return [
            'fraction' => 0.0,
            'distance' => self::haversineDistance($pLat, $pLon, $aLat, $aLon),
            'projLat'  => $aLat,
            'projLon'  => $aLon,
         ];
      }

      // t — частка проекції (0 = початок, 1 = кінець)
      // Для невеликих відстаней проекція на площині достатньо точна
      $t = (($pLon - $aLon) * $dx + ($pLat - $aLat) * $dy) / ($dx * $dx + $dy * $dy);
      $t = max(0.0, min(1.0, $t));

      $projLat = $aLat + $t * $dy;
      $projLon = $aLon + $t * $dx;

      return [
         'fraction' => $t,
         'distance' => self::haversineDistance($pLat, $pLon, $projLat, $projLon),
         'projLat'  => $projLat,
         'projLon'  => $projLon,
      ];
   }

   /**
    * Snap-to-line: знаходить найближчу точку на LINESTRING до заданої позиції.
    * 
    * Координати маршруту мають формат [[lat, lng], [lat, lng], ...].
    * 
    * Повертає:
    *   - distance    — відстань від точки до маршруту (метри)
    *   - segment     — індекс сегмента маршруту
    *   - fraction    — частка всередині сегмента (0..1)
    *   - progress    — загальний прогрес вздовж всього маршруту (0.0..1.0)
    *   - projLat/Lon — координати проекції на маршрут
    *
    * @param float $lat          — широта точки
    * @param float $lon          — довгота точки
    * @param array $routeCoords  — координати маршруту [[lat, lng], ...]
    * @return array
    */
   public static function snapToLine($lat, $lon, $routeCoords)
   {
      $n = count($routeCoords);

      if ($n === 0) {
         return [
            'distance' => 99999999,
            'segment'  => 0,
            'fraction' => 0.0,
            'progress' => 0.0,
            'projLat'  => $lat,
            'projLon'  => $lon,
         ];
      }

      if ($n === 1) {
         $dist = self::haversineDistance($lat, $lon, $routeCoords[0][0], $routeCoords[0][1]);
         return [
            'distance' => $dist,
            'segment'  => 0,
            'fraction' => 0.0,
            'progress' => 0.0,
            'projLat'  => $routeCoords[0][0],
            'projLon'  => $routeCoords[0][1],
         ];
      }

      // 1. Обчислюємо довжину кожного сегмента
      $segLengths = [];
      $totalLength = 0;

      for ($i = 0; $i < $n - 1; $i++) {
         $len = self::haversineDistance(
            $routeCoords[$i][0],
            $routeCoords[$i][1],
            $routeCoords[$i + 1][0],
            $routeCoords[$i + 1][1]
         );
         $segLengths[] = $len;
         $totalLength += $len;
      }

      // 2. Знаходимо найближчий сегмент
      $minDist = 99999999;
      $bestSegment = 0;
      $bestFraction = 0.0;
      $bestProgress = 0.0;
      $bestProjLat = $routeCoords[0][0];
      $bestProjLon = $routeCoords[0][1];

      $accumulated = 0;

      for ($i = 0; $i < $n - 1; $i++) {
         $proj = self::projectPointOnSegment(
            $lat,
            $lon,
            $routeCoords[$i][0],
            $routeCoords[$i][1],
            $routeCoords[$i + 1][0],
            $routeCoords[$i + 1][1]
         );

         if ($proj['distance'] < $minDist) {
            $minDist = $proj['distance'];
            $bestSegment = $i;
            $bestFraction = $proj['fraction'];
            $bestProjLat = $proj['projLat'];
            $bestProjLon = $proj['projLon'];

            if ($totalLength > 0) {
               $bestProgress = ($accumulated + $segLengths[$i] * $proj['fraction']) / $totalLength;
            }
         }

         $accumulated += $segLengths[$i];
      }

      return [
         'distance' => $minDist,
         'segment'  => $bestSegment,
         'fraction' => $bestFraction,
         'progress' => $bestProgress,
         'projLat'  => $bestProjLat,
         'projLon'  => $bestProjLon,
      ];
   }

    // ─────────────────────────────────────
    // Довжина ламаної
    // ─────────────────────────────────────

   /**
    * Загальна довжина ламаної лінії (в метрах).
    *
    * @param array $coords — [[lat, lng], ...]
    * @return float
    */
   public static function polylineLength($coords)
   {
      $total = 0;
      for ($i = 0; $i < count($coords) - 1; $i++) {
         $total += self::haversineDistance(
            $coords[$i][0],
            $coords[$i][1],
            $coords[$i + 1][0],
            $coords[$i + 1][1]
         );
      }
      return $total;
   }

    // ─────────────────────────────────────
    // Конвертація координат
    // ─────────────────────────────────────

   /**
    * NMEA координати → десяткові градуси.
    * 
    * NMEA формат: DDMM.MMMM (напр. 5027.0324 = 50°27.0324')
    * Десяткові: DD.DDDDDD (напр. 50.450540)
    *
    * @param float $value — NMEA значення
    * @return float — десяткові градуси
    */
   public static function nmeaToDecimal($value)
   {
      if ($value == 0) return 0;

      $deg = floor($value / 100);
      $min = $value - $deg * 100;
      return $deg + $min / 60;
   }

    // ─────────────────────────────────────
    // WKT парсери
    // ─────────────────────────────────────

   /**
    * Парсинг LINESTRING WKT → масив координат [[lat, lng], ...]
    *
    * @param string $wkt
    * @return array
    */
   public static function parseLineStringWKT($wkt)
   {
      if (empty($wkt)) return [];

      if (preg_match('/LINESTRING\s*\((.+)\)/i', $wkt, $matches)) {
         $coords = [];
         $pairs = explode(',', $matches[1]);
         foreach ($pairs as $pair) {
            $parts = preg_split('/\s+/', trim($pair));
            if (count($parts) >= 2) {
               $coords[] = [floatval($parts[1]), floatval($parts[0])]; // [lat, lng]
            }
         }
         return $coords;
      }
      return [];
   }

   /**
    * Парсинг POINT WKT → координати [lat, lng]
    *
    * @param string $wkt
    * @return array|null
    */
   public static function parsePointWKT($wkt)
   {
      if (empty($wkt)) return null;

      if (preg_match('/POINT\s*\(([^\)]+)\)/i', $wkt, $matches)) {
         $parts = preg_split('/\s+/', trim($matches[1]));
         if (count($parts) >= 2) {
            return [floatval($parts[1]), floatval($parts[0])]; // [lat, lng]
         }
      }
      return null;
   }
}
