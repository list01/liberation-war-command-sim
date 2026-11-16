#!/usr/bin/env python3
"""采集三大战区的真实开放高程数据（NASA/METI ASTER GDEM，约 30m）。

运行（可重复、断点续采；接口偶发超时，故每次只跑少量批次，重复执行直至完成）：
    python data/fetch_elevation.py --max-batches 8
    # 重复执行，直到输出 COMPLETE
    python data/embed_elevation.py

每战区按 12×8 网格采集 96 个 **ASTER GDEM 实测控制点**（16 点/请求，接口对
40 点以上请求会超时）。已采批次写入 data/_raw_<area>.json，失败批次留待下次补齐。
全部完成后由 96 个控制点**双线性加密到 60×36 绘制网格**并做一次 3×3 轻度平滑，
等高线间隔按实测起伏自适应（孟良崮 100 m / 塔山 50 m / 徐蚌 10 m）。

产物：
    data/elevation.json   实测控制点 + 插值网格 + 完整元数据（供存档复核）
    data/elevation.js     同源压缩副本（由 embed_elevation.py 内嵌进游戏）

诚实标注：控制点是真实观测值；60×36 绘制网格是插值产物（元数据 render_grid.kind
明确写 "NOT a full-resolution DEM"），不代表 30 m 原始分辨率。

合规：取的是**开放高程数值**，不是地图瓦片 / 底图服务；主游戏离线自绘 SVG，
不加载任何第三方地图源。在线底图对照仍由 src/geography.html 使用腾讯地图。
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "https://api.opentopodata.org/v1/aster30m"
DATASET = "aster30m"
COLS, ROWS, BATCH = 12, 8, 16
FINE_C, FINE_R = 60, 36
TOTAL = COLS * ROWS

AREAS = {
    "menglianggu": {"lon0": 117.70, "lon1": 118.75, "lat0": 35.42, "lat1": 35.92, "step": 100},
    "tashan":      {"lon0": 120.68, "lon1": 121.18, "lat0": 40.80, "lat1": 41.15, "step": 50},
    "xubeng":      {"lon0": 116.45, "lon1": 118.05, "lat0": 32.85, "lat1": 34.40, "step": 20},
}
ROOT = Path(__file__).resolve().parent


def raw_path(name):
    return ROOT / ("_raw_%s.json" % name)


def fetch(points):
    q = "%7C".join("%.5f,%.5f" % p for p in points)
    req = urllib.request.Request(API + "?locations=" + q, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=12) as r:
        d = json.loads(r.read().decode())
    if d.get("status") != "OK":
        raise RuntimeError(str(d.get("status")))
    return [x["elevation"] for x in d["results"]]


def points_for(a):
    pts, coords = [], []
    for j in range(ROWS):
        lat = a["lat1"] - (j + 0.5) / ROWS * (a["lat1"] - a["lat0"])
        for i in range(COLS):
            lon = a["lon0"] + (i + 0.5) / COLS * (a["lon1"] - a["lon0"])
            pts.append((lat, lon))
            coords.append([round(lat, 5), round(lon, 5)])
    return pts, coords


def bilinear(controls):
    fine = []
    for j in range(FINE_R):
        fy = j / (FINE_R - 1) * (ROWS - 1)
        y0 = min(ROWS - 2, int(fy)); ty = fy - y0
        row = []
        for i in range(FINE_C):
            fx = i / (FINE_C - 1) * (COLS - 1)
            x0 = min(COLS - 2, int(fx)); tx = fx - x0
            p, q = controls[y0][x0], controls[y0][x0 + 1]
            u, v = controls[y0 + 1][x0], controls[y0 + 1][x0 + 1]
            row.append((p * (1 - tx) + q * tx) * (1 - ty) + (u * (1 - tx) + v * tx) * ty)
        fine.append(row)
    grid = []
    for j in range(FINE_R):
        row = []
        for i in range(FINE_C):
            nb = [fine[min(FINE_R - 1, max(0, j + dj))][min(FINE_C - 1, max(0, i + di))]
                  for dj in (-1, 0, 1) for di in (-1, 0, 1)]
            row.append(round(0.5 * fine[j][i] + 0.5 * sum(nb) / len(nb), 1))
        grid.append(row)
    return grid


def load_state(name, pts, coords):
    f = raw_path(name)
    if f.exists():
        return json.loads(f.read_text(encoding="utf-8"))
    return {"vals": [None] * len(pts), "coords": coords}


def finalize():
    meta = {
        "dataset": DATASET,
        "name": "NASA/METI ASTER Global Digital Elevation Model (ASTER GDEM), ~30 m",
        "resolution": "~30 m (1 arc-second)", "extent": "global",
        "source": "NASA LP DAAC / ASTER GDEM https://asterweb.jpl.nasa.gov/gdem.asp",
        "access": "Open Topo Data public elevation API https://api.opentopodata.org/v1/aster30m",
        "license": "NASA/METI public-domain open elevation data",
        "dataset_note": "原计划使用 srtm30m (NASA/USGS SRTMGL1 v003)，采集时该端点持续读超时；改用同为 NASA 公开 ~30m 全球 DEM 的 ASTER GDEM。数据集列表见 https://www.opentopodata.org/",
        "api_limits": "100 locations/request, 1 request/second, 1000 requests/day; observed 40+ points/request times out, so 16 points/request used",
        "collected_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "controls": {"cols": COLS, "rows": ROWS, "per_area": TOTAL,
                     "kind": "ASTER GDEM measured elevation at sampled coordinates"},
        "render_grid": {"cols": FINE_C, "rows": FINE_R,
                        "kind": "bilinear interpolation + one 3x3 smoothing pass from controls; NOT a full-resolution DEM"},
        "note": "现代开放 DEM 重建自然地形骨架；1948 年聚落、道路、水系与海岸线以军史史料为准。高程在数十年尺度上基本稳定，但城镇建成区、水库与海岸人工改变可能带来局部差异。",
    }
    out = {"meta": meta, "areas": {}}
    for name, a in AREAS.items():
        st = json.loads(raw_path(name).read_text(encoding="utf-8"))
        vals = st["vals"]
        controls = [[float(vals[r * COLS + c]) for c in range(COLS)] for r in range(ROWS)]
        grid = bilinear(controls)
        flat = [v for row in controls for v in row]
        gf = [v for row in grid for v in row]
        step = a["step"]
        while (max(gf) - min(gf)) / step < 6 and step > 5:
            step = max(5, step // 2)
        out["areas"][name] = {
            "bbox": {k: a[k] for k in ("lon0", "lon1", "lat0", "lat1")},
            "contourStep": step, "min": min(flat), "max": max(flat),
            "gridMin": min(gf), "gridMax": max(gf),
            "controls": {"coords": st["coords"], "values": flat}, "grid": grid,
        }
        print("  %s: measured %.0f-%.0f m | grid %.0f-%.0f m | step %d m"
              % (name, min(flat), max(flat), min(gf), max(gf), step), flush=True)
    (ROOT / "elevation.json").write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    compact = {"meta": meta, "areas": {
        k: {"bbox": v["bbox"], "contourStep": v["contourStep"],
            "min": v["gridMin"], "max": v["gridMax"],
            "measuredMin": v["min"], "measuredMax": v["max"], "grid": v["grid"]}
        for k, v in out["areas"].items()}}
    (ROOT / "elevation.js").write_text(
        "const ELEVATION = " + json.dumps(compact, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8", newline="\n")
    print("COMPLETE: run data/embed_elevation.py to refresh src/index.html", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-batches", type=int, default=8)
    args = ap.parse_args()
    used, done, total = 0, 0, 0
    for name, a in AREAS.items():
        pts, coords = points_for(a)
        st = load_state(name, pts, coords)
        for i in range(0, len(pts), BATCH):
            if all(v is not None for v in st["vals"][i:i + BATCH]):
                continue
            if used >= args.max_batches:
                continue
            batch = pts[i:i + BATCH]
            ok = False
            for attempt in range(3):
                try:
                    got = fetch(batch)
                    if len(got) == len(batch):
                        st["vals"][i:i + len(got)] = got
                        ok = True
                        break
                except Exception:
                    pass
                time.sleep(2)
            used += 1
            raw_path(name).write_text(json.dumps(st), encoding="utf-8")
            print(("  OK " if ok else "  MISS ") + name + " %d/%d" % (min(i + len(batch), len(pts)), len(pts)), flush=True)
            time.sleep(1.1)
        done += sum(1 for v in st["vals"] if v is not None)
        total += len(st["vals"])
    print("PROGRESS %d/%d control points" % (done, total), flush=True)
    if done == total:
        finalize()
    else:
        print("PAUSED: run again to fill missing batches", flush=True)


if __name__ == "__main__":
    main()
