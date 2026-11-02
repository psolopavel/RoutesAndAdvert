#!/usr/bin/env python3
"""Quick analysis of UID vs official geojson matching."""
import json
import re
import unicodedata
from pathlib import Path

UID_PATH = Path(r"c:\Users\solog\Downloads\UID_ALL_GROMADS.json")
GEO_DIR = Path(r"c:\Users\solog\Downloads\ukr_admin_boundaries.geojson")
ALERTS_PATH = Path(r"d:\Download\homework\alerts.json")


def norm(s: str) -> str:
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", s).lower().strip()
    s = s.replace("’", "'").replace("`", "'").replace("ʼ", "'")
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
    n = name
    if level == "Community":
        for suf in COMMUNITY_SUFFIXES:
            if n.endswith(suf):
                n = n[: -len(suf)]
                break
        # "м. Кропивницький та Кропивницька" -> take part after " та " if present
        if " та " in n:
            parts = [p.strip() for p in n.split(" та ")]
            n = parts[-1]
        if n.startswith("м. "):
            n = n[3:]
    elif level == "District":
        for suf in (" район",):
            if n.endswith(suf):
                n = n[: -len(suf)]
    elif level == "State":
        for suf in (" область", " республіка"):
            if n.endswith(suf):
                n = n[: -len(suf)]
        if "автономна республіка" in norm(name):
            n = "крим"
    return n.strip()


def walk_uid(nodes, oblast=None, raion=None, out=None):
    if out is None:
        out = []
    for n in nodes:
        t = n["regionType"]
        item = {
            "uid": n["regionId"],
            "name": n["regionName"],
            "type": t,
            "oblast": oblast,
            "raion": raion if t == "Community" else None,
        }
        if t == "District":
            item["raion"] = n["regionName"]
        out.append(item)
        children = n.get("regionChildIds") or []
        if t == "State":
            walk_uid(children, oblast=n["regionName"], out=out)
        elif t == "District":
            walk_uid(children, oblast=oblast, raion=n["regionName"], out=out)
    return out


def load_geo(level: int):
    path = GEO_DIR / f"ukr_admin{level}.geojson"
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    return data["features"]


def build_index(features, name_key, parent_key=None):
    idx = {}
    for feat in features:
        p = feat["properties"]
        core = norm(strip_suffix(p.get(name_key) or "", "District" if "adm2" in name_key else "Community" if "adm3" in name_key else "State"))
        parent = norm(strip_suffix(p.get(parent_key) or "", "State")) if parent_key else None
        key = (core, parent) if parent_key else core
        idx.setdefault(key, []).append(p)
    return idx


def match_stats(flat, idx, level, parent_field=None):
    type_map = {"State": "State", "District": "District", "Community": "Community"}
    items = [x for x in flat if x["type"] == type_map[level]]
    ok = amb = fail = 0
    fails = []
    for item in items:
        core = norm(strip_suffix(item["name"], level))
        if parent_field:
            parent = norm(strip_suffix(item.get(parent_field) or "", "State"))
            key = (core, parent)
        else:
            key = core
        hits = idx.get(key, [])
        if len(hits) == 1:
            ok += 1
        elif len(hits) > 1:
            amb += 1
        else:
            fail += 1
            fails.append(item["name"])
    return ok, amb, fail, fails


def main():
    with UID_PATH.open(encoding="utf-8") as f:
        uid = json.load(f)
    flat = walk_uid(uid["states"])

    counts = {}
    for x in flat:
        counts[x["type"]] = counts.get(x["type"], 0) + 1
    print("UID counts:", counts)

    adm1 = load_geo(1)
    adm2 = load_geo(2)
    adm3 = load_geo(3)
    print(f"Geo counts: adm1={len(adm1)} adm2={len(adm2)} adm3={len(adm3)}")

    idx1 = build_index(adm1, "adm1_name1")
    idx2 = build_index(adm2, "adm2_name1", "adm1_name1")
    idx3 = build_index(adm3, "adm3_name1", "adm2_name1")

    for label, idx, level, parent in [
        ("oblast name only", idx1, "State", None),
        ("raion name+oblast", idx2, "District", "oblast"),
        ("hromada name+raion", idx3, "Community", "raion"),
        ("hromada name only", build_index(adm3, "adm3_name1"), "Community", None),
    ]:
        ok, amb, fail, fails = match_stats(flat, idx, level, parent)
        total = ok + amb + fail
        print(f"{label}: ok={ok} amb={amb} fail={fail} / {total} ({100*(ok+amb)/total:.1f}%)")
        if fail and fail <= 20:
            print("  fails:", fails[:10])

    # alerts cross-check
    if ALERTS_PATH.exists():
        with ALERTS_PATH.open(encoding="utf-8") as f:
            alerts = json.load(f)
        uid_map = {(x["uid"], x["type"]): x for x in flat}
        type_from_alert = {
            "oblast": "State",
            "raion": "District",
            "hromada": "Community",
            "city": "Community",
        }
        unresolved = []
        for group in alerts.get("by_alert_type", {}).values():
            for a in group.get("alerts", []):
                lt = a.get("location_type")
                t = type_from_alert.get(lt)
                if not t:
                    continue
                key = (str(a.get("location_uid")), t)
                if key not in uid_map:
                    unresolved.append(a)
        print(f"Alerts in sample: unresolved uid lookups {len(unresolved)}")


if __name__ == "__main__":
    main()
