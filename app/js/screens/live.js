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
var HIDDEN_KEY = "live_hidden";       // [{id, n}]
var ORDER_KEY = "live_order";         // [id, ...] orden propio (todos los canales)
var REM_KEY = "live_reminders";       // [{id, ch, t, hi}]
var GUIDE_SPAN = 3 * 3600;            // ventana visible de la rejilla (s): 6 franjas de 30 min
var GUIDE_RANGE = 6 * 3600;           // ahora -> +6 h
var GUIDE_ROWS = 5;                   // filas pintadas a la vez (virtualizado)

App.settings.define("liveExtraLists", []);

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
  epgTimer: null,
  base: [],          // canales de la lista principal
  extra: [],         // canales de listas M3U adicionales
  extraKey: null,    // URLs ya cargadas (para detectar cambios)
  forceExtra: false,
  allOrder: [],      // todos los canales (visibles y ocultos) en orden propio
  grab: null,        // id del canal "agarrado" en modo mover
  guide: null,       // estado de la guía en rejilla (null = vista de tarjetas)
  view: "guide",     // vista principal: "guide" (rejilla) | "cards" (tarjetas)
  favOnly: false,    // la guía solo muestra favoritos
  pending: null      // canal a reproducir cuando cargue la lista (recordatorio)
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

/* ----- Listas M3U adicionales (#66) ----- */
function extraUrls(){
  var v = App.settings.get("liveExtraLists");
  return (Array.isArray(v) ? v : []).filter(isHttpUrl);
}
function hashStr(s){
  var h = 0; s = String(s);
  for(var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function extraName(u){
  var p = String(u).replace(/^https?:\/\//i, "").split(/[?#]/)[0].replace(/\/+$/, "").split("/");
  var last = (p.length > 1 ? p[p.length - 1] : "").replace(/\.(m3u8?|json)$/i, "");
  return p[0] + (last ? "/" + last : "");
}
function fetchExtra(u){
  var ckey = "live_extra:" + u;
  var cached = (App.cache && !S.forceExtra) ? App.cache.get(ckey) : Promise.resolve(undefined);
  return Promise.resolve(cached).then(function(c){
    if(c && c.length) return c;
    return App.net.fetch(u).then(function(r){
      if(!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }).then(function(text){
      var txt = text.replace(/^\uFEFF/, "").trim();
      var list = (/\.m3u8?(\?|$)/i.test(u) || /^#EXTM3U/i.test(txt)) ? parseM3U(txt) : parseTDT(JSON.parse(txt));
      if(App.cache) App.cache.set(ckey, list, CACHE_TTL);
      return list;
    });
  }).then(function(list){
    var name = extraName(u), seen = {}, h = hashStr(u);
    return list.map(function(ch){
      var id = "x" + h + "-" + (slug(ch.epg || ch.name) || "canal");
      if(seen[id]){ var n = 2; while(seen[id + "-" + n]) n++; id = id + "-" + n; }
      seen[id] = true;
      ch.id = id; ch.ambit = name; ch.country = "x" + h; ch.extra = true;
      return ch;
    });
  }).catch(function(e){
    console.warn("[live] extra list " + u, e);
    App.ui.toast(t("live.extra.failed", {url: extraName(u)}));
    return [];
  });
}
/* Resuelve true si las listas adicionales cambiaron */
function loadExtras(){
  var urls = extraUrls(), key = urls.join("\n");
  if(key === S.extraKey && !S.forceExtra) return Promise.resolve(false);
  S.extraKey = key;
  return Promise.all(urls.map(fetchExtra)).then(function(lists){
    if(S.extraKey !== key) return false;
    S.forceExtra = false;
    S.extra = [].concat.apply([], lists);
    return true;
  });
}
function refreshExtras(){
  loadExtras().then(function(changed){
    if(changed && S.el && S.base.length){ rebuild(); render(); }
  });
}
App.bus.on("settings:change", function(c){
  if(!c || !c.key || c.key === "liveExtraLists") refreshExtras();
});

/* ----- Orden propio (#64) y ocultos (#65) ----- */
function hiddenList(){ var h = App.store.get(HIDDEN_KEY, []); return Array.isArray(h) ? h : []; }
function saveOrder(){ App.store.set(ORDER_KEY, S.allOrder.map(function(c){ return c.id; })); }

/* Combina listas, aplica orden propio, quita ocultos y numera */
function rebuild(){
  var all = S.base.concat(S.extra);
  var ord = App.store.get(ORDER_KEY, null);
  if(ord && ord.length){
    var pos = {};
    ord.forEach(function(id, i){ pos[id] = i; });
    all = all.map(function(c, i){ return { c: c, i: i }; }).sort(function(a, b){
      var pa = pos[a.c.id], pb = pos[b.c.id];
      if(pa === undefined && pb === undefined) return a.i - b.i;
      if(pa === undefined) return 1;
      if(pb === undefined) return -1;
      return pa - pb;
    }).map(function(o){ return o.c; });
  }
  S.allOrder = all;
  var hid = {};
  hiddenList().forEach(function(h){ hid[h.id] = true; });
  S.channels = all.filter(function(c){ return !hid[c.id]; });
  S.byId = {};
  S.channels.forEach(function(c, i){ c.num = i + 1; S.byId[c.id] = c; });
}

function setChannels(list, fromCache, stale){
  S.base = list;
  S.fromCache = fromCache; S.stale = stale;
  rebuild();
  render();
  loadEpg(false);
  refreshExtras();
  if(S.pending && S.byId[S.pending]){ var id = S.pending; S.pending = null; playChannel(S.byId[id]); }
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
    if(S.guide) renderGuide();
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

function guideCard(){
  return '<div class="live-card live-app live-guide-btn focusable" data-kind="guide">' +
           '<div class="live-app-name">' + App.esc(t("live.guide")) + '</div>' +
           '<div class="live-app-desc">' + App.esc(t("live.guideDesc")) + '</div>' +
         '</div>';
}

function chCard(ch){
  var fav = S.favs.indexOf(ch.id) >= 0;
  var logo = ch.logo
    ? '<img class="live-logo" src="' + App.esc(ch.logo) + '" alt="" loading="lazy">'
    : '<span class="live-initials" style="' + App.ui.placeholderStyle(ch.name) + '">' + App.esc(App.ui.initials(ch.name)) + '</span>';
  return '<div class="live-card live-ch focusable' + (ch.id === S.playingId ? ' playing' : '') + (ch.id === S.grab ? ' grabbed' : '') +
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
  html += '<div class="live-row">' + guideCard() + APPS.map(appCard).join("") + '</div>';

  var favs = S.favs.map(function(id){ return S.byId[id]; }).filter(Boolean);
  if(favs.length){
    html += '<div class="section-title">' + App.esc(t("live.favorites")) + '</div>';
    html += '<div class="live-grid">' + favs.map(chCard).join("") + '</div>';
  }

  // Secciones = tramos consecutivos del mismo ámbito (el orden propio puede partirlos)
  var runs = [], lastAmbit = null;
  S.channels.forEach(function(ch){
    var k = ch.country + "|" + ch.ambit;
    if(k !== lastAmbit){ runs.push({ ch: ch, items: [] }); lastAmbit = k; }
    runs[runs.length - 1].items.push(ch);
  });
  runs.forEach(function(r){
    html += '<div class="section-title">' + App.esc(ambitLabel(r.ch.ambit)) + ' <span class="muted num">' + r.items.length + '</span></div>';
    html += '<div class="live-grid live-sec">' + r.items.map(chCard).join("") + '</div>';
  });
  var nHid = hiddenList().length;
  if(nHid) html += '<p class="live-note muted">' + App.esc(t("live.hiddenNote", {n: nHid})) + '</p>';

  if(S.stale) html += '<p class="live-note muted">' + App.esc(t("live.staleNote")) + '</p>';
  html += '<p class="live-note muted">' + App.esc(t("live.sourceNote")) + '</p>';
  html += '</div><div class="live-epg"></div>';

  S.el.innerHTML = html;
  makeGrid();
  restoreFocus(prevKey);
  if(S.guide){ S.guide.epgT = -1; renderGuide(); }
  else if(S.view === "guide" && S.channels.length) openGuide();
}

function renderError(msg){
  S.el.innerHTML =
    '<div class="scroll live-scroll">' +
      '<div class="section-title">' + App.esc(t("live.apps")) + '</div>' +
      '<div class="live-row">' + guideCard() + APPS.map(appCard).join("") + '</div>' +
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

function cardKey(el){
  return el.dataset.kind === "ch" ? "ch:" + el.dataset.id : el.dataset.kind + ":" + (el.dataset.key || "");
}
function currentKey(){
  var el = S.grid && S.grid.current();
  return el ? cardKey(el) : null;
}
function findIndex(key){
  if(!S.grid || !key) return -1;
  for(var i = 0; i < S.grid.items.length; i++){
    if(cardKey(S.grid.items[i]) === key) return i;
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
  var name = img.getAttribute("data-name") || (card ? (card.querySelector(".live-name") || {}).textContent : "");
  var span = document.createElement("span");
  span.className = "live-initials" + (img.classList.contains("lg-logo") ? " lg-logo" : "");
  span.setAttribute("style", App.ui.placeholderStyle(name));
  span.textContent = App.ui.initials(name);
  img.parentNode.replaceChild(span, img);
}

/* ================= Acciones ================= */
function onSelect(i, el){
  if(el.dataset.kind === "app") launchApp(el.dataset.key);
  else if(el.dataset.kind === "guide") openGuide();
  else playChannel(S.byId[el.dataset.id]);
}

function playChannel(ch){
  if(!ch) return;
  if(!App.player || !App.player.play){ App.hint(t("live.noPlayer")); return; }
  S.playingId = ch.id;
  markPlaying();
  // Mini-guía (#68): "Ahora: … · Luego: … 21:30" (se recalcula en cada cambio de canal)
  var e = epgFor(ch), parts = [];
  if(e && e.now) parts.push(t("live.sub.now", {t: e.now.t}));
  if(e && e.next) parts.push(t("live.sub.next", {t: e.next.t, h: hhmm(e.next.hi)}));
  var sub = parts.length ? parts.join(" · ") : ambitLabel(ch.ambit) + (ch.geo ? " · " + t("live.geoOnly") : "");
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

function toggleFavId(id){
  var i = S.favs.indexOf(id);
  if(i >= 0){ S.favs.splice(i, 1); App.ui.toast(t("live.favRemoved")); }
  else { S.favs.push(id); App.ui.toast(t("live.favAdded")); }
  App.store.set(FAVS_KEY, S.favs);
}
function toggleFav(){
  var ch = focusedChannel();
  if(!ch){ App.hint(t("live.pickChannel")); return; }
  toggleFavId(ch.id);
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

/* ================= Ocultar / mover / ir al canal ================= */
function hideChannel(ch){
  if(!ch) return;
  var h = hiddenList();
  h.push({ id: ch.id, n: ch.name });
  App.store.set(HIDDEN_KEY, h);
  rebuild();
  render();
  App.ui.toast(t("live.hidden", {name: ch.name}));
  if(S.guide) renderGuide();
}

/* Menú de ocultos: elegir uno lo vuelve a mostrar. Resuelve cuando se cierra. */
function manageHidden(){
  var h = hiddenList();
  if(!h.length){ App.ui.toast(t("live.noHidden")); return Promise.resolve(); }
  var items = [{ label: t("live.showAll"), value: "*" }].concat(h.map(function(x){ return { label: x.n, value: x.id }; }));
  return App.ui.menu(t("live.hiddenTitle", {n: h.length}), items).then(function(v){
    if(v === null || v === undefined) return;
    var left = v === "*" ? [] : h.filter(function(x){ return x.id !== v; });
    App.store.set(HIDDEN_KEY, left);
    if(S.base.length){ rebuild(); if(S.el) render(); }
    App.ui.toast(t("live.shown"));
  });
}

function resetOrder(){
  App.store.set(ORDER_KEY, null);
  if(S.base.length){ rebuild(); if(S.el) render(); }
  App.ui.toast(t("live.orderReset"));
}

/* Modo mover: ▲◄ antes, ▼► después (solo dentro de su sección) */
function startGrab(ch){
  if(!ch || S.guide) return;
  S.grab = ch.id;
  var el = S.el.querySelector('.live-sec [data-id="' + ch.id + '"]');
  if(el) el.classList.add("grabbed");
  App.ui.toast(t("live.grabHelp"), 5000);
}
function endGrab(){
  var el = S.el && S.el.querySelector(".live-ch.grabbed");
  if(el) el.classList.remove("grabbed");
  S.grab = null;
  saveOrder();
  App.ui.toast(t("live.orderSaved"));
}
function grabMove(dir){
  var ch = S.byId[S.grab];
  if(!ch){ S.grab = null; return; }
  var i = S.channels.indexOf(ch), j = i + dir;
  var nb = S.channels[j];
  if(!nb || nb.country !== ch.country || nb.ambit !== ch.ambit){ App.ui.toast(t("live.moveEdge"), 1200); return; }
  // intercambiar en la lista visible y en la lista completa
  S.channels[i] = nb; S.channels[j] = ch;
  var a = S.allOrder.indexOf(ch), b = S.allOrder.indexOf(nb);
  S.allOrder[a] = nb; S.allOrder[b] = ch;
  var n = ch.num; ch.num = nb.num; nb.num = n;
  // DOM: mover la tarjeta sin repintar todo
  var ca = S.el.querySelector('.live-sec [data-id="' + ch.id + '"]');
  var cb = S.el.querySelector('.live-sec [data-id="' + nb.id + '"]');
  if(ca && cb && ca.parentNode === cb.parentNode){
    if(dir < 0) ca.parentNode.insertBefore(ca, cb); else ca.parentNode.insertBefore(cb, ca);
  }
  [ch, nb].forEach(function(c){
    var els = S.el.querySelectorAll('[data-id="' + c.id + '"] .live-num');
    for(var k = 0; k < els.length; k++) els[k].textContent = c.num;
  });
  S.geo = null;
  S.grid.refresh(false);
  var idx = S.grid.items.indexOf(ca);
  if(idx >= 0) S.grid.focus(idx);
}

/* Ir al canal N: teclado en pantalla o, si no hay, menú de decenas */
function gotoChannel(){
  if(!S.channels.length) return;
  if(App.ui.keyboard && App.ui.keyboard.open){
    App.ui.keyboard.open({
      title: t("live.gotoTitle", {max: S.channels.length}),
      value: "",
      placeholder: "1-" + S.channels.length,
      max: 4,
      onDone: function(v){
        var num = parseInt(String(v).replace(/\D/g, ""), 10);
        if(!num) return;
        var ch = S.channels[num - 1];
        if(ch) playChannel(ch); else App.ui.toast(t("live.noChannel", {n: num}));
      }
    });
    return;
  }
  var tens = [], n = S.channels.length;
  for(var a = 1; a <= n; a += 10) tens.push({ label: a + "-" + Math.min(n, a + 9), value: a });
  App.ui.menu(t("live.gotoTens"), tens).then(function(a){
    if(!a) return;
    var items = [];
    for(var k = a; k < a + 10 && k <= n; k++) items.push({ label: k + " · " + S.channels[k - 1].name, value: k });
    return App.ui.menu(t("live.gotoTitle", {max: n}), items).then(function(k){
      if(k) playChannel(S.channels[k - 1]);
    });
  });
}

/* ================= Recordatorios ================= */
function remList(){ var l = App.store.get(REM_KEY, []); return Array.isArray(l) ? l : []; }
function remKey(chId, hi){ return chId + "@" + hi; }
function hasReminder(chId, hi){
  var l = remList();
  for(var i = 0; i < l.length; i++) if(l[i].id === chId && l[i].hi === hi) return true;
  return false;
}
function toggleReminder(ch, ev){
  var l = remList(), found = -1;
  for(var i = 0; i < l.length; i++) if(l[i].id === ch.id && l[i].hi === ev.hi) found = i;
  if(found >= 0){ l.splice(found, 1); App.ui.toast(t("live.rem.removed")); }
  else { l.push({ id: ch.id, ch: ch.name, t: ev.t, hi: ev.hi }); App.ui.toast(t("live.rem.added", {title: ev.t, h: hhmm(ev.hi)})); }
  App.store.set(REM_KEY, l);
}
function watchChannelId(id){
  if(S.byId[id]){ playChannel(S.byId[id]); return; }
  S.pending = id;
  App.go("live", {});
}
function checkReminders(){
  var l = remList();
  if(!l.length) return;
  var now = Date.now() / 1000, keep = [], due = [];
  l.forEach(function(r){
    if(r.hi - now <= 60){ if(now - r.hi < 300) due.push(r); }
    else keep.push(r);
  });
  if(!due.length) return;
  App.store.set(REM_KEY, keep);
  var r = due[0];
  var msg = t("live.rem.due", {title: r.t, ch: r.ch, h: hhmm(r.hi)});
  var busy = App.ui.isModalOpen() || (App.ui.keyboard && App.ui.keyboard.isOpen && App.ui.keyboard.isOpen()) ||
             (App.player && App.player.isActive && App.player.isActive());
  if(busy){ App.ui.toast(msg, 8000); return; }
  App.ui.modal({
    title: t("live.rem.title"),
    html: "<p>" + App.esc(msg) + "</p>",
    buttons: [{ label: t("live.rem.watch"), value: "watch" }, { label: t("live.rem.dismiss"), value: "no" }],
    onClose: function(v){ if(v === "watch") watchChannelId(r.id); }
  });
}
setInterval(checkReminders, 15000);

/* ================= Guía en rejilla (vista principal) =================
 * Arriba: vista destacada del canal enfocado. Debajo: fila de chips (Canales, Favoritos, apps oficiales)
 * y la rejilla (canales en filas, franjas de 30 min en columnas, ventana de 3 h dentro de ahora → +6 h).
 * Solo se pintan las filas visibles (GUIDE_ROWS) y los programas que tocan la ventana. */
function floor30(ts){ return Math.floor(ts / 1800) * 1800; }

function buildGuideRows(){
  var G = S.guide, now = Date.now() / 1000, end = G.t0 + GUIDE_RANGE;
  var rows = [];
  S.channels.forEach(function(ch){
    if(S.favOnly && S.favs.indexOf(ch.id) < 0) return;
    var all = (S.epg && ch.epg) ? S.epg.byName[ch.epg] : null;
    var evs = all ? all.filter(function(e){ return e.hf > now && e.hi < end; }) : [];
    rows.push({ ch: ch, evs: evs });
  });
  G.rows = rows;
  G.epgT = S.epg ? S.epg.t : 0;
}

function pickEv(evs, tm){
  for(var i = 0; i < evs.length; i++) if(evs[i].hi <= tm && evs[i].hf > tm) return i;
  for(var j = 0; j < evs.length; j++) if(evs[j].hi > tm) return j;
  return evs.length - 1;
}

function guideBarItems(){
  var out = [{ k: "cards", label: t("live.v2.channels") }, { k: "fav", label: "★ " + t("live.v2.favOnly"), on: !!S.favOnly }];
  APPS.forEach(function(a){ out.push({ k: "app", key: a.key, label: a.name }); });
  return out;
}

function openGuide(){
  if(!S.channels.length){ App.ui.toast(t("live.epg.loading")); return; }
  var now = Date.now() / 1000, t0 = floor30(now);
  S.view = "guide";
  S.guide = { t0: t0, ws: t0, row: 0, top: 0, ev: 0, cursor: now, rows: [], epgT: -1, zone: "grid", bi: 0, heroKey: "",
              blurred: document.body.classList.contains("zone-header") };
  if(!S.epg) loadEpg(false);
  buildGuideRows();
  var G = S.guide;
  for(var i = 0; i < G.rows.length; i++) if(G.rows[i].ch.id === S.playingId){ G.row = i; break; }
  if(G.rows[G.row]) G.ev = pickEv(G.rows[G.row].evs, now);
  guideEnsureVisible();
  var bar = S.el.querySelector(".live-epg"); if(bar) bar.classList.remove("on");
  renderGuide();
}
function closeGuide(){
  S.guide = null;
  S.view = "cards";
  var el = S.el && S.el.querySelector(".live-guide");
  if(el && el.parentNode) el.parentNode.removeChild(el);
  if(S.grid){ S.grid.refresh(false); S.grid.focus(S.grid.index, true); }
  scheduleEpgBar();
}

/* Ajusta fila visible y ventana horaria para que el programa enfocado se vea */
function guideEnsureVisible(){
  var G = S.guide, r = G.rows[G.row];
  if(G.row < G.top) G.top = G.row;
  if(G.row >= G.top + GUIDE_ROWS) G.top = G.row - GUIDE_ROWS + 1;
  if(!r) return;
  var ev = r.evs[G.ev];
  if(!ev) return;
  var we = G.ws + GUIDE_SPAN, maxStart = G.t0 + GUIDE_RANGE - GUIDE_SPAN;
  if(ev.hf > G.ws && ev.hi < we) return;
  if(ev.hf <= G.ws) G.ws = Math.max(G.t0, floor30(ev.hi));
  else G.ws = Math.min(maxStart, Math.max(G.t0, floor30(ev.hi) - 3600));
}

function dayLabel(ws){
  var d = new Date(ws * 1000);
  var lab = "";
  try{ lab = d.toLocaleDateString(App.i18n.lang() === "es" ? "es-ES" : "en-GB", { weekday: "short", day: "numeric" }); }catch(e){}
  return (new Date().toDateString() === d.toDateString() ? t("live.v2.today") + (lab ? " · " : "") : "") + lab;
}

function logoHtml(ch, cls){
  return ch.logo
    ? '<img class="' + cls + ' live-logo" data-name="' + App.esc(ch.name) + '" src="' + App.esc(ch.logo) + '" alt="">'
    : '<span class="' + cls + ' live-initials" style="' + App.ui.placeholderStyle(ch.name) + '">' + App.esc(App.ui.initials(ch.name)) + '</span>';
}

/* Vista destacada del canal */
function heroHtml(ch, now){
  if(!ch) return "";
  var e = epgFor(ch), cur = e && e.now, nx = e && e.next;
  var h = '<div class="lg-preview">' + logoHtml(ch, "lg-logo") + '</div><div class="lg-info">';
  h += '<div class="lg-meta"><span class="lg-tag">' + App.esc(t("live.v2.liveTag")) + '</span><span class="num">' +
       ch.num + ' · ' + App.esc(ch.name) + '</span></div>';
  if(cur){
    var p = Math.max(0, Math.min(1, (now - cur.hi) / Math.max(1, cur.hf - cur.hi)));
    h += '<h1 class="lg-now-title">' + App.esc(cur.t || ch.name) + '</h1>' +
         '<div class="lg-sched num">' + hhmm(cur.hi) + ' – ' + hhmm(cur.hf) + '</div>' +
         '<div class="lg-prog"><i style="width:' + (p * 100).toFixed(0) + '%"></i></div>';
  } else {
    h += '<h1 class="lg-now-title">' + App.esc(ch.name) + '</h1>' +
         '<div class="lg-sched">' + App.esc(S.epg || !S.epgLoading ? t("live.epg.none") : t("live.epg.loading")) + '</div>';
  }
  if(nx) h += '<div class="lg-next">' + App.esc(t("live.v2.upNext")) + ' <b>' + App.esc(nx.t) + '</b> <span class="num">· ' + hhmm(nx.hi) + '</span></div>';
  return h + '</div>';
}

/* ---- PC / móvil (no TV): clic/toque en la guía; en móvil la guía es una lista de canales ---- */
function listMode(){ return !App.isTizen() && document.body.classList.contains("mobile"); }

function listHtml(now){
  var G = S.guide, h = "";
  if(!G.rows.length) return '<div class="lg-empty muted">' + App.esc(S.favOnly ? t("live.v2.noFavs") : t("live.guideEmpty")) + '</div>';
  G.rows.forEach(function(row, i){
    var ch = row.ch, e = epgFor(ch), cur = e && e.now, nx = e && e.next;
    var fav = S.favs.indexOf(ch.id) >= 0;
    h += '<div class="lgl-item' + (ch.id === S.playingId ? ' playing' : '') + (i === G.row ? ' cur' : '') + '" data-r="' + i + '">' +
      '<div class="lgl-logo">' + logoHtml(ch, "lgl-img") + '</div><div class="lgl-txt">' +
      '<div class="lgl-name"><b class="num">' + ch.num + '</b><span>' + App.esc(ch.name) + '</span>' + (fav ? '<i class="lg-star">★</i>' : '') + '</div>';
    if(cur){
      var p = Math.max(0, Math.min(1, (now - cur.hi) / Math.max(1, cur.hf - cur.hi)));
      h += '<div class="lgl-now">' + App.esc(cur.t) + ' <span class="muted num">' + hhmm(cur.hi) + '–' + hhmm(cur.hf) + '</span></div>' +
           '<div class="lg-prog"><i style="width:' + (p * 100).toFixed(0) + '%"></i></div>';
      if(nx) h += '<div class="lgl-next">' + App.esc(t("live.v2.upNext")) + ' <b>' + App.esc(nx.t) + '</b> <span class="num">· ' + hhmm(nx.hi) + '</span></div>';
    } else {
      h += '<div class="lgl-now muted">' + App.esc(S.epg || !S.epgLoading ? t("live.v2.noGuide") : t("live.epg.loading")) + '</div>';
    }
    h += '</div></div>';
  });
  return h;
}

/* Delegación de clic/toque (solo fuera de la TV). Un toque/clic = enfocar + OK. */
function guideClick(ev){
  var G = S.guide; if(!G) return;
  var n = ev.target.closest ? ev.target : null; if(!n) return;
  var bi = n.closest("[data-bi]");
  if(bi){ G.zone = "bar"; G.bi = Number(bi.getAttribute("data-bi")); G.blurred = false; guideBarSelect(); return; }
  if(n.closest(".lg-preview")){ var rc = G.rows[G.row]; if(rc) playChannel(rc.ch); return; }
  var item = n.closest("[data-r]") || n.closest(".lg-row");
  if(!item) return;
  var ri = Number(item.getAttribute("data-r"));
  if(isNaN(ri) || !G.rows[ri]) return;
  G.zone = "grid"; G.blurred = false; G.row = ri;
  var evn = n.closest("[data-e]");
  if(evn && !n.closest(".lg-ch") && G.rows[ri].evs[Number(evn.getAttribute("data-e"))]){
    G.ev = Number(evn.getAttribute("data-e")); G.cursor = Math.max(G.rows[ri].evs[G.ev].hi, G.ws);
    guideSelect();
  } else {
    playChannel(G.rows[ri].ch);
  }
}
/* Pulsar/mantener sobre una fila deja seleccionado ese canal sin repintar (el menú contextual lo usa) */
function guidePointDown(ev){
  var G = S.guide; if(!G || !ev.target.closest) return;
  var item = ev.target.closest("[data-r]");
  if(!item) return;
  var ri = Number(item.getAttribute("data-r"));
  if(G.rows[ri]){ G.zone = "grid"; G.row = ri; var e = ev.target.closest("[data-e]"); if(e) G.ev = Number(e.getAttribute("data-e")); }
}
function guideWheel(ev){
  var G = S.guide;
  if(!G || listMode()) return;
  var d = ev.deltaY > 0 ? 1 : ev.deltaY < 0 ? -1 : 0;
  if(!d) return;
  ev.preventDefault();
  var nt = Math.max(0, Math.min(Math.max(0, G.rows.length - GUIDE_ROWS), G.top + d));
  if(nt === G.top) return;
  G.top = nt;
  if(G.row < G.top) G.row = G.top;
  if(G.row >= G.top + GUIDE_ROWS) G.row = G.top + GUIDE_ROWS - 1;
  var r = G.rows[G.row]; if(r) G.ev = pickEv(r.evs, G.cursor);
  renderGuide();
}

function renderGuide(){
  var G = S.guide;
  if(!G || !S.el) return;
  if(G.epgT !== (S.epg ? S.epg.t : 0)){
    var keepId = G.rows[G.row] ? G.rows[G.row].ch.id : null;
    buildGuideRows();
    var ni = -1;
    for(var q = 0; q < G.rows.length; q++) if(G.rows[q].ch.id === keepId){ ni = q; break; }
    G.row = ni >= 0 ? ni : Math.min(G.row, Math.max(0, G.rows.length - 1));
    if(G.rows[G.row]) G.ev = pickEv(G.rows[G.row].evs, G.cursor);
    guideEnsureVisible();
  }
  var el = S.el.querySelector(".live-guide");
  if(!el){
    el = document.createElement("div");
    el.className = "live-guide";
    el.innerHTML = '<div class="lg-hero"></div><div class="lg-bar"></div><div class="lg-main"></div>';
    S.el.appendChild(el);
    if(!App.isTizen()){
      el.addEventListener("click", guideClick);
      el.addEventListener("pointerdown", guidePointDown);
      el.addEventListener("wheel", guideWheel, { passive: false });
    }
    G.heroKey = "";
  }
  var now = Date.now() / 1000, ws = G.ws, we = ws + GUIDE_SPAN;
  var cur = G.rows[G.row];

  /* --- vista destacada (solo se repinta si cambia el canal / la guía / el minuto) --- */
  var hk = (cur ? cur.ch.id : "") + "|" + G.epgT + "|" + Math.floor(now / 30) + "|" + (S.epgLoading ? 1 : 0);
  if(hk !== G.heroKey){
    G.heroKey = hk;
    el.querySelector(".lg-hero").innerHTML = heroHtml(cur ? cur.ch : null, now);
  }

  /* --- chips: Canales, Favoritos, apps oficiales --- */
  var h = '<span class="lg-bar-label">' + App.esc(t("live.v2.view")) + '</span>';
  guideBarItems().forEach(function(it, i){
    if(i === 2) h += '<span class="lg-bar-sep"></span><span class="lg-bar-label">' + App.esc(t("live.v2.apps")) + '</span>';
    h += '<span data-bi="' + i + '" class="lg-chip' + (it.on ? ' on' : '') + (G.zone === "bar" && G.bi === i && !G.blurred ? ' fcs' : '') + '">' + App.esc(it.label) + '</span>';
  });
  el.querySelector(".lg-bar").innerHTML = h;

  if(listMode()){   // móvil: lista de canales con nativo scroll
    var lm = el.querySelector(".lg-main"), keep = lm.scrollTop;
    el.classList.add("lg-list");
    lm.innerHTML = listHtml(now);
    lm.scrollTop = keep;
    return;
  }
  el.classList.remove("lg-list");

  /* --- rejilla --- */
  h = '<div class="lg-times"><div class="lg-corner">' + App.esc(dayLabel(ws)) + '</div><div class="lg-axis">';
  for(var s = 0; s < GUIDE_SPAN / 1800; s++){
    h += '<span class="lg-slot num" style="left:' + (s * 1800 / GUIDE_SPAN * 100) + '%">' + hhmm(ws + s * 1800) + '</span>';
  }
  if(now >= ws && now < we) h += '<i class="lg-now" style="left:' + ((now - ws) / GUIDE_SPAN * 100) + '%"></i>';
  h += '</div></div>';
  if(!G.rows.length){
    h += '<div class="lg-empty muted">' + App.esc(S.favOnly ? t("live.v2.noFavs") : t("live.guideEmpty")) + '</div>';
  }
  var rem = {};
  remList().forEach(function(r){ rem[remKey(r.id, r.hi)] = true; });
  var gridFocus = G.zone === "grid" && !G.blurred;
  for(var i = G.top; i < Math.min(G.rows.length, G.top + GUIDE_ROWS); i++){
    var row = G.rows[i], isCur = i === G.row;
    var fav = S.favs.indexOf(row.ch.id) >= 0;
    h += '<div class="lg-row' + (isCur ? ' cur' : '') + '" data-r="' + i + '"><div class="lg-ch"><b class="num">' + row.ch.num + '</b>' +
         '<span>' + App.esc(row.ch.name) + '</span>' + (fav ? '<i class="lg-star">★</i>' : '') + '</div><div class="lg-line">';
    if(!row.evs.length){
      h += '<div data-e="0" class="lg-ev lg-none' + (isCur && gridFocus ? ' sel' : '') + '" style="left:0;width:100%"><span>' +
           App.esc(S.epg || !S.epgLoading ? t("live.v2.noGuide") : t("live.epg.loading")) + '</span></div>';
    }
    for(var j = 0; j < row.evs.length; j++){
      var e = row.evs[j];
      if(e.hf <= ws || e.hi >= we) continue;
      var a = Math.max(e.hi, ws), b = Math.min(e.hf, we);
      var onAir = e.hi <= now && e.hf > now, hasRem = !!rem[remKey(row.ch.id, e.hi)];
      var cls = 'lg-ev' + (onAir ? ' on' : '') + (isCur && gridFocus && j === G.ev ? ' sel' : '') +
                (hasRem ? ' rem' : '') + (e.hi < ws ? ' cl' : '') + (e.hf > we ? ' cr' : '');
      h += '<div data-e="' + j + '" class="' + cls + '" style="left:' + ((a - ws) / GUIDE_SPAN * 100) + '%;width:' + ((b - a) / GUIDE_SPAN * 100) + '%">' +
           '<span class="lg-ev-t">' + App.esc(e.t) + '</span>' +
           '<span class="lg-ev-s num">' + hhmm(e.hi) + (onAir ? ' · ' + App.esc(t("live.v2.onAir")) : '') + '</span>' +
           (hasRem ? '<em class="lg-rem">' + App.esc(t("live.v2.reminder")) + '</em>' : '') + '</div>';
    }
    h += '</div></div>';
  }
  var cev = cur && cur.evs[G.ev];
  if(cev){
    var air = cev.hi <= now && cev.hf > now;
    h += '<div class="lg-sel"><b>' + App.esc(cev.t) + '</b> <span class="muted num">' + hhmm(cev.hi) + '–' + hhmm(cev.hf) + '</span>' +
         '<span class="lg-act">' + App.esc(air ? t("live.guide.okWatch") : (hasReminder(cur.ch.id, cev.hi) ? t("live.guide.okUnremind") : t("live.guide.okRemind"))) + '</span></div>';
  }
  el.querySelector(".lg-main").innerHTML = h;
}

function guideSelect(){
  var G = S.guide, r = G && G.rows[G.row], ev = r && r.evs[G.ev];
  if(!r) return;
  var now = Date.now() / 1000;
  if(!ev || ev.hi <= now){ playChannel(r.ch); }
  else { toggleReminder(r.ch, ev); renderGuide(); }
}

function guideBarSelect(){
  var it = guideBarItems()[S.guide.bi];
  if(!it) return;
  if(it.k === "cards") closeGuide();
  else if(it.k === "fav") toggleFavOnly();
  else launchApp(it.key);
}
function toggleFavOnly(){
  S.favOnly = !S.favOnly;
  if(S.guide){ S.guide.epgT = -1; S.guide.row = 0; S.guide.top = 0; renderGuide(); }
}

function guideKey(k){
  var G = S.guide;
  if(App.isBack(k)) return false;                  // la guía es la vista principal: Atrás sale de la pantalla
  var d = App.digit(k);
  if(d >= 0){ pushDigit(d); return true; }
  G.blurred = false;
  if(G.zone === "bar"){
    var n = guideBarItems().length;
    if(k === K.OK){ guideBarSelect(); return true; }
    if(k === K.LEFT){ if(G.bi > 0) G.bi--; else { G.blurred = true; renderGuide(); App.focusHeader(); return true; } }
    else if(k === K.RIGHT){ if(G.bi < n - 1) G.bi++; }
    else if(k === K.DOWN){ G.zone = "grid"; }
    else if(k === K.UP){ renderGuide(); return true; }
    else return true;
    renderGuide();
    return true;
  }
  var r = G.rows[G.row];
  if(k === K.OK){ guideSelect(); return true; }
  if(k === K.RED){ G.ws = G.t0; G.cursor = Date.now() / 1000; if(r) G.ev = pickEv(r.evs, G.cursor); renderGuide(); return true; }
  if(k === K.GREEN){ if(r){ toggleFavId(r.ch.id); renderGuide(); } return true; }
  if(k === K.INFO){ closeGuide(); return true; }
  if(!r){
    if(k === K.UP){ G.zone = "bar"; renderGuide(); }
    return true;
  }
  if(k === K.LEFT){
    if(G.ev > 0){ G.ev--; G.cursor = Math.max(r.evs[G.ev].hi, G.ws); }
    else { G.blurred = true; renderGuide(); App.focusHeader(); return true; }
  } else if(k === K.RIGHT){
    if(G.ev < r.evs.length - 1){ G.ev++; G.cursor = r.evs[G.ev].hi; }
  } else if(k === K.UP || k === K.DOWN || k === K.CHUP || k === K.CHDOWN){
    var step = (k === K.CHUP || k === K.CHDOWN) ? GUIDE_ROWS : 1;
    var nr = G.row + ((k === K.DOWN || k === K.CHDOWN) ? step : -step);
    if(nr < 0){
      if(k === K.UP && G.row === 0){ G.zone = "bar"; renderGuide(); return true; }
      nr = 0;
    }
    nr = Math.min(nr, G.rows.length - 1);
    G.row = nr; G.ev = pickEv(G.rows[nr].evs, G.cursor);
  } else return true;
  guideEnsureVisible();
  renderGuide();
  return true;
}

/* ================= Acciones (menú contextual, A1) ================= */
function actions(){
  var out = [], G = S.guide;
  if(G){
    var r = G.rows[G.row], ev = r && r.evs[G.ev], now = Date.now() / 1000;
    if(G.zone === "bar"){
      out.push({ label: t("live.act.open"), run: guideBarSelect });
    } else if(r){
      out.push({ label: t("live.act.watch"), run: function(){ playChannel(r.ch); } });
      if(ev && ev.hi > now) out.push({
        label: hasReminder(r.ch.id, ev.hi) ? t("live.guide.okUnremind") : t("live.guide.okRemind"),
        run: function(){ toggleReminder(r.ch, ev); renderGuide(); }
      });
      out.push({ label: S.favs.indexOf(r.ch.id) >= 0 ? t("live.act.unfav") : t("live.act.fav"), run: function(){ toggleFavId(r.ch.id); renderGuide(); } });
      out.push({ label: t("live.act.hide"), run: function(){ hideChannel(r.ch); } });
    }
    out.push({ label: t("live.act.now"), run: function(){ G.ws = G.t0; G.cursor = now; if(r) G.ev = pickEv(r.evs, now); renderGuide(); } });
    out.push({ label: t(S.favOnly ? "live.v2.act.allChannels" : "live.v2.act.favOnly"), run: toggleFavOnly });
    out.push({ label: t("live.v2.act.cards"), run: closeGuide });
    var nhg = hiddenList().length;
    if(nhg) out.push({ label: t("live.act.hidden", {n: nhg}), run: manageHidden });
    out.push({ label: t("live.act.goto"), run: gotoChannel });
    out.push({ label: t("live.act.reload"), run: function(){ S.forceExtra = true; load(true); loadEpg(true); } });
    return out;
  }
  var el = S.grid && S.grid.current();
  var ch = focusedChannel();
  if(ch){
    out.push({ label: t("live.act.watch"), run: function(){ playChannel(ch); } });
    out.push({ label: S.favs.indexOf(ch.id) >= 0 ? t("live.act.unfav") : t("live.act.fav"), run: function(){ toggleFavId(ch.id); render(); } });
    out.push({ label: t("live.act.hide"), run: function(){ hideChannel(ch); } });
    out.push({ label: t("live.act.move"), run: function(){ startGrab(ch); } });
  } else if(el && el.dataset.kind === "app"){
    out.push({ label: t("live.act.open"), run: function(){ launchApp(el.dataset.key); } });
  }
  out.push({ label: t("live.guide"), run: openGuide });
  if(S.channels.length) out.push({ label: t("live.act.goto"), run: gotoChannel });
  var nh = hiddenList().length;
  if(nh) out.push({ label: t("live.act.hidden", {n: nh}), run: manageHidden });
  if(App.store.get(ORDER_KEY, null)) out.push({ label: t("live.act.resetOrder"), run: resetOrder });
  out.push({ label: t("live.act.reload"), run: function(){ S.forceExtra = true; load(true); loadEpg(true); } });
  return out;
}

/* ================= Ajustes (grupo "Live TV") ================= */
function manageExtra(){
  return new Promise(function(resolve){
    var urls = extraUrls();
    var items = [{ label: "+ " + t("live.extra.add"), value: "+" }].concat(urls.map(function(u, i){
      return { label: extraName(u), value: i };
    }));
    App.ui.menu(t("live.extra.title"), items).then(function(v){
      if(v === null || v === undefined){ resolve(); return; }
      if(v === "+"){
        if(!(App.ui.keyboard && App.ui.keyboard.open)){ resolve(); return; }
        App.ui.keyboard.open({
          title: t("live.extra.addTitle"), value: "https://", placeholder: "https://.../list.m3u",
          onDone: function(val){
            val = String(val || "").trim();
            if(!isHttpUrl(val)){ App.ui.toast(t("live.extra.invalid")); resolve(); return; }
            if(urls.indexOf(val) < 0) App.settings.set("liveExtraLists", urls.concat([val]));
            App.ui.toast(t("live.extra.added"));
            resolve();
          },
          onCancel: function(){ resolve(); }
        });
        return;
      }
      var u = urls[v];
      App.ui.confirm(t("live.extra.removeTitle"), extraName(u)).then(function(ok){
        if(ok){
          App.settings.set("liveExtraLists", urls.filter(function(x){ return x !== u; }));
          App.ui.toast(t("live.extra.removed"));
        }
        resolve();
      });
    });
  });
}

App.settingsUI.add("settings.group.live", {
  id: "liveExtraLists", type: "action",
  label: function(){ return t("live.set.extra"); },
  desc: function(){ return t("live.set.extraDesc", {n: extraUrls().length}); },
  run: manageExtra
});
App.settingsUI.add("settings.group.live", {
  id: "liveHidden", type: "action",
  label: function(){ return t("live.set.hidden"); },
  desc: function(){ return t("live.set.hiddenDesc", {n: hiddenList().length}); },
  run: manageHidden
});
App.settingsUI.add("settings.group.live", {
  id: "liveOrder", type: "action",
  label: function(){ return t("live.set.order"); },
  desc: function(){ return t("live.set.orderDesc"); },
  run: function(){ resetOrder(); }
});

/* ================= Pantalla ================= */
App.screens.register({
  id: "live", label: t("nav.live"), nav: true, order: 30,
  get hint(){ return t("live.v2.hint"); },
  mount: function(el){
    S.el = el;
    el.addEventListener("error", onImgError, true);
    window.addEventListener("resize", function(){ S.geo = null; });
  },
  show: function(params){
    if(S.guide){
      S.guide.blurred = document.body.classList.contains("zone-header");
      S.guide.heroKey = ""; S.guide.epgT = -1;
      renderGuide(); loadEpg(false);
      return;
    }
    if(params && params._back && S.grid){ restoreFocus(currentKey()); return; }
    if(!S.channels.length && !S.loading) load(false);
    else if(S.grid){ S.geo = null; restoreFocus(currentKey()); loadEpg(false); }
  },
  hide: function(){
    if(S.grab) endGrab();
    clearTimeout(S.digitTimer); S.digitBuf = "";
    clearTimeout(S.epgTimer);
  },
  focus: function(){
    if(S.guide){ S.guide.blurred = false; renderGuide(); return; }
    if(!S.grid) return;
    S.grid.refresh(false);
    S.geo = null;
    S.grid.focus(S.grid.index, true);
    scheduleEpgBar();
  },
  blur: function(){
    if(S.guide){ S.guide.blurred = true; renderGuide(); }
    if(S.grid) S.grid.blur();
    var bar = S.el && S.el.querySelector(".live-epg");
    if(bar) bar.classList.remove("on");
  },
  actions: actions,
  onKey: function(k, e){
    if(S.guide) return guideKey(k);
    if(S.grab){
      if(k === K.UP || k === K.LEFT){ grabMove(-1); return true; }
      if(k === K.DOWN || k === K.RIGHT){ grabMove(1); return true; }
      if(k === K.OK || App.isBack(k)){ endGrab(); return true; }
      return true;
    }
    if(App.isBack(k) && S.channels.length){ openGuide(); return true; }   // tarjetas → guía
    if(k === K.RED){ S.forceExtra = true; load(true); loadEpg(true); return true; }
    if(k === K.GREEN){ toggleFav(); return true; }
    if(k === K.INFO){ openGuide(); return true; }
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
  epgFor: function(id){ return epgFor(S.byId[id]); },
  openGuide: openGuide
};

})();
