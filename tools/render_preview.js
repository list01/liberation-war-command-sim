#!/usr/bin/env node
/**
 * v1.2 静态地图快照生成器（可复现的视觉证据）
 * 运行： node tools/render_preview.js
 * 输出： out/map-regiment.html / out/map-battalion.html / out/map-company.html
 *
 * 不依赖浏览器：在 Node vm + DOM stub 中运行游戏脚本，直接取 renderMap()
 * 生成的 SVG，包装为自包含静态页。用于核对团 / 营 / 连三级注记密度、
 * 编号高地、四色图式与控制区色块，且不引入任何外部资源。
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('FAIL: no <script> block'); process.exit(1); }

function makeCtx() {
  const els = {};
  const document = {
    getElementById(id) {
      return els[id] || (els[id] = {
        innerHTML:'', textContent:'', value:'radio', disabled:false,
        options:{length:0}, dataset:{}, appendChild(){},
        onclick:null, onchange:null,
        getBoundingClientRect(){ return {width:800, height:480}; }
      });
    },
    createElement(){ return {value:'', textContent:''}; }
  };
  const c = { document, console, Math, Date, Object, Array, Set, JSON,
              String, Number, parseInt, isNaN };
  vm.createContext(c);
  vm.runInContext(m[1], c, { filename:'index.js' });
  return c;
}

const c = makeCtx();
const run = s => vm.runInContext(s, c);
run('start(0)');

const OUT = [
  {z:1, file:'map-regiment.html',  tag:'团级战术'},
  {z:2, file:'map-battalion.html', tag:'营级部署'},
  {z:3, file:'map-company.html',   tag:'连级战斗'}
];

for (const o of OUT) {
  run('S.view.z=' + o.z + ';S.view.cx=375;S.view.cy=310;renderMap()');
  const svg = run('document.getElementById("map").innerHTML');
  const info = JSON.parse(run(
    'JSON.stringify({name:ZOOMS[S.view.z].name,map:ZOOMS[S.view.z].map,' +
    'ci:ZOOMS[S.view.z].ci,carto:ZOOMS[S.view.z].carto,' +
    'n:cartoVisible(S.sc.geo,S.view.z).length})'));
  const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>《解放战争》${info.name} · 分级兵要地志快照</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0b1410;color:#dbe7df;font:14px/1.6 "Microsoft YaHei","PingFang SC",sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:18px}
header{border-bottom:1px solid #2b4034;padding-bottom:10px;margin-bottom:14px}
h1{margin:0;font-size:20px;color:#e4b969}
.meta{color:#9fb8aa;font-size:12.5px;margin-top:6px}
.map{width:100%;aspect-ratio:5/3;background:#142b26;border:1px solid #35513f;border-radius:6px;overflow:hidden}
.map svg{display:block;width:100%;height:100%}
footer{margin-top:12px;font-size:12px;color:#8fa79c;border-top:1px solid #2b4034;padding-top:10px}
.k{color:#d8b98a}
</style></head><body><div class="wrap">
<header><h1>《解放战争》师级指挥模拟器 · ${info.name}</h1>
<div class="meta">等效 ${info.map} · 图式等高距 ${info.ci} m · 本级分级注记 ${info.n} 条 · 本级应标：${info.carto}</div></header>
<div class="map">${svg}</div>
<footer>静态快照由 <span class="k">node tools/render_preview.js</span> 从游戏同一渲染管线生成，可随时复现。
四色图式：黑＝居民地 / 道路、蓝＝水系、绿＝植被、棕＝地貌与等高线；白色数字为高程点。
未标 exact 的坐标按战史方位示意标定，仅用于教学示意，不可用于量算。
控制区色块只表示我方实际控制与「已侦知」敌控区，不含敌方动向。</footer>
</div></body></html>`;
  fs.writeFileSync(path.join(ROOT, 'out', o.file), page, 'utf8');
  console.log('  OK  ' + o.file + '  ' + info.name + '  SVG ' +
    (svg.length / 1024).toFixed(1) + ' KB  ' + info.n + ' 条注记');
}
