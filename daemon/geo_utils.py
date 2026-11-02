"""
GeoUtils — геометричні утиліти для роботи з координатами.

Порт з PHP GeoUtils.php.
Всі координати у форматі десяткових градусів (decimal degrees).
"""

import math
import re

EARTH_RADIUS = 6_371_000  # метрів


# ─────────────────────────────────────
# Відстань між точками
# ─────────────────────────────────────

def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Haversine — відстань між двома точками на сфері (метри)."""
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)

    a = (math.sin(d_lat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(d_lon / 2) ** 2)

    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return EARTH_RADIUS * c


# ─────────────────────────────────────
# Bearing (азимут)
# ─────────────────────────────────────

def bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Початковий азимут від точки A до точки B (0..360)."""
    d_lon = math.radians(lon2 - lon1)
    lat1r = math.radians(lat1)
    lat2r = math.radians(lat2)

    x = math.sin(d_lon) * math.cos(lat2r)
    y = (math.cos(lat1r) * math.sin(lat2r) -
         math.sin(lat1r) * math.cos(lat2r) * math.cos(d_lon))

    brng = math.degrees(math.atan2(x, y))
    return (brng + 360) % 360


def angle_difference(a: float, b: float) -> float:
    """Різниця між двома кутами (0..180)."""
    diff = abs(a - b)
    return 360 - diff if diff > 180 else diff


# ─────────────────────────────────────
# Проекція точки на відрізок
# ─────────────────────────────────────

def project_point_on_segment(p_lat, p_lon, a_lat, a_lon, b_lat, b_lon):
    """
    Проекція точки P на відрізок AB.
    Повертає dict: fraction (0..1), distance (м), projLat, projLon
    """
    dx = b_lon - a_lon
    dy = b_lat - a_lat

    if dx == 0 and dy == 0:
        return {
            'fraction': 0.0,
            'distance': haversine_distance(p_lat, p_lon, a_lat, a_lon),
            'projLat': a_lat,
            'projLon': a_lon,
        }

    t = ((p_lon - a_lon) * dx + (p_lat - a_lat) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))

    proj_lat = a_lat + t * dy
    proj_lon = a_lon + t * dx

    return {
        'fraction': t,
        'distance': haversine_distance(p_lat, p_lon, proj_lat, proj_lon),
        'projLat': proj_lat,
        'projLon': proj_lon,
    }


def snap_to_line(lat, lon, route_coords, seg_from=None, seg_to=None):
    """
    Snap-to-line: найближча точка на LINESTRING до заданої позиції.

    route_coords: list of [lat, lng]
    seg_from: мінімальний індекс сегменту для пошуку (опціонально, для forward-only snap)
    seg_to:   максимальний індекс сегменту для пошуку (опціонально)

    Повертає dict:
      distance, segment, fraction, progress (0..1), projLat, projLon
    """
    n = len(route_coords)

    if n == 0:
        return {
            'distance': 99999999,
            'segment': 0,
            'fraction': 0.0,
            'progress': 0.0,
            'projLat': lat,
            'projLon': lon,
        }

    if n == 1:
        dist = haversine_distance(lat, lon, route_coords[0][0], route_coords[0][1])
        return {
            'distance': dist,
            'segment': 0,
            'fraction': 0.0,
            'progress': 0.0,
            'projLat': route_coords[0][0],
            'projLon': route_coords[0][1],
        }

    # Довжини сегментів
    seg_lengths = []
    total_length = 0.0
    for i in range(n - 1):
        length = haversine_distance(
            route_coords[i][0], route_coords[i][1],
            route_coords[i + 1][0], route_coords[i + 1][1]
        )
        seg_lengths.append(length)
        total_length += length

    # Діапазон пошуку
    start = max(0, seg_from) if seg_from is not None else 0
    end = min(n - 2, seg_to) if seg_to is not None else n - 2

    # Шукаємо найближчий сегмент
    min_dist = 99999999
    best_segment = 0
    best_fraction = 0.0
    best_progress = 0.0
    best_proj_lat = route_coords[0][0]
    best_proj_lon = route_coords[0][1]

    # Accumulated length до start
    accumulated = sum(seg_lengths[:start])

    for i in range(start, end + 1):
        proj = project_point_on_segment(
            lat, lon,
            route_coords[i][0], route_coords[i][1],
            route_coords[i + 1][0], route_coords[i + 1][1]
        )

        if proj['distance'] < min_dist:
            min_dist = proj['distance']
            best_segment = i
            best_fraction = proj['fraction']
            best_proj_lat = proj['projLat']
            best_proj_lon = proj['projLon']

            if total_length > 0:
                best_progress = (accumulated + seg_lengths[i] * proj['fraction']) / total_length

        accumulated += seg_lengths[i]

    return {
        'distance': min_dist,
        'segment': best_segment,
        'fraction': best_fraction,
        'progress': best_progress,
        'projLat': best_proj_lat,
        'projLon': best_proj_lon,
    }


# ─────────────────────────────────────
# Конвертація координат
# ─────────────────────────────────────

def nmea_to_decimal(value: float) -> float:
    """NMEA координати → десяткові градуси. (DDMM.MMMM → DD.DDDDDD)"""
    if value == 0:
        return 0.0
    deg = math.floor(value / 100)
    minutes = value - deg * 100
    return deg + minutes / 60.0


# ─────────────────────────────────────
# WKT парсери
# ─────────────────────────────────────

def parse_linestring_wkt(wkt: str):
    """LINESTRING WKT → list of [lat, lng]"""
    if not wkt:
        return []
    m = re.match(r'LINESTRING\s*\((.+)\)', wkt, re.IGNORECASE)
    if not m:
        return []
    coords = []
    for pair in m.group(1).split(','):
        parts = pair.strip().split()
        if len(parts) >= 2:
            coords.append([float(parts[1]), float(parts[0])])  # [lat, lng]
    return coords


def parse_point_wkt(wkt: str):
    """POINT WKT → [lat, lng] або None"""
    if not wkt:
        return None
    m = re.match(r'POINT\s*\(([^)]+)\)', wkt, re.IGNORECASE)
    if not m:
        return None
    parts = m.group(1).strip().split()
    if len(parts) >= 2:
        return [float(parts[1]), float(parts[0])]
    return None
