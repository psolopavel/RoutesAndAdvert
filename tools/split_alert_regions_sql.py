#!/usr/bin/env python3
"""
Ділить tools/output/alert_regions.sql на N частин для імпорту в phpMyAdmin.

Запуск:
  python tools/split_alert_regions_sql.py
  python tools/split_alert_regions_sql.py --parts 10 --input tools/output/alert_regions.sql
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path


def split_sql(input_path: Path, out_dir: Path, parts: int) -> list[Path]:
    text = input_path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)

    header: list[str] = []
    inserts: list[str] = []
    footer: list[str] = []
    phase = "header"

    for line in lines:
        if line.startswith("INSERT INTO"):
            phase = "inserts"
            inserts.append(line)
        elif phase == "inserts" and line.startswith("-- matched:"):
            phase = "footer"
            footer.append(line)
        elif phase == "header":
            header.append(line)
        elif phase == "inserts":
            inserts.append(line)
        else:
            footer.append(line)

    if not inserts:
        raise SystemExit(f"No INSERT statements found in {input_path}")

    out_dir.mkdir(parents=True, exist_ok=True)
    chunk_size = math.ceil(len(inserts) / parts)
    written: list[Path] = []

    for i in range(parts):
        start = i * chunk_size
        chunk = inserts[start : start + chunk_size]
        if not chunk:
            break

        part_no = i + 1
        out_path = out_dir / f"alert_regions_part_{part_no:02d}_of_{parts:02d}.sql"
        body: list[str] = [
            f"-- Part {part_no}/{parts} from {input_path.name}\n",
            "SET NAMES utf8mb4;\n",
        ]
        if part_no == 1:
            body.extend(header[1:] if header and header[0].startswith("--") else header)
            if body and not body[-1].endswith("\n"):
                body[-1] += "\n"
        else:
            body.append("\n")

        body.extend(chunk)
        if part_no == parts and footer:
            body.append("\n")
            body.extend(footer)

        out_path.write_text("".join(body), encoding="utf-8")
        written.append(out_path)

    manifest = out_dir / "README.txt"
    manifest.write_text(
        "\n".join(
            [
                f"Source: {input_path}",
                f"INSERT rows total: {len(inserts)}",
                f"Parts: {len(written)}",
                "",
                "Import order:",
                "  1. tools/schema_alert_regions.sql  (create tables once)",
                "  2. alert_regions_part_01 ... part_NN in order",
                "",
                "Files:",
                *[f"  - {p.name} ({sum(1 for ln in p.read_text(encoding='utf-8').splitlines() if ln.startswith('INSERT INTO'))} inserts)"
                  for p in written],
            ]
        ),
        encoding="utf-8",
    )

    return written


def main():
    ap = argparse.ArgumentParser(description="Split alert_regions.sql into smaller files")
    ap.add_argument(
        "--input",
        type=Path,
        default=Path("tools/output/alert_regions.sql"),
        help="Source SQL file",
    )
    ap.add_argument(
        "--out-dir",
        type=Path,
        default=Path("tools/output/alert_regions_parts"),
        help="Output directory",
    )
    ap.add_argument("--parts", type=int, default=10, help="Number of parts")
    args = ap.parse_args()

    if not args.input.is_file():
        raise SystemExit(f"File not found: {args.input}")
    if args.parts < 1:
        raise SystemExit("--parts must be >= 1")

    files = split_sql(args.input, args.out_dir, args.parts)
    print(f"Split {args.input} -> {len(files)} files in {args.out_dir}")
    for p in files:
        print(f"  {p.name}")


if __name__ == "__main__":
    main()
