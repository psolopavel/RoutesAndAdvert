#!/usr/bin/env python3
"""
Збирає довідник alert_regions:
  UID_ALL_GROMADS.json  +  ukr_admin{1,2,3}.geojson  →  JSON + SQL

Запуск:
  python tools/build_alert_regions.py \
      --uid "C:/Users/.../UID_ALL_GROMADS.json" \
      --geo-dir "C:/Users/.../ukr_admin_boundaries.geojson" \
      --out-dir tools/output

Потім імпорт (на сервері з MySQL):
  mysql RoutesAndAdvertisement < tools/output/alert_regions.sql
"""
from __future__ import annotations

import argparse
import json
import re
import unicodedata
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any


# ─── Нормалізація назв ───────────────────────────────────────────────

def norm(s: str) -> str:
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", s).lower().strip()
    s = s.replace("'", "'").replace("`", "'").replace("ʼ", "'")
    s = re.sub(r"\s+", " ", s)
    return s


COMMUNITY_SUFFIXES = (
    " територіальна громада",
    " селищна громада",
    " міська громада",
    " сільська громада",
    " громада",
)


def strip_suffix(name: str, level: str) -> str:
    n = name.strip()
    if level in ("Community", "hromada", "city"):
        for suf in COMMUNITY_SUFFIXES:
            if n.endswith(suf):
                n = n[: -len(suf)]
                break
        if " та " in n:
            n = n.split(" та ")[-1].strip()
        if n.startswith("м. "):
            n = n[3:]
    elif level in ("District", "raion"):
        if n.endswith(" район"):
            n = n[: -len(" район")]
    elif level in ("State", "oblast"):
        for suf in (" область",):
            if n.endswith(suf):
                n = n[: -len(suf)]
        if "автономна республіка" in norm(name):
            return "крим"
        if norm(n) in ("м. київ", "київ"):
            return "київ"
        if norm(n) in ("м. севастополь", "севастополь"):
            return "севастополь"
    return n.strip()


TYPE_TO_LEVEL = {
    "State": ("oblast", 1),
    "District": ("raion", 2),
    "Community": ("hromada", 3),
}

ALERT_TYPE_MAP = {
    "oblast": 1,
    "raion": 2,
    "hromada": 3,
    "city": 3,
}


# ─── Geo helpers ─────────────────────────────────────────────────────

def ring_centroid(ring: list[list[float]]) -> tuple[float, float]:
    if not ring:
        return 0.0, 0.0
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return sum(ys) / len(ys), sum(xs) / len(xs)


def feature_centroid(feat: dict) -> tuple[float, float]:
    geom = feat.get("geometry") or {}
    gtype = geom.get("type")
    coords = geom.get("coordinates") or []
    if gtype == "Polygon" and coords:
        return ring_centroid(coords[0])
    if gtype == "MultiPolygon" and coords and coords[0]:
        return ring_centroid(coords[0][0])
    return 0.0, 0.0


def geojson_to_wkt(feat: dict) -> str:
    geom = feat["geometry"]
    gtype = geom["type"]
    coords = geom["coordinates"]

    def point_xy(p):
        return float(p[0]), float(p[1])

    def ring_wkt(ring):
        pts = ", ".join(f"{x} {y}" for x, y in (point_xy(p) for p in ring))
        return f"({pts})"

    def polygon_wkt(rings):
        return "(" + ", ".join(ring_wkt(ring) for ring in rings) + ")"

    if gtype == "Polygon":
        return f"MULTIPOLYGON({polygon_wkt(coords)})"
    if gtype == "MultiPolygon":
        polys = ", ".join(polygon_wkt(poly) for poly in coords)
        return f"MULTIPOLYGON({polys})"
    raise ValueError(f"Unsupported geometry: {gtype}")


# ─── Data classes ────────────────────────────────────────────────────

@dataclass
class UidNode:
    alert_uid: str
    alert_level: str
    admin_level: int
    name_uk: str
    oblast_name: str | None
    raion_name: str | None
    uid_type: str


@dataclass
class RegionRow:
    alert_uid: str
    alert_level: str
    admin_level: int
    name_uk: str
    oblast_name: str | None
    raion_name: str | None
    official_pcode: str | None
    centroid_lat: float | None
    centroid_lon: float | None
    geom_wkt: str | None
    match_method: str
    match_notes: str | None = None


# ─── UID tree ────────────────────────────────────────────────────────

def walk_uid(nodes: list, oblast: str | None = None, raion: str | None = None) -> list[UidNode]:
    out: list[UidNode] = []
    for n in nodes:
        uid_type = n["regionType"]
        level, admin = TYPE_TO_LEVEL[uid_type]
        item = UidNode(
            alert_uid=str(n["regionId"]),
            alert_level=level,
            admin_level=admin,
            name_uk=n["regionName"],
            oblast_name=oblast,
            raion_name=raion if uid_type == "Community" else (n["regionName"] if uid_type == "District" else None),
            uid_type=uid_type,
        )
        out.append(item)
        children = n.get("regionChildIds") or []
        if uid_type == "State":
            out.extend(walk_uid(children, oblast=n["regionName"]))
        elif uid_type == "District":
            out.extend(walk_uid(children, oblast=oblast, raion=n["regionName"]))
    return out


def city_aliases(nodes: list[UidNode]) -> list[UidNode]:
    """Генерує alert_uid для location_type=city (окремий namespace API)."""
    aliases: list[UidNode] = []
    for n in nodes:
        if n.uid_type == "Community" and n.name_uk.startswith("м. "):
            rid = n.alert_uid
            city_uid = "5" + rid
            aliases.append(
                UidNode(
                    alert_uid=city_uid,
                    alert_level="city",
                    admin_level=3,
                    name_uk=n.name_uk.split(" та ")[0].strip() if " та " in n.name_uk else n.name_uk,
                    oblast_name=n.oblast_name,
                    raion_name=n.raion_name,
                    uid_type="CityAlias",
                )
            )
        if n.uid_type == "State" and n.name_uk.startswith("м. "):
            rid = n.alert_uid
            if len(rid) == 3:
                city_uid = "5" + rid
            elif rid.startswith("1") and len(rid) == 4:
                city_uid = "6" + rid[1:]
            else:
                city_uid = "5" + rid
            short = n.name_uk.split(" та ")[0].strip()
            aliases.append(
                UidNode(
                    alert_uid=city_uid,
                    alert_level="city",
                    admin_level=3,
                    name_uk=short,
                    oblast_name=n.name_uk,
                    raion_name=None,
                    uid_type="CityAlias",
                )
            )
    return aliases


# ─── Geo indexes ─────────────────────────────────────────────────────

def load_geo(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as f:
        return json.load(f)["features"]


def build_index(features, name_key, parent_key=None, parent_level="District", extra_name_keys=None):
    idx: dict[tuple, list[dict]] = {}
    name_keys = [name_key] + [k for k in (extra_name_keys or []) if k != name_key]
    for feat in features:
        p = feat["properties"]
        level = "Community" if "adm3" in name_key else "District" if "adm2" in name_key else "State"
        parent = None
        if parent_key:
            parent = norm(strip_suffix(p.get(parent_key) or "", parent_level))
        for nk in name_keys:
            raw = p.get(nk)
            if not raw:
                continue
            core = norm(strip_suffix(raw, level))
            key = (core, parent) if parent_key else (core,)
            bucket = idx.setdefault(key, [])
            if feat not in bucket:
                bucket.append(feat)
    return idx


def dedupe_features(hits: list[dict]) -> list[dict]:
    seen: set[int] = set()
    out: list[dict] = []
    for feat in hits:
        fid = id(feat)
        if fid in seen:
            continue
        seen.add(fid)
        out.append(feat)
    return out


def matched_via_old_name(node: UidNode, feat: dict) -> bool:
    """True, якщо UID-назва збіглася з adm3_name1_old, а не з поточною adm3_name1."""
    if node.alert_level not in ("hromada", "city"):
        return False
    core_uid = norm(strip_suffix(node.name_uk, "Community"))
    props = feat["properties"]
    cur = norm(strip_suffix(props.get("adm3_name1") or "", "Community"))
    if core_uid == cur:
        return False
    old = norm(strip_suffix(props.get("adm3_name1_old") or "", "Community"))
    return core_uid == old


# ─── Matching ────────────────────────────────────────────────────────

def match_feature(node: UidNode, idx1, idx2, idx3) -> tuple[dict | None, str, str | None]:
    if node.alert_level == "oblast":
        key = (norm(strip_suffix(node.name_uk, "State")),)
        hits = idx1.get(key, [])
        if len(hits) == 1:
            return hits[0], "exact", None
        if len(hits) > 1:
            return hits[0], "exact", "ambiguous oblast"
        return None, "unmatched", f"no oblast for {node.name_uk}"

    if node.alert_level == "raion":
        key = (
            norm(strip_suffix(node.name_uk, "District")),
            norm(strip_suffix(node.oblast_name or "", "State")),
        )
        hits = idx2.get(key, [])
        if len(hits) == 1:
            return hits[0], "exact", None
        if len(hits) > 1:
            return hits[0], "parent_context", "ambiguous raion"
        return None, "unmatched", f"no raion for {node.name_uk} / {node.oblast_name}"

    # hromada / city → adm3 (спочатку adm3_name1, також adm3_name1_old в індексі)
    core = norm(strip_suffix(node.name_uk, "Community"))

    def pick_hits(candidates: list[dict], base_method: str) -> tuple[dict | None, str, str | None]:
        hits = dedupe_features(candidates)
        if len(hits) == 1:
            method = "old_name" if matched_via_old_name(node, hits[0]) else base_method
            note = "matched via adm3_name1_old" if method == "old_name" else None
            return hits[0], method, note
        if len(hits) > 1:
            method = "old_name" if matched_via_old_name(node, hits[0]) else base_method
            amb = "ambiguous hromada+raion" if base_method == "parent_context" else "ambiguous hromada name-only"
            return hits[0], method, amb
        return None, "unmatched", None

    if node.raion_name:
        key = (core, norm(strip_suffix(node.raion_name, "District")))
        feat, method, notes = pick_hits(idx3.get(key, []), "parent_context")
        if feat:
            return feat, method, notes

    feat, method, notes = pick_hits(idx3.get((core,), []), "exact")
    if feat:
        return feat, method, notes

    return None, "unmatched", f"no hromada for {node.name_uk}"


def props_pcode(props: dict, admin_level: int) -> str | None:
    if admin_level == 1:
        return props.get("adm1_pcode")
    if admin_level == 2:
        return props.get("adm2_pcode")
    return props.get("adm3_pcode")


def build_rows(uid_nodes: list[UidNode], geo_dir: Path) -> list[RegionRow]:
    adm1 = load_geo(geo_dir / "ukr_admin1.geojson")
    adm2 = load_geo(geo_dir / "ukr_admin2.geojson")
    adm3 = load_geo(geo_dir / "ukr_admin3.geojson")

    idx1 = build_index(adm1, "adm1_name1")
    idx2 = build_index(adm2, "adm2_name1", "adm1_name1")
    idx3_name = build_index(adm3, "adm3_name1", extra_name_keys=["adm3_name1_old"])
    idx3_full = build_index(adm3, "adm3_name1", "adm2_name1", extra_name_keys=["adm3_name1_old"])

    rows: list[RegionRow] = []
    seen: set[tuple[str, str]] = set()
    base_by_uid: dict[str, RegionRow] = {}

    for node in uid_nodes:
        key = (node.alert_uid, node.alert_level)
        if key in seen:
            continue
        seen.add(key)

        feat, method, notes = match_feature(node, idx1, idx2, idx3_full if node.raion_name else idx3_name)
        if not feat and node.raion_name:
            feat, method, notes = match_feature(node, idx1, idx2, idx3_name)

        if feat:
            props = feat["properties"]
            lat, lon = feature_centroid(feat)
            row = RegionRow(
                alert_uid=node.alert_uid,
                alert_level=node.alert_level,
                admin_level=node.admin_level,
                name_uk=node.name_uk,
                oblast_name=node.oblast_name,
                raion_name=node.raion_name,
                official_pcode=props_pcode(props, node.admin_level),
                centroid_lat=round(lat, 7),
                centroid_lon=round(lon, 7),
                geom_wkt=geojson_to_wkt(feat),
                match_method=method,
                match_notes=notes,
            )
        else:
            row = RegionRow(
                alert_uid=node.alert_uid,
                alert_level=node.alert_level,
                admin_level=node.admin_level,
                name_uk=node.name_uk,
                oblast_name=node.oblast_name,
                raion_name=node.raion_name,
                official_pcode=None,
                centroid_lat=None,
                centroid_lon=None,
                geom_wkt=None,
                match_method="unmatched",
                match_notes=notes,
            )
        rows.append(row)
        base_by_uid[node.alert_uid] = row

    # city UID — окремий namespace API; наслідуємо геометрію базового regionId
    for alias in city_aliases(uid_nodes):
        key = (alias.alert_uid, alias.alert_level)
        if key in seen:
            continue
        seen.add(key)

        base_id = None
        if alias.alert_uid.startswith("5"):
            base_id = alias.alert_uid[1:]
        elif alias.alert_uid.startswith("6"):
            base_id = "1" + alias.alert_uid[1:]
        base = base_by_uid.get(base_id) if base_id else None
        if base and base.geom_wkt:
            rows.append(
                RegionRow(
                    alert_uid=alias.alert_uid,
                    alert_level="city",
                    admin_level=base.admin_level,
                    name_uk=alias.name_uk,
                    oblast_name=alias.oblast_name,
                    raion_name=alias.raion_name,
                    official_pcode=base.official_pcode,
                    centroid_lat=base.centroid_lat,
                    centroid_lon=base.centroid_lon,
                    geom_wkt=base.geom_wkt,
                    match_method="alias",
                    match_notes=f"city alias of uid {base_id}",
                )
            )
        else:
            rows.append(
                RegionRow(
                    alert_uid=alias.alert_uid,
                    alert_level="city",
                    admin_level=3,
                    name_uk=alias.name_uk,
                    oblast_name=alias.oblast_name,
                    raion_name=alias.raion_name,
                    official_pcode=None,
                    centroid_lat=None,
                    centroid_lon=None,
                    geom_wkt=None,
                    match_method="unmatched",
                    match_notes=f"city alias, base uid {base_id} not matched",
                )
            )

    return rows


# ─── Export ──────────────────────────────────────────────────────────

def sql_escape(s: str | None) -> str:
    if s is None:
        return "NULL"
    return "'" + s.replace("\\", "\\\\").replace("'", "''") + "'"


def rows_to_sql(rows: list[RegionRow]) -> str:
    lines = [
        "-- Generated by build_alert_regions.py",
        "SET NAMES utf8mb4;",
        "TRUNCATE TABLE alert_regions;",
        "",
    ]
    ok = [r for r in rows if r.geom_wkt]
    for r in ok:
        lines.append(
            "INSERT INTO alert_regions "
            "(alert_uid, alert_level, name_uk, oblast_name, raion_name, official_pcode, admin_level, "
            "centroid_lat, centroid_lon, geom, match_method, match_notes) VALUES ("
            f"{sql_escape(r.alert_uid)}, "
            f"{sql_escape(r.alert_level)}, "
            f"{sql_escape(r.name_uk)}, "
            f"{sql_escape(r.oblast_name)}, "
            f"{sql_escape(r.raion_name)}, "
            f"{sql_escape(r.official_pcode)}, "
            f"{r.admin_level}, "
            f"{r.centroid_lat}, "
            f"{r.centroid_lon}, "
            f"ST_GeomFromText({sql_escape(r.geom_wkt)}), "
            f"{sql_escape(r.match_method)}, "
            f"{sql_escape(r.match_notes)}"
            ");"
        )
    lines.append("")
    lines.append(f"-- matched: {len(ok)} / {len(rows)}")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="Build alert_regions from UID + geojson")
    ap.add_argument("--uid", type=Path, required=True)
    ap.add_argument("--geo-dir", type=Path, required=True)
    ap.add_argument("--out-dir", type=Path, default=Path("tools/output"))
    args = ap.parse_args()

    with args.uid.open(encoding="utf-8") as f:
        uid_data = json.load(f)

    uid_nodes = walk_uid(uid_data["states"])
    rows = build_rows(uid_nodes, args.geo_dir)

    args.out_dir.mkdir(parents=True, exist_ok=True)

    json_path = args.out_dir / "alert_regions.json"
    sql_path = args.out_dir / "alert_regions.sql"
    report_path = args.out_dir / "alert_regions_report.json"

    with json_path.open("w", encoding="utf-8") as f:
        json.dump([asdict(r) for r in rows], f, ensure_ascii=False, indent=2)

    with sql_path.open("w", encoding="utf-8") as f:
        f.write(rows_to_sql(rows))

    matched = sum(1 for r in rows if r.geom_wkt)
    unmatched = [asdict(r) for r in rows if not r.geom_wkt]
    uid_base = [r for r in rows if r.alert_level != "city"]
    uid_base_ok = sum(1 for r in uid_base if r.geom_wkt)
    by_level: dict[str, dict[str, int]] = {}
    for r in rows:
        by_level.setdefault(r.alert_level, {"ok": 0, "fail": 0})
        if r.geom_wkt:
            by_level[r.alert_level]["ok"] += 1
        else:
            by_level[r.alert_level]["fail"] += 1

    old_name_count = sum(1 for r in rows if r.match_method == "old_name")

    report = {
        "total": len(rows),
        "matched": matched,
        "unmatched": len(unmatched),
        "matched_via_old_name": old_name_count,
        "uid_base_total": len(uid_base),
        "uid_base_matched": uid_base_ok,
        "uid_base_unmatched": len(uid_base) - uid_base_ok,
        "by_level": by_level,
        "unmatched_samples": unmatched[:50],
    }
    with report_path.open("w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    unmatched_path = args.out_dir / "alert_regions_unmatched.json"
    with unmatched_path.open("w", encoding="utf-8") as f:
        json.dump(unmatched, f, ensure_ascii=False, indent=2)

    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"\nWrote:\n  {json_path}\n  {sql_path}\n  {report_path}\n  {unmatched_path}")


if __name__ == "__main__":
    main()
