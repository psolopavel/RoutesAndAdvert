#!/usr/bin/env python3
"""
tracker_daemon.py — спрощений демон відстеження маршрутів транспорту.
Логіка (один тік, кожні N секунд):
  1. Читає active_displays — IMEI з активним player.js.
  2. Для кожного IMEI бере пару маршрутів з routes_to_cars (first_route_id, second_route_id).
  3. Якщо немає активної сесії — обирає той з двох маршрутів, до якого ближче машина
     (з урахуванням напрямку), і створює сесію.
  4. Якщо є активна сесія — оновлює її:
       • snap до поточного route_id;
       • якщо машина далеко — пробує парний маршрут (з гістерезисом ×2);
         якщо обидва далеко → деактивує сесію;
       • якщо машина в кінці маршруту (progress >= 0.98 і speed < 3) → перемикає
         route_id на парний у тій самій сесії та одразу пере-snap до нього;
       • рахує current_stop_id, prev_stop_id, next_stop_id, progress_between_stops
         (доля пройденого відрізка між prev та next).
  5. Сесії IMEI, що зникли з active_displays → деактивує (active=0).
  6. Періодична очистка застарілих active_displays.

Таблиці:
  routes_to_cars(id, imei, first_route_id, second_route_id, date)
    — одна пара маршрутів на IMEI.
  tracking_sessions(id, imei, route_id, progress_between_stops,
                    current_stop_id, prev_stop_id, next_stop_id, active)
    — стан, який читає api/tracking.php для player.js.
  active_displays(imei, last_ping)
    — кого зараз обслуговувати.

Запуск:
  python3 tracker_daemon.py --config /etc/AdvertismentManager/daemon_config.ini
"""

import argparse
import configparser
import logging
import logging.handlers
import os
import signal
import sys
import time

import mysql.connector
from mysql.connector import Error as MySQLError

from alerts_in_ua import Client as AlertsClient

from geo_utils import (
    nmea_to_decimal,
    haversine_distance,
    bearing,
    angle_difference,
    snap_to_line,
    parse_linestring_wkt,
    parse_point_wkt,
)

# ─────────────────────────────────────
# Глобальні змінні
# ─────────────────────────────────────
running = True
logger = logging.getLogger('tracker_daemon')


def signal_handler(sig, frame):
    global running
    logger.info("Отримано сигнал %s, зупиняємо демон...", sig)
    running = False


signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)


# ─────────────────────────────────────
# Конфігурація
# ─────────────────────────────────────

class Config:
    def __init__(self, ini_path: str):
        cfg = configparser.ConfigParser()
        cfg.read(ini_path)

        # GPS DB
        self.gps_host = cfg.get('gps_db', 'host', fallback='localhost')
        self.gps_port = cfg.getint('gps_db', 'port', fallback=3306)
        self.gps_user = cfg.get('gps_db', 'user', fallback='root')
        self.gps_pass = cfg.get('gps_db', 'password', fallback='')
        self.gps_db = cfg.get('gps_db', 'database', fallback='gps')

        # Routes DB
        self.routes_host = cfg.get('routes_db', 'host', fallback='localhost')
        self.routes_port = cfg.getint('routes_db', 'port', fallback=3306)
        self.routes_user = cfg.get('routes_db', 'user', fallback='root')
        self.routes_pass = cfg.get('routes_db', 'password', fallback='')
        self.routes_db = cfg.get('routes_db', 'database', fallback='RoutesAndAdvertisement')

        # Daemon
        self.interval = cfg.getfloat('daemon', 'interval', fallback=3.0)
        self.max_snap_distance = cfg.getfloat('daemon', 'max_snap_distance', fallback=150.0)
        self.max_direction_diff = cfg.getfloat('daemon', 'max_direction_diff', fallback=90.0)
        self.default_stop_radius = cfg.getfloat('daemon', 'default_stop_radius', fallback=30.0)
        self.lost_timeout = cfg.getint('daemon', 'lost_timeout', fallback=300)
        self.recheck_route_interval = cfg.getint('daemon', 'recheck_route_interval', fallback=60)
        self.display_timeout = cfg.getint('daemon', 'display_timeout', fallback=300)
        self.route_end_progress = cfg.getfloat('daemon', 'route_end_progress', fallback=0.98)
        self.route_end_speed = cfg.getfloat('daemon', 'route_end_speed', fallback=3.0)
        self.switch_hysteresis = cfg.getfloat('daemon', 'switch_hysteresis', fallback=0.5)

        # Alerts (alerts.in.ua API)
        self.alerts_token = cfg.get('alerts', 'token', fallback='')
        self.alerts_interval = cfg.getfloat('alerts', 'interval', fallback=30.0)

        # Logging
        self.log_file = cfg.get('daemon', 'log_file',
                                fallback='/tmp/AdvertismentManager/logs/tracker_daemon.log')
        self.log_level = cfg.get('daemon', 'log_level', fallback='INFO')


# ─────────────────────────────────────
# Підключення до БД
# ─────────────────────────────────────

class DBPool:
    """Прості підключення до двох баз з автоматичним перепідключенням."""

    def __init__(self, config: Config):
        self.config = config
        self.gps_conn = None
        self.routes_conn = None

    def get_gps(self):
        if self.gps_conn is None or not self.gps_conn.is_connected():
            self.gps_conn = mysql.connector.connect(
                host=self.config.gps_host,
                port=self.config.gps_port,
                user=self.config.gps_user,
                password=self.config.gps_pass,
                database=self.config.gps_db,
                charset='utf8mb4',
                autocommit=True,
            )
        return self.gps_conn

    def get_routes(self):
        if self.routes_conn is None or not self.routes_conn.is_connected():
            self.routes_conn = mysql.connector.connect(
                host=self.config.routes_host,
                port=self.config.routes_port,
                user=self.config.routes_user,
                password=self.config.routes_pass,
                database=self.config.routes_db,
                charset='utf8mb4',
                autocommit=True,
            )
        return self.routes_conn

    def close(self):
        for conn in (self.gps_conn, self.routes_conn):
            if conn and conn.is_connected():
                conn.close()


# ─────────────────────────────────────
# Кеш маршрутів — лише ті route_id, що використовуються в routes_to_cars
# ─────────────────────────────────────

class RouteCache:
    """Кешує маршрути та їх зупинки. Оновлюється раз на 60 сек.

    Завантажує лише ті маршрути, що згадані у routes_to_cars
    (first_route_id або second_route_id), бо самих маршрутів багато,
    а реально використовується невелика підмножина.
    """

    def __init__(self, db_pool: DBPool, config: Config):
        self.db_pool = db_pool
        self.config = config
        self.routes = {}  # {route_id: route_dict}
        self.last_refresh = 0
        self.refresh_interval = 60

    def get(self, route_id):
        self._maybe_refresh()
        return self.routes.get(int(route_id)) if route_id is not None else None

    def force_refresh(self):
        self.last_refresh = 0
        self._maybe_refresh()

    def _maybe_refresh(self):
        now = time.time()
        if now - self.last_refresh <= self.refresh_interval:
            return
        self.last_refresh = now
        self._refresh()

    def _refresh(self):
        try:
            conn = self.db_pool.get_routes()
            cursor = conn.cursor(dictionary=True)

            # Збираємо всі route_id, які реально потрібні (з routes_to_cars)
            cursor.execute("""
                SELECT DISTINCT route_id FROM (
                    SELECT first_route_id  AS route_id FROM routes_to_cars
                    UNION
                    SELECT second_route_id AS route_id FROM routes_to_cars
                ) AS used
                WHERE route_id IS NOT NULL
            """)
            used_ids = [int(row['route_id']) for row in cursor.fetchall() if row['route_id']]

            if not used_ids:
                self.routes = {}
                cursor.close()
                logger.debug("Кеш маршрутів: routes_to_cars порожній")
                return

            placeholders = ','.join(['%s'] * len(used_ids))
            cursor.execute(f"""
                SELECT id, group_id, name, ST_AsText(geom) AS geom_wkt, length_m
                FROM routes
                WHERE id IN ({placeholders}) AND active = 1
            """, used_ids)
            routes_rows = cursor.fetchall()

            new_routes = {}
            for route in routes_rows:
                route['coordinates'] = parse_linestring_wkt(route.get('geom_wkt', ''))
                route.pop('geom_wkt', None)
                coords = route['coordinates']

                cursor.execute("""
                    SELECT id, name, ST_AsText(geom) AS geom_wkt, radius_m, order_index
                    FROM stops
                    WHERE route_id = %s AND active = 1
                    ORDER BY order_index ASC
                """, (route['id'],))
                stops_raw = cursor.fetchall()

                stops = []
                for s in stops_raw:
                    stop_coords = parse_point_wkt(s.get('geom_wkt', ''))
                    lat = stop_coords[0] if stop_coords else 0
                    lng = stop_coords[1] if stop_coords else 0

                    stop_progress = 0.0
                    if lat != 0 and lng != 0 and len(coords) >= 2:
                        stop_progress = snap_to_line(lat, lng, coords)['progress']

                    stops.append({
                        'id': int(s['id']),
                        'name': s['name'],
                        'lat': lat,
                        'lng': lng,
                        'radius_m': int(s['radius_m']) if s['radius_m'] else int(self.config.default_stop_radius),
                        'order_index': int(s['order_index']),
                        'progress': stop_progress,
                    })

                # Стабільне сортування за order_index (перестраховка)
                stops.sort(key=lambda x: x['order_index'])
                route['stops'] = stops
                new_routes[int(route['id'])] = route

            cursor.close()
            self.routes = new_routes
            logger.debug("Кеш маршрутів оновлено: %d маршрутів (з %d використовуваних)",
                         len(new_routes), len(used_ids))

        except MySQLError as e:
            logger.error("Помилка оновлення кешу маршрутів: %s", e)


# ─────────────────────────────────────
# Синхронізація тривог з alerts.in.ua
# ─────────────────────────────────────

class AlertsUpdater:
    """Періодично опитує alerts.in.ua API і синхронізує active_alerts."""

    def __init__(self, db_pool: DBPool, config: Config):
        self.db_pool = db_pool
        self.config = config
        self._last_update = 0
        self._client = None
        if config.alerts_token:
            self._client = AlertsClient(token=config.alerts_token)

        # Кеш alert_uid+level → region_id (статичний довідник, оновлюється раз)
        self._uid_to_region = {}
        self._uid_cache_loaded = False

    def maybe_update(self, cursor):
        """Викликається з _tick(). Оновлює active_alerts, якщо пройшов інтервал."""
        if not self._client:
            return

        now = time.time()
        if now - self._last_update < self.config.alerts_interval:
            return
        self._last_update = now

        try:
            self._sync(cursor)
        except Exception as e:
            logger.error("Помилка синхронізації тривог: %s", e)

    def _ensure_uid_cache(self, cursor):
        """Одноразове завантаження маппінгу alert_uid+level → region_id."""
        if self._uid_cache_loaded:
            return
        cursor.execute(
            "SELECT id, alert_uid, alert_level FROM alert_regions"
        )
        for row in cursor.fetchall():
            key = (str(row['alert_uid']), row['alert_level'])
            self._uid_to_region[key] = int(row['id'])
        self._uid_cache_loaded = True
        logger.debug("AlertsUpdater: завантажено %d записів uid→region",
                     len(self._uid_to_region))

    def _sync(self, cursor):
        alerts_map = self._client.get_active_alerts()
        all_alerts = alerts_map.get_all_alerts()

        self._ensure_uid_cache(cursor)

        current_ids = []
        for alert in all_alerts:
            alert_id = int(alert.id)
            current_ids.append(alert_id)

            uid = str(alert.location_uid)
            level = alert.location_type  # oblast / raion / hromada / city
            region_id = self._uid_to_region.get((uid, level))

            started = alert.started_at.strftime('%Y-%m-%d %H:%M:%S') if alert.started_at else '1970-01-01 00:00:00'
            updated = alert.updated_at.strftime('%Y-%m-%d %H:%M:%S') if alert.updated_at else started

            cursor.execute("""
                REPLACE INTO active_alerts
                    (id, alert_type, alert_uid, alert_level,
                     location_title, started_at, updated_at, region_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                alert_id,
                alert.alert_type or 'unknown',
                uid,
                level,
                alert.location_title or '',
                started,
                updated,
                region_id,
            ))

        # Видаляємо тривоги, які вже завершились
        if current_ids:
            placeholders = ','.join(['%s'] * len(current_ids))
            cursor.execute(
                f"DELETE FROM active_alerts WHERE id NOT IN ({placeholders})",
                current_ids,
            )
            deleted = cursor.rowcount
        else:
            cursor.execute("DELETE FROM active_alerts")
            deleted = cursor.rowcount

        logger.info("Тривоги синхронізовано: %d активних, %d видалено",
                    len(current_ids), deleted)


# ─────────────────────────────────────
# Основна логіка
# ─────────────────────────────────────

class TrackerDaemon:
    def __init__(self, config: Config):
        self.config = config
        self.db_pool = DBPool(config)
        self.route_cache = RouteCache(self.db_pool, config)
        self.alerts_updater = AlertsUpdater(self.db_pool, config)
        self._last_display_cleanup = 0

        # Per-session state (в пам'яті). Тільки для forward-only snap.
        # {session_id: {'current_segment': int}}
        self._session_state = {}

        # Кеш визначення громади: {imei: (region_id, timestamp)}
        self._region_cache = {}
        self._region_cache_ttl = 30

        # Анти-спам логування для IMEI без routes_to_cars: {imei: last_ts}
        self._missing_pair_warned = {}
        self._missing_pair_warn_interval = 300  # 5 хв

    # ─── Головний цикл ──────────────────────────────────────────────

    def run(self):
        logger.info("Демон запущено, інтервал = %.1f сек", self.config.interval)

        while running:
            start = time.time()
            try:
                self._tick()
            except MySQLError as e:
                logger.error("MySQL помилка в tick: %s", e)
                self.db_pool.close()
                self.db_pool.gps_conn = None
                self.db_pool.routes_conn = None
            except Exception as e:
                logger.exception("Неочікувана помилка в tick: %s", e)

            elapsed = time.time() - start
            sleep_time = max(0, self.config.interval - elapsed)
            if sleep_time > 0:
                time.sleep(sleep_time)

        self.db_pool.close()
        logger.info("Демон зупинено.")

    # ─── Один тік ──────────────────────────────────────────────────

    def _tick(self):
        routes_conn = self.db_pool.get_routes()
        cursor = routes_conn.cursor(dictionary=True)
        now_ts = int(time.time())

        # Синхронізація тривог (окремий інтервал)
        self.alerts_updater.maybe_update(cursor)

        # Періодична очистка
        if (now_ts - self._last_display_cleanup) >= self.config.recheck_route_interval:
            self._last_display_cleanup = now_ts
            self._cleanup_stale_displays(cursor)

        # 1) Активні дисплеї
        cursor.execute(
            "SELECT imei FROM active_displays WHERE last_ping >= NOW() - INTERVAL %s SECOND",
            (self.config.display_timeout,),
        )
        active_imeis = {str(row['imei']) for row in cursor.fetchall()}

        if not active_imeis:
            cursor.close()
            return

        # 2) Існуючі активні сесії
        cursor.execute("""
            SELECT id, imei, route_id
            FROM tracking_sessions
            WHERE active = 1
        """)
        sessions = cursor.fetchall()
        # Нормалізуємо imei до str
        for s in sessions:
            s['imei'] = str(s['imei'])
        session_by_imei = {s['imei']: s for s in sessions}

        # 3) Деактивуємо сесії для IMEI, які зникли з active_displays
        orphan_ids = [s['id'] for s in sessions if s['imei'] not in active_imeis]
        if orphan_ids:
            placeholders = ','.join(['%s'] * len(orphan_ids))
            cursor.execute(
                f"UPDATE tracking_sessions SET active = 0 WHERE id IN ({placeholders})",
                orphan_ids,
            )
            for sid in orphan_ids:
                self._session_state.pop(sid, None)
            logger.info("Деактивовано %d сесій без активного дисплея", len(orphan_ids))

        # 4) Завантажуємо routes_to_cars для активних IMEI
        pairs = self._get_route_pairs(cursor, list(active_imeis))

        # 5) Завантажуємо позиції GPS батчем
        positions = self._get_tracker_positions_batch(list(active_imeis))

        # 6) Створюємо сесії для IMEI без активної сесії
        imeis_without_session = active_imeis - set(session_by_imei.keys())
        for imei in imeis_without_session:
            pair = pairs.get(imei)
            if not pair:
                self._warn_missing_pair(imei)
                continue
            tracker = positions.get(imei)
            if not tracker:
                logger.debug("[%s] Пропуск створення сесії — немає GPS даних", imei)
                continue
            if not self._tracker_is_fresh(tracker, now_ts, imei):
                continue

            self._auto_create_session(cursor, imei, tracker, pair)

        # 7) Оновлюємо існуючі активні сесії
        # Перечитуємо, бо могли щойно створити
        cursor.execute("""
            SELECT id, imei, route_id
            FROM tracking_sessions
            WHERE active = 1
        """)
        sessions = cursor.fetchall()
        for s in sessions:
            s['imei'] = str(s['imei'])

        active_sessions = [s for s in sessions if s['imei'] in active_imeis]

        for session in active_sessions:
            try:
                self._process_session(cursor, session, pairs.get(session['imei']),
                                      positions.get(session['imei']), now_ts)
            except Exception as e:
                logger.error("Помилка обробки сесії id=%s imei=%s: %s",
                             session['id'], session['imei'], e)

        cursor.close()

    # ─── Допоміжні: GPS / БД ──────────────────────────────────────

    def _get_tracker_positions_batch(self, imeis):
        """Батчевий запит позицій трекерів. Повертає {imei(str): row}."""
        if not imeis:
            return {}
        try:
            conn = self.db_pool.get_gps()
            cursor = conn.cursor(dictionary=True)
            placeholders = ','.join(['%s'] * len(imeis))
            cursor.execute(f"""
                SELECT id, imei, tracker_table, latitude, longtitude,
                       speed, satellites, direction, last_seen
                FROM trackers
                WHERE imei IN ({placeholders})
            """, imeis)
            rows = cursor.fetchall()
            cursor.close()
            return {str(row['imei']): row for row in rows}
        except MySQLError as e:
            logger.error("Помилка батчевого запиту позицій трекерів: %s", e)
            return {}

    def _get_route_pairs(self, cursor, imeis):
        """Завантажує пари маршрутів для IMEI з routes_to_cars.

        Повертає {imei(str): (first_route_id, second_route_id)}.
        """
        if not imeis:
            return {}
        placeholders = ','.join(['%s'] * len(imeis))
        cursor.execute(f"""
            SELECT imei, first_route_id, second_route_id
            FROM routes_to_cars
            WHERE imei IN ({placeholders})
        """, imeis)
        result = {}
        for row in cursor.fetchall():
            imei = str(row['imei'])
            first_id = int(row['first_route_id']) if row['first_route_id'] else None
            second_id = int(row['second_route_id']) if row['second_route_id'] else None
            result[imei] = (first_id, second_id)
        return result

    def _tracker_is_fresh(self, tracker, now_ts, imei):
        last_seen = tracker.get('last_seen', 0) or 0
        if last_seen > 0 and (now_ts - last_seen) > self.config.lost_timeout:
            logger.debug("[%s] GPS застарілий: %d сек тому", imei, now_ts - last_seen)
            return False
        return True

    def _resolve_region_id(self, cursor, imei, lat, lng):
        """Визначає alert_regions.id (громаду) для точки lat/lng з TTL-кешем.

        Повертає (region_id, refreshed): refreshed=True лише після ST_Contains.
        """
        now = time.time()
        cached = self._region_cache.get(imei)
        if cached and (now - cached[1]) < self._region_cache_ttl:
            return cached[0], False

        region_id = None
        try:
            cursor.execute("""
                SELECT id FROM alert_regions
                WHERE admin_level = 3
                  AND ST_Contains(geom, ST_GeomFromText(CONCAT('POINT(', %s, ' ', %s, ')')))
                LIMIT 1
            """, (lng, lat))
            row = cursor.fetchone()
            if row:
                region_id = int(row['id'])
        except MySQLError as e:
            logger.error("[%s] Помилка ST_Contains: %s", imei, e)

        self._region_cache[imei] = (region_id, now)
        return region_id, True

    def _warn_missing_pair(self, imei):
        now = time.time()
        last = self._missing_pair_warned.get(imei, 0)
        if now - last >= self._missing_pair_warn_interval:
            self._missing_pair_warned[imei] = now
            logger.warning("[%s] Немає запису в routes_to_cars — IMEI пропущено", imei)

    # ─── Створення сесії ──────────────────────────────────────────

    def _auto_create_session(self, cursor, imei, tracker, pair):
        """Створити нову сесію для IMEI, обираючи кращий з двох маршрутів пари."""
        lat = nmea_to_decimal(tracker['latitude'])
        lng = nmea_to_decimal(tracker['longtitude'])
        if lat == 0 and lng == 0:
            return
        direction = tracker.get('direction') or 0

        first_id, second_id = pair
        candidates = []
        for rid in (first_id, second_id):
            if rid is None:
                continue
            route = self.route_cache.get(rid)
            if not route or len(route.get('coordinates', [])) < 2:
                continue
            snap = snap_to_line(lat, lng, route['coordinates'])
            if snap['distance'] > self.config.max_snap_distance:
                continue
            score = self._score_snap(snap, route['coordinates'], direction)
            candidates.append((score, route, snap))

        if not candidates:
            logger.debug("[%s] Жоден з маршрутів пари (%s, %s) не підходить",
                         imei, first_id, second_id)
            return

        candidates.sort(key=lambda x: x[0])
        _, route, snap = candidates[0]

        # Якщо машина вже у самому кінці — не створюємо сесію
        if snap['progress'] >= self.config.route_end_progress:
            logger.debug("[%s] Маршрут %s — машина в кінці (progress=%.2f), сесію не створюємо",
                         imei, route['id'], snap['progress'])
            return

        stops_info = self._compute_stops_info(lat, lng, route, snap['progress'])
        region_id, region_refreshed = self._resolve_region_id(cursor, imei, lat, lng)

        # Одна строка на IMEI (унікальний індекс idx_imei).
        # current_region_id оновлюємо лише при свіжому ST_Contains (раз на ~30 сек).
        dup_region_sql = ",\n                current_region_id = VALUES(current_region_id)" if region_refreshed else ""
        cursor.execute(f"""
            INSERT INTO tracking_sessions
                (imei, route_id, progress_between_stops,
                 current_stop_id, prev_stop_id, next_stop_id,
                 current_region_id, active)
            VALUES (%s, %s, %s, %s, %s, %s, %s, 1)
            ON DUPLICATE KEY UPDATE
                route_id = VALUES(route_id),
                progress_between_stops = VALUES(progress_between_stops),
                current_stop_id = VALUES(current_stop_id),
                prev_stop_id = VALUES(prev_stop_id),
                next_stop_id = VALUES(next_stop_id){dup_region_sql},
                active = 1
        """, (
            imei,
            route['id'],
            stops_info['progress_between_stops'],
            stops_info['current_stop_id'],
            stops_info['prev_stop_id'],
            stops_info['next_stop_id'],
            region_id,
        ))

        # lastrowid: для INSERT — id нового рядка; для UPDATE по дублю — id оновленого.
        # Якщо все ж отримали 0 (рідкісний випадок), дістаємо вручну.
        session_id = cursor.lastrowid
        if not session_id:
            cursor.execute(
                "SELECT id FROM tracking_sessions WHERE imei = %s LIMIT 1",
                (imei,),
            )
            row = cursor.fetchone()
            if row:
                session_id = row['id'] if isinstance(row, dict) else row[0]

        if session_id:
            self._session_state[session_id] = {'current_segment': snap['segment']}

        logger.info("[%s] ✓ Сесію створено/реактивовано id=%s, route_id=%s, progress=%.3f, "
                    "current=%s, prev=%s, next=%s, pbs=%.3f",
                    imei, session_id, route['id'], snap['progress'],
                    stops_info['current_stop_id'],
                    stops_info['prev_stop_id'],
                    stops_info['next_stop_id'],
                    stops_info['progress_between_stops'])

    # ─── Обробка існуючої сесії ───────────────────────────────────

    def _process_session(self, cursor, session, pair, tracker, now_ts):
        session_id = session['id']
        imei = session['imei']
        route_id = int(session['route_id'])

        # Немає пари — деактивуємо (привʼязка зникла)
        if not pair:
            self._deactivate_session(cursor, session_id)
            self._warn_missing_pair(imei)
            return

        first_id, second_id = pair

        # route_id має бути одним з пари — інакше переключаємо/деактивуємо
        if route_id != first_id and route_id != second_id:
            logger.info("[%s] route_id=%s сесії не входить в пару (%s, %s) — деактивую",
                        imei, route_id, first_id, second_id)
            self._deactivate_session(cursor, session_id)
            return

        if not tracker:
            return

        if not self._tracker_is_fresh(tracker, now_ts, imei):
            self._deactivate_session(cursor, session_id)
            return

        lat = nmea_to_decimal(tracker['latitude'])
        lng = nmea_to_decimal(tracker['longtitude'])
        if lat == 0 and lng == 0:
            return
        speed = tracker.get('speed') or 0
        direction = tracker.get('direction') or 0

        route = self.route_cache.get(route_id)
        if not route or len(route.get('coordinates', [])) < 2:
            logger.warning("[%s] Маршрут id=%s не знайдено в кеші — деактивую сесію",
                           imei, route_id)
            self._deactivate_session(cursor, session_id)
            return

        state = self._session_state.setdefault(session_id, {'current_segment': 0})

        # Forward-only snap (з невеликим запасом назад на петлях)
        seg_from = max(0, state['current_segment'] - 3)
        snap = snap_to_line(lat, lng, route['coordinates'], seg_from=seg_from)

        # Якщо далеко від поточного маршруту — пробуємо парний з гістерезисом
        if snap['distance'] > self.config.max_snap_distance:
            switched = self._try_switch_to_pair(cursor, session, pair, tracker, lat, lng, direction)
            if switched:
                return
            self._deactivate_session(cursor, session_id)
            logger.info("[%s] Машина зійшла з маршруту %s (dist=%.0f) — деактивую сесію",
                        imei, route_id, snap['distance'])
            return

        # Кінець маршруту → перемикаємось на парний у тій самій сесії
        if snap['progress'] >= self.config.route_end_progress and speed < self.config.route_end_speed:
            other_id = second_id if route_id == first_id else first_id
            if other_id is None:
                # Парного немає — просто деактивуємо
                self._deactivate_session(cursor, session_id)
                logger.info("[%s] Кінець маршруту %s, парного немає — сесію деактивовано",
                            imei, route_id)
                return

            other_route = self.route_cache.get(other_id)
            if other_route and len(other_route.get('coordinates', [])) >= 2:
                other_snap = snap_to_line(lat, lng, other_route['coordinates'])
                if other_snap['distance'] <= self.config.max_snap_distance:
                    # Перемикаємо route_id у сесії, далі рахуємо вже по новому маршруту
                    logger.info("[%s] Кінець маршруту %s → перемикаю на парний %s",
                                imei, route_id, other_id)
                    route_id = other_id
                    route = other_route
                    snap = other_snap
                    state['current_segment'] = snap['segment']
                else:
                    # Парний теж далеко — на наступному тіку спробує знову
                    logger.debug("[%s] Кінець %s, парний %s далеко (dist=%.0f) — пропускаю",
                                 imei, route_id, other_id, other_snap['distance'])

        # Оновлюємо forward-only сегмент
        if snap['segment'] >= state['current_segment']:
            state['current_segment'] = snap['segment']

        stops_info = self._compute_stops_info(lat, lng, route, snap['progress'])
        region_id, region_refreshed = self._resolve_region_id(cursor, imei, lat, lng)

        region_sql = ",\n                   current_region_id = %s" if region_refreshed else ""
        region_params = (region_id,) if region_refreshed else ()
        cursor.execute(f"""
            UPDATE tracking_sessions
               SET route_id = %s,
                   progress_between_stops = %s,
                   current_stop_id = %s,
                   prev_stop_id = %s,
                   next_stop_id = %s{region_sql}
             WHERE id = %s
        """, (
            route_id,
            stops_info['progress_between_stops'],
            stops_info['current_stop_id'],
            stops_info['prev_stop_id'],
            stops_info['next_stop_id'],
            *region_params,
            session_id,
        ))

        logger.debug("[%s] sid=%s route=%s progress=%.3f cur=%s prev=%s next=%s pbs=%.3f region=%s%s",
                     imei, session_id, route_id, snap['progress'],
                     stops_info['current_stop_id'],
                     stops_info['prev_stop_id'],
                     stops_info['next_stop_id'],
                     stops_info['progress_between_stops'],
                     region_id,
                     " (refreshed)" if region_refreshed else " (cached)")

    def _try_switch_to_pair(self, cursor, session, pair, tracker, lat, lng, direction):
        """Спроба перемкнутись на парний маршрут з гістерезисом ×2.

        Повертає True, якщо перемкнулись (БД оновлено), False — інакше.
        """
        session_id = session['id']
        imei = session['imei']
        route_id = int(session['route_id'])
        first_id, second_id = pair
        other_id = second_id if route_id == first_id else first_id

        if other_id is None:
            return False

        other_route = self.route_cache.get(other_id)
        if not other_route or len(other_route.get('coordinates', [])) < 2:
            return False

        # Поточна відстань до старого маршруту
        cur_route = self.route_cache.get(route_id)
        if not cur_route or len(cur_route.get('coordinates', [])) < 2:
            return False
        cur_snap = snap_to_line(lat, lng, cur_route['coordinates'])

        other_snap = snap_to_line(lat, lng, other_route['coordinates'])
        if other_snap['distance'] > self.config.max_snap_distance:
            return False

        # Гістерезис: парний повинен бути значно ближче
        if other_snap['distance'] >= cur_snap['distance'] * self.config.switch_hysteresis:
            return False

        # Перемикаємось
        state = self._session_state.setdefault(session_id, {'current_segment': 0})
        state['current_segment'] = other_snap['segment']

        stops_info = self._compute_stops_info(lat, lng, other_route, other_snap['progress'])
        region_id, region_refreshed = self._resolve_region_id(cursor, imei, lat, lng)
        region_sql = ",\n                   current_region_id = %s" if region_refreshed else ""
        region_params = (region_id,) if region_refreshed else ()
        cursor.execute(f"""
            UPDATE tracking_sessions
               SET route_id = %s,
                   progress_between_stops = %s,
                   current_stop_id = %s,
                   prev_stop_id = %s,
                   next_stop_id = %s{region_sql}
             WHERE id = %s
        """, (
            other_id,
            stops_info['progress_between_stops'],
            stops_info['current_stop_id'],
            stops_info['prev_stop_id'],
            stops_info['next_stop_id'],
            *region_params,
            session_id,
        ))
        logger.info("[%s] Перемикання маршруту: %s → %s (dist %.0f → %.0f)",
                    imei, route_id, other_id, cur_snap['distance'], other_snap['distance'])
        return True

    def _deactivate_session(self, cursor, session_id):
        cursor.execute("UPDATE tracking_sessions SET active = 0 WHERE id = %s", (session_id,))
        self._session_state.pop(session_id, None)

    # ─── Обчислення current/prev/next/pbs ─────────────────────────

    def _compute_stops_info(self, lat, lng, route, vehicle_progress):
        """Розраховує current_stop_id, prev_stop_id, next_stop_id, progress_between_stops.

        Правила:
          • current_stop_id — перша зупинка, в радіус якої потрапляє машина (haversine).
          • prev/next — сусіди в списку, відсортованому за order_index:
              - якщо є current → prev = order_index-1, next = order_index+1 (NULL на краях);
              - інакше — за vehicle_progress: prev = остання з progress<=vp,
                                              next = перша з progress>vp.
          • progress_between_stops — доля між prev і next (0..1):
              - якщо current є → 0;
              - якщо prev або next NULL → 0;
              - інакше: (vp - prev.progress) / (next.progress - prev.progress).
        """
        stops = route.get('stops', [])
        if not stops:
            return {
                'current_stop_id': None,
                'prev_stop_id': None,
                'next_stop_id': None,
                'progress_between_stops': 0.0,
            }

        # current
        current_idx = None
        for i, s in enumerate(stops):
            if s['lat'] == 0 and s['lng'] == 0:
                continue
            if haversine_distance(lat, lng, s['lat'], s['lng']) <= s['radius_m']:
                current_idx = i
                break

        if current_idx is not None:
            prev_id = stops[current_idx - 1]['id'] if current_idx > 0 else None
            next_id = stops[current_idx + 1]['id'] if current_idx < len(stops) - 1 else None
            return {
                'current_stop_id': stops[current_idx]['id'],
                'prev_stop_id': prev_id,
                'next_stop_id': next_id,
                'progress_between_stops': 0.0,
            }

        # Без current — шукаємо за vehicle_progress
        prev_idx = None
        next_idx = None
        for i, s in enumerate(stops):
            if s['progress'] <= vehicle_progress:
                prev_idx = i
            else:
                next_idx = i
                break

        prev_id = stops[prev_idx]['id'] if prev_idx is not None else None
        next_id = stops[next_idx]['id'] if next_idx is not None else None

        if prev_idx is None or next_idx is None:
            pbs = 0.0
        else:
            denom = stops[next_idx]['progress'] - stops[prev_idx]['progress']
            if denom <= 0:
                pbs = 0.0
            else:
                pbs = (vehicle_progress - stops[prev_idx]['progress']) / denom
                pbs = max(0.0, min(1.0, pbs))

        return {
            'current_stop_id': None,
            'prev_stop_id': prev_id,
            'next_stop_id': next_id,
            'progress_between_stops': round(pbs, 6),
        }

    # ─── Скоринг при виборі маршруту ──────────────────────────────

    def _score_snap(self, snap, coords, direction):
        """Базовий скор: snap.distance + штраф +50 при невірному напрямку."""
        score = snap['distance']
        seg_idx = snap['segment']
        if direction and seg_idx < len(coords) - 1:
            seg_bearing = bearing(
                coords[seg_idx][0], coords[seg_idx][1],
                coords[seg_idx + 1][0], coords[seg_idx + 1][1],
            )
            if angle_difference(direction, seg_bearing) > self.config.max_direction_diff:
                score += 50
        return score

    # ─── Очистка ─────────────────────────────────────────────────

    def _cleanup_stale_displays(self, cursor):
        """Видалити застарілі active_displays та неактивні сесії."""
        cursor.execute(
            "DELETE FROM active_displays WHERE last_ping < NOW() - INTERVAL %s SECOND",
            (self.config.display_timeout * 2,),
        )
        deleted = cursor.rowcount
        if deleted > 0:
            logger.info("Очищено %d застарілих записів з active_displays", deleted)

        # Видаляємо неактивні сесії, чий IMEI зник з active_displays
        cursor.execute("""
            DELETE ts FROM tracking_sessions ts
            LEFT JOIN active_displays ad ON ts.imei = ad.imei
            WHERE ts.active = 0 AND ad.imei IS NULL
        """)
        deleted_sessions = cursor.rowcount
        if deleted_sessions > 0:
            logger.info("Очищено %d старих неактивних сесій", deleted_sessions)


# ─────────────────────────────────────
# Точка входу
# ─────────────────────────────────────

def setup_logging(config: Config):
    log_dir = os.path.dirname(config.log_file)
    if log_dir and not os.path.isdir(log_dir):
        os.makedirs(log_dir, exist_ok=True)

    handler = logging.handlers.RotatingFileHandler(
        config.log_file,
        maxBytes=500_000,
        backupCount=1,
        encoding='utf-8',
    )
    handler.setFormatter(logging.Formatter(
        '%(asctime)s [%(levelname)s] %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S',
    ))

    console = logging.StreamHandler()
    console.setFormatter(logging.Formatter(
        '%(asctime)s [%(levelname)s] %(message)s',
        datefmt='%H:%M:%S',
    ))

    logger.setLevel(getattr(logging, config.log_level.upper(), logging.INFO))
    logger.addHandler(handler)
    logger.addHandler(console)


def main():
    parser = argparse.ArgumentParser(description='Tracker Daemon (simplified)')
    parser.add_argument('--config', '-c',
                        default='/etc/AdvertismentManager/daemon_config.ini',
                        help='Шлях до конфігураційного файлу')
    args = parser.parse_args()

    if not os.path.exists(args.config):
        local_config = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.ini')
        if os.path.exists(local_config):
            args.config = local_config
        else:
            print(f"Конфігураційний файл не знайдено: {args.config}")
            sys.exit(1)

    config = Config(args.config)
    setup_logging(config)

    logger.info("=" * 50)
    logger.info("Tracker Daemon (simplified) запускається")
    logger.info("Config: %s", args.config)
    logger.info("GPS DB: %s@%s/%s", config.gps_user, config.gps_host, config.gps_db)
    logger.info("Routes DB: %s@%s/%s", config.routes_user, config.routes_host, config.routes_db)
    logger.info("Alerts: token=%s, interval=%.0fs",
                '***' + config.alerts_token[-6:] if len(config.alerts_token) > 6 else '(empty)',
                config.alerts_interval)
    logger.info("=" * 50)

    daemon = TrackerDaemon(config)
    daemon.run()


if __name__ == '__main__':
    main()
