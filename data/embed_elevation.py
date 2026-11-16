#!/usr/bin/env python3
"""把 data/elevation.js 的真实高程数据内嵌进 src/index.html（幂等）。

运行： python data/embed_elevation.py
原因：游戏需在 file:// 下离线运行，不能用 fetch 读取外部 JSON；
      data/elevation.json 保留为可复核的采集产物，index.html 内嵌同源副本。
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "index.html"
DATA = ROOT / "data" / "elevation.js"

block = DATA.read_text(encoding="utf-8").strip()
if not block.startswith("const ELEVATION = "):
    raise SystemExit("ERROR: data/elevation.js is missing or malformed")
html = SRC.read_text(encoding="utf-8")

if "/* ELEVATION_BLOCK */" in html:
    html = html.replace("/* ELEVATION_BLOCK */", block)
else:
    a = html.find("const ELEVATION = ")
    if a < 0:
        raise SystemExit("ERROR: could not locate ELEVATION block in index.html")
    b = html.find("\n", a)
    if b < 0:
        raise SystemExit("ERROR: malformed ELEVATION line")
    html = html[:a] + block + html[b:]

SRC.write_text(html, encoding="utf-8", newline="\n")
print(f"embedded {len(block)} chars of elevation data into {SRC.name}")
