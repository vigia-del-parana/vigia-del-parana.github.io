/* Vigía del Paraná — app comunitaria, no oficial. Código abierto. */
(function(){
"use strict";
var REPO = "https://github.com/vigia-del-parana/vigia-del-parana.github.io";
var APORTES_URL = "https://script.google.com/macros/s/AKfycbyNFAWRS9io1DKh00aJ34yvv56rjYuYz_XBcNwHi1bpB0IfxkXDS0uecLGOKVff6k3sMQ/exec"; // receptor de aportes de vecinos (Google Apps Script, ver aportes/)
var APORTES_ACTIVO = true;  // false: solo visible con ?aportar=prueba (para pruebas)
var RESOLVER_URL = ""; // opcional: servicio que resuelve links cortos maps.app.goo.gl (ver README)
var COBERTURA_KM = 45;  // distancia máxima a una estación para considerar la ubicación cubierta
var HORIZONTE = 20;     // días de proyección de tendencia

var LVL = [{id:"normal",nombre:"Normal"},{id:"atencion",nombre:"Atención"},{id:"preparacion",nombre:"Preparación"},{id:"salida",nombre:"Salida"}];
var LEAD = {
  normal:"El río está en niveles normales para tu zona. No hay nada que hacer con apuro: es un buen momento para tener algunas cosas resueltas con tranquilidad.",
  atencion:"El río viene subiendo y se acerca a niveles que empiezan a importar en tu zona. Todavía hay tiempo de sobra; conviene ir preparando algunas cosas sin apuro.",
  preparacion:"El río está cerca del nivel de alerta de tu zona. Es momento de dejar todo listo, con calma, para que si hace falta salir no haya que improvisar.",
  salida:"El río llegó al nivel que en tu zona indica salir. Si tu casa está en un lugar bajo, lo más seguro es irte ahora, con calma, al lugar que ya tenías pensado."
};
var TODO = {
  normal:["Mirar el nivel una vez por día alcanza; esta app se actualiza a la mañana y a la tarde.","Tener documentos, títulos y recetas médicas juntos en una bolsa cerrada, en un lugar alto, ahorra apuros después.","Pensar a dónde irías si hiciera falta (un familiar, una escuela) y por qué camino, da tranquilidad.","Anotar el teléfono de la vecinal y de Defensa Civil de tu ciudad."],
  atencion:["Un bolso con ropa, cargadores, documentos y medicamentos, listo en un lugar a mano.","Si vivís cerca de un terraplén, vale la pena recorrerlo de vez en cuando: zanjas, partes hundidas o pozos son cosas para avisar a la vecinal o al municipio.","Pensar dónde irían los animales si hubiera que salir.","Conversar con vecinos mayores o que viven solos, para que sepan que el río viene subiendo.","Sumarse al grupo de la vecinal es la mejor forma de enterarse de los avisos."],
  preparacion:["Ir subiendo a lugares altos lo que se dañaría con agua: electrodomésticos, colchones, papeles, fotos.","Dejar el auto o la moto en un lugar alto.","Confirmar con la familia el lugar al que irían y cómo.","Tener agua potable guardada.","Mirar el terraplén más seguido; cualquier filtración se avisa al 103."],
  salida:["Salir con el bolso que ya tenés armado, sin cargar de más.","Cortar la luz y el gas antes de irte.","Avisar a la familia y a la vecinal que saliste y a dónde.","Evitar cruzar calles con agua en movimiento, a pie o en auto.","Si tenés vecinos mayores o con movilidad reducida, acompañarlos a salir."]
};

var $ = function(id){ return document.getElementById(id); };
var store = {
  get:function(k){ try{ var v=localStorage.getItem(k); return v?JSON.parse(v):null; }catch(e){ return null; } },
  set:function(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); return true; }catch(e){ return false; } },
  del:function(k){ try{ localStorage.removeItem(k); }catch(e){} }
};
var D = { est:null, zonas:null, alturas:null, ctx:null, modelo:null };
var state = { loc: store.get("vigia.loc"), zona:null, estacion:null };
var map=null, marker=null, mapPoint=null;

/* ---------- utilidades ---------- */
function fmt(n,d){ if(n==null||isNaN(n)) return "–"; return n.toLocaleString("es-AR",{minimumFractionDigits:d==null?2:d,maximumFractionDigits:d==null?2:d}); }
function cm(n){ if(n==null||isNaN(n)) return "–"; var v=Math.round(n*100); return (v>0?"+":"")+v+" cm"; }
function dateLabel(s){ var p=s.split("-"); return +p[2]+"/"+(+p[1]); }
function parseD(s){ var p=s.split("-"); return new Date(+p[0],+p[1]-1,+p[2]); }
function isoD(d){ return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
function daysBetween(a,b){ return Math.round((parseD(b)-parseD(a))/86400000); }
function todayStr(){ return isoD(new Date()); }
function levelOf(h,t){ if(h>=t.s) return 3; if(h>=t.p) return 2; if(h>=t.a) return 1; return 0; }
function slope(serie,n){
  var pts=serie.slice(-n); if(pts.length<3) return 0;
  var x0=pts[0][0],xs=[],ys=[]; pts.forEach(function(p){ xs.push(daysBetween(x0,p[0])); ys.push(p[1]); });
  var mx=xs.reduce(function(a,b){return a+b;},0)/xs.length, my=ys.reduce(function(a,b){return a+b;},0)/ys.length, num=0,den=0;
  for(var i=0;i<xs.length;i++){ num+=(xs[i]-mx)*(ys[i]-my); den+=(xs[i]-mx)*(xs[i]-mx); }
  return den?num/den:0;
}
function valueDaysAgo(serie,d){
  var last=serie[serie.length-1], target=parseD(last[0]).getTime()-d*86400000;
  for(var i=serie.length-1;i>=0;i--){ if(parseD(serie[i][0]).getTime()<=target) return serie[i][1]; }
  return null;
}
function svgEl(tag,attrs,text){ var el=document.createElementNS("http://www.w3.org/2000/svg",tag); for(var k in attrs) el.setAttribute(k,attrs[k]); if(text!=null) el.textContent=text; return el; }
function km(a,b){ var dx=(b[1]-a[1])*Math.cos(a[0]*Math.PI/180)*111.32, dy=(b[0]-a[0])*111.32; return Math.sqrt(dx*dx+dy*dy); }
function pointInRing(lng,lat,ring){ var inside=false; for(var i=0,j=ring.length-1;i<ring.length;j=i++){ var xi=ring[i][0],yi=ring[i][1],xj=ring[j][0],yj=ring[j][1]; if(((yi>lat)!==(yj>lat)) && (lng < (xj-xi)*(lat-yi)/(yj-yi)+xi)) inside=!inside; } return inside; }
function pointInFeature(lng,lat,f){ var g=f.geometry, polys=g.type==="Polygon"?[g.coordinates]:g.coordinates; for(var i=0;i<polys.length;i++){ if(pointInRing(lng,lat,polys[i][0])){ var hole=false; for(var h=1;h<polys[i].length;h++){ if(pointInRing(lng,lat,polys[i][h])) hole=true; } if(!hole) return true; } } return false; }
function estById(id){ for(var i=0;i<D.est.length;i++){ if(D.est[i].id===id) return D.est[i]; } return null; }
function serieOf(id){ if(!D.alturas) return null; for(var i=0;i<D.alturas.estaciones.length;i++){ if(D.alturas.estaciones[i].id===id) return D.alturas.estaciones[i].serie; } return null; }
function cityZone(e){ // zona genérica de una ciudad a partir de niveles oficiales
  var a=e.alerta, ev=e.evac;
  return {id:"ciudad-"+e.id, barrio:e.nombre, nombre:e.nombre, ref:"Niveles oficiales del INA para el puerto de "+e.nombre, estacion:e.id,
    umbrales:[+(a-1.0).toFixed(2), +(a-0.5).toFixed(2), a], generica:true,
    vigilar:"Esta app usa los niveles oficiales de alerta ("+fmt(a)+" m) y evacuación ("+fmt(ev)+" m) del puerto de "+e.nombre+". Tu municipio y Defensa Civil definen qué barrios se afectan primero: seguí sus avisos."};
}
// Línea aproximada del cauce principal del Paraná, de la confluencia con el Paraguay al delta [lng,lat].
// Sirve para no asignar a alguien un puerto de la otra orilla (por ejemplo, Coronda → Diamante).
var CAUCE=[[-58.62,-27.30],[-58.87,-27.47],[-58.90,-27.95],[-59.12,-28.50],[-59.40,-29.15],[-59.62,-30.00],[-59.75,-30.74],[-60.05,-31.20],[-60.15,-31.42],[-60.42,-31.56],[-60.55,-31.71],[-60.67,-32.05],[-60.72,-32.40],[-60.69,-32.75],[-60.61,-32.95],[-60.26,-33.24],[-60.17,-33.33],[-59.98,-33.48],[-59.62,-33.67],[-59.45,-33.80],[-59.20,-34.00],[-59.005,-34.090],[-58.950,-34.148],[-58.840,-34.230],[-58.733,-34.293],[-58.600,-34.296],[-58.544,-34.300],[-58.440,-34.320]];
function orilla(lat,lng){ // "izq" (Corrientes, Entre Ríos) o "der" (Chaco, Santa Fe, Buenos Aires); null al norte de la confluencia
  if(lat>-27.30) return null;
  var best=Infinity, cr=0;
  for(var i=0;i<CAUCE.length-1;i++){ var ax=CAUCE[i][0], ay=CAUCE[i][1], dx=CAUCE[i+1][0]-ax, dy=CAUCE[i+1][1]-ay;
    var t=Math.max(0,Math.min(1,((lng-ax)*dx+(lat-ay)*dy)/(dx*dx+dy*dy))), px=ax+t*dx, py=ay+t*dy, d2=(lng-px)*(lng-px)+(lat-py)*(lat-py);
    if(d2<best){ best=d2; cr=dx*(lat-ay)-dy*(lng-ax); } }
  return cr>0?"izq":"der";
}
function resolveZone(lat,lng){
  var fs=D.zonas.features;
  for(var i=0;i<fs.length;i++){ if(pointInFeature(lng,lat,fs[i])) return {zona:Object.assign({},fs[i].properties), km:0}; }
  var lado=orilla(lat,lng), best=null, bd=Infinity, bestS=null, bdS=Infinity;
  D.est.forEach(function(e){ var d=km([lat,lng],[e.lat,e.lng]); if(d<bd){ bd=d; best=e; }
    if(lado && orilla(e.lat,e.lng)===lado && d<bdS){ bdS=d; bestS=e; } });
  if(bestS && bdS<=COBERTURA_KM){ best=bestS; bd=bdS; } // preferir el puerto de la misma orilla
  if(bd>COBERTURA_KM) return {zona:null, km:bd, est:best};
  return {zona:cityZone(best), km:bd, est:best};
}
function altZones(lat,lng){ // alternativas cercanas para "No, elegir otra"
  var out=[]; D.zonas.features.forEach(function(f){ var c=f.geometry.coordinates[0][0][0]; out.push({z:f.properties, d:km([lat,lng],[c[1],c[0]])}); });
  out.sort(function(a,b){return a.d-b.d;}); var alts=out.filter(function(x){return x.d<15;}).slice(0,6).map(function(x){return x.z;});
  var near=[]; D.est.forEach(function(e){ near.push({e:e,d:km([lat,lng],[e.lat,e.lng])}); }); near.sort(function(a,b){return a.d-b.d;});
  near.slice(0,3).forEach(function(x){ alts.push(cityZone(x.e)); });
  return alts;
}

/* ---------- Proyección Vigía (método directo por horizonte, ver scripts/ajustar_modelo.py) ---------- */
function serieMap(id){ var s=serieOf(id); if(!s) return null; var m={}; s.forEach(function(p){ m[p[0]]=p[1]; }); return {m:m, last:s[s.length-1][0]}; }
function addDays(d,k){ return isoD(new Date(parseD(d).getTime()+k*86400000)); }
// cambio medido en la estación id entre t-hasta y t-desde; si a esa estación le falta el dato del día, corre las dos puntas hasta 2 días atrás
function cambioEntrada(id, t, desde, hasta){
  var u=serieMap(id); if(!u) return null;
  for(var off=0; off<=2; off++){ var a=u.m[addDays(t,-desde-off)], b=u.m[addDays(t,-hasta-off)]; if(a!=null&&b!=null) return a-b; }
  return null;
}
var PROJ_MEMO={};
function projectStation(estId){
  if(PROJ_MEMO.hasOwnProperty(estId)) return PROJ_MEMO[estId];
  var r=projectStationRaw(estId); PROJ_MEMO[estId]=r; return r;
}
function entradasTxt(M, estId){
  var nom=[]; (M&&M.entradas||[]).forEach(function(x){ if(x.id!==estId && nom.indexOf(x.nombre)<0) nom.push(x.nombre); });
  if(!nom.length) return "este mismo puerto";
  return nom.length>1? nom.slice(0,-1).join(", ")+" y "+nom[nom.length-1] : nom[0];
}
function projectStationRaw(estId){
  var M=D.modelo&&D.modelo.estaciones?D.modelo.estaciones[String(estId)]:null;
  if(!M||!M.w||!M.entradas) return null;
  var d=serieMap(estId); if(!d) return null;
  var t=d.last, h0=d.m[t]; if(h0==null) return null;
  var x=[];
  for(var i=0;i<M.entradas.length;i++){ var en=M.entradas[i], v=cambioEntrada(en.id,t,en.desde,en.hasta); if(v==null) return null; x.push(v); }
  // en días de crecida el error del método es mayor: se usa el medido en esas condiciones
  var h7=d.m[addDays(t,-7)], sube=!!(h7!=null && (h0-h7)>((D.modelo.sube_7d)||0.15) && M.err_sube);
  var errs=sube?M.err_sube:M.err, out=[];
  for(var k=1;k<=M.w.length;k++){
    var c=h0; for(var j=0;j<x.length;j++) c+=M.w[k-1][j]*x[j];
    var e=(errs&&errs[k-1]!=null)?errs[k-1]:(M.err&&M.err[k-1]!=null?M.err[k-1]:null);
    out.push({fecha:addDays(t,k), central:+c.toFixed(2), min:e!=null?+(c-e).toFixed(2):null, max:e!=null?+(c+e).toFixed(2):null, sube:sube});
  }
  return out.length?out:null;
}
// ¿El pronóstico del INA cae fuera de la banda de la Proyección Vigía? Devuelve el punto más alejado.
function divergenciaINA(proj, fcFuture){
  if(!proj||!fcFuture||!fcFuture.length) return null;
  var peor=null;
  fcFuture.forEach(function(f){ var p=null; proj.forEach(function(q){ if(q.fecha<=f.fecha) p=q; });
    if(!p||p.min==null||daysBetween(p.fecha,f.fecha)>2) return;
    var fuera = f.central>p.max ? f.central-p.max : f.central<p.min ? p.min-f.central : 0;
    if(fuera>0.05 && (!peor||fuera>peor.fuera)) peor={fuera:fuera, ina:f, vigia:p}; });
  return peor;
}

/* ---------- carga ---------- */
function load(){
  var v="?v="+Math.floor(Date.now()/600000);
  return Promise.all([
    fetch("data/estaciones.json"+v).then(function(r){return r.json();}),
    fetch("data/zonas.geojson"+v).then(function(r){return r.json();}),
    fetch("data/alturas.json"+v).then(function(r){return r.json();}).catch(function(){return null;}),
    fetch("data/contexto.json"+v).then(function(r){return r.json();}).catch(function(){return null;}),
    fetch("data/modelo.json"+v).then(function(r){return r.json();}).catch(function(){return null;})
  ]).then(function(r){ D.est=r[0].estaciones; D.zonas=r[1]; D.alturas=r[2]; D.ctx=r[3]; D.modelo=r[4]; });
}

/* ---------- ubicación ---------- */
function setLoc(loc){ state.loc=loc; store.set("vigia.loc",loc); }
function proposeZone(lat,lng,origen){
  var r=resolveZone(lat,lng);
  $("ubicMsg").textContent="";
  if(!r.zona){
    $("ubicMsg").className="msg err";
    $("ubicMsg").textContent="Ese punto queda a "+Math.round(r.km)+" km de "+r.est.nombre+", la estación más cercana. Por ahora la app cubre las ciudades sobre el Paraná y el Paraguay en Argentina.";
    return;
  }
  state.pending={lat:lat,lng:lng,zona:r.zona,origen:origen};
  $("confirmZona").textContent=zoneLabel(r.zona);
  $("confirmRef").textContent=(r.zona.generica?"Estación más cercana a "+Math.round(r.km)+" km. ":r.zona.estimada?"Zona estimada a partir de registros de crecidas anteriores, sin validación de vecinos todavía. ":"Zona estimada según el mapa de la Costa santafesina. ")+r.zona.ref;
  $("confirmAlt").hidden=true; $("confirmBox").hidden=false;
  $("confirmBox").scrollIntoView({behavior:"smooth",block:"nearest"});
}
function zoneLabel(z){ return z.generica?z.nombre:(z.barrio===z.nombre?z.barrio:z.barrio+" · "+z.nombre); }
function commitZone(z,lat,lng,origen){
  setLoc({lat:lat,lng:lng,zonaId:z.id,estacion:z.estacion,zona:z,origen:origen||null});
  $("confirmBox").hidden=true; $("ubicBody").hidden=true; $("cambiarUbic").hidden=false;
  render();
  $("estado").scrollIntoView({behavior:"smooth",block:"start"});
}
function currentZone(){
  if(!state.loc) return null;
  var z=null;
  if(state.loc.zonaId && state.loc.zonaId.indexOf("ciudad-")===0){ var e=estById(+state.loc.zonaId.slice(7)); if(e) z=cityZone(e); }
  else { D.zonas.features.forEach(function(f){ if(f.properties.id===state.loc.zonaId) z=Object.assign({},f.properties); }); }
  return z;
}
function gps(){
  var msg=$("ubicMsg");
  if(!navigator.geolocation){ msg.className="msg err"; msg.textContent="Este navegador no permite usar la ubicación. Probá con el mapa."; return; }
  msg.className="msg"; msg.textContent="Buscando tu ubicación…";
  navigator.geolocation.getCurrentPosition(function(p){
    proposeZone(p.coords.latitude,p.coords.longitude,"gps");
  },function(err){
    msg.className="msg err";
    msg.textContent = err.code===1 ? "No diste permiso para la ubicación. Podés marcar tu casa en el mapa o escribir tu dirección." : "No se pudo obtener la ubicación. Probá con el mapa o escribí tu dirección.";
  },{enableHighAccuracy:true,timeout:15000,maximumAge:60000});
}
function showMap(){
  $("mapaBox").hidden=false; $("textoBox").hidden=true;
  if(!map){
    var c = state.loc ? [state.loc.lat,state.loc.lng] : [-31.62,-60.60];
    map=L.map("mapa",{zoomControl:true}).setView(c, state.loc?14:11);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"&copy; OpenStreetMap"}).addTo(map);
    L.geoJSON(D.zonas,{style:function(){return {color:"#2C6B6E",weight:1,fillOpacity:.06};}}).addTo(map);
    D.est.forEach(function(e){ L.circleMarker([e.lat,e.lng],{radius:5,color:"#8A6A3D",fillOpacity:.9}).bindTooltip("Puerto de "+e.nombre).addTo(map); });
    map.on("click",function(ev){ mapPoint=[ev.latlng.lat,ev.latlng.lng]; if(marker) marker.setLatLng(ev.latlng); else marker=L.marker(ev.latlng).addTo(map); $("mapaOk").disabled=false; $("mapaInfo").textContent="Punto marcado."; });
  }
  setTimeout(function(){ map.invalidateSize(); },50);
}
function dms(deg,min,sec,hemi){ var v=+deg+(+min)/60+(+sec||0)/3600; return /[SWO]/i.test(hemi)?-v:v; }
function parseCoords(raw){
  var s=raw.replace(/−/g,"-");
  var m=s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/); if(m) return [parseFloat(m[1]),parseFloat(m[2])];
  m=s.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/); if(m) return [parseFloat(m[1]),parseFloat(m[2])];
  m=s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/); if(m) return [parseFloat(m[1]),parseFloat(m[2])];
  m=s.match(/(\d{1,2})\s*°\s*(\d{1,2})\s*['’′]\s*([\d.,]+)?\s*(?:["”″]|'')?\s*([NS])[\s,;]*(\d{1,3})\s*°\s*(\d{1,2})\s*['’′]\s*([\d.,]+)?\s*(?:["”″]|'')?\s*([EWO])/i);
  if(m) return [dms(m[1],m[2],(m[3]||"0").replace(",","."),m[4]), dms(m[5],m[6],(m[7]||"0").replace(",","."),m[8])];
  m=s.match(/(-?[23]\d[.,]\d+)\s*[,;\s]\s*(-?[56]\d[.,]\d+)/);
  if(m){ var la=parseFloat(m[1].replace(",",".")), lo=parseFloat(m[2].replace(",",".")); return [la>0?-la:la, lo>0?-lo:lo]; }
  return null;
}
function resolveShort(url){
  if(!RESOLVER_URL) return Promise.reject(new Error("sin resolver"));
  return fetch(RESOLVER_URL+"?u="+encodeURIComponent(url)).then(function(r){return r.json();}).then(function(j){ if(j&&j.lat&&j.lng) return [j.lat,j.lng]; throw new Error("sin coords"); });
}
function geocode(q){
  var u="https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=ar&viewbox=-61.5,-24.5,-53.5,-34.5&bounded=1&q="+encodeURIComponent(q);
  return fetch(u,{headers:{"Accept-Language":"es"}}).then(function(r){return r.json();}).then(function(j){ if(j&&j.length) return [parseFloat(j[0].lat),parseFloat(j[0].lon)]; throw new Error("no encontrado"); });
}
function fromText(){
  var raw=$("textoIn").value.trim(), msg=$("textoMsg");
  if(!raw){ msg.className="msg err"; msg.textContent="Escribí algo primero."; return; }
  var c=parseCoords(raw);
  if(c){ proposeZone(c[0],c[1],"texto"); msg.textContent=""; return; }
  msg.className="msg"; msg.textContent="Buscando…";
  var p = /goo\.gl|maps\.app/.test(raw) ? resolveShort(raw.match(/https?:\/\/\S+/)[0]).catch(function(){ throw new Error("corto"); }) : geocode(raw);
  p.then(function(c){ msg.textContent=""; proposeZone(c[0],c[1],"texto"); }).catch(function(e){
    msg.className="msg err";
    msg.textContent = e.message==="corto"
      ? "Ese es un link corto de Google Maps y no trae la ubicación. Abrilo, mantené apretado sobre el punto y copiá los números que aparecen arriba (empiezan con -). O usá «Usar mi ubicación» o el mapa."
      : "No encontré esa dirección. Probá con «Barrio, Ciudad» (por ejemplo «Colastiné Norte, Santa Fe») o marcá tu casa en el mapa.";
  });
}
function buildCityList(){
  var box=$("listaCiudades"); box.textContent="";
  var list=D.est.slice().sort(function(a,b){return a.orden-b.orden;});
  list.forEach(function(e){
    var b=document.createElement("button"); b.type="button"; b.className="zbtn"; b.setAttribute("role","radio");
    var n=document.createElement("b"); n.textContent=e.nombre; b.appendChild(n);
    var r=document.createElement("span"); r.textContent=e.provincia+" · río "+e.rio; b.appendChild(r);
    b.addEventListener("click",function(){ commitZone(cityZone(e),e.lat,e.lng); });
    box.appendChild(b);
  });
}

/* ---------- render ---------- */
function render(){
  var z=currentZone();
  $("ubicResumen").textContent = z ? zoneLabel(z) : "Elegí dónde estás para ver tu estado";
  $("cambiarUbic").hidden=!z;
  var hrs = D.alturas && D.alturas.actualizado ? (Date.now()-new Date(D.alturas.actualizado).getTime())/3600000 : null;
  var fr=$("fresh");
  if(hrs==null){ fr.textContent="Sin datos"; fr.className="chip stale"; }
  else { var when=new Date(D.alturas.actualizado).toLocaleString("es-AR",{day:"numeric",month:"numeric",hour:"2-digit",minute:"2-digit"}); fr.textContent=(hrs>36?"Datos viejos · ":"Actualizado ")+when; fr.className="chip"+(hrs>36?" stale":""); }
  if(D.ctx&&D.ctx.resumen) $("resumenFoot").textContent="Resumen del día: "+D.ctx.resumen;
  if(!z){ $("app").hidden=true; return; }
  $("app").hidden=false;
  var e=estById(z.estacion), serie=serieOf(z.estacion);
  var t={a:z.umbrales[0],p:z.umbrales[1],s:z.umbrales[2]};
  $("lblPuerto").textContent="Puerto de "+e.nombre+(z.generica?"":" · tu zona: "+z.nombre);
  if(!serie||!serie.length){
    $("hNow").innerHTML="–<span>m</span>"; $("hDelta").textContent="Todavía no hay mediciones cargadas para este puerto."; $("margen").textContent="";
    $("estado").className="status"; $("lvlName").textContent="Sin datos"; $("lvlTag").textContent="";
    $("lines").textContent=""; $("gauge").textContent=""; $("chart").textContent=""; renderTodo(0,z); renderUp(e); renderDams(); renderFc(z.estacion,e); renderNews(); renderAportes(z,e,null,null); return;
  }
  var last=serie[serie.length-1], h=last[1], sl=slope(serie,8), d1=valueDaysAgo(serie,1), d7=valueDaysAgo(serie,7);
  var lvlNow=levelOf(h,t);
  var fc=(D.ctx&&D.ctx.pronosticos&&D.ctx.pronosticos[String(z.estacion)])||null;
  var today=todayStr();
  var fcFuture=(fc&&fc.puntos?fc.puntos:[]).filter(function(p){return p.fecha>=today;});
  PROJ_MEMO={}; var proj=e.marea?null:projectStation(z.estacion);
  if(e.marea) sl=0;   // Delta inferior y Río de la Plata: la altura sigue a la marea y al viento, no a una tendencia
  var projPeak=proj?proj.reduce(function(m,p){return Math.max(m,p.central);},-Infinity):-Infinity;
  var peak=Math.max(proj?projPeak:h+Math.max(sl,0)*HORIZONTE, fcFuture.reduce(function(m,p){return Math.max(m,p.central);},-Infinity));
  var lvlOut=levelOf(peak,t);
  $("estado").className="status lvl-"+LVL[lvlNow].id;
  $("lvlName").textContent=LVL[lvlNow].nombre;
  $("lvlTag").textContent= lvlOut>lvlNow ? "Próximas "+HORIZONTE+" días: "+LVL[lvlOut].nombre : "Nivel actual";
  $("hNow").innerHTML=fmt(h)+"<span>m</span>";
  $("hDelta").textContent=cm(d1!=null?h-d1:null)+" en 24 h · "+cm(d7!=null?h-d7:null)+" en 7 días · dato del "+dateLabel(last[0]);
  var lines=[];
  var next=[["atención",t.a],["preparación",t.p],["salida",t.s]].filter(function(x){return x[1]>h;})[0];
  var mg=$("margen");
  if(next){ var faltan=Math.round((next[1]-h)*100); mg.className="margen "+(lvlNow===0?"ok":lvlNow===1?"":"alarm"); mg.textContent="Faltan "+faltan+" cm para "+next[0].charAt(0).toUpperCase()+next[0].slice(1)+" en tu zona ("+fmt(next[1])+" m)"; }
  else { mg.className="margen crit"; mg.textContent="Superó el umbral de salida de tu zona ("+fmt(t.s)+" m)"; }
  if(next && proj){
    var hit=null; proj.forEach(function(p){ if(!hit && p.central>=next[1]) hit=p; });
    var hitMax=null; proj.forEach(function(p){ if(!hitMax && p.max!=null && p.max>=next[1]) hitMax=p; });
    var ritmo=sl>0.003?"Sube unos "+Math.round(sl*100)+" cm por día. ":sl<-0.003?"Baja unos "+Math.abs(Math.round(sl*100))+" cm por día. ":"Está estable. ";
    if(hit) lines.push(ritmo+"Según la proyección, llegaría al umbral de "+next[0]+" ("+fmt(next[1])+" m) alrededor del "+dateLabel(hit.fecha)+".");
    else if(hitMax) lines.push(ritmo+"La proyección no llega al umbral de "+next[0]+" ("+fmt(next[1])+" m) en "+proj.length+" días, aunque en el escenario alto podría rozarlo hacia el "+dateLabel(hitMax.fecha)+".");
    else lines.push(ritmo+"La proyección a "+proj.length+" días no alcanza el umbral de "+next[0]+" ("+fmt(next[1])+" m).");
  } else if(next && e.marea){
    lines.push("En este puerto la altura depende sobre todo de la marea del Río de la Plata y del viento: con sudestada puede subir más de un metro en pocas horas. Por eso acá no se calcula tendencia ni Proyección Vigía. El próximo umbral es "+next[0]+" ("+fmt(next[1])+" m), "+Math.round((next[1]-h)*100)+" cm más arriba.");
  } else if(next){
    if(sl>0.003){ lines.push("Sube unos "+Math.round(sl*100)+" cm por día. Si sigue igual, llegaría al umbral de "+next[0]+" ("+fmt(next[1])+" m) en unos "+Math.round((next[1]-h)/sl)+" días."); }
    else if(sl<-0.003){ lines.push("Está bajando unos "+Math.abs(Math.round(sl*100))+" cm por día. El próximo umbral es "+next[0]+" ("+fmt(next[1])+" m)."); }
    else { lines.push("Está estable. El próximo umbral es "+next[0]+" ("+fmt(next[1])+" m), "+Math.round((next[1]-h)*100)+" cm más arriba."); }
  } else lines.push("El río superó el umbral de salida de tu zona ("+fmt(t.s)+" m).");
  if(proj){ var M=D.modelo.estaciones[String(z.estacion)], pl=proj[proj.length-1], pk=proj.reduce(function(m,p){return p.central>m.central?p:m;},proj[0]);
    lines.push("Proyección Vigía a "+proj.length+" días (según cómo viene el río en "+entradasTxt(M,z.estacion)+"): "+fmt(pk.central)+" m hacia el "+dateLabel(pk.fecha)+(pk.max!=null?" (entre "+fmt(pk.min)+" y "+fmt(pk.max)+")":"")+"."); }
  var dv=divergenciaINA(proj,fcFuture);
  if(dv) lines.push("Ojo: esta vez la Proyección Vigía y el pronóstico del INA no coinciden ("+fmt(dv.vigia.central)+" m contra "+fmt(dv.ina.central)+" m para el "+dateLabel(dv.ina.fecha)+"). Cuando difieren, seguí el del INA: usa modelos hidrológicos completos y el pronóstico de lluvias, que esta app no tiene.");
  lines.push("Niveles oficiales en "+e.nombre+": alerta "+fmt(e.alerta)+" m · evacuación "+fmt(e.evac)+" m.");
  if(fcFuture.length){ var fp=fcFuture[fcFuture.length-1]; lines.push("Pronóstico del INA para el "+dateLabel(fp.fecha)+": "+fmt(fp.central)+" m"+(fp.max!=null?" (hasta "+fmt(fp.max)+" m)":"")+"."); }
  var box=$("lines"); box.textContent=""; lines.forEach(function(s){ var p=document.createElement("p"); p.textContent=s; box.appendChild(p); });
  var best=null,bc=-Infinity;
  upstreamOf(e,8).forEach(function(up){ var us=serieOf(up.id); if(us&&us.length>7){ var c=us[us.length-1][1]-valueDaysAgo(us,7); if(c>bc){ bc=c; best=up; } } });
  if(best && !e.marea){ var sig=document.createElement("p"); sig.className="signal"+(bc>=0.3?"":" calm");
    sig.textContent = bc>=0.3 ? "Aguas arriba viene agua: "+best.nombre+" subió "+Math.round(bc*100)+" cm en 7 días. Ese pulso llega a tu ciudad días después." : "Aguas arriba sin cambios grandes: el puerto que más varió fue "+best.nombre+", "+cm(bc)+" en 7 días."; box.appendChild(sig); }
  drawGauge(h,t,e); drawChart(serie,fc,t,e.marea?null:sl,proj,dv);
  renderTodo(lvlNow,z); renderUp(e); renderDams(); renderFc(z.estacion,e); renderNews(); renderAportes(z,e,h,last[0]);
}
function upstreamOf(e,n){ return D.est.filter(function(x){return x.orden<e.orden;}).sort(function(a,b){return b.orden-a.orden;}).slice(0,n); }
function renderTodo(lvl,z){
  var key=LVL[lvl].id;
  $("actuarLead").textContent=LEAD[key];
  var ul=$("todo"); ul.textContent="";
  TODO[key].forEach(function(txt){ var li=document.createElement("li"); li.textContent=txt; ul.appendChild(li); });
  var vg=$("vigilar"); vg.textContent=""; var b=document.createElement("b"); b.textContent="Para conocer tu zona: "; vg.appendChild(b); vg.appendChild(document.createTextNode(z.vigilar)); if(z.estimada){ var es=document.createElement("span"); es.className="muted small"; es.textContent=" Zona armada con registros públicos de crecidas anteriores; si conocés el barrio y algo no cierra, avisanos."; vg.appendChild(es); }
}
function renderUp(e){
  var tb=$("upTable"); tb.textContent="";
  var list=D.est.slice().sort(function(a,b){return a.orden-b.orden;});
  var nAlerta=0, nEvac=0, nSube=0;
  list.forEach(function(x){ var s0=serieOf(x.id); if(!s0||!s0.length) return; var h0=s0[s0.length-1][1]; if(h0>=x.evac) nEvac++; else if(h0>=x.alerta) nAlerta++; var a7=valueDaysAgo(s0,7); if(a7!=null&&h0-a7>=0.3) nSube++; });
  var partes=[]; if(nEvac) partes.push(nEvac+(nEvac===1?" supera evacuación":" superan evacuación")); if(nAlerta) partes.push(nAlerta+(nAlerta===1?" supera alerta":" superan alerta")); if(nSube) partes.push(nSube+(nSube===1?" subió":" subieron")+" más de 30 cm en la semana");
  var cr=$("cuencaResumen"); if(cr) cr.textContent = partes.length ? partes.join(" · ") : "Sin puertos en alerta";
  var sumMain=document.querySelector("#cuencaBox .sum-main"); if(sumMain) sumMain.textContent="Ver los "+list.length+" puertos";
  list.forEach(function(x){
    var s=serieOf(x.id), tr=document.createElement("tr"); if(x.id===e.id) tr.className="here";
    tr.innerHTML="<td></td><td></td><td></td>"; var c=tr.children;
    var nm=document.createElement("span"); nm.textContent=x.nombre; c[0].appendChild(nm);
    var sm=document.createElement("span"); sm.className="st"; c[0].appendChild(sm);
    if(!s||!s.length){ sm.textContent="Sin datos todavía"; c[1].textContent="–"; tb.appendChild(tr); return; }
    var h=s[s.length-1][1], a1=valueDaysAgo(s,1), a7=valueDaysAgo(s,7), dd1=a1!=null?h-a1:null, dd7=a7!=null?h-a7:null, pct=Math.max(0,Math.min(1,h/x.alerta));
    var falta=x.alerta-h;
    sm.textContent = h>=x.evac?"Supera evacuación":h>=x.alerta?"Supera alerta":"Alerta en "+fmt(x.alerta)+" m";
    var lv=document.createElement("span"); lv.className="num lvl"; lv.textContent=fmt(h)+" m"; var st1=document.createElement("div"); st1.className="stack"; st1.appendChild(lv); c[1].appendChild(st1);
    var v1=document.createElement("span"); v1.className="num "+(dd1>0.005?"up":dd1<-0.005?"down":""); v1.textContent=cm(dd1); var l1=document.createElement("small"); l1.textContent=" 24 h"; v1.appendChild(l1);
    var v7=document.createElement("span"); v7.className="num "+(dd7>0.005?"up":dd7<-0.005?"down":""); v7.textContent=cm(dd7); var l7=document.createElement("small"); l7.textContent=" 7 d"; v7.appendChild(l7);
    var st2=document.createElement("div"); st2.className="stack"; st2.appendChild(v1); st2.appendChild(v7); c[2].appendChild(st2);
    var wrap=document.createElement("div"); wrap.className="falta";
    var txt=document.createElement("span"); txt.className="num"; txt.textContent= falta>0 ? "falta "+fmt(falta)+" m" : "alerta +"+fmt(-falta)+" m"; txt.title= falta>0 ? "Faltan "+fmt(falta)+" m para el nivel de alerta" : "Superó la alerta por "+fmt(-falta)+" m"; if(falta<=0.5) txt.classList.add("up"); wrap.appendChild(txt);
    var m=document.createElement("div"); m.className="meter"+(pct>=0.9?" hot":""); m.title=Math.round(pct*100)+"% del nivel de alerta"; var b=document.createElement("b"); b.style.width=(Math.min(1,pct)*100)+"%"; m.appendChild(b); wrap.appendChild(m);
    st1.appendChild(wrap);
    tb.appendChild(tr);
  });
}
function renderDams(){
  var box=$("dams"); box.textContent=""; var list=(D.ctx&&D.ctx.represas)||[];
  if(!list.length){ var p=document.createElement("p"); p.className="hint"; p.textContent="Sin información cargada."; box.appendChild(p); return; }
  list.forEach(function(r){
    var p=document.createElement("div"); p.className="card dam";
    var h=document.createElement("h3"); h.textContent=r.nombre; p.appendChild(h);
    if(r.estado){ var pl=document.createElement("span"); pl.className="pill"; pl.textContent=r.estado; p.appendChild(pl); }
    if(r.valor){ var v=document.createElement("div"); v.className="val num"; v.textContent=r.valor; if(r.unidad){ var sm=document.createElement("small"); sm.textContent=" "+r.unidad; v.appendChild(sm); } p.appendChild(v); }
    if(r.valorNota){ var vn=document.createElement("div"); vn.className="muted small"; vn.textContent=r.valorNota; p.appendChild(vn); }
    if(r.detalle){ var dt=document.createElement("p"); dt.textContent=r.detalle; p.appendChild(dt); }
    var src=document.createElement("div"); src.className="src"; src.textContent=(r.fecha?dateLabel(r.fecha)+" · ":"")+(r.fuente||"");
    if(r.url){ src.appendChild(document.createTextNode(" · ")); var a=document.createElement("a"); a.href=r.url; a.target="_blank"; a.rel="noopener"; a.textContent="ver fuente"; src.appendChild(a); }
    p.appendChild(src); box.appendChild(p);
  });
}
function renderFc(estId,e){
  var box=$("fc"); box.textContent=""; var fc=D.ctx&&D.ctx.pronosticos?D.ctx.pronosticos[String(estId)]:null;
  if(!fc||!fc.puntos||!fc.puntos.length){
    var INA_FC=[19,20,23,24,26,29,30,34,32,14];
    $("fcNote").textContent = e.marea
      ? "Para el Delta inferior y el Río de la Plata, el pronóstico de alturas lo elaboran el INA (sistema de pronóstico del Delta) y el Servicio de Hidrografía Naval, que emite los avisos de sudestada. Consultalos en sus sitios oficiales."
      : INA_FC.indexOf(estId)>=0
      ? "El INA publica pronóstico para "+e.nombre+" los martes y viernes; todavía no está cargado el último. Mientras tanto, guiate por la Proyección Vigía de arriba, que es una estimación propia y no oficial."
      : "El INA no publica un pronóstico puntual para "+e.nombre+". La Proyección Vigía de arriba es una estimación propia y no oficial.";
    return; }
  fc.puntos.forEach(function(p){
    var d=document.createElement("div"); d.className="day";
    var l=document.createElement("div"); l.className="eyebrow"; l.textContent=dateLabel(p.fecha); d.appendChild(l);
    var v=document.createElement("div"); v.className="v num"; v.textContent=fmt(p.central)+" m"; d.appendChild(v);
    var r=document.createElement("div"); r.className="muted small num"; r.textContent=(p.min!=null||p.max!=null)?"Rango: "+(p.min!=null?fmt(p.min):"?")+" a "+(p.max!=null?fmt(p.max):"?")+" m":"Valor central"; d.appendChild(r); box.appendChild(d);
  });
  $("fcNote").textContent="Puerto de "+e.nombre+" · emitido el "+(fc.emitido?dateLabel(fc.emitido):"?")+(fc.fuente?" · "+fc.fuente:"")+". "+(fc.nota||"");
}
function renderNews(){
  var ul=$("news"); ul.textContent=""; var list=(D.ctx&&D.ctx.noticias)||[];
  if(!list.length){ var li=document.createElement("li"); li.className="muted"; li.textContent="Sin noticias cargadas."; ul.appendChild(li); return; }
  list.forEach(function(n){
    var li=document.createElement("li"); var a=document.createElement("a"); a.href=n.url; a.target="_blank"; a.rel="noopener"; a.textContent=n.titulo; li.appendChild(a);
    if(n.resumen){ var p=document.createElement("p"); p.textContent=n.resumen; li.appendChild(p); }
    var s=document.createElement("span"); s.className="src"; s.textContent=(n.fuente||"")+(n.fecha?" · "+dateLabel(n.fecha):""); li.appendChild(s); ul.appendChild(li);
  });
}

/* ---------- gráficos ---------- */
function drawGauge(h,t,e){
  var max=Math.max(8, Math.ceil(e.evac+1)); if(e.evac>12) max=Math.ceil(e.evac*1.15);
  var W=112,H=330,top=14,bot=14,x0=46,w=26,min=0, y=function(v){ return top+(max-v)/(max-min)*(H-top-bot); };
  var svg=svgEl("svg",{viewBox:"0 0 "+W+" "+H,role:"img"}); svg.appendChild(svgEl("title",{},"Regla del puerto: "+fmt(h)+" m"));
  svg.appendChild(svgEl("rect",{x:x0,y:top,width:w,height:H-top-bot,rx:3,fill:"var(--bg)",stroke:"var(--line)"}));
  svg.appendChild(svgEl("rect",{x:x0,y:y(Math.max(h,0)),width:w,height:y(min)-y(Math.max(h,0)),fill:"var(--water)",opacity:.85}));
  var step=max>12?2:1;
  for(var v=0;v<=max+0.001;v+=step/2){ var whole=Math.abs(v/step-Math.round(v/step))<0.01;
    svg.appendChild(svgEl("line",{x1:x0,x2:x0+(whole?10:6),y1:y(v),y2:y(v),stroke:"var(--silt)","stroke-width":whole?1.5:1}));
    if(whole) svg.appendChild(svgEl("text",{x:x0-6,y:y(v)+4,"text-anchor":"end","font-size":11,fill:"var(--muted)"},String(v))); }
  var marks=[{v:e.evac,c:"var(--crit)",l:"Evac."},{v:e.alerta,c:"var(--alarm)",l:"Alerta"},{v:t.s,c:"var(--crit)",l:"Salida",dash:true},{v:t.p,c:"var(--alarm)",l:"Prep.",dash:true},{v:t.a,c:"var(--warn)",l:"Aten.",dash:true}];
  var used=[];
  marks.forEach(function(m){ if(m.v>max) return; var yy=y(m.v);
    svg.appendChild(svgEl("line",{x1:x0-2,x2:x0+w+2,y1:yy,y2:yy,stroke:m.c,"stroke-width":1.6,"stroke-dasharray":m.dash?"3 2":"none"}));
    var ly=yy+3.5; used.forEach(function(u){ if(Math.abs(u-ly)<10) ly=u+10; }); used.push(ly);
    svg.appendChild(svgEl("text",{x:x0+w+5,y:ly,"font-size":10,fill:m.c,"font-weight":600},m.l)); });
  svg.appendChild(svgEl("line",{x1:x0-4,x2:x0+w+4,y1:y(h),y2:y(h),stroke:"var(--ink)","stroke-width":2}));
  var g=$("gauge"); g.textContent=""; g.appendChild(svg);
}
function drawChart(serie,fc,t,sl,proj,dv){
  var W=640,H=270,L=40,R=14,T=14,B=28, pts=serie.slice(-21), d0=pts[0][0], last=pts[pts.length-1];
  var fpts=(fc&&fc.puntos?fc.puntos:[]).filter(function(p){return p.fecha>d0;});
  var endD=new Date(parseD(last[0]).getTime()+HORIZONTE*86400000), dEnd=isoD(endD);
  fpts.forEach(function(p){ if(p.fecha>dEnd) dEnd=p.fecha; });
  var span=Math.max(daysBetween(d0,dEnd),1);
  var trendEnd=sl==null?last[1]:last[1]+sl*HORIZONTE;
  var vals=pts.map(function(p){return p[1];}).concat(proj?[]:[trendEnd]);
  if(proj){ proj.forEach(function(p){ vals.push(p.central); if(p.max!=null) vals.push(p.max); if(p.min!=null) vals.push(p.min); if(p.fecha>dEnd) dEnd=p.fecha; }); span=Math.max(daysBetween(d0,dEnd),1); }
  fpts.forEach(function(p){ vals.push(p.central); if(p.max!=null) vals.push(p.max); if(p.min!=null) vals.push(p.min); });
  var lo=Math.floor((Math.min.apply(null,vals)-0.2)*2)/2, hi=Math.ceil((Math.max.apply(null,vals)+0.3)*2)/2;
  [t.a,t.p,t.s].forEach(function(v){ if(v>hi&&v<=hi+0.8) hi=Math.ceil((v+0.1)*2)/2; });
  var x=function(d){ return L+daysBetween(d0,d)/span*(W-L-R); }, y=function(v){ return T+(hi-v)/(hi-lo)*(H-T-B); };
  var svg=svgEl("svg",{viewBox:"0 0 "+W+" "+H,role:"img"}); svg.appendChild(svgEl("title",{},"Altura observada, pronóstico del INA y tendencia"));
  var gstep=(hi-lo)>6?1:0.5;
  for(var v=lo;v<=hi+0.001;v+=gstep){ svg.appendChild(svgEl("line",{x1:L,x2:W-R,y1:y(v),y2:y(v),stroke:"var(--line)"})); svg.appendChild(svgEl("text",{x:L-6,y:y(v)+4,"text-anchor":"end","font-size":11,fill:"var(--muted)"},fmt(v,1))); }
  [{v:t.a,c:"var(--warn)",l:"Atención"},{v:t.p,c:"var(--alarm)",l:"Preparación"},{v:t.s,c:"var(--crit)",l:"Salida"}].forEach(function(m){ if(m.v>lo&&m.v<hi){
    svg.appendChild(svgEl("line",{x1:L,x2:W-R,y1:y(m.v),y2:y(m.v),stroke:m.c,"stroke-width":1.5,"stroke-dasharray":"5 4"}));
    svg.appendChild(svgEl("text",{x:W-R,y:y(m.v)-5,"text-anchor":"end","font-size":11,fill:m.c,"font-weight":600},m.l+" "+fmt(m.v))); } });
  var step=Math.max(1,Math.round(span/6));
  for(var i=0;i<=span;i+=step){ var s=isoD(new Date(parseD(d0).getTime()+i*86400000)); svg.appendChild(svgEl("text",{x:x(s),y:H-8,"text-anchor":"middle","font-size":11,fill:"var(--muted)"},dateLabel(s))); }
  svg.appendChild(svgEl("line",{x1:x(last[0]),x2:x(last[0]),y1:T,y2:H-B,stroke:"var(--line)","stroke-dasharray":"2 3"}));
  var area="M"+x(pts[0][0])+","+y(lo), line=""; pts.forEach(function(p,i){ area+=" L"+x(p[0])+","+y(p[1]); line+=(i?" L":"M")+x(p[0])+","+y(p[1]); }); area+=" L"+x(last[0])+","+y(lo)+" Z";
  svg.appendChild(svgEl("path",{d:area,fill:"var(--water-soft)"})); svg.appendChild(svgEl("path",{d:line,fill:"none",stroke:"var(--water)","stroke-width":2.5,"stroke-linejoin":"round"}));
  if(proj){
    var band="M"+x(last[0])+","+y(last[1]); proj.forEach(function(p){ band+=" L"+x(p.fecha)+","+y(p.max!=null?p.max:p.central); });
    for(var q=proj.length-1;q>=0;q--){ band+=" L"+x(proj[q].fecha)+","+y(proj[q].min!=null?proj[q].min:proj[q].central); } band+=" Z";
    svg.appendChild(svgEl("path",{d:band,fill:"var(--water)",opacity:.12}));
    var pl="M"+x(last[0])+","+y(last[1]); proj.forEach(function(p){ pl+=" L"+x(p.fecha)+","+y(p.central); });
    svg.appendChild(svgEl("path",{d:pl,fill:"none",stroke:"var(--water)","stroke-width":2,"stroke-dasharray":"4 3"}));
    var pe=proj[proj.length-1]; svg.appendChild(svgEl("text",{x:x(pe.fecha),y:y(pe.central)-9,"text-anchor":"end","font-size":11.5,fill:"var(--water)","font-weight":600},fmt(pe.central)));
  } else if(sl!=null){
    svg.appendChild(svgEl("path",{d:"M"+x(last[0])+","+y(last[1])+" L"+x(isoD(endD))+","+y(Math.max(lo,Math.min(hi,trendEnd))),fill:"none",stroke:"var(--muted)","stroke-width":1.5,"stroke-dasharray":"2 4"}));
  }
  if(fpts.length){ var fl="M"+x(last[0])+","+y(last[1]); fpts.forEach(function(p){ fl+=" L"+x(p.fecha)+","+y(p.central); });
    svg.appendChild(svgEl("path",{d:fl,fill:"none",stroke:"var(--silt)","stroke-width":2,"stroke-dasharray":"6 5"}));
    fpts.forEach(function(p){ var top=p.max!=null?p.max:p.central, bot=p.min!=null?p.min:p.central;
      if(top!==bot){ svg.appendChild(svgEl("line",{x1:x(p.fecha),x2:x(p.fecha),y1:y(top),y2:y(bot),stroke:"var(--silt)","stroke-width":2})); svg.appendChild(svgEl("line",{x1:x(p.fecha)-5,x2:x(p.fecha)+5,y1:y(top),y2:y(top),stroke:"var(--silt)","stroke-width":2})); if(p.min!=null) svg.appendChild(svgEl("line",{x1:x(p.fecha)-5,x2:x(p.fecha)+5,y1:y(bot),y2:y(bot),stroke:"var(--silt)","stroke-width":2})); }
      svg.appendChild(svgEl("circle",{cx:x(p.fecha),cy:y(p.central),r:4.5,fill:"var(--surface)",stroke:"var(--silt)","stroke-width":2}));
      svg.appendChild(svgEl("text",{x:x(p.fecha)-8,y:y(p.central)+4,"text-anchor":"end","font-size":11.5,fill:"var(--silt)","font-weight":600},fmt(p.central))); }); }
  svg.appendChild(svgEl("circle",{cx:x(last[0]),cy:y(last[1]),r:5,fill:"var(--water)"}));
  svg.appendChild(svgEl("text",{x:x(last[0])-8,y:y(last[1])-9,"text-anchor":"end","font-size":12,fill:"var(--ink)","font-weight":600},fmt(last[1])+" m"));
  var c=$("chart"); c.textContent=""; c.appendChild(svg);
  $("legend").innerHTML='<span><i style="background:var(--water)"></i>Medido</span>'+(fpts.length?'<span><i style="background:var(--silt)"></i>Pronóstico INA (central y rango)</span>':'')+(proj?'<span><i style="background:var(--water);opacity:.6"></i>Proyección Vigía y banda de error <a href="#como-proyecta" class="ast" title="Cómo se calcula">*</a></span>':sl==null?'':'<span><i style="background:var(--muted)"></i>Tendencia '+HORIZONTE+' días (estimación propia)</span>');
  if(proj){ var M=D.modelo.estaciones[String(state.loc.estacion)]; $("chartNote").textContent="La proyección Vigía mira cuánto subió o bajó el río en las últimas dos semanas en "+entradasTxt(M,state.loc.estacion)+" y, con lo que pasó en los últimos "+(D.modelo.anios||3)+" años, estima cómo sigue en este puerto. La banda es el error real del método al probarlo contra el pasado"+(proj[0].sube?", medido en días en que el río venía subiendo como ahora":"")+"."+(dv?" Esta vez el pronóstico del INA queda fuera de esa banda: vale el del INA.":" Cuando el INA publica pronóstico, vale el INA."); }
  else if(sl==null){ $("chartNote").textContent="En el Delta inferior y el Río de la Plata cada punto es la altura más alta registrada ese día. Acá manda la marea y el viento (sudestada), así que no se dibuja tendencia: para lo que viene, seguí los avisos del INA y del Servicio de Hidrografía Naval."; }
  else { $("chartNote").textContent="La tendencia prolonga el ritmo de la última semana; sirve para orientarse, no reemplaza al pronóstico del INA."; }
}

/* ---------- aportes de vecinos ---------- */
var PRUEBA_APORTE = /[?&]aportar=prueba\b/.test(location.search);  // modo de prueba: muestra el botón aunque el río no esté en alerta
var OPCIONES = [["no","No llegó"],["calle","Llegó a la calle"],["terreno","Entró al terreno"],["casa","Entró a la casa o al local"]];
var COLOR_RESP = {no:"var(--ok)",calle:"var(--warn)",terreno:"var(--alarm)",casa:"var(--crit)"};
var TXT_RESP = {no:"el agua no llegó",calle:"el agua llegó a la calle",terreno:"el agua entró a los terrenos",casa:"el agua entró a las casas"};
var aporteCtx=null, vecinosMap=null, vecinosCapa=null, vecinosData=null, vecinosPedido=false;
function hoyLocal(){ var d=new Date(Date.now()-3*3600000); return d.toISOString().slice(0,10); }
function celularId(){
  var id=store.get("vigia.cel");
  if(!id){ id=(window.crypto&&crypto.randomUUID)?crypto.randomUUID():("c"+Math.random().toString(36).slice(2)+Date.now().toString(36)); store.set("vigia.cel",id); }
  return id;
}
function renderAportes(z,e,h,fechaDato){
  var box=$("aporteBox");
  var activo = !!APORTES_URL && (APORTES_ACTIVO || PRUEBA_APORTE);
  var conGps = state.loc && state.loc.origen==="gps";
  var enAlerta = h!=null && h>=e.alerta;
  box.hidden = !(activo && conGps && h!=null && (enAlerta || PRUEBA_APORTE));
  if(!box.hidden){
    aporteCtx={est:e, h:h, fecha:fechaDato};
    if(store.get("vigia.aporte")===hoyLocal() && !PRUEBA_APORTE){ $("aporteBtn").hidden=true; $("aportePaso").hidden=true; $("aporteMsg").className="msg ok"; $("aporteMsg").textContent="Ya aportaste hoy desde este celular. ¡Gracias! Mañana podés volver a contar cómo sigue."; }
  }
  $("privAportes").hidden=!activo;
  renderVecinos();
}
function pedirAporte(){
  var msg=$("aporteMsg"); msg.className="msg"; msg.textContent="Buscando tu ubicación…";
  $("aportePaso").hidden=true;
  if(!navigator.geolocation){ msg.className="msg err"; msg.textContent="Este celular no permite usar la ubicación."; return; }
  navigator.geolocation.getCurrentPosition(function(p){
    var acc=Math.round(p.coords.accuracy||9999);
    if(acc>50){ msg.className="msg err"; msg.textContent="Tu celular marca la ubicación con un margen de "+acc+" m. Para que el dato sirva hace falta más precisión: probá al aire libre, con el GPS activado, y tocá de nuevo el botón."; return; }
    aporteCtx.lat=p.coords.latitude; aporteCtx.lng=p.coords.longitude; aporteCtx.acc=acc;
    msg.textContent="";
    $("aporteQ").textContent="En tu ubicación y según la altura actual del río ("+fmt(aporteCtx.h)+" m en el puerto de "+aporteCtx.est.nombre+", dato del "+dateLabel(aporteCtx.fecha)+"), ¿el agua llegó a tu lugar?";
    var opc=$("aporteOpc"); opc.textContent="";
    OPCIONES.forEach(function(o){ var b=document.createElement("button"); b.type="button"; b.className="zbtn"; var t=document.createElement("b"); t.textContent=o[1]; b.appendChild(t);
      b.addEventListener("click",function(){ enviarAporte(o[0]); }); opc.appendChild(b); });
    $("aportePaso").hidden=false;
  },function(err){
    msg.className="msg err"; msg.textContent= err.code===1 ? "Para aportar hace falta permitir la ubicación del celular." : "No se pudo obtener la ubicación. Probá de nuevo en un rato.";
  },{enableHighAccuracy:true,timeout:20000,maximumAge:0});
}
function enviarAporte(resp){
  var msg=$("aporteMsg"); msg.className="msg"; msg.textContent="Enviando…";
  Array.prototype.forEach.call($("aporteOpc").children,function(b){ b.disabled=true; });
  var body=JSON.stringify({lat:+aporteCtx.lat.toFixed(6), lng:+aporteCtx.lng.toFixed(6), acc:aporteCtx.acc, resp:resp, est:aporteCtx.est.id, h:aporteCtx.h, hFecha:aporteCtx.fecha, did:celularId(), prueba:PRUEBA_APORTE});
  var listo=function(r){
    if(r && r.ok){ store.set("vigia.aporte",hoyLocal()); $("aportePaso").hidden=true; $("aporteBtn").hidden=true; msg.className="msg ok";
      msg.textContent="¡Gracias por aportar! Tu dato quedó guardado y, sumado al de otros vecinos, ayuda a que en la próxima crecida tu barrio tenga avisos más precisos."+(PRUEBA_APORTE?" (Aporte de prueba: no se suma al mapa.)":""); vecinosPedido=false; vecinosData=null; renderVecinos(); return; }
    var mot=r&&r.motivo;
    Array.prototype.forEach.call($("aporteOpc").children,function(b){ b.disabled=false; });
    msg.className="msg err";
    msg.textContent = mot==="ya_aportaste" ? "Ya aportaste hoy desde este celular. ¡Gracias! Mañana podés volver a contar cómo sigue."
      : mot==="precision" ? "La ubicación no fue lo bastante precisa. Probá al aire libre y volvé a intentar."
      : mot==="fuera_de_zona" ? "Tu ubicación queda fuera de la zona que cubre la app."
      : mot==="saturado" ? "Hay muchos aportes en este momento. Probá de nuevo en unos minutos."
      : "No se pudo enviar el aporte. Revisá la conexión y probá de nuevo.";
    if(mot==="ya_aportaste"){ store.set("vigia.aporte",hoyLocal()); $("aportePaso").hidden=true; $("aporteBtn").hidden=true; msg.className="msg ok"; }
  };
  if(!APORTES_URL){ setTimeout(function(){ listo({ok:true}); },400); return; } // modo prueba sin servidor
  fetch(APORTES_URL,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},body:body,redirect:"follow"})
    .then(function(r){ return r.json(); }).then(listo).catch(function(){ listo(null); });
}
function renderVecinos(){
  var box=$("vecinosBox");
  if(!APORTES_URL || !(APORTES_ACTIVO || PRUEBA_APORTE) || !state.loc){ box.hidden=true; return; }
  if(!vecinosData){
    if(!vecinosPedido){ vecinosPedido=true;
      fetch(APORTES_URL+"?accion=mapa").then(function(r){return r.json();}).then(function(d){ vecinosData=d&&d.ok?d:{celdas:[]}; renderVecinos(); }).catch(function(){ vecinosData={celdas:[]}; }); }
    box.hidden=true; return;
  }
  var lat=state.loc.lat, lng=state.loc.lng;
  var cerca=(vecinosData.celdas||[]).filter(function(c){ return km([lat,lng],[(c.s+c.n)/2,(c.w+c.e)/2])<=15; });
  if(!cerca.length){ box.hidden=true; return; }
  box.hidden=false;
  if(!vecinosMap){
    vecinosMap=L.map("mapaVecinos",{zoomControl:true,scrollWheelZoom:false}).setView([lat,lng],14);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:18,attribution:"&copy; OpenStreetMap"}).addTo(vecinosMap);
  } else vecinosMap.setView([lat,lng],14);
  if(vecinosCapa) vecinosCapa.remove();
  vecinosCapa=L.layerGroup().addTo(vecinosMap);
  var cs=getComputedStyle(document.documentElement);
  var col=function(r){ return (cs.getPropertyValue({no:"--ok",calle:"--warn",terreno:"--alarm",casa:"--crit"}[r])||"#888").trim(); };
  cerca.forEach(function(c){
    var est=estById(c.est), rango=c.hmin!=null?(Math.abs(c.hmax-c.hmin)<0.005?fmt(c.hmin)+" m":"entre "+fmt(c.hmin)+" y "+fmt(c.hmax)+" m"):"";
    var tip=c.aportes+" aportes · lo más repetido: "+TXT_RESP[c.modo]+(rango?" · río "+rango+(est?" en el puerto de "+est.nombre:""):"")+" · "+(c.desde===c.hasta?"el "+dateLabel(c.desde):"del "+dateLabel(c.desde)+" al "+dateLabel(c.hasta));
    L.rectangle([[c.s,c.w],[c.n,c.e]],{color:col(c.modo),weight:1,fillColor:col(c.modo),fillOpacity:.45}).bindTooltip(tip).addTo(vecinosCapa);
  });
  L.circleMarker([lat,lng],{radius:5,color:"#2C6B6E",fillOpacity:1}).bindTooltip("Tu ubicación").addTo(vecinosCapa);
  setTimeout(function(){ vecinosMap.invalidateSize(); },50);
  $("vecinosLeyenda").innerHTML=OPCIONES.map(function(o){ return '<span><i class="sq" style="background:'+COLOR_RESP[o[0]]+'"></i>'+o[1]+'</span>'; }).join("");
  $("vecinosNota").textContent="Cada cuadrado reúne al menos "+(vecinosData.minimo||3)+" aportes de celulares distintos en una zona de unos "+(vecinosData.celda_m||250)+" m, y muestra lo que más se repitió. Tocá un cuadrado para ver con qué altura del río pasó. Nunca se muestra una casa.";
}

/* ---------- eventos ---------- */
function bind(){
  $("btnGps").addEventListener("click",gps);
  $("aporteBtn").addEventListener("click",pedirAporte);
  $("btnMapa").addEventListener("click",showMap);
  $("btnTexto").addEventListener("click",function(){ $("textoBox").hidden=false; $("mapaBox").hidden=true; $("textoIn").focus(); });
  $("mapaOk").addEventListener("click",function(){ if(mapPoint) proposeZone(mapPoint[0],mapPoint[1],"mapa"); });
  $("textoOk").addEventListener("click",fromText);
  $("textoIn").addEventListener("keydown",function(ev){ if(ev.key==="Enter"){ ev.preventDefault(); fromText(); } });
  $("confirmOk").addEventListener("click",function(){ var p=state.pending; if(p) commitZone(p.zona,p.lat,p.lng,p.origen); });
  $("confirmNo").addEventListener("click",function(){
    var p=state.pending, box=$("confirmAlt"); box.textContent=""; box.hidden=false;
    altZones(p.lat,p.lng).forEach(function(z){ var b=document.createElement("button"); b.type="button"; b.className="zbtn";
      var n=document.createElement("b"); n.textContent=zoneLabel(z); b.appendChild(n); var r=document.createElement("span"); r.textContent=z.ref; b.appendChild(r);
      b.addEventListener("click",function(){ commitZone(z,p.lat,p.lng,p.origen); }); box.appendChild(b); });
  });
  $("cambiarUbic").addEventListener("click",function(){ $("ubicBody").hidden=false; $("confirmBox").hidden=true; $("ubic").scrollIntoView({behavior:"smooth",block:"start"}); });
  $("repoLink").href=REPO;
  var deferred=null;
  window.addEventListener("beforeinstallprompt",function(ev){ ev.preventDefault(); deferred=ev; $("instalar").hidden=false; });
  $("instalar").addEventListener("click",function(){ if(deferred){ deferred.prompt(); deferred=null; $("instalar").hidden=true; } });
  if("serviceWorker" in navigator){ navigator.serviceWorker.register("sw.js").catch(function(){}); }
}

load().then(function(){
  bind(); buildCityList();
  // link con zona: #colastine-norte-setubal o #ciudad-34
  var h=(location.hash||"").replace(/^#/,"").toLowerCase();
  if(h){ var z=null; D.zonas.features.forEach(function(f){ if(f.properties.id===h) z=f.properties; });
    if(!z&&h.indexOf("ciudad-")===0){ var e=estById(+h.slice(7)); if(e) z=cityZone(e); }
    if(z){ var e2=estById(z.estacion); setLoc({lat:e2.lat,lng:e2.lng,zonaId:z.id,estacion:z.estacion}); } }
  var zc=currentZone();
  if(zc){ $("ubicBody").hidden=true; }
  render();
}).catch(function(err){
  $("fresh").textContent="No se pudieron cargar los datos"; $("fresh").className="chip stale";
  $("ubicMsg").className="msg err"; $("ubicMsg").textContent="Error al cargar la app. Revisá la conexión y volvé a intentar.";
  console.error(err);
});
})();
