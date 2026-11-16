#!/usr/bin/env node
/**
 * 《解放战争》师级指挥模拟器 v0.2 · 冒烟测试
 * 运行： node tests/smoke_test.js
 * 覆盖：史实数据完整性、真实地理投影、三剧本端到端推演、开放式指挥机制、
 *       通信传达延迟、数值边界、SVG 地图层、真实电文库、合规检查。
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('FAIL: no <script> block'); process.exit(1); }
const code = m[1];

function fakeEl() {
  return { innerHTML:'', textContent:'', value:'radio', disabled:false,
    options:{length:0}, dataset:{}, appendChild(){}, onclick:null, onchange:null };
}
function makeCtx() {
  const els = {};
  const document = {
    getElementById(id) { return els[id] || (els[id] = fakeEl()); },
    createElement() { return { value:'', textContent:'' }; }
  };
  const ctx = { document, console, Math, Date, Object, Array, Set, JSON, String, Number, parseInt, isNaN };
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename:'index.js' });
  return ctx;
}
const run = (c, s) => vm.runInContext(s, c);
const get = (c, e) => JSON.parse(run(c, 'JSON.stringify(' + e + ')'));
let failed = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!ok) failed++;
}

// 1. 史实数据与真实电文
console.log('[1] 宏观史实与真实电文');
{
  const c = makeCtx();
  check('11 件真实电文 / 指示齐备', get(c,'DOCTRINE.length') === 11);
  check('每件电文均标注来源与设计含义',
    get(c,'DOCTRINE.every(d=>d.src&&d.q&&d.hint&&d.date&&d.title)'));
  check('宏观时间线 >= 12 条', get(c,'HISTORY.timeline.length') >= 12);
  check('兵力对比 7 个时点', get(c,'HISTORY.forces.length') === 7);
  check('编制沿革 4 条', get(c,'HISTORY.formations.length') === 4);
  const sc = get(c,'SCENARIOS.map(s=>({id:s.id,docs:s.docs,wire:s.wire.doc,geo:s.geo,limit:s.limit,kind:s.kind}))');
  check('3 个剧本均为开放式指挥', sc.length === 3 && sc.every(s => s.kind === 'open'));
  check('每关电文引用都能在电文库中找到',
    sc.every(s => s.docs.every(id => get(c,'DOCTRINE.some(d=>d.id==='+JSON.stringify(id)+')')) && s.docs.indexOf(s.wire) >= 0));
  check('真实电文含"我们不遥制"与"机断专行"',
    get(c,'DOCTRINE.some(d=>d.q.indexOf("我们不遥制")>=0)') && get(c,'DOCTRINE.some(d=>d.q.indexOf("机断专行")>=0)'));
}

// 2. 真实地理层
console.log('[2] 真实地理：地名 / 水系 / 铁路 / 公路');
{
  const c = makeCtx();
  const geo = get(c,'Object.keys(GEO).map(k=>({id:k,title:GEO[k].title,places:GEO[k].places.length,rivers:GEO[k].rivers.length,rails:GEO[k].rails.length,roads:GEO[k].roads.length,bbox:GEO[k].bbox}))');
  check('3 个战区地理数据齐备', geo.length === 3);
  for (const g of geo) {
    check(g.id + ' 地名 >= 8 个且有水系', g.places >= 8 && g.rivers >= 2,
      '地名 ' + g.places + ' / 河流 ' + g.rivers + ' / 铁路 ' + g.rails + ' / 公路 ' + g.roads);
    check(g.id + ' 包围盒有效', g.bbox.lon1 > g.bbox.lon0 && g.bbox.lat1 > g.bbox.lat0);
    const proj = get(c,'(()=>{const g=GEO['+JSON.stringify(g.id)+'];const s=new Set();g.places.forEach(p=>{const c=proj(g,p.lon,p.lat);s.add(c.x+","+c.y)});return {distinct:s.size,inBounds:g.places.every(p=>{const c=proj(g,p.lon,p.lat);return c.x>=0&&c.x<'+18+'&&c.y>=0&&c.y<'+11+'})}})()');
    check(g.id + ' 地名按真实经纬度投影且分布不重叠', proj.inBounds && proj.distinct >= 6, '投影到 ' + proj.distinct + ' 个格点');
  }
  check('孟良崮战区无铁路（史实）', geo.find(g=>g.id==='menglianggu').rails === 0);
  check('徐蚌战区有津浦、陇海两条铁路', geo.find(g=>g.id==='xubeng').rails === 2);
  check('塔山战区有北宁铁路', geo.find(g=>g.id==='tashan').rails === 1);
  for (let i = 0; i < 3; i++) {
    run(c,'start('+i+')');
    const t = get(c,'({rows:S.map.length,bad:S.map.filter(r=>r.length!==18).length,chars:[...new Set(S.map.join(""))].filter(ch=>!TERRAIN[ch]).length,onSea:S.pieces.concat(S.enemies.filter(e=>e.active)).filter(u=>terrainAt(u.x,u.y)==="s").length})');
    check('剧本 ' + i + ' 生成 11×18 史实地形格', t.rows === 11 && t.bad === 0 && t.chars === 0);
    check('剧本 ' + i + ' 初始单位均不在海域', t.onSea === 0);
  }
}

// 3. 三剧本端到端推演（开放式：下不同类型命令，含忍耐待机 / 围而不打 / 主动弃守 / 上报）
console.log('[3] 三剧本端到端推演');
const names = ['沂蒙·孟良崮','辽西·塔山','徐蚌·中间突破'];
for (let si = 0; si < 3; si++) {
  const c = makeCtx();
  run(c,'start('+si+')');
  run(c,`
    S.selected='r1'; issueOrder('attack','phone',{x:12,y:5});
    S.selected='r2'; issueOrder('wait','radio',null);
    S.selected='r3'; issueOrder('envelop','radio',null);
    S.selected='recon'; issueOrder('recon','radio',{x:11,y:5});
    reportSituation();
  `);
  const q = get(c,'S.orders.length');
  check(names[si] + ' 命令与上报进入记录', q === 4, '命令 ' + q + ' 条');
  for (let i = 0; i < 30; i++) run(c,'if(!S.over) endTurn()');
  const r = get(c,`({
    over:S.over,turn:S.turn,limit:S.sc.limit,title:S.result&&S.result.title,
    score:S.result&&S.result.score,reason:S.result&&S.result.reason,
    logs:S.logs.length,delivered:S.orders.filter(o=>o.status!=='pending').length,
    badMen:S.pieces.filter(p=>p.men<0||p.morale<0||p.morale>100||p.ammo<0||p.ammo>100||p.fatigue<0||p.fatigue>100).length,
    badEnemy:S.enemies.filter(e=>e.men<0||e.morale<0||e.morale>100).length,
    stats:S.stats,trust:S.trust,decisions:S.decisions.length
  })`);
  check(names[si] + ' 给出终局结论', r.over && !!r.title, '第 ' + r.turn + ' 时段 · ' + r.title + ' · ' + r.score + ' 分');
  check(names[si] + ' 命令均已传达', r.delivered === q, r.delivered + '/' + q);
  check(names[si] + ' 战报有内容', r.logs > 20, r.logs + ' 条');
  check(names[si] + ' 数值不越界', r.badMen === 0 && r.badEnemy === 0);
  check(names[si] + ' 决心与上报被记录', r.decisions >= 4 && r.stats.reports >= 1);
  check(names[si] + ' 控制真实交通节点被统计', typeof r.stats.railControl === 'number');
}

// 4. 开放式指挥与机制
console.log('[4] 开放式指挥与关键机制');
{
  const c = makeCtx();
  run(c,'start(0)');
  check('新增 4 类自由指挥命令', get(c,"['wait','envelop','abandon'].every(k=>CMDS[k]&&CMDS[k].allow.indexOf('regiment')>=0) && CMDS.persuade.allow.indexOf('political')>=0"));
  const delay = get(c,"(()=>{S.selected='r1';issueOrder('move','runner',{x:5,y:5});return S.orders[0].arrive-S.turn})()");
  check('通信员传达延迟 = 2 时段', delay === 2, '实测 ' + delay);
  const immediate = get(c,"(()=>{S.selected='r2';issueOrder('hold','phone',null);return S.orders[S.orders.length-1].arrive-S.turn})()");
  check('有线电话即时生效 = 0 时段', immediate === 0, '实测 ' + immediate);
  const dep = get(c,"(()=>{const b=S.pieces.length;deploy('r1-1-1-1');return {b,a:S.pieces.length,men:S.pieces.find(p=>p.id==='p_r1-1-1-1').men}})()");
  check('班级可派出为独立分队', dep.a === dep.b + 1 && dep.men > 0);
  check('评分卡 8 项', get(c,'evaluate().ev.length') === 8);
  const nightBlock = get(c,"(()=>{S.night=false;S.selected='r1';issueOrder('nightraid','radio',{x:5,y:5});return S.orders.length})()");
  check('白昼不得下达夜袭', nightBlock === 2, '队列 ' + nightBlock);
  // 主动收兵（玩家自主决定何时结束）
  for (let i = 0; i < 4; i++) run(c,'if(!S.over) endTurn()');
  run(c,"finish('report')");
  const rr = get(c,'({over:S.over,reason:S.result.reason,title:S.result.title,ev:S.result.ev.length})');
  check('玩家可主动"收兵 / 结束推演"', rr.over && rr.reason === 'report' && !!rr.title, rr.title);
  check('终局含评分卡与决心复盘', rr.ev === 8);
  // SVG 史实地图层
  // 二维真实地形图层：高程晕渲 + marching squares 等高线
  const svg = get(c,"(()=>{renderMap();const h=document.getElementById('map').innerHTML;return {tiles:(h.match(/data-x=/g)||[]).length,viewbox:h.indexOf('0 0 800 480')>=0,rects:(h.match(/<rect/g)||[]).length,polys:(h.match(/<polygon/g)||[]).length,paths:(h.match(/<path/g)||[]).length,svg:h.indexOf('<svg')===0,names:h.indexOf('孟良崮')>=0,rivers:h.indexOf('#4d94c4')>=0,noIso:typeof iso==='undefined',bad:/NaN|undefined|Infinity/.test(h)}})()");
  check('地图为二维平面 18×11 真实地形图', svg.svg && svg.tiles === 198 && svg.viewbox && svg.noIso, svg.tiles + ' 个格点热区');
  check('高程分级晕渲已绘制且 2.5D 立体块已移除', svg.rects > 2000 && svg.polys === 0, svg.rects + ' 个晕渲/热区矩形');
  check('SVG 无异常坐标', !svg.bad);
  check('叠加真实地名、河流水系与交通线', svg.names && svg.rivers && svg.paths > 0);
  const cRail = makeCtx(); run(cRail,'start(2)');
  const rsvg = get(cRail,"(()=>{renderMap();return document.getElementById('map').innerHTML})()");
  check('徐蚌战场叠加津浦、陇海两条铁路', (rsvg.match(/#c9b47a/g)||[]).length >= 2);
  const elev = get(c,"(()=>{const ks=Object.keys(ELEVATION.areas);const L=ks.map(k=>contourLevels(k));return {keys:ks,dataset:ELEVATION.meta.dataset,grid:ks.map(k=>[ELEVATION.areas[k].grid.length,ELEVATION.areas[k].grid[0].length]),ranges:ks.map(k=>[ELEVATION.areas[k].measuredMin,ELEVATION.areas[k].measuredMax]),levels:L.map(a=>a.length),segs:ks.map((k,i)=>contourSegments(k,L[i][Math.floor(L[i].length/2)]).length),hyps:hypsColor(0.5),sample:ks.map(k=>Math.round(sampleElevation(k,3,4)))}})()");
  check('开放高程数据：ASTER GDEM、3 战区、60×36 绘制网格', elev.dataset==='aster30m' && elev.keys.length===3 && elev.grid.every(g=>g[0]===36&&g[1]===60));
  check('各战区实测高程范围合理', elev.ranges.every(r=>r[1]>r[0]&&r[0]>-500&&r[1]<9000), JSON.stringify(elev.ranges));
  check('等高线层级由真实高程范围派生', elev.levels.every(n=>n>=2), JSON.stringify(elev.levels));
  check('marching squares 生成等高线段', elev.segs.every(n=>n>0), JSON.stringify(elev.segs));
  check('高程晕渲配色合法', /^#[0-9a-f]{6}$/.test(elev.hyps));
  check('格点高程采样为有限实测值', elev.sample.every(v=>Number.isFinite(v)), JSON.stringify(elev.sample));
  check('地形类型由真实高程派生（程序化 base 已移除）', get(c,"S.map.join('').length")===198 && get(c,"GEO.menglianggu.base===undefined"));
  const c2 = makeCtx();
  run(c2,'start(2)');
  for (let i = 0; i < 26; i++) {
    if (get(c2,'S.over')) break;
    run(c2,`(function(){
      const alive=S.enemies.filter(e=>e.alive&&e.active);
      if(!alive.length)return;
      for(const id of ['r1','r2','r3']){
        const u=byId(id); if(!u||!u.alive)continue;
        let best=alive[0],bd=99;
        for(const e of alive){const d=dist(u,e);if(d<bd){bd=d;best=e;}}
        S.selected=id; issueOrder('attack','phone',{x:best.x,y:best.y});
      }
      S.selected='arty'; issueOrder('artillery','phone',{x:alive[0].x,y:alive[0].y});
      if(S.turn%3===0) reportSituation();
    })();`);
    run(c2,'if(!S.over) endTurn()');
  }
  const rr2 = get(c2,'({over:S.over,score:S.result&&S.result.score,title:S.result&&S.result.title,kill:Math.round(S.stats.enemyLoss),own:Math.round(S.stats.ownLoss)})');
  check('积极指挥可获得较高评价', rr2.over && rr2.score >= 52,
    rr2.score + ' 分 · ' + rr2.title + ' · 歼敌 ' + rr2.kill + ' / 我伤亡 ' + rr2.own);
}

// 5. 合规与交付检查
console.log('[5] 合规与交付');
{
  const geoHtml = fs.readFileSync(path.join(ROOT, 'src', 'geography.html'), 'utf8');
  check('真实地图对照页使用腾讯地图 GL JS（白名单）', geoHtml.indexOf('map.qq.com/api/gljs') >= 0);
  check('SDK URL 不含明文 key', /api\/gljs\?v=1\.exp(?![\s\S]*key=)/.test(geoHtml) && geoHtml.indexOf('key=') < 0);
  check('保留 WorkBuddy 代理占位符', geoHtml.indexOf('__WB_HTTP_PORT__') >= 0 && geoHtml.indexOf('__WB_TMAP_SECRET__') >= 0);
  check('未引用境外地图源', !/googleapis|openstreetmap|mapbox|bing\.com\/maps|tile\.openstreetmap/i.test(geoHtml + html));
  check('主游戏离线可运行（无外部脚本）', !/<script[^>]+src="https?:/i.test(html));
  const docs = ['docs/SOURCES.md','docs/DESIGN.md','README.md'];
  for (const d of docs) check(d + ' 存在', fs.existsSync(path.join(ROOT, d)));
  const ej = JSON.parse(fs.readFileSync(path.join(ROOT,'data','elevation.json'),'utf8'));
  check('高程数据文件与采集/内嵌脚本齐备',
    fs.existsSync(path.join(ROOT,'data','elevation.js')) && fs.existsSync(path.join(ROOT,'data','fetch_elevation.py')) && fs.existsSync(path.join(ROOT,'data','embed_elevation.py')));
  check('元数据区分 ASTER 实测控制点与插值网格', ej.meta.dataset==='aster30m' && ej.meta.controls.kind && ej.meta.render_grid.kind.indexOf('NOT')>=0);
  check('每战区 96 个 ASTER 实测控制点', Object.values(ej.areas).every(a=>a.controls.values.length===96 && a.controls.coords.length===96));
}


// 6. v0.5 多级比例尺战术地图与营连级部署
console.log('[6] 多级比例尺、制图分级与下级指挥');
{
  const c = makeCtx(); run(c,'start(0)');
  const zs = get(c,'ZOOMS.map(z=>({k:z.k,name:z.name,cmd:z.cmd}))');
  check('四级比例尺：师级全景 / 团级战术 / 营级部署 / 连级战斗',
    zs.length===4 && zs.map(z=>z.k).join(',')==='1,3,9,18',
    zs.map(z=>z.name).join(' / '));
  const lod = get(c,'({f:LOD.feature,g:LOD.subgrid,z:LOD.zone,ca:LOD.carto,layers:LAYER_DEFS.length})');
  check('LOD：子格与要点仅在团 / 营 / 连级出现', lod.f[0]===0 && lod.f[1]===1 && lod.g[0]===0 && lod.g[2]===1,
    lod.layers + ' 个可开关图层');
  check('新增控制区 / 分级地志图层的 LOD 为四级且师级隐藏',
    lod.z.length===4 && lod.ca.length===4 && !lod.z[0] && !lod.ca[0] && lod.z[3] && lod.ca[3]);

  const vb = get(c,"(()=>{const out=[];for(let z=0;z<4;z++){S.view.z=z;S.view.cx=400;S.view.cy=240;out.push(viewBoxStr())}S.view.z=0;return out})()");
  check('viewBox 随比例尺收缩而非另建坐标系',
    vb[0]==='0 0 800 480' && vb[1].split(' ')[2]==='266.7' && vb[2].split(' ')[2]==='88.9' && vb[3].split(' ')[2]==='44.4',
    vb.join(' | '));
  const vp = get(c,"(()=>{S.view.z=2;S.view.cx=0;S.view.cy=0;const a=visibleBox();S.view.cx=9999;S.view.cy=9999;const b2=visibleBox();resetView();return {a:[a.x,a.y],b:[b2.x,b2.y],z:S.view.z}})()");
  check('视口平移被钳制在图幅内', vp.a[0]===0 && vp.b[0]<VW0() && vp.z===0, JSON.stringify(vp));
  function VW0(){ return 800; }
  const zoom = get(c,"(()=>{S.selected='r1';zoomBy(1);const a={z:S.view.z,cx:S.view.cx};zoomBy(9);const b={z:S.view.z};focusSelected();resetView();return {a,b,z:S.view.z}})()");
  check('放大自动聚焦所选单位且不越级', zoom.a.z===1 && zoom.a.cx<400 && zoom.b.z===3 && zoom.z===0);
  const lay = get(c,"(()=>{const a=layerOn('contour');toggleLayer('contour');const b=layerOn('contour');resetLayers();return {a,b,back:layerOn('contour')}})()");
  check('图层可独立开关并可恢复自动分级', lay.a && !lay.b && lay.back);

  const carto = get(c,"(()=>({places:Object.values(GEO).every(g=>g.places.every(p=>placeRank(p)>=0&&placeRank(p)<=4)),roads:Object.values(GEO).every(g=>g.roads.every(r=>roadGrade(r)>=1&&roadGrade(r)<=3)),rivers:Object.values(GEO).every(g=>g.rivers.every(r=>riverGrade(r)>=1&&riverGrade(r)<=3)),lakes:Object.values(LAKES).reduce((a,v)=>a+v.length,0),features:Object.values(FEATURES).reduce((a,v)=>a+v.length,0),sourced:Object.values(FEATURES).every(fs=>fs.every(f=>f.src&&FEATURE_KIND[f.k])),btasks:Object.keys(BTASKS).length,cacts:Object.keys(CACTS).length,roles:Object.keys(SQUAD_ROLES).length}))()");
  check('居民地 / 道路 / 水系均有 1–3 级制图分级', carto.places && carto.roads && carto.rivers);
  check('面状水域与史实战术要点齐备且逐条标注来源', carto.lakes>=3 && carto.features>=20 && carto.sourced,
    carto.lakes + ' 处水域 / ' + carto.features + ' 个要点');
  check('营任务 6 类 / 连战术动作 13 类 / 班组 5 类', carto.btasks===6 && carto.cacts===13 && carto.roles===5,
    carto.btasks + ' / ' + carto.cacts + ' / ' + carto.roles);

  const fc = get(c,"(()=>{const L=featureCells(S.sc.geo);return {n:L.length,uniq:new Set(L.map(o=>[o.x,o.y,o.sx,o.sy].join(','))).size,hit:L.every(o=>subFeature(S.sc.geo,o.x,o.y,o.sx,o.sy).explicit),shift:L.filter(o=>o.shifted).length}})()");
  check('冲突要点分配到唯一子格且可被子格命中', fc.n===fc.uniq && fc.hit, JSON.stringify(fc));
  const subf = get(c,"(()=>{const f=subFeature(S.sc.geo,2,3,1,1);return {n:f.n,e:f.elev,def:f.eff.def,att:f.eff.att,src:!!f.src}})()");
  check('派生子格要点含高程、效应与依据', Number.isFinite(subf.e) && Number.isFinite(subf.def) && subf.src);

  for (let si=0; si<3; si++) {
    const cx = makeCtx(); run(cx,'start('+si+')');
    const out=[];
    for (let z=0; z<4; z++) {
      run(cx,'S.view.z='+z+';S.view.cx=400;S.view.cy=240;renderAll()');
      out.push(get(cx,"(()=>{const h=document.getElementById('map').innerHTML;return {tiles:(h.match(/data-x=/g)||[]).length,bad:/NaN|undefined|Infinity/.test(h),polys:(h.match(/<polygon/g)||[]).length,svg:h.indexOf('<svg')===0}})()"));
    }
    check('剧本 '+si+' 四级渲染无异常坐标且无 2.5D 立体块',
      out.every(o=>!o.bad&&o.polys===0&&o.svg) && out[0].tiles===198 && out[1].tiles===315 && out[2].tiles===162 && out[3].tiles>0,
      out.map(o=>o.tiles).join('/') + ' 热区');
    const ui = get(cx,"(()=>{const q=id=>document.getElementById(id).innerHTML.length;return {tools:q('maptools'),legend:q('legend'),scale:q('scalebar'),info:q('mapinfo')}})()");
    check('剧本 '+si+' 工具栏 / 图例 / 比例尺 / 情报卡齐备',
      ui.tools>200 && ui.legend>200 && ui.scale>20 && ui.info>20, JSON.stringify(ui));
  }
  const local = get(c,"(()=>{S.view.z=2;S.view.cx=400;S.view.cy=240;const h=localHypsometric(S.sc.geo,2);const L=localContourLevels(S.sc.geo,2);S.view.z=0;return {rects:(h.match(/<rect/g)||[]).length,levels:L.length}})()");
  check('放大后局部重采样晕渲与加密等高线生效', local.rects>500 && local.levels>=2,
    local.rects + ' 个局部色块 / ' + local.levels + ' 层');

  const d = makeCtx(); run(d,'start(0)');
  const r = get(d,'({x:byId("r1").x,y:byId("r1").y})');
  run(d,'beginDeploy("r1-1-1")');
  const dep = get(d,"(()=>{const r=byId('r1');return [deploySubAt('r1-1-1',r.x,r.y,1,1,'hold'),deploySubAt('r1-1-2',r.x,r.y,0,0,'assault'),deploySubAt('r1-1-3',r.x,r.y,2,2,'flank'),deploySubAt('r1-2-1',r.x,r.y,1,0,'support'),deploySubAt('r1-2-2',r.x,r.y,1,1,'hold')]})()");
  check('每团每时段限 3 处阵位调整',
    dep[0]&&dep[1]&&dep[2]&&!dep[3]&&!dep[4] && get(d,'Object.values(S.subs).filter(s=>s.repositioned).length')===3, JSON.stringify(dep));
  const tf = get(d,"({r1:subTacticalMod([byId('r1')]),r2:tacticalFactor([byId('r2')],'def')})");
  check('战术修正含编成说明且钳制在 0.85–1.45', tf.r1.att>=0.85 && tf.r1.att<=1.45 && !!tf.r1.note && tf.r2.f<=1.45,
    'r1 ' + tf.r1.att.toFixed(3) + ' · ' + tf.r1.note);
  const sc = get(d,"(()=>{endTurn();const before=S.intel;deploySubAt('r1-2-3',byId('r1').x,byId('r1').y,0,2,'scout');return {before,after:S.intel}})()");
  check('渗透侦察任务提升敌情等级', sc.after>sc.before, sc.before+' → '+sc.after);
  check('不得把营连部署到本团及邻格之外', get(d,"deploySubAt('r1-3-1',17,0,1,1,'hold')")===false);
  const combat = makeCtx(); run(combat,'start(0)');
  run(combat,"(()=>{const r=byId('r1');const e=S.enemies[0];e.x=r.x;e.y=r.y;e.active=true;e.alive=true;deploySubAt('r1-1-1',r.x,r.y,1,1,'assault');S.selected='r1';issueOrder('attack','phone',{x:r.x,y:r.y});})()");
  run(combat,'endTurn()');
  check('下级编成与要点实际进入结算并写入战报',
    get(combat,"S.logs.some(l=>l.t.indexOf('要点生效')>=0||l.t.indexOf('集中')>=0)"));
  check('主游戏仍无外部脚本 / 第三方瓦片',
    !/<script[^>]+src="https?:/i.test(html) && !/googleapis|openstreetmap|mapbox|tile\./i.test(html));
}



// 7. v0.6 团以下单位解聚、指挥链与兵力守恒
console.log('[7] 团以下指挥：聚合—解聚、命令链、结算');
{
  const c = makeCtx(); run(c,'start(0)');
  const base = get(c,"(()=>{const regs=S.pieces.filter(p=>p.kind==='regiment');return {subs:Object.keys(S.subs).length,bn:Object.values(S.subs).filter(s=>s.level==='battalion').length,cn:Object.values(S.subs).filter(s=>s.level==='company').length,sn:Object.values(S.subs).filter(s=>s.level==='squad').length,placed:Object.values(S.subs).filter(s=>s.placed).length,ok:regs.every(subBookOK),sums:regs.map(r=>[r.men,r.subs.reduce((a,b)=>a+b.men,0)])}})()");
  check('3 团解聚为 9 营 / 27 连 / 81 班，全部有默认阵位',
    base.subs===117 && base.bn===9 && base.cn===27 && base.sn===81 && base.placed===117, JSON.stringify(base));
  check('兵力账目守恒：团 = Σ营 = Σ连 = Σ班',
    base.ok && base.sums.every(v=>v[0]===v[1]), JSON.stringify(base.sums));
  const def = get(c,"(()=>{const bs=battalionsOf('r1');return {tasks:bs.map(b=>b.task),men:bs.map(b=>b.men),cfg:SUB_LEVEL}})()");
  check('每团默认主攻 / 助攻 / 预备队编成', def.tasks.join(',')==='main,support,reserve', JSON.stringify(def.tasks));
  check('营 / 连 / 班作业量与传达延迟递增',
    def.cfg.battalion.cost===1&&def.cfg.battalion.delay===1&&def.cfg.company.cost===2&&def.cfg.company.delay===2&&def.cfg.squad.cost===2);

  const z1 = get(c,"(()=>{const a=byId('r1');S.view.z=1;S.view.cx=(a.x+0.5)*CW;S.view.cy=(a.y+0.5)*CH;renderMap();const h=document.getElementById('map').innerHTML;const r=renderSubUnits(1,zoomU());S.view.z=0;return {syms:(r.match(/<rect/g)||[]).length,task:(r.indexOf(BTASKS.main.n)>=0),hasmain:h.indexOf('主攻')>=0}})()");
  check('团级视图渲染可见营符号与任务标注（按视口裁剪）', z1.syms>=3 && z1.task && z1.hasmain, JSON.stringify(z1));
  const z2 = get(c,"(()=>{S.focusSub='r1-1';S.view.z=2;S.view.cx=(byId('r1').x+0.5)*44.444;S.view.cy=(byId('r1').y+0.5)*43.636;const r=renderSubUnits(2,zoomU());S.view.z=0;S.focusSub=null;return {rects:(r.match(/<rect/g)||[]).length,labels:(r.match(/1连|2连|3连/g)||[]).length}})()");
  check('营连级视图渲染营与焦点营的连（标号牌）', z2.rects>0 && z2.labels>=1, JSON.stringify(z2));

  // 逐级命令：作业量与延迟
  const oc = makeCtx(); run(oc,'start(0)');
  const before = get(oc,'S.points');
  run(oc,"S.treeSel='r1-1';issueSubOrder('defend','phone',null)");
  const o1 = get(oc,"(()=>{const o=S.subOrders[0];return {points:S.points,delay:o.arrive-1,arrive:o.arrive,status:o.status,task:subById('r1-1').task}})()");
  check('营命令耗 1 点作业量、按团部传达延迟 1 时段',
    o1.points===before-1 && o1.delay===1 && o1.task==='main', JSON.stringify(o1));
  run(oc,'endTurn()');
  check('命令在下一时段经传达生效并改变营任务', get(oc,"subById('r1-1').task")==='defend');
  run(oc,"S.treeSel='r1-1-1';issueSubOrder('trench','phone',null)");
  const o2 = get(oc,"(()=>{const o=S.subOrders[S.subOrders.length-1];return {points:S.points,delay:o.arrive-S.turn}})()");
  check('连命令耗 2 点作业量、传达延迟 2 时段（有线电话即时 + 两级下传）', o2.delay===2 && o2.points===2, JSON.stringify(o2));

  // 战术阶段动作效果
  const ac = makeCtx(); run(ac,'start(0)');
  run(ac,"subById('r1-1-1').order={type:'trench',target:null};subById('r1-1-2').order={type:'recon',target:null};subPhase()");
  const eff = get(ac,"({trench:subById('r1-1').trench,intel:S.intel,rec:S.stats.recon})");
  check('连战术动作：近迫作业升工事、侦察升敌情', eff.trench===1 && eff.intel===2 && eff.rec===1, JSON.stringify(eff));

  // 集中兵力 vs 平分兵力
  const mass = get(c,"(()=>{const r=byId('r1'),bs=battalionsOf('r1');const save=bs.map(b=>b.task);bs[0].task='main';bs[1].task='main';bs[2].task='pin';const a=subTacticalMod([r]).att;bs.forEach((b,i)=>b.task=save[i]);return a})()");
  const split = get(c,"(()=>{const r=byId('r1'),bs=battalionsOf('r1');const save=bs.map(b=>b.task);bs.forEach(b=>b.task='pin');const a=subTacticalMod([r]).att;bs.forEach((b,i)=>b.task=save[i]);return a})()");
  check('两个营主攻形成局部优势，平分兵力受罚', mass>split && mass>1, mass.toFixed(3)+' > '+split.toFixed(3));

  // 伤亡 / 补充 / 派出守恒
  const cons = makeCtx(); run(cons,'start(0)');
  run(cons,"applyLoss(byId('r1'),300)");
  const afterLoss = get(cons,"({ok:subBookOK(byId('r1')),men:byId('r1').men,sum:battalionsOf('r1').reduce((a,b)=>a+b.men,0)})");
  check('伤亡逐级分摊后账目仍守恒', afterLoss.ok && afterLoss.men===afterLoss.sum, JSON.stringify(afterLoss));
  run(cons,"applyReplenish(byId('r1'),120)");
  check('即俘即补逐级回补后账目仍守恒', get(cons,'subBookOK(byId("r1"))'));
  run(cons,"S.treeSel='r1-2-1-1';deploy('r1-2-1-1')");
  check('班级派出为独立分队后账目仍守恒',
    get(cons,'subBookOK(byId("r1"))') && get(cons,'S.pieces.filter(p=>p.detached).length')===1 &&
    get(cons,'Object.values(S.subs).filter(s=>s.detached).length')>=1,
    '派出后团 ' + get(cons,'byId("r1").men') + ' 人');

  // 团机动后阵形跟随
  const sync = makeCtx(); run(sync,'start(0)');
  const pos0 = get(sync,"subById('r1-1').placed.x");
  run(sync,"byId('r1').x=byId('r1').x+1;syncSubPositions()");
  const pos1 = get(sync,"subById('r1-1').placed.x");
  check('团机动时营连班阵形按位移跟随', pos1===pos0+1, pos0+' → '+pos1);

  // 命令面板按层级切换
  const ui = makeCtx(); run(ui,'start(0)');
  run(ui,"S.treeSel='r1-1';renderCmd()");
  const cmdB = get(ui,"document.getElementById('cmdpanel').innerHTML");
  run(ui,"S.treeSel='r1-1-1';renderCmd()");
  const cmdC = get(ui,"document.getElementById('cmdpanel').innerHTML");
  check('命令面板按营 / 连自动切换命令集',
    cmdB.indexOf('预备队')>=0 && cmdB.indexOf('近迫作业')<0 && cmdC.indexOf('近迫作业')>=0, cmdB.length+' / '+cmdC.length);
  run(ui,"selectNode('r1-1')");
  check('选中下级单位自动展开编制并放大到团级',
    get(ui,'S.treeSel')==='r1-1' && get(ui,'S.expanded.has("r1")') && get(ui,'S.view.z')>=1);
  const e2e = makeCtx(); run(e2e,'start(2)');
  for (let i=0;i<26;i++){
    if (get(e2e,'S.over')) break;
    run(e2e,`(function(){
      const alive=S.enemies.filter(e=>e.alive&&e.active);
      if(!alive.length)return;
      for(const id of ['r1','r2','r3']){
        const u=byId(id); if(!u||!u.alive)continue;
        let best=alive[0],bd=99;
        for(const e of alive){const d=dist(u,e);if(d<bd){bd=d;best=e;}}
        S.selected=id; issueOrder('attack','phone',{x:best.x,y:best.y});
      }
      S.selected='arty'; issueOrder('artillery','phone',{x:alive[0].x,y:alive[0].y});
      if(S.turn%3===0) reportSituation();
    })();`);
    run(e2e,'if(!S.over) endTurn()');
  }
  const fin = get(e2e,'({over:S.over,score:S.result&&S.result.score,ok:S.pieces.filter(p=>p.kind==="regiment").every(subBookOK)})');
  check('端到端推演可达终局且全程兵力账目守恒', fin.over && fin.score>=52 && fin.ok,
    fin.score + ' 分 · 守恒 ' + fin.ok);
}



// 8. v0.7 敌我双方标号牌、敌方解聚与接触态势
console.log('[8] 敌我渲染：标号牌、敌方解聚、接触线');
{
  const c = makeCtx(); run(c,'start(0)');
  const foe = get(c,"(()=>({n:Object.keys(S.foeSubs).length,bn:Object.values(S.foeSubs).filter(s=>s.level==='foeBattalion').length,cn:Object.values(S.foeSubs).filter(s=>s.level==='foeCompany').length,ok:S.enemies.every(foeBookOK),placed:Object.values(S.foeSubs).filter(s=>s.placed).length}))()");
  check('敌方按同一三三制解聚且全部有阵位', foe.n===48 && foe.bn===12 && foe.cn===36 && foe.placed===48, JSON.stringify(foe));
  check('敌方兵力账目守恒：敌单位 = Σ敌营 = Σ敌连', foe.ok);
  run(c,"applyFoeLoss(S.enemies[0],400)");
  check('敌方伤亡逐级分摊后账目仍守恒', get(c,'foeBookOK(S.enemies[0])'));
  const pos0 = get(c,"S.enemies[0].foeSubs[0].placed.x");
  run(c,"S.enemies[0].x=S.enemies[0].x+1;syncFoePositions()");
  check('敌单位机动时敌营 / 敌连阵形跟随', get(c,"S.enemies[0].foeSubs[0].placed.x")===pos0+1);

  const z0 = get(c,"(()=>{S.view.z=0;const r=renderUnits(0,1);return {ours:(r.match(/<rect/g)||[]).length,foes:(r.match(/<path/g)||[]).length,hasMen:r.indexOf('人')>=0,wide:(r.match(/width=\"5[0-9]\\./g)||[]).length}})()");
  check('师级视图：我方圆角牌 / 敌方切角牌形状可区分', z0.ours>0 && z0.foes>0 && z0.hasMen, JSON.stringify(z0));
  check('标号牌按目标屏幕像素放大（宽度显著大于 v0.6 小圆点）', z0.wide>=3, z0.wide+' 个大号牌');

  const z1 = get(c,"(()=>{const e=S.enemies[0];S.view.z=1;S.view.cx=(e.x+0.5)*CW;S.view.cy=(e.y+0.5)*CH;const a=renderSubUnits(1,zoomU()),b=renderFoeUnits(1,zoomU());S.view.z=0;return {ourB:(a.match(/主攻|助攻|预备队/g)||[]).length,foeB:(b.match(/敌 \\d 营/g)||[]).length,foePath:(b.match(/<path/g)||[]).length}})()");
  check('团级视图敌我双方均展开到营级', z1.ourB>=0 && z1.foeB>=1 && z1.foePath>=1, JSON.stringify(z1));

  const ct = get(c,"(()=>{S.view.z=1;S.view.cx=400;S.view.cy=240;const a=renderContact(1,zoomU());const on=layerOn('contact');toggleLayer('contact');const off=layerOn('contact');resetLayers();const back=layerOn('contact');S.view.z=0;const z0=layerOn('contact');return {len:a.length,on,off,back,z0}})()");
  check('敌我接触线图层可开关且按级别自动分级', ct.on && !ct.off && ct.back && !ct.z0, JSON.stringify(ct));

  for (let si=0;si<3;si++){
    const cc=makeCtx(); run(cc,'start('+si+')');
    const out=[];
    for(let z=0;z<3;z++){
      run(cc,'S.view.z='+z+';S.view.cx=400;S.view.cy=240;renderAll()');
      const h=get(cc,"document.getElementById('map').innerHTML");
      out.push({bad:/NaN|undefined|Infinity/.test(h),polys:(h.match(/<polygon/g)||[]).length});
    }
    check('剧本 '+si+' 三级敌我渲染无异常坐标、无 2.5D 立体块',
      out.every(o=>!o.bad&&o.polys===0));
    check('剧本 '+si+' 敌方账目全程守恒', get(cc,'S.enemies.every(foeBookOK)'));
  }
  const leg = get(c,"(()=>{renderLegend();return document.getElementById('legend').innerHTML})()");
  check('图例新增敌我识别组', leg.indexOf('敌我识别')>=0 && leg.indexOf('切角')>=0);
  const cue = get(c,"(()=>{S.view.z=1;S.view.cx=(byId('r1').x+0.5)*CW;S.view.cy=(byId('r1').y+0.5)*CH;const a=renderEdgeCues(1,zoomU()),b2=renderEdgeCues(0,1);S.view.z=0;return {len:a.length,hasFoe:a.indexOf('敌 ')>=0,z0:b2.length}})()");
  check('视界外敌我方位指示仅放大视图出现', cue.len>0 && cue.hasFoe && cue.z0===0, JSON.stringify(cue));
  const nav = makeCtx(); run(nav,'start(1)');
  run(nav,'focusEnemy()');
  const fe = get(nav,"(()=>({z:S.view.z,cx:S.view.cx,onEnemy:S.enemies.some(e=>e.alive&&e.active&&Math.abs((e.x+0.5)*CW-S.view.cx)<1)}))()");
  check('定位敌情把视口对准一个在场的敌单位', fe.z>=1 && fe.onEnemy, JSON.stringify(fe));
  run(nav,'focusContact()');
  check('定位接触带按敌我距离自动选择级别', get(nav,'S.view.z')>=1);
  run(nav,'renderMapTools()');
  const tools = get(nav,"document.getElementById('maptools').innerHTML");
  check('工具栏提供定位敌情 / 定位接触带', tools.indexOf('定位敌情')>=0 && tools.indexOf('定位接触带')>=0);
}



// 9. v0.8 移动设备友好：响应式、抽屉、手势、视口自适应
console.log('[9] 移动端：布局 / 抽屉 / 手势 / 视口自适应');
{
  const full = fs.readFileSync(path.join(ROOT,'src','index.html'),'utf8');
  check('viewport 含 viewport-fit=cover 与主题色',
    full.indexOf('viewport-fit=cover')>=0 && full.indexOf('theme-color')>=0);
  check('三档响应式：平板横屏 / 单栏移动 / 小屏手机',
    full.indexOf('@media(max-width:1180px) and (min-width:901px)')>=0 &&
    full.indexOf('@media(max-width:900px)')>=0 && full.indexOf('@media(max-width:420px)')>=0);
  check('触控目标 >=44px 与安全区适配',
    full.indexOf('min-height:44px')>=0 && full.indexOf('env(safe-area-inset-bottom)')>=0);
  check('移动端 DOM：状态条 / 底部栏 / 遮罩 / 全屏控件 / 地图框架',
    ['id="mstatus"','id="mbar"','id="mscrim"','id="mapfs"','class="mapframe"'].every(k=>full.indexOf(k)>=0));
  check('地图禁用浏览器手势并改用 Pointer Events',
    full.indexOf('touch-action:none')>=0 && full.indexOf('onpointerdown')>=0 && full.indexOf('onpointerup')>=0);

  const c = makeCtx(); run(c,'start(1)');
  check('桌面比例下 viewBox 保持不变', get(c,'viewBoxStr()')==='0 0 800 480');
  const sh = get(c,"(()=>{const a=toggleSheet('right');const b=toggleSheet('right');const x=toggleSheet('left');closeSheet();return {a,b,x,end:S.sheet}})()");
  check('抽屉可开合、同级再点关闭、互斥切换', sh.a==='right'&&sh.b===null&&sh.x==='left'&&sh.end===null, JSON.stringify(sh));
  const fsState = get(c,"(()=>{const a=toggleFullscreenMap(),b=toggleFullscreenMap();return {a,b,end:S.fs}})()");
  check('全屏地图可进入与退出', fsState.a===true&&fsState.b===false&&fsState.end===false);
  const ui = get(c,"(()=>({status:document.getElementById('mstatus').innerHTML,fs:document.getElementById('mapfs').innerHTML}))()");
  check('精简状态条与地图浮动控件被渲染',
    ui.status.indexOf('时段')>=0 && ui.fs.indexOf('全屏')>=0, JSON.stringify(ui).slice(0,150));
  check('地图绑定 Pointer 手势与滚轮兼容',
    get(c,"(()=>{const m=document.getElementById('map');return !!(m.onpointerdown&&m.onpointermove&&m.onpointerup&&m.onpointercancel&&m.onclick&&m.onwheel)})()"));

  run(c,"document.getElementById('map').getBoundingClientRect=()=>({left:0,top:0,width:390,height:520})");
  const vb = get(c,"(()=>{const b=visibleBox();return {w:b.w,h:b.h,area:b.w*b.h,ratio:b.w/b.h}})()");
  check('窄屏容器下 viewBox 按比例自适应且视口面积守恒',
    Math.abs(vb.ratio-390/520)<0.01 && Math.abs(vb.area-800*480)<1, JSON.stringify(vb));
  const pick = get(c,"(()=>{S.view.z=2;S.view.cx=400;S.view.cy=240;const d=pickCellAt(200,260,document.getElementById('map'));S.view.z=0;return d})()");
  check('触屏按世界坐标落格，含子格与微格且范围合法',
    pick && pick.x>=0 && pick.x<18 && pick.y>=0 && pick.y<11 &&
    [pick.sx,pick.sy,pick.mx,pick.my].every(v=>v>=0&&v<=2), JSON.stringify(pick));
  const drag = get(c,"(()=>{const m=document.getElementById('map');m.onpointerdown({pointerId:1,pointerType:'touch',clientX:100,clientY:100,button:0});m.onpointermove({pointerId:1,pointerType:'touch',clientX:130,clientY:120,button:0});m.onpointerup({pointerId:1,pointerType:'touch',clientX:130,clientY:120,button:0});return {moved:S._dragMoved,drag:!!S._drag}})()");
  check('单指拖拽被识别为平移手势', drag.moved===true, JSON.stringify(drag));
  check('桌面三栏布局未被破坏', full.indexOf('grid-template-columns:274px minmax(520px,1fr) 318px')>=0);
}



// 10. v0.9 态势表现：只读事件流 / 四组图层 / 复盘时间轴
console.log('[10] 态势表现：路线、战斗效果、战术战略与复盘');
{
  const full = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  check('四组态势图层与 LOD 自动分级',
    ['route','combat','tactic','strategy'].every(k => full.indexOf("{k:'" + k + "'") >= 0) &&
    full.indexOf('route:[1,1,1,1]') >= 0 && full.indexOf('tactic:[0,1,1,1]') >= 0 &&
    full.indexOf('strategy:[1,0,0,0]') >= 0);
  check('动画克制：keyframes / reduced-motion / 移动端静态降级',
    full.indexOf('@keyframes fxflow') >= 0 && full.indexOf('prefers-reduced-motion') >= 0 &&
    full.indexOf('.fx-anim .fx-flow,.fx-anim .fx-pop') >= 0);
  check('态势摘要卡与时间轴控件齐备',
    full.indexOf('id="fxsummary"') >= 0 && full.indexOf('态势时间轴') >= 0 &&
    full.indexOf('fxStep(-1)') >= 0 && full.indexOf('fxLive()') >= 0 && full.indexOf('fxToggleAnim()') >= 0);
  check('表现层旁路埋点覆盖引擎关键节点',
    ['fxPush(\'move\'','fxPush(\'combat\'','fxPush(\'kill\'','fxPush(\'encircle\'',
     'fxPush(\'artillery\'','fxPush(\'subact\'','fxSnapshot()'].every(k => full.indexOf(k) >= 0));

  const c = makeCtx(); run(c, 'start(0)');
  const init = get(c, '({fx:!!S.fx,events:S.fx.events.length,hist:S.fx.history.length,trails:Object.keys(S.fx.trails).length,animate:S.fx.animate})');
  check('S.fx 只读表现状态正确初始化',
    init.fx && init.events === 0 && init.hist === 0 && init.trails === 0 && init.animate === true,
    JSON.stringify(init));

  for (let i = 0; i < 6; i++) {
    if (get(c, 'S.over')) break;
    run(c, `(function(){
      const alive=S.enemies.filter(e=>e.alive&&e.active);
      if(!alive.length)return;
      for(const id of ['r1','r2','r3']){
        const u=byId(id); if(!u||!u.alive)continue;
        let best=alive[0],bd=99;
        for(const e of alive){const d=dist(u,e);if(d<bd){bd=d;best=e;}}
        S.selected=id; issueOrder('attack','phone',{x:best.x,y:best.y});
      }
      S.selected='arty'; issueOrder('artillery','phone',{x:alive[0].x,y:alive[0].y});
    })();`);
    run(c, 'if(!S.over) endTurn()');
  }
  const A = get(c, `(()=>{
    const types={}; for(const h of S.fx.history) for(const e of h.events) types[e.type]=(types[e.type]||0)+1;
    return {turn:S.turn,hist:S.fx.history.length,trails:Object.keys(S.fx.trails).length,
      types,keys:Object.keys(S.fx.history[0]).sort().join(','),score:strategicScore()};
  })()`);
  check('每时段生成事件快照与单位轨迹', A.hist === A.turn - 1 && A.trails > 0,
    A.hist + ' 个快照 / ' + A.trails + ' 条轨迹');
  check('事件覆盖机动 / 交火 / 炮火准备 / 支前',
    ['move','combat','artillery','supply'].every(k => A.types[k] > 0), JSON.stringify(A.types));
  check('快照含事件、单位、敌情、战果与评分',
    A.keys === 'enemies,events,score,stats,t,units', A.keys);

  const L = get(c, `(()=>{const z=S.view.z,u=zoomU();
    const r=renderRoutes(z,u),b=renderCombatFx(z,u),t=renderTacticFx(z,u),g=renderStrategyFx(z,u);
    return {route:r.length,combat:b.length,tactic:t.length,strategy:g.length,
      clean:[r,b,t,g].every(x=>!/NaN|undefined|Infinity/.test(x)),
      arrow:r.indexOf('<path d="M')>=0, polygon:r.indexOf('<polygon')<0,
      intent:g.indexOf('战役意图')>=0}})()`);
  check('四组态势渲染均产出内容且无异常坐标',
    L.route > 1000 && L.combat > 500 && L.strategy > 100 && L.clean,
    L.route + '/' + L.combat + '/' + L.tactic + '/' + L.strategy);
  check('进攻轴线用 path，保持无 2.5D 立体块', L.arrow && L.polygon);
  check('师级全景绘制战役意图方向', L.intent);

  const lay = get(c, `(()=>{const a=layerOn('strategy'),b=layerOn('tactic');
    toggleLayer('strategy');const off=!layerOn('strategy');resetLayers();
    S.view.z=2;const t2=layerOn('tactic');S.view.z=0;
    return {a,b,off,back:layerOn('strategy'),t2}})()`);
  check('新图层按 LOD 分级（战略仅师级、战术仅团级起）且可手动开关',
    lay.a && !lay.b && lay.off && lay.back && lay.t2, JSON.stringify(lay));

  const R = get(c, `(()=>{const all=fxEvents().length,t0=S.fx.viewTurn;
    fxStep(-1);const t=S.fx.viewTurn,ev=fxEvents().length,
      trail=Object.values(fxTrails()).reduce((a,v)=>a+v.length,0),
      h=document.getElementById('map').innerHTML,
      clean=h.indexOf('opacity=".075"')<0 && h.indexOf('fill="#57c9a0" opacity=".10"')<0,
      tag=document.getElementById('maptools').innerHTML.indexOf('复盘')>=0,
      sum=document.getElementById('fxsummary').innerHTML.indexOf('复盘')>=0;
    fxStep(-1);const t2=S.fx.viewTurn;
    fxLive();return {all,t0,t,ev,t2,trail,clean,tag,sum,live:S.fx.viewTurn}})()`);
  check('复盘时间轴可逐时段步进并返回实时',
    R.t0 === null && R.t > 0 && R.t2 === R.t - 1 && R.live === null && R.trail > 0, JSON.stringify(R));
  check('复盘读取该时段事件且隐藏实时派生要素',
    R.ev > 0 && R.clean && R.tag && R.sum, JSON.stringify(R));
  const anim = get(c, `(()=>{const a=document.getElementById('map').innerHTML.indexOf('fx-anim')>=0;
    fxToggleAnim();const b=document.getElementById('map').innerHTML.indexOf('fx-static')>=0;
    fxToggleAnim();return {a,b,back:document.getElementById('map').innerHTML.indexOf('fx-anim')>=0}})()`);
  check('动画开关切换 SVG 动/静态类', anim.a && anim.b && anim.back, JSON.stringify(anim));
  const sum = get(c, `(()=>{renderFxSummary();return document.getElementById('fxsummary').innerHTML})()`);
  check('态势摘要卡聚合事件计数与战果数值',
    sum.indexOf('态势事件') >= 0 && sum.indexOf('歼敌进度') >= 0 && sum.indexOf('战役分') >= 0);

  for (let si = 0; si < 3; si++) {
    const cc = makeCtx(); run(cc, 'start(' + si + ')');
    for (let i = 0; i < 5; i++) { if (get(cc, 'S.over')) break; run(cc, 'endTurn()'); }
    const out = get(cc, `(()=>{const o=[];for(let z=0;z<3;z++){S.view.z=z;renderAll();
      const h=document.getElementById('map').innerHTML;
      o.push({bad:/NaN|undefined|Infinity/.test(h),polys:(h.match(/<polygon/g)||[]).length});}
      S.view.z=0;return {o,hist:S.fx.history.length,ok:S.enemies.every(foeBookOK)}})()`);
    check('剧本 ' + si + ' 三级态势渲染无异常坐标、无 2.5D 立体块、敌账目守恒',
      out.o.every(x => !x.bad && x.polys === 0) && out.hist > 0 && out.ok,
      JSON.stringify(out.o));
  }
  check('主游戏仍零外部脚本 / 无第三方瓦片',
    !/<script[^>]+src="https?:/i.test(full) && !/googleapis|openstreetmap|mapbox|tile\./i.test(full));
}



// 11. v1.0 指挥所作战台：HUD 化面板与交互一致性
console.log('[11] 指挥台 UI：仪表 / 指令卡 / 通信台 / 纸带战报');
{
  const full = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  check('编号模块铭牌与 HUD 视觉系统',
    full.indexOf('counter-reset:mod') >= 0 && full.indexOf('.panel::before') >= 0 &&
    full.indexOf('.cmd-ico') >= 0 && full.indexOf('.commpad') >= 0 && full.indexOf('.logbox') >= 0);
  check('游戏化组件样式齐备（指令卡 / 单位卡 / 回执 / 敌情卡 / 简报仪表）',
    ['cmd-cost','tn-n','mbar','rc-t','foecard','bcg','turnbar','chip'].every(k => full.indexOf(k) >= 0));
  check('无外部资源且保留 reduced-motion 降级',
    !/<link[^>]+href="https?:/i.test(full) && !/@import\s+url\(/i.test(full) &&
    full.indexOf('prefers-reduced-motion') >= 0);
  check('桌面三栏与移动端抽屉规则未被破坏',
    full.indexOf('grid-template-columns:274px minmax(520px,1fr) 318px') >= 0 &&
    full.indexOf('@media(max-width:900px)') >= 0 && full.indexOf('.msheet-open') >= 0 &&
    full.indexOf('min-height:44px') >= 0);
  check('DOM：通信台 / 顶栏按钮组 / 图例与地理说明按需展开',
    full.indexOf('id="commpanel"') >= 0 && full.indexOf('class="comm-native"') >= 0 &&
    full.indexOf('class="topbtns"') >= 0 && full.indexOf('class="legendfold"') >= 0 &&
    full.indexOf('class="geonotefold"') >= 0);
  check('通信台五键等宽与视口宽度兜底',
    full.indexOf('repeat(5,minmax(0,1fr))!important') >= 0 &&
    full.indexOf('width:100vw!important') >= 0);

  const c = makeCtx(); run(c, 'start(0)');
  const pad = get(c, "(()=>{const h=document.getElementById('commpanel').innerHTML;return {keys:(h.match(/class=\"commkey/g)||[]).length,on:(h.match(/class=\"commkey on/g)||[]).length,def:document.getElementById('comm').value}})()");
  check('通信台渲染 5 个实体按键且默认选中电台',
    pad.keys === 5 && pad.on === 1 && pad.def === 'radio', JSON.stringify(pad));
  run(c, "pickComm('phone')");
  const picked = get(c, "(()=>{const h=document.getElementById('commpanel').innerHTML;return {v:document.getElementById('comm').value,onPhone:/class=\"commkey on\"[^>]*onclick=\"pickComm\\('phone'\\)/.test(h),ready:S._commReady}})()");
  check('切换通信方式只改取值容器，不破坏命令逻辑',
    picked.v === 'phone' && picked.onPhone && picked.ready === true, JSON.stringify(picked));
  run(c, "S.selected='r1';renderAll()");
  const cmd = get(c, "document.getElementById('cmdpanel').innerHTML");
  check('师级命令变为带图标 / 说明 / 代价角标的指令卡',
    (cmd.match(/cmd-ico/g) || []).length >= 8 && (cmd.match(/cmd-cost/g) || []).length >= 8 &&
    cmd.indexOf('进攻 / 总攻') >= 0);
  const tree = get(c, "document.getElementById('tree').innerHTML");
  check('编制树变为带军标 / 兵力条 / 状态灯的单位卡',
    (tree.match(/class="mini"/g) || []).length >= 4 &&
    (tree.match(/class="mbar"/g) || []).length >= 4 &&
    (tree.match(/class="lamp/g) || []).length >= 4);
  const foe = get(c, "document.getElementById('enemylist').innerHTML");
  check('敌情通报改为逐单位侦知情报卡（含等级与最后确认）',
    foe.indexOf('foecard') >= 0 && foe.indexOf('侦知') >= 0 && foe.indexOf('最后确认') >= 0);
  const chips = get(c, "document.getElementById('chips').innerHTML");
  check('顶栏仪表含推演进度条', chips.indexOf('turnbar') >= 0 && chips.indexOf('--fill:') >= 0);
  const brief = get(c, "document.getElementById('prompt').innerHTML");
  check('当前指示变为四格仪表任务简报',
    (brief.match(/class="bcg"/g) || []).length === 4 && brief.indexOf('本时段剩余参谋作业量') >= 0);
  const log = get(c, "document.getElementById('log').innerHTML");
  check('战报为带独立时间标签的电报纸带', log.indexOf('class="t"') >= 0);
  run(c, "S.treeSel='r1-1';renderCmd()");
  const cmdB = get(c, "document.getElementById('cmdpanel').innerHTML");
  run(c, "S.treeSel='r1-1-1';renderCmd()");
  const cmdC = get(c, "document.getElementById('cmdpanel').innerHTML");
  check('营 / 连命令集仍按层级自动切换（文案未受改造影响）',
    cmdB.indexOf('预备队') >= 0 && cmdB.indexOf('近迫作业') < 0 && cmdC.indexOf('近迫作业') >= 0);
  const e2e = makeCtx(); run(e2e, 'start(2)');
  for (let i = 0; i < 26; i++) {
    if (get(e2e, 'S.over')) break;
    run(e2e, `(function(){
      const alive=S.enemies.filter(e=>e.alive&&e.active);
      if(!alive.length)return;
      for(const id of ['r1','r2','r3']){
        const u=byId(id); if(!u||!u.alive)continue;
        let best=alive[0],bd=99;
        for(const e of alive){const d=dist(u,e);if(d<bd){bd=d;best=e;}}
        S.selected=id; issueOrder('attack','phone',{x:best.x,y:best.y});
      }
      S.selected='arty'; issueOrder('artillery','phone',{x:alive[0].x,y:alive[0].y});
      if(S.turn%3===0) reportSituation();
    })();`);
    run(e2e, 'if(!S.over) endTurn()');
  }
  const fin = get(e2e, '({over:S.over,score:S.result&&S.result.score,ok:S.pieces.filter(p=>p.kind==="regiment").every(subBookOK)})');
  check('端到端推演结论与兵力守恒不变', fin.over && fin.score >= 52 && fin.ok,
    fin.score + ' 分 · 守恒 ' + fin.ok);
}



// 12. v1.1 情报不对称与敌方指挥（OPFOR C2）
console.log('[12] 战争迷雾 / 敌方 OODA 指挥 / 攻防对称');
{
  const full = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  check('敌方决心渲染已彻底移除（无动向箭头 / 无任务名泄漏）',
    full.indexOf('/* 4) 敌预期动向') < 0 && full.indexOf('敌动向', full.indexOf('function renderRoutes')) < 0 &&
    full.indexOf('敌方 goal / task / 命令队列属对手决心') >= 0);
  check('情报层与敌方指挥层模块齐备',
    ['INTEL_LV','foeReportPos','intelDecay','foeEstimate','FOE_TASKS','foeUtility',
     'foeCommandPhase','foeInitiative','foeC2'].every(k => full.indexOf(k) >= 0));
  check('敌方十类任务与我方攻防 / 侦察 / 支援 / 撤退 / 工事对称',
    ['scout','main','support','pin','flank','fortify','prep','ambush','assist','withdraw']
      .every(k => full.indexOf(k+':') >= 0));

  const c = makeCtx(); run(c, 'start(0)');
  const init = get(c, '({lv:Object.values(S.foeIntel).map(q=>q.lvl),view:Object.values(S.foeView).map(v=>v.lvl),orders:S.foeOrders.length})');
  check('开局：已入场敌军仅概略通报、未抵达增援完全未侦知',
    init.lv[0] === 2 && init.lv[init.lv.length-1] === 0 && init.view.every(v => v === 1),
    JSON.stringify(init));
  const gain = get(c, "(()=>{const e=S.enemies[0];const b=foeLvl(e);intelGain('recon',e.x,e.y,2);return {b,a:foeLvl(e),src:S.foeIntel[e.id].src}})()");
  check('侦察提升逐单位情报等级并记录来源', gain.a > gain.b && gain.src.length > 0, JSON.stringify(gain));
  const decay = get(c, "(()=>{const e=S.enemies[1];S.foeIntel[e.id].lvl=3;S.foeIntel[e.id].last=S.turn-3;S.foeIntel[e.id].age=1;intelDecay();return {lvl:foeLvl(e),src:S.foeIntel[e.id].src}})()");
  check('未刷新情报随时段降级', decay.lvl === 2 && decay.src === '情报过时', JSON.stringify(decay));
  const stale = get(c, "(()=>{const e=S.enemies[2];S.foeIntel[e.id].lvl=2;S.foeIntel[e.id].seen={x:1,y:1,turn:0};const p=foeReportPos(e);return {pos:[p.x,p.y],stale:p.stale,real:[e.x,e.y]}})()");
  check('概略情报只报最后确认位置，不报真实位置',
    stale.pos[0] === 1 && stale.pos[1] === 1 && stale.stale > 0 && stale.pos[0] !== stale.real[0],
    JSON.stringify(stale));
  const blind = get(c, "(()=>{const r=byId('r1');r.x=7;r.y=7;S.foeView.r1={lvl:1,seen:{x:2,y:3,turn:1}};const e=foeEstimate('r1');return {est:[e.x,e.y],real:[r.x,r.y]}})()");
  check('敌方不窥屏：只按自己的不完整情报估计我方位置',
    blind.est[0] === 2 && blind.est[0] !== blind.real[0], JSON.stringify(blind));

  const ai = makeCtx(); run(ai, 'start(2)');
  run(ai, 'foeDecide()');
  const ord = get(ai, '({n:S.foeOrders.length,delay:S.foeOrders.map(o=>o.arrive-S.turn),tasks:S.foeOrders.map(o=>o.task),valid:S.foeOrders.every(o=>!!FOE_TASKS[o.task])})');
  check('敌方 OODA 生成决心队列并经指挥延迟生效',
    ord.n > 0 && ord.delay.every(d => d >= 1) && ord.valid, JSON.stringify(ord));
  const util = get(ai, "(()=>{const e=S.enemies[0],ctx=foeContext(e);return {main:foeUtility(e,'main',ctx),fortify:foeUtility(e,'fortify',ctx),all:Object.keys(FOE_TASKS).every(k=>{const u=foeUtility(e,k,ctx);return u>=0&&u<=1.2})}})()");
  check('效用评分为每个任务产出有限分数', util.all && util.main > 0 && util.fortify > 0, JSON.stringify(util));
  const fort = get(ai, "(()=>{const e=S.enemies.find(x=>x.alive&&x.active);e.task='fortify';const b=e.entrench;foeExecute(e);return {b,a:e.entrench}})()");
  check('敌方会构筑工事（对称于我方近迫 / 筑垒）', fort.a > fort.b, JSON.stringify(fort));
  const prep = get(ai, "(()=>{const e=S.enemies.find(x=>x.alive&&x.active);e.task='prep';foeExecute(e);return {n:Object.keys(S.foePrep).length,ammo:e.ammo}})()");
  check('敌方会实施火力准备并消耗弹药', prep.n > 0 && prep.ammo < 90, JSON.stringify(prep));

  const fi = makeCtx(); run(fi, 'start(1)');
  run(fi, "(()=>{const e=S.enemies.find(x=>x.alive&&x.active);const r=byId('r1');r.x=e.x;r.y=Math.min(H-1,e.y+1);r.order={type:'hold'};e.task='main';S.stats.ownLoss=0;})()");
  run(fi, 'foeInitiative()');
  check('我方不主动攻击时敌人仍会反冲击',
    get(fi, 'S.stats.ownLoss') > 0 && get(fi, 'S.logs.some(l=>l.t.indexOf("敌反冲击")>=0)'),
    '我方伤亡 ' + get(fi, 'S.stats.ownLoss'));
  const withdraw = get(fi, "(()=>{const e=S.enemies[0];e.men=Math.round(e.men0*0.3);e.morale=25;const ctx=foeContext(e);return {w:foeUtility(e,'withdraw',ctx),m:foeUtility(e,'main',ctx)}})()");
  check('敌残部会决心有序转进而非凭空消失', withdraw.w > withdraw.m, JSON.stringify(withdraw));
  const assist = get(fi, "(()=>{const a=S.enemies[0],b=S.enemies.find(x=>x!==a&&x.alive&&x.active);b.men=Math.round(b.men0*0.5);const ctx=foeContext(a);return {ally:ctx.ally,u:foeUtility(a,'assist',ctx)}})()");
  check('友邻受威胁时敌方会考虑增援靠拢', assist.ally && assist.u > 0.3, JSON.stringify(assist));

  const vis = makeCtx(); run(vis, 'start(0)');
  run(vis, "(()=>{for(const id in S.foeIntel){S.foeIntel[id].lvl=0;}})()");
  const hid = get(vis, "(()=>{renderAll();const h=document.getElementById('enemylist').innerHTML;return {unknown:h.indexOf('处敌情未侦知')>=0,units:renderUnits(0,1).indexOf('敌情?')<0,routes:renderRoutes(0,1).indexOf('#dc6d60')<0}})()");
  check('未侦知敌军不出现在地图 / 路线 / 标号牌', hid.unknown && hid.units && hid.routes, JSON.stringify(hid));
  run(vis, "(()=>{for(const id in S.foeIntel){S.foeIntel[id].lvl=3;}})()");
  const exposed = get(vis, "(()=>{renderAll();return {men:document.getElementById('enemylist').innerHTML.indexOf('人')>=0,pos:document.getElementById('enemylist').innerHTML.indexOf('即时确认')>=0}})()");
  check('确实情报才显示精确兵力与即时位置', exposed.men && exposed.pos, JSON.stringify(exposed));
  const leak = get(vis, "(()=>{renderAll();const ids=['map','maptools','mapinfo','enemylist','queue','log','prompt','chips','legend','fxsummary'];const bad=['主攻突击','迂回穿插','固守筑垒','设伏反冲击','增援友邻','转进突围','敌动向','敌预期动向'];const out=[];for(const id of ids){const h=document.getElementById(id).innerHTML;for(const w of bad)if(h.indexOf(w)>=0)out.push(id+':'+w);}return out})()");
  check('敌方决心零泄漏（10 个可见面板逐项审计）', leak.length === 0, JSON.stringify(leak));

  const e2e = makeCtx(); run(e2e, 'start(2)');
  for (let i = 0; i < 26; i++) {
    if (get(e2e, 'S.over')) break;
    run(e2e, `(function(){
      const alive=S.enemies.filter(e=>e.alive&&e.active&&foeSeen(e));
      if(!alive.length)return;
      for(const id of ['r1','r2','r3']){
        const u=byId(id); if(!u||!u.alive)continue;
        let best=alive[0],bd=99;
        for(const e of alive){const d=dist(u,e);if(d<bd){bd=d;best=e;}}
        S.selected=id; issueOrder('attack','phone',{x:best.x,y:best.y});
      }
      S.selected='arty'; issueOrder('artillery','phone',{x:alive[0].x,y:alive[0].y});
      if(S.turn%3===0) reportSituation();
    })();`);
    run(e2e, 'if(!S.over) endTurn()');
  }
  const fin = get(e2e, '({over:S.over,score:S.result&&S.result.score,ok:S.pieces.filter(p=>p.kind==="regiment").every(subBookOK),foeOrders:S.foeOrders.length})');
  check('端到端可达成战役意图且全程兵力守恒',
    fin.over && fin.score >= 52 && fin.ok && fin.foeOrders > 0, JSON.stringify(fin));
}


// 13. v1.2 团/营/连分级兵要地志、军用地形图式与敌我展示方式
console.log('[13] 团 / 营 / 连分级地名、地形地貌与敌我展示');
{
  const c = makeCtx(); run(c, 'start(0)');
  const meta = get(c, `(()=>{
    const ids=Object.keys(CARTO), out={};
    ids.forEach(k=>{ const L=CARTO[k], g=GEO[k];
      out[k]={n:L.length, lv:[1,2,3].map(v=>L.filter(o=>o.lv===v).length),
        kindOk:L.every(o=>!!CARTO_KIND[o.t] && o.lv>=1 && o.lv<=3),
        srcOk:L.every(o=>!!o.src && !!o.n && typeof o.lon==='number' && typeof o.lat==='number'),
        inBox:L.every(o=>o.lon>=g.bbox.lon0&&o.lon<=g.bbox.lon1&&o.lat>=g.bbox.lat0&&o.lat<=g.bbox.lat1),
        exact:L.filter(o=>o.exact).length, elev:L.filter(o=>o.e!==undefined).length,
        unitName:L.filter(o=>/\d+\s*(师|旅|团|营|连)|纵队|整编|第\s?\d+\s?军/.test(o.n)).length};
    });
    return {ids,out,zooms:ZOOMS.map(z=>({k:z.k,map:z.map,ci:z.ci,carto:z.carto})),
      kinds:Object.keys(CARTO_KIND).length};
  })()`);
  check('三战区均建团 / 营 / 连三级应标要素', meta.ids.length===3 && meta.ids.every(k=>meta.out[k].n>=20),
    meta.ids.map(k=>k+':'+meta.out[k].n).join(' / '));
  check('每战区 lv1 / lv2 / lv3 三级均有条目',
    meta.ids.every(k=>meta.out[k].lv.every(n=>n>=5)), JSON.stringify(meta.out.menglianggu.lv));
  check('逐条带史料依据、合法类别且在图幅包围盒内',
    meta.ids.every(k=>meta.out[k].kindOk && meta.out[k].srcOk && meta.out[k].inBox));
  check('分级地名词库不含任何敌我部队番号（只标地形地名）',
    meta.ids.every(k=>meta.out[k].unitName===0));
  check('实测坐标与方位示意坐标严格区分', meta.out.menglianggu.exact>=8 &&
    meta.out.menglianggu.exact<meta.out.menglianggu.n, meta.out.menglianggu.exact+' 条实测');
  check('编号高地 / 主峰带高程点', meta.out.menglianggu.elev>=8,
    meta.out.menglianggu.elev+' 个高程点');
  check('四级比例尺均标注等效军用地形图与图式等高距',
    meta.zooms.length===4 && meta.zooms.every(z=>z.map&&z.ci>0&&z.carto) &&
    meta.zooms.map(z=>z.ci).join(',')==='40,10,5,2.5');
  check('四色制图图式覆盖居民地 / 山 / 水系 / 植被 / 地貌 / 工事', meta.kinds===8);

  const names = get(c, "CARTO.menglianggu.map(o=>o.n)");
  check('孟良崮真实编号高地与山水名齐备',
    ['520高地','西540高地','东540高地','570（史称600）高地','330高地','285高地',
     '芦山','雕窝','汶河','垛庄','坦埠','孟良崮主峰','大崮顶（大庵顶）','万泉山']
      .every(n=>names.indexOf(n)>=0));
  const anchor = get(c, `(()=>{const a=CARTO.menglianggu.find(o=>o.n==='孟良崮主峰'),
     b=GEO.menglianggu.places.find(p=>p.n==='孟良崮');
     return {same:a.lon===b.lon&&a.lat===b.lat,e:a.e}})()`);
  check('主峰实测坐标与 GEO 真实经纬度完全一致且标高 536 m',
    anchor.same && anchor.e===536);

  const vis = get(c, '[0,1,2,3].map(z=>cartoVisible("menglianggu",z).length)');
  check('地名随团→营→连逐级展开，师级不显示细部',
    vis[0]===0 && vis[1]>0 && vis[2]>vis[1] && vis[3]>vis[2], vis.join(' → '));

  const rc = get(c, `(()=>{const out=[];
    for(let z=0;z<4;z++){
      S.view.z=z;S.view.cx=375;S.view.cy=310;
      const s=renderCartography(S.sc.geo,z,zoomU());
      out.push({z,len:s.length,bad:/NaN|undefined|Infinity/.test(s),
        hasHeight:s.indexOf('520')>=0,hasVillage:s.indexOf('面犁沟')>=0,
        hasRelief:s.indexOf('崮顶')>=0,white:(s.match(/#ffffff/g)||[]).length});
    }
    resetView();return out})()`);
  check('师级全景不渲染分级地志图层', rc[0].len===0);
  check('团 / 营 / 连级均产出分级注记且无异常坐标',
    rc.slice(1).every(o=>o.len>200&&!o.bad), rc.map(o=>o.len).join('/'));
  check('高程点以白色数字标注（参考态势图）', rc.slice(1).some(o=>o.white>0),
    rc.map(o=>o.white).join('/'));
  check('营级出现编号高地、连级出现崮顶等地貌细部',
    rc[2].hasHeight && rc[3].hasRelief,
    '营级520=' + rc[2].hasHeight + ' / 连级崮顶=' + rc[3].hasRelief);

  const rf = get(c, `(()=>{const a=[];for(let j=0;j<5;j++)for(let i=0;i<6;i++)
      a.push(reliefAt('menglianggu',120+i*90,60+j*80).n);
    return {a,uniq:Array.from(new Set(a)).length}})()`);
  check('连级派生地貌部位判读合法且能区分多种部位',
    rf.a.length===30 && rf.a.every(n=>typeof n==='string'&&n.length>0) && rf.uniq>=3,
    rf.uniq+' 种判读');

  const ci = get(c, `(()=>{const o=[];for(let z=1;z<=3;z++){
      S.view.z=z;S.view.cx=375;S.view.cy=310;
      const L=localContourLevels(S.sc.geo,z);o.push(L.length>1?L[1]-L[0]:0)}
    resetView();return o})()`);
  check('等高距随团→营→连逐级加密（20 / 10 / 5 m 示意）',
    ci[0]>ci[1] && ci[1]>ci[2], ci.join(' / ')+' m');

  const mine = get(c, `(()=>{S.view.z=1;const p=byId('r1');
    S.view.cx=(p.x+0.5)*CW;S.view.cy=(p.y+0.5)*CH;
    const s=renderControlZones(1,zoomU());resetView();return s.indexOf('#57c9a0')>=0})()`);
  check('我方实际控制区以半透明色块表达（已知事实）', mine);
  const cz = get(c, `(()=>{
    S.view.z=2;const e=S.enemies[0];
    S.view.cx=(e.x+0.5)*CW;S.view.cy=(e.y+0.5)*CH;
    const saved=S.enemies.map(x=>{const q=foeIntel(x.id);return q?q.lvl:0});
    const on=renderControlZones(2,zoomU());
    S.enemies.forEach(x=>{const q=foeIntel(x.id);if(q)q.lvl=0});
    const off=renderControlZones(2,zoomU());
    S.enemies.forEach((x,i)=>{const q=foeIntel(x.id);if(q)q.lvl=saved[i]});
    resetView();
    return {onFoe:on.indexOf('#f0937f')>=0,onTag:on.indexOf('已侦知敌控区')>=0,
      offFoe:off.indexOf('#f0937f')>=0,offTag:off.indexOf('已侦知敌控区')>=0,
      bad:/NaN|undefined|Infinity/.test(on+off)}})()`);
  check('敌控区色块仅在已侦知时出现，未侦知即完全消失',
    cz.onFoe && cz.onTag && !cz.offFoe && !cz.offTag && !cz.bad, JSON.stringify(cz));
  const leak = get(c, `(()=>{S.view.z=3;S.view.cx=375;S.view.cy=310;
    const s=renderCartography(S.sc.geo,3,zoomU())+renderControlZones(3,zoomU());
    resetView();return /主攻|迂回|固守筑垒|火力准备|设伏|增援友邻|有序转进|敌决心|敌任务/.test(s)})()`);
  check('分级地图层零敌方动向 / 决心泄漏', !leak);

  const ui = get(c, `(()=>{renderAll();const a=id=>document.getElementById(id).innerHTML;return {
    details:(a('places').match(/<details/g)||[]).length,
    lv:a('places').indexOf('团级 · 1:5 万')>=0&&a('places').indexOf('连级 · 1:1 万')>=0,
    tools:a('maptools').indexOf('本级应标')>=0&&a('maptools').indexOf('兵要地志')>=0,
    scale:a('scalebar').indexOf('等效')>=0,
    info:a('mapinfo').indexOf('分级注记')>=0,
    note:document.getElementById('geonote').textContent.indexOf('四级 viewBox')>=0}})()`);
  check('地名面板折叠列出团 / 营 / 连三级应标要素', ui.details===3 && ui.lv);
  check('工具栏 / 比例尺 / 情报卡 / 地理说明同步四级制图信息',
    ui.tools && ui.scale && ui.info && ui.note, JSON.stringify(ui));

  for (let si=0; si<3; si++) {
    const cx = makeCtx(); run(cx,'start('+si+')');
    const bad = get(cx, `(()=>{const o=[];for(let z=0;z<4;z++){
      S.view.z=z;S.view.cx=400;S.view.cy=240;renderMap();
      const h=document.getElementById('map').innerHTML;
      o.push(/NaN|undefined|Infinity/.test(h)||h.indexOf('<polygon')>=0)}
      resetView();return o})()`);
    check('剧本 '+si+' 四级地图含分级地志 / 控制区且无异常坐标、无 2.5D', bad.every(v=>!v));
  }
}


// 14. v1.3 分级阵地 / 分级行军路线 / 敌我态势 / 交互与 UI
console.log('[14] 分级阵地、分级路线、敌我态势与交互');
{
  const c = makeCtx(); run(c, 'start(0)');
  const defs = get(c, '({n:LAYER_DEFS.length,keys:LAYER_DEFS.map(l=>l.k),lens:Object.keys(LOD).map(k=>LOD[k].length)})');
  check('接触带 / 分级阵地 / 小地图三图层齐备且全部 LOD 为四级',
    defs.n === 22 && defs.keys.indexOf('front') >= 0 && defs.keys.indexOf('position') >= 0 &&
    defs.keys.indexOf('minimap') >= 0 && defs.lens.every(n => n === 4), defs.n + ' 个图层');

  const pos = get(c, `(()=>{
    const at=(z,cx,cy)=>{S.view.z=z;S.view.cx=cx;S.view.cy=cy;const s=renderPositions(z,zoomU());
      return {len:s.length,reg:s.indexOf('团防御地域')>=0,btn:s.indexOf('营支撑点')>=0,
        foe:s.indexOf('已侦知敌阵地')>=0,bad:/NaN|undefined|Infinity/.test(s)}};
    const r=byId('r1'), e=S.enemies[0];
    const o=[at(0,400,240),at(1,(r.x+0.5)*CW,(r.y+0.5)*CH),
             at(2,(r.x+0.5)*CW,(r.y+0.5)*CH),at(3,(r.x+0.5)*CW,(r.y+0.5)*CH),
             at(2,(e.x+0.5)*CW,(e.y+0.5)*CH)];
    resetView();return o})()`);
  check('师级不画阵地，团 / 营 / 连级逐级展开',
    pos[0].len === 0 && pos[1].reg && pos[2].btn && pos[3].len > 200 && pos.every(o => !o.bad),
    pos.map(o => o.len).join('/'));
  check('敌方阵地只在已侦知位置出现', pos[4].foe);
  const wk = get(c, `(()=>{const r=byId('r1');r.entrench=3;S.view.z=1;
    S.view.cx=(r.x+0.5)*CW;S.view.cy=(r.y+0.5)*CH;
    const a=renderPositions(1,zoomU());r.entrench=0;const b=renderPositions(1,zoomU());
    resetView();return {a:a.indexOf('工事 3 级')>=0,b:b.indexOf('工事 0 级')>=0}})()`);
  check('阵地工事等级直接读取实时状态（无第二事实源）', wk.a && wk.b);
  const hid = get(c, `(()=>{const e=S.enemies[0];S.view.z=2;
    S.view.cx=(e.x+0.5)*CW;S.view.cy=(e.y+0.5)*CH;
    const saved=S.enemies.map(x=>{const q=foeIntel(x.id);return q?q.lvl:0});
    const on=renderPositions(2,zoomU());
    S.enemies.forEach(x=>{const q=foeIntel(x.id);if(q)q.lvl=0});
    const off=renderPositions(2,zoomU());
    S.enemies.forEach((x,i)=>{const q=foeIntel(x.id);if(q)q.lvl=saved[i]});
    resetView();return {on:on.indexOf('已侦知敌阵地')>=0,off:off.indexOf('已侦知敌阵地')>=0}})()`);
  check('未侦知敌军阵地完全消失', hid.on && !hid.off, JSON.stringify(hid));

  const rt = get(c, `(()=>{const o=[];for(let z=0;z<4;z++){
    S.view.z=z;S.view.cx=333;S.view.cy=284;
    o.push({z,base:renderRoutes(z,zoomU()).length,sub:renderEchelonRoutes(z,zoomU()).length})}
    resetView();return o})()`);
  check('下半级路线只在营 / 连级展开',
    rt[0].sub === 0 && rt[1].sub === 0 && rt.every(o => o.base > 0),
    rt.map(o => o.z + ':' + o.sub).join(' '));
  check('分级路线常量与下半级目标换算齐备',
    get(c, 'POS_Z.length') === 4 &&
    get(c, 'typeof echelonTarget') === 'function' &&
    get(c, 'typeof renderEchelonRoutes') === 'function');
  const eo = get(c, `(()=>{const r=byId('r1');S.treeSel='r1-1';
    const ok=issueSubOrder('main','radio',{x:r.x,y:r.y,sx:2,sy:2});
    S.view.z=3;S.view.cx=(r.x+0.5)*CW;S.view.cy=(r.y+0.5)*CH;
    S.subOrders.forEach(o=>o.status='done');
    const s=renderEchelonRoutes(3,zoomU());resetView();
    return {ok,len:s.length,label:s.indexOf('主攻')>=0,bad:/NaN|undefined|Infinity/.test(s)}})()`);
  check('已传达的下级命令在连级画出带番号的路线',
    eo.ok && eo.len > 100 && eo.label && !eo.bad, JSON.stringify(eo));

  const fl = get(c, `(()=>{S.view.z=1;S.view.cx=333;S.view.cy=284;
    const on=renderFrontLine(1,zoomU());
    toggleLayer('front');const off=renderFrontLine(1,zoomU());
    resetLayers();resetView();
    return {on:on.indexOf('接触带')>=0,off:off.length===0,bad:/NaN|undefined|Infinity/.test(on)}})()`);
  check('接触带聚合线可独立开关', fl.on && fl.off && !fl.bad, JSON.stringify(fl));
  const cz = get(c, `(()=>{S.view.z=1;S.view.cx=333;S.view.cy=284;
    const s=renderControlZones(1,zoomU());resetView();
    return {edge:(s.match(/stroke="#89e6c0"/g)||[]).length,
      hatch:(s.match(/#7d9688/g)||[]).length}})()`);
  check('控制区补上外边界线与未侦知地幅斜纹', cz.edge > 0 && cz.hatch > 0, JSON.stringify(cz));

  const pr = get(c, `(()=>{const out={};for(const m of Object.keys(LAYER_PRESETS)){
    presetLayers(m);out[m]={preset:S.layers.preset,
      on:LAYER_PRESETS[m].on.every(k=>layerOn(k)),
      off:LAYER_PRESETS[m].off.every(k=>!layerOn(k))}}
    resetLayers();out.back=S.layers.preset===null&&layerOn('contour');return out})()`);
  check('战术 / 地形 / 情报三种视图一键切换且可恢复自动分级',
    ['tactic','terrain','intel'].every(m => pr[m].preset === m && pr[m].on && pr[m].off) && pr.back,
    JSON.stringify(pr.tactic));
  check('键盘快捷键已注册（零外部依赖）', get(c, 'typeof document.onkeydown') === 'function');
  const fp = get(c, `(()=>{focusCarto(1,0);
    const a={pf:!!S.placeFocus,n:S.placeFocus&&S.placeFocus.n,z:S.view.z,
      info:document.getElementById('mapinfo').innerHTML.indexOf('已定位')>=0,
      places:document.getElementById('places').innerHTML.indexOf('focusCarto(')>=0};
    clearPlaceFocus();a.cleared=S.placeFocus===null;return a})()`);
  check('地名面板条目可点击定位并展示史料依据',
    fp.pf && fp.info && fp.places && fp.cleared && fp.z >= 1, JSON.stringify(fp));
  const tip = get(c, `(()=>{const r=byId('r1');
    const a=cellTip(r.x,r.y), b=featureTip(r.x,r.y,0,0);
    return {works:a.indexOf('团防御地域')>=0,sub:b.indexOf('本级阵地')>=0,
      bad:/undefined|NaN/.test(a+b)}})()`);
  check('悬停提示补充阵地工事与本级阵地信息', tip.works && tip.sub && !tip.bad, JSON.stringify(tip));
  const ui = get(c, `(()=>{renderAll();const t=document.getElementById('maptools').innerHTML,
    lg=document.getElementById('legend').innerHTML;
    return {sum:t.indexOf('本级指挥摘要')>=0,keys:t.indexOf('右键地图弹快捷命令')>=0,
      preset:t.indexOf('战术视图')>=0,legend:lg.indexOf('分级阵地（v1.3）')>=0,
      route:lg.indexOf('分级路线与控制区（v1.3）')>=0}})()`);
  check('指挥摘要 / 交互提示 / 图层预设 / 新图例齐备',
    ui.sum && ui.keys && ui.preset && ui.legend && ui.route, JSON.stringify(ui));
  const leak = get(c, `(()=>{S.view.z=3;S.view.cx=333;S.view.cy=284;
    const s=renderPositions(3,zoomU())+renderFrontLine(3,zoomU())+
      renderEchelonRoutes(3,zoomU())+renderControlZones(3,zoomU());resetView();
    return /主攻突击|迂回穿插|固守筑垒|设伏反冲击|增援友邻|转进突围|敌动向|敌预期动向|敌决心|敌任务/.test(s)})()`);
  check('新增图层零敌方决心 / 动向泄漏', !leak);

  for (let si = 0; si < 3; si++) {
    const cx = makeCtx(); run(cx, 'start(' + si + ')');
    const bad = get(cx, `(()=>{const o=[];for(let z=0;z<4;z++){
      S.view.z=z;S.view.cx=400;S.view.cy=240;renderMap();
      const h=document.getElementById('map').innerHTML;
      o.push(/NaN|undefined|Infinity/.test(h)||h.indexOf('<polygon')>=0)}
      resetView();return o})()`);
    check('剧本 ' + si + ' 四级地图含阵地 / 路线 / 接触带且无异常坐标', bad.every(v => !v));
  }
  const e2e = makeCtx(); run(e2e, 'start(0)');
  for (let i = 0; i < 20; i++) run(e2e, 'if(!S.over) endTurn()');
  check('新增表现层不改变结算与兵力守恒',
    get(e2e, 'S.pieces.filter(p=>p.kind==="regiment").every(subBookOK)') === true);
}


// 15. v1.4 开场页与覆盖层响应式完整性（防止内容被视口裁切）
console.log('[15] 开场页与覆盖层响应式完整性');
{
  const full = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  check('覆盖层用 flex-start + margin:auto + 自身滚动，超高内容不再被裁',
    full.indexOf('align-items:flex-start') >= 0 &&
    full.indexOf('overflow-y:auto;overscroll-behavior:contain') >= 0 &&
    /\.ovcard\{[^}]*margin:auto/.test(full));
  check('开场命令夹三段式：标题 / 按钮常驻，长介绍独占滚动区',
    /\.startcard\{[^}]*display:flex;flex-direction:column;overflow:hidden/.test(full) &&
    full.indexOf('.startcard .ovhead,.startcard .ovfoot{flex:none}') >= 0 &&
    /\.startcard \.ovbody\{[^}]*min-height:0;overflow-y:auto/.test(full));
  check('开场副标题已同步到 v1.3（不残留旧版本号）',
    full.indexOf('v1.3 · 分级阵地 / 分级路线 / 交互优化') >= 0 &&
    full.indexOf('v1.1 · 情报与对等对手 · 教学向开放推演') < 0);
  check('剧目卡片自适应列 + 窄屏单列 + 按钮整行触控',
    full.indexOf('repeat(auto-fit,minmax(190px,1fr))') >= 0 &&
    /@media\(max-width:620px\)\{\s*\.scs\{grid-template-columns:1fr\}/.test(full) &&
    full.indexOf('.ovfoot button{flex:1 1 100%}') >= 0);
  check('视口高度规则都有 dvh 回退（移动端地址栏不变形）',
    (full.match(/100dvh/g) || []).length >= 4 && (full.match(/86dvh/g) || []).length >= 1);
  check('其余覆盖层（简报 / 背景 / 终局）沿用同一可滚动容器',
    (full.match(/class="ov"/g) || []).length >= 4);

  const c = makeCtx();
  const s = get(c, "(()=>{showStart();return document.getElementById('overlay').innerHTML})()");
  check('开场 DOM 含 ovhead / ovbody / ovfoot / 折叠说明',
    s.indexOf('ovcard startcard') >= 0 && s.indexOf('ovhead') >= 0 &&
    s.indexOf('ovbody') >= 0 && s.indexOf('ovfoot') >= 0 && s.indexOf('startmore') >= 0);
  /* DOM stub 不解析嵌套 innerHTML：剧目卡片要从 scs 节点自身读取 */
  const st = get(c, `(()=>{showStart();
    const o=document.getElementById('overlay').innerHTML, b=document.getElementById('scs').innerHTML;
    return {sc:(b.match(/class="sc /g)||[]).length,start:o.indexOf('start(curSC)')>=0,
      hist:o.indexOf('showHistory()')>=0,scs:o.indexOf('id="scs"')>=0}})()`);
  check('三个剧目卡片与两个开始按钮都在完整结构内',
    st.sc === 3 && st.start && st.hist && st.scs, JSON.stringify(st));
  const br = (s.match(/<br>/g) || []).length;
  check('长玩法说明默认折叠，首屏核心介绍精简',
    s.indexOf('<details class="startmore"><summary>') >= 0 && br < 20,
    br + ' 个换行');
  const picked = get(c, "(()=>{pickSC(2);const b=document.getElementById('scs').innerHTML;return {on:(b.match(/sc on/g)||[]).length,tail:b.indexOf('徐蚌')>=0}})()");
  check('切换剧目后选中态与卡片内容同步刷新', picked.on === 1 && picked.tail, JSON.stringify(picked));
  check('开场页零脚本依赖且按钮均可键盘聚焦',
    s.indexOf('<script') < 0 && s.indexOf('<button') >= 0);
}


// 16. v1.4 现代战略游戏地图交互
console.log('[16] 右键上下文命令 / 热键 / 悬停预览 / 小地图导航');
{
  const c = makeCtx(); run(c, 'start(0)');
  const fa = get(c, `(()=>{const e=S.enemies[0],rp=foeReportPos(e);
    const on=!!foeAtCell(rp.x,rp.y);
    const saved=Object.keys(S.foeIntel).map(k=>[k,S.foeIntel[k].lvl]);
    Object.keys(S.foeIntel).forEach(k=>S.foeIntel[k].lvl=0);
    const off=foeAtCell(rp.x,rp.y)===null;
    saved.forEach(([k,v])=>S.foeIntel[k].lvl=v);
    return {on,off}})()`);
  check('智能目标只识别已侦知敌，未侦知完全不参与', fa.on && fa.off, JSON.stringify(fa));
  const leak = get(c, `(()=>{const e=S.enemies.find(x=>x.id==='m4');
    S.logs.length=0;onCell(e.x,e.y);
    const h=document.getElementById('log').innerHTML;
    return {lvl:foeLvl(e),name:h.indexOf(e.name)>=0,gear:h.indexOf(e.equip)>=0,
      ent:h.indexOf('工事 '+e.entrench+' 级')>=0}})()`);
  check('点击未侦知敌真实格不再泄漏番号 / 装备 / 工事（修复原漏洞）',
    leak.lvl === 0 && !leak.name && !leak.gear && !leak.ent, JSON.stringify(leak));

  const menu = get(c, `(()=>{S.selected='r1';
    openCtxMenu({clientX:100,clientY:100,shiftKey:false},{x:5,y:5});
    const blank=document.getElementById('ctxmenu').innerHTML;
    const rp=foeReportPos(S.enemies[0]);
    openCtxMenu({clientX:100,clientY:100,shiftKey:false},{x:rp.x,y:rp.y});
    const foe=document.getElementById('ctxmenu').innerHTML;
    const opened=document.getElementById('ctxmenu').className;
    closeCtxMenu();
    const closed=document.getElementById('ctxmenu').className;
    return {blank:blank.indexOf('机动到此')>=0,foe:foe.indexOf('进攻该敌')>=0,
      head:foe.indexOf('已侦知敌情')>=0||foe.indexOf('整编')>=0,opened,closed}})()`);
  check('右键空格给机动、右键已侦知敌给进攻（上下文命令）',
    menu.blank && menu.foe && menu.head && menu.opened === 'ctxmenu on' && menu.closed === 'ctxmenu',
    JSON.stringify(menu));
  const unseen = get(c, `(()=>{const e=S.enemies.find(x=>x.id==='m4');S.selected='r1';
    openCtxMenu({clientX:100,clientY:100,shiftKey:false},{x:e.x,y:e.y});
    const h=document.getElementById('ctxmenu').innerHTML;
    closeCtxMenu();
    return {attack:h.indexOf('进攻该敌')>=0,terrain:h.indexOf('地形')>=0,
      leak:h.indexOf(e.name)>=0}})()`);
  check('右键未侦知位置只显示地形，绝不泄漏敌军',
    !unseen.attack && unseen.terrain && !unseen.leak, JSON.stringify(unseen));
  const qo = get(c, `(()=>{S.selected='r1';const n=S.orders.length;
    const ok=quickOrder('move',7,6,'phone');const o=S.orders[S.orders.length-1];
    return {ok,added:S.orders.length===n+1,type:o.type,x:o.target.x}})()`);
  check('右键命令复用既有 issueOrder 入队且不改结算',
    qo.ok && qo.added && qo.type === 'move' && qo.x === 7, JSON.stringify(qo));
  const hk = get(c, `(()=>{S.selected='r1';S.pending=null;
    cmdHotkey('attack');const a={on:!!S.pending,type:S.pending&&S.pending.type};
    cancelAllPending();cmdHotkey('wait');
    const b={on:!!S.pending,last:S.orders[S.orders.length-1].type};
    cancelAllPending();return {a,b}})()`);
  check('命令热键：需目标进入待指定、原地命令直接下达',
    hk.a.on && hk.a.type === 'attack' && !hk.b.on && hk.b.last === 'wait', JSON.stringify(hk));
  const esc = get(c, `(()=>{S.pending={type:'attack'};S.subPending='recon';S.deployTarget='r1-1';
    cancelAllPending();return {p:!S.pending,s:!S.subPending,d:!S.deployTarget}})()`);
  check('Esc 一次取消待令 / 下级待令 / 部署', esc.p && esc.s && esc.d);

  const hv = get(c, `(()=>{S.selected='r1';S.hover={x:7,y:5};
    const a=renderHoverFx(1,zoomU());
    const e=S.enemies.find(x=>x.id==='m4');S.hover={x:e.x,y:e.y};
    const b=renderHoverFx(1,zoomU());
    S.hover=null;const off=renderHoverFx(1,zoomU());
    return {len:a.length,box:a.indexOf('hoverfx')>=0,path:a.indexOf('<path')>=0,
      name:b.indexOf(e.name)>=0,off:off.length===0,bad:/NaN|undefined/.test(a+b)}})()`);
  check('悬停预览画出目标框与意图箭头，且不暴露未侦知敌名',
    hv.len > 200 && hv.box && hv.path && !hv.name && hv.off && !hv.bad, JSON.stringify(hv));
  const mm = get(c, `(()=>{S.view.z=1;S.view.cx=400;S.view.cy=240;
    const a=renderMiniMap(1,zoomU()), e=S.enemies.find(x=>x.id==='m4');
    const b=visibleBox(),u=zoomU(),mw=118*u,mh=71*u;
    const wx=b.x+b.w-mw/2-9*u, wy=b.y+b.h-mh/2-9*u;
    const hit=miniMapAt((wx-b.x)/b.w*800,(wy-b.y)/b.h*480,null), miss=miniMapAt(1,1,null);
    S.view.z=0;const hidden=renderMiniMap(0,zoomU());S.view.z=1;
    return {len:a.length,box:a.indexOf('data-mini')>=0,mine:a.indexOf('#57c9a0')>=0,
      foe:a.indexOf('#f0937f')>=0,leak:a.indexOf(e.name)>=0,
      hit:!!hit,x:hit&&Math.round(hit.x),y:hit&&Math.round(hit.y),miss:miss===null,
      hidden:hidden.length===0}})()`);
  check('小地图含缩略 / 我方 / 已侦知敌 / 视口框，未侦知敌不出现',
    mm.len > 800 && mm.box && mm.mine && mm.foe && !mm.leak, JSON.stringify(mm));
  check('小地图点击映射回世界坐标且师级隐藏',
    mm.hit && mm.x === 400 && mm.y === 240 && mm.miss && mm.hidden, JSON.stringify(mm));
  const rm = get(c, `(()=>{S.view.z=1;S.view.cx=400;S.view.cy=240;S.hover={x:7,y:5};
    renderMap();const h=document.getElementById('map').innerHTML;
    S.view.z=0;S.hover=null;
    return {hover:h.indexOf('hoverfx')>=0,mini:h.indexOf('data-mini')>=0,
      ctx:!!document.getElementById('ctxmenu'),bad:/NaN|undefined|Infinity/.test(h)}})()`);
  check('悬停预览与小地图已接入主渲染且无异常坐标',
    rm.hover && rm.mini && rm.ctx && !rm.bad, JSON.stringify(rm));

  for (let si = 0; si < 3; si++) {
    const cx = makeCtx(); run(cx, 'start(' + si + ')');
    const bad = get(cx, `(()=>{const o=[];for(let z=0;z<4;z++){
      S.view.z=z;S.view.cx=400;S.view.cy=240;S.hover={x:5,y:4};renderMap();
      const h=document.getElementById('map').innerHTML;
      o.push(/NaN|undefined|Infinity/.test(h)||h.indexOf('<polygon')>=0)}
      resetView();return o})()`);
    check('剧本 ' + si + ' 四级地图含交互图元且无异常坐标', bad.every(v => !v));
  }
  const e2e = makeCtx(); run(e2e, 'start(0)');
  for (let i = 0; i < 20; i++) run(e2e, 'if(!S.over) endTurn()');
  check('地图交互改造不改变结算与兵力守恒',
    get(e2e, 'S.pieces.filter(p=>p.kind==="regiment").every(subBookOK)') === true);
}


// 17. v1.4.1 地图选点不再误触发整片选中
console.log('[17] 地图选点与非误触');
{
  const full = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  check('桌面 / 移动统一禁用地图文本选中（旧规则仅 ≤900px）',
    /\.map\{cursor:crosshair;user-select:none;-webkit-user-select:none/.test(full) &&
    /\.geosvg text[^}]*user-select:none/.test(full) &&
    full.indexOf('.map::selection,.map *::selection{background:transparent') >= 0);
  check('命令热键过滤 Ctrl / Meta / Alt 系统快捷键',
    /if\(ev\.ctrlKey\|\|ev\.metaKey\|\|ev\.altKey\) return/.test(full));
  const c = makeCtx(); run(c, 'start(0)');
  const key = get(c, `(()=>{S.selected='r1';S.pending=null;const n=S.orders.length;
    let blocked=false;
    document.onkeydown({key:'a',ctrlKey:true,metaKey:false,altKey:false,
      target:{tagName:'BODY'},preventDefault(){blocked=true}});
    const ctrl={pending:!!S.pending,orders:S.orders.length===n,blocked};
    document.onkeydown({key:'a',ctrlKey:false,metaKey:false,altKey:false,
      target:{tagName:'BODY'},preventDefault(){}});
    const plain={pending:!!S.pending,type:S.pending&&S.pending.type};
    cancelAllPending();return {ctrl,plain}})()`);
  check('Ctrl+A 交还浏览器全选且不误下进攻令，普通 A 仍生效',
    !key.ctrl.pending && key.ctrl.orders && !key.ctrl.blocked &&
    key.plain.pending && key.plain.type === 'attack', JSON.stringify(key));
  const pd = get(c, `(()=>{const m=document.getElementById('map');let prevented=0;
    m.onpointerdown({pointerType:'mouse',button:0,pointerId:9,clientX:120,clientY:90,
      preventDefault(){prevented++}});
    m.onpointermove({pointerType:'mouse',pointerId:9,clientX:125,clientY:90});
    m.onpointerup({pointerType:'mouse',pointerId:9,clientX:125,clientY:90});
    return {prevented}})()`);
  check('鼠标按下阻断原生拖选且不破坏手势状态机', pd.prevented === 1, JSON.stringify(pd));
  const still = get(c, `(()=>{S.pending=null;S.selected='r1';
    const before=S.orders.length;
    quickOrder('wait',0,0,'radio');
    return {added:S.orders.length===before+1,bad:/NaN|undefined/.test(
      document.getElementById('map').innerHTML)}})()`);
  check('选点修复后命令仍可正常下达', still.added && !still.bad, JSON.stringify(still));
}


console.log('');
console.log(failed === 0 ? 'ALL PASS' : failed + ' CHECK(S) FAILED');
process.exit(failed === 0 ? 0 : 1);
