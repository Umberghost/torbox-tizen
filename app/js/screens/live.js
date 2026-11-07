/* screens/live.js — TV en directo (TDTChannels / M3U), guía EPG y accesos directos a apps oficiales.
 * Textos en app/i18n/live.js. */
(function(){
"use strict";

var App = window.App;
var K = App.K;
var t = App.t;

var CACHE_KEY = "live_cache";
var FAVS_KEY = "live_favs";
var CACHE_TTL = 12 * 3600 * 1000;
var EPG_URL = "https://www.tdtchannels.com/epg/TV.json";
var EPG_TTL = 6 * 3600 * 1000;

/* Flags de TDTChannels que indican que el flujo no se puede reproducir desde un
 * navegador/AVPlay sin cabeceras especiales (Referer, User-Agent) o no navegable. */
var BAD_FLAGS = /^(NONAV|NOEM|REF|REFI\d*|REFC\d*|UAG|UAGB)$/;

/* Orden de ámbitos: primero los nacionales clave y Andalucía. */
var AMBIT_ORDER = ["Generalistas", "Informativos", "Infantiles", "Deportivos", "Andalucía"];

/* Dentro de Andalucía, estos primero (en este orden). */
var ANDALUCIA_FIRST = [/^canal sur andaluc/i, /^canal sur 2/i, /^canal sur/i, /^7tv sevilla/i, /^7tv andaluc/i];

/* ================= Accesos directos ================= */
var APPS = [
  { key: "atresplayer", name: "Atresplayer", re: /atres\s*player/i },
  { key: "mitele", name: "Mediaset Infinity", re: /mitele|mediaset|infinity/i },
  { key: "tivify", name: "Tivify", re: /tivify/i }
];

/* ================= Estado ================= */
var S = {
  el: null,
  grid: null,
  channels: [],      // lista plana ordenada; num = índice + 1
  byId: {},
  favs: App.store.get(FAVS_KEY, []),
  loading: false,
  playingId: null,
  digitBuf: "",
  digitTimer: null,
  fromCache: false,
  stale: false,
  geo: null,         // geometría cacheada de las tarjetas (rendimiento)
  epg: null,         // { t, byName: {epgName: [{hi,hf,t}]} }
  epgLoading: false,
  epgTimer: null
};

/* ================= Utilidades ================= */
function slug(s){
  return String(s || "").toLowerCase()
    .replace(/[áàä]/g, "a").replace(/[éèë]/g, "e").replace(/[íìï]/g, "i")
    .replace(/[óòö]/g, "o").replace(/[úùü]/g, "u").replace(/ñ/g, "n")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function isHttpUrl(u){ return /^https?:\/\//i.test(String(u || "")); }
function isHlsUrl(u){ return /\.m3u8(\?|$)/i.test(String(u || "")); }
/* URLs con plantillas tipo [IP] o [DEVICE_ID] (redes de anuncios) no funcionan tal cual */
function hasPlaceholders(u){ return /\[[A-Z_]+\]/.test(String(u || "")); }
/* Nombre de ámbito traducido si hay clave (live.ambit.<slug>); si no, el original de la lista */
function ambitLabel(name){
  var k = "live.ambit." + slug(name);
  return App.i18n.has(k) ? t(k) : name;
}
function pad2(n){ return (n < 10 ? "0" : "") + n; }
function hhmm(sec){ var d = new Date(sec * 1000); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }

/* ================= Parsers ================= */
function parseTDT(json){
  var out = [];
  (json.countries || []).forEach(function(country){
    (country.ambits || []).forEach(function(ambit){
      (ambit.channels || []).forEach(function(ch){
        var flags = ch.extra_info || [];
        for(var f = 0; f < flags.length; f++){ if(BAD_FLAGS.test(flags[f])) return; }
        var urls = (ch.options || []).filter(function(o){
          if(!o || !isHttpUrl(o.url) || hasPlaceholders(o.url)) return false;
          if(o.format === "m3u8") return true;
          if(o.format === "stream") return isHlsUrl(o.url);
          return false;
        }).map(function(o){ return o.url; });
        if(!urls.length) return;
        out.push({
          name: ch.name || "Channel",
          logo: ch.logo || "",
          url: urls[0],
          urls: urls,
          ambit: ambit.name || "Otros",
          country: country.name || "",
          geo: flags.indexOf("GEO") >= 0,
          epg: ch.epg_id || ""
        });
      });
    });
  });
  return out;
}

function attr(line, name){
  var m = line.match(new RegExp(name + '="([^"]*)"', "i"));
  return m ? m[1] : "";
}
function parseM3U(text){
  var out = [];
  var lines = String(text).split(/\r?\n/);
  var cur = null;
  for(var i = 0; i < lines.length; i++){
    var line = lines[i].trim();
    if(!line) continue;
    if(/^#EXTINF/i.test(line)){
      var comma = line.lastIndexOf(",");
      cur = {
        name: comma >= 0 ? line.slice(comma + 1).trim() : "Channel",
        logo: attr(line, "tvg-logo"),
        ambit: attr(line, "group-title") || "Otros",
        epg: attr(line, "tvg-id")
      };
    } else if(line.charAt(0) === "#"){
      continue;
    } else if(cur){
      if(isHttpUrl(line) && !hasPlaceholders(line)){
        out.push({ name: cur.name, logo: cur.logo, url: line, urls: [line],
                   ambit: cur.ambit, country: "", geo: false, epg: cur.epg });
      }
      cur = null;
    }
  }
  return out;
}

/* ================= Orden ================= */
function ambitRank(a){
  var i = AMBIT_ORDER.indexOf(a.name);
  if(i >= 0) return i;
  // España antes que internacional, respetando el orden de la fuente
  return (a.country && a.country !== "Spain" ? 1000 : 100) + a.first;
}
function andaluciaRank(name){
  for(var i = 0; i < ANDALUCIA_FIRST.length; i++){ if(ANDALUCIA_FIRST[i].test(name)) return i; }
  return 99;
}

function organize(list){
  // Agrupar por ámbito conservando el orden de aparición
  var ambits = [], byName = {};
  list.forEach(function(ch, idx){
    var k = ch.country + "|" + ch.ambit;
    var a = byName[k];
    if(!a){ a = byName[k] = { name: ch.ambit, country: ch.country, first: ambits.length, items: [] }; ambits.push(a); }
    ch._src = idx;
    a.items.push(ch);
  });
  ambits.sort(function(x, y){ return ambitRank(x) - ambitRank(y); });
  ambits.forEach(function(a){
    if(a.name === "Andalucía"){
      a.items.sort(function(x, y){ return (andaluciaRank(x.name) - andaluciaRank(y.name)) || (x._src - y._src); });
    }
  });
  // Lista plana numerada + ids únicos
  var flat = [], seen = {};
  ambits.forEach(function(a){
    a.items.forEach(function(ch){
      var id = slug(ch.epg || ch.name) || "canal";
      if(seen[id]){ var n = 2; while(seen[id + "-" + n]) n++; id = id + "-" + n; }
      seen[id] = true;
      ch.id = id;
      ch.num = flat.length + 1;
      delete ch._src;
      flat.push(ch);
    });
  });
  return flat;
}

/* ================= Carga ================= */
function fetchList(url){
  return App.net.fetch(url).then(function(r){
    if(!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  }).then(function(text){
    var txt = text.replace(/^﻿/, "").trim();
    var list;
    if(/\.m3u8?(\?|$)/i.test(url) || /^#EXTM3U/i.test(txt)) list = parseM3U(txt);
    else list = parseTDT(JSON.parse(txt));
    if(!list.length) throw new Error(t("live.noPlayable"));
    return organize(list);
  });
}

function load(force){
  var url = App.settings.get("liveListUrl") || "https://www.tdtchannels.com/lists/tv.json";
  var cache = App.store.get(CACHE_KEY, null);
  var cacheOk = cache && cache.url === url && cache.channels && cache.channels.length;
  if(!force && cacheOk && Date.now() - cache.t < CACHE_TTL){
    setChannels(cache.channels, true, false);
    return Promise.resolve();
  }
  S.loading = true;
  if(!S.channels.length) App.ui.loading(S.el, t("live.loading"));
  return fetchList(url).then(function(channels){
    S.loading = false;
    App.store.set(CACHE_KEY, { t: Date.now(), url: url, channels: channels });
    setChannels(channels, false, false);
    if(force) App.ui.toast(t("live.updated", {n: channels.length}));
  }).catch(function(e){
    S.loading = false;
    console.warn("[live]", e);
    if(cacheOk){
      setChannels(cache.channels, true, true);
      App.ui.toast(t("live.usingCache"));
    } else if(!S.channels.length){
      renderError(e.message);
    } else {
      App.ui.toast(t("live.reloadFailed", {msg: e.message}));
    }
  });
}

function setChannels(list, fromCache, stale){
  S.channels = list;
  S.byId = {};
  list.forEach(function(ch){ S.byId[ch.id] = ch; });
  S.fromCache = fromCache; S.stale = stale;
  render();
  loadEpg(false);
}

/* ================= Guía EPG (TDTChannels) =================
 * TV.json: [{name:"La1.TV", events:[{hi, hf, t, d, g, c}]}] (~4 MB, ~600 KB con gzip).
 * Se cruza con epg_id del canal. Solo se guarda en memoria (6 h) y solo eventos
 * desde ahora hasta +24 h, título y horas (lo justo para "Ahora / Luego").
 */
function loadEpg(force){
  if(S.epgLoading) return;
  if(!force && S.epg && Date.now() - S.epg.t < EPG_TTL) return;
  var anyEpg = false;
  for(var i = 0; i < S.channels.length && !anyEpg; i++) if(S.channels[i].epg) anyEpg = true;
  if(!anyEpg) return;
  S.epgLoading = true;
  App.net.fetch(EPG_URL).then(function(r){
    if(!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(function(list){
    var now = Date.now() / 1000, until = now + 24 * 3600, byName = {}, n = 0;
    (list || []).forEach(function(c){
      if(!c || !c.name || !c.events) return;
      var evs = [];
      for(var j = 0; j < c.events.length; j++){
        var e = c.events[j];
        if(e.hf > now && e.hi < until) evs.push({ hi: e.hi, hf: e.hf, t: e.t || "" });
      }
      if(evs.length){ evs.sort(function(a, b){ return a.hi - b.hi; }); byName[c.name] = evs; n++; }
    });
    S.epg = { t: Date.now(), byName: byName };
    S.epgLoading = false;
    console.info("[live] EPG loaded: " + n + " channels");
    updateEpgBar();
  }).catch(function(e){
    S.epgLoading = false;
    S.epg = { t: Date.now() - EPG_TTL + 15 * 60000, byName: {} };   // reintentar en 15 min
    console.warn("[live] EPG failed:", e.message);
  });
}

/* → {now:{t,hi,hf}, next:{...}} o null */
function epgFor(ch){
  if(!ch || !ch.epg || !S.epg) return null;
  var evs = S.epg.byName[ch.epg];
  if(!evs) return null;
  var now = Date.now() / 1000;
  for(var i = 0; i < evs.length; i++){
    if(evs[i].hi <= now && evs[i].hf > now) return { now: evs[i], next: evs[i + 1] || null };
    if(evs[i].hi > now) return { now: null, next: evs[i] };
  }
  return null;
}

function epgBarHtml(ch){
  if(!ch) return "";
  var e = epgFor(ch);
  var h = '<span class="live-epg-ch"><b class="num">' + ch.num + '</b> ' + App.esc(ch.name) + '</span>';
  if(!e){
    h += '<span class="live-epg-none muted">' + App.esc(S.epg ? t("live.epg.none") : (S.epgLoading ? t("live.epg.loading") : t("live.epg.none"))) + '</span>';
    return h;
  }
  if(e.now){
    var now = Date.now() / 1000;
    var p = Math.max(0, Math.min(1, (now - e.now.hi) / Math.max(1, e.now.hf - e.now.hi)));
    h += '<span class="live-epg-now"><span class="live-epg-tag">' + App.esc(t("live.epg.now")) + '</span> ' +
         App.esc(e.now.t) + ' <span class="muted num">' + hhmm(e.now.hi) + '–' + hhmm(e.now.hf) + '</span>' +
         '<span class="progress live-epg-bar"><i style="width:' + (p * 100).toFixed(0) + '%"></i></span></span>';
  }
  if(e.next){
    h += '<span class="live-epg-next"><span class="live-epg-tag next">' + App.esc(t("live.epg.next")) + '</span> ' +
         App.esc(e.next.t) + ' <span class="muted num">' + hhmm(e.next.hi) + '</span></span>';
  }
  return h;
}

function focusedChannel(){
  var el = S.grid && S.grid.current();
  if(!el || el.dataset.kind !== "ch") return null;
  return S.byId[el.dataset.id] || null;
}
function updateEpgBar(){
  if(!S.el) return;
  var bar = S.el.querySelector(".live-epg");
  if(!bar) return;
  var ch = focusedChannel();
  if(!ch){ bar.classList.remove("on"); return; }
  bar.innerHTML = epgBarHtml(ch);
  bar.classList.add("on");
}
function scheduleEpgBar(){
  clearTimeout(S.epgTimer);
  S.epgTimer = setTimeout(updateEpgBar, 120);
}

/* ================= Render ================= */
function appCard(a){
  return '<div class="live-card live-app focusable" data-kind="app" data-key="' + a.key + '">' +
           '<div class="live-app-name">' + App.esc(a.name) + '</div>' +
           '<div class="live-app-desc">' + App.esc(t("live.app." + a.key)) + '</div>' +
         '</div>';
}

function chCard(ch){
  var fav = S.favs.indexOf(ch.id) >= 0;
  var logo = ch.logo
    ? '<img class="live-logo" src="' + App.esc(ch.logo) + '" alt="" loading="lazy">'
    : '<span class="live-initials" style="' + App.ui.placeholderStyle(ch.name) + '">' + App.esc(App.ui.initials(ch.name)) + '</span>';
  return '<div class="live-card live-ch focusable' + (ch.id === S.playingId ? ' playing' : '') +
           '" data-kind="ch" data-id="' + App.esc(ch.id) + '">' +
           '<div class="live-thumb">' + logo +
             '<span class="live-num num">' + ch.num + '</span>' +
             (fav ? '<span class="live-fav">★</span>' : '') +
           '</div>' +
           '<div class="live-name">' + App.esc(ch.name) + '</div>' +
         '</div>';
}

function render(){
  var prevKey = currentKey();
  var html = '<div class="scroll live-scroll">';

  html += '<div class="section-title">' + App.esc(t("live.apps")) + ' <span class="muted">' + App.esc(t("live.appsSub")) + '</span></div>';
  html += '<div class="live-row">' + APPS.map(appCard).join("") + '</div>';

  var favs = S.favs.map(function(id){ return S.byId[id]; }).filter(Boolean);
  if(favs.length){
    html += '<div class="section-title">' + App.esc(t("live.favorites")) + '</div>';
    html += '<div class="live-grid">' + favs.map(chCard).join("") + '</div>';
  }

  // Contar por ámbito una sola vez (antes era O(n²))
  var counts = {};
  S.channels.forEach(function(ch){ var k = ch.country + "|" + ch.ambit; counts[k] = (counts[k] || 0) + 1; });

  var lastAmbit = null, open = false;
  S.channels.forEach(function(ch){
    var k = ch.country + "|" + ch.ambit;
    if(k !== lastAmbit){
      if(open) html += '</div>';
      html += '<div class="section-title">' + App.esc(ambitLabel(ch.ambit)) + ' <span class="muted num">' + counts[k] + '</span></div>';
      html += '<div class="live-grid live-sec">';
      open = true; lastAmbit = k;
    }
    html += chCard(ch);
  });
  if(open) html += '</div>';

  if(S.stale) html += '<p class="live-note muted">' + App.esc(t("live.staleNote")) + '</p>';
  html += '<p class="live-note muted">' + App.esc(t("live.sourceNote")) + '</p>';
  html += '</div><div class="live-epg"></div>';

  S.el.innerHTML = html;
  makeGrid();
  restoreFocus(prevKey);
}

function renderError(msg){
  S.el.innerHTML =
    '<div class="scroll live-scroll">' +
      '<div class="section-title">' + App.esc(t("live.apps")) + '</div>' +
      '<div class="live-row">' + APPS.map(appCard).join("") + '</div>' +
      '<div class="live-error"><h2>' + App.esc(t("live.loadError")) + '</h2>' +
      '<p class="muted">' + App.esc(msg || "") + '</p><p class="muted">' + App.esc(t("live.loadErrorHelp")) + '</p></div>' +
    '</div>';
  makeGrid();
  S.grid.focus(0, true);
}

/* ================= Navegación rápida =================
 * FocusGrid mide todas las tarjetas (getBoundingClientRect) en cada pulsación.
 * Con ~380 canales eso cuesta en la TV, así que se calcula la geometría UNA vez
 * por render (posiciones relativas al contenido del scroll, que no cambian al
 * desplazarse) y se sustituye move() por la misma heurística con datos cacheados.
 */
function makeGrid(){
  var scroller = S.el.querySelector(".live-scroll");
  S.grid = new App.ui.FocusGrid(scroller, { onSelect: onSelect, onFocus: scheduleEpgBar });
  S.geo = null;
  var grid = S.grid;
  grid.move = function(dir){ return fastMove(grid, dir); };
}

function buildGeo(grid){
  var scroller = S.el.querySelector(".live-scroll");
  if(!scroller) return null;
  var base = scroller.getBoundingClientRect();
  var st = scroller.scrollTop, sl = scroller.scrollLeft;
  return grid.items.map(function(el){
    var r = el.getBoundingClientRect();
    // quitar el escalado del foco (transform) para que no altere la geometría
    var left = r.left - base.left + sl, top = r.top - base.top + st;
    return { l: left, t: top, r: left + r.width, b: top + r.height, cx: left + r.width / 2, cy: top + r.height / 2 };
  });
}

function fastMove(grid, dir){
  if(!S.geo || S.geo.length !== grid.items.length) S.geo = buildGeo(grid);
  var g = S.geo;
  if(!g) return false;
  var a = g[grid.index];
  if(!a) return false;
  var best = -1, bestScore = Infinity;
  for(var i = 0; i < g.length; i++){
    if(i === grid.index) continue;
    var b = g[i], dx = b.cx - a.cx, dy = b.cy - a.cy, primary, secondary;
    if(dir === "up"){ if(b.b > a.t + 2) continue; primary = -dy; secondary = Math.abs(dx); }
    else if(dir === "down"){ if(b.t < a.b - 2) continue; primary = dy; secondary = Math.abs(dx); }
    else if(dir === "left"){ if(b.r > a.l + 2) continue; primary = -dx; secondary = Math.abs(dy); }
    else { if(b.l < a.r - 2) continue; primary = dx; secondary = Math.abs(dy); }
    var score = primary + secondary * 2.5;
    if(score < bestScore){ bestScore = score; best = i; }
  }
  if(best >= 0){ grid.focus(best); return true; }
  return false;
}

function currentKey(){
  var el = S.grid && S.grid.current();
  if(!el) return null;
  return el.dataset.kind === "app" ? "app:" + el.dataset.key : "ch:" + el.dataset.id;
}
function findIndex(key){
  if(!S.grid || !key) return -1;
  for(var i = 0; i < S.grid.items.length; i++){
    var el = S.grid.items[i];
    var k = el.dataset.kind === "app" ? "app:" + el.dataset.key : "ch:" + el.dataset.id;
    if(k === key) return i;
  }
  return -1;
}
function restoreFocus(key){
  if(!S.grid) return;
  var i = findIndex(key);
  if(i < 0 && S.playingId) i = findIndex("ch:" + S.playingId);
  if(i < 0){
    // por defecto: primer canal (salta la fila de apps)
    i = 0;
    for(var j = 0; j < S.grid.items.length; j++){ if(S.grid.items[j].dataset.kind === "ch"){ i = j; break; } }
  }
  if(document.body.classList.contains("zone-header")){ S.grid.index = i; S.grid.blur(); }
  else S.grid.focus(i, true);
  scheduleEpgBar();
}

/* Logos rotos → iniciales */
function onImgError(ev){
  var img = ev.target;
  if(!img || img.tagName !== "IMG" || !img.classList.contains("live-logo")) return;
  var card = img.closest ? img.closest(".live-card") : null;
  var name = card ? (card.querySelector(".live-name") || {}).textContent : "";
  var span = document.createElement("span");
  span.className = "live-initials";
  span.setAttribute("style", App.ui.placeholderStyle(name));
  span.textContent = App.ui.initials(name);
  img.parentNode.replaceChild(span, img);
}

/* ================= Acciones ================= */
function onSelect(i, el){
  if(el.dataset.kind === "app") launchApp(el.dataset.key);
  else playChannel(S.byId[el.dataset.id]);
}

function playChannel(ch){
  if(!ch) return;
  if(!App.player || !App.player.play){ App.hint(t("live.noPlayer")); return; }
  S.playingId = ch.id;
  markPlaying();
  var sub = ambitLabel(ch.ambit) + (ch.geo ? " · " + t("live.geoOnly") : "");
  var e = epgFor(ch);
  if(e && e.now) sub = t("live.epg.now") + ": " + e.now.t + " · " + sub;
  App.player.play({
    title: ch.num + " · " + ch.name,
    subtitle: sub,
    url: ch.url,
    urls: ch.urls,
    key: "live:" + ch.id,
    live: true,
    poster: ch.logo,
    onChannel: function(dir){ zap(dir); },
    onDigit: function(n){ pushDigit(n); }
  });
}

function markPlaying(){
  if(!S.el) return;
  var cards = S.el.querySelectorAll(".live-ch");
  for(var i = 0; i < cards.length; i++) cards[i].classList.toggle("playing", cards[i].dataset.id === S.playingId);
  // dejar el foco en el canal en reproducción para cuando se cierre el reproductor
  var idx = findIndex("ch:" + S.playingId);
  if(idx >= 0 && S.grid){ S.grid.index = idx; S.grid.paint(); }
}

function zap(dir){
  if(!S.channels.length) return;
  var cur = S.byId[S.playingId];
  var i = cur ? cur.num - 1 : -1;
  var n = S.channels.length;
  var next = S.channels[((i + dir) % n + n) % n];
  playChannel(next);
}

function pushDigit(n){
  if(n < 0 || n > 9) return;
  S.digitBuf = (S.digitBuf + n).slice(-4);
  App.ui.toast(t("live.channelTyping", {n: S.digitBuf}), 1600);
  clearTimeout(S.digitTimer);
  S.digitTimer = setTimeout(function(){
    var num = parseInt(S.digitBuf, 10);
    S.digitBuf = "";
    var ch = S.channels[num - 1];
    if(ch) playChannel(ch);
    else App.ui.toast(t("live.noChannel", {n: num}));
  }, 1500);
}

function toggleFav(){
  var el = S.grid && S.grid.current();
  if(!el || el.dataset.kind !== "ch"){ App.hint(t("live.pickChannel")); return; }
  var id = el.dataset.id;
  var i = S.favs.indexOf(id);
  if(i >= 0){ S.favs.splice(i, 1); App.ui.toast(t("live.favRemoved")); }
  else { S.favs.push(id); App.ui.toast(t("live.favAdded")); }
  App.store.set(FAVS_KEY, S.favs);
  render();
}

/* ----- Lanzar apps oficiales ----- */
function appDef(key){
  for(var i = 0; i < APPS.length; i++) if(APPS[i].key === key) return APPS[i];
  return null;
}
function saveAppId(key, id){
  var ids = Object.assign({}, App.settings.get("appIds") || {});
  if(id) ids[key] = id; else delete ids[key];
  App.settings.set("appIds", ids);
}
function findInstalled(def){
  return new Promise(function(resolve){
    try{
      tizen.application.getAppsInfo(function(list){
        var hit = null;
        for(var i = 0; i < list.length; i++){
          var a = list[i];
          if(def.re.test(a.name || "") || def.re.test(a.id || "")){ hit = a.id; break; }
        }
        resolve(hit);
      }, function(){ resolve(null); });
    }catch(e){ resolve(null); }
  });
}
function launchId(id){
  return new Promise(function(resolve, reject){
    try{ tizen.application.launch(id, resolve, reject); }catch(e){ reject(e); }
  });
}
function notFound(def){
  var extra = def.key === "tivify" ? "<p>" + App.esc(t("live.tivifyNote")) + "</p>" : "";
  App.ui.modal({
    title: t("live.notFoundTitle", {app: def.name}),
    html: "<p>" + App.esc(t("live.notFoundText", {app: def.name})) + "</p>" + extra,
    buttons: [{ label: t("live.understood"), value: true }]
  });
}

function launchApp(key){
  var def = appDef(key);
  if(!def) return;
  if(!(window.tizen && tizen.application && tizen.application.launch)){
    App.hint(t("live.tvOnly", {app: def.name}), 4500);
    return;
  }
  var saved = (App.settings.get("appIds") || {})[key];
  var tried = {};

  function attempt(id){
    if(!id || tried[id]) return Promise.reject(new Error("no id"));
    tried[id] = true;
    return launchId(id);
  }

  App.ui.toast(t("live.opening", {app: def.name}));
  attempt(saved)
    .catch(function(){
      if(saved) saveAppId(key, null);          // id guardado ya no vale
      return findInstalled(def).then(function(id){
        if(!id) throw new Error("not installed");
        saveAppId(key, id);
        return attempt(id);
      });
    })
    .catch(function(e){
      console.warn("[live] launch " + key, e);
      notFound(def);
    });
}

/* ================= Pantalla ================= */
App.screens.register({
  id: "live", label: t("nav.live"), nav: true, order: 30,
  get hint(){ return t("live.hint"); },
  mount: function(el){
    S.el = el;
    el.addEventListener("error", onImgError, true);
    window.addEventListener("resize", function(){ S.geo = null; });
  },
  show: function(params){
    if(params && params._back && S.grid){ restoreFocus(currentKey()); return; }
    if(!S.channels.length && !S.loading) load(false);
    else if(S.grid){ S.geo = null; restoreFocus(currentKey()); loadEpg(false); }
  },
  hide: function(){
    clearTimeout(S.digitTimer); S.digitBuf = "";
    clearTimeout(S.epgTimer);
  },
  focus: function(){
    if(!S.grid) return;
    S.grid.refresh(false);
    S.geo = null;
    S.grid.focus(S.grid.index, true);
    scheduleEpgBar();
  },
  blur: function(){
    if(S.grid) S.grid.blur();
    var bar = S.el && S.el.querySelector(".live-epg");
    if(bar) bar.classList.remove("on");
  },
  onKey: function(k){
    if(k === K.RED){ load(true); loadEpg(true); return true; }
    if(k === K.GREEN){ toggleFav(); return true; }
    var d = App.digit(k);
    if(d >= 0 && S.channels.length){ pushDigit(d); return true; }
    if(S.grid) return S.grid.handleKey(k);
    return false;
  }
});

/* Exponer para pruebas / otros módulos */
App.live = {
  parseTDT: parseTDT,
  parseM3U: parseM3U,
  organize: organize,
  reload: function(){ return load(true); },
  channels: function(){ return S.channels.slice(); },
  epgFor: function(id){ return epgFor(S.byId[id]); }
};

})();
